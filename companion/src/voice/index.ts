// Lilith's local voice: Piper turns her replies into speech, whisper.cpp turns the player's
// microphone into text. Both run as short-lived processes on this PC; nothing leaves it.
//
// Files live in <data dir>/voice (bin/, voices/, models/, cache/). Processes run with that folder
// as their working directory and get relative paths only: Windows user folders can contain
// characters the engines' ANSI argv can't represent ("C:\Users\Elcñor 小林\...").
// Runs are serialized: both engines want every CPU core for the second or two they take.

import { copyFile, mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { availableParallelism } from "node:os";
import { dirname, join } from "node:path";
import type { Language } from "../languages.ts";
import { errorMessage, type Log } from "../log.ts";
import { componentFor, engines, isComponentId, sttModelIds, sttModels, voiceIds, voices, type ComponentId, type Download, type SpokenLanguage, type SttModelId, type VoiceId } from "./catalog.ts";
import { applyGain, readWav } from "./wav.ts";

export type VoiceErrorKind = "not_installed" | "unsupported" | "no_speech" | "failed";

export class VoiceError extends Error {
  constructor(
    readonly kind: VoiceErrorKind,
    message: string,
  ) {
    super(message);
  }
}

export interface SpeakOptions {
  voice: VoiceId;
  /** 1 = the voice's natural pace. */
  speed: number;
  /** 0–100. */
  volume: number;
}

export interface Spoken {
  /** Absolute path, handed to the game plugin. */
  file: string;
  /** File name inside the cache, served to the dashboard. */
  name: string;
  seconds: number;
}

export interface InstallProgress {
  id: ComponentId;
  received: number;
  total: number;
}

/** What the brain and the dashboard need from the voice; tests substitute a fake. */
export interface VoiceService {
  speak(text: string, options: SpeakOptions): Promise<Spoken>;
  transcribe(file: string, options: { model: SttModelId; language: Language | null }): Promise<string>;
  isInstalled(id: ComponentId): Promise<boolean>;
}

const PROCESS_TIMEOUT_MS = 120_000;
const CACHE_MAX_AGE_MS = 10 * 60_000;
const CACHE_FILE = /^(say|in)-[a-z0-9]{8}\.wav$/;

/** Sample line for "test voice", in the voice's own language. */
export const sampleLine: Record<SpokenLanguage, string> = {
  es: "Hola. Soy Lilith. ¿Te gusta cómo sueno así?",
  en: "Hi, I'm Lilith. Do you like how I sound?",
};

export class Voice implements VoiceService {
  #queue: Promise<unknown> = Promise.resolve();

  constructor(
    readonly dir: string,
    private readonly log: Log,
    /** LILITH_AI_PIPER / LILITH_AI_WHISPER point at engines installed by hand (development off Windows). */
    private readonly env: Record<string, string | undefined> = process.env,
  ) {}

  /** Engines are downloaded on Windows only; elsewhere they must come from the environment. */
  get supported(): boolean {
    return process.platform === "win32" || Boolean(this.env.LILITH_AI_PIPER || this.env.LILITH_AI_WHISPER);
  }

  #engine(name: keyof typeof engines): { exe: string; bundled: boolean } | null {
    const override = this.env[name === "piper" ? "LILITH_AI_PIPER" : "LILITH_AI_WHISPER"];
    if (override) return { exe: override, bundled: false };
    return process.platform === "win32" ? { exe: join(this.dir, engines[name].ready), bundled: true } : null;
  }

  async isInstalled(id: ComponentId): Promise<boolean> {
    if (id === "piper" || id === "whisper") {
      const engine = this.#engine(id);
      return engine !== null && (await exists(engine.exe));
    }
    return exists(join(this.dir, componentFor(id).ready));
  }

  /** Which components are on disk, for the dashboard. */
  async status() {
    const ids: ComponentId[] = ["piper", "whisper", ...voiceIds.map((id) => `voice:${id}` as const), ...sttModelIds.map((id) => `stt:${id}` as const)];
    const installed = Object.fromEntries(await Promise.all(ids.map(async (id) => [id, await this.isInstalled(id)] as const)));
    return { supported: this.supported, installed: installed as Record<ComponentId, boolean> };
  }

  // ── Installing ────────────────────────────────────────────────────────────

  /** Downloads, verifies and unpacks components that aren't installed yet. */
  async install(ids: readonly ComponentId[], onProgress: (progress: InstallProgress) => void, signal?: AbortSignal): Promise<void> {
    for (const id of ids) {
      if (!isComponentId(id)) throw new Error(`unknown voice component ${id}`);
      if (await this.isInstalled(id)) continue;
      if ((id === "piper" || id === "whisper") && process.platform !== "win32") {
        throw new VoiceError("unsupported", `The ${id} engine is only downloaded on Windows; set ${id === "piper" ? "LILITH_AI_PIPER" : "LILITH_AI_WHISPER"} instead`);
      }
      const { files } = componentFor(id);
      const total = files.reduce((sum, file) => sum + file.bytes, 0);
      let before = 0;
      for (const file of files) {
        await download(file, this.dir, this.log, (received) => onProgress({ id, received: before + received, total }), signal);
        before += file.bytes;
      }
      this.log.info(`installed voice component ${id}`);
    }
  }

  // ── Speaking and listening ────────────────────────────────────────────────

  speak(text: string, options: SpeakOptions): Promise<Spoken> {
    return this.#serialize(async () => {
      const engine = this.#engine("piper");
      if (!engine || !(await exists(engine.exe))) throw new VoiceError("not_installed", "The voice engine (Piper) isn't installed");
      if (!(await this.isInstalled(`voice:${options.voice}`))) throw new VoiceError("not_installed", `The voice ${options.voice} isn't installed`);
      await this.#sweepCache();

      const name = `say-${randomId()}.wav`;
      const args = ["--model", voices[options.voice].ready, "--output_file", `cache/${name}`, "--length_scale", (1 / options.speed).toFixed(2)];
      // The bundled build finds espeak-ng-data next to its exe through a narrow-char path; a relative one is always safe.
      if (engine.bundled) args.push("--espeak_data", "bin/piper/espeak-ng-data");
      const started = performance.now();
      const result = await runProcess([engine.exe, ...args], { cwd: this.dir, stdin: `${forSpeech(text)}\n` });
      const file = join(this.dir, "cache", name);
      if (result.code !== 0 || !(await exists(file))) {
        throw new VoiceError("failed", `Piper exited with ${result.code}: ${lastLines(result.stderr)}`);
      }
      const bytes = new Uint8Array(await readFile(file));
      const info = readWav(bytes);
      applyGain(bytes, info, options.volume / 100);
      await writeFile(file, bytes);
      this.log.debug(`spoke ${info.seconds.toFixed(1)} s of audio in ${Math.round(performance.now() - started)} ms`);
      return { file, name, seconds: info.seconds };
    });
  }

  transcribe(source: string, options: { model: SttModelId; language: Language | null }): Promise<string> {
    return this.#serialize(async () => {
      const engine = this.#engine("whisper");
      if (!engine || !(await exists(engine.exe))) throw new VoiceError("not_installed", "Speech recognition (whisper.cpp) isn't installed");
      if (!(await this.isInstalled(`stt:${options.model}`))) throw new VoiceError("not_installed", `The speech model "${options.model}" isn't installed`);

      const name = `in-${randomId()}.wav`;
      const input = join(this.dir, "cache", name);
      await mkdir(join(this.dir, "cache"), { recursive: true });
      await copyFile(source, input);
      try {
        const threads = String(Math.max(2, Math.min(8, availableParallelism() - 1)));
        const args = ["-m", sttModels[options.model].ready, "-f", `cache/${name}`, "-l", whisperLanguage(options.language), "-nt", "-np", "-t", threads];
        const started = performance.now();
        const result = await runProcess([engine.exe, ...args], { cwd: this.dir });
        if (result.code !== 0) throw new VoiceError("failed", `whisper.cpp exited with ${result.code}: ${lastLines(result.stderr)}`);
        const text = cleanTranscript(result.stdout);
        this.log.debug(`transcribed in ${Math.round(performance.now() - started)} ms (${text.length} chars)`);
        if (!text) throw new VoiceError("no_speech", "No speech was recognized");
        return text;
      } finally {
        await rm(input, { force: true });
      }
    });
  }

  /** The cached audio file behind a name from `speak`, or null for anything else. */
  cachedAudio(name: string): string | null {
    return CACHE_FILE.test(name) ? join(this.dir, "cache", name) : null;
  }

  async #sweepCache(): Promise<void> {
    const cache = join(this.dir, "cache");
    await mkdir(cache, { recursive: true });
    const now = Date.now();
    for (const entry of await readdir(cache)) {
      if (!CACHE_FILE.test(entry)) continue;
      const info = await stat(join(cache, entry)).catch(() => null);
      if (info && now - info.mtimeMs > CACHE_MAX_AGE_MS) await rm(join(cache, entry), { force: true }).catch(() => {});
    }
  }

  #serialize<T>(run: () => Promise<T>): Promise<T> {
    const result = this.#queue.then(run, run);
    this.#queue = result.catch((error: unknown) => this.log.debug(`voice run failed: ${errorMessage(error)}`));
    return result;
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

