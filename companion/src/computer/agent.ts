import type { HttpOptions } from "../providers/http.ts";
import type { AgentSession, ToolResult } from "../providers/types.ts";
import { parseCall, physicalPoint, screenshotSize, type Action } from "./actions.ts";
import type { Desktop, InputWatch } from "./desktop.ts";
import { guardAction } from "./guards.ts";

export interface ComputerTurnOptions {
  session: AgentSession;
  desktop: Desktop;
  vision: boolean;
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

/** Runs tool batches in order, stops after the first failure, and always releases the input watcher. */
export async function runComputerTurn(options: ComputerTurnOptions): Promise<ComputerTurnResult> {
  const controller = new AbortController();
  const signal = options.http.signal ? AbortSignal.any([controller.signal, options.http.signal]) : controller.signal;
  const maxSteps = options.maxSteps ?? 20;
  let outcome: "stopped" | "limit" = "stopped";
  let timer: ReturnType<typeof setTimeout> | undefined;
  let watch: InputWatch | undefined;
  let interval: ReturnType<typeof setInterval> | undefined;
  let model = "";
  let steps = 0;
  let results: ToolResult[] = [];
  let watcherFailure: Error | undefined;
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
      if (!step.calls.length) return { text: step.text, model, outcome: "done" };
      results = [];
      let failed = false;
      for (const call of step.calls) {
        checkInput();
        if (options.canAct && !options.canAct()) return { text: "", model, outcome: "superseded" };
        if (failed) {
          results.push({ id: call.id, text: "Not executed: an earlier computer action in this turn failed.", isError: true });
          continue;
        }
        if (steps++ >= maxSteps) return { text: "", model, outcome: "limit" };
        timer ??= setTimeout(() => { outcome = "limit"; controller.abort(); }, options.maxMs ?? 180_000);
        const action = parseCall(call);
        try {
          if ("error" in action) throw new Error(action.error);
          if (!options.vision && !["type", "key", "openApp", "openUrl"].includes(action.type)) throw new Error("This model cannot see the screen. Use only open_app, open_url, type_text and press_key.");
          // Bounds are checked even for a fake desktop and before any modifiers are pressed.
          if ("at" in action && action.at) physicalPoint(action.at, options.desktop.screen);
          if ("at" in action && action.at === null) physicalPoint(options.desktop.cursor(), options.desktop.screen);
          if (action.type === "drag") { physicalPoint(action.from, options.desktop.screen); physicalPoint(action.to, options.desktop.screen); }
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
          guardAction(action, options.desktop.foreground());
          options.onStatus(action);
          options.log(`computer action ${steps}: ${action.type}${action.type === "type" ? ` (${action.text.length} characters)` : ""}`);
          let text = "OK";
          let image: Uint8Array | undefined;
          switch (action.type) {
            case "screenshot": image = options.desktop.capture(); break;
            case "zoom": image = options.desktop.capture(action.region); break;
            case "cursor": { const p = options.desktop.cursor(); text = `X=${p.x}, Y=${p.y}`; break; }
            case "wait": await pause(action.seconds * 1000, signal); break;
            default: text = await options.desktop.execute(action, signal) ?? "OK";
          }
          checkInput();
          if (!options.vision && (action.type === "type" || action.type === "key")) text += `; focused app: ${options.desktop.foreground().exe || "unknown"}`;
          if (options.vision && call.toolset !== "computer" && !image) {
            await pause(options.settleMs ?? 400, signal);
            checkInput();
            image = options.desktop.capture();
          }
          results.push({ id: call.id, text, ...(image ? { image } : {}) });
        } catch (error) {
          if (signal.aborted) throw error;
          const text = error instanceof Error ? error.message : String(error);
          options.log(`computer action failed: ${text}`);
          results.push({ id: call.id, text, isError: true });
          failed = true;
        }
      }
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

async function pause(ms: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  await new Promise<void>((resolve, reject) => {
    const cleanup = () => signal.removeEventListener("abort", abort);
    const timer = setTimeout(() => { cleanup(); resolve(); }, ms);
    const abort = () => { clearTimeout(timer); cleanup(); reject(signal.reason); };
    signal.addEventListener("abort", abort, { once: true });
  });
}
