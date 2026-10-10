// What Lilith remembers, in three layers sized for small local models:
// - The conversation. Every turn is kept for the transcript, but the model only gets the turns
//   after the summary point, within a token budget, so the prompt stays short and its prefix
//   stays the same from one turn to the next (local servers then reuse their cache).
// - A summary of older turns: short lines of plain fact. When the unsummarized part grows past a
//   threshold, the oldest turns are folded into it in the background (compaction), so a long
//   conversation keeps its thread without a long prompt. The model only writes lines for the new
//   turns; keeping, deduplicating and retiring old lines is done here, because a small model
//   asked to rewrite the whole summary drops what came before.
// - Notes about the user, kept current from whole exchanges (added, corrected, removed), which
//   the player can read, edit and clear from the dashboard.
// Near-duplicate replies are kept for the transcript but never sent back to the model, so one
// bad loop can't feed itself.

import { z } from "zod";
import { readTextFile, writeAtomic } from "./config.ts";
import { copyFile } from "node:fs/promises";
import { isRepeat, truncate } from "./reply.ts";
import type { ChatTurn } from "./providers/types.ts";

const StoredTurn = z.object({
  /** Increases by one per turn; the summary and notes record how far they've read. */
  id: z.number().int().positive(),
  role: z.enum(["user", "assistant"]),
  content: z.string(),
  at: z.string(),
  /** "keepsake": the player shared a note or picture and she reacted to it. */
  source: z.enum(["game", "dashboard", "speakFirst", "keepsake"]).default("game"),
  /** A near-duplicate reply: shown in the transcript, excluded from the model's context. */
  repeat: z.boolean().optional(),
  /** The exchange read the player's accounts. Prompts replay it; the notes, summary and card passes skip it, so nothing from their mail becomes a permanent note. */
  consulted: z.literal(true).optional(),
});
export type StoredTurn = z.infer<typeof StoredTurn>;

const MemoryFile = z.object({
  version: z.literal(2),
  history: z.array(StoredTurn),
  notes: z.array(z.string()),
  /** What happened in the conversation before the turns the model sees verbatim. */
  summary: z.string(),
  /** Last turn folded into the summary. */
  summarizedThrough: z.number().int(),
  /** Last turn the notes were updated from. */
  learnedThrough: z.number().int(),
});
type MemoryData = z.infer<typeof MemoryFile>;

/** Version 1 had no summary, and turns had no ids. */
const MemoryFileV1 = z.object({
  version: z.literal(1).default(1),
  history: z.array(StoredTurn.omit({ id: true })).default([]),
  notes: z.array(z.string()).default([]),
});

const STORED_TURNS = 400;
export const MAX_NOTES = 30;
export const SUMMARY_MAX_LINES = 12;
export const SUMMARY_MAX_CHARS = 1500;
/** Most conversation a single background summary reads, so a small model can take it in at once. */
const COMPACTION_CHUNK_TOKENS = 1600;
/** Most conversation a single notes update reads. */
const LEARNING_CHUNK_TOKENS = 1600;
/** An upgraded memory only summarizes its most recent turns; older ones stay in the transcript. */
const MIGRATED_PENDING_TURNS = 80;

/** How much conversation the model gets, in estimated tokens (each turn counts at least TURN_MIN_TOKENS). */
export interface ContextBudget {
  /** Most recent turns sent verbatim. Older ones slide out if the summary hasn't caught up yet. */
  window: number;
  /** Once the turns after the summary pass this, the oldest are folded into the summary… */
  compactAt: number;
  /** …down to about this much, so she still has the recent thread word for word. */
  keep: number;
}

/**
 * Small local models get a short window: the more of her own replies a 4B model sees, the more it
 * copies them, and its quality drops as the prompt grows. That's 12 exchanges at most, summarized
 * after 10 down to the last 4. Hosted models get much more of the conversation verbatim.
 */
export const contextBudget = (local: boolean): ContextBudget =>
  local ? { window: 1200, compactAt: 1000, keep: 400 } : { window: 9000, compactAt: 6000, keep: 2500 };

/**
 * Every turn weighs at least this much in the budget, so it limits turns as well as tokens: a small
 * model copies its own replies however short they are.
 */
const TURN_MIN_TOKENS = 50;
const weight = (turn: StoredTurn): number => Math.max(TURN_MIN_TOKENS, estimateTokens(turn.content));

const WIDE = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;

/**
 * Rough token count for budgeting, without a tokenizer: three characters per token in alphabetic
 * scripts (Qwen measures about 3.3 in Spanish), one per CJK character, plus each message's
 * chat-template overhead. Errs high.
 */
