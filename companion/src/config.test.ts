import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigStore, type Config } from "./config.ts";

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
