// What Lilith remembers: the conversation (sent as real alternating turns, capped) and a short
// list of notes about the user that they can read, edit and clear from the dashboard.
// Near-duplicate replies are kept for the transcript but never sent back to the model, so one
// bad loop can't feed itself.

import { z } from "zod";
import { writeAtomic } from "./config.ts";
import { isRepeat } from "./reply.ts";
import type { ChatTurn } from "./providers/types.ts";

const StoredTurn = z.object({
  role: z.enum(["user", "assistant"]),
  content: z.string(),
  at: z.string(),
  source: z.enum(["game", "dashboard", "speakFirst"]).default("game"),
  /** A near-duplicate reply: shown in the transcript, excluded from the model's context. */
  repeat: z.boolean().optional(),
});
export type StoredTurn = z.infer<typeof StoredTurn>;

const MemoryFile = z.object({
  version: z.literal(1).default(1),
  history: z.array(StoredTurn).default([]),
  notes: z.array(z.string()).default([]),
  userMessagesSinceLearn: z.number().int().default(0),
});
type MemoryData = z.infer<typeof MemoryFile>;

const STORED_TURNS = 300;
const PROMPT_TURNS = 20;
export const MAX_NOTES = 30;

export class Memory {
  private constructor(
    readonly path: string,
    private data: MemoryData,
  ) {}

  static async load(path: string, onWarning: (message: string) => void = () => {}): Promise<Memory> {
    const file = Bun.file(path);
    if (await file.exists()) {
      try {
        const parsed = MemoryFile.safeParse(await file.json());
        if (parsed.success) return new Memory(path, parsed.data);
        onWarning("memory.json is invalid; starting fresh and keeping a backup");
      } catch (error) {
        onWarning(`memory.json could not be read (${String(error)}); starting fresh and keeping a backup`);
      }
      await Bun.write(`${path}.broken-${Date.now()}`, file);
    }
    return new Memory(path, MemoryFile.parse({}));
  }

  get history(): readonly StoredTurn[] {
    return this.data.history;
  }

  get notes(): readonly string[] {
    return this.data.notes;
  }

  /** Recent turns for the model, oldest first. */
  promptTurns(): ChatTurn[] {
    return this.data.history
      .filter((turn) => !turn.repeat)
      .slice(-PROMPT_TURNS)
      .map(({ role, content }) => ({ role, content }));
  }

  recentReplies(count = 5): string[] {
    return this.data.history
      .filter((turn) => turn.role === "assistant" && !turn.repeat)
      .slice(-count)
      .map((turn) => turn.content);
  }

  /** Records an exchange. Returns false if the reply was a near-repeat (kept out of the context). */
  async addExchange(user: string | null, reply: string, source: StoredTurn["source"]): Promise<boolean> {
    const at = new Date().toISOString();
    const repeat = isRepeat(reply, this.recentReplies());
    if (user) {
      this.data.history.push({ role: "user", content: user, at, source });
      this.data.userMessagesSinceLearn++;
    }
    this.data.history.push({ role: "assistant", content: reply, at, source, ...(repeat ? { repeat } : {}) });
    this.data.history = this.data.history.slice(-STORED_TURNS);
    await this.save();
    return !repeat;
  }

  /** User messages since the last fact-learning pass. */
  get pendingForLearning(): number {
    return this.data.userMessagesSinceLearn;
  }

  recentUserMessages(count: number): string[] {
    return this.data.history
      .filter((turn) => turn.role === "user")
      .slice(-count)
      .map((turn) => turn.content);
  }

  async addNotes(notes: readonly string[]): Promise<string[]> {
    const added = notes
      .map((note) => note.trim())
      .filter((note) => note.length > 2 && !isRepeat(note, this.data.notes, 0.6));
    this.data.notes = [...this.data.notes, ...added].slice(-MAX_NOTES);
    this.data.userMessagesSinceLearn = 0;
    await this.save();
    return added;
  }

  async setNotes(notes: readonly string[]): Promise<void> {
    this.data.notes = notes.map((note) => note.trim()).filter(Boolean).slice(0, MAX_NOTES);
    await this.save();
  }

  async clearHistory(): Promise<void> {
    this.data.history = [];
    this.data.userMessagesSinceLearn = 0;
    await this.save();
  }

  private save(): Promise<void> {
    return writeAtomic(this.path, `${JSON.stringify(this.data, null, 2)}\n`);
  }
}
