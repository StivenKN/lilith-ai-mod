// The promise of this mod: when something fails, the player sees what failed, in their language,
// in the bubble, instead of a stock in-character line.

import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Brain, computerEnabled } from "./brain.ts";
import { FakeDesktop, type DesktopStatus } from "./computer/desktop.ts";
import { ConfigStore } from "./config.ts";
import { Logger } from "./log.ts";
import { Memory } from "./memory.ts";
import type { CompanionMessage } from "./protocol.ts";

let dir = "";
let server: ReturnType<typeof Bun.serve>;
let respond: (request: Request) => Response | Promise<Response> = () => new Response();
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "lilith-brain-"));
  server = Bun.serve({ port: 0, fetch: (request) => new URL(request.url).pathname === "/props" ? new Response("Not found", { status: 404 }) : respond(request) });
});
afterAll(async () => {
  server.stop(true);
  await rm(dir, { recursive: true, force: true });
});

async function setup(name: string, desktop?: DesktopStatus) {
  const config = await ConfigStore.load(join(dir, `${name}-config.json`));
  await config.update({ provider: { preset: "openai", baseUrl: `http://127.0.0.1:${server.port}/v1`, model: "gpt-x", configured: true }, apiKeys: { openai: "sk-test-abcdefghijklmnop" }, features: { computerControl: "off" } });
  const memory = await Memory.load(join(dir, `${name}-memory.json`));
  const logger = new Logger(null);
  const sent: CompanionMessage[] = [];
  const brain = new Brain({ version: "test", config, memory, logger, send: (m) => sent.push(m), dashboardUrl: () => "", openDashboard: () => {}, onFatal: () => {}, ...(desktop ? { desktop } : {}) });
  brain.handlePluginMessage({ type: "state", idle: true, sleep: false, busy: false, interacting: false, drag: false, langRaw: "Spanish", playerName: "" });
  brain.handlePluginMessage({ type: "hello", v: 1, pluginVersion: "t", gameVersion: "t", unityVersion: "t", bepinexVersion: "t", gameDir: "", caps: {} });
  return { brain, sent, logger, memory, config };
}

describe("Brain", () => {
  test("shows an invalid key as a plain Spanish error in the bubble and the chat window", async () => {
    respond = () => Response.json({ error: { message: "Incorrect API key provided: sk-test-abcdefghijklmnop" } }, { status: 401 });
    const { brain, sent, logger } = await setup("auth");
    const result = await brain.chat("hola", "game");
    expect(result.ok).toBe(false);
    const bubble = sent.find((m) => m.type === "say" && m.text.startsWith("Lilith AI:"));
    expect(bubble).toMatchObject({ text: "Lilith AI: La clave de API de OpenAI no es válida. Vuelve a pegarla en la configuración." });
    expect(sent).toContainEqual(expect.objectContaining({ type: "chatStatus", kind: "error" }));
    // The key never reaches logs or error details.
    expect(JSON.stringify(logger.recent())).not.toContain("abcdefghijklmnop");
    expect(JSON.stringify(result)).not.toContain("abcdefghijklmnop");
  });

  test("retries a reasoning-only reply with a bigger budget", async () => {
    let calls = 0;
    respond = () =>
      Response.json({
        choices: [{ finish_reason: ++calls === 1 ? "length" : "stop", message: { content: calls === 1 ? "" : "[timida] Aquí estoy.", reasoning_content: "hmm" } }],
      });
    const { brain, sent } = await setup("reasoning");
    expect(await brain.chat("¿estás?", "game")).toMatchObject({ ok: true, text: "Aquí estoy.", emotion: "shy" });
    expect(calls).toBe(2);
    expect(sent).toContainEqual(expect.objectContaining({ type: "say", text: "Aquí estoy.", emotion: "shy" }));
  });

  test("keeps a repeated reply out of the model's context", async () => {
    respond = () => Response.json({ choices: [{ finish_reason: "stop", message: { content: "Siempre digo lo mismo, ¿verdad?" } }] });
    const { brain, memory } = await setup("repeat");
    await brain.chat("uno", "dashboard");
    await brain.chat("dos", "dashboard");
    expect(memory.history.filter((turn) => turn.role === "assistant")).toHaveLength(2);
    expect(memory.promptTurns().filter((turn) => turn.role === "assistant")).toHaveLength(1);
  });

  test("runs the web search the model asks for and answers with the results", async () => {
    const systems: string[] = [];
    respond = async (request) => {
      const body = (await request.json()) as { messages: { role: string; content: string }[] };
      systems.push(body.messages[0]!.content);
      const content = systems.length === 1 ? "[buscar: clima en Lima]" : "[feliz] Hoy hay 19 grados en Lima, ¡abrígate un poco!";
      return Response.json({ choices: [{ finish_reason: "stop", message: { content } }] });
    };
    const { brain, sent, logger, config } = await setup("search");
    await config.update({ search: { mode: "firecrawl", apiKey: "fc-secret-key-123456" } });
    const realFetch = globalThis.fetch;
    const searches: unknown[] = [];
    const spy = spyOn(globalThis, "fetch").mockImplementation((async (input: RequestInfo | URL, init?: RequestInit) => {
      if (!String(input).startsWith("https://api.firecrawl.dev/")) return realFetch(input, init);
      searches.push(JSON.parse(String(init?.body)));
      return Response.json({ success: true, data: { web: [{ title: "Lima weather", url: "https://www.bbc.com/weather/lima", description: "19 °C, cloudy" }] } });
    }) as typeof fetch);
    try {
      expect(await brain.chat("¿cómo está el clima?", "game")).toMatchObject({ ok: true, text: "Hoy hay 19 grados en Lima, ¡abrígate un poco!" });
    } finally {
      spy.mockRestore();
    }
    expect(searches).toEqual([expect.objectContaining({ query: "clima en Lima" })]);
    expect(systems[0]).toContain("[buscar: consulta breve]");
    expect(systems[1]).toContain("Lima weather (bbc.com): 19 °C, cloudy");
    expect(sent).toContainEqual(expect.objectContaining({ type: "chatStatus", text: "Buscando en internet: clima en Lima…" }));
    expect(JSON.stringify(logger.recent())).not.toContain("fc-secret-key-123456");
  });
});

