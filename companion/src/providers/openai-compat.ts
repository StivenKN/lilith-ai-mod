// OpenAI-compatible Chat Completions: OpenAI, Gemini, DeepSeek, OpenRouter, Groq, Mistral, xAI,
// LM Studio, llama.cpp, vLLM... Servers disagree on which optional fields they accept, so a 400
// that names a field drops (or renames) it and retries; the lesson is remembered per model.

import { z } from "zod";
import { randomInt } from "node:crypto";
import { computerTools, toolCallsInText, toolSchema } from "../computer/actions.ts";
import { bgraToPng } from "../computer/png.ts";
import { isLocalUrl, type Preset } from "./presets.ts";
import { awaitWithAbort, requestJson, toolsUnsupported, trimSlash, withRetry, type HttpOptions } from "./http.ts";
import { normalizeTurns, ProviderError, stepTemperature, type Capabilities, type ChatRequest, type ChatResult, type ChatTurn, type Provider, type ToolCall } from "./types.ts";

const AssistantMessage = z.looseObject({
  content: z.union([z.string(), z.array(z.object({ type: z.string(), text: z.string().optional() }))]).nullish(),
  reasoning_content: z.string().nullish(),
  reasoning: z.string().nullish(),
  refusal: z.string().nullish(),
  tool_calls: z.array(z.looseObject({ id: z.string(), type: z.literal("function"), function: z.looseObject({ name: z.string(), arguments: z.unknown() }) })).optional(),
});
type ImagePart = { type: "text"; text: string } | { type: "image_url"; image_url: { url: string } };
type Message =
  | { role: "system" | "user"; content: string }
  | { role: "user"; content: ImagePart[] }
  | { role: "tool"; tool_call_id: string; content: string }
  | (z.infer<typeof AssistantMessage> & { role: "assistant" });

const ChatCompletion = z.object({
  model: z.string().optional(),
  choices: z
    .array(
      z.object({
        finish_reason: z.string().nullish(),
        message: AssistantMessage,
      }),
    )
    .min(1),
});

const ModelList = z.object({ data: z.array(z.object({ id: z.string() })) });

/** Per (baseUrl, model) adjustments learned from 400 responses. Lives for the process lifetime. */
const learned = new Map<string, Set<string>>();
const visionChecks = new Map<string, Promise<boolean>>();

export interface OpenAiOptions {
  baseUrl: string;
  apiKey: string;
  model: string;
  preset: Preset;
  onAdjust: (message: string) => void;
}

