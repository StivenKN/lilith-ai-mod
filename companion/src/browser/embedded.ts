import { join } from "node:path";
import { z } from "zod";

/**
 * The extension's files, by path inside its folder. The exe carries them (build.ts embeds what
 * extension/build.ts wrote to dist/); running from source, they're built fresh, so a stale dist
 * never stands in for the code being worked on.
 */
export async function extensionFiles(): Promise<ReadonlyMap<string, Uint8Array>> {
  if (!Bun.isStandaloneExecutable) {
    // A path made at run time, so the bundler leaves the build tooling out of the exe.
    const builder = join(import.meta.dir, "..", "..", "extension", "build.ts");
    return ((await import(builder)) as typeof import("../../extension/build.ts")).buildExtension();
  }
  const { default: bundle } = await import("./embedded-bundle.ts");
  const files = z.record(z.string(), z.base64()).parse(JSON.parse(bundle));
  return new Map(Object.entries(files).map(([name, data]) => [name, Uint8Array.from(Buffer.from(data, "base64"))]));
}
