// Win32 x64 bindings. Loaded lazily so unsupported hosts can still run ordinary chat.
import { dlopen, type Pointer } from "bun:ffi";
import { checkedUrl, openPath } from "../open.ts";
import { physicalPoint, screenshotPoint, screenshotSize, type Action, type Point, type Region } from "./actions.ts";
import { browserWindow, describeWindows, matchWindow, openApp, windowOf, type ListedWindow } from "./apps.ts";
import type { Desktop, InputWatch } from "./desktop.ts";
import { encodeInputs, INPUT_SIZE, sendCheckedInputs, typeEvents, type InputEvent } from "./input.ts";
import { parseKeys, parseModifiers, type VirtualKey } from "./keys.ts";
import { guardAction, ownWindow, terminalWindow } from "./guards.ts";
import { bgraToPng } from "../png.ts";
import { playerRawInput, rawInputDevices } from "./raw-input.ts";
import { waitForLaunchFocus, type FocusedWindow } from "./focus.ts";

/** A top-level window as Win32 hands it to us. Bun returns pointers as numbers or, if large, bigints. */
type NativeWindow = FocusedWindow & { id: Pointer | bigint };

export function createWindowsDesktop(): Desktop {
  const user = dlopen("user32.dll", {
    SetProcessDpiAwarenessContext: { args: ["i64"], returns: "i32" },
    SetThreadDpiAwarenessContext: { args: ["i64"], returns: "i64" },
    GetThreadDpiAwarenessContext: { args: [], returns: "i64" },
    GetAwarenessFromDpiAwarenessContext: { args: ["i64"], returns: "i32" },
    GetSystemMetrics: { args: ["i32"], returns: "i32" },
    GetDC: { args: ["ptr"], returns: "ptr" },
    ReleaseDC: { args: ["ptr", "ptr"], returns: "i32" },
    SendInput: { args: ["u32", "ptr", "i32"], returns: "u32" },
    MapVirtualKeyW: { args: ["u32", "u32"], returns: "u32" },
    VkKeyScanExW: { args: ["u16", "ptr"], returns: "i16" },
    GetKeyboardLayout: { args: ["u32"], returns: "ptr" },
    GetCursorPos: { args: ["ptr"], returns: "i32" },
    GetForegroundWindow: { args: [], returns: "ptr" },
    GetWindowThreadProcessId: { args: ["ptr", "ptr"], returns: "u32" },
    GetClassNameW: { args: ["ptr", "ptr", "i32"], returns: "i32" },
    GetWindowTextW: { args: ["ptr", "ptr", "i32"], returns: "i32" },
    FindWindowExW: { args: ["ptr", "ptr", "ptr", "ptr"], returns: "ptr" },
    GetWindow: { args: ["ptr", "u32"], returns: "ptr" },
    GetWindowLongPtrW: { args: ["ptr", "i32"], returns: "i64" },
    IsWindowVisible: { args: ["ptr"], returns: "i32" },
    IsIconic: { args: ["ptr"], returns: "i32" },
    ShowWindow: { args: ["ptr", "i32"], returns: "i32" },
    SetForegroundWindow: { args: ["ptr"], returns: "i32" },
    PostMessageW: { args: ["ptr", "u32", "u64", "i64"], returns: "i32" },
    CreateWindowExW: { args: ["u32", "ptr", "ptr", "u32", "i32", "i32", "i32", "i32", "i64", "ptr", "ptr", "ptr"], returns: "ptr" },
    DestroyWindow: { args: ["ptr"], returns: "i32" },
    RegisterRawInputDevices: { args: ["ptr", "u32", "u32"], returns: "i32" },
    GetRawInputData: { args: ["u64", "u32", "ptr", "ptr", "u32"], returns: "u32" },
    PeekMessageW: { args: ["ptr", "ptr", "u32", "u32", "u32"], returns: "i32" },
    TranslateMessage: { args: ["ptr"], returns: "i32" },
    DispatchMessageW: { args: ["ptr"], returns: "i64" },
  });
  let gdi: ReturnType<typeof loadGdi>;
  let kernel: ReturnType<typeof loadKernel>;
  try { gdi = loadGdi(); } catch (error) { user.close(); throw error; }
  try { kernel = loadKernel(); } catch (error) { gdi.close(); user.close(); throw error; }
  // Without DWM (unlikely on Windows 10+), cloaked windows such as suspended Store apps get listed too.
  let dwm: ReturnType<typeof loadDwm> | undefined;
  try { dwm = loadDwm(); } catch { dwm = undefined; }
  const u = user.symbols;
  const g = gdi.symbols;
  const k = kernel.symbols;
  const rawMarker = (0x4c490000 | (process.pid & 0xffff)) >>> 0;
  const inputMarker = 0x4c494c4900000000n | BigInt(rawMarker);
  let activeWatch: InputWatch | undefined;
  u.SetProcessDpiAwarenessContext(-4n);
  const previousDpi = u.SetThreadDpiAwarenessContext(-4n);
  if (u.GetAwarenessFromDpiAwarenessContext(u.GetThreadDpiAwarenessContext()) !== 2) {
    user.close(); gdi.close(); kernel.close(); dwm?.close();
    throw new Error("Could not enable physical-pixel desktop coordinates");
  }
  const screen = () => ({ width: u.GetSystemMetrics(0), height: u.GetSystemMetrics(1) });
  if (screen().width <= 0 || screen().height <= 0) {
    if (previousDpi) u.SetThreadDpiAwarenessContext(previousDpi);
    user.close(); gdi.close(); kernel.close(); dwm?.close();
    throw new Error("No primary display is available");
  }

  function send(events: readonly InputEvent[]): void {
    sendCheckedInputs(events, (batch) => u.SendInput(batch.length, encodeInputs(batch, inputMarker, u.GetSystemMetrics(23) !== 0), INPUT_SIZE));
  }
  const keyEvent = (key: VirtualKey, down: boolean): InputEvent => ({ type: "key", vk: key.vk, scan: u.MapVirtualKeyW(key.vk, 0), extended: key.extended, down });
  const tap = (vk: number): InputEvent[] => [keyEvent({ vk, extended: false }, true), keyEvent({ vk, extended: false }, false)];
  function move(at: Point): void {
    const p = physicalPoint(at, screen());
    const left = u.GetSystemMetrics(76), top = u.GetSystemMetrics(77);
    const width = u.GetSystemMetrics(78), height = u.GetSystemMetrics(79);
    send([{ type: "move", nx: Math.round((p.x - left) * 65535 / Math.max(1, width - 1)), ny: Math.round((p.y - top) * 65535 / Math.max(1, height - 1)) }]);
  }
  function capture(region?: Region): Uint8Array {
    const size = screen();
    const full = screenshotSize(size);
    const src = region ? {
      x: Math.floor(region.x * size.width / full.width), y: Math.floor(region.y * size.height / full.height),
      width: Math.ceil(region.width * size.width / full.width), height: Math.ceil(region.height * size.height / full.height),
    } : { x: 0, y: 0, ...size };
    if (src.x < 0 || src.y < 0 || src.width <= 0 || src.height <= 0 || src.x + src.width > size.width || src.y + src.height > size.height) throw new Error("Capture region is outside the primary screen");
    const target = screenshotSize(src);
    const dc = u.GetDC(null);
    if (!dc) throw new Error("Could not get the screen DC");
    let mem: ReturnType<typeof g.CreateCompatibleDC> = null;
    let bitmap: ReturnType<typeof g.CreateCompatibleBitmap> = null;
    let old: ReturnType<typeof g.SelectObject> = null;
    try {
      mem = g.CreateCompatibleDC(dc);
      bitmap = g.CreateCompatibleBitmap(dc, target.width, target.height);
      if (!mem || !bitmap) throw new Error("Could not allocate capture bitmap");
      old = g.SelectObject(mem, bitmap);
      if (!old) throw new Error("Could not select capture bitmap");
      g.SetStretchBltMode(mem, 4); // HALFTONE
      g.SetBrushOrgEx(mem, 0, 0, null);
      if (!g.StretchBlt(mem, 0, 0, target.width, target.height, dc, src.x, src.y, src.width, src.height, 0x40cc0020)) throw new Error("Screen capture failed");
      g.SelectObject(mem, old);
      old = null;
      const header = new Uint8Array(44);
      const view = new DataView(header.buffer);
      view.setUint32(0, 40, true);
      view.setInt32(4, target.width, true);
      view.setInt32(8, -target.height, true); // top-down
      view.setUint16(12, 1, true);
      view.setUint16(14, 32, true);
      const bgra = new Uint8Array(target.width * target.height * 4);
      if (g.GetDIBits(dc, bitmap, 0, target.height, bgra, header, 0) !== target.height) throw new Error("Could not read capture pixels");
      return bgraToPng(bgra, target.width, target.height);
    } finally {
      if (old && mem) g.SelectObject(mem, old);
      if (bitmap) g.DeleteObject(bitmap);
      if (mem) g.DeleteDC(mem);
      u.ReleaseDC(null, dc);
    }
  }

  function watchInput(): InputWatch {
    if (activeWatch) throw new Error("Player input is already being watched");
    let changed = false;
    // Queued Raw Input never blocks other apps or expires during capture/GC like low-level hooks.
    const className = Uint16Array.from("STATIC\0", (char) => char.charCodeAt(0));
    const hwnd = u.CreateWindowExW(0, className, null, 0, 0, 0, 0, 0, -3n, null, null, null); // HWND_MESSAGE
    if (!hwnd) throw new Error("Could not create the player input window");
    if (!u.RegisterRawInputDevices(rawInputDevices(BigInt(hwnd)), 2, 16)) {
      u.DestroyWindow(hwnd);
      throw new Error("Could not watch player input; computer control was stopped");
    }
    const message = new Uint8Array(48), msg = new DataView(message.buffer);
    const raw = new Uint8Array(48), size = new Uint32Array(1);
    let closed = false;
    const watch: InputWatch = {
      changed() {
        if (closed) return changed;
        while (!changed && u.PeekMessageW(message, hwnd, 0, 0, 1)) {
          try {
            if (msg.getUint32(8, true) === 0xff) { // WM_INPUT
              size[0] = raw.length;
              const count = u.GetRawInputData(msg.getBigUint64(24, true), 0x10000003, raw, size, 24);
              if (count === 0xffffffff) throw new Error("Could not read player input; computer control was stopped");
              if (playerRawInput(raw.subarray(0, count), rawMarker)) changed = true;
            }
          } finally { u.TranslateMessage(message); u.DispatchMessageW(message); }
        }
        return changed;
      },
      close() {
        if (closed) return;
        closed = true;
        u.RegisterRawInputDevices(rawInputDevices(null), 2, 16);
        u.DestroyWindow(hwnd);
        activeWatch = undefined;
      },
    };
    activeWatch = watch;
    return watch;
  }

  const pid = new Uint32Array(1), text = new Uint16Array(512), cloak = new Uint32Array(1);
  const processPath = new Uint16Array(32768), pathSize = new Uint32Array(1);
  const read = (length: number) => String.fromCharCode(...text.subarray(0, Math.max(0, length)));
  function describe(id: NativeWindow["id"]): NativeWindow {
    u.GetWindowThreadProcessId(id, pid);
    const className = read(u.GetClassNameW(id, text, text.length));
    const title = read(u.GetWindowTextW(id, text, text.length));
    const handle = k.OpenProcess(0x1000, 0, pid[0]!);
    if (!handle) return { id, exe: "", className, title };
    try {
      pathSize[0] = processPath.length;
      if (!k.QueryFullProcessImageNameW(handle, 0, processPath, pathSize)) return { id, exe: "", className, title };
      return { id, exe: String.fromCharCode(...processPath.subarray(0, pathSize[0])).split("\\").at(-1) ?? "", className, title };
    } finally { k.CloseHandle(handle); }
  }
  function cursor(): Point {
    const p = new Int32Array(2);
    if (!u.GetCursorPos(p)) throw new Error("Could not read cursor position");
    return screenshotPoint({ x: p[0]!, y: p[1]! }, screen());
  }
  function foreground(): FocusedWindow {
    const id = u.GetForegroundWindow();
    return id ? describe(id) : { id: null, exe: "", className: "", title: "" };
  }
  /**
   * The windows Alt+Tab shows, front to back, except Lilith's own and terminals or system tools,
   * which she may not open either. Never by title: a browser tab can mention PowerShell.
   */
  function windows(): Array<ListedWindow & NativeWindow> {
    const found: Array<ListedWindow & NativeWindow> = [];
    for (let id = u.FindWindowExW(null, null, null, null), n = 0; id && n < 4096; id = u.FindWindowExW(null, id, null, null), n++) {
      if (!u.IsWindowVisible(id)) continue;
      if (dwm && dwm.symbols.DwmGetWindowAttribute(id, 14, cloak, 4) === 0 && cloak[0]) continue; // DWMWA_CLOAKED
      const style = Number(u.GetWindowLongPtrW(id, -20)); // GWL_EXSTYLE
      // Tool windows and owned popups count only when marked WS_EX_APPWINDOW.
      if (!(style & 0x40000) && (style & 0x80 || u.GetWindow(id, 4))) continue;
      const window = describe(id);
      if (!window.title || ownWindow(window) || terminalWindow(window) || /^(Progman|WorkerW|Shell_TrayWnd)$/.test(window.className)) continue;
      found.push({ ...window, minimized: !!u.IsIconic(id) });
    }
    return found;
  }
  async function focus(window: NativeWindow, signal: AbortSignal): Promise<void> {
    if (u.IsIconic(window.id)) u.ShowWindow(window.id, 9); // SW_RESTORE
    send([{ type: "nudge" }]);
    u.SetForegroundWindow(window.id);
    for (let n = 0; n < 20 && u.GetForegroundWindow() !== window.id; n++) {
      await Bun.sleep(50);
      signal.throwIfAborted();
    }
    if (u.GetForegroundWindow() !== window.id) throw new Error(`Windows did not bring "${window.title}" to the front. Try clicking it in the taskbar.`);
  }
  async function manageWindow(action: Extract<Action, { type: "window" }>, signal: AbortSignal): Promise<string> {
    const open = windows();
    if (action.op === "list") return describeWindows(open, u.GetForegroundWindow());
    const active = u.GetForegroundWindow();
    // Without a title, only an app window counts: never the desktop or taskbar, where WM_CLOSE means shut down.
    const target = action.title === null ? open.find((window) => window.id === active) : matchWindow(open, action.title);
    if (!target) throw new Error("The active window is not an app window. Name the window to act on.");
    switch (action.op) {
      case "focus": await focus(target, signal); return `Switched to "${target.title}".`;
      case "maximize":
        if (target.id !== active) await focus(target, signal);
        u.ShowWindow(target.id, 3); // SW_MAXIMIZE
        return `Maximized "${target.title}".`;
      case "minimize": u.ShowWindow(target.id, 6); return `Minimized "${target.title}".`; // SW_MINIMIZE
      case "close":
        // What its X button does: the app may still ask to save first.
        if (!u.PostMessageW(target.id, 0x10, 0, 0)) throw new Error(`Could not close "${target.title}". It may be running as administrator.`); // WM_CLOSE
        return `Asked "${target.title}" to close.`;
    }
  }
  return {
    get screen() { return screen(); },
    capture,
    cursor,
    foreground,
    watchInput,
    async execute(action: Action, signal: AbortSignal) {
      signal.throwIfAborted();
      switch (action.type) {
        case "openApp": case "openUrl": {
          const before = foreground();
          let sameWindow: (focused: FocusedWindow) => boolean;
          if (action.type === "openApp") {
            const app = await openApp(action.name, signal);
            sameWindow = (focused) => windowOf(focused, app.Name);
          } else {
            openPath(checkedUrl(action.url));
            // A new tab retitles the browser already in front. Any other app's retitling proves nothing.
            sameWindow = (focused) => browserWindow(focused) && focused.title !== before.title;
          }
          await waitForLaunchFocus(before.id, foreground, signal, { sameWindow });
          return "Opened.";
        }
        case "window": return manageWindow(action, signal);
        case "type":
          // Small chunks give the takeover watcher time to run while typing long text.
          for (const char of action.text.replace(/\r\n?/g, "\n")) {
            signal.throwIfAborted();
            guardAction(action, foreground());
            send(typeEvents(char, tap));
            await Bun.sleep(1);
          }
          return;
        case "key":
          for (let n = 0; n < action.repeat; n++) for (const combo of parseKeys(action.combo)) {
            signal.throwIfAborted();
            guardAction(action, foreground());
            const held = [...combo.modifiers];
            let target: InputEvent[];
            if ("vk" in combo.key) target = [keyEvent(combo.key, true), keyEvent(combo.key, false)];
            else {
              const thread = u.GetWindowThreadProcessId(u.GetForegroundWindow(), null);
              const layout = u.GetKeyboardLayout(thread);
              const mapping = combo.key.char.length === 1 && layout ? u.VkKeyScanExW(combo.key.char.charCodeAt(0), layout) : -1;
              if (mapping === -1) {
                if (held.length) throw new Error("This character cannot be used in a keyboard shortcut");
                target = typeEvents(combo.key.char, tap);
              } else {
                for (const [bit, vk] of [[1, 0x10], [2, 0x11], [4, 0x12]] as const) if (mapping >> 8 & bit) held.push({ vk, extended: false });
                target = tap(mapping & 0xff);
              }
            }
            try { send([...held.map((key) => keyEvent(key, true)), ...target]); }
            finally { send(held.reverse().map((key) => keyEvent(key, false))); }
            await Bun.sleep(10);
          }
          return;
        case "move": move(action.at); return;
        case "click": case "scroll": case "drag": {
          const held = parseModifiers(action.modifiers);
          try {
            send(held.map((key) => keyEvent(key, true)));
            if (action.type === "click") {
              if (action.at) move(action.at);
              for (let n = 0; n < action.count; n++) send([{ type: "button", button: action.button, down: true }, { type: "button", button: action.button, down: false }]);
            } else if (action.type === "scroll") {
              if (action.at) move(action.at);
              send([{ type: "wheel", clicks: action.amount * (["up", "right"].includes(action.direction) ? 1 : -1), horizontal: ["left", "right"].includes(action.direction) }]);
            } else {
              // Validate both endpoints before pressing the mouse button.
              physicalPoint(action.to, screen());
              const from = action.from ?? cursor();
              move(from);
              try {
                send([{ type: "button", button: "left", down: true }]);
                for (let n = 1; n <= 12; n++) {
                  signal.throwIfAborted();
                  move({ x: Math.round(from.x + (action.to.x - from.x) * n / 12), y: Math.round(from.y + (action.to.y - from.y) * n / 12) });
                  await Bun.sleep(20);
                }
              } finally { send([{ type: "button", button: "left", down: false }]); }
            }
          } finally { send(held.reverse().map((key) => keyEvent(key, false))); }
          return;
        }
        case "screenshot": case "zoom": case "cursor": case "wait": case "finish": case "browser": return; // handled by the loop
      }
    },
    close() { activeWatch?.close(); if (previousDpi) u.SetThreadDpiAwarenessContext(previousDpi); user.close(); gdi.close(); kernel.close(); dwm?.close(); },
  };
}

