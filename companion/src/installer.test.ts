import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findGameDirs, inspectGame, install, installDirFromManifest, libraryPaths, uninstall, type Exec } from "./installer.ts";

const temps: string[] = [];
afterEach(async () => Promise.all(temps.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))));

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "lilith-installer-"));
  temps.push(dir);
  return dir;
}

async function touch(path: string, contents = "x"): Promise<void> {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, contents);
}

const exists = (path: string) => stat(path).then(() => true, () => false);
const notRunning: Exec = async () => ({ code: 0, stdout: "INFO: No tasks are running which match the specified criteria." });

async function fakeGame(root: string): Promise<string> {
  const game = join(root, "steamapps", "common", "Lilith Game");
  await touch(join(game, "Lilith.exe"));
  await touch(join(game, "GameAssembly.dll"));
  await mkdir(join(game, "Lilith_Data"), { recursive: true });
  return game;
}

async function fakePayload(root: string): Promise<string> {
  const payload = join(root, "payload");
  await touch(join(payload, "bepinex", "winhttp.dll"));
  await touch(join(payload, "bepinex", "BepInEx", "core", "BepInEx.Unity.IL2CPP.dll"));
  await touch(join(payload, "unity-libs", "2021.3.45.zip"));
  await touch(join(payload, "BepInEx.cfg"), "[Logging.Console]\nEnabled = false\n");
  await touch(join(payload, "plugin", "LilithAICompanion.dll"));
  await touch(join(payload, "VERSION"), "0.1.0\n");
  return payload;
}

describe("Steam discovery", () => {
  test("reads library folders and the game's install dir from VDF/ACF files", () => {
    const vdf = `"libraryfolders"\n{\n\t"0"\n\t{\n\t\t"path"\t\t"C:\\\\Program Files (x86)\\\\Steam"\n\t}\n\t"1"\n\t{\n\t\t"path"\t\t"D:\\\\Games\\\\SteamLibrary"\n\t\t"apps" { "4643090" "123" }\n\t}\n}`;
    expect(libraryPaths(vdf)).toEqual(["C:\\Program Files (x86)\\Steam", "D:\\Games\\SteamLibrary"]);
    expect(installDirFromManifest(`"AppState" { "appid" "4643090" "installdir" "Lilith Game" }`)).toBe("Lilith Game");
  });

  test("finds the game in a secondary library", async () => {
    const steam = await tempDir();
    const library = await tempDir();
    await touch(join(steam, "steamapps", "libraryfolders.vdf"), `"libraryfolders" { "1" { "path" "${library.replace(/\\/g, "\\\\")}" } }`);
    await touch(join(library, "steamapps", "appmanifest_4643090.acf"), `"AppState" { "installdir" "Lilith Game" }`);
    const game = await fakeGame(library);
    expect(await findGameDirs([steam])).toEqual([game]);
  });
});

describe("install and uninstall", () => {
  test("installs BepInEx and the mod, moves conflicting mods out of plugins/, and uninstalls cleanly", async () => {
    const root = await tempDir();
    const game = await fakeGame(root);
    const payload = await fakePayload(root);
    await touch(join(game, "BepInEx", "plugins", "LilithMod", "LilithMod.dll"));
    await touch(join(game, "BepInEx", "plugins", "LilithFloorFix.dll"));

    const before = await inspectGame(game, notRunning);
    expect(before.conflicts).toEqual([{ name: "LilithMod", path: "LilithMod" }]);

    const result = await install({ gameDir: game, payloadDir: payload, selfExe: null, disableConflicts: true, exec: notRunning });
    expect(result.ok).toBe(true);
    expect(await exists(join(game, "winhttp.dll"))).toBe(true);
    expect(await exists(join(game, "BepInEx", "unity-libs", "2021.3.45.zip"))).toBe(true);
    expect(await exists(join(game, "BepInEx", "plugins", "LilithAICompanion", "LilithAICompanion.dll"))).toBe(true);
    expect(await exists(join(game, "BepInEx", "disabled-plugins", "LilithMod"))).toBe(true);
    expect(await readdir(join(game, "BepInEx", "plugins"))).toEqual(expect.arrayContaining(["LilithFloorFix.dll", "LilithAICompanion"]));

    const after = await inspectGame(game, notRunning);
    expect(after).toMatchObject({ bepinexInstalled: true, conflicts: [], mod: { installed: true, version: "0.1.0" } });

    // Another mod still uses BepInEx, so it stays.
    const removal = await uninstall({ gameDir: game, removeBepInEx: true, exec: notRunning });
    expect(removal).toEqual({ ok: true, outcome: "bepinexKept", otherMods: ["LilithFloorFix.dll"] });
    expect(await exists(join(game, "BepInEx", "plugins", "LilithAICompanion"))).toBe(false);
    expect(await exists(join(game, "winhttp.dll"))).toBe(true);
  });

  test("keeps an existing BepInEx and refuses while the game runs", async () => {
    const root = await tempDir();
    const game = await fakeGame(root);
    const payload = await fakePayload(root);
    await touch(join(game, "BepInEx", "core", "BepInEx.Unity.IL2CPP.dll"), "existing");

    const running: Exec = async () => ({ code: 0, stdout: "Lilith.exe   1234 Console   1   300,000 K" });
    const blocked = await install({ gameDir: game, payloadDir: payload, selfExe: null, disableConflicts: false, exec: running });
    expect(blocked.ok).toBe(false);

    const result = await install({ gameDir: game, payloadDir: payload, selfExe: null, disableConflicts: false, exec: notRunning });
    expect(result.steps.find((step) => step.id === "bepinex")?.detail).toContain("kept");
    expect(await exists(join(game, "winhttp.dll"))).toBe(false);
  });

  test("reports missing release files instead of half-installing", async () => {
    const root = await tempDir();
    const game = await fakeGame(root);
    const result = await install({ gameDir: game, payloadDir: join(root, "nope"), selfExe: null, disableConflicts: false, exec: notRunning });
    expect(result.ok).toBe(false);
    expect(result.steps.at(-1)?.detail).toContain("Release files missing");
  });
});
