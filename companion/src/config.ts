// User settings: one Zod schema is the source of truth for defaults, validation and types.
// Stored as %APPDATA%\LilithAICompanion\config.json and written atomically.

import { z } from "zod";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { languageCodes } from "./languages.ts";
import { presetIds, presets, type PresetId } from "./providers/presets.ts";

export const HotkeySchema = z.object({
  key: z.string().regex(/^(F([1-9]|1[0-9]|2[0-4])|[A-Z0-9])$/),
  ctrl: z.boolean().default(false),
  alt: z.boolean().default(false),
  shift: z.boolean().default(false),
});
export type Hotkey = z.infer<typeof HotkeySchema>;

export const ConfigSchema = z.object({
  version: z.literal(1).default(1),
  provider: z
    .object({
      preset: z.enum(presetIds).default("ollama"),
      baseUrl: z.string().default(presets.ollama.baseUrl),
      model: z.string().default(presets.ollama.defaultModel),
      /** False until the user finishes provider setup once. */
      configured: z.boolean().default(false),
    })
    .prefault({}),
  /** Keys are kept per provider so switching back and forth doesn't lose them. */
  apiKeys: z.partialRecord(z.enum(presetIds), z.string()).default({}),
  /** "auto" follows the game's language setting. */
  replyLanguage: z.union([z.literal("auto"), z.enum(languageCodes)]).default("auto"),
  uiLanguage: z.enum(["auto", "es", "en"]).default("auto"),
  hotkey: HotkeySchema.prefault({ key: "F7" }),
  persona: z
    .object({
      /** null = built-in persona for the reply language. */
      custom: z.string().nullable().default(null),
    })
    .prefault({}),
  features: z
    .object({
      speakFirst: z.boolean().default(false),
      speakFirstMinutes: z.number().int().min(5).max(240).default(30),
      learnFacts: z.boolean().default(true),
      /** Install new releases from GitHub on their own (they take effect on the next game launch). */
      autoUpdate: z.boolean().default(true),
    })
    .prefault({}),
  advanced: z
    .object({
      /** null = automatic (60 s cloud, 180 s first local load then 60 s). */
      timeoutSeconds: z.number().int().min(10).max(600).nullable().default(null),
      temperature: z.number().min(0).max(2).default(0.8),
      maxReplyChars: z.number().int().min(60).max(600).default(240),
      bubbleLineUnits: z.number().int().min(12).max(80).default(32),
      bubbleLines: z.number().int().min(1).max(8).default(3),
    })
    .prefault({}),
});

export type Config = z.infer<typeof ConfigSchema>;
/** A partial settings update: top-level keys, and one level of nested keys, are optional. */
export type SettingsPatch = { [K in keyof Config]?: Config[K] extends Record<string, unknown> ? Partial<Config[K]> : Config[K] };

export const defaultConfig = (): Config => ConfigSchema.parse({});

export function apiKeyFor(config: Config, preset: PresetId = config.provider.preset): string {
  return config.apiKeys[preset]?.trim() ?? "";
}

/** Masks a secret for display: keeps the last 4 characters. */
export const maskSecret = (value: string): string => (value.length <= 4 ? "••••" : `••••${value.slice(-4)}`);

/** Config as shown in the dashboard and diagnostic reports: keys masked, never sent in full. */
export function publicConfig(config: Config) {
  const apiKeys = Object.fromEntries(Object.entries(config.apiKeys).map(([id, key]) => [id, key ? maskSecret(key) : ""]));
  return { ...config, apiKeys };
}

export class ConfigStore {
  #config: Config;
  #listeners = new Set<(config: Config) => void>();

  private constructor(
    readonly path: string,
    config: Config,
  ) {
    this.#config = config;
  }

  /** Loads the file, falling back to defaults (and keeping a backup) if it's missing or invalid. */
  static async load(path: string, onWarning: (message: string) => void = () => {}): Promise<ConfigStore> {
    const text = await readTextFile(path);
    if (text === null) return new ConfigStore(path, defaultConfig());
    try {
      const parsed = ConfigSchema.safeParse(JSON.parse(text));
      if (parsed.success) return new ConfigStore(path, parsed.data);
      onWarning(`config.json is invalid (${z.prettifyError(parsed.error)}); using defaults and keeping a backup`);
    } catch (error) {
      onWarning(`config.json could not be read (${String(error)}); using defaults and keeping a backup`);
    }
    await rename(path, `${path}.broken-${Date.now()}`).catch(() => {});
    return new ConfigStore(path, defaultConfig());
  }

  get current(): Config {
    return this.#config;
  }

  /** Applies a deep-ish patch (one level of nesting), validates, saves, and notifies listeners. */
  async update(patch: SettingsPatch): Promise<Config> {
    const merged: Record<string, unknown> = { ...this.#config };
    for (const [key, value] of Object.entries(patch)) {
      const previous = merged[key];
      merged[key] =
        isPlainObject(value) && isPlainObject(previous) ? { ...previous, ...value } : value;
    }
    const next = ConfigSchema.parse(merged);
    await writeAtomic(this.path, `${JSON.stringify(next, null, 2)}\n`);
    this.#config = next;
    for (const listener of this.#listeners) listener(next);
    return next;
  }

  onChange(listener: (config: Config) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }
}

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * File contents, or null if the file doesn't exist. Uses node:fs on purpose: in the compiled
 * Windows build, reading a missing file through Bun.file() never settled, and the process quietly
 * exited on first run.
 */
export async function readTextFile(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as { code?: string }).code === "ENOENT") return null;
    throw error;
  }
}

/** Write to a temp file then rename, so a crash never leaves a half-written file. */
export async function writeAtomic(path: string, contents: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.tmp`;
  await writeFile(temp, contents, "utf8");
  await rename(temp, path);
}
