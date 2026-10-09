import type { HttpOptions } from "../providers/http.ts";
import type { AgentSession, ToolResult } from "../providers/types.ts";
import { parseCall, physicalPoint, screenshotSize, type Action } from "./actions.ts";
import type { Desktop, InputWatch } from "./desktop.ts";
import { guardAction, type Foreground } from "./guards.ts";

export interface ComputerTurnOptions {
  session: AgentSession;
  desktop: Desktop;
  vision: boolean;
  /** What the host asked for. Repeated next to every screenshot, where a small model looks most. */
  task: string;
  http: HttpOptions;
  yieldFocus: () => void;
  onStatus: (action: Action) => void;
  log: (message: string) => void;
  /** A newer queued message may preserve the reply while preventing this turn from acting. */
  canAct?: () => boolean;
  maxSteps?: number;
  maxMs?: number;
  /** Shorter waits for deterministic fake-desktop tests. */
  settleMs?: number;
}

export interface ComputerTurnResult {
  text: string;
  model: string;
  outcome: "done" | "stopped" | "limit" | "superseded";
}

/** What a model without vision may do: everything but the mouse. */
const BLIND: ReadonlySet<Action["type"]> = new Set(["type", "key", "wait", "openApp", "openUrl", "window", "finish"]);
/** Actions that only look. Everything else may change the screen. */
const LOOKS: ReadonlySet<Action["type"]> = new Set(["screenshot", "zoom", "cursor"]);
/** Actions that bring other windows forward, which take longer to paint. */
const SWITCHES: ReadonlySet<Action["type"]> = new Set(["openApp", "openUrl", "window"]);
/** Pointer actions aimed at a spot the model picked from a screenshot. */
const aimed = (action: Action) => action.type === "move" || action.type === "drag" || ((action.type === "click" || action.type === "scroll") && action.at !== null);

const SKIPPED = "Not executed: an earlier computer action in this turn failed.";
const ENDED = "Not executed: you already ended the task.";

/**
 * Runs tool batches in order, stops after the first failure, and always releases the input watcher.
 * Custom tools (everything but Claude's own computer toolset) get one fresh screenshot after each
 * batch, with the task restated, the active window, and whether anything changed: a small model
 * needs that feedback to notice a missed click instead of claiming success.
 */
