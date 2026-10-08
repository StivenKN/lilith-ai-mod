// Adapters against local mock servers that replay the failure modes users actually hit.

import { afterAll, describe, expect, test } from "bun:test";
import { inflateSync } from "node:zlib";
import { z } from "zod";
import { bgraToPng } from "../computer/png.ts";
import { createProvider } from "./index.ts";
import { pullOllamaModel, unloadOllama, type PullProgress } from "./ollama.ts";
import { ProviderError, type ChatResult } from "./types.ts";

type Handler = (request: Request, body: Record<string, unknown>) => Response | Promise<Response>;

const servers: Array<{ stop: (force?: boolean) => unknown }> = [];
afterAll(() => servers.forEach((server) => server.stop(true)));

/** Starts a mock server; returns its base URL and the request bodies it received. */
function mock(handler: Handler, props?: { modalities: { vision: boolean } } | (() => Response | Promise<Response>)) {
  const bodies: Array<Record<string, unknown>> = [];
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      if (request.method === "GET" && new URL(request.url).pathname === "/props") return typeof props === "function" ? props() : props ? Response.json(props) : new Response("Not found", { status: 404 });
      const body = request.method === "POST" ? ((await request.json()) as Record<string, unknown>) : {};
      bodies.push(body);
      return handler(request, body);
    },
  });
  servers.push(server);
  return { url: `http://127.0.0.1:${server.port}`, bodies };
}

const completion = (content: string, extra: Record<string, unknown> = {}) =>
  Response.json({ model: "m", choices: [{ finish_reason: "stop", message: { content, ...extra } }] });

const request = { system: "persona", turns: [{ role: "user" as const, content: "¿hola?" }], maxTokens: 100, temperature: 0.8, timeoutMs: 2000 };
const noop = () => {};

async function chatError(promise: Promise<ChatResult>): Promise<ProviderError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof ProviderError) return error;
    throw error;
  }
  throw new Error("expected the request to fail");
}

const openai = (url: string, preset: "openai" | "custom" | "deepseek" = "custom") =>
  createProvider({ preset, baseUrl: `${url}/v1`, model: "m", apiKey: "sk-test-1234567890abcdef" }, noop);

