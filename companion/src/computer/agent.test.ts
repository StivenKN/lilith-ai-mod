import { expect, test } from "bun:test";
import { runComputerTurn, type ComputerTurnOptions } from "./agent.ts";
import { FakeDesktop } from "./desktop.ts";
import { waitForLaunchFocus } from "./focus.ts";
import type { AgentSession, AgentStep, ToolCall, ToolResult } from "../providers/types.ts";

const call = (name: string, input: unknown): ToolCall => ({ id: crypto.randomUUID(), name, input });
const step = (...calls: ToolCall[]): AgentStep => ({ calls, text: calls.length ? "" : "Finished.", model: "test", finish: "stop" });
function scripted(...steps: AgentStep[]) {
  const received: ToolResult[][] = [];
  const session: AgentSession = { async next(results) { received.push([...results]); return steps.shift() ?? step(); } };
  return { session, received };
}
const run = (session: AgentSession, desktop = new FakeDesktop(), extra: Partial<ComputerTurnOptions> = {}) => runComputerTurn({ session, desktop, vision: true, http: { timeoutMs: 1000 }, yieldFocus() {}, onStatus() {}, log() {}, settleMs: 0, ...extra });

test("plain chat touches nothing; computer batches yield focus once and return screenshots", async () => {
  const desktop = new FakeDesktop();
  let focuses = 0;
  expect(await run(scripted(step()).session, desktop, { yieldFocus: () => focuses++ })).toMatchObject({ text: "Finished.", outcome: "done" });
  expect(focuses).toBe(0);
  const { session, received } = scripted(step(call("open_app", { name: "Notepad" }), call("type_text", { text: "Hola" })), step());
  await run(session, desktop, { yieldFocus: () => focuses++ });
  expect(focuses).toBe(1);
  expect(desktop.actions.map((action) => action.type)).toEqual(["openApp", "type"]);
  expect(received[1]?.every((result) => result.image)).toBe(true);
});

test("a failed batch action skips its dependent calls", async () => {
  const desktop = new FakeDesktop();
  const { session, received } = scripted(step(call("click", { x: 9000, y: 2 }), call("type_text", { text: "danger" })), step());
  await run(session, desktop);
  expect(desktop.actions).toHaveLength(0);
  expect(received[1]?.[0]).toMatchObject({ isError: true });
  expect(received[1]?.[1]?.text).toBe("Not executed: an earlier computer action in this turn failed.");
});

test("blind mode refuses forged vision calls, and foreground guards reach tool errors", async () => {
  const desktop = new FakeDesktop();
  const blind = scripted(step(call("screenshot", {})), step());
  await run(blind.session, desktop, { vision: false });
  expect(blind.received[1]?.[0]).toMatchObject({ isError: true });
  desktop.focused = { exe: "cmd.exe", className: "ConsoleWindowClass" };
  const guarded = scripted(step(call("type_text", { text: "echo unsafe" })), step());
  await run(guarded.session, desktop);
  expect(guarded.received[1]?.[0]?.text).toContain("disabled");
  expect(desktop.actions).toHaveLength(0);
});

test("player takeover cancels an in-flight model request and closes the watcher", async () => {
  const desktop = new FakeDesktop();
  let requests = 0, closed = false, aborted = false;
  const watch = desktop.watchInput.bind(desktop);
  desktop.watchInput = () => ({ ...watch(), close() { closed = true; } });
  const session: AgentSession = { async next(_results, http) {
    if (++requests === 1) return step(call("open_app", { name: "Notepad" }));
    setTimeout(() => desktop.inputVersion++, 10);
    await new Promise<void>((_resolve, reject) => http.signal!.addEventListener("abort", () => { aborted = true; reject(http.signal!.reason); }, { once: true }));
    return step();
  } };
  expect(await run(session, desktop)).toMatchObject({ outcome: "stopped" });
  expect(aborted).toBe(true);
  expect(closed).toBe(true);
});

test("action and wall-clock caps stop without executing extra calls", async () => {
  const desktop = new FakeDesktop();
  const session = scripted(step(call("open_app", { name: "One" }), call("open_app", { name: "Two" }))).session;
  expect(await run(session, desktop, { maxSteps: 1, vision: false })).toMatchObject({ outcome: "limit" });
  expect(desktop.actions).toHaveLength(1);
  expect(await run(scripted(step({ ...call("wait", { duration: 30 }), toolset: "computer" })).session, new FakeDesktop(), { maxMs: 20 })).toMatchObject({ outcome: "limit" });
});

test("the action deadline starts after model loading, and watcher errors stop before input", async () => {
  const loading: AgentSession = { async next() { await Bun.sleep(30); return step(); } };
  expect(await run(loading, new FakeDesktop(), { maxMs: 10 })).toMatchObject({ outcome: "done" });
  const desktop = new FakeDesktop();
  let closed = false;
  desktop.watchInput = () => ({ changed() { throw new Error("Raw input failed"); }, close() { closed = true; } });
  await expect(run(scripted(step(call("type_text", { text: "Unsafe after watcher failure" }))).session, desktop)).rejects.toThrow("Player input watcher failed: Raw input failed");
  expect(closed).toBe(true);
  expect(desktop.actions).toHaveLength(0);
});

test("blind keyboard batches wait for launch focus and include the focused app in results", async () => {
  const desktop = new FakeDesktop();
  let id = 1;
  desktop.focused = { exe: "game.exe", className: "Game" };
  desktop.execute = async (action, signal) => {
    if (action.type === "openApp") {
      setTimeout(() => { id = 2; desktop.focused = { exe: "notepad.exe", className: "Notepad" }; }, 10);
      await waitForLaunchFocus(1, () => ({ id, ...desktop.focused }), signal, 100, 1);
    }
    if (action.type === "type") expect(desktop.focused.exe).toBe("notepad.exe");
    desktop.actions.push(action);
  };
  const { session, received } = scripted(step(call("open_app", { name: "Notepad" }), call("type_text", { text: "Hola\n" })), step());
  await run(session, desktop, { vision: false });
  expect(desktop.actions.map((action) => action.type)).toEqual(["openApp", "type"]);
  expect(received[1]?.[1]?.text).toContain("focused app: notepad.exe");
});

test("a launch that cannot get focus skips dependent typing", async () => {
  const desktop = new FakeDesktop();
  desktop.execute = async (_action, signal) => { await waitForLaunchFocus(1, () => ({ id: 1, ...desktop.focused }), signal, 5, 1); };
  const { session, received } = scripted(step(call("open_url", { url: "https://example.com" }), call("type_text", { text: "Wrong app\n" })), step());
  await run(session, desktop, { vision: false });
  expect(received[1]?.[0]).toMatchObject({ isError: true, text: expect.stringContaining("focus did not move") });
  expect(received[1]?.[1]).toMatchObject({ isError: true, text: expect.stringContaining("Not executed") });
  expect(desktop.actions).toHaveLength(0);
});

test("superseding a turn during focus handoff prevents its first action", async () => {
  const desktop = new FakeDesktop();
  let current = true;
  expect(await run(scripted(step(call("type_text", { text: "Old task" }))).session, desktop, { canAct: () => current, yieldFocus: () => { current = false; } })).toMatchObject({ outcome: "superseded" });
  expect(desktop.actions).toHaveLength(0);
});
