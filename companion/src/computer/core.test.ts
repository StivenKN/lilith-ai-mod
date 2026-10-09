import { describe, expect, test } from "bun:test";
import { inflateSync } from "node:zlib";
import { computerTools, parseCall, physicalPoint, screenshotPoint, screenshotSize, toolCallsInText, toolSchema, type Action } from "./actions.ts";
import { describeWindows, matchApp, matchWindow, parseApps, windowOf } from "./apps.ts";
import { blockedApp, guardAction } from "./guards.ts";
import { encodeInputs, INPUT_SIZE, sendCheckedInputs, typeEvents, type InputEvent } from "./input.ts";
import { parseKeys } from "./keys.ts";
import { bgraToPng } from "./png.ts";
import { checkedUrl } from "../open.ts";
import { playerRawInput, rawInputDevices } from "./raw-input.ts";
import { waitForLaunchFocus } from "./focus.ts";

test("RGB PNG preserves pixels with zero GDI alpha, filter rows and chunk CRCs", () => {
  const png = bgraToPng(Uint8Array.of(30, 20, 10, 0, 60, 50, 40, 0), 1, 2);
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  expect(png[25]).toBe(2); // RGB, not RGBA
  let idat = new Uint8Array();
  for (let at = 8; at < png.length;) {
    const length = view.getUint32(at), body = png.subarray(at + 4, at + 8 + length);
    expect(view.getUint32(at + 8 + length)).toBe(Bun.hash.crc32(body));
    if (new TextDecoder().decode(body.subarray(0, 4)) === "IDAT") idat = new Uint8Array(body.subarray(4));
    at += length + 12;
  }
  expect([...inflateSync(idat)]).toEqual([2, 10, 20, 30, 2, 30, 30, 30]);
  expect(() => bgraToPng(new Uint8Array(0), 1, 1)).toThrow("dimensions");
});

test("keys and SendInput layout preserve extended flags, wheel sign and UTF-16 surrogate pairs", () => {
  const keys = parseKeys("ctrl+Page_Down alt+Tab F24");
  expect(keys[0]).toMatchObject({ modifiers: [{ vk: 0x11 }], key: { vk: 0x22, extended: true } });
  const events = typeEvents("ñ😀\r\n\t", (vk) => [{ type: "key", vk, scan: 0x1c, extended: false, down: true }, { type: "key", vk, scan: 0x1c, extended: false, down: false }]);
  expect(events.flatMap((event) => event.type === "unicode" && event.down ? [event.unit] : [])).toEqual([0xf1, 0xd83d, 0xde00]);
  const marker = 0x4c494c4900001234n;
  const encoded = encodeInputs([{ type: "key", vk: 0x22, scan: 0x51, extended: true, down: false }, { type: "move", nx: 65535, ny: 0 }, { type: "wheel", clicks: -2, horizontal: true }], marker);
  expect(encoded.length).toBe(INPUT_SIZE * 3);
  const view = new DataView(encoded.buffer);
  expect(view.getUint16(10, true)).toBe(0x51);
  expect(view.getUint32(12, true)).toBe(3);
  expect(view.getUint32(60, true)).toBe(0xc001);
  expect(view.getInt32(96, true)).toBe(-240);
  expect(view.getBigUint64(24, true)).toBe(marker);
  expect(view.getBigUint64(72, true)).toBe(marker);
});

test("short input writes release accepted keys and mouse buttons without replaying input", () => {
  const events: InputEvent[] = [
    { type: "key", vk: 0x11, scan: 0x1d, extended: false, down: true },
    { type: "unicode", unit: 0xf1, down: true }, { type: "unicode", unit: 0xf1, down: false },
    { type: "button", button: "left", down: true }, { type: "button", button: "left", down: false },
  ];
  for (const count of [1, 2, 4]) {
    const received: Array<readonly InputEvent[]> = [];
    expect(() => sendCheckedInputs(events, (batch) => { received.push(batch); return received.length === 1 ? count : batch.length; })).toThrow(`accepted ${count}/5`);
    expect(received).toHaveLength(2);
    expect(received[1]).toContainEqual({ type: "key", vk: 0x11, scan: 0x1d, extended: false, down: false });
    expect(received[1]?.some((event) => "down" in event && event.down)).toBe(false);
    if (count === 2) expect(received[1]).toContainEqual({ type: "unicode", unit: 0xf1, down: false });
    if (count === 4) expect(received[1]).toContainEqual({ type: "button", button: "left", down: false });
  }
  let writes = 0;
  sendCheckedInputs(events, (batch) => { writes++; return batch.length; });
  expect(writes).toBe(1);
});