const exists = (path: string) => stat(path).then(() => true, () => false);
const randomId = () => crypto.randomUUID().replace(/-/g, "").slice(0, 8);
const lastLines = (text: string) => text.trim().split(/\r?\n/).slice(-3).join(" | ") || "no output";

/** One line of plain text: Piper speaks each input line into the same file, so newlines would cut her off. */
export const forSpeech = (text: string) => text.replace(/…/g, "...").replace(/\s+/g, " ").trim();

/** Drops whisper's non-speech annotations ("[BLANK_AUDIO]", "(music)", "*laughs*"). */
export function cleanTranscript(raw: string): string {
  return raw
    .replace(/\[[^\]]*\]|\([^)]*\)|\*[^*]*\*/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** whisper.cpp language codes; "auto" lets it detect. */
export function whisperLanguage(language: Language | null): string {
  if (!language) return "auto";
  if (language.startsWith("zh")) return "zh";
  if (language === "pt-BR") return "pt";
  return language;
}

/**
 * Fetches one pinned file into `dir`, refusing anything whose SHA-256 doesn't match, then unpacks
 * it if it's an archive. Files already in place are skipped; nothing half-done is left behind.
 */
export async function download(file: Download, dir: string, log: Log, onBytes: (received: number) => void, signal?: AbortSignal): Promise<void> {
  const target = join(dir, file.path);
  if (!file.extract && (await exists(target))) return onBytes(file.bytes);
  await mkdir(dirname(target), { recursive: true });
  const part = `${target}.part`;
  log.info(`downloading ${file.url}`);
  const response = await fetch(file.url, { signal: signal ?? null });
  if (!response.ok || !response.body) throw new Error(`download failed (HTTP ${response.status}): ${file.url}`);

  const hasher = new Bun.CryptoHasher("sha256");
  const writer = Bun.file(part).writer();
  let received = 0;
  let reported = 0;
  try {
    for await (const chunk of response.body) {
      hasher.update(chunk);
      writer.write(chunk);
      received += chunk.length;
      if (received - reported > 1_000_000) {
        reported = received;
        onBytes(received);
        await writer.flush();
      }
    }
  } finally {
    await writer.end();
  }
  const hash = hasher.digest("hex");
  if (hash !== file.sha256) {
    await rm(part, { force: true });
    throw new Error(`checksum mismatch for ${file.url}: expected ${file.sha256}, got ${hash}`);
  }
  onBytes(file.bytes);

  if (!file.extract) return rename(part, target);
  await extractZip(part, join(dir, file.extract));
  await rm(part, { force: true });
}

