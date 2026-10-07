// Third-party downloads the release depends on, pinned by URL and SHA-256 (single source of truth).
//   bun scripts/pinned.ts bepinex <dir>    downloads, verifies and extracts BepInEx (used to build the plugin)

import { createHash } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";

export interface Pinned {
  url: string;
  sha256: string;
  file: string;
}

/** BepInEx 6 bleeding-edge build proven in game by the community mods. */
export const BEPINEX: Pinned = {
  url: "https://builds.bepinex.dev/projects/bepinex_be/780/BepInEx-Unity.IL2CPP-win-x64-6.0.0-be.780%2B3be4532.zip",
  sha256: "504303897b5df2256f676428dfa0981cde2440b7937efcd282bf1bc426a6e223",
  file: "bepinex-be.780.zip",
};

/** Unstripped Unity libraries for the game's Unity version, so the first launch works offline. */
export const UNITY_LIBS: Pinned = {
  url: "https://unity.bepinex.dev/libraries/2021.3.45.zip",
  sha256: "3cfde1613715c966cb8084087c37081ed5896871b39194d45a907a69dd7da9e5",
  file: "unity-libs-2021.3.45.zip",
};

/** Downloads once into dist/cache and refuses anything whose checksum doesn't match. */
export async function fetchPinned(source: Pinned): Promise<string> {
  const path = resolve("dist", "cache", source.file);
  if (!(await Bun.file(path).exists())) {
    console.log(`downloading ${source.url}`);
    const response = await fetch(source.url);
    if (!response.ok) throw new Error(`download failed (${response.status}): ${source.url}`);
    await Bun.write(path, response);
  }
  const hash = createHash("sha256").update(await Bun.file(path).bytes()).digest("hex");
  if (hash !== source.sha256) {
    await rm(path);
    throw new Error(`checksum mismatch for ${source.file}: expected ${source.sha256}, got ${hash}`);
  }
  return path;
}

export async function run(command: string[]): Promise<void> {
  const child = Bun.spawn(command, { stdout: "inherit", stderr: "inherit" });
  if ((await child.exited) !== 0) throw new Error(`failed: ${command.join(" ")}`);
}

/** Extracts the pinned BepInEx into `dir` (bsdtar reads zip on macOS and Windows 10+). */
export async function extractBepInEx(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  await run(["tar", "-xf", await fetchPinned(BEPINEX), "-C", dir]);
}

if (import.meta.main) {
  const [command, dir] = process.argv.slice(2);
  if (command !== "bepinex" || !dir) {
    console.error("usage: bun scripts/pinned.ts bepinex <dir>");
    process.exit(2);
  }
  await extractBepInEx(resolve(dir));
  console.log(`BepInEx extracted to ${resolve(dir)}`);
}