test("logical mouse buttons honor swapped primary buttons for clicks, drags and cleanup", () => {
  const events: InputEvent[] = [
    { type: "button", button: "left", down: true }, { type: "button", button: "left", down: false },
    { type: "button", button: "right", down: true }, { type: "button", button: "right", down: false },
    { type: "button", button: "middle", down: true }, { type: "button", button: "middle", down: false },
  ];
  for (const [swapped, flags] of [[false, [2, 4, 8, 16, 32, 64]], [true, [8, 16, 2, 4, 32, 64]]] as const) {
    const packed = new DataView(encodeInputs(events, 0n, swapped).buffer);
    expect(events.map((_, n) => packed.getUint32(n * INPUT_SIZE + 20, true))).toEqual([...flags]);
  }
});

test("launch focus waits are abortable and refuse unidentified windows", async () => {
  const controller = new AbortController();
  const unidentified = () => ({ id: 2, exe: "", className: "Notepad", title: "Notepad" });
  const waiting = waitForLaunchFocus(1, unidentified, controller.signal, { timeoutMs: 1000 });
  controller.abort();
  await expect(waiting).rejects.toThrow();
  await expect(waitForLaunchFocus(1, unidentified, new AbortController().signal, { timeoutMs: 2, pollMs: 1 })).rejects.toThrow("focus did not move");
});

test("a launch whose target was already in front counts only after a moment, and only if it's that app", async () => {
  const browser = { id: 1, exe: "chrome.exe", className: "Chrome_WidgetWin_1", title: "Inbox - Google Chrome" };
  const signal = new AbortController().signal;
  const started = performance.now();
  expect(await waitForLaunchFocus(1, () => browser, signal, { timeoutMs: 100, pollMs: 1, sameWindow: (window) => windowOf(window, "Google Chrome") })).toBe(browser);
  expect(performance.now() - started).toBeGreaterThanOrEqual(45);
  await expect(waitForLaunchFocus(1, () => browser, signal, { timeoutMs: 20, pollMs: 1, sameWindow: (window) => windowOf(window, "Spotify") })).rejects.toThrow("focus did not move");
});

test("raw input registration and packet decoding use x64 offsets and exclude our marker", () => {
  const devices = new DataView(rawInputDevices(123n).buffer);
  expect(devices.getUint16(2, true)).toBe(2);
  expect(devices.getUint16(18, true)).toBe(6);
  expect(devices.getUint32(4, true)).toBe(0x100);
  expect(devices.getBigUint64(24, true)).toBe(123n);
  const removed = new DataView(rawInputDevices(null).buffer);
  expect(removed.getUint32(20, true)).toBe(1);
  expect(removed.getBigUint64(8, true)).toBe(0n);
  for (const [type, size, offset] of [[0, 48, 44], [1, 40, 36]] as const) {
    const bytes = new Uint8Array(size), view = new DataView(bytes.buffer);
    view.setUint32(0, type, true);
    expect(playerRawInput(bytes, 123)).toBe(true);
    view.setUint32(offset, 123, true);
    expect(playerRawInput(bytes, 123)).toBe(false);
  }
  expect(() => playerRawInput(new Uint8Array(24), 123)).toThrow("packet");
});

const screen = { width: 1920, height: 1080 };

