import { z } from "zod";
import type { FocusedWindow } from "./focus.ts";
import { blockedApp, type Foreground } from "./guards.ts";

const StartApp = z.object({ Name: z.string(), AppID: z.string().min(1) });
export type StartApp = z.infer<typeof StartApp>;
/** Case, accents and a trailing ".exe" don't matter when a model names an app or window. */
const fold = (value: string) => value.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().trim().replace(/\.exe$/, "");

// Inline Shell enumeration works under Restricted policy without loading Get-StartApps.psm1.
export const START_APPS_COMMAND = "[Console]::OutputEncoding = [Text.UTF8Encoding]::new(); $ErrorActionPreference = 'Stop'; $apps = @((New-Object -ComObject Shell.Application).NameSpace('shell:::{4234d49b-0245-4df3-b780-3893943456e1}').Items() | ForEach-Object { [pscustomobject]@{ Name = $_.Name; AppID = $_.Path } }); ConvertTo-Json -InputObject $apps -Compress";

export function parseApps(json: string): StartApp[] {
  const value: unknown = JSON.parse(json.replace(/^﻿/, ""));
  return z.array(StartApp).parse(value === null ? [] : Array.isArray(value) ? value : [value]);
}

/**
 * Built-in apps by their English names, which a model uses even on a Spanish Windows ("Notepad" for
 * "Bloc de notas"), found by a piece of their AppID, which doesn't change with the language.
 */
const builtIn = new Map([
  ["notepad", "notepad"], ["calculator", "calculator"], ["settings", "immersivecontrolpanel"], ["windows settings", "immersivecontrolpanel"],
  ["file explorer", "windows.explorer"], ["windows explorer", "windows.explorer"], ["windows file explorer", "windows.explorer"], ["explorer", "windows.explorer"],
  ["camera", "windowscamera"], ["photos", "windows.photos"], ["clock", "windowsalarms"], ["alarms", "windowsalarms"], ["snipping tool", "screensketch"],
  ["control panel", "windows.controlpanel"], ["microsoft store", "windowsstore"], ["store", "windowsstore"], ["media player", "zunemusic"],
]);

class AppNotFoundError extends Error {
  override readonly name = "AppNotFoundError";
}

export function matchApp(apps: readonly StartApp[], name: string): StartApp {
  const query = fold(name);
  if (!query) throw new Error("An app name is required");
  for (const match of [(s: string) => s === query, (s: string) => s.startsWith(query), (s: string) => s.includes(query)]) {
    const candidates = apps.filter((app) => match(fold(app.Name)));
    if (candidates.length === 1) return candidates[0]!;
    if (candidates.length > 1) throw new Error(`App name is ambiguous. Use one of: ${candidates.slice(0, 8).map((app) => app.Name).join(", ")}`);
  }
  const id = builtIn.get(query);
  const native = id ? apps.filter((app) => app.AppID.toLowerCase().includes(id)) : [];
  if (native.length === 1) return native[0]!;
  // Models add words: "Google Chrome browser", "the Spotify app". The longest name inside wins.
  const inside = apps.filter((app) => fold(app.Name).length >= 4 && query.includes(fold(app.Name)));
  const longest = Math.max(0, ...inside.map((app) => fold(app.Name).length));
  const best = inside.filter((app) => fold(app.Name).length === longest);
  if (best.length === 1) return best[0]!;
  const suggestions = [...apps].sort((a, b) => {
    const score = (app: StartApp) => query.split(/\s+/).filter((word) => fold(app.Name).includes(word)).length;
    return score(b) - score(a) || a.Name.localeCompare(b.Name);
  }).slice(0, 8);
  throw new AppNotFoundError(`App not found. Installed names include: ${suggestions.map((app) => app.Name).join(", ")}. If it's a website, open it with open_url.`);
}

let catalog: Promise<StartApp[]> | undefined;
export async function installedApps(signal?: AbortSignal): Promise<StartApp[]> {
  catalog ??= (async () => {
    const proc = Bun.spawn(["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", START_APPS_COMMAND], { windowsHide: true, stdout: "pipe", stderr: "pipe" });
    const abort = () => proc.kill();
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    const timer = setTimeout(() => proc.kill(), 10_000);
    try {
      const [output, errors, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
      if (code !== 0) throw new Error(`Could not list Start apps: ${errors.slice(0, 200)}`);
      return parseApps(output);
    } finally { clearTimeout(timer); signal?.removeEventListener("abort", abort); }
  })();
  try { return await catalog; } catch (error) { catalog = undefined; throw error; }
}

/** Launches a Start app and returns it, so the caller can recognize its window. */
export async function openApp(name: string, signal: AbortSignal): Promise<StartApp> {
  signal.throwIfAborted();
  let app: StartApp;
  try { app = matchApp(await installedApps(signal), name); }
  catch (error) {
    if (!(error instanceof AppNotFoundError)) throw error;
    // The Start catalog can change while the companion is running.
    catalog = undefined;
    app = matchApp(await installedApps(signal), name);
  }
  signal.throwIfAborted();
  if (blockedApp(app.Name, app.AppID)) throw new Error("Opening terminals and system tools is disabled");
  Bun.spawn(["explorer.exe", `shell:AppsFolder\\${app.AppID}`], { stdout: "ignore", stderr: "ignore" });
  return app;
}

/**
 * Whether a window looks like the named app's: its executable is named after it, or its title ends
 * with it, as Windows apps title themselves ("Sin título: Bloc de notas"). A title that merely
 * mentions the app, like a browser tab about it, doesn't count.
 */
export function windowOf(window: Foreground, name: string): boolean {
  const query = fold(name);
  return !!query && (fold(window.title).endsWith(query) || fold(window.exe) === query);
}

export const browserWindow = (window: Pick<Foreground, "exe">): boolean =>
  /^(chrome|msedge|firefox|brave|opera|vivaldi|arc|librewolf|waterfox|floorp|zen|chromium|thorium|iexplore)\.exe$/i.test(window.exe);

export type ListedWindow = FocusedWindow & { minimized: boolean };

/** The frontmost window whose title or app matches; whole matches beat partial ones. */
export function matchWindow<W extends Foreground>(windows: readonly W[], query: string): W {
  const wanted = fold(query);
  if (!wanted) throw new Error("A window title is required");
  const found = windows.find((window) => fold(window.title) === wanted || fold(window.exe) === wanted)
    ?? windows.find((window) => fold(window.title).includes(wanted) || fold(window.exe).includes(wanted));
  if (found) return found;
  throw new Error(`No open window matches "${query}". Open windows: ${windows.slice(0, 12).map((window) => `"${window.title}"`).join(", ") || "none"}`);
}

/** Open windows as the model reads them, front to back. */
export function describeWindows(windows: readonly ListedWindow[], active: FocusedWindow["id"]): string {
  if (!windows.length) return "No app windows are open.";
  const lines = windows.slice(0, 25).map((window, index) =>
    `${index + 1}. "${window.title.slice(0, 100)}" (${window.exe || "unknown app"})${window.id === active ? " [active]" : window.minimized ? " [minimized]" : ""}`);
  return `Open windows, front to back:\n${lines.join("\n")}`;
}