describe("OpenAI-compatible adapter", () => {
  test("returns text and sends the system prompt first", async () => {
    const server = mock(() => completion("¡Hola!"));
    const result = await openai(server.url).chat(request);
    expect(result.text).toBe("¡Hola!");
    expect((server.bodies[0]?.messages as Array<{ role: string }>)[0]?.role).toBe("system");
  });

  test.each([
    [401, { error: { message: "Incorrect API key provided" } }, "auth"],
    [402, { error: { message: "Insufficient Balance" } }, "billing"],
    [429, { error: { message: "You exceeded your current quota, check your plan and billing" } }, "billing"],
    [404, { error: { message: "The model `m` does not exist" } }, "model_not_found"],
    [404, "Not Found", "not_found"],
    [400, { error: { message: "model 'm' is not a valid model ID" } }, "model_not_found"],
  ] as const)("classifies HTTP %i", async (status, body, kind) => {
    const server = mock(() => (typeof body === "string" ? new Response(body, { status }) : Response.json(body, { status })));
    expect((await chatError(openai(server.url).chat(request))).kind).toBe(kind);
  });

  test("retries once after a rate limit, honoring Retry-After", async () => {
    let calls = 0;
    const server = mock(() =>
      ++calls === 1 ? Response.json({ error: { message: "Rate limit" } }, { status: 429, headers: { "retry-after": "0" } }) : completion("ok"),
    );
    expect((await openai(server.url).chat(request)).text).toBe("ok");
    expect(server.bodies).toHaveLength(2);
  });

  test.each(["chat", "tools"] as const)("a cancelled %s request interrupts the Retry-After wait without another request", async (mode) => {
    const server = mock(() => Response.json({ error: { message: "Rate limit" } }, { status: 429, headers: { "retry-after": "15" } }));
    let started!: () => void;
    const reached = new Promise<void>((resolve) => { started = resolve; });
    const provider = createProvider({ preset: "custom", baseUrl: server.url, model: "retry-cancellation", apiKey: "test" }, () => started());
    const controller = new AbortController();
    const pending = mode === "chat" ? provider.chat({ ...request, signal: controller.signal }) : provider.agent({ ...request, vision: false }).next([], { timeoutMs: 2000, signal: controller.signal });
    await reached;
    controller.abort();
    await expect(pending).rejects.toThrow();
    expect(server.bodies).toHaveLength(1);
  });

  test("switches to max_completion_tokens when max_tokens is rejected", async () => {
    const server = mock((_, body) =>
      "max_tokens" in body
        ? Response.json({ error: { message: "Unsupported parameter: 'max_tokens' is not supported with this model. Use 'max_completion_tokens' instead." } }, { status: 400 })
        : completion("ok"),
    );
    expect((await openai(server.url).chat(request)).text).toBe("ok");
    expect(server.bodies.at(-1)).toHaveProperty("max_completion_tokens", 100);
  });

  test("drops a preset field the server doesn't understand", async () => {
    const server = mock((_, body) =>
      "thinking" in body ? Response.json({ error: { message: "Unrecognized request argument supplied: thinking" } }, { status: 400 }) : completion("ok"),
    );
    expect((await openai(server.url, "deepseek").chat(request)).text).toBe("ok");
    expect(server.bodies.at(-1)).not.toHaveProperty("thinking");
  });

  test("reports reasoning separately when the answer is empty", async () => {
    const server = mock(() => completion("", { reasoning_content: "pensando..." }));
    const result = await openai(server.url).chat(request);
    expect(result).toMatchObject({ text: "", reasoning: "pensando..." });
  });

  test("times out with a clear error", async () => {
    const server = mock(async () => {
      await Bun.sleep(500);
      return completion("late");
    });
    expect((await chatError(openai(server.url).chat({ ...request, timeoutMs: 100 }))).kind).toBe("timeout");
  });

  test("reports an unreachable server", async () => {
    const closed = Bun.serve({ port: 0, fetch: () => new Response() });
    const url = `http://127.0.0.1:${closed.port}`;
    closed.stop(true);
    expect((await chatError(openai(url).chat(request))).kind).toBe("unreachable");
  });

  test("requires a key for hosted providers", () => {
    expect(() => createProvider({ preset: "openai", baseUrl: "https://api.openai.com/v1", model: "m", apiKey: "" }, noop)).toThrow(
      ProviderError,
    );
  });
});

describe("Ollama adapter", () => {
  const ollama = (url: string) => createProvider({ preset: "ollama", baseUrl: `${url}/v1`, model: "qwen3.5:4b", apiKey: "" }, noop);

  test("disables thinking, sets the context window, and strips a /v1 suffix", async () => {
    const server = mock((req) => {
      expect(new URL(req.url).pathname).toBe("/api/chat");
      return Response.json({ message: { content: "Hola" }, done_reason: "stop" });
    });
    expect((await ollama(server.url).chat(request)).text).toBe("Hola");
    expect(server.bodies[0]).toMatchObject({ think: false, stream: false, options: { num_ctx: 8192 } });
  });

  test("retries without `think` for models that reject it", async () => {
    const server = mock((_, body) =>
      "think" in body ? Response.json({ error: '"qwen3.5:4b" does not support thinking' }, { status: 400 }) : Response.json({ message: { content: "ok" } }),
    );
    expect((await ollama(server.url).chat(request)).text).toBe("ok");
  });

  test("keeps the model in memory for the configured idle time, and frees it only while it's loaded", async () => {
    let loaded = true;
    const server = mock((req) => {
      const path = new URL(req.url).pathname;
      if (path === "/api/ps") return Response.json({ models: loaded ? [{ name: "qwen3.5:4b" }] : [] });
      if (path === "/api/generate") {
        loaded = false;
        return Response.json({ model: "qwen3.5:4b", done: true, done_reason: "unload" });
      }
      return Response.json({ message: { content: "Hola" } });
    });
    const provider = createProvider({ preset: "ollama", baseUrl: server.url, model: "qwen3.5:4b", apiKey: "", unloadAfterMinutes: 3 }, noop);
    await provider.chat(request);
    expect(server.bodies[0]).toMatchObject({ keep_alive: "3m" });
    expect(await unloadOllama(server.url, "qwen3.5:4b")).toBe(true);
    expect(await unloadOllama(server.url, "qwen3.5:4b")).toBe(false);
    expect(server.bodies.filter((body) => body.keep_alive === 0)).toEqual([{ model: "qwen3.5:4b", keep_alive: 0 }]);
  });

  test("maps a missing model to model_not_found", async () => {
    const server = mock(() => Response.json({ error: 'model "nope" not found, try pulling it first' }, { status: 404 }));
    const provider = createProvider({ preset: "ollama", baseUrl: server.url, model: "nope", apiKey: "" }, noop);
    expect((await chatError(provider.chat(request))).kind).toBe("model_not_found");
  });

  test("streams pull progress", async () => {
    const server = mock(
      () =>
        new Response(
          [{ status: "pulling manifest" }, { status: "downloading", total: 100, completed: 50 }, { status: "success" }]
            .map((event) => JSON.stringify(event))
            .join("\n"),
        ),
    );
    const events: PullProgress[] = [];
    await pullOllamaModel(server.url, "qwen3.5:4b", (event) => events.push(event));
    expect(events.map((event) => event.status)).toEqual(["pulling manifest", "downloading", "success"]);
  });
});

