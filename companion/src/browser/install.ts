// The unpacked extension the player loads once (chrome://extensions → Load unpacked). It lives in
// the per-user data folder, next to this user's pairing secret, and a newer companion rewrites it
// on start; the extension then reloads itself from it when hub.ts tells it to.

import { join } from "node:path";
import { z } from "zod";
import { readTextFile, writeAtomic } from "../config.ts";
import type { Log } from "../log.ts";
import { randomHex } from "./shared.ts";

const Pairing = z.object({ secret: z.string().regex(/^[0-9a-f]{64}$/) });
const Companions = z.object({ ports: z.array(z.number().int()) });

/**
 * Writes the extension when it's missing or older than `version` (or always, with `force`, for
 * development), never downgrading one a newer companion wrote. VERSION goes last, so a half
 * written folder is rewritten next time. The pairing secret is made once and then kept, so an
 * update never unpairs the browser.
 */
export async function installExtension(
  dir: string,
  version: string,
  files: () => Promise<ReadonlyMap<string, Uint8Array>>,
  log: Log,
  force = false,
): Promise<{ secret: string }> {
  const installed = (await readTextFile(join(dir, "VERSION")))?.trim();
  if (force || !installed || Bun.semver.order(installed, version) < 0) {
    for (const [name, bytes] of await files()) await writeAtomic(join(dir, name), bytes);
    await writeAtomic(join(dir, "VERSION"), `${version}\n`);
    log.info(`browser extension ${version} written to ${dir}${installed ? ` (was ${installed})` : ""}`);
  }
  // The extension reads this to find companions; it must exist even before one has run.
  if (!(await Bun.file(join(dir, "companions.json")).exists())) await writeAtomic(join(dir, "companions.json"), `${JSON.stringify({ ports: [] })}\n`);
  // Missing or unreadable: a new secret, and the browser pairs again on its next connection.
  const pairing = Pairing.safeParse(await Bun.file(join(dir, "pairing.json")).json().catch(() => null));
  if (pairing.success) return pairing.data;
  const created = { secret: randomHex(32) };
  await writeAtomic(join(dir, "pairing.json"), `${JSON.stringify(created)}\n`);
  return created;
}

/**
 * Lists (or, `leaving`, unlists) this companion's port in companions.json, which the extension
 * reads to find companions. Knocking on closed ports instead would put an error on
 * chrome://extensions for every one of them, every 30 seconds. Ports where no companion answers
 * any more are dropped (one that crashed, or whatever took its port since); repeating this now and
 * then mends an entry lost to two companions writing at once.
 */
export async function listCompanion(dir: string, port: number, companionAt: (port: number) => Promise<boolean>, leaving = false): Promise<void> {
  const path = join(dir, "companions.json");
  const listed = Companions.safeParse(await Bun.file(path).json().catch(() => null));
  const others = listed.success ? listed.data.ports.filter((each) => each !== port) : [];
  const alive = (await Promise.all(others.map(async (each) => (await companionAt(each)) ? [each] : []))).flat();
  await writeAtomic(path, `${JSON.stringify({ ports: leaving ? alive : [...alive, port].toSorted() })}\n`);
}
