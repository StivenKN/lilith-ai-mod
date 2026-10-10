import { expect, test } from "bun:test";
import type { BrowserAction, Observation } from "../browser/session.ts";
import { runComputerTurn, type BrowserTurn, type ComputerTurnOptions } from "./agent.ts";
import { FakeDesktop } from "./desktop.ts";
import { waitForLaunchFocus } from "./focus.ts";
import { bgraToPng } from "../png.ts";
import type { AgentSession, AgentStep, ToolCall, ToolResult } from "../providers/types.ts";

const call = (name: string, input: unknown): ToolCall => ({ id: crypto.randomUUID(), name, input });
const act = (input: Record<string, unknown>) => call("computer_use", input);
const step = (...calls: ToolCall[]): AgentStep => ({ calls, text: calls.length ? "" : "Finished.", model: "test", finish: "stop" });
function scripted(...steps: AgentStep[]) {
  const received: ToolResult[][] = [];
  const session: AgentSession = { async next(results) { received.push([...results]); return steps.shift() ?? step(); } };
  return { session, received };
}
const run = (session: AgentSession, desktop = new FakeDesktop(), extra: Partial<ComputerTurnOptions> = {}) => runComputerTurn({ session, desktop, vision: true, task: "Write hola in Notepad", http: { timeoutMs: 1000 }, yieldFocus() {}, onStatus() {}, log() {}, settleMs: 0, ...extra });

test("plain chat touches nothing; a batch yields focus once and ends with one screenshot, the task and the active window", async () => {
  const desktop = new FakeDesktop();
  let focuses = 0;
  expect(await run(scripted(step()).session, desktop, { yieldFocus: () => focuses++ })).toMatchObject({ text: "Finished.", outcome: "done" });
  expect(focuses).toBe(0);
  const { session, received } = scripted(step(call("open_app", { name: "Notepad" }), act({ action: "type", text: "Hola" })), step());
  await run(session, desktop, { yieldFocus: () => focuses++ });
  expect(focuses).toBe(1);
  expect(desktop.actions.map((action) => action.type)).toEqual(["openApp", "type"]);
  const [opened, typed] = received[1]!;
  expect(opened?.image).toBeUndefined();
  expect(typed?.image).toBeDefined();
  expect(typed?.caption).toContain('Your host asked: "Write hola in Notepad". Do the next step');
  expect(typed?.text).toBe('OK Active window: "Untitled - Notepad" (notepad.exe).');
});

test("a lookup tool call ends the turn before anything in its batch runs, and before parseCall sees it", async () => {
  const desktop = new FakeDesktop();
  const lookup = call("email", { query: "laura" });
  const { session, received } = scripted(step(call("open_app", { name: "Notepad" }), lookup), step());
  expect(await run(session, desktop, { lookupTools: ["email", "web_search"] })).toEqual({ text: "", model: "test", outcome: "lookup", calls: [expect.objectContaining({ name: "open_app" }), lookup] });
  expect(desktop.actions).toHaveLength(0);
  expect(received).toHaveLength(1);
  // Without the tool offered, the same call is a PC call the loop reports as unknown.
  const plain = scripted(step(lookup), step());
  expect(await run(plain.session, desktop)).toMatchObject({ outcome: "done" });
  expect(plain.received[1]?.[0]).toMatchObject({ isError: true });
});

test("after a desktop action, a lookup call is refused and the model is told to answer, so page text cannot steer a lookup", async () => {
  const desktop = new FakeDesktop();
  const lookup = call("email", { query: "laura" });
  const { session, received } = scripted(step(call("open_app", { name: "Notepad" })), step(lookup), step());
  expect(await run(session, desktop, { lookupTools: ["email"] })).toMatchObject({ outcome: "done" });
  expect(received[2]?.[0]).toMatchObject({ id: lookup.id, isError: true, text: expect.stringContaining("without calling tools") });
  expect(desktop.actions.map((action) => action.type)).toEqual(["openApp"]);
});

test("a failed batch action skips its dependent calls", async () => {
  const desktop = new FakeDesktop();
  const { session, received } = scripted(step(act({ action: "left_click", coordinate: [9000, 2] }), act({ action: "type", text: "danger" })), step());
  await run(session, desktop);
  expect(desktop.actions).toHaveLength(0);
  expect(received[1]?.[0]).toMatchObject({ isError: true, text: expect.stringContaining("from 0 to 1000") });
  expect(received[1]?.[1]?.text).toBe("Not executed: an earlier computer action in this turn failed.");
});

