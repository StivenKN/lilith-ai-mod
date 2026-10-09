// Claude through the official SDK. Chat runs at low effort (fast, cheap) with server-side
// refusal fallbacks on the models that support them; both are dropped automatically for
// models that reject them.

import Anthropic from "@anthropic-ai/sdk";
import type { BetaMessageParam, BetaToolUnion, BetaToolResultBlockParam, BetaTextBlockParam, BetaImageBlockParam } from "@anthropic-ai/sdk/resources/beta/messages/messages";
import { computerTools, toolSchema } from "../computer/actions.ts";
import { classifyStatus, toolsUnsupported, trimSlash } from "./http.ts";
import { normalizeTurns, ProviderError, type ChatRequest, type ChatResult, type ChatTurn, type Provider, type ToolCall } from "./types.ts";

const FALLBACK_MODELS = /^claude-(fable-5-1|opus-5-5|opus-5|sonnet-5-5)$/;
const EFFORT_MODELS = /^claude-(fable|mythos|opus-(4-[5-9]|5)|sonnet-(4-6|5))/;
const TOOLSET_MODELS = /^claude-(fable-5|mythos-5|opus-5|sonnet-5|opus-4-8|haiku-5-5)/;

/** Per-model features the API rejected at runtime. */
type RejectedFeature = "effort" | "fallbacks" | "toolset" | "cache" | "tools";
const rejected = new Map<string, Set<RejectedFeature>>();

export interface AnthropicOptions {
  baseUrl: string;
  apiKey: string;
  model: string;
  onAdjust: (message: string) => void;
}

