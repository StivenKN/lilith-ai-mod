import { describe, expect, test } from "bun:test";
import { inflateSync } from "node:zlib";
import { computerTools, parseCall, physicalPoint, screenshotPoint, screenshotSize, toolSchema } from "./actions.ts";
import { matchApp, parseApps } from "./apps.ts";
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
  const waiting = waitForLaunchFocus(1, () => ({ id: 2, exe: "", className: "Notepad" }), controller.signal, 1000);
  controller.abort();
  await expect(waiting).rejects.toThrow();
  await expect(waitForLaunchFocus(1, () => ({ id: 2, exe: "", className: "Notepad" }), new AbortController().signal, 2, 1)).rejects.toThrow("focus did not move");
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

describe("computer actions", () => {
  test("parses native member names and repeats without changing coordinates after zoom", () => {
    expect(parseCall({ id: "a", toolset: "computer", name: "left_click_drag", input: { start_coordinate: [2, 3], coordinate: [20, 30], text: "shift" } })).toEqual({ type: "drag", from: { x: 2, y: 3 }, to: { x: 20, y: 30 }, modifiers: "shift" });
    expect(parseCall({ id: "a", toolset: "computer", name: "key", input: { text: "Tab", repeat: 4 } })).toEqual({ type: "key", combo: "Tab", repeat: 4 });
    expect(parseCall({ id: "a", toolset: "computer", name: "zoom", input: { region: [10, 10, 5, 20] } })).toHaveProperty("error");
    expect(parseCall({ id: "a", toolset: "browser", name: "type", input: { text: "x" } })).toHaveProperty("error");
    expect(parseCall({ id: "a", name: "click", input: { x: -1, y: 0 } })).toHaveProperty("error");
  });
  test("bounds-checks and scales screenshots, with portable blind schemas", () => {
    expect(screenshotSize({ width: 1920, height: 1080 })).toEqual({ width: 1280, height: 720 });
    expect(physicalPoint({ x: 640, y: 360 }, { width: 1920, height: 1080 })).toEqual({ x: 960, y: 540 });
    expect(() => physicalPoint({ x: 1280, y: 0 }, { width: 1920, height: 1080 })).toThrow("outside");
    expect(screenshotPoint({ x: 3839, y: 2159 }, { width: 3840, height: 2160 })).toEqual({ x: 1279, y: 719 });
    expect(screenshotPoint({ x: -1, y: 0 }, { width: 3840, height: 2160 }).x).toBe(-1);
    const tools = computerTools(false);
    expect(tools.map((tool) => tool.name)).toEqual(["type_text", "press_key", "open_app", "open_url"]);
    expect(toolSchema(tools[0]!)).not.toHaveProperty("$schema");
  });
});

test("Start app matching supports accents and refuses ambiguous names", () => {
  const apps = parseApps('[{"Name":"Bloc de notas","AppID":"notepad.exe"},{"Name":"Calculadora","AppID":"calc"},{"Name":"Cámara","AppID":"cam"}]');
  expect(matchApp(apps, "CAMARA").AppID).toBe("cam");
  expect(matchApp(apps, "notas").AppID).toBe("notepad.exe");
  expect(() => matchApp(apps, "ca")).toThrow("ambiguous");
  expect(() => matchApp(apps, "missing")).toThrow("Calculadora");
  expect(parseApps('{"Name":"One","AppID":"one"}')).toHaveLength(1);
});

test("guards block terminal input and Win key aliases, but allow ordinary keyboard use", () => {
  const focused = { exe: "notepad.exe", className: "Notepad" };
  for (const combo of ["windows+r", "win+x", "super+s", "super_r+q"]) expect(() => guardAction({ type: "key", combo, repeat: 1 }, focused)).toThrow("disabled");
  expect(() => guardAction({ type: "key", combo: "win+d", repeat: 1 }, focused)).not.toThrow();
  for (const combo of ["win", "super_r", "ctrl+Escape", "control_r+Esc"]) expect(() => guardAction({ type: "key", combo, repeat: 1 }, focused)).toThrow("Opening Start");
  expect(() => guardAction({ type: "type", text: "x" }, { exe: "pwsh.exe", className: "ConsoleWindowClass" })).toThrow("disabled");
  expect(() => guardAction({ type: "type", text: "x" }, { exe: "Lilith.exe", className: "LilithAICompanionChat" })).toThrow("disabled");
  expect(() => guardAction({ type: "openApp", name: "Windows PowerShell" }, focused)).toThrow("disabled");
  for (const name of ["Run", "Ejecutar", "Task Manager", "Administrador de tareas"]) expect(blockedApp(name)).toBe(true);
  expect(blockedApp("Localized Run", "Microsoft.Windows.Shell.RunDialog")).toBe(true);
  for (const window of [
    { exe: "explorer.exe", className: "#32770" }, { exe: "taskmgr.exe", className: "TaskManagerWindow" },
    { exe: "SearchHost.exe", className: "XamlExplorerHostIslandWindow" },
    { exe: "PowerToys.PowerLauncher.exe", className: "HwndWrapper" }, { exe: "Microsoft.CmdPal.UI.exe", className: "WinUIDesktopWin32WindowClass" },
  ]) expect(() => guardAction({ type: "type", text: "unsafe" }, window)).toThrow("disabled");
  expect(() => guardAction({ type: "type", text: "Hola" }, focused)).not.toThrow();
  expect(() => checkedUrl("file:///C:/test")).toThrow("http");
  expect(() => checkedUrl("https://user:password@example.com/")).toThrow("credentials");
});