test("coordinates picked before seeing the current screen are refused, with the screen attached", async () => {
  const desktop = new FakeDesktop();
  desktop.capture = () => bgraToPng(new Uint8Array(4).fill(desktop.actions.length * 40), 1, 1);
  const click = (x: number) => act({ action: "left_click", coordinate: [x, 500] });
  const { session, received } = scripted(step(click(100)), step(click(100), click(200)), step());
  await run(session, desktop);
  // First guess, with no screenshot yet: refused, and the screen comes back with the error.
  expect(received[1]?.[0]).toMatchObject({ isError: true, text: expect.stringContaining("have not seen the screen") });
  expect(received[1]?.[0]?.image).toBeDefined();
  // Seen now: the first click goes through; the second was planned before it changed the screen.
  expect(desktop.actions).toEqual([expect.objectContaining({ type: "click", at: { x: 128, y: 360 } })]);
  expect(received[2]?.[1]).toMatchObject({ isError: true, text: expect.stringContaining("have not seen the screen") });
});

test("repeating an action that changed nothing is refused, so a small model tries another way", async () => {
  const desktop = new FakeDesktop();
  const click = () => act({ action: "left_click", coordinate: [500, 500] });
  const { session, received } = scripted(step(act({ action: "screenshot" })), step(click()), step(click()), step(click()), step(click()), step(click()));
  // The third refusal ends the task, and the model is asked to say where it got stuck.
  expect(await run(session, desktop)).toMatchObject({ outcome: "done", text: "" });
  expect(received[2]?.[0]?.text).toContain("The screen did not change.");
  expect(received[3]?.[0]).toMatchObject({ isError: true, text: expect.stringContaining("you just did exactly this") });
  expect(received[5]?.[0]?.text).toContain("Tell your host what you managed and where you got stuck");
  expect(received).toHaveLength(6);
  expect(desktop.actions).toHaveLength(1);
});

test("an answer before acting is sent back once; then terminate ends the task and later calls never run", async () => {
  const desktop = new FakeDesktop();
  const answer = (text: string) => act({ action: "answer", text });
  const { session, received } = scripted(step(answer("¿Quieres que lo haga?")), step(answer("It says 42."), act({ action: "type", text: "late" })), step(act({ action: "type", text: "again" })));
  expect(await run(session, desktop)).toMatchObject({ text: "It says 42.", outcome: "done" });
  expect(received[1]?.[0]?.text).toContain("do it now with a tool");
  expect(received[2]?.[0]?.text).toContain("reply to your host");
  expect(received[2]?.[1]?.text).toContain("already ended");
  expect(desktop.actions).toHaveLength(0);
});