test.each([
  ["ollama", "http://127.0.0.1:11434", true],
  ["openai", "https://api.openai.com/v1", false],
  ["custom", "https://api.remote.example/v1", false],
  ["ollama", "https://remote.example/ollama", false],
  ["custom", "http://192.168.1.4:8080", true],
  ["custom", "http://[fd00::1]:8080", true],
  ["custom", "https://[2606:4700::1111]", false],
  ["custom", "https://fc-public.example", false],
  ["custom", "https://10.public.example", false],
] as const)("Automatic control checks the actual %s address %s", (preset, baseUrl, expected) => {
  expect(computerEnabled("auto", { preset, baseUrl })).toBe(expected);
  expect(computerEnabled("on", { preset, baseUrl })).toBe(true);
  expect(computerEnabled("off", { preset, baseUrl })).toBe(false);
});

test("Brain executes one tool turn, shows statuses, and stores only the user and final reply", async () => {
  const desktop = new FakeDesktop();
  let calls = 0;
  respond = async (request) => {
    const path = new URL(request.url).pathname;
    if (path === "/api/show") return Response.json({ capabilities: ["tools", "vision"] });
    if (path === "/api/ps") return Response.json({ models: [{ name: "qwen" }] });
    const body = await request.json() as { messages: Array<{ role: string }> };
    calls++;
    return Response.json({ model: "qwen", message: body.messages.some((message) => message.role === "tool")
      ? { content: "[feliz] Abrí la calculadora." }
      : { content: "", tool_calls: [{ function: { name: "open_app", arguments: { name: "Calculadora" } } }] } });
  };
  const { brain, sent, memory, config } = await setup("computer", { available: true, desktop });
  await config.update({ provider: { preset: "ollama", baseUrl: `http://127.0.0.1:${server.port}`, model: "qwen" }, features: { computerControl: "auto", learnFacts: false } });
  expect(await brain.chat("Abre la calculadora", "game")).toMatchObject({ ok: true, text: "Abrí la calculadora." });
  expect(calls).toBe(2);
  expect(desktop.actions).toEqual([{ type: "openApp", name: "Calculadora" }]);
  expect(sent).toContainEqual({ type: "yieldFocus" });
  expect(sent).toContainEqual({ type: "chatStatus", kind: "thinking", text: "Abriendo Calculadora…" });
  expect(memory.history.map((turn) => turn.role)).toEqual(["user", "assistant"]);
  expect(JSON.stringify(memory.history)).not.toContain("image");
  expect(brain.snapshot().computer).toMatchObject({ available: true, tools: true, vision: true });
});

