// Keeps the mod up to date from GitHub Releases. The copy the game launches (bridge mode) checks
// for a newer release, downloads its zip, verifies the SHA-256 published in the release notes,
// and swaps the plugin DLL and companion exe in place for the next game launch. Elsewhere (the
// downloaded setup exe) it only reports that a newer version exists.

import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { COMPANION_EXE, PLUGIN_DLL, removeUpdateLeftovers, replaceModFiles } from "./installer.ts";
import { errorMessage, type Log } from "./log.ts";
import { zipTar } from "./zip.ts";

export const RELEASES_API = "https://api.github.com/repos/StivenKN/lilith-ai-mod/releases";
const FIRST_CHECK_MS = 60_000;
const CHECK_EVERY_MS = 6 * 60 * 60_000;

export const zipName = (version: string) => `LilithAICompanion-${version}.zip`;
/** The checksum line in the release notes (written by scripts/release.ts, read by `findUpdate`). */
export const checksumLine = (version: string, sha256: string) => `SHA-256 \`${zipName(version)}\`: \`${sha256}\``;

const Release = z.object({
  tag_name: z.string(),
  draft: z.boolean(),
  prerelease: z.boolean(),
  html_url: z.string(),
  body: z.string().nullable(),
  assets: z.array(z.object({ name: z.string(), browser_download_url: z.string() })),
});

export interface Update {
  version: string;
  /** Release page, for a manual download. */
  url: string;
  zipUrl: string;
  sha256: string;
}

/**
 * The newest installable release newer than `current`, or null. Stable versions only move to stable
 * releases; betas also take newer betas. Releases without the zip or its checksum are skipped.
 */
export function pickUpdate(releases: unknown, current: string): Update | null {
  const parsed = z.array(z.unknown()).parse(releases).flatMap((item) => {
    const release = Release.safeParse(item);
    return release.success ? [release.data] : [];
  });
  const acceptBetas = current.includes("-");
  const candidates = parsed.flatMap((release): Update[] => {
    const version = release.tag_name.replace(/^v/, "");
    if (release.draft || (release.prerelease && !acceptBetas) || Bun.semver.order(version, current) <= 0) return [];
    const zip = release.assets.find((asset) => asset.name === zipName(version));
    const sha256 = new RegExp(`SHA-256 \`${RegExp.escape(zipName(version))}\`: \`([0-9a-f]{64})\``).exec(release.body ?? "")?.[1];
    return zip && sha256 ? [{ version, url: release.html_url, zipUrl: zip.browser_download_url, sha256 }] : [];
  });
  return candidates.sort((a, b) => Bun.semver.order(b.version, a.version))[0] ?? null;
}

type Found = Pick<Update, "version" | "url">;
export type UpdateStatus =
  | { state: "idle" }
  | (Found & { state: "available"; canInstall: boolean })
  | (Found & { state: "installing" })
  | (Found & { state: "installed" })
  | (Found & { state: "failed"; detail: string });

type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

export class Updater {
  #status: UpdateStatus = { state: "idle" };
  #update: Update | null = null;
  #timers: Array<ReturnType<typeof setTimeout>> = [];
  #listeners = new Set<() => void>();

  constructor(
    private readonly options: {
      version: string;
      /** Installed mod folder this exe runs from; null when it can't update itself (setup exe, dev). */
      modDir: string | null;
      /** Scratch space for downloads. */
      downloadDir: string;
      /** Read on each check, so the setting applies without a restart. */
      autoInstall: () => boolean;
      log: Log;
      fetch?: Fetch;
    },
  ) {}

  get status(): UpdateStatus {
    return this.#status;
  }

  onChange(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /** Checks shortly after start, then every few hours. */
  start(firstCheckMs = FIRST_CHECK_MS): void {
    if (this.options.modDir) void removeUpdateLeftovers(this.options.modDir);
    this.#timers.push(setTimeout(() => void this.check(), firstCheckMs));
    this.#timers.push(setInterval(() => void this.check(), CHECK_EVERY_MS));
  }

  stop(): void {
    for (const timer of this.#timers) clearTimeout(timer);
  }

  /** Looks for a newer release and installs it when allowed. Network errors are logged, not shown. */
  async check(): Promise<void> {
    if (this.#status.state === "installing" || this.#status.state === "installed") return;
    try {
      const response = await this.#fetch(`${RELEASES_API}?per_page=20`, { accept: "application/vnd.github+json" });
      if (!response.ok) throw new Error(`GitHub answered HTTP ${response.status}`);
      this.#update = pickUpdate(await response.json(), this.options.version);
    } catch (error) {
      this.options.log.warn(`update check failed: ${errorMessage(error)}`);
      return;
    }
    const update = this.#update;
    if (!update) return this.#set({ state: "idle" });
    this.options.log.info(`version ${update.version} is available`);
    this.#set({ state: "available", version: update.version, url: update.url, canInstall: this.options.modDir !== null });
    if (this.options.modDir && this.options.autoInstall()) await this.install();
  }

  /** Downloads, verifies and installs the update found by the last check. */
  async install(): Promise<void> {
    const update = this.#update;
    const modDir = this.options.modDir;
    if (!update || !modDir || this.#status.state === "installing" || this.#status.state === "installed") return;
    const { version, url } = update;
    this.#set({ state: "installing", version, url });
    const dir = join(this.options.downloadDir, version);
    try {
      await rm(dir, { recursive: true, force: true });
      await mkdir(dir, { recursive: true });
      const zip = join(dir, zipName(version));
      const response = await this.#fetch(update.zipUrl);
      if (!response.ok) throw new Error(`download failed: HTTP ${response.status}`);
      await Bun.write(zip, response);
      const sha256 = new Bun.CryptoHasher("sha256").update(await Bun.file(zip).bytes()).digest("hex");
      if (sha256 !== update.sha256) throw new Error(`checksum mismatch (expected ${update.sha256}, got ${sha256})`);

      // The zip holds one folder: LilithAICompanion-<version>/{LilithAICompanion.exe, payload/plugin/LilithAICompanion.dll, …}
      const root = `LilithAICompanion-${version}`;
      const members = [`${root}/${COMPANION_EXE}`, `${root}/payload/plugin/${PLUGIN_DLL}`];
      const tar = Bun.spawn([zipTar, "-x", "-f", zip, "-C", dir, ...members], { stdout: "ignore", stderr: "pipe", windowsHide: true });
      if ((await tar.exited) !== 0) throw new Error(`could not extract the update: ${(await new Response(tar.stderr).text()).trim()}`);

      await replaceModFiles({ modDir, companion: join(dir, members[0]!), plugin: join(dir, members[1]!), version });
      this.options.log.info(`updated to ${version}; it takes effect on the next game launch`);
      this.#set({ state: "installed", version, url });
    } catch (error) {
      this.options.log.error(`update to ${version} failed: ${errorMessage(error)}`);
      this.#set({ state: "failed", version, url, detail: errorMessage(error) });
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  }

  #fetch(url: string, headers: Record<string, string> = {}): Promise<Response> {
    headers = { "user-agent": `LilithAICompanion/${this.options.version}`, ...headers };
    return (this.options.fetch ?? fetch)(url, { headers, signal: AbortSignal.timeout(5 * 60_000) });
  }

  #set(status: UpdateStatus): void {
    this.#status = status;
    for (const listener of this.#listeners) listener();
  }
}
