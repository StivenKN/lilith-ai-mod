// Native Ollama API. Uses `think: false` (Qwen-style models otherwise spend the whole budget
// thinking), a context window big enough for the persona, and a long keep-alive so the model
// stays loaded between messages. Also exposes the extras the setup wizard needs.

import { z } from "zod";
import { requestJson, send, trimSlash } from "./http.ts";
import { normalizeTurns, ProviderError, type ChatRequest, type ChatResult, type ModelInfo, type Provider } from "./types.ts";

const KEEP_ALIVE = "30m";
const NUM_CTX = 8192;

const ChatResponse = z.object({
  model: z.string().optional(),
  message: z.object({ content: z.string().default(""), thinking: z.string().optional() }),
  done_reason: z.string().optional(),
});
const Tags = z.object({ models: z.array(z.object({ name: z.string(), size: z.number().optional() })) });
const Ps = z.object({ models: z.array(z.object({ name: z.string() })) });
const PullEvent = z.object({
  status: z.string().optional(),
  total: z.number().optional(),
  completed: z.number().optional(),
  error: z.string().optional(),
});
export type PullProgress = z.infer<typeof PullEvent>;

/** Accepts what users paste: ".../v1", ".../api", trailing slashes. */
export const ollamaBase = (url: string): string => trimSlash(url).replace(/\/(v1|api)$/i, "");

const noThinkModels = new Set<string>();

export interface OllamaOptions {
  baseUrl: string;
  model: string;
  onAdjust: (message: string) => void;
}

export function createOllamaProvider(options: OllamaOptions): Provider {
  const base = ollamaBase(options.baseUrl);
  return {
    async chat(request: ChatRequest): Promise<ChatResult> {
      for (let attempt = 0; ; attempt++) {
        const useThink = !noThinkModels.has(options.model);
        try {
          const json = await requestJson(
            `${base}/api/chat`,
            {
              body: {
                model: options.model,
                messages: [{ role: "system", content: request.system }, ...normalizeTurns(request.turns)],
                stream: false,
                ...(useThink ? { think: false } : {}),
                keep_alive: KEEP_ALIVE,
                options: { num_ctx: NUM_CTX, num_predict: request.maxTokens, temperature: request.temperature },
              },
            },
            request,
          );
          const parsed = ChatResponse.safeParse(json);
          if (!parsed.success) throw new ProviderError("bad_response", `Unexpected Ollama response: ${JSON.stringify(json).slice(0, 300)}`);
          return {
            text: parsed.data.message.content,
            reasoning: parsed.data.message.thinking ?? "",
            finish: parsed.data.done_reason === "length" ? "length" : "stop",
            model: parsed.data.model ?? options.model,
          };
        } catch (error) {
          if (attempt === 0 && useThink && error instanceof ProviderError && /think/i.test(error.message)) {
            noThinkModels.add(options.model);
            options.onAdjust(`${options.model} does not accept "think"; retrying without it`);
            continue;
          }
          if (error instanceof ProviderError && error.kind === "unreachable") {
            throw new ProviderError("unreachable", `Ollama is not running at ${base} (${error.message})`);
          }
          throw error;
        }
      }
    },

    listModels: (timeoutMs) => listOllamaModels(base, timeoutMs),
  };
}

export async function listOllamaModels(baseUrl: string, timeoutMs = 5_000): Promise<ModelInfo[]> {
  const json = await requestJson(`${ollamaBase(baseUrl)}/api/tags`, {}, { timeoutMs });
  const parsed = Tags.safeParse(json);
  if (!parsed.success) throw new ProviderError("bad_response", "Unexpected /api/tags response");
  return parsed.data.models.map((model) => ({ id: model.name, ...(model.size ? { sizeBytes: model.size } : {}) }));
}

/** Version string if an Ollama server answers at this address, otherwise null. */
export async function ollamaVersion(baseUrl: string): Promise<string | null> {
  try {
    const json = await requestJson(`${ollamaBase(baseUrl)}/api/version`, {}, { timeoutMs: 2_000 });
    return z.object({ version: z.string() }).parse(json).version;
  } catch {
    return null;
  }
}

/** Whether the model is currently loaded in memory (first message after a load is slow). */
export async function isOllamaModelLoaded(baseUrl: string, model: string): Promise<boolean> {
  try {
    const json = await requestJson(`${ollamaBase(baseUrl)}/api/ps`, {}, { timeoutMs: 2_000 });
    return Ps.parse(json).models.some((loaded) => loaded.name === model || loaded.name === `${model}:latest`);
  } catch {
    return false;
  }
}

/** Loads the model in the background so the first chat message doesn't wait for it. */
export async function warmUpOllama(baseUrl: string, model: string): Promise<void> {
  await requestJson(`${ollamaBase(baseUrl)}/api/generate`, { body: { model, keep_alive: KEEP_ALIVE } }, { timeoutMs: 300_000 });
}

/** Downloads a model, reporting progress events as they stream in. */
export async function pullOllamaModel(
  baseUrl: string,
  model: string,
  onProgress: (event: PullProgress) => void,
  signal?: AbortSignal,
): Promise<void> {
  const response = await send(`${ollamaBase(baseUrl)}/api/pull`, { body: { model, stream: true } }, { timeoutMs: 6 * 3600_000, signal });
  if (!response.body) throw new ProviderError("bad_response", "Ollama returned no progress stream");
  const handle = (line: string) => {
    if (!line.trim()) return;
    const event = PullEvent.safeParse(JSON.parse(line));
    if (!event.success) return;
    if (event.data.error) throw new ProviderError("bad_request", event.data.error);
    onProgress(event.data);
  };
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of response.body) {
    buffer += decoder.decode(chunk, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    lines.forEach(handle);
  }
  handle(buffer + decoder.decode());
}