describe("computer actions", () => {
  test("parses native member names and repeats without changing coordinates after zoom", () => {
    expect(parseCall({ id: "a", toolset: "computer", name: "left_click_drag", input: { start_coordinate: [2, 3], coordinate: [20, 30], text: "shift" } }, screen)).toEqual({ type: "drag", from: { x: 2, y: 3 }, to: { x: 20, y: 30 }, modifiers: "shift" });
    expect(parseCall({ id: "a", toolset: "computer", name: "key", input: { text: "Tab", repeat: 4 } }, screen)).toEqual({ type: "key", combo: "Tab", repeat: 4 });
    expect(parseCall({ id: "a", toolset: "computer", name: "zoom", input: { region: [10, 10, 5, 20] } }, screen)).toHaveProperty("error");
    expect(parseCall({ id: "a", toolset: "browser", name: "type", input: { text: "x" } }, screen)).toHaveProperty("error");
  });
  test("bounds-checks and scales screenshots, with portable blind schemas", () => {
    expect(screenshotSize({ width: 1920, height: 1080 })).toEqual({ width: 1280, height: 720 });
    expect(physicalPoint({ x: 640, y: 360 }, { width: 1920, height: 1080 })).toEqual({ x: 960, y: 540 });
    expect(() => physicalPoint({ x: 1280, y: 0 }, { width: 1920, height: 1080 })).toThrow("outside");
    expect(screenshotPoint({ x: 3839, y: 2159 }, { width: 3840, height: 2160 })).toEqual({ x: 1279, y: 719 });
    expect(screenshotPoint({ x: -1, y: 0 }, { width: 3840, height: 2160 }).x).toBe(-1);
    const tools = computerTools(false);
    expect(tools.map((tool) => tool.name)).toEqual(["computer_use", "open_app", "open_url", "window"]);
    const blind = toolSchema(tools[0]!);
    expect(blind).not.toHaveProperty("$schema");
    expect(blind).not.toHaveProperty("properties.coordinate");
    expect(blind).toHaveProperty("properties.action.enum", ["key", "type", "wait", "terminate", "answer"]);
    expect(computerTools(true)[0]?.description).toContain("The screen's resolution is 1000x1000.");
  });

  const use = (input: Record<string, unknown>, name = "computer_use") => parseCall({ id: "a", name, input }, screen);
  test("computer_use points on Qwen's 1000 grid land on screenshot pixels, however the model writes them", () => {
    expect(use({ action: "left_click", coordinate: [500, 500] })).toMatchObject({ type: "click", at: { x: 640, y: 360 }, count: 1 });
    expect(use({ action: "double_click", coordinate: [1000, 1000] })).toMatchObject({ at: { x: 1279, y: 719 }, count: 2 });
    for (const coordinate of ["(250, 500)", { x: "250", y: 500 }, ["250", "500"]]) expect(use({ action: "click", coordinate })).toMatchObject({ at: { x: 320, y: 360 } });
    expect(use({ action: "left_click", x: 250, y: 500 })).toMatchObject({ at: { x: 320, y: 360 } });
    expect(use({ coordinate: [250, 500] }, "left_click")).toMatchObject({ type: "click", at: { x: 320, y: 360 } });
    expect(use({ action: "left_click", coordinate: [1001, 5] })).toEqual({ error: expect.stringContaining("from 0 to 1000") });
    expect(use({ action: "mouse_move" })).toEqual({ error: expect.stringContaining("needs coordinate") });
    expect(use({ action: "left_click_drag", coordinate: [500, 500] })).toMatchObject({ type: "drag", from: null, to: { x: 640, y: 360 } });
  });
  test("computer_use keys, scrolls, waits and endings follow Qwen's conventions", () => {
    expect(use({ action: "key", keys: ["ctrl", "c"] })).toEqual({ type: "key", combo: "ctrl+c", repeat: 1 });
    expect(use({ action: "press", keys: "enter" })).toEqual({ type: "key", combo: "enter", repeat: 1 });
    expect(use({ action: "key", keys: [] })).toEqual({ error: expect.stringContaining("needs keys") });
    expect(use({ action: "scroll", pixels: -5 })).toMatchObject({ type: "scroll", at: null, direction: "down", amount: 5 });
    expect(use({ action: "scroll", pixels: 300, coordinate: [500, 500] })).toMatchObject({ direction: "up", amount: 3, at: { x: 640, y: 360 } });
    expect(use({ action: "hscroll", pixels: -2 })).toMatchObject({ direction: "left", amount: 2 });
    expect(use({ action: "wait", time: 500 })).toEqual({ type: "wait", seconds: 60 });
    expect(use({ action: "terminate", status: "success" })).toEqual({ type: "finish", answer: "" });
    expect(use({ action: "dance" })).toEqual({ error: expect.stringContaining("Use one of: screenshot, key, type") });
    // Other tools, or the keys themselves, where the action goes.
    expect(use({ action: "open_app", name: "Spotify" })).toEqual({ type: "openApp", name: "Spotify" });
    expect(use({ action: "window", title: "Spotify" })).toEqual({ type: "window", op: "focus", title: "Spotify" });
    expect(use({ action: "ctrl+w" })).toEqual({ type: "key", combo: "ctrl+w", repeat: 1 });
    expect(use({ action: "open_url", arguments: { url: "https://www.youtube.com/results?search_query=lofi" } })).toEqual({ type: "openUrl", url: "https://www.youtube.com/results?search_query=lofi" });
    expect(use({ name: "x" }, "toString")).toHaveProperty("error");
  });
  test("window and URL tools accept the usual near misses", () => {
    expect(use({ action: "switch", name: "Spotify" }, "window")).toEqual({ type: "window", op: "focus", title: "Spotify" });
    expect(use({ action: "close" }, "window")).toEqual({ type: "window", op: "close", title: null });
    expect(use({ action: "focus" }, "window")).toEqual({ error: expect.stringContaining("needs the title") });
    expect(use({ title: "Spotify" }, "window")).toEqual({ type: "window", op: "focus", title: "Spotify" });
    expect(use({ coordinate: [1, 2] })).toEqual({ error: expect.stringContaining("needs an action, such as left_click") });
    expect(use({ app: "Notepad" }, "open_app")).toEqual({ error: "Invalid open_app input: ✖ Invalid input: expected string, received undefined\n  → at name" });
    expect(use({ url: "youtube.com/results?search_query=lofi" }, "open_url")).toEqual({ type: "openUrl", url: "https://youtube.com/results?search_query=lofi" });
  });
  test("calls a server left in the reply text are recovered; ordinary replies are left alone", () => {
    const tools = computerTools(true).map((tool) => tool.name);
    const tagged = '[happy] On it!\n<tool_call>\n{"name": "computer_use", "arguments": {"action": "left_click", "coordinate": [10, 20]}}\n</tool_call>';
    expect(toolCallsInText(tagged, tools)).toEqual({ calls: [{ name: "computer_use", input: { action: "left_click", coordinate: [10, 20] } }], text: "[happy] On it!" });
    expect(toolCallsInText('{"name": "open_app", "arguments": "{\\"name\\": \\"Notepad\\"}"}', tools).calls).toEqual([{ name: "open_app", input: { name: "Notepad" } }]);
    expect(toolCallsInText("<tool_call>{oops</tool_call>", tools).calls[0]).toHaveProperty("error");
    for (const reply of ['{"name": "Lilith", "arguments": 1}', "[happy] Hi!"]) expect(toolCallsInText(reply, tools)).toEqual({ calls: [], text: reply });
  });
});