test("Brain falls back to ordinary chat when the model rejects tools", async () => {
  const desktop = new FakeDesktop();
  let plainCalls = 0;
  respond = async (request) => {
    const body = await request.json() as { tools?: unknown; messages: Array<{ content: unknown }> };
    if (Array.isArray(body.messages.at(-1)?.content)) return Response.json({ error: { message: "Images are not supported" } }, { status: 400 });
    if (body.tools) return Response.json({ error: { message: "This model does not support tools" } }, { status: 400 });
    plainCalls++;
    return Response.json({ choices: [{ finish_reason: "stop", message: { content: "[neutral] Solo puedo conversar." } }] });
  };
  const { brain, config } = await setup("no-tools", { available: true, desktop });
  await config.update({ features: { computerControl: "on", learnFacts: false } });
  expect(await brain.chat("hola", "dashboard")).toMatchObject({ ok: true, text: "Solo puedo conversar." });
  expect(plainCalls).toBe(1);
  expect(desktop.actions).toHaveLength(0);
  expect(brain.snapshot().computer.tools).toBe(false);
});

test("a newer queued message prevents superseded computer tasks from starting", async () => {
  const desktop = new FakeDesktop();
  respond = async (request) => {
    const path = new URL(request.url).pathname;
    if (path === "/api/show") return Response.json({ capabilities: ["tools"] });
    if (path === "/api/ps") return Response.json({ models: [] });
    const body = await request.json() as { tools?: unknown; messages: Array<{ role: string; content: string }> };
    const name = body.messages.findLast((message) => message.role === "user")!.content;
    if (!body.tools) return Response.json({ message: { content: "Recibí tu mensaje." } });
    return Response.json({ message: body.messages.some((message) => message.role === "tool")
      ? { content: "Hecho." }
      : { content: "", tool_calls: [{ function: { name: "open_app", arguments: { name } } }] } });
  };
  const { brain, config } = await setup("queued-computer", { available: true, desktop });
  await config.update({ provider: { preset: "ollama", baseUrl: `http://127.0.0.1:${server.port}`, model: "queue" }, features: { computerControl: "auto", learnFacts: false } });
  const first = brain.chat("Old task", "dashboard");
  const second = brain.chat("New task", "dashboard");
  expect(await first).toMatchObject({ ok: true, text: "Recibí tu mensaje." });
  expect((await second).ok).toBe(true);
  expect(desktop.actions).toEqual([{ type: "openApp", name: "New task" }]);
  const stopped = brain.chat("After shutdown", "dashboard");
  await brain.stop();
  await stopped;
  expect(desktop.actions).toHaveLength(1);
});

test.each([false, true])("a second chat preserves the pending reply and prevents its first action, tools=%s", async (returnsTools) => {
  const desktop = new FakeDesktop();
  let release!: () => void, started!: () => void;
  const waiting = new Promise<void>((resolve) => { release = resolve; });
  const reached = new Promise<void>((resolve) => { started = resolve; });
  respond = async (request) => {
    const path = new URL(request.url).pathname;
    if (path === "/api/show") return Response.json({ capabilities: ["tools"] });
    if (path === "/api/ps") return Response.json({ models: [] });
    const body = await request.json() as { tools?: unknown; messages: Array<{ role: string; content: string }> };
    const user = body.messages.findLast((message) => message.role === "user")!.content;
    if (user === "hola" && body.tools) {
      started();
      await waiting;
      if (returnsTools) return Response.json({ message: { content: "", tool_calls: [{ function: { name: "open_app", arguments: { name: "Notepad" } } }] } });
    }
    return Response.json({ message: { content: user === "hola" ? "Hola, Conan." : "Estoy bien, ¿y tú?" } });
  };
  const { brain, config, memory } = await setup(`pending-chat-${returnsTools}`, { available: true, desktop });
  await config.update({ provider: { preset: "ollama", baseUrl: `http://127.0.0.1:${server.port}`, model: `pending-chat-${returnsTools}` }, features: { computerControl: "auto", learnFacts: false } });
  const first = brain.chat("hola", "game");
  await reached;
  const second = brain.chat("¿cómo estás?", "game");
  release();
  expect(await first).toMatchObject({ ok: true, text: "Hola, Conan." });
  expect(await second).toMatchObject({ ok: true, text: "Estoy bien, ¿y tú?" });
  expect(desktop.actions).toHaveLength(0);
  expect(memory.history.map((turn) => turn.content)).toEqual(["hola", "Hola, Conan.", "¿cómo estás?", "Estoy bien, ¿y tú?"]);
});

