import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigStore, writeAtomic, type Config } from "./config.ts";

const log = { info: () => {}, warn: () => {} };
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const step of cleanup.splice(0)) await step();
});

async function twoStores() {
  const dir = await mkdtemp(join(tmpdir(), "lac-config-"));
  const path = join(dir, "config.json");
  const [setup, game] = [await ConfigStore.load(path), await ConfigStore.load(path)];
  await game.watch(log);
  cleanup.push(async () => {
    game.close();
    await rm(dir, { recursive: true, force: true });
  });
  return { path, setup, game };
}

const nextChange = (store: ConfigStore) =>
  new Promise<Config>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("no change seen")), 3000);
    const stop = store.onChange((config) => {
      clearTimeout(timer);
      stop();
      resolve(config);
    });
  });

async function tempPath(name: string) {
  const dir = await mkdtemp(join(tmpdir(), "lac-config-"));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  return join(dir, name);
}

test("overlapping saves both land, in order, in memory and on disk", async () => {
  const path = await tempPath("config.json");
  const store = await ConfigStore.load(path);
  const seen: Config[] = [];
  store.onChange((config) => seen.push(config));
  const saves = await Promise.allSettled([
    store.update({ apiKeys: { openai: "sk-aaaaaaaaaaaaaaaa" } }),
    store.update({ search: { mode: "firecrawl", apiKey: "fc-bbbbbbbbbbbb" } }),
  ]);
  expect(saves.map((save) => save.status)).toEqual(["fulfilled", "fulfilled"]);
  expect(store.current.apiKeys.openai).toBe("sk-aaaaaaaaaaaaaaaa");
  expect(store.current.search).toEqual({ mode: "firecrawl", apiKey: "fc-bbbbbbbbbbbb" });
  expect(seen.map((config) => [config.apiKeys.openai, config.search.mode])).toEqual([
    ["sk-aaaaaaaaaaaaaaaa", "off"],
    ["sk-aaaaaaaaaaaaaaaa", "firecrawl"],
  ]);
  expect(JSON.parse(await readFile(path, "utf8"))).toEqual(store.current);
});

test("a rejected save doesn't hold up the saves after it", async () => {
  const store = await ConfigStore.load(await tempPath("config.json"));
  const seen: Config[] = [];
  store.onChange((config) => seen.push(config));
  const [invalid, valid] = await Promise.allSettled([
    store.update({ advanced: { temperature: 5 } }),
    store.update({ hotkey: { key: "F9" } }),
  ]);
  expect([invalid.status, valid.status]).toEqual(["rejected", "fulfilled"]);
  expect(seen.map((config) => config.hotkey.key)).toEqual(["F9"]);
});

test("concurrent atomic writes to one file all succeed and one lands whole", async () => {
  const path = await tempPath("memory.json");
  const contents = Array.from({ length: 32 }, (_, i) => `{ "save": ${i}, "pad": "${"x".repeat(i * 40)}" }\n`);
  await Promise.all(contents.map((text) => writeAtomic(path, text)));
  expect(contents).toContain(await readFile(path, "utf8"));
});

test("a save from another running copy applies live", async () => {
  const { setup, game } = await twoStores();
  const changed = nextChange(game);
  await setup.update({ hotkey: { key: "F8" }, features: { speakFirst: true } });
  expect((await changed).hotkey.key).toBe("F8");
  expect(game.current.features.speakFirst).toBe(true);
});

test("an invalid hand edit is ignored, then the fix applies", async () => {
  const { path, game } = await twoStores();
  await writeFile(path, "{ not json");
  await Bun.sleep(400);
  expect(game.current.hotkey.key).toBe("F7");
  const changed = nextChange(game);
  await writeFile(path, JSON.stringify({ advanced: { temperature: 0.3 } }));
  expect((await changed).advanced.temperature).toBe(0.3);
});
