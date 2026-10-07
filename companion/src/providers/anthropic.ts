// Claude through the official SDK. Chat runs at low effort (fast, cheap) with server-side
// refusal fallbacks on the models that support them; both are dropped automatically for
// models that reject them.

import Anthropic from "@anthropic-ai/sdk";
import { classifyStatus, trimSlash } from "./http.ts";
import { normalizeTurns, ProviderError, type ChatRequest, type ChatResult, type Provider } from "./types.ts";

const FALLBACK_MODELS = /^claude-(fable-5-1|opus-5-5|opus-5|sonnet-5-5)$/;
const EFFORT_MODELS = /^claude-(fable|mythos|opus-(4-[5-9]|5)|sonnet-(4-6|5))/;

/** Per-model features the API rejected at runtime. */
const rejected = new Map<string, Set<"effort" | "fallbacks">>();

export interface AnthropicOptions {
  baseUrl: string;
  apiKey: string;
  model: string;
  onAdjust: (message: string) => void;
}

export function createAnthropicProvider(options: AnthropicOptions): Provider {
  const client = new Anthropic({ apiKey: options.apiKey, baseURL: trimSlash(options.baseUrl), maxRetries: 1 });
  const off = rejected.get(options.model) ?? new Set();
  rejected.set(options.model, off);

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
              messages: normalizeTurns(request.turns),
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
  };
}

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
