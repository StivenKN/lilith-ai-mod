// Native Ollama API. Uses `think: false` (Qwen-style models otherwise spend the whole budget
// thinking) and a context window big enough for the persona. Every request sets how long the
// model stays in memory afterwards, so Ollama frees it on its own once Lilith goes unused, even if
// this process is killed. Also loads and unloads models on demand, and has the extras the setup
// wizard needs.

import { z } from "zod";
import { computerTools, toolCallsInText, toolSchema } from "../computer/actions.ts";
import { awaitWithAbort, requestJson, send, toolsUnsupported, trimSlash } from "./http.ts";
import { normalizeTurns, ProviderError, stepTemperature, type Capabilities, type ChatRequest, type ChatResult, type ModelInfo, type Provider, type ToolCall } from "./types.ts";

/** Minutes a model stays loaded after its last request, unless the settings say otherwise. */
export const UNLOAD_AFTER_MINUTES = 10;
const NUM_CTX = 8192;
const keepAlive = (minutes = UNLOAD_AFTER_MINUTES) => `${minutes}m`;

const OllamaMessage = z.looseObject({
  content: z.string().default(""), thinking: z.string().optional(),
  tool_calls: z.array(z.looseObject({ function: z.looseObject({ name: z.string(), arguments: z.unknown() }) })).optional(),
});
const ChatResponse = z.object({
  model: z.string().optional(),
  message: OllamaMessage,
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
const capabilityChecks = new Map<string, Promise<Capabilities>>();

export interface OllamaOptions {
  baseUrl: string;
  model: string;
  unloadAfterMinutes?: number | undefined;
  onAdjust: (message: string) => void;
}

export function createOllamaProvider(options: OllamaOptions): Provider {
  const base = ollamaBase(options.baseUrl);
  const key = `${base}|${options.model}`;
  let noTools = false;
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
                messages: [
                  { role: "system", content: request.system },
                  ...normalizeTurns(request.turns).map(({ role, content, images }) =>
                    images?.length ? { role, content, images: images.map((image) => image.data) } : { role, content },
                  ),
                ],
                stream: false,
                ...(useThink ? { think: false } : {}),
                ...(request.json ? { format: request.json.schema } : {}),
                keep_alive: keepAlive(options.unloadAfterMinutes),
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

    async capabilities(http, refresh = false) {
      if (refresh) { capabilityChecks.delete(key); noTools = false; }
      let check = capabilityChecks.get(key);
      if (!check) {
        check = (async () => {
          const json = await requestJson(`${base}/api/show`, { body: { model: options.model } }, http);
          const { capabilities } = z.object({ capabilities: z.array(z.string()).default([]) }).parse(json);
          return { tools: capabilities.includes("tools"), vision: capabilities.includes("vision") };
        })();
        capabilityChecks.set(key, check);
      }
      try { const result = await awaitWithAbort(check, http.signal); return { ...result, tools: result.tools && !noTools }; }
      catch (error) { if (capabilityChecks.get(key) === check) capabilityChecks.delete(key); throw error; }
    },

    agent(request) {
      type Message = { role: "system" | "user" | "assistant" | "tool"; content: string; tool_name?: string; images?: string[]; tool_calls?: z.infer<typeof OllamaMessage>["tool_calls"] };
      const messages: Message[] = [{ role: "system", content: request.system }, ...normalizeTurns(request.turns).map(({ role, content }) => ({ role, content }))];
      const tools = computerTools(request.vision);
      let pending: ToolCall[] = [];
      let sequence = 0;
      return {
        async next(results, http) {
          if (noTools) throw new ProviderError("no_tools", "This Ollama model does not accept tools");
          for (const result of results) messages.push({ role: "tool", tool_name: pending.find((call) => call.id === result.id)?.name ?? "", content: `${result.isError ? "Error: " : ""}${result.text}` });
          const latest = results.findLast((result) => result.image);
          if (latest?.image) {
            for (const message of messages) if (message.images) { delete message.images; message.content = "[earlier screenshot removed]"; }
            messages.push({ role: "user", content: latest.caption ?? "Current primary screen after the actions.", images: [Buffer.from(latest.image).toString("base64")] });
          }
          let temperature = stepTemperature(request, results);
          for (let attempt = 0; ; attempt++) {
            const useThink = !noThinkModels.has(options.model);
            try {
              const json = await requestJson(`${base}/api/chat`, { body: {
                model: options.model, messages, stream: false, ...(useThink ? { think: false } : {}),
                keep_alive: keepAlive(options.unloadAfterMinutes),
                options: { num_ctx: NUM_CTX, num_predict: request.maxTokens, temperature },
                tools: tools.map((tool) => ({ type: "function", function: { name: tool.name, description: tool.description, parameters: toolSchema(tool) } })),
              } }, http);
              const parsed = ChatResponse.safeParse(json);
              if (!parsed.success) throw new ProviderError("bad_response", "Unexpected Ollama tool response");
              const { message } = parsed.data;
              messages.push({ ...message, role: "assistant" });
              const native = message.tool_calls ?? [];
              // Models without Ollama's built-in tool parser can leave the call in the text.
              const written = native.length ? { calls: [], text: message.content } : toolCallsInText(message.content, tools.map((tool) => tool.name));
              pending = [
                ...native.map((call) => ({ name: call.function.name, input: call.function.arguments })),
                ...written.calls,
              ].map((call) => ({ ...call, id: `ollama-${++sequence}` }));
              return { calls: pending, text: written.text, model: parsed.data.model ?? options.model, finish: parsed.data.done_reason === "length" ? "length" : "stop" };
            } catch (error) {
              if (error instanceof ProviderError && toolsUnsupported(error)) {
                noTools = true;
                capabilityChecks.set(key, Promise.resolve({ tools: false, vision: request.vision }));
                throw new ProviderError("no_tools", error.message, 400);
              }
              if (attempt === 0 && useThink && error instanceof ProviderError && error.kind === "bad_request" && /think/i.test(error.message)) {
                noThinkModels.add(options.model);
                options.onAdjust(`${options.model} does not accept "think"; retrying without it`);
                continue;
              }
              // Ollama fails the whole request when the model writes a tool call it can't parse.
              // That's sampling noise, so ask again, a little warmer, rather than lose the task.
              if (attempt < 2 && error instanceof ProviderError && error.status === 500 && /invalid character|unexpected end of JSON|cannot unmarshal/i.test(error.message)) {
                temperature = Math.min(1, temperature + 0.3);
                options.onAdjust(`${options.model} wrote a malformed tool call; asking again`);
                continue;
              }
              throw error;
            }
          }
        },
      };
    },
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

/** Whether the model is in memory. Ollama lists a model while it's still loading, too. */
export async function isOllamaModelLoaded(baseUrl: string, model: string): Promise<boolean> {
  try {
    const json = await requestJson(`${ollamaBase(baseUrl)}/api/ps`, {}, { timeoutMs: 2_000 });
    return Ps.parse(json).models.some((loaded) => loaded.name === model || loaded.name === `${model}:latest`);
  } catch {
    return false;
  }
}

/**
 * Loads the model (or restarts its idle countdown) so the next message doesn't wait for it. With the
 * same context size as chat: Ollama reloads a model whose context size changes between requests.
 */
export async function warmUpOllama(baseUrl: string, model: string, unloadAfterMinutes?: number): Promise<void> {
  await requestJson(`${ollamaBase(baseUrl)}/api/generate`, { body: { model, keep_alive: keepAlive(unloadAfterMinutes), options: { num_ctx: NUM_CTX } } }, { timeoutMs: 300_000 });
}

/**
 * Frees the model's memory now (what `ollama stop` does). Returns whether it was loaded. Never
 * throws: Ollama may be closed, or the model deleted, and either way there's nothing to free.
 */
export async function unloadOllama(baseUrl: string, model: string): Promise<boolean> {
  if (!(await isOllamaModelLoaded(baseUrl, model))) return false;
  try {
    await requestJson(`${ollamaBase(baseUrl)}/api/generate`, { body: { model, keep_alive: 0 } }, { timeoutMs: 2_000 });
    return true;
  } catch {
    return false;
  }
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