export function createOpenAiProvider(options: OpenAiOptions): Provider {
  const base = trimSlash(options.baseUrl);
  const headers = {
    ...(options.apiKey ? { authorization: `Bearer ${options.apiKey}` } : {}),
    ...options.preset.extraHeaders,
  };
  const quirkKey = `${base}|${options.model}`;
  const quirks = learned.get(quirkKey) ?? new Set<string>();
  learned.set(quirkKey, quirks);

  const buildBody = (request: ChatRequest): Record<string, unknown> => {
    const tokensField = quirks.has("max_completion_tokens")
      ? "max_completion_tokens"
      : quirks.has("max_tokens")
        ? "max_tokens"
        : (options.preset.maxTokensField ?? "max_tokens");
    const body: Record<string, unknown> = {
      model: options.model,
      messages: [{ role: "system", content: request.system }, ...normalizeTurns(request.turns).map(toMessage)],
      stream: false,
      [tokensField]: request.maxTokens,
      temperature: request.temperature,
      ...(request.json ? { response_format: { type: "json_schema", json_schema: { ...request.json, strict: true } } } : {}),
      ...options.preset.extraBody,
    };
    for (const quirk of quirks) if (quirk.startsWith("drop:")) delete body[quirk.slice(5)];
    return body;
  };

  /** Learns from a rejected field. Returns false when the error isn't about a field we can change. */
  const adjust = (error: ProviderError, body: Record<string, unknown>): boolean => {
    if (error.kind !== "bad_request") return false;
    const message = error.message;
    if ("max_tokens" in body && /max_completion_tokens/.test(message)) {
      quirks.add("max_completion_tokens");
    } else if ("max_completion_tokens" in body && /max_completion_tokens/.test(message)) {
      quirks.add("max_tokens");
    } else if ("response_format" in body && /response_format|json|schema/i.test(message)) {
      // Structured output is optional: the prompt describes the format too.
      quirks.add("drop:response_format");
    } else {
      const field = Object.keys(body).find(
        (key) => !["model", "messages", "stream", "max_tokens", "max_completion_tokens", "tools", "tool_choice"].includes(key) && message.includes(key),
      );
      if (!field) return false;
      quirks.add(`drop:${field}`);
    }
    options.onAdjust(`${options.model}: server rejected a request field, retrying without it (${message.slice(0, 160)})`);
    return true;
  };

  return {
    async chat(request: ChatRequest): Promise<ChatResult> {
      for (let attempt = 0; ; attempt++) {
        const body = buildBody(request);
        try {
          const json = await withRetry(
            () => requestJson(`${base}/chat/completions`, { headers, body }, request),
            (error, waitMs) => options.onAdjust(`${error.kind}; retrying in ${waitMs} ms`),
            request.signal,
          );
          return parseCompletion(json, options.model);
        } catch (error) {
          if (attempt < 3 && error instanceof ProviderError && adjust(error, body)) continue;
          throw error;
        }
      }
    },

    async listModels(timeoutMs = 15_000) {
      const json = await requestJson(`${base}/models`, { headers }, { timeoutMs });
      const parsed = ModelList.safeParse(json);
      if (!parsed.success) throw new ProviderError("bad_response", "The model list had an unexpected shape");
      return parsed.data.data
        .map((model) => ({ id: model.id.replace(/^models\//, "") }))
        .sort((a, b) => a.id.localeCompare(b.id));
    },

    async capabilities(http, refresh = false): Promise<Capabilities> {
      if (refresh) { visionChecks.delete(quirkKey); quirks.delete("no-tools"); }
      let check = visionChecks.get(quirkKey);
      if (!check) {
        check = (async () => {
          // llama.cpp declares modalities without loading images into a text-only model.
          if (isLocalUrl(base)) {
            const propsUrl = new URL(base);
            propsUrl.pathname = propsUrl.pathname.replace(/\/(v1)?\/?$/, "") + "/props";
            propsUrl.search = new URLSearchParams({ model: options.model }).toString();
            try {
              const json = await requestJson(propsUrl.href, { headers }, http);
              const props = z.object({ modalities: z.object({ vision: z.boolean() }) }).safeParse(json);
              if (props.success) return props.data.modalities.vision;
            } catch (error) {
              if (http.signal?.aborted) throw error;
              if (!(error instanceof ProviderError) || ["auth", "billing", "rate_limit", "unreachable", "timeout"].includes(error.kind) || [502, 503, 504].includes(error.status ?? 0)) throw error;
            }
          }
          const probe = visionProbe();
          for (let attempt = 0; ; attempt++) {
            const body = buildBody({ system: "Describe the supplied image.", turns: [], maxTokens: 1024, temperature: 0, timeoutMs: http.timeoutMs });
            body.messages = [{ role: "user", content: [{ type: "text", text: "Name the left color and then the right color. Use only two color names separated by a comma." }, { type: "image_url", image_url: { url: `data:image/png;base64,${Buffer.from(probe.image).toString("base64")}` } }] }];
            try {
              const result = parseCompletion(await requestJson(`${base}/chat/completions`, { headers, body }, http), options.model);
              return (result.text.toLowerCase().match(/\b(red|green|blue|yellow|black|white)\b/g) ?? []).join(" ") === probe.answer;
            } catch (error) {
              // A rejected optional setting is unrelated to vision. Learn and retry it first.
              if (attempt < 3 && error instanceof ProviderError && adjust(error, body)) continue;
              // Text-only compatible servers also reject images with 404/500 responses.
              if (error instanceof ProviderError && [400, 404, 415, 422, 500].includes(error.status ?? 0) && !["auth", "billing", "rate_limit", "timeout"].includes(error.kind)) return false;
              throw error;
            }
          }
        })();
        visionChecks.set(quirkKey, check);
      }
      try { return { tools: !quirks.has("no-tools"), vision: await awaitWithAbort(check, http.signal) }; }
      catch (error) { if (visionChecks.get(quirkKey) === check) visionChecks.delete(quirkKey); throw error; }
    },

    agent(request) {
      const messages: Message[] = [{ role: "system", content: request.system }, ...normalizeTurns(request.turns).map((turn): Message => turn.role === "assistant" ? { role: "assistant", content: turn.content } : { role: "user", content: turn.content })];
      const tools = computerTools(request.vision, request.browser);
      let sequence = 0;
      // Where the latest screenshot or page sits. The one before is blanked: each costs as much context as a long reply.
      let observation: { index: number; image: boolean } | undefined;
      return {
        async next(results, http) {
          if (quirks.has("no-tools")) throw new ProviderError("no_tools", "This model does not accept function tools");
          for (const result of results) messages.push({ role: "tool", tool_call_id: result.id, content: `${result.isError ? "Error: " : ""}${result.text}` });
          const latest = results.findLast((result) => result.image || result.page);
          if (latest) {
            if (observation) messages[observation.index] = { role: "user", content: `[earlier ${observation.image ? "screenshot" : "page"} removed]` };
            const text = [latest.page, latest.caption ?? "Current primary screen after the actions."].filter(Boolean).join("\n\n");
            observation = { index: messages.length, image: !!latest.image };
            // Text-only pages stay plain strings, which every compatible server accepts.
            messages.push(latest.image
              ? { role: "user", content: [{ type: "text", text }, { type: "image_url", image_url: { url: `data:image/png;base64,${Buffer.from(latest.image).toString("base64")}` } }] }
              : { role: "user", content: text });
          }
          for (let attempt = 0; ; attempt++) {
            const body = buildBody({ ...request, temperature: stepTemperature(request, results), timeoutMs: http.timeoutMs });
            body.messages = messages;
            body.tools = tools.map((tool) => ({ type: "function", function: { name: tool.name, description: tool.description, parameters: toolSchema(tool) } }));
            try {
              const json = await withRetry(() => requestJson(`${base}/chat/completions`, { headers, body }, http), (error, wait) => options.onAdjust(`${error.kind}; retrying in ${wait} ms`), http.signal);
              const parsed = ChatCompletion.safeParse(json);
              if (!parsed.success) throw new ProviderError("bad_response", "Unexpected tool response");
              const choice = parsed.data.choices[0]!;
              const result = parseCompletion(json, options.model);
              if (result.finish === "refusal") throw new ProviderError("refused", "The model declined the computer request");
              const native = choice.message.tool_calls ?? [];
              // Local servers whose template parser misses a call leave it in the text. Recorded as
              // a real tool call, because tool results must follow one.
              const written = native.length ? { calls: [], text: result.text } : toolCallsInText(result.text, tools.map((tool) => tool.name));
              const recovered = written.calls.map((call) => ({ ...call, id: `text-call-${++sequence}` }));
              messages.push(recovered.length
                ? { role: "assistant", content: written.text || null, tool_calls: recovered.map((call) => ({ id: call.id, type: "function" as const, function: { name: call.name, arguments: JSON.stringify(call.input ?? {}) } })) }
                : { ...choice.message, role: "assistant" });
              const calls: ToolCall[] = [...native.map((call) => {
                try {
                  if (typeof call.function.arguments !== "string") throw new Error("Tool arguments must be a JSON string");
                  return { id: call.id, name: call.function.name, input: JSON.parse(call.function.arguments) as unknown };
                } catch { return { id: call.id, name: call.function.name, input: null, error: "Malformed tool arguments. Send a valid JSON object." }; }
              }), ...recovered];
              return { text: written.text, model: result.model, finish: result.finish, calls };
            } catch (error) {
              if (error instanceof ProviderError && toolsUnsupported(error)) {
                quirks.add("no-tools");
                throw new ProviderError("no_tools", error.message, error.status);
              }
              if (attempt < 3 && error instanceof ProviderError && adjust(error, body)) continue;
              throw error;
            }
          }
        },
      };
    },
  };
}

function visionProbe() {
  const colors = [
    { name: "red", rgb: [255, 0, 0] }, { name: "green", rgb: [0, 255, 0] },
    { name: "blue", rgb: [0, 0, 255] }, { name: "yellow", rgb: [255, 255, 0] },
    { name: "black", rgb: [0, 0, 0] }, { name: "white", rgb: [255, 255, 255] },
  ];
  const left = colors.splice(randomInt(colors.length), 1)[0]!, right = colors[randomInt(colors.length)]!;
  const pixels = new Uint8Array(64 * 32 * 4);
  for (let y = 0; y < 32; y++) for (let x = 0; x < 64; x++) {
    const color = x < 32 ? left : right, at = (y * 64 + x) * 4;
    pixels.set([color.rgb[2]!, color.rgb[1]!, color.rgb[0]!, 255], at);
  }
  return { image: bgraToPng(pixels, 64, 32), answer: `${left.name} ${right.name}` };
}

/** Pictures go as content parts with data URLs; plain turns stay plain strings for older servers. */
const toMessage = ({ role, content, images }: ChatTurn) =>
  images?.length
    ? {
        role,
        content: [
          { type: "text", text: content },
          ...images.map((image) => ({ type: "image_url", image_url: { url: `data:${image.mediaType};base64,${image.data}` } })),
        ],
      }
    : { role, content };

function parseCompletion(json: unknown, model: string): ChatResult {
  const parsed = ChatCompletion.safeParse(json);
  if (!parsed.success) {
    throw new ProviderError("bad_response", `Unexpected chat response: ${JSON.stringify(json).slice(0, 300)}`);
  }
  const choice = parsed.data.choices[0]!;
  const content = choice.message.content;
  const text = typeof content === "string" ? content : (content ?? []).map((part) => part.text ?? "").join("");
  if (!text && choice.message.refusal) throw new ProviderError("refused", choice.message.refusal);
  const finish = choice.finish_reason;
  return {
    text,
    reasoning: choice.message.reasoning_content ?? choice.message.reasoning ?? "",
    finish: finish === "stop" ? "stop" : finish === "length" ? "length" : finish === "content_filter" ? "refusal" : "other",
    model: parsed.data.model ?? model,
  };
}