test("blind mode refuses the mouse, and foreground guards reach tool errors", async () => {
  const desktop = new FakeDesktop();
  const blind = scripted(step(act({ action: "screenshot" })), step());
  await run(blind.session, desktop, { vision: false });
  expect(blind.received[1]?.[0]).toMatchObject({ isError: true, text: expect.stringContaining("cannot see") });
  desktop.focused = { exe: "cmd.exe", className: "ConsoleWindowClass", title: "Command Prompt" };
  const guarded = scripted(step(act({ action: "type", text: "echo unsafe" })), step());
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

test("watcher errors stop before input", async () => {
  const desktop = new FakeDesktop();
  let closed = false;
  desktop.watchInput = () => ({ changed() { throw new Error("Raw input failed"); }, close() { closed = true; } });
  await expect(run(scripted(step(act({ action: "type", text: "Unsafe after watcher failure" }))).session, desktop)).rejects.toThrow("Player input watcher failed: Raw input failed");
  expect(closed).toBe(true);
  expect(desktop.actions).toHaveLength(0);
});

test("blind keyboard batches wait for launch focus and name the active window in results", async () => {
  const desktop = new FakeDesktop();
  let id = 1;
  desktop.focused = { exe: "game.exe", className: "Game", title: "Game" };
  desktop.execute = async (action, signal) => {
    if (action.type === "openApp") {
      setTimeout(() => { id = 2; desktop.focused = { exe: "notepad.exe", className: "Notepad", title: "Untitled - Notepad" }; }, 10);
      await waitForLaunchFocus(1, () => ({ id, ...desktop.focused }), signal, { timeoutMs: 100, pollMs: 1 });
    }
    if (action.type === "type") expect(desktop.focused.exe).toBe("notepad.exe");
    desktop.actions.push(action);
  };
  const { session, received } = scripted(step(call("open_app", { name: "Notepad" }), act({ action: "type", text: "Hola\n" })), step());
  await run(session, desktop, { vision: false });
  expect(desktop.actions.map((action) => action.type)).toEqual(["openApp", "type"]);
  expect(received[1]?.[1]?.text).toContain('Active window: "Untitled - Notepad" (notepad.exe)');
  expect(received[1]?.[1]?.image).toBeUndefined();
});

test("a launch that cannot get focus skips dependent typing", async () => {
  const desktop = new FakeDesktop();
  desktop.execute = async (_action, signal) => { await waitForLaunchFocus(1, () => ({ id: 1, ...desktop.focused }), signal, { timeoutMs: 5, pollMs: 1 }); };
  const { session, received } = scripted(step(call("open_url", { url: "https://example.com" }), act({ action: "type", text: "Wrong app\n" })), step());
  await run(session, desktop, { vision: false });
  expect(received[1]?.[0]).toMatchObject({ isError: true, text: expect.stringContaining("focus did not move") });
  expect(received[1]?.[1]).toMatchObject({ isError: true, text: expect.stringContaining("Not executed") });
  expect(desktop.actions).toHaveLength(0);
});

test("superseding a turn during focus handoff prevents its first action", async () => {
  const desktop = new FakeDesktop();
  let current = true;
  expect(await run(scripted(step(act({ action: "type", text: "Old task" }))).session, desktop, { canAct: () => current, yieldFocus: () => { current = false; } })).toMatchObject({ outcome: "superseded" });
  expect(desktop.actions).toHaveLength(0);
});

/** A browser that records what it's asked and shows a page that changes after anything but a look. */
function fakeBrowser(options: { image?: boolean } = {}) {
  const done: Array<BrowserAction | { op: "open"; url: string }> = [];
  let version = 0, stop = () => {}, released = 0;
  const browser: BrowserTurn = {
    async open(url) { done.push({ op: "open", url }); version++; return "Opened in a new tab."; },
    async run(action) {
      done.push(action);
      if (action.op !== "look" && action.op !== "read") version++;
      return "Clicked.";
    },
    async observe(): Promise<Observation> {
      const page = `Page v${version}\n[1] button "Search"`;
      return { page, same: null, ...(options.image ? { image: bgraToPng(new Uint8Array(4), 1, 1) } : {}) };
    },
    release() { released++; },
    onStop(listener) { stop = listener; return () => { stop = () => {}; }; },
  };
  return { browser, done, stop: () => stop(), released: () => released };
}
const browse = (input: Record<string, unknown>) => call("browser", input);

test("a model that can't see browses by element numbers, without the popup moving or the input watch", async () => {
  const desktop = new FakeDesktop();
  const { browser, done, released } = fakeBrowser();
  let focuses = 0;
  const { session, received } = scripted(step(call("open_url", { url: "youtube.com" })), step(browse({ action: "type", ref: 1, text: "cats", submit: true }), browse({ action: "click", ref: 1 })), step());
  expect(await run(session, desktop, { vision: false, browser, yieldFocus: () => focuses++ })).toMatchObject({ outcome: "done" });
  expect(done).toEqual([{ op: "open", url: "https://youtube.com" }, { op: "type", ref: 1, text: "cats", submit: true }, { op: "click", ref: 1 }]);
  expect(focuses).toBe(0);
  expect(desktop.actions).toHaveLength(0);
  const page = received[1]![0]!;
  expect(page).toMatchObject({ text: "Opened in a new tab.", page: expect.stringContaining('[1] button "Search"'), caption: expect.stringContaining("This is the browser page now.") });
  expect(page.image).toBeUndefined();
  expect(received[2]![1]!.page).toContain("Page v3");
  expect(released()).toBe(1);
});

test("after a page picture, screen coordinates are refused as guesses", async () => {
  const desktop = new FakeDesktop();
  const { browser } = fakeBrowser({ image: true });
  const { session, received } = scripted(step(browse({ action: "read" })), step(act({ action: "left_click", coordinate: [500, 500] })), step());
  await run(session, desktop, { browser });
  expect(received[1]![0]!.image).toBeDefined();
  expect(received[2]![0]).toMatchObject({ isError: true, text: expect.stringContaining("shows only the browser page") });
  expect(desktop.actions).toHaveLength(0);
});

test("cancelling the browser's debugging bar stops the turn", async () => {
  const fake = fakeBrowser();
  const session: AgentSession = { async next(_results, http) {
    setTimeout(fake.stop, 10);
    await new Promise<void>((_resolve, reject) => http.signal!.addEventListener("abort", () => reject(http.signal!.reason), { once: true }));
    return step();
  } };
  expect(await run(session, new FakeDesktop(), { browser: fake.browser })).toMatchObject({ outcome: "stopped" });
  expect(fake.released()).toBe(1);
});

test("a page that didn't change is said so, and the third identical try ends the task", async () => {
  const { browser } = fakeBrowser();
  let observed = 0;
  browser.observe = async () => ({ page: "Same page", same: observed++ > 0 });
  const click = () => browse({ action: "click", ref: 1 });
  const { session, received } = scripted(step(click()), step(click()), step(click()), step(click()), step(click()));
  expect(await run(session, new FakeDesktop(), { browser })).toMatchObject({ outcome: "done" });
  expect(received[2]![0]!.text).toContain("The page did not change.");
  expect(received[3]![0]).toMatchObject({ isError: true, text: expect.stringContaining("the page did not change") });
});

test("waiting while browsing shows the page again and leaves the desktop to the player", async () => {
  const desktop = new FakeDesktop();
  const { browser } = fakeBrowser();
  let focuses = 0;
  const { session, received } = scripted(step(call("open_url", { url: "example.com" })), step(call("browser_wait", { time: 1 })), step());
  await run(session, desktop, { vision: false, browser, yieldFocus: () => focuses++ });
  expect(received[2]![0]!.page).toContain("Page v1");
  expect(focuses).toBe(0);
});
