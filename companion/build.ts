// Compiles the companion into a single executable.
//   bun build.ts              → dist/LilithAICompanion.exe (Windows x64; icon/metadata only when built on Windows)
//   bun build.ts --host       → dist/LilithAICompanion-<os> for a quick local smoke test
// The dashboard (HTML/CSS/TSX/fonts) is bundled into the binary through the HTML import, and the
// browser extension through dist/browser-extension.txt (extension/build.ts writes it first).

import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import pkg from "./package.json" with { type: "json" };

const host = process.argv.includes("--host");
const onWindows = process.platform === "win32";
const outfile = join("dist", host && !onWindows ? `LilithAICompanion-${process.platform}` : "LilithAICompanion.exe");

const args = [
  "build",
  "src/main.ts",
  "--compile",
  "--minify",
  "--bytecode",
  "--sourcemap=inline",
  // The exe runs with the game folder as working directory: never pick up stray .env/bunfig files there.
  "--no-compile-autoload-dotenv",
  "--no-compile-autoload-bunfig",
  `--outfile=${outfile}`,
];
if (!host) args.push("--target=bun-windows-x64");
if (onWindows && !host) {
  // These need Windows APIs, so they're only available when building on Windows (CI).
  args.push(
    "--windows-icon=../assets/icon.ico",
    "--windows-title=Lilith AI Companion",
    "--windows-publisher=Lilith AI Companion contributors",
    `--windows-version=${pkg.version.split("-")[0]}.0`, // Windows wants 4 numbers: "0.1.0-beta.1" → "0.1.0.0"
    "--windows-description=AI companion for The NOexistenceN of Lilith",
  );
}

await mkdir("dist", { recursive: true });
const extension = Bun.spawn([process.execPath, "extension/build.ts"], { stdout: "inherit", stderr: "inherit" });
if ((await extension.exited) !== 0) process.exit(1);
const build = Bun.spawn([process.execPath, ...args], { stdout: "inherit", stderr: "inherit" });
const code = await build.exited;
if (code !== 0) process.exit(code);
console.log(`built ${outfile}`);