describe("Anthropic adapter", () => {
  const claude = (url: string, model = "claude-opus-5-5") =>
    createProvider({ preset: "anthropic", baseUrl: url, model, apiKey: "sk-ant-test-1234567890" }, noop);
  const message = (text: string, stop_reason = "end_turn") =>
    Response.json({ id: "msg", type: "message", role: "assistant", model: "claude-opus-5-5", content: [{ type: "text", text }], stop_reason, usage: { input_tokens: 1, output_tokens: 1 } });

  test("sends low effort and default fallbacks to current models", async () => {
    const server = mock(() => message("Hola"));
    expect((await claude(server.url).chat(request)).text).toBe("Hola");
    expect(server.bodies[0]).toMatchObject({ output_config: { effort: "low" }, fallbacks: "default" });
  });

  test("omits both for older models", async () => {
    const server = mock(() => message("Hi"));
    await claude(server.url, "claude-haiku-4-5").chat(request);
    expect(server.bodies[0]).not.toHaveProperty("output_config");
    expect(server.bodies[0]).not.toHaveProperty("fallbacks");
  });

  test("turns a refusal into a classified error", async () => {
    const server = mock(() => message("", "refusal"));
    expect((await chatError(claude(server.url).chat(request))).kind).toBe("refused");
  });

  test("classifies an invalid key", async () => {
    const server = mock(() => Response.json({ type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } }, { status: 401 }));
    expect((await chatError(claude(server.url, "claude-sonnet-5-5").chat(request))).kind).toBe("auth");
  });
});

const agentRequest = { ...request, vision: true };
const http = { timeoutMs: 2000 };
const image = bgraToPng(Uint8Array.of(0, 0, 255, 0), 1, 1);
const transcript = z.object({ messages: z.array(z.looseObject({ role: z.string(), content: z.unknown() })) });

function describeProbe(body: Record<string, unknown>) {
  const { messages } = z.object({ messages: z.array(z.object({ content: z.array(z.looseObject({ type: z.string() })) })) }).parse(body);
  const part = z.object({ image_url: z.object({ url: z.string() }) }).parse(messages[0]!.content[1]);
  const png = Buffer.from(part.image_url.url.split(",")[1]!, "base64");
  const bytes = inflateSync(png.subarray(41, 41 + png.readUInt32BE(33)));
  const colors: Record<string, string> = { "255,0,0": "red", "0,255,0": "green", "0,0,255": "blue", "255,255,0": "yellow", "0,0,0": "black", "255,255,255": "white" };
  return completion(`Left: ${colors[[...bytes.subarray(1, 4)].join(",")]}. Right: ${colors[[...bytes.subarray(97, 100)].join(",")]}.`);
}

