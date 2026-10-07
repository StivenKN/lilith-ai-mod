// Finds the game through Steam, installs BepInEx + the mod from the release's payload/ folder,
// moves conflicting AI mods out of the way, and uninstalls exactly what it installed.
// Windows-specific probes (registry, tasklist) go through an injectable `exec` for testing.

import { cp, mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative } from "node:path";

export const STEAM_APP_ID = 4643090;
export const GAME_EXE = "Lilith.exe";
export const MOD_FOLDER = "LilithAICompanion";
export const PLUGIN_DLL = "LilithAICompanion.dll";
export const COMPANION_EXE = "LilithAICompanion.exe";
const UNITY_LIBS = "2021.3.45.zip";
const DEFAULT_INSTALL_DIR = "The NOexistenceN of Lilith";
const MANIFEST = "install-manifest.json";
/** Other AI mods that also hook F7/the dialogue system. Moved outside plugins/ to disable them. */
const CONFLICTS = ["LilithMod", "LilithTextInjector"];
const DISABLED_DIR = "disabled-plugins";

export type Exec = (command: string[]) => Promise<{ code: number; stdout: string }>;

export const defaultExec: Exec = async (command) => {
  try {
    const child = Bun.spawn(command, { stdout: "pipe", stderr: "ignore", windowsHide: true });
    const stdout = await new Response(child.stdout).text();
    return { code: await child.exited, stdout };
  } catch {
    return { code: -1, stdout: "" };
  }
};

const exists = (path: string) => stat(path).then(() => true, () => false);

// ── Steam discovery ────────────────────────────────────────────────────────────

type VdfValue = string | VdfObject;
export interface VdfObject {
  [key: string]: VdfValue;
}

/** Minimal parser for Valve's KeyValues text format (libraryfolders.vdf, appmanifest_*.acf). */
export function parseVdf(text: string): VdfObject {
  const tokens = text.match(/"(?:\\.|[^"\\])*"|[{}]/g) ?? [];
  let index = 0;
  const unquote = (token: string) => token.slice(1, -1).replace(/\\\\/g, "\\").replace(/\\"/g, '"');
  const parseObject = (): VdfObject => {
    const object: VdfObject = {};
    while (index < tokens.length) {
      const token = tokens[index++]!;
      if (token === "}") break;
      if (token === "{") continue;
      const next = tokens[index++];
      if (next === undefined) break;
      object[unquote(token)] = next === "{" ? parseObject() : unquote(next);
    }
    return object;
  };
  return parseObject();
}

const child = (value: VdfValue | undefined, key: string): VdfValue | undefined =>
  typeof value === "object" ? Object.entries(value).find(([k]) => k.toLowerCase() === key.toLowerCase())?.[1] : undefined;

export function libraryPaths(vdfText: string): string[] {
  const folders = child(parseVdf(vdfText), "libraryfolders");
  if (typeof folders !== "object") return [];
  return Object.values(folders).flatMap((entry) => {
    const path = child(entry, "path");
    return typeof path === "string" ? [path] : [];
  });
}

export function installDirFromManifest(acfText: string): string | null {
  const installDir = child(child(parseVdf(acfText), "AppState"), "installdir");
  return typeof installDir === "string" ? installDir : null;
}