export async function runComputerTurn(options: ComputerTurnOptions): Promise<ComputerTurnResult> {
  const controller = new AbortController();
  const signal = options.http.signal ? AbortSignal.any([controller.signal, options.http.signal]) : controller.signal;
  const maxSteps = options.maxSteps ?? 40;
  const settle = options.settleMs ?? 400;
  let outcome: "stopped" | "limit" = "stopped";
  let timer: ReturnType<typeof setTimeout> | undefined;
  let watch: InputWatch | undefined;
  let interval: ReturnType<typeof setInterval> | undefined;
  let model = "";
  let steps = 0;
  let results: ToolResult[] = [];
  let watcherFailure: Error | undefined;
  // Whether the model planned this batch on a screenshot that still shows the screen.
  let current = false;
  let lastScreen: number | bigint | undefined;
  // The latest action that changed something, and whether the screen changed after it.
  let last: { action: string; changed: boolean | null } | undefined;
  let answer: string | null = null;
  let nudged = false;
  let repeats = 0;
  const pollInput = () => {
    if (signal.aborted) return;
    try { if (watch?.changed()) { outcome = "stopped"; controller.abort(); } }
    catch (error) {
      watcherFailure = new Error(`Player input watcher failed: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
      options.log(watcherFailure.message);
      controller.abort(watcherFailure);
    }
  };
  const checkInput = () => {
    pollInput();
    signal.throwIfAborted();
  };
  try {
    for (;;) {
      checkInput();
      const step = await options.session.next(results, { ...options.http, signal });
      model = step.model;
      checkInput();
      // After terminate or answer the model only has to reply. More calls end the task anyway.
      if (!step.calls.length || answer !== null) return { text: step.text || answer || "", model, outcome: "done" };
      results = [];
      let skip: string | null = null;
      let custom = false;
      const changed: Action[] = [];
      for (const call of step.calls) {
        checkInput();
        if (options.canAct && !options.canAct()) return { text: "", model, outcome: "superseded" };
        if (skip) {
          results.push({ id: call.id, text: skip, isError: true });
          continue;
        }
        const action = parseCall(call, options.desktop.screen);
        // Asked to do something, a small model often "answers" by asking whether it should. Once,
        // before anything happened, it's told to act instead; a second answer stands.
        if (!("error" in action) && action.type === "finish" && steps === 0 && !nudged) {
          nudged = true;
          results.push({ id: call.id, text: "Nothing has been done on the PC yet. If your host asked you to do something there, do it now with a tool instead of asking whether to. If they only asked you a question, reply in words." });
          continue;
        }
        if (!("error" in action) && action.type === "finish") {
          answer = action.answer;
          skip = ENDED;
          results.push({ id: call.id, text: "The task has ended. Now reply to your host, without calling tools." });
          continue;
        }
        if (steps++ >= maxSteps) return { text: "", model, outcome: "limit" };
        timer ??= setTimeout(() => { outcome = "limit"; controller.abort(); }, options.maxMs ?? 480_000);
        custom ||= call.toolset !== "computer";
        try {
          if ("error" in action) throw new Error(action.error);
          if (!options.vision && !BLIND.has(action.type)) throw new Error("This model cannot see the screen. Use only the keyboard, open_app, open_url and window.");
          // Bounds are checked even for a fake desktop and before any modifiers are pressed.
          if ("at" in action && action.at) physicalPoint(action.at, options.desktop.screen);
          if ("at" in action && action.at === null) physicalPoint(options.desktop.cursor(), options.desktop.screen);
          if (action.type === "drag") { physicalPoint(action.from ?? options.desktop.cursor(), options.desktop.screen); physicalPoint(action.to, options.desktop.screen); }
          if (action.type === "zoom") {
            const { region } = action, image = screenshotSize(options.desktop.screen);
            if (region.x + region.width > image.width || region.y + region.height > image.height) throw new Error("Zoom region is outside the screen");
          }
          if (!watch) {
            options.yieldFocus();
            await pause(options.settleMs ?? 250, signal);
            watch = options.desktop.watchInput();
            interval = setInterval(pollInput, 25);
          }
          checkInput();
          if (options.canAct && !options.canAct()) return { text: "", model, outcome: "superseded" };
          // Coordinates picked before seeing the screen, or after an earlier action in this batch changed it, are guesses.
          if (options.vision && call.toolset !== "computer" && aimed(action) && !current) {
            throw new Error("Not executed: you have not seen the screen since it last changed, so these coordinates are a guess. Look at the new screenshot and choose them again.");
          }
          const signature = JSON.stringify(action);
          // Waiting again for a slow app is fine; it's other repeats that mean the model is stuck.
          if (action.type !== "wait" && last?.action === signature && last.changed === false) {
            // A small model can ignore this and retry until the action cap. The third time, the task ends.
            if (++repeats >= 3) {
              answer = "";
              skip = ENDED;
              results.push({ id: call.id, text: "Not executed. You keep repeating an action that changes nothing, so the task has ended. Tell your host what you managed and where you got stuck, without calling tools.", isError: true });
              continue;
            }
            throw new Error("Not executed: you just did exactly this and the screen did not change. Try something different (another spot, a keyboard shortcut, another way), or tell your host you could not do it.");
          }
          guardAction(action, options.desktop.foreground());
          options.onStatus(action);
          options.log(`computer action ${steps}: ${action.type}${action.type === "type" ? ` (${action.text.length} characters)` : action.type === "window" ? ` ${action.op}` : ""}`);
          let text = "OK";
          let image: Uint8Array | undefined;
          switch (action.type) {
            // Custom tools get their screenshot after the batch.
            case "screenshot": if (call.toolset === "computer") image = options.desktop.capture(); break;
            case "zoom": image = options.desktop.capture(action.region); break;
            case "cursor": { const p = options.desktop.cursor(); text = `X=${p.x}, Y=${p.y}`; break; }
            case "wait": await pause(action.seconds * 1000, signal); break;
            default: text = await options.desktop.execute(action, signal) ?? "OK";
          }
          checkInput();
          if (!LOOKS.has(action.type)) {
            current = false;
            changed.push(action);
            last = { action: signature, changed: null };
          }
          results.push({ id: call.id, text, ...(image ? { image } : {}) });
        } catch (error) {
          if (signal.aborted) throw error;
          const text = error instanceof Error ? error.message : String(error);
          options.log(`computer action failed: ${text}`);
          results.push({ id: call.id, text, isError: true });
          skip = SKIPPED;
        }
      }
      // Nothing reached the desktop yet, so the chat popup may still cover it: no screenshot.
      const report = results.at(-1);
      if (!watch || !report) continue;
      const notes: string[] = [];
      if (options.vision && custom) {
        await pause(changed.some((action) => SWITCHES.has(action.type)) ? settle * 2.5 : settle, signal);
        checkInput();
        const image = options.desktop.capture();
        const screen = Bun.hash(image);
        if (changed.length && lastScreen !== undefined) {
          if (last) last.changed = screen !== lastScreen;
          if (screen === lastScreen) notes.push("The screen did not change.");
        }
        lastScreen = screen;
        current = true;
        report.image = image;
        report.caption = caption(options.task, steps, maxSteps);
      }
      notes.push(activeWindow(options.desktop.foreground()));
      report.text = `${report.text} ${notes.join(" ")}`;
    }
  } catch (error) {
    if (watcherFailure) throw watcherFailure;
    if (!signal.aborted) throw error;
    return { text: "", model, outcome };
  } finally {
    clearTimeout(timer);
    if (interval) clearInterval(interval);
    watch?.close();
  }
}

/** Sent with each screenshot: what to do with it, and the task, which may have scrolled far up. */
function caption(task: string, steps: number, maxSteps: number): string {
  const asked = task.trim() ? ` Your host asked: "${task.trim().slice(0, 300)}".` : "";
  return `This is the screen now.${asked} Actions used: ${steps} of ${maxSteps}. Do the next step, or stop calling tools and reply to your host if the task is done or cannot be done.`;
}

const activeWindow = (window: Foreground) =>
  window.exe ? `Active window: ${window.title ? `"${window.title.slice(0, 100)}" ` : ""}(${window.exe}).` : "Active window: unknown.";

async function pause(ms: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  await new Promise<void>((resolve, reject) => {
    const cleanup = () => signal.removeEventListener("abort", abort);
    const timer = setTimeout(() => { cleanup(); resolve(); }, ms);
    const abort = () => { clearTimeout(timer); cleanup(); reject(signal.reason); };
    signal.addEventListener("abort", abort, { once: true });
  });
}