describe("computer sessions", () => {
  test("llama.cpp text-only metadata avoids sending an image probe", async () => {
    const server = mock(() => { throw new Error("An image probe must not reach a text-only model"); }, { modalities: { vision: false } });
    expect(await openai(server.url).capabilities(http)).toEqual({ tools: true, vision: false });
    expect(server.bodies).toHaveLength(0);
  });

  test.each([502, 503, 504])("HTTP %i capability failures are not cached as blind mode", async (status) => {
    for (const route of ["metadata", "image"] as const) {
      let calls = 0;
      const failure = () => Response.json({ error: "Loading model" }, { status });
      const server = route === "metadata"
        ? mock(() => { throw new Error("No image probe after a transient metadata error"); }, () => ++calls === 1 ? failure() : Response.json({ modalities: { vision: true } }))
        : mock((_request, body) => ++calls === 1 ? failure() : describeProbe(body));
      await expect(openai(server.url).capabilities(http)).rejects.toMatchObject({ status });
      expect(await openai(server.url).capabilities(http)).toEqual({ tools: true, vision: true });
      expect(calls).toBe(2);
    }
  });

  test("a metadata timeout stops before an image probe and permits a fresh check", async () => {
    let calls = 0;
    const server = mock(() => { throw new Error("No image probe after a metadata timeout"); }, async () => {
      if (++calls === 1) await Bun.sleep(50);
      return Response.json({ modalities: { vision: true } });
    });
    await expect(openai(server.url).capabilities({ timeoutMs: 10 })).rejects.toMatchObject({ kind: "timeout" });
    expect(await openai(server.url).capabilities(http)).toEqual({ tools: true, vision: true });
    expect(server.bodies).toHaveLength(0);
  });

  test.each(["openai", "ollama"] as const)("%s tool sessions retain the ordinary chat history", async (preset) => {
    const server = mock(() => preset === "ollama" ? Response.json({ message: { content: "Done" } }) : completion("Done"));
    const turns = Array.from({ length: 19 }, (_, index) => ({ role: index % 2 ? "assistant" as const : "user" as const, content: `Turn ${index}` }));
    const provider = createProvider({ preset, baseUrl: server.url, model: "history", apiKey: "test" }, noop);
    await provider.agent({ ...agentRequest, turns }).next([], http);
    expect(transcript.parse(server.bodies[0]).messages).toHaveLength(20);
  });

  test.each(["openai", "ollama"] as const)("a %s capability caller can stop while another caller owns the probe", async (preset) => {
    let release!: () => void;
    let started!: () => void;
    const waiting = new Promise<void>((resolve) => { release = resolve; });
    const reached = new Promise<void>((resolve) => { started = resolve; });
    const server = mock(async () => {
      started();
      await waiting;
      return preset === "ollama" ? Response.json({ capabilities: ["tools"] }) : completion("Cannot see it");
    });
    const settings = { preset, baseUrl: server.url, model: "shared-probe", apiKey: "test" };
    const owner = createProvider(settings, noop).capabilities(http);
    await reached;
    const controller = new AbortController();
    const second = createProvider(settings, noop).capabilities({ ...http, signal: controller.signal });
    controller.abort(new Error("Stopped"));
    try { await expect(second).rejects.toThrow("Stopped"); }
    finally { release(); await owner; }
  });

  test.each(["openai", "ollama", "anthropic"] as const)("a malformed %s tool transcript does not disable tools", async (preset) => {
    const server = mock(() => Response.json({ error: { message: "tool results have invalid tool_call_id" } }, { status: 400 }));
    const provider = createProvider({ preset, baseUrl: server.url, model: "transcript-error", apiKey: "test" }, noop);
    await expect(provider.agent(agentRequest).next([], http)).rejects.toMatchObject({ kind: "bad_request" });
    await expect(provider.agent(agentRequest).next([], http)).rejects.toMatchObject({ kind: "bad_request" });
    expect(server.bodies).toHaveLength(2);
  });

  test("OpenAI preserves thought signatures and tool ids, sends only the newest image", async () => {
    const signature = { thought_signature: "keep-me" };
    let n = 0;
    const server = mock(() => completion("", { role: "assistant", tool_calls: [{ id: `call-${++n}`, type: "function", function: { name: "screenshot", arguments: "{}" }, extra_content: { google: signature } }] }));
    const session = openai(server.url).agent(agentRequest);
    const first = await session.next([], http);
    await session.next([{ id: first.calls[0]!.id, text: "OK", image }], http);
    await session.next([{ id: "call-2", text: "OK", image }], http);
    const last = transcript.parse(server.bodies.at(-1)).messages;
    expect(last.find((message) => message.role === "assistant")).toHaveProperty("tool_calls.0.extra_content.google", signature);
    expect(last.find((message) => message.role === "tool")).toMatchObject({ tool_call_id: "call-1" });
    expect(JSON.stringify(last).match(/data:image\/png/g)).toHaveLength(1);
    expect(JSON.stringify(last)).toContain("earlier screenshot removed");
  });

  test("malformed OpenAI arguments become a tool error, and a tools 400 never strips tools", async () => {
    const bad = mock(() => completion("", { tool_calls: [{ id: "bad", type: "function", function: { name: "open_app", arguments: "{" } }] }));
    const result = await openai(bad.url).agent(agentRequest).next([], http);
    expect(result.calls[0]?.error).toContain("Malformed");
    const rejected = mock((_request, body) => body.tools ? Response.json({ error: { message: "This model does not support tools" } }, { status: 400 }) : completion("plain chat"));
    const provider = openai(rejected.url);
    await expect(provider.agent(agentRequest).next([], http)).rejects.toMatchObject({ kind: "no_tools" });
    expect(rejected.bodies).toHaveLength(1);
    expect(rejected.bodies[0]).toHaveProperty("tools");
    expect((await provider.chat(request)).text).toBe("plain chat");
  });

  test.each(["openai", "anthropic"] as const)("%s remembers unsupported tools across instances and permits a refresh", async (preset) => {
    const server = mock(() => Response.json({ error: { message: "This model does not support tools" } }, { status: 400 }), { modalities: { vision: false } });
    const settings = { preset, baseUrl: server.url, model: "text-only-tools", apiKey: "test" };
    await expect(createProvider(settings, noop).agent({ ...agentRequest, vision: false }).next([], http)).rejects.toMatchObject({ kind: "no_tools" });
    const provider = createProvider(settings, noop);
    expect(await provider.capabilities(http)).toEqual({ tools: false, vision: false });
    await expect(provider.agent({ ...agentRequest, vision: false }).next([], http)).rejects.toMatchObject({ kind: "no_tools" });
    expect(server.bodies).toHaveLength(1);
    expect(await provider.capabilities(http, true)).toEqual({ tools: true, vision: false });
  });

  test("vLLM's disabled auto tool choice is remembered", async () => {
    const server = mock(() => Response.json({ error: { message: '"auto" tool choice requires --enable-auto-tool-choice' } }, { status: 400 }));
    const provider = openai(server.url);
    await expect(provider.agent(agentRequest).next([], http)).rejects.toMatchObject({ kind: "no_tools" });
    await expect(openai(server.url).agent(agentRequest).next([], http)).rejects.toMatchObject({ kind: "no_tools" });
    expect(server.bodies).toHaveLength(1);
  });

  test("compatible vision probes require the actual colors and cache the result", async () => {
    const server = mock((_request, body) => {
      expect(Number(body.max_tokens)).toBeGreaterThanOrEqual(1024);
      return describeProbe(body);
    });
    const provider = openai(server.url);
    expect(await provider.capabilities(http)).toEqual({ tools: true, vision: true });
    expect(await provider.capabilities(http)).toEqual({ tools: true, vision: true });
    expect(server.bodies).toHaveLength(1);
    await provider.capabilities(http, true);
    expect(server.bodies).toHaveLength(2);
    const blind = mock(() => completion("I cannot see an image"));
    expect(await openai(blind.url).capabilities(http)).toEqual({ tools: true, vision: false });
  });

  test("Ollama reads capabilities and returns tool_name with only the latest screenshot", async () => {
    const server = mock((request) => new URL(request.url).pathname === "/api/show"
      ? Response.json({ capabilities: ["tools", "vision"] })
      : Response.json({ message: { content: "", tool_calls: [{ function: { name: "screenshot", arguments: {} } }] } }));
    const provider = createProvider({ preset: "ollama", baseUrl: server.url, model: "qwen", apiKey: "" }, noop);
    expect(await provider.capabilities(http)).toEqual({ tools: true, vision: true });
    const session = provider.agent(agentRequest);
    const first = await session.next([], http);
    const second = await session.next([{ id: first.calls[0]!.id, text: "OK", image }], http);
    await session.next([{ id: second.calls[0]!.id, text: "OK", image }], http);
    const messages = transcript.parse(server.bodies.at(-1)).messages;
    expect(messages.find((message) => message.role === "tool")).toMatchObject({ tool_name: "screenshot" });
    expect(messages.filter((message) => "images" in message)).toHaveLength(1);
    expect(server.bodies.at(-1)).toHaveProperty("options.num_ctx", 8192);
  });

  test("Claude echoes native toolset results and thinking blocks without refusal fallbacks", async () => {
    const content = [{ type: "thinking", thinking: "reason", signature: "sig" }, { type: "tool_use", id: "native", toolset_name: "computer", name: "screenshot", input: {} }];
    let n = 0;
    const server = mock(() => Response.json({ id: "msg", type: "message", role: "assistant", model: "claude-opus-5-5", content: ++n === 1 ? content : [{ type: "text", text: "Done" }], stop_reason: n === 1 ? "tool_use" : "end_turn", usage: { input_tokens: 1, output_tokens: 1 } }));
    const provider = createProvider({ preset: "anthropic", baseUrl: server.url, model: "claude-opus-5-5", apiKey: "test" }, noop);
    const session = provider.agent(agentRequest);
    expect((await session.next([], http)).calls[0]).toHaveProperty("toolset", "computer");
    expect((await session.next([{ id: "native", text: "OK", image }], http)).text).toBe("Done");
    const messages = transcript.parse(server.bodies[1]).messages;
    expect(messages.find((message) => message.role === "assistant")?.content).toEqual(content);
    expect(messages.at(-1)?.content).toEqual([expect.objectContaining({ type: "tool_result", tool_use_id: "native", toolset_name: "computer", content: [expect.objectContaining({ type: "text" }), expect.objectContaining({ type: "image" })] })]);
    expect(server.bodies[0]).not.toHaveProperty("fallbacks");
    expect(server.bodies[0]).toHaveProperty("cache_control.type", "ephemeral");
  });

  test("a rejected Claude toolset retries with custom tools", async () => {
    const server = mock((_request, body) => JSON.stringify(body.tools).includes("computer_toolset")
      ? Response.json({ type: "error", error: { type: "invalid_request_error", message: "computer toolset is not supported" } }, { status: 400 })
      : Response.json({ id: "msg", type: "message", role: "assistant", model: "claude-opus-5-5", content: [{ type: "text", text: "Done" }], stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 } }));
    const provider = createProvider({ preset: "anthropic", baseUrl: server.url, model: "claude-opus-5-5", apiKey: "test" }, noop);
    expect((await provider.agent(agentRequest).next([], http)).text).toBe("Done");
    expect(server.bodies).toHaveLength(2);
    expect(JSON.stringify(server.bodies[1]?.tools)).not.toContain("toolset");
    expect(JSON.stringify(server.bodies[1]?.tools)).toContain("type_text");
  });
});

