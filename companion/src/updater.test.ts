import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { removeUpdateLeftovers } from "./installer.ts";
import { Logger } from "./log.ts";
import { checksumLine, pickUpdate, Updater, zipName } from "./updater.ts";
import { zipTar } from "./zip.ts";

const temps: string[] = [];
afterEach(async () => Promise.all(temps.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))));

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "lilith-updater-"));
  temps.push(dir);
  return dir;
}

const sha = (char: string) => char.repeat(64);
const release = (version: string, options: { prerelease?: boolean; draft?: boolean; sha256?: string | null } = {}) => ({
  tag_name: `v${version}`,
  draft: options.draft ?? false,
  prerelease: options.prerelease ?? version.includes("-"),
  html_url: `https://github.com/StivenKN/lilith-ai-mod/releases/tag/v${version}`,
  body: options.sha256 === null ? "notes" : `notes\n\n${checksumLine(version, options.sha256 ?? sha("a"))}\n`,
  assets: [{ name: zipName(version), browser_download_url: `https://example.test/${zipName(version)}` }],
});

describe("pickUpdate", () => {
  test("betas take the newest beta or stable; stable installs ignore betas", () => {
    const releases = [release("0.2.0-beta.1"), release("0.1.0"), release("0.1.0-beta.10"), release("0.3.0", { draft: true })];
    expect(pickUpdate(releases, "0.1.0-beta.2")?.version).toBe("0.2.0-beta.1");
    expect(pickUpdate(releases, "0.1.0")).toBeNull();
    expect(pickUpdate([...releases, release("0.1.1")], "0.1.0")?.version).toBe("0.1.1");
  });

  test("skips releases it couldn't verify", () => {
    expect(pickUpdate([release("0.2.0", { sha256: null }), { tag_name: "v9.0.0" }], "0.1.0")).toBeNull();
  });
});

describe("Updater.install", () => {
  /** An installed mod folder plus a real release zip served by a fake GitHub. */
  async function setup(tamper = false) {
    const root = await tempDir();
    const modDir = join(root, "game", "BepInEx", "plugins", "LilithAICompanion");
    await mkdir(modDir, { recursive: true });
    await writeFile(join(modDir, "LilithAICompanion.dll"), "old dll");
    await writeFile(join(modDir, "LilithAICompanion.exe"), "old exe");
    await writeFile(join(modDir, "install-manifest.json"), JSON.stringify({ version: "0.1.0", installedAt: "", files: [], bepinexFiles: [] }));

    const build = join(root, "build");
    const folder = join(build, "LilithAICompanion-0.2.0");
    await mkdir(join(folder, "payload", "plugin"), { recursive: true });
    await writeFile(join(folder, "LilithAICompanion.exe"), "new exe");
    await writeFile(join(folder, "payload", "plugin", "LilithAICompanion.dll"), "new dll");
    const zip = join(build, zipName("0.2.0"));
    expect(await Bun.spawn([zipTar, "--format=zip", "-c", "-f", zip, "-C", build, "LilithAICompanion-0.2.0"]).exited).toBe(0);
    const bytes = await Bun.file(zip).bytes();
    const digest = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");

    const updater = new Updater({
      version: "0.1.0",
      modDir,
      downloadDir: join(root, "updates"),
      autoInstall: () => true,
      log: new Logger(join(root, "log.txt")).scope("update"),
      fetch: async (url) =>
        url.endsWith(".zip")
          ? new Response(tamper ? new Uint8Array([...bytes, 0]) : bytes)
          : Response.json([release("0.2.0", { sha256: digest })]),
    });
    return { modDir, updater, read: (name: string) => readFile(join(modDir, name), "utf8") };
  }

  test("swaps the plugin and companion in place and records the new version", async () => {
    const { modDir, updater, read } = await setup();
    await updater.check();
    expect(updater.status).toMatchObject({ state: "installed", version: "0.2.0" });
    expect(await read("LilithAICompanion.dll")).toBe("new dll");
    expect(await read("LilithAICompanion.exe")).toBe("new exe");
    expect(JSON.parse(await read("install-manifest.json")).version).toBe("0.2.0");
    // The old files are moved aside (a running game still holds them) and cleaned up on the next start.
    expect((await readdir(modDir)).filter((name) => name.endsWith(".old"))).toHaveLength(2);
    await removeUpdateLeftovers(modDir);
    expect((await readdir(modDir)).filter((name) => name.endsWith(".old"))).toHaveLength(0);
  });

  test("refuses a download that doesn't match the published checksum", async () => {
    const { updater, read } = await setup(true);
    await updater.check();
    expect(updater.status).toMatchObject({ state: "failed", version: "0.2.0" });
    expect(await read("LilithAICompanion.dll")).toBe("old dll");
    expect(await read("LilithAICompanion.exe")).toBe("old exe");
  });
});
