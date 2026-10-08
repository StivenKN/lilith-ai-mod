import { z } from "zod";
import { blockedApp } from "./guards.ts";

const StartApp = z.object({ Name: z.string(), AppID: z.string().min(1) });
export type StartApp = z.infer<typeof StartApp>;
const fold = (value: string) => value.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().trim();

// Inline Shell enumeration works under Restricted policy without loading Get-StartApps.psm1.
export const START_APPS_COMMAND = "[Console]::OutputEncoding = [Text.UTF8Encoding]::new(); $ErrorActionPreference = 'Stop'; $apps = @((New-Object -ComObject Shell.Application).NameSpace('shell:::{4234d49b-0245-4df3-b780-3893943456e1}').Items() | ForEach-Object { [pscustomobject]@{ Name = $_.Name; AppID = $_.Path } }); ConvertTo-Json -InputObject $apps -Compress";

export function parseApps(json: string): StartApp[] {
  const value: unknown = JSON.parse(json.replace(/^\uFEFF/, ""));
  return z.array(StartApp).parse(value === null ? [] : Array.isArray(value) ? value : [value]);
}

export function matchApp(apps: readonly StartApp[], name: string): StartApp {
  const query = fold(name);
  if (!query) throw new Error("An app name is required");
  for (const match of [(s: string) => s === query, (s: string) => s.startsWith(query), (s: string) => s.includes(query)]) {
    const candidates = apps.filter((app) => match(fold(app.Name)));
    if (candidates.length === 1) return candidates[0]!;
    if (candidates.length > 1) throw new Error(`App name is ambiguous. Use one of: ${candidates.slice(0, 8).map((app) => app.Name).join(", ")}`);
  }
  const suggestions = [...apps].sort((a, b) => {
    const score = (app: StartApp) => query.split(/\s+/).filter((word) => fold(app.Name).includes(word)).length;
    return score(b) - score(a) || a.Name.localeCompare(b.Name);
  }).slice(0, 8);
  throw new Error(`App not found. Installed names include: ${suggestions.map((app) => app.Name).join(", ")}`);
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

export async function openApp(name: string, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  let apps = await installedApps(signal);
  if (!apps.some((app) => fold(app.Name).includes(fold(name)))) {
    // The Start catalog can change while the companion is running.
    catalog = undefined;
    apps = await installedApps(signal);
  }
  const app = matchApp(apps, name);
  signal.throwIfAborted();
  if (blockedApp(app.Name, app.AppID)) throw new Error("Opening terminals and system tools is disabled");
  Bun.spawn(["explorer.exe", `shell:AppsFolder\\${app.AppID}`], { stdout: "ignore", stderr: "ignore" });
}