test("a newer chat still stops a turn after its first action", async () => {
  const desktop = new FakeDesktop();
  let release!: () => void, started!: () => void;
  const waiting = new Promise<void>((resolve) => { release = resolve; });
  const reached = new Promise<void>((resolve) => { started = resolve; });
  respond = async (request) => {
    const path = new URL(request.url).pathname;
    if (path === "/api/show") return Response.json({ capabilities: ["tools"] });
    if (path === "/api/ps") return Response.json({ models: [] });
    const body = await request.json() as { messages: Array<{ role: string; content: string }> };
    const user = body.messages.findLast((message) => message.role === "user")!.content;
    if (user === "hola") return Response.json({ message: { content: "Aquí sigo." } });
    if (body.messages.some((message) => message.role === "tool")) {
      started();
      await waiting;
      return Response.json({ message: { content: "Done" } });
    }
    return Response.json({ message: { content: "", tool_calls: [{ function: { name: "open_app", arguments: { name: "Notepad" } } }] } });
  };
  const { brain, config } = await setup("cancel-after-action", { available: true, desktop });
  await config.update({ provider: { preset: "ollama", baseUrl: `http://127.0.0.1:${server.port}`, model: "cancel-after-action" }, features: { computerControl: "auto", learnFacts: false } });
  const first = brain.chat("Abre Notepad", "game");
  await reached;
  const second = brain.chat("hola", "game");
  try {
    expect(await first).toMatchObject({ ok: true, text: "Está bien, me detengo." });
    expect(await second).toMatchObject({ ok: true, text: "Aquí sigo." });
    expect(desktop.actions).toEqual([{ type: "openApp", name: "Notepad" }]);
  } finally { release(); }
});

test("a tool rejection after desktop actions reports failure without restarting as plain chat", async () => {
  const desktop = new FakeDesktop();
  let plainCalls = 0;
  respond = async (request) => {
    const path = new URL(request.url).pathname;
    if (path === "/api/show") return Response.json({ capabilities: ["tools"] });
    if (path === "/api/ps") return Response.json({ models: [] });
    const body = await request.json() as { tools?: unknown; messages: Array<{ role: string }> };
    if (!body.tools) { plainCalls++; return Response.json({ message: { content: "Todo listo." } }); }
    if (body.messages.some((message) => message.role === "tool")) return Response.json({ error: "This model does not support tools" }, { status: 400 });
    return Response.json({ message: { content: "", tool_calls: [{ function: { name: "open_app", arguments: { name: "Notepad" } } }] } });
  };
  const { brain, config } = await setup("post-action-failure", { available: true, desktop });
  await config.update({ provider: { preset: "ollama", baseUrl: `http://127.0.0.1:${server.port}`, model: "partial" }, features: { computerControl: "auto", learnFacts: false } });
  expect(await brain.chat("Open Notepad and type hello", "dashboard")).toMatchObject({ ok: false, error: { kind: "no_tools" } });
  expect(desktop.actions).toEqual([{ type: "openApp", name: "Notepad" }]);
  expect(plainCalls).toBe(0);
});

test("an old provider check cannot overwrite capabilities after settings change", async () => {
  let release!: () => void;
  let started!: () => void;
  const waiting = new Promise<void>((resolve) => { release = resolve; });
  const reached = new Promise<void>((resolve) => { started = resolve; });
  respond = async () => { started(); await waiting; return Response.json({ capabilities: ["tools", "vision"] }); };
  const { brain, config } = await setup("stale-computer-check", { available: true, desktop: new FakeDesktop() });
  await config.update({ provider: { preset: "ollama", baseUrl: `http://127.0.0.1:${server.port}`, model: "stale-check" } });
  const checking = brain.computerCheck();
  await reached;
  try { await config.update({ provider: { model: "new-provider" } }); }
  finally { release(); }
  expect(await checking).toMatchObject({ tools: true, vision: true });
  expect(brain.snapshot().computer.tools).toBeUndefined();
});

