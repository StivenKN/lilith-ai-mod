// One log for everything: companion lines and plugin lines mirrored over the bridge.
// Plain-text lines in a rotating file (easy to attach to a bug report), plus an in-memory
// ring buffer that the dashboard streams live. Secrets are redacted before anything is stored.

import { appendFileSync, mkdirSync, renameSync, statSync } from "node:fs";
import { dirname } from "node:path";

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogEntry {
  at: string;
  level: LogLevel;
  source: string;
  message: string;
}

const MAX_FILE_BYTES = 2 * 1024 * 1024;
const RING_SIZE = 1000;

const SECRET_PATTERNS = [
  /sk-[A-Za-z0-9_-]{12,}/g,
  /sk-ant-[A-Za-z0-9_-]{12,}/g,
  /AIza[0-9A-Za-z_-]{20,}/g,
  /gsk_[A-Za-z0-9]{20,}/g,
  /xai-[A-Za-z0-9]{20,}/g,
  /(Bearer\s+)[A-Za-z0-9._~+/-]{12,}/gi,
  /([?&](?:key|token|t)=)[A-Za-z0-9._-]{8,}/gi,
];

export class Logger {
  readonly #ring: LogEntry[] = [];
  readonly #listeners = new Set<(entry: LogEntry) => void>();
  readonly #secrets = new Set<string>();
  #writesSinceCheck = 0;

  constructor(readonly file: string | null) {
    if (file) {
      mkdirSync(dirname(file), { recursive: true });
      this.#rotateIfLarge();
    }
  }

  /** Registers a value that must never appear in logs, reports or the dashboard. */
  addSecret(value: string): void {
    if (value.length >= 6) this.#secrets.add(value);
  }

  redact(text: string): string {
    let out = text;
    for (const secret of this.#secrets) out = out.split(secret).join("***");
    for (const pattern of SECRET_PATTERNS) {
      out = out.replace(pattern, (match, prefix: unknown) => (typeof prefix === "string" ? `${prefix}***` : "***"));
    }
    return out;
  }

  write(level: LogLevel, source: string, message: string): void {
    const entry: LogEntry = { at: new Date().toISOString(), level, source, message: this.redact(message) };
    this.#ring.push(entry);
    if (this.#ring.length > RING_SIZE) this.#ring.shift();
    if (this.file) {
      try {
        appendFileSync(this.file, `${formatEntry(entry)}\n`, "utf8");
        if (++this.#writesSinceCheck >= 200) this.#rotateIfLarge();
      } catch {
        // Logging must never take the app down (disk full, file locked by an editor...).
      }
    }
    for (const listener of this.#listeners) listener(entry);
  }

  scope(source: string) {
    return {
      debug: (message: string) => this.write("debug", source, message),
      info: (message: string) => this.write("info", source, message),
      warn: (message: string) => this.write("warn", source, message),
      error: (message: string) => this.write("error", source, message),
    };
  }

  recent(limit = RING_SIZE): LogEntry[] {
    return this.#ring.slice(-limit);
  }

  subscribe(listener: (entry: LogEntry) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  #rotateIfLarge(): void {
    this.#writesSinceCheck = 0;
    if (!this.file) return;
    try {
      if (statSync(this.file).size > MAX_FILE_BYTES) renameSync(this.file, `${this.file}.1`);
    } catch {
      // Missing file is fine.
    }
  }
}

export type Log = ReturnType<Logger["scope"]>;

export const formatEntry = (entry: LogEntry): string =>
  `${entry.at} ${entry.level.toUpperCase().padEnd(5)} [${entry.source}] ${entry.message}`;

export const errorMessage = (error: unknown): string =>
  error instanceof Error ? `${error.name}: ${error.message}` : String(error);
