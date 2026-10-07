// End to end: spawn the companion in --bridge mode and talk to it exactly like the game plugin
// does (JSON lines over stdio), with a mock AI server behind it.

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLineDecoder } from "./bridge.ts";
import { PROTOCOL_VERSION } from "./protocol.ts";

describe("line decoder", () => {
  test("decodes a UTF-8 character split across chunks", () => {
    const lines: string[] = [];
    const decoder = createLineDecoder((line) => lines.push(line));
    const bytes = new TextEncoder().encode('{"text":"ñandú ¿sí?"}\n');
    const split = bytes.indexOf(0xc3) + 1; // in the middle of "ñ"
    decoder.push(bytes.slice(0, split));
    decoder.push(bytes.slice(split));
    expect(lines).toEqual(['{"text":"ñandú ¿sí?"}']);
  });

  test("handles CRLF, a BOM, and a final line without newline", () => {
    const lines: string[] = [];
    const decoder = createLineDecoder((line) => lines.push(line));
    decoder.push(new TextEncoder().encode('\uFEFF{"a":1}\r\n{"b":2}'));
    decoder.end();
    expect(lines).toEqual(['{"a":1}', '{"b":2}']);
  });
});

describe("companion --bridge", () => {
  const cleanup: Array<() => unknown> = [];
  afterAll(async () => {
    for (const run of cleanup) await run();
  });

  test("hello → ready, chat → thinking + Spanish reply in the bubble, stdin close → exit", async () => {
    const llm = Bun.serve({
      port: 0,
      fetch: () =>
        Response.json({ model: "mock", choices: [{ finish_reason: "stop", message: { content: "[feliz] ¡Hola! ¿Me extrañaste, pingüino?" } }] }),
    });
    cleanup.push(() => llm.stop(true));
    const dataDir = await mkdtemp(join(tmpdir(), "lilith-bridge-"));
    cleanup.push(() => rm(dataDir, { recursive: true, force: true }));
    await writeFile(
      join(dataDir, "config.json"),
      JSON.stringify({ provider: { preset: "custom", baseUrl: `http://127.0.0.1:${llm.port}/v1`, model: "mock", configured: true } }),
    );

    const child = Bun.spawn([process.execPath, join(import.meta.dir, "main.ts"), "--bridge"], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "inherit",
      env: { ...process.env, LILITH_AI_DATA_DIR: dataDir },
    });
    const received: Array<Record<string, unknown>> = [];
    const waiters: Array<() => void> = [];
    const lines = createLineDecoder((line) => {
      received.push(JSON.parse(line) as Record<string, unknown>);
      waiters.splice(0).forEach((wake) => wake());
    });
    void (async () => {
      for await (const chunk of child.stdout) lines.push(chunk);
    })();
    const waitFor = async (predicate: (message: Record<string, unknown>) => boolean) => {
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline) {
        const found = received.find(predicate);
        if (found) return found;
        await new Promise<void>((wake) => {
          waiters.push(wake);
          setTimeout(wake, 200);
        });
      }
      throw new Error(`timed out; received: ${JSON.stringify(received)}`);
    };
    const send = (message: unknown) => child.stdin.write(`${JSON.stringify(message)}\n`);

    // Same order as the plugin: state first (so the first "ready" is already localized), then hello.
    send({ type: "state", idle: true, sleep: false, busy: false, interacting: false, drag: false, langRaw: "es-419", playerName: "Conan" });
    send({ type: "hello", v: PROTOCOL_VERSION, pluginVersion: "test", gameVersion: "1.1.0", unityVersion: "2021.3.45", bepinexVersion: "be.780", gameDir: "C:\\Game", caps: { say: "ok" } });
    const ready = await waitFor((message) => message.type === "ready");
    expect(ready).toMatchObject({ v: PROTOCOL_VERSION, strings: { placeholder: "Escríbele a Lilith…" } });
    expect(String(ready.dashboardUrl)).toStartWith("http://127.0.0.1:");

    send({ type: "chat", text: "Hola Lilith" });
    await waitFor((message) => message.type === "chatStatus" && message.kind === "thinking");
    const reply = await waitFor((message) => message.type === "say" && message.text !== "…");
    expect(reply).toMatchObject({ text: "¡Hola! ¿Me extrañaste, pingüino?", emotion: "happy" });

    child.stdin.end();
    const code = await Promise.race([child.exited, Bun.sleep(5000).then(() => "still running")]);
    expect(code).toBe(0);
  }, 20_000);
});
