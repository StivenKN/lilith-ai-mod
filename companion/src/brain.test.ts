// The promise of this mod: when something fails, the player sees what failed, in their language,
// in the bubble, instead of a stock in-character line.

import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Brain } from "./brain.ts";
import { ConfigStore } from "./config.ts";
import { Logger } from "./log.ts";
import { Memory } from "./memory.ts";
import type { CompanionMessage } from "./protocol.ts";

let dir = "";
let server: ReturnType<typeof Bun.serve>;
let respond: (request: Request) => Response | Promise<Response> = () => new Response();
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "lilith-brain-"));
  server = Bun.serve({ port: 0, fetch: (request) => respond(request) });
});
afterAll(async () => {
  server.stop(true);
  await rm(dir, { recursive: true, force: true });
});

async function setup(name: string) {
  const config = await ConfigStore.load(join(dir, `${name}-config.json`));
  await config.update({ provider: { preset: "openai", baseUrl: `http://127.0.0.1:${server.port}/v1`, model: "gpt-x", configured: true }, apiKeys: { openai: "sk-test-abcdefghijklmnop" } });
  const memory = await Memory.load(join(dir, `${name}-memory.json`));
  const logger = new Logger(null);
  const sent: CompanionMessage[] = [];
  const brain = new Brain({ version: "test", config, memory, logger, send: (m) => sent.push(m), dashboardUrl: () => "", openDashboard: () => {}, onFatal: () => {} });
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
