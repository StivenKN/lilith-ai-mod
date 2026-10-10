import type { Action, Point, Region, Size } from "./actions.ts";
import type { Foreground } from "./guards.ts";
import { bgraToPng } from "../png.ts";
import { screenshotSize } from "./actions.ts";

export interface InputWatch {
  /** Pumps native input notifications, excluding this process's injected events. */
  changed(): boolean;
  close(): void;
}

export interface Desktop {
  screen: Size;
  capture(region?: Region): Uint8Array;
  cursor(): Point;
  foreground(): Foreground;
  watchInput(): InputWatch;
  /** Performs an action; a returned string replaces "OK" as the model's result (a window list, say). */
  execute(action: Action, signal: AbortSignal): Promise<string | void>;
  close(): void;
}

export type DesktopStatus = { available: true; desktop: Desktop } | { available: false; reason: string };

/** No host input or app launches. Used only when explicitly enabled for development. */
export class FakeDesktop implements Desktop {
  screen = { width: 1280, height: 720 };
  actions: Action[] = [];
  inputVersion = 0;
  focused: Foreground = { exe: "notepad.exe", className: "Notepad", title: "Untitled - Notepad" };
  capture(region?: Region): Uint8Array {
    const size = screenshotSize(region ?? this.screen);
    const bgra = new Uint8Array(size.width * size.height * 4).fill(100);
    return bgraToPng(bgra, size.width, size.height);
  }
  cursor(): Point { return { x: 20, y: 20 }; }
  foreground(): Foreground { return this.focused; }
  watchInput(): InputWatch {
    const baseline = this.inputVersion;
    return { changed: () => this.inputVersion !== baseline, close() {} };
  }
  async execute(action: Action, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    this.actions.push(action);
  }
  close(): void {}
}

let status: Promise<DesktopStatus> | undefined;
export function getDesktop(): Promise<DesktopStatus> {
  status ??= (async () => {
    if (process.env.LILITH_AI_FAKE_DESKTOP === "1") return { available: true as const, desktop: new FakeDesktop() };
    if (process.platform !== "win32" || process.arch !== "x64") return { available: false as const, reason: "Computer control requires Windows x64" };
    try {
      const { createWindowsDesktop } = await import("./windows.ts");
      return { available: true as const, desktop: createWindowsDesktop() };
    } catch (error) {
      return { available: false as const, reason: `Windows desktop unavailable: ${error instanceof Error ? error.message : String(error)}` };
    }
  })();
  return status;
}