test("Start app matching supports accents, extra words and .exe, and refuses ambiguous names", () => {
  const apps = parseApps('[{"Name":"Bloc de notas","AppID":"notepad.exe"},{"Name":"Calculadora","AppID":"calc"},{"Name":"Cámara","AppID":"cam"},{"Name":"Google Chrome","AppID":"chrome"},{"Name":"Spotify","AppID":"spotify"}]');
  expect(matchApp(apps, "CAMARA").AppID).toBe("cam");
  expect(matchApp(apps, "notas").AppID).toBe("notepad.exe");
  expect(matchApp(apps, "spotify.exe").AppID).toBe("spotify");
  expect(matchApp(apps, "the Google Chrome browser").AppID).toBe("chrome");
  const spanish = parseApps('[{"Name":"Explorador de archivos","AppID":"Microsoft.Windows.Explorer"},{"Name":"Bloc de notas","AppID":"Microsoft.WindowsNotepad_8wekyb3d8bbwe!App"}]');
  expect(matchApp(spanish, "File Explorer").Name).toBe("Explorador de archivos");
  expect(matchApp(spanish, "Notepad").Name).toBe("Bloc de notas");
  expect(() => matchApp(spanish, "YouTube")).toThrow("open it with open_url");
  expect(() => matchApp(apps, "ca")).toThrow("ambiguous");
  expect(() => matchApp(apps, "missing")).toThrow("Calculadora");
  expect(parseApps('{"Name":"One","AppID":"one"}')).toHaveLength(1);
});

