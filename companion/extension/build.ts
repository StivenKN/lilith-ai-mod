// Builds the browser extension (Manifest V3) in memory: the service worker, the page script,
// the manifest with this version, and the icons. The code isn't minified, so anyone can read
// what runs in their browser.
//   bun extension/build.ts   → dist/browser-extension.txt, which build.ts embeds in the exe.
// The companion writes the files to its data folder (src/browser/install.ts); load that folder
// unpacked, also while developing (`--dev` rewrites it from source on every start).

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import pkg from "../package.json" with { type: "json" };

/** The public half of the key that pins the extension's ID (EXTENSION_ID in src/browser/shared.ts). */
export const MANIFEST_KEY = "MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAxw/pJEJW6OgBzBb6JNTTrKMG2T9OsFsZK9gZ18qpB9dLD4D5XSPetRhKUv8FZ7Zmle5OQyQsgTodujIPZovKTmNyecyABSA3wDlBtjmyg5oN9gcq2rGUzESrAk1kRLJnDcir9GdwZv8DqRTdSZNLgZPJuwAhYLoLbr/X0Z9HpboyAwtPTkTpaIPePGCiJk1MrShtiqDwh9+ao6/ZxYyiIAFbN6KwxXEbgjkXVsHaHSwyWRQdDJhJ89zZ4J5KmoBE7bVrURiRw2Gczwr9xzeJq1D6tQObu72uhZNtxB+L/Hdqkw+xRGuhfYUaW4gq0tVMk65MH/DAczqZv5KXTxYLQwIDAQAB";

const icons = Object.fromEntries([16, 32, 48, 128].map((size) => [size, `icons/${size}.png`]));

export const manifest = {
  manifest_version: 3,
  name: "Lilith AI Companion",
  description: "Lets Lilith use this browser when you ask her to. Works with Lilith AI Companion on this PC.",
  // Chrome wants up to four numbers; the full version is shown and compared as version_name.
  version: pkg.version.split("-")[0],
  version_name: pkg.version,
  key: MANIFEST_KEY,
  minimum_chrome_version: "121",
  background: { service_worker: "background.js", type: "module" },
  permissions: ["debugger", "scripting", "tabs", "tabGroups", "storage", "alarms"],
  host_permissions: ["<all_urls>"],
  action: { default_title: "Lilith", default_icon: icons },
  icons,
};

/** Every file of the extension, by its path inside the folder. */
export async function buildExtension(): Promise<Map<string, Uint8Array>> {
  const files = new Map<string, Uint8Array>();
  // The page script runs inside webpages, so it's one self-contained script.
  for (const [entry, format] of [["background.ts", "esm"], ["page.ts", "iife"]] as const) {
    const result = await Bun.build({ entrypoints: [join(import.meta.dir, entry)], root: join(import.meta.dir, ".."), target: "browser", format, minify: false });
    if (!result.success) throw new AggregateError(result.logs, `Could not build the extension's ${entry}`);
    files.set(entry.replace(/\.ts$/, ".js"), new Uint8Array(await result.outputs[0]!.arrayBuffer()));
  }
  files.set("manifest.json", new TextEncoder().encode(`${JSON.stringify(manifest, null, 2)}\n`));
  for (const path of Object.values(icons)) files.set(path, await Bun.file(join(import.meta.dir, path)).bytes());
  return files;
}

if (import.meta.main) {
  const files = await buildExtension();
  const dist = join(import.meta.dir, "..", "dist");
  await mkdir(dist, { recursive: true });
  await writeFile(join(dist, "browser-extension.txt"), JSON.stringify(Object.fromEntries([...files].map(([name, bytes]) => [name, Buffer.from(bytes).toString("base64")]))));
  console.log(`built the browser extension (${files.size} files) into dist/browser-extension.txt`);
}
