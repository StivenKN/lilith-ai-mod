// The promise of this mod: when something fails, the player sees what failed, in their language,
// in the bubble, instead of a stock in-character line.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
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
let respond: () => Response = () => new Response();
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "lilith-brain-"));
  server = Bun.serve({ port: 0, fetch: () => respond() });
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
  return { brain, sent, logger, memory };
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
});
