// Assembles the player-facing release zip:
//
//   LilithAICompanion-<version>/
//     LilithAICompanion.exe        setup wizard + the AI companion (double-click to install)
//     LEEME - README.txt
//     payload/
//       bepinex/                   BepInEx 6 IL2CPP (pinned build, checksum-verified)
//       unity-libs/2021.3.45.zip   so the first launch doesn't depend on unity.bepinex.dev
//       BepInEx.cfg                console window off
//       plugin/LilithAICompanion.dll
//       VERSION
//
//   bun scripts/release.ts --plugin <path to LilithAICompanion.dll> [--exe dist/LilithAICompanion.exe]
//
// The plugin DLL must be built on a PC with the game installed (see docs/BUILDING.md).

import { createHash } from "node:crypto";
import { cp, mkdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import pkg from "../package.json" with { type: "json" };

const BEPINEX = {
  url: "https://builds.bepinex.dev/projects/bepinex_be/780/BepInEx-Unity.IL2CPP-win-x64-6.0.0-be.780%2B3be4532.zip",
  sha256: "504303897b5df2256f676428dfa0981cde2440b7937efcd282bf1bc426a6e223",
};
const UNITY_LIBS = {
  url: "https://unity.bepinex.dev/libraries/2021.3.45.zip",
  sha256: "3cfde1613715c966cb8084087c37081ed5896871b39194d45a907a69dd7da9e5",
};

const { values } = parseArgs({
  options: { plugin: { type: "string" }, exe: { type: "string", default: "dist/LilithAICompanion.exe" } },
});
if (!values.plugin) {
  console.error("usage: bun scripts/release.ts --plugin <LilithAICompanion.dll> [--exe dist/LilithAICompanion.exe]");
  process.exit(2);
}
for (const path of [values.plugin, values.exe]) {
  if (!(await Bun.file(path).exists())) {
    console.error(`missing ${path}`);
    process.exit(1);
  }
}

/** Downloads once into dist/cache and refuses anything whose checksum doesn't match. */
async function fetchPinned(source: { url: string; sha256: string }, name: string): Promise<string> {
  const path = resolve("dist", "cache", name);
  if (!(await Bun.file(path).exists())) {
    console.log(`downloading ${source.url}`);
    const response = await fetch(source.url);
    if (!response.ok) throw new Error(`download failed (${response.status}): ${source.url}`);
    await Bun.write(path, response);
  }
  const hash = createHash("sha256").update(await Bun.file(path).bytes()).digest("hex");
  if (hash !== source.sha256) {
    await rm(path);
    throw new Error(`checksum mismatch for ${name}: expected ${source.sha256}, got ${hash}`);
  }
  return path;
}

async function run(command: string[]): Promise<void> {
  const child = Bun.spawn(command, { stdout: "inherit", stderr: "inherit" });
  if ((await child.exited) !== 0) throw new Error(`failed: ${command.join(" ")}`);
}

const name = `LilithAICompanion-${pkg.version}`;
const root = resolve("dist", "release", name);
const payload = join(root, "payload");
await rm(root, { recursive: true, force: true });
await mkdir(join(payload, "bepinex"), { recursive: true });
await mkdir(join(payload, "unity-libs"), { recursive: true });
await mkdir(join(payload, "plugin"), { recursive: true });

// bsdtar (macOS, Windows 10+) reads and writes zip files.
await run(["tar", "-xf", await fetchPinned(BEPINEX, "bepinex-be.780.zip"), "-C", join(payload, "bepinex")]);
await cp(await fetchPinned(UNITY_LIBS, "unity-libs-2021.3.45.zip"), join(payload, "unity-libs", "2021.3.45.zip"));
await cp(resolve("..", "packaging", "BepInEx.cfg"), join(payload, "BepInEx.cfg"));
await cp(values.plugin, join(payload, "plugin", "LilithAICompanion.dll"));
await writeFile(join(payload, "VERSION"), `${pkg.version}\n`);
await cp(values.exe, join(root, "LilithAICompanion.exe"));
await cp(resolve("..", "THIRD-PARTY-NOTICES.md"), join(root, "THIRD-PARTY-NOTICES.md"));
await cp(resolve("..", "LICENSE"), join(root, "LICENSE.txt"));
await writeFile(
  join(root, "LEEME - README.txt"),
  [
    `Lilith AI Companion ${pkg.version}`,
    "",
    "ES  1. Cierra el juego.",
    "    2. Abre LilithAICompanion.exe (desde esta carpeta, no desde dentro del .zip).",
    "    3. Sigue los pasos en tu navegador: instala el mod y elige la IA.",
    "    Si Windows muestra «Windows protegió tu PC», pulsa «Más información» y luego «Ejecutar de todas formas».",
    "",
    "EN  1. Close the game.",
    "    2. Open LilithAICompanion.exe (from this folder, not from inside the .zip).",
    "    3. Follow the steps in your browser: install the mod and choose the AI.",
    '    If Windows shows "Windows protected your PC", click "More info", then "Run anyway".',
    "",
  ].join("\r\n"),
);

const zip = resolve("dist", "release", `${name}.zip`);
await rm(zip, { force: true });
await run(["tar", "-a", "-c", "-f", zip, "-C", resolve("dist", "release"), name]);
const zipHash = createHash("sha256").update(await Bun.file(zip).bytes()).digest("hex");
console.log(`\nrelease: ${zip}\nsha256:  ${zipHash}`);
