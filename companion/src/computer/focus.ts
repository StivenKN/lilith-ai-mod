import { setTimeout } from "node:timers/promises";
import type { Foreground } from "./guards.ts";

export type FocusedWindow = Foreground & { id: number | bigint | null };

/** A background launch must bring an identifiable window forward before dependent input is allowed. */
export async function waitForLaunchFocus(
  previous: FocusedWindow["id"],
  foreground: () => FocusedWindow,
  signal: AbortSignal,
  timeoutMs = 5000,
  pollMs = 100,
): Promise<FocusedWindow> {
  const deadline = performance.now() + timeoutMs;
  do {
    signal.throwIfAborted();
    const focused = foreground();
    if (focused.id && focused.id !== previous && focused.exe && focused.className) return focused;
    const remaining = deadline - performance.now();
    if (remaining <= 0) break;
    await setTimeout(Math.min(pollMs, remaining), undefined, { signal });
  } while (performance.now() < deadline);
  throw new Error("Launch requested, but focus did not move to a new window. Dependent actions were refused. Do not retry the launch; it may already be open.");
}