/** Steam install folders from the registry, plus the default location. */
export async function steamRoots(exec: Exec = defaultExec): Promise<string[]> {
  if (process.platform !== "win32") return [];
  const queries = [
    ["HKCU\\Software\\Valve\\Steam", "SteamPath"],
    ["HKLM\\SOFTWARE\\WOW6432Node\\Valve\\Steam", "InstallPath"],
    ["HKLM\\SOFTWARE\\Valve\\Steam", "InstallPath"],
  ] as const;
  const found: string[] = [];
  for (const [key, value] of queries) {
    const { stdout } = await exec(["reg", "query", key, "/v", value]);
    const match = new RegExp(`${value}\\s+REG_\\w+\\s+(.+)`, "i").exec(stdout);
    if (match?.[1]) found.push(match[1].trim().replace(/\//g, "\\"));
  }
  found.push("C:\\Program Files (x86)\\Steam");
  return dedupePaths(found);
}

const dedupePaths = (paths: string[]) => [...new Map(paths.map((path) => [path.toLowerCase(), path])).values()];

/** Every valid game folder reachable from these Steam roots. */
export async function findGameDirs(roots: readonly string[]): Promise<string[]> {
  const libraries = new Set<string>();
  for (const root of roots) {
    libraries.add(root);
    const vdf = await readFile(join(root, "steamapps", "libraryfolders.vdf"), "utf8").catch(() => "");
    for (const path of libraryPaths(vdf)) libraries.add(path.replace(/\\\\/g, "\\"));
  }
  const candidates: string[] = [];
  for (const library of dedupePaths([...libraries])) {
    const acf = await readFile(join(library, "steamapps", `appmanifest_${STEAM_APP_ID}.acf`), "utf8").catch(() => "");
    const installDir = installDirFromManifest(acf) ?? DEFAULT_INSTALL_DIR;
    const dir = join(library, "steamapps", "common", installDir);
    if ((await validateGameDir(dir)).ok) candidates.push(dir);
  }
  return dedupePaths(candidates);
}

export async function validateGameDir(dir: string): Promise<{ ok: boolean; missing: string[] }> {
  const required = [GAME_EXE, "GameAssembly.dll", "Lilith_Data"];
  const missing: string[] = [];
  for (const name of required) if (!(await exists(join(dir, name)))) missing.push(name);
  return { ok: missing.length === 0, missing };
}

// ── Inspection ─────────────────────────────────────────────────────────────────

const Manifest = {
  parse(text: string): InstallManifest | null {
    try {
      const value = JSON.parse(text) as Partial<InstallManifest>;
      return Array.isArray(value.files) && typeof value.version === "string"
        ? { version: value.version, installedAt: value.installedAt ?? "", files: value.files, bepinexFiles: value.bepinexFiles ?? [] }
        : null;
    } catch {
      return null;
    }
  },
};

export interface InstallManifest {
  version: string;
  installedAt: string;
  /** Mod files, relative to the game folder. */
  files: string[];
  /** BepInEx files this installer added (empty if BepInEx was already there). */
  bepinexFiles: string[];
}

export interface GameStatus {
  gameDir: string;
  valid: boolean;
  missing: string[];
  bepinexInstalled: boolean;
  /** Interop assemblies exist, i.e. the slow first launch already happened. */
  firstLaunchDone: boolean;
  mod: { installed: boolean; version: string | null };
  conflicts: Array<{ name: string; path: string }>;
  gameRunning: boolean | null;
  smartAppControl: "on" | "evaluation" | "off" | "unknown";
}

const pluginDir = (gameDir: string) => join(gameDir, "BepInEx", "plugins", MOD_FOLDER);

export async function readManifest(gameDir: string): Promise<InstallManifest | null> {
  return Manifest.parse(await readFile(join(pluginDir(gameDir), MANIFEST), "utf8").catch(() => ""));
}

export async function inspectGame(gameDir: string, exec: Exec = defaultExec): Promise<GameStatus> {
  const validation = await validateGameDir(gameDir);
  const manifest = await readManifest(gameDir);
  return {
    gameDir,
    valid: validation.ok,
    missing: validation.missing,
    bepinexInstalled: await exists(join(gameDir, "BepInEx", "core", "BepInEx.Unity.IL2CPP.dll")),
    firstLaunchDone: await exists(join(gameDir, "BepInEx", "interop", "Assembly-CSharp.dll")),
    mod: { installed: (await exists(join(pluginDir(gameDir), PLUGIN_DLL))) && manifest !== null, version: manifest?.version ?? null },
    conflicts: await findConflicts(gameDir),
    gameRunning: await isGameRunning(exec),
    smartAppControl: await smartAppControlState(exec),
  };
}

async function findConflicts(gameDir: string): Promise<Array<{ name: string; path: string }>> {
  const plugins = join(gameDir, "BepInEx", "plugins");
  const found: Array<{ name: string; path: string }> = [];
  const walk = async (dir: string, depth: number) => {
    for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
      const full = join(dir, entry.name);
      const name = entry.name.replace(/\.dll$/i, "");
      if (entry.name === MOD_FOLDER) continue;
      if (CONFLICTS.some((conflict) => conflict.toLowerCase() === name.toLowerCase())) {
        found.push({ name, path: relative(plugins, full) });
      } else if (entry.isDirectory() && depth < 2) {
        await walk(full, depth + 1);
      }
    }
  };
  await walk(plugins, 0);
  // Report the top-level entry under plugins/, which is what gets moved.
  const topLevel = new Map(found.map((item) => [item.path.split(/[\\/]/)[0]!, item.name]));
  return [...topLevel].map(([path, name]) => ({ name, path }));
}

export async function isGameRunning(exec: Exec = defaultExec): Promise<boolean | null> {
  if (process.platform !== "win32" && exec === defaultExec) return null;
  const { code, stdout } = await exec(["tasklist", "/FI", `IMAGENAME eq ${GAME_EXE}`, "/NH"]);
  return code === 0 ? stdout.toLowerCase().includes(GAME_EXE.toLowerCase()) : null;
}

/** Windows 11 Smart App Control can block the DLLs BepInEx generates on first launch. */
export async function smartAppControlState(exec: Exec = defaultExec): Promise<GameStatus["smartAppControl"]> {
  if (process.platform !== "win32" && exec === defaultExec) return "unknown";
  const { stdout } = await exec(["reg", "query", "HKLM\\SYSTEM\\CurrentControlSet\\Control\\CI\\Policy", "/v", "VerifiedAndReputablePolicyState"]);
  const value = /REG_DWORD\s+0x([0-9a-f]+)/i.exec(stdout)?.[1];
  return value === undefined ? "unknown" : value === "1" ? "on" : value === "2" ? "evaluation" : "off";
}

// ── Install / uninstall ────────────────────────────────────────────────────────

export interface InstallStep {
  id: "check" | "bepinex" | "unityLibs" | "config" | "plugin" | "companion" | "conflicts" | "manifest";
  ok: boolean;
  detail: string;
}

/** Folder layout of the release zip next to the exe. */
export const payloadPaths = (payloadDir: string) => ({
  bepinex: join(payloadDir, "bepinex"),
  unityLibs: join(payloadDir, "unity-libs", UNITY_LIBS),
  config: join(payloadDir, "BepInEx.cfg"),
  plugin: join(payloadDir, "plugin", PLUGIN_DLL),
  version: join(payloadDir, "VERSION"),
});

export async function payloadStatus(payloadDir: string): Promise<{ available: boolean; version: string | null; missing: string[] }> {
  const paths = payloadPaths(payloadDir);
  const missing: string[] = [];
  for (const [name, path] of Object.entries(paths)) if (name !== "version" && !(await exists(path))) missing.push(relative(payloadDir, path));
  const version = (await readFile(paths.version, "utf8").catch(() => "")).trim() || null;
  return { available: missing.length === 0, version, missing };
}

export async function install(options: {
  gameDir: string;
  payloadDir: string;
  /** Path of the running companion exe to copy into the game (null in development). */
  selfExe: string | null;
  disableConflicts: boolean;
  exec?: Exec;
}): Promise<{ ok: boolean; steps: InstallStep[] }> {
  const { gameDir } = options;
  const steps: InstallStep[] = [];
  const fail = (step: InstallStep) => ({ ok: false, steps: [...steps, step] });
  const paths = payloadPaths(options.payloadDir);

  const validation = await validateGameDir(gameDir);
  if (!validation.ok) return fail({ id: "check", ok: false, detail: `Not the game folder (missing ${validation.missing.join(", ")})` });
  if (await isGameRunning(options.exec)) return fail({ id: "check", ok: false, detail: "The game is running; close it first" });
  const payload = await payloadStatus(options.payloadDir);
  if (!payload.available) return fail({ id: "check", ok: false, detail: `Release files missing: ${payload.missing.join(", ")}` });
  steps.push({ id: "check", ok: true, detail: gameDir });

  try {
    const previous = await readManifest(gameDir);
    let bepinexFiles = previous?.bepinexFiles ?? [];
    if (await exists(join(gameDir, "BepInEx", "core", "BepInEx.Unity.IL2CPP.dll"))) {
      steps.push({ id: "bepinex", ok: true, detail: "Already installed; kept as is" });
    } else {
      bepinexFiles = await copyTree(paths.bepinex, gameDir);
      steps.push({ id: "bepinex", ok: true, detail: `Installed (${bepinexFiles.length} files)` });
    }

    const unityLibs = join(gameDir, "BepInEx", "unity-libs", UNITY_LIBS);
    if (!(await exists(unityLibs))) await copyFile(paths.unityLibs, unityLibs);
    steps.push({ id: "unityLibs", ok: true, detail: "Unity libraries ready for the first launch" });

    const config = join(gameDir, "BepInEx", "config", "BepInEx.cfg");
    if (!(await exists(config))) await copyFile(paths.config, config);
    steps.push({ id: "config", ok: true, detail: "BepInEx.cfg present" });

    const files = [join("BepInEx", "plugins", MOD_FOLDER, PLUGIN_DLL)];
    await copyFile(paths.plugin, join(gameDir, files[0]!));
    steps.push({ id: "plugin", ok: true, detail: PLUGIN_DLL });

    const exeTarget = join(pluginDir(gameDir), COMPANION_EXE);
    if (options.selfExe && options.selfExe.toLowerCase() !== exeTarget.toLowerCase()) {
      await copyFile(options.selfExe, exeTarget);
      steps.push({ id: "companion", ok: true, detail: COMPANION_EXE });
    } else {
      steps.push({ id: "companion", ok: true, detail: options.selfExe ? "Already in place" : "Skipped (development build)" });
    }
    files.push(join("BepInEx", "plugins", MOD_FOLDER, COMPANION_EXE));

    const conflicts = await findConflicts(gameDir);
    if (conflicts.length > 0 && options.disableConflicts) {
      const target = join(gameDir, "BepInEx", DISABLED_DIR);
      await mkdir(target, { recursive: true });
      for (const conflict of conflicts) {
        await retry(() => rename(join(gameDir, "BepInEx", "plugins", conflict.path), join(target, basename(conflict.path))));
      }
      steps.push({ id: "conflicts", ok: true, detail: `Moved to BepInEx\\${DISABLED_DIR}: ${conflicts.map((c) => c.name).join(", ")}` });
    } else {
      steps.push({ id: "conflicts", ok: true, detail: conflicts.length ? `Left enabled: ${conflicts.map((c) => c.name).join(", ")}` : "None found" });
    }

    const manifest: InstallManifest = { version: payload.version ?? "dev", installedAt: new Date().toISOString(), files, bepinexFiles };
    await writeFile(join(pluginDir(gameDir), MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    steps.push({ id: "manifest", ok: true, detail: MANIFEST });
    return { ok: true, steps };
  } catch (error) {
    return fail({ id: "check", ok: false, detail: error instanceof Error ? error.message : String(error) });
  }
}

export type UninstallResult =
  | { ok: false; outcome: "gameRunning" }
  | { ok: true; outcome: "mod" | "modAndBepInEx" }
  | { ok: true; outcome: "bepinexKept"; otherMods: string[] };

/** Removes the mod (and BepInEx only if we installed it, were asked to, and no other mod uses it). User data is untouched. */
export async function uninstall(options: { gameDir: string; removeBepInEx: boolean; exec?: Exec }): Promise<UninstallResult> {
  if (await isGameRunning(options.exec)) return { ok: false, outcome: "gameRunning" };
  const manifest = await readManifest(options.gameDir);
  await rm(pluginDir(options.gameDir), { recursive: true, force: true });
  if (!options.removeBepInEx || !manifest || manifest.bepinexFiles.length === 0) return { ok: true, outcome: "mod" };
  const otherMods = await readdir(join(options.gameDir, "BepInEx", "plugins")).catch(() => []);
  if (otherMods.length > 0) return { ok: true, outcome: "bepinexKept", otherMods };
  for (const file of manifest.bepinexFiles) await rm(join(options.gameDir, file), { force: true });
  for (const dir of ["BepInEx", "dotnet"]) await rm(join(options.gameDir, dir), { recursive: true, force: true });
  return { ok: true, outcome: "modAndBepInEx" };
}

/** Copies a directory tree, returning the copied files relative to the destination. */
async function copyTree(from: string, to: string): Promise<string[]> {
  const files: string[] = [];
  const walk = async (dir: string) => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else files.push(relative(from, full));
    }
  };
  await walk(from);
  for (const file of files) await copyFile(join(from, file), join(to, file));
  return files;
}

async function copyFile(from: string, to: string): Promise<void> {
  await mkdir(dirname(to), { recursive: true });
  await retry(() => cp(from, to, { force: true }));
}

/** Antivirus scanners briefly lock fresh files on Windows; retry a few times before failing. */
async function retry(run: () => Promise<void>, attempts = 4): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await run();
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (attempt >= attempts || (code !== "EBUSY" && code !== "EPERM" && code !== "EACCES")) throw error;
      await Bun.sleep(400 * attempt);
    }
  }
}