describe("pictures", () => {
  const withPicture = {
    ...request,
    turns: [{ role: "user" as const, content: "Describe the picture.", images: [{ mediaType: "image/jpeg" as const, data: "/9j/AAAA" }] }],
  };
  const lastMessage = (body: Record<string, unknown> | undefined) => (body?.messages as unknown[] | undefined)?.at(-1);

  test.each([
    [
      "OpenAI-compatible",
      () => completion("ok"),
      (url: string) => createProvider({ preset: "custom", baseUrl: `${url}/v1`, model: "m", apiKey: "" }, noop),
      {
        role: "user",
        content: [
          { type: "text", text: "Describe the picture." },
          { type: "image_url", image_url: { url: "data:image/jpeg;base64,/9j/AAAA" } },
        ],
      },
    ],
    [
      "Ollama",
      () => Response.json({ message: { content: "ok" }, done_reason: "stop" }),
      (url: string) => createProvider({ preset: "ollama", baseUrl: url, model: "qwen3.5:4b", apiKey: "" }, noop),
      { role: "user", content: "Describe the picture.", images: ["/9j/AAAA"] },
    ],
    [
      "Anthropic",
      () => Response.json({ id: "msg", type: "message", role: "assistant", model: "m", content: [{ type: "text", text: "ok" }], stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 } }),
      (url: string) => createProvider({ preset: "anthropic", baseUrl: url, model: "claude-haiku-4-5", apiKey: "sk-ant-test-1234567890" }, noop),
      {
        role: "user",
        content: [
          { type: "image", source: { type: "base64", media_type: "image/jpeg", data: "/9j/AAAA" } },
          { type: "text", text: "Describe the picture." },
        ],
      },
    ],
  ] as const)("%s sends them in its own format", async (_, reply, provider, expected) => {
    const server = mock(reply);
    await provider(server.url).chat(withPicture);
    expect(lastMessage(server.bodies[0])).toEqual(expected);
  });
});