test.each(["capability", "tool response"] as const)("changing settings during a pending %s preserves chat without stale capabilities or actions", async (stage) => {
  const desktop = new FakeDesktop();
  let release!: () => void, started!: () => void;
  const waiting = new Promise<void>((resolve) => { release = resolve; });
  const reached = new Promise<void>((resolve) => { started = resolve; });
  respond = async (request) => {
    const path = new URL(request.url).pathname;
    if (path === "/api/show") {
      if (stage === "capability") { started(); await waiting; }
      return Response.json({ capabilities: ["tools", "vision"] });
    }
    if (path === "/api/ps") return Response.json({ models: [] });
    const body = await request.json() as { tools?: unknown };
    if (body.tools) {
      started();
      await waiting;
      return Response.json({ message: { content: "", tool_calls: [{ function: { name: "open_app", arguments: { name: "Notepad" } } }] } });
    }
    return Response.json({ message: { content: "Hola, Conan." } });
  };
  const { brain, config, memory } = await setup(`settings-before-action-${stage}`, { available: true, desktop });
  await config.update({ provider: { preset: "ollama", baseUrl: `http://127.0.0.1:${server.port}`, model: `settings-before-action-${stage}` }, features: { computerControl: "auto", learnFacts: false } });
  const replying = brain.chat("hola", "game");
  await reached;
  try { await config.update({ features: { computerControl: "off" }, provider: { model: "new-provider" } }); }
  finally { release(); }
  expect(await replying).toMatchObject({ ok: true, text: "Hola, Conan." });
  expect(desktop.actions).toHaveLength(0);
  expect(brain.snapshot().computer.tools).toBeUndefined();
  expect(memory.history.at(-1)?.content).toBe("Hola, Conan.");
});

test("text-only compatible servers with image 500 and Jinja-disabled tools still chat", async () => {
  const desktop = new FakeDesktop();
  let images = 0, plain = 0, rejectedTools = 0;
  respond = async (request) => {
    const body = await request.json() as { tools?: unknown; messages: Array<{ content: unknown }> };
    if (Array.isArray(body.messages.at(-1)?.content)) { images++; return Response.json({ error: "image input is not supported" }, { status: 500 }); }
    if (body.tools) { rejectedTools++; return Response.json({ error: "tools param requires --jinja flag" }, { status: 500 }); }
    plain++;
    return Response.json({ choices: [{ finish_reason: "stop", message: { content: "[neutral] Aquí sigo." } }] });
  };
  const { brain, config } = await setup("text-server-compat", { available: true, desktop });
  await config.update({ provider: { model: "llama-text" }, features: { computerControl: "auto", learnFacts: false } });
  expect(await brain.chat("hola", "dashboard")).toMatchObject({ ok: true, text: "Aquí sigo." });
  expect((await brain.chat("¿me escuchas?", "dashboard")).ok).toBe(true);
  expect(images).toBe(1);
  expect(rejectedTools).toBe(1);
  expect(plain).toBeGreaterThanOrEqual(2);
  expect(desktop.actions).toHaveLength(0);
});

test("ordinary chat on the computer path retains empty-reply retry behavior", async () => {
  const budgets: number[] = [];
  respond = async (request) => {
    const path = new URL(request.url).pathname;
    if (path === "/api/show") return Response.json({ capabilities: ["tools"] });
    if (path === "/api/ps") return Response.json({ models: [] });
    const body = await request.json() as { tools?: unknown; options: { num_predict: number } };
    budgets.push(body.options.num_predict);
    return Response.json({ message: { content: !body.tools && body.options.num_predict === 4096 ? "[feliz] Ahora sí." : "", thinking: "reasoning" }, done_reason: "length" });
  };
  const { brain, memory, config } = await setup("computer-empty-chat", { available: true, desktop: new FakeDesktop() });
  await config.update({ provider: { preset: "ollama", baseUrl: `http://127.0.0.1:${server.port}`, model: "reasoning-chat" }, features: { computerControl: "auto", learnFacts: false } });
  expect(await brain.chat("hola", "dashboard")).toMatchObject({ ok: true, text: "Ahora sí.", emotion: "happy" });
  expect(budgets).toEqual([4096, 1024, 4096]);
  expect(memory.history.at(-1)?.content).toBe("Ahora sí.");
});
