// User settings: one Zod schema is the source of truth for defaults, validation and types.
// Stored as %APPDATA%\LilithAICompanion\config.json and written atomically. The file is watched,
// so a change saved by another running copy (the setup exe and the game's copy can both be open)
// or by hand applies live, without restarting anything.

import { z } from "zod";
import { watch, type FSWatcher } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { basename, dirname } from "node:path";
import { languageCodes } from "./languages.ts";
import type { Log } from "./log.ts";
import { UNLOAD_AFTER_MINUTES } from "./providers/ollama.ts";
import { presetIds, presets, type PresetId } from "./providers/presets.ts";
import { searchModes } from "./search.ts";
import { defaultVoice, sttModelIds, voiceIdsFor } from "./voice/catalog.ts";

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
      /** Now and then, write a card for the game's inbox from what the player shared (at most one a day). */
      cards: z.boolean().default(true),
      /** Install new releases from GitHub on their own (they take effect on the next game launch). */
      autoUpdate: z.boolean().default(true),
      /** Automatic enables control for AI servers on this PC or LAN. */
      computerControl: z.enum(["auto", "on", "off"]).default("auto"),
    })
    .prefault({}),
  /** Web search Lilith can use for current information. Off until the player picks a backend. */
  search: z
    .object({
      mode: z.enum(searchModes).default("off"),
      /** Firecrawl API key (only used in "firecrawl" mode). */
      apiKey: z.string().default(""),
    })
    .prefault({}),
  voice: z
    .object({
      /** She reads her replies aloud in game. */
      speak: z.boolean().default(false),
      /** The player can talk to her: the voice hotkey (or the mic button) starts and stops recording. */
      listen: z.boolean().default(false),
      /** "auto" speaks her reply language when it's Spanish or English; a fixed one also makes her reply in it. */
      language: z.enum(["auto", "es", "en"]).default("auto"),
      esVoice: z.enum(voiceIdsFor("es")).default(defaultVoice.es),
      enVoice: z.enum(voiceIdsFor("en")).default(defaultVoice.en),
      speed: z.number().min(0.6).max(1.6).default(1),
      volume: z.number().int().min(0).max(100).default(85),
      hotkey: HotkeySchema.prefault({ key: "F8" }),
      sttModel: z.enum(sttModelIds).default("small"),
    })
    .prefault({}),
  advanced: z
    .object({
      /** null = automatic (60 s cloud, 180 s while a local model loads, else 60 s). */
      timeoutSeconds: z.number().int().min(10).max(600).nullable().default(null),
      /** Ollama frees the model's memory after this long without a request; opening the chat loads it again. */
      unloadAfterMinutes: z.number().int().min(1).max(240).default(UNLOAD_AFTER_MINUTES),
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
  return { ...config, apiKeys, search: { ...config.search, apiKey: config.search.apiKey ? maskSecret(config.search.apiKey) : "" } };
}

export class ConfigStore {
  #config: Config;
  /** What's on disk as of our last read or write, to tell our own saves from someone else's. */
  #savedText: string | null = null;
  #listeners = new Set<(config: Config) => void>();
  #lastSaveSettled: Promise<void> = Promise.resolve();
  #watcher: FSWatcher | null = null;
  #reloadTimer: ReturnType<typeof setTimeout> | null = null;

  private constructor(
    readonly path: string,
    config: Config,
    savedText: string | null = null,
  ) {
    this.#config = config;
    this.#savedText = savedText;
  }

  /** Loads the file, falling back to defaults (and keeping a backup) if it's missing or invalid. */
  static async load(path: string, onWarning: (message: string) => void = () => {}): Promise<ConfigStore> {
    const text = await readTextFile(path);
    if (text === null) return new ConfigStore(path, defaultConfig());
    try {
      const parsed = ConfigSchema.safeParse(JSON.parse(text));
      if (parsed.success) return new ConfigStore(path, parsed.data, text);
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

  /**
   * Applies a deep-ish patch (one level of nesting), validates, saves, and notifies listeners.
   * Saves run one at a time in call order, so each merges into the result of the one before.
   */
  update(patch: SettingsPatch): Promise<Config> {
    const saved = this.#lastSaveSettled.then(() => this.#save(patch));
    this.#lastSaveSettled = saved.then(() => {}, () => {});
    return saved;
  }

  async #save(patch: SettingsPatch): Promise<Config> {
    const merged: Record<string, unknown> = { ...this.#config };
    for (const [key, value] of Object.entries(patch)) {
      const previous = merged[key];
      merged[key] =
        isPlainObject(value) && isPlainObject(previous) ? { ...previous, ...value } : value;
    }
    const next = ConfigSchema.parse(merged);
    const text = `${JSON.stringify(next, null, 2)}\n`;
    this.#savedText = text;
    await writeAtomic(this.path, text);
    this.#apply(next);
    return next;
  }

  /**
   * Reloads the file when something else changes it. Invalid contents (say, a half-finished hand
   * edit) are reported and ignored until fixed. Watches the folder, not the file: atomic saves
   * replace the file, which would end a watch on the file itself.
   */
  async watch(log: Pick<Log, "info" | "warn">): Promise<void> {
    if (this.#watcher) return;
    await mkdir(dirname(this.path), { recursive: true });
    const name = basename(this.path);
    this.#watcher = watch(dirname(this.path), (_event, file) => {
      if (file !== null && file !== name) return;
      // Editors and atomic renames fire several events per save; settle first.
      if (this.#reloadTimer) clearTimeout(this.#reloadTimer);
      this.#reloadTimer = setTimeout(() => void this.#reload(log), 150);
    });
    this.#watcher.on("error", (error) => log.warn(`stopped watching config.json: ${String(error)}`));
  }

  close(): void {
    if (this.#reloadTimer) clearTimeout(this.#reloadTimer);
    this.#watcher?.close();
    this.#watcher = null;
  }

  async #reload(log: Pick<Log, "info" | "warn">): Promise<void> {
    const text = await readTextFile(this.path).catch(() => null);
    if (text === null || text === this.#savedText) return;
    this.#savedText = text;
    try {
      const parsed = ConfigSchema.safeParse(JSON.parse(text));
      if (!parsed.success) return log.warn(`config.json changed but is invalid (${z.prettifyError(parsed.error)}); keeping the current settings`);
      log.info("config.json changed on disk; settings applied");
      this.#apply(parsed.data);
    } catch (error) {
      log.warn(`config.json changed but could not be read (${String(error)}); keeping the current settings`);
    }
  }

  #apply(next: Config): void {
    this.#config = next;
    for (const listener of this.#listeners) listener(next);
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

let nextTempId = 0;

/** Write to a temp file then rename, so a crash never leaves a half-written file. */
export async function writeAtomic(path: string, contents: string | Uint8Array): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.${nextTempId++}.tmp`;
  await writeFile(temp, contents, "utf8");
  await rename(temp, path);
}
