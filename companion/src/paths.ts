import { homedir } from "node:os";
import { join } from "node:path";

export const APP_ID = "LilithAICompanion";

/** Where config, memory, keepsakes and logs live. `LILITH_AI_DATA_DIR` overrides it (tests, sim). */
export function dataDir(): string {
  const override = process.env.LILITH_AI_DATA_DIR;
  if (override) return override;
  if (process.platform === "win32") return join(process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"), APP_ID);
  if (process.platform === "darwin") return join(homedir(), "Library", "Application Support", APP_ID);
  return join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), APP_ID);
}

export const dataPaths = (root = dataDir()) => ({
  root,
  config: join(root, "config.json"),
  memory: join(root, "memory.json"),
  /** Notes and pictures the player shared for her cards, and the cards she wrote. */
  keepsakes: join(root, "keepsakes.json"),
  pictures: join(root, "keepsakes"),
  logs: join(root, "logs"),
  logFile: join(root, "logs", "lilith-ai.log"),
  /** Voice engines, voices, speech models and the audio cache (see voice/index.ts). */
  voice: join(root, "voice"),
  /** Written by the running instance so a second launch can hand off to it. */
  instance: join(root, "instance.json"),
});

export type DataPaths = ReturnType<typeof dataPaths>;