export function estimateTokens(text: string): number {
  let wide = 0;
  let other = 0;
  for (const char of text) WIDE.test(char) ? wide++ : other++;
  return Math.ceil(other / 3 + wide) + 5;
}

/** A slice of the conversation for background upkeep. Stale once the player edits her memory. */
export interface UpkeepJob {
  turns: readonly StoredTurn[];
  /** Last turn the job covers. */
  through: number;
  revision: number;
}

/** Changes to the notes proposed after reading new exchanges. Numbers are 1-based positions. */
export const NoteChanges = z.object({
  add: z.array(z.string()),
  update: z.array(z.object({ number: z.number(), text: z.string() })),
  remove: z.array(z.number()),
});
export type NoteChanges = z.infer<typeof NoteChanges>;
const { $schema, ...noteChangesSchema } = z.toJSONSchema(NoteChanges, { target: "draft-7" });
/** Constrains the notes update to valid JSON while the model writes it, where the server can. */
export const noteChangesFormat = { name: "note_changes", schema: noteChangesSchema };

/** Reads the notes update from a reply, tolerating code fences, reasoning and stray prose. */
export function parseNoteChanges(text: string): NoteChanges | null {
  const body = text.replace(/<think(ing)?>[\s\S]*?<\/think(ing)?>/gi, "");
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start < 0 || end < start) return null;
  try {
    const parsed = NoteChanges.partial().safeParse(JSON.parse(body.slice(start, end + 1)));
    if (!parsed.success) return null;
    const { add = [], update = [], remove = [] } = parsed.data;
    return { add, update, remove };
  } catch {
    return null;
  }
}

/** A summary or list line without its bullet, numbering or markdown. */
const bare = (line: string): string =>
  line.trim().replace(/^(?:[-*•]|\d+[.)])\s*/, "").replace(/(\*\*|__)(.+?)\1/g, "$2").replace(/\s+/g, " ").trim();

/** The lines the model wrote for the summary: [] when it found nothing worth keeping, null if unusable. */
export function parseSummaryLines(text: string): string[] | null {
  const body = text.replace(/<think(ing)?>[\s\S]*?<\/think(ing)?>/gi, "").trim();
  if (/^(none|nada|ninguno|ninguna)\.?$/i.test(body)) return [];
  const lines = body.split("\n").map(bare).filter((line) => line.length >= 12 && !line.startsWith("#") && !line.endsWith(":"));
  return lines.length > 0 ? lines.slice(0, 4) : null;
}

/** Spanish and English words too common to tell which notes a message is about. */
const COMMON = new Set("para pero como esta este esto estoy estas porque cuando donde tengo tiene tienes sobre todo nada algo aqui solo mucho bien hola that this with have from your about when where there just what them they".split(" "));

/** The first five letters of each meaningful word: close enough to match "quiero" with "quiere". */
const stems = (text: string): Set<string> =>
  new Set(text.toLowerCase().normalize("NFD").replace(/\p{M}/gu, "").split(/[^\p{L}\p{N}]+/u).filter((word) => word.length >= 4 && !COMMON.has(word)).map((word) => word.slice(0, 5)));

/**
 * The notes that share words with a message, best first. A small model overlooks a note at the
 * top of a long prompt; repeated next to the message it's answering, it gets used.
 */
export function relevantNotes(notes: readonly string[], message: string, limit = 3): string[] {
  const wanted = stems(message);
  return notes
    .map((note, index) => ({ note, index, score: [...stems(note)].filter((stem) => wanted.has(stem)).length }))
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score || b.index - a.index)
    .slice(0, limit)
    .map(({ note }) => note);
}

export class Memory {
  /** Bumped whenever the player edits or clears memory, so upkeep started before is discarded. */
  #revision = 0;

  private constructor(
    readonly path: string,
    private data: MemoryData,
  ) {}

  static async load(path: string, onWarning: (message: string) => void = () => {}): Promise<Memory> {
    const text = await readTextFile(path).catch(() => null);
    if (text !== null) {
      try {
        const json: unknown = JSON.parse(text);
        const current = MemoryFile.safeParse(json);
        if (current.success) return new Memory(path, current.data);
        const v1 = MemoryFileV1.safeParse(json);
        if (v1.success) return new Memory(path, migrate(v1.data));
        onWarning("memory.json is invalid; starting fresh and keeping a backup");
      } catch (error) {
        onWarning(`memory.json could not be read (${String(error)}); starting fresh and keeping a backup`);
      }
      await copyFile(path, `${path}.broken-${Date.now()}`).catch(() => {});
    }
    return new Memory(path, empty());
  }

  get history(): readonly StoredTurn[] {
    return this.data.history;
  }