/** Unpacks into a scratch folder, then moves each top-level entry into place (replacing old copies). */
async function extractZip(zip: string, into: string): Promise<void> {
  const scratch = `${into}.unpacking`;
  await rm(scratch, { recursive: true, force: true });
  await mkdir(scratch, { recursive: true });
  // Windows' own bsdtar reads zip; a GNU tar earlier in PATH (Git for Windows) wouldn't.
  const tar = process.platform === "win32" ? join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe") : "tar";
  const { code, stderr } = await runProcess([tar, "-xf", zip, "-C", scratch], { cwd: dirname(zip) });
  if (code !== 0) throw new Error(`could not unpack ${zip}: ${stderr.trim() || `tar exited with ${code}`}`);
  await mkdir(into, { recursive: true });
  for (const entry of await readdir(scratch)) {
    await rm(join(into, entry), { recursive: true, force: true });
    await rename(join(scratch, entry), join(into, entry));
  }
  await rm(scratch, { recursive: true, force: true });
}

export async function runProcess(command: string[], options: { cwd: string; stdin?: string }) {
  const child = Bun.spawn(command, {
    cwd: options.cwd,
    stdin: options.stdin === undefined ? "ignore" : new TextEncoder().encode(options.stdin),
    stdout: "pipe",
    stderr: "pipe",
    windowsHide: true,
  });
  const timer = setTimeout(() => child.kill(), PROCESS_TIMEOUT_MS);
  try {
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    return { code, stdout, stderr };
  } finally {
    clearTimeout(timer);
  }
}

