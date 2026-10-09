import { setTimeout } from "node:timers/promises";
import type { Foreground } from "./guards.ts";

export type FocusedWindow = Foreground & { id: number | bigint | null };

export interface LaunchFocusOptions {
  timeoutMs?: number;
  pollMs?: number;
  /**
   * When the window in front didn't change, whether it is the launch's target anyway: the app was
   * already open and in front, or a link opened as a new tab in the browser already in front.
   * Checked only after a moment, so a real new window gets its chance first.
   */
  sameWindow?: (focused: FocusedWindow) => boolean;
}

/** A background launch must bring an identifiable window forward before dependent input is allowed. */
export async function waitForLaunchFocus(
  previous: FocusedWindow["id"],
  foreground: () => FocusedWindow,
  signal: AbortSignal,
  { timeoutMs = 5000, pollMs = 100, sameWindow }: LaunchFocusOptions = {},
): Promise<FocusedWindow> {
  const started = performance.now();
  const grace = Math.min(1500, timeoutMs / 2);
  for (;;) {
    signal.throwIfAborted();
    const focused = foreground();
    const identified = !!focused.id && !!focused.exe && !!focused.className;
    if (identified && focused.id !== previous) return focused;
    const elapsed = performance.now() - started;
    if (identified && sameWindow && elapsed >= grace && sameWindow(focused)) return focused;
    if (elapsed >= timeoutMs) break;
    await setTimeout(Math.min(pollMs, timeoutMs - elapsed), undefined, { signal });
  }
  throw new Error("Launch requested, but focus did not move to a new window. Dependent actions were refused. Do not retry the launch; it may already be open. Use window to list or focus it.");
}