  get notes(): readonly string[] {
    return this.data.notes;
  }

  get summary(): string {
    return this.data.summary;
  }

  /** Turns not yet in the summary that the model may see, oldest first. */
  #unsummarized(): StoredTurn[] {
    return this.data.history.filter((turn) => turn.id > this.data.summarizedThrough && !turn.repeat);
  }

  /** The turns after the summary for the model, oldest first: as many recent ones as fit the budget. */
  promptTurns(budget: ContextBudget): ChatTurn[] {
    const turns = this.#unsummarized();
    let tokens = 0;
    let start = turns.length;
    while (start > 0) {
      tokens += weight(turns[start - 1]!);
      if (tokens > budget.window && turns.length - start >= 2) break;
      start--;
    }
    return turns.slice(start).map(({ role, content }) => ({ role, content }));
  }

  /** Her latest replies, newest last, to keep her from repeating herself. */
  recentReplies(count = 6): string[] {
    return this.data.history
      .filter((turn) => turn.role === "assistant" && !turn.repeat)
      .slice(-count)
      .map((turn) => turn.content);
  }

  /** When the player last said something, if ever. */
  get lastUserMessageAt(): Date | null {
    const at = this.data.history.findLast((turn) => turn.role === "user")?.at;
    return at ? new Date(at) : null;
  }

  /** Records an exchange. Returns false if the reply was a near-repeat (kept out of the context). */
  async addExchange(user: string | null, reply: string, source: StoredTurn["source"], consulted = false): Promise<boolean> {
    const at = new Date().toISOString();
    const repeat = isRepeat(reply, this.recentReplies(5));
    const flags = consulted ? { consulted: true as const } : {};
    let id = this.#lastId();
    if (user) this.data.history.push({ id: ++id, role: "user", content: user, at, source, ...flags });
    this.data.history.push({ id: ++id, role: "assistant", content: reply, at, source, ...flags, ...(repeat ? { repeat } : {}) });
    this.data.history = this.data.history.slice(-STORED_TURNS);
    await this.save();
    return !repeat;
  }

  #lastId(): number {
    return this.data.history.at(-1)?.id ?? Math.max(this.data.summarizedThrough, this.data.learnedThrough);
  }

  /** The turns after the summary no longer fit the window, so the oldest are sliding out unsummarized. */
  overdue(budget: ContextBudget): boolean {
    return this.#unsummarized().reduce((sum, turn) => sum + weight(turn), 0) > budget.window;
  }

  /**
   * The oldest turns to fold into the summary, once the turns after it pass `compactAt` (or
   * whenever there's more than `keep`, if forced). Ends on one of her replies, so an exchange is
   * never split between the summary and the verbatim turns. Exchanges that read the player's
   * accounts are folded past without being read: `through` covers them, `turns` leaves them out.
   */
  compaction(budget: ContextBudget, force = false): UpkeepJob | null {
    const pending = this.#unsummarized();
    let remaining = pending.reduce((sum, turn) => sum + weight(turn), 0);
    if (!force && remaining <= budget.compactAt) return null;
    const chunk: StoredTurn[] = [];
    let size = 0;
    for (const turn of pending) {
      if (remaining <= budget.keep || size >= COMPACTION_CHUNK_TOKENS) break;
      chunk.push(turn);
      size += estimateTokens(turn.content);
      remaining -= weight(turn);
    }
    while (chunk.at(-1)?.role === "user") chunk.pop();
    const last = chunk.at(-1);
    return last ? { turns: chunk.filter((turn) => !turn.consulted), through: last.id, revision: this.#revision } : null;
  }

  /**
   * Adds the lines written for a compaction job to the summary: near-duplicates of lines it has are
   * skipped, and the oldest lines retire once it's full. Returns false if the job went stale.
   */
  async applySummary(job: UpkeepJob, lines: readonly string[]): Promise<boolean> {
    if (job.revision !== this.#revision) return false;
    const next = this.data.summary.split("\n").map(bare).filter(Boolean);
    for (const line of lines) if (!isRepeat(line, next, 0.6)) next.push(line);
    let kept = next.slice(-SUMMARY_MAX_LINES);
    while (kept.length > 1 && kept.join("\n").length > SUMMARY_MAX_CHARS) kept = kept.slice(1);
    this.data.summary = kept.map((line) => `- ${line}`).join("\n");
    this.data.summarizedThrough = job.through;
    await this.save();
    return true;
  }

  /** The player's own edit of the summary, from the dashboard. */
  async setSummary(summary: string): Promise<void> {
    this.#revision++;
    this.data.summary = truncate(summary.trim(), SUMMARY_MAX_CHARS);
    await this.save();
  }

  /**
   * Exchanges the notes haven't been updated from, once there are at least `minUserMessages` of the
   * player's messages. Exchanges that read their accounts count for nothing and are left out.
   */
  learning(minUserMessages: number): UpkeepJob | null {
    const pending = this.data.history.filter((turn) => turn.id > this.data.learnedThrough && !turn.repeat);
    if (pending.filter((turn) => turn.role === "user" && !turn.consulted).length < minUserMessages) return null;
    const chunk: StoredTurn[] = [];
    let size = 0;
    for (const turn of pending) {
      if (size >= LEARNING_CHUNK_TOKENS && turn.role === "user") break;
      chunk.push(turn);
      size += estimateTokens(turn.content);
    }
    return { turns: chunk.filter((turn) => !turn.consulted), through: chunk.at(-1)!.id, revision: this.#revision };
  }

  /**
   * Applies proposed changes to the notes and records that the job's turns were read. Every change
   * is checked: unknown numbers are ignored, questions and fragments aren't notes, near-duplicates
   * aren't added twice, and a pass may not wipe out most of what she knows.
   */
  async applyNoteChanges(job: UpkeepJob, changes: NoteChanges): Promise<{ added: number; updated: number; removed: number } | null> {
    if (job.revision !== this.#revision) return null;
    const notes = [...this.data.notes];
    const valid = (n: number) => Number.isInteger(n) && n >= 1 && n <= notes.length;
    const updated = new Map<number, string>();
    for (const { number, text } of changes.update) {
      const note = cleanNote(text);
      if (valid(number) && note && note !== notes[number - 1]) updated.set(number, note);
    }
    let removed = new Set(changes.remove.filter((n) => valid(n) && !updated.has(n)));
    if (removed.size > Math.max(2, notes.length / 3)) removed = new Set();
    const kept = notes.filter((_, index) => !removed.has(index + 1) && !updated.has(index + 1));
    // A corrected note moves to the end, with the newest.
    const next = [...kept, ...updated.values()];
    let added = 0;
    for (const text of changes.add) {
      const note = cleanNote(text);
      if (!note || isRepeat(note, next, 0.7)) continue;
      next.push(note);
      added++;
    }
    this.data.notes = next.slice(-MAX_NOTES);
    this.data.learnedThrough = job.through;
    await this.save();
    return { added, updated: updated.size, removed: removed.size };
  }

  /** Marks a job's turns as read without changing the notes (the model's answer was unusable). */
  async skipLearning(job: UpkeepJob): Promise<void> {
    if (job.revision !== this.#revision) return;
    this.data.learnedThrough = job.through;
    await this.save();
  }

  /** For the cards: what the player said lately, except when they were asking about their accounts. */
  recentUserMessages(count: number): string[] {
    return this.data.history
      .filter((turn) => turn.role === "user" && !turn.consulted)
      .slice(-count)
      .map((turn) => turn.content);
  }

  /** The player's own edit of the notes, from the dashboard. */
  async setNotes(notes: readonly string[]): Promise<void> {
    this.#revision++;
    this.data.notes = notes.map((note) => note.trim()).filter(Boolean).slice(0, MAX_NOTES);
    await this.save();
  }

  /** Forgets the conversation and its summary; the notes stay. */
  async clearHistory(): Promise<void> {
    this.#revision++;
    this.data = { ...empty(), notes: this.data.notes };
    await this.save();
  }

  private save(): Promise<void> {
    return writeAtomic(this.path, `${JSON.stringify(this.data, null, 2)}\n`);
  }
}

const empty = (): MemoryData => ({ version: 2, history: [], notes: [], summary: "", summarizedThrough: 0, learnedThrough: 0 });

function migrate(v1: z.infer<typeof MemoryFileV1>): MemoryData {
  const history = v1.history.map((turn, index) => ({ ...turn, id: index + 1 }));
  const last = history.length;
  return {
    version: 2,
    history,
    notes: v1.notes,
    summary: "",
    summarizedThrough: Math.max(0, last - MIGRATED_PENDING_TURNS),
    // The old notes already came from these turns.
    learnedThrough: last,
  };
}

/** A note as stored: one plain statement, not a list item, a question or a fragment. */
export function cleanNote(text: string): string | null {
  const note = text
    .trim()
    .replace(/^(?:[-*•]|\d+[.)])\s*/, "")
    .replace(/^["“«](.*)["”»]$/s, "$1")
    .replace(/\s+/g, " ")
    .trim();
  if (note.length < 4 || note.length > 200 || /[?？]$/.test(note)) return null;
  return note;
}