export function createAnthropicProvider(options: AnthropicOptions): Provider {
  const client = new Anthropic({ apiKey: options.apiKey, baseURL: trimSlash(options.baseUrl), maxRetries: 1 });
  const key = `${trimSlash(options.baseUrl)}|${options.model}`;
  const off = rejected.get(key) ?? new Set<RejectedFeature>();
  rejected.set(key, off);

  return {
    async chat(request: ChatRequest): Promise<ChatResult> {
      for (let attempt = 0; ; attempt++) {
        const useEffort = EFFORT_MODELS.test(options.model) && !off.has("effort");
        const useFallbacks = FALLBACK_MODELS.test(options.model) && !off.has("fallbacks");
        try {
          const response = await client.beta.messages.create(
            {
              model: options.model,
              max_tokens: request.maxTokens,
              system: request.system,
              messages: normalizeTurns(request.turns).map(toMessage),
              ...(useEffort ? { output_config: { effort: "low" as const } } : {}),
              ...(useFallbacks ? { fallbacks: "default" as const, betas: ["server-side-fallback-2026-07-01"] } : {}),
            },
            { timeout: request.timeoutMs, ...(request.signal ? { signal: request.signal } : {}) },
          );
          if (response.stop_reason === "refusal") {
            throw new ProviderError("refused", `Claude declined (${response.stop_details?.category ?? "no category"})`);
          }
          const text = response.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("");
          return {
            text,
            reasoning: "",
            finish: response.stop_reason === "max_tokens" ? "length" : "stop",
            model: response.model,
          };
        } catch (error) {
          const classified = toProviderError(error);
          if (attempt < 2 && classified.kind === "bad_request") {
            const feature = /effort|output_config/i.test(classified.message)
              ? "effort"
              : /fallback|beta/i.test(classified.message)
                ? "fallbacks"
                : null;
            if (feature && !off.has(feature)) {
              off.add(feature);
              options.onAdjust(`${options.model}: API rejected "${feature}", retrying without it`);
              continue;
            }
          }
          throw classified;
        }
      }
    },

    async listModels(timeoutMs = 15_000) {
      try {
        const models: { id: string }[] = [];
        for await (const model of client.models.list({ limit: 100 }, { timeout: timeoutMs })) models.push({ id: model.id });
        return models;
      } catch (error) {
        throw toProviderError(error);
      }
    },

    async capabilities(_http, refresh = false) {
      if (refresh) off.delete("tools");
      return { tools: !off.has("tools"), vision: /^claude-/i.test(options.model) };
    },

    agent(request) {
      const messages: BetaMessageParam[] = normalizeTurns(request.turns).map(toMessage);
      let pending: ToolCall[] = [];
      return {
        async next(results, http) {
          if (off.has("tools")) throw new ProviderError("no_tools", "This model does not accept function tools");
          if (results.length) {
            // An error result may hold only text, so its screenshot follows the results instead.
            const after: Array<BetaTextBlockParam | BetaImageBlockParam> = [];
            const content: BetaToolResultBlockParam[] = results.map((result) => {
              const blocks: Array<BetaTextBlockParam | BetaImageBlockParam> = [{ type: "text", text: result.text }];
              const seen: Array<BetaTextBlockParam | BetaImageBlockParam> = [];
              if (result.image) seen.push({ type: "image", source: { type: "base64", media_type: "image/png", data: Buffer.from(result.image).toString("base64") } });
              if (result.page) seen.push({ type: "text", text: result.page });
              if (result.caption) seen.push({ type: "text", text: result.caption });
              (result.isError ? after : blocks).push(...seen);
              const toolset = pending.find((call) => call.id === result.id)?.toolset;
              return { type: "tool_result", tool_use_id: result.id, content: blocks, ...(result.isError ? { is_error: true } : {}), ...(toolset ? { toolset_name: toolset } : {}) };
            });
            messages.push({ role: "user", content: [...content, ...after] });
          }
          for (let attempt = 0; ; attempt++) {
            const toolset = request.vision && TOOLSET_MODELS.test(options.model) && !off.has("toolset");
            const tools: BetaToolUnion[] = computerTools(request.vision, request.browser)
              .filter((tool) => !toolset || tool.name !== "computer_use")
              .map((tool) => ({ name: tool.name, description: tool.description, input_schema: { ...toolSchema(tool), type: "object" } }));
            if (toolset) tools.unshift({ type: "computer_toolset_20260801", configs: { hold_key: { enabled: false }, left_mouse_down: { enabled: false }, left_mouse_up: { enabled: false } } });
            try {
              const response = await client.beta.messages.create({
                model: options.model, system: request.system, messages, max_tokens: request.maxTokens, tools,
                ...(!off.has("cache") ? { cache_control: { type: "ephemeral" as const } } : {}),
                ...(EFFORT_MODELS.test(options.model) && !off.has("effort") ? { output_config: { effort: "low" as const } } : {}),
              }, { timeout: http.timeoutMs, ...(http.signal ? { signal: http.signal } : {}) });
              if (response.stop_reason === "refusal") throw new ProviderError("refused", `Claude declined (${response.stop_details?.category ?? "no category"})`);
              // Keep thinking/signature blocks and all toolset metadata exactly as returned.
              messages.push({ role: "assistant", content: response.content });
              pending = response.content.flatMap((block): ToolCall[] => block.type === "tool_use" ? [{ id: block.id, name: block.name, input: block.input, ...(block.toolset_name ? { toolset: block.toolset_name } : {}) }] : []);
              return { calls: pending, text: response.content.flatMap((block) => block.type === "text" ? [block.text] : []).join(""), model: response.model, finish: response.stop_reason === "max_tokens" ? "length" : "stop" };
            } catch (error) {
              if (http.signal?.aborted) throw error;
              const classified = toProviderError(error);
              if (attempt < 3 && classified.status === 400) {
                const feature = toolset && !pending.length && /toolset/i.test(classified.message) ? "toolset"
                  : /effort|output_config/i.test(classified.message) ? "effort"
                  : /cache_control/i.test(classified.message) ? "cache" : null;
                if (feature && !off.has(feature)) {
                  off.add(feature);
                  options.onAdjust(`${options.model}: API rejected "${feature}", retrying without it`);
                  continue;
                }
              }
              if (toolsUnsupported(classified)) {
                off.add("tools");
                throw new ProviderError("no_tools", classified.message, 400);
              }
              throw classified;
            }
          }
        },
      };
    },
  };
}

/** Pictures go first as base64 image blocks, as Anthropic recommends. */
const toMessage = ({ role, content, images }: ChatTurn): BetaMessageParam =>
  images?.length
    ? {
        role,
        content: [
          ...images.map((image) => ({ type: "image" as const, source: { type: "base64" as const, media_type: image.mediaType, data: image.data } })),
          { type: "text" as const, text: content },
        ],
      }
    : { role, content };

function toProviderError(error: unknown): ProviderError {
  if (error instanceof ProviderError) return error;
  if (error instanceof Anthropic.APIConnectionTimeoutError) return new ProviderError("timeout", "Claude did not answer in time");
  if (error instanceof Anthropic.APIConnectionError) return new ProviderError("unreachable", `Could not reach the Anthropic API (${error.message})`);
  if (error instanceof Anthropic.APIError) {
    const status = error.status ?? 0;
    const kind = status === 529 ? "server" : classifyStatus(status, error.message);
    return new ProviderError(kind, `HTTP ${status} from Anthropic: ${error.message}`, status);
  }
  return new ProviderError("bad_response", error instanceof Error ? error.message : String(error));
}
