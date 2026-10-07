// OpenAI-compatible Chat Completions: OpenAI, Gemini, DeepSeek, OpenRouter, Groq, Mistral, xAI,
// LM Studio, llama.cpp, vLLM... Servers disagree on which optional fields they accept, so a 400
// that names a field drops (or renames) it and retries; the lesson is remembered per model.

import { z } from "zod";
import type { Preset } from "./presets.ts";
import { requestJson, trimSlash, withRetry } from "./http.ts";
import { normalizeTurns, ProviderError, type ChatRequest, type ChatResult, type Provider } from "./types.ts";

const ChatCompletion = z.object({
  model: z.string().optional(),
  choices: z
    .array(
      z.object({
        finish_reason: z.string().nullish(),
        message: z.object({
          content: z.union([z.string(), z.array(z.object({ type: z.string(), text: z.string().optional() }))]).nullish(),
          reasoning_content: z.string().nullish(),
          reasoning: z.string().nullish(),
          refusal: z.string().nullish(),
        }),
      }),
    )
    .min(1),
});

const ModelList = z.object({ data: z.array(z.object({ id: z.string() })) });

/** Per (baseUrl, model) adjustments learned from 400 responses. Lives for the process lifetime. */
const learned = new Map<string, Set<string>>();

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
      messages: [{ role: "system", content: request.system }, ...normalizeTurns(request.turns)],
      stream: false,
      [tokensField]: request.maxTokens,
      temperature: request.temperature,
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
    } else {
      const field = Object.keys(body).find(
        (key) => !["model", "messages", "stream", "max_tokens", "max_completion_tokens"].includes(key) && message.includes(key),
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
  };
}

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
