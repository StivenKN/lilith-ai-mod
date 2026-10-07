// Assembles the player-facing release zip, plus the notes used for the GitHub release:
//
//   LilithAICompanion-<version>/
//     LilithAICompanion.exe        setup wizard + the AI companion (double-click to install)
//     LEEME - README.txt · LICENSE.txt · THIRD-PARTY-NOTICES.md
//     payload/
//       bepinex/                   BepInEx 6 IL2CPP (pinned build, checksum-verified)
//       unity-libs/2021.3.45.zip   so the first launch doesn't depend on unity.bepinex.dev
//       BepInEx.cfg                console window off
//       plugin/LilithAICompanion.dll
//       VERSION
//   RELEASE-NOTES.md
//
//   bun scripts/release.ts --plugin <path to LilithAICompanion.dll> [--exe dist/LilithAICompanion.exe]
//
// CI builds the plugin without the game (see .github/workflows/release.yml and docs/BUILDING.md).

import { createHash } from "node:crypto";
import { cp, mkdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import pkg from "../package.json" with { type: "json" };
import { extractBepInEx, fetchPinned, run, UNITY_LIBS } from "./pinned.ts";

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

const version = pkg.version;
const name = `LilithAICompanion-${version}`;
const releaseDir = resolve("dist", "release");
const root = join(releaseDir, name);
const payload = join(root, "payload");
await rm(root, { recursive: true, force: true });
await mkdir(join(payload, "unity-libs"), { recursive: true });
await mkdir(join(payload, "plugin"), { recursive: true });

await extractBepInEx(join(payload, "bepinex"));
await cp(await fetchPinned(UNITY_LIBS), join(payload, "unity-libs", "2021.3.45.zip"));
await cp(resolve("..", "packaging", "BepInEx.cfg"), join(payload, "BepInEx.cfg"));
await cp(values.plugin, join(payload, "plugin", "LilithAICompanion.dll"));
await writeFile(join(payload, "VERSION"), `${version}\n`);
await cp(values.exe, join(root, "LilithAICompanion.exe"));
await cp(resolve("..", "THIRD-PARTY-NOTICES.md"), join(root, "THIRD-PARTY-NOTICES.md"));
await cp(resolve("..", "LICENSE"), join(root, "LICENSE.txt"));
await writeFile(
  join(root, "LEEME - README.txt"),
  [
    `Lilith AI Companion ${version}`,
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

const zip = join(releaseDir, `${name}.zip`);
await rm(zip, { force: true });
await run(["tar", "-a", "-c", "-f", zip, "-C", releaseDir, name]);
const zipHash = createHash("sha256").update(await Bun.file(zip).bytes()).digest("hex");

const beta = version.includes("-");
await writeFile(
  join(releaseDir, "RELEASE-NOTES.md"),
  [
    ...(beta
      ? [
          "> **Beta.** Everything outside the game is tested automatically; the in-game part is new. If something doesn't work, open an issue with the diagnostic report (dashboard → Help).",
          "> **Beta.** Todo lo que corre fuera del juego tiene pruebas automáticas; la parte dentro del juego es nueva. Si algo no funciona, abre un issue con el informe de diagnóstico (panel → Ayuda).",
          "",
        ]
      : []),
    "## Instalar (ES)",
    "",
    `1. Descarga **${name}.zip** (abajo, en *Assets*) y extráelo en una carpeta.`,
    "2. Con el juego cerrado, abre **LilithAICompanion.exe**. Si Windows muestra «Windows protegió tu PC», pulsa *Más información* → *Ejecutar de todas formas*.",
    "3. Sigue los pasos en tu navegador: instala el mod y elige la IA (Ollama gratis en tu PC, o un servicio en línea).",
    "4. Abre el juego desde Steam (el primer inicio tarda 1 a 3 minutos) y pulsa **F7** para hablar con Lilith.",
    "",
    "## Install (EN)",
    "",
    `1. Download **${name}.zip** (below, under *Assets*) and extract it.`,
    '2. With the game closed, open **LilithAICompanion.exe**. If Windows shows "Windows protected your PC", click *More info* → *Run anyway*.',
    "3. Follow the steps in your browser: install the mod and choose the AI (free Ollama on your PC, or an online service).",
    "4. Start the game from Steam (the first launch takes 1–3 minutes) and press **F7** to talk to Lilith.",
    "",
    `SHA-256 \`${name}.zip\`: \`${zipHash}\``,
    "",
  ].join("\n"),
);
console.log(`\nrelease: ${zip}\nsha256:  ${zipHash}\nnotes:   ${join(releaseDir, "RELEASE-NOTES.md")}`);
