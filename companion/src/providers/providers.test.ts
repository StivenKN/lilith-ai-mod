// Adapters against local mock servers that replay the failure modes users actually hit.

import { afterAll, describe, expect, test } from "bun:test";
import { createProvider } from "./index.ts";
import { pullOllamaModel, type PullProgress } from "./ollama.ts";
import { ProviderError, type ChatResult } from "./types.ts";

type Handler = (request: Request, body: Record<string, unknown>) => Response | Promise<Response>;

const servers: Array<{ stop: (force?: boolean) => unknown }> = [];
afterAll(() => servers.forEach((server) => server.stop(true)));

/** Starts a mock server; returns its base URL and the request bodies it received. */
function mock(handler: Handler) {
  const bodies: Array<Record<string, unknown>> = [];
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
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