function loadGdi() {
  return dlopen("gdi32.dll", {
    CreateCompatibleDC: { args: ["ptr"], returns: "ptr" },
    CreateCompatibleBitmap: { args: ["ptr", "i32", "i32"], returns: "ptr" },
    SelectObject: { args: ["ptr", "ptr"], returns: "ptr" },
    DeleteObject: { args: ["ptr"], returns: "i32" },
    DeleteDC: { args: ["ptr"], returns: "i32" },
    SetStretchBltMode: { args: ["ptr", "i32"], returns: "i32" },
    SetBrushOrgEx: { args: ["ptr", "i32", "i32", "ptr"], returns: "i32" },
    StretchBlt: { args: ["ptr", "i32", "i32", "i32", "i32", "ptr", "i32", "i32", "i32", "i32", "u32"], returns: "i32" },
    GetDIBits: { args: ["ptr", "ptr", "u32", "u32", "ptr", "ptr", "u32"], returns: "i32" },
  });
}
function loadDwm() {
  return dlopen("dwmapi.dll", {
    DwmGetWindowAttribute: { args: ["ptr", "u32", "ptr", "u32"], returns: "i32" },
  });
}
function loadKernel() {
  return dlopen("kernel32.dll", {
    OpenProcess: { args: ["u32", "i32", "u32"], returns: "ptr" },
    QueryFullProcessImageNameW: { args: ["ptr", "u32", "ptr", "ptr"], returns: "i32" },
    CloseHandle: { args: ["ptr"], returns: "i32" },
  });
}