test("windows match by title or app, frontmost first, and list front to back", () => {
  const window = (id: number, title: string, exe: string, minimized = false) => ({ id, title, exe, className: "W", minimized });
  const open = [window(1, "lofi beats - YouTube - Google Chrome", "chrome.exe"), window(2, "Spotify Premium", "Spotify.exe", true), window(3, "Inbox - Google Chrome", "chrome.exe")];
  expect(matchWindow(open, "chrome").id).toBe(1);
  expect(matchWindow(open, "inbox").id).toBe(3);
  expect(matchWindow(open, "spotify.exe").id).toBe(2);
  expect(() => matchWindow(open, "Word")).toThrow('Open windows: "lofi beats');
  expect(describeWindows(open, 1)).toBe('Open windows, front to back:\n1. "lofi beats - YouTube - Google Chrome" (chrome.exe) [active]\n2. "Spotify Premium" (Spotify.exe) [minimized]\n3. "Inbox - Google Chrome" (chrome.exe)');
  expect(windowOf({ exe: "notepad.exe", className: "Notepad", title: "Sin título: Bloc de notas" }, "Bloc de notas")).toBe(true);
  expect(windowOf({ exe: "Spotify.exe", className: "Chrome_WidgetWin_0", title: "Spotify Premium" }, "Spotify")).toBe(true);
  // A browser tab about Notepad is not Notepad: typing meant for it must not go there.
  expect(windowOf({ exe: "chrome.exe", className: "Chrome_WidgetWin_1", title: "Notepad tips - Google Chrome" }, "Notepad")).toBe(false);
});

test("guards block terminal input and Win key aliases, but allow ordinary keyboard use", () => {
  const focused = { exe: "notepad.exe", className: "Notepad", title: "Notepad" };
  for (const combo of ["windows+r", "win+x", "super+s", "super_r+q", "winleft+r"]) expect(() => guardAction({ type: "key", combo, repeat: 1 }, focused)).toThrow("disabled");
  expect(() => guardAction({ type: "key", combo: "win+d", repeat: 1 }, focused)).not.toThrow();
  for (const combo of ["win", "super_r", "winright", "ctrl+Escape", "control_r+Esc"]) expect(() => guardAction({ type: "key", combo, repeat: 1 }, focused)).toThrow("Opening Start");
  expect(parseKeys("pgdn volumeup arrowleft")).toMatchObject([{ key: { vk: 0x22 } }, { key: { vk: 0xaf } }, { key: { vk: 0x25 } }]);
  expect(() => parseKeys("constructor")).toThrow("Unknown key");
  const game = { exe: "Lilith.exe", className: "UnityWndClass", title: "Lilith" };
  const close: Action = { type: "window", op: "close", title: null };
  expect(() => guardAction(close, game)).toThrow("Lilith's own");
  expect(() => guardAction(close, focused)).not.toThrow();
  expect(() => guardAction({ type: "type", text: "x" }, { exe: "pwsh.exe", className: "ConsoleWindowClass", title: "PowerShell" })).toThrow("disabled");
  expect(() => guardAction({ type: "type", text: "x" }, { exe: "Lilith.exe", className: "LilithAICompanionChat", title: "" })).toThrow("disabled");
  // The game itself (alt+F4 would end the companion), and consoles that Windows reports under their client.
  expect(() => guardAction({ type: "key", combo: "alt+F4", repeat: 1 }, game)).toThrow("disabled");
  expect(() => guardAction({ type: "type", text: "x" }, { exe: "python.exe", className: "ConsoleWindowClass", title: "python" })).toThrow("disabled");
  expect(() => guardAction({ type: "openApp", name: "Windows PowerShell" }, focused)).toThrow("disabled");
  for (const name of ["Run", "Ejecutar", "Task Manager", "Administrador de tareas"]) expect(blockedApp(name)).toBe(true);
  expect(blockedApp("Localized Run", "Microsoft.Windows.Shell.RunDialog")).toBe(true);
  for (const window of [
    { exe: "explorer.exe", className: "#32770" }, { exe: "taskmgr.exe", className: "TaskManagerWindow" },
    { exe: "SearchHost.exe", className: "XamlExplorerHostIslandWindow" },
    { exe: "PowerToys.PowerLauncher.exe", className: "HwndWrapper" }, { exe: "Microsoft.CmdPal.UI.exe", className: "WinUIDesktopWin32WindowClass" },
  ]) expect(() => guardAction({ type: "type", text: "unsafe" }, { ...window, title: "" })).toThrow("disabled");
  expect(() => guardAction({ type: "type", text: "Hola" }, focused)).not.toThrow();
  expect(() => checkedUrl("file:///C:/test")).toThrow("http");
  expect(() => checkedUrl("https://user:password@example.com/")).toThrow("credentials");
});
