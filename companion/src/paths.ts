import { homedir } from "node:os";
import { join } from "node:path";

export const APP_ID = "LilithAICompanion";

/** Where config, memory and logs live. `LILITH_AI_DATA_DIR` overrides it (tests, sim). */
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
  logs: join(root, "logs"),
  logFile: join(root, "logs", "lilith-ai.log"),
  /** Written by the running instance so a second launch can hand off to it. */
  instance: join(root, "instance.json"),
});

export type DataPaths = ReturnType<typeof dataPaths>;
