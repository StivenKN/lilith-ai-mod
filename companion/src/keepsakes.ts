// Keepsakes: notes and pictures the player chooses to share with Lilith, and the cards she writes
// from them. Nothing here is gathered on its own: every keepsake was handed over in the dashboard,
// and removing one deletes its picture from disk.
// Pictures arrive already shrunk and re-encoded to JPEG by the dashboard (which also drops
// EXIF data such as GPS location); they are stored as <id>.jpg in their own folder.

import { z } from "zod";
import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { readTextFile, writeAtomic } from "./config.ts";

const Common = {
  id: z.string(),
  addedAt: z.string(),
  /** Last time a card was written about it; cards favor what hasn't been used yet. */
  usedAt: z.string().nullable().default(null),
};

const Keepsake = z.discriminatedUnion("kind", [
  z.object({ ...Common, kind: z.literal("note"), text: z.string() }),
  z.object({
    ...Common,
    kind: z.literal("picture"),
    /** What the player says about it, in their words. */
    caption: z.string().default(""),
    /** What the model saw in it, written once when it was added (empty if the model can't see). */
    seen: z.string().default(""),
  }),
]);
export type Keepsake = z.infer<typeof Keepsake>;
export type Picture = Extract<Keepsake, { kind: "picture" }>;

const Card = z.object({
  id: z.string(),
  text: z.string(),
  at: z.string(),
  trigger: z.enum(["manual", "auto"]),
  /** The keepsake the card was about, if any (it may have been removed since). */
  keepsakeId: z.string().nullable(),
  /** True once the game confirmed the card is in its inbox. */
  inGame: z.boolean().default(false),
  /** Why the game couldn't take it, when it couldn't. */
  error: z.string().optional(),
});
export type Card = z.infer<typeof Card>;

const KeepsakesFile = z.object({
  version: z.literal(1).default(1),
  keepsakes: z.array(Keepsake).default([]),
  cards: z.array(Card).default([]),
});
type KeepsakesData = z.infer<typeof KeepsakesFile>;

export const MAX_KEEPSAKES = 60;
export const MAX_PICTURE_BYTES = 2 * 1024 * 1024;
const STORED_CARDS = 50;
const NOTE_CHARS = 500;
const CAPTION_CHARS = 300;

export class Keepsakes {
  private constructor(
    readonly path: string,
    readonly pictureDir: string,
    private data: KeepsakesData,
  ) {}

  static async load(path: string, pictureDir: string, onWarning: (message: string) => void = () => {}): Promise<Keepsakes> {
    const text = await readTextFile(path).catch(() => null);
    if (text !== null) {
      try {
        const parsed = KeepsakesFile.safeParse(JSON.parse(text));
        if (parsed.success) return new Keepsakes(path, pictureDir, parsed.data);
        onWarning("keepsakes.json is invalid; starting fresh and keeping a backup");
      } catch (error) {
        onWarning(`keepsakes.json could not be read (${String(error)}); starting fresh and keeping a backup`);
      }
      await copyFile(path, `${path}.broken-${Date.now()}`).catch(() => {});
    }
    return new Keepsakes(path, pictureDir, KeepsakesFile.parse({}));
  }

  /** Newest first. */
  get list(): readonly Keepsake[] {
    return this.data.keepsakes.toReversed();
  }

  /** Newest first. */
  get cards(): readonly Card[] {
    return this.data.cards.toReversed();
  }

  get lastCard(): Card | null {
    return this.data.cards.at(-1) ?? null;
  }

  get(id: string): Keepsake | null {
    return this.data.keepsakes.find((keepsake) => keepsake.id === id) ?? null;
  }

  picturePath(picture: Picture): string {
    return join(this.pictureDir, `${picture.id}.jpg`);
  }

  async readPicture(picture: Picture): Promise<Buffer> {
    return readFile(this.picturePath(picture));
  }

  async addNote(text: string): Promise<Keepsake> {
    const note: Keepsake = { id: newId(), kind: "note", text: text.trim().slice(0, NOTE_CHARS), addedAt: now(), usedAt: null };
    await this.#add([note]);
    return note;
  }

  /** Stores JPEG pictures. Throws on anything that isn't a reasonably sized JPEG. */
  async addPictures(images: readonly Buffer[]): Promise<Picture[]> {
    for (const image of images) {
      if (image.length > MAX_PICTURE_BYTES) throw new Error("picture is too large");
      if (!isJpeg(image)) throw new Error("picture is not a JPEG");
    }
    await mkdir(this.pictureDir, { recursive: true });
    const pictures = images.map((): Picture => ({ id: newId(), kind: "picture", caption: "", seen: "", addedAt: now(), usedAt: null }));
    await Promise.all(pictures.map((picture, index) => writeFile(this.picturePath(picture), images[index]!)));
    await this.#add(pictures);
    return pictures;
  }

  async describe(id: string, update: { caption?: string; seen?: string }): Promise<Keepsake | null> {
    const keepsake = this.get(id);
    if (keepsake?.kind !== "picture") return null;
    if (update.caption !== undefined) keepsake.caption = update.caption.trim().slice(0, CAPTION_CHARS);
    if (update.seen !== undefined) keepsake.seen = update.seen.trim().slice(0, CAPTION_CHARS);
    await this.#save();
    return keepsake;
  }

  async remove(id: string): Promise<void> {
    const keepsake = this.get(id);
    if (!keepsake) return;
    this.data.keepsakes = this.data.keepsakes.filter((item) => item.id !== id);
    if (keepsake.kind === "picture") await rm(this.picturePath(keepsake), { force: true });
    await this.#save();
  }

  /**
   * The keepsake the next card should be about: never-used ones first, then the one used longest
   * ago. Ties are broken at random so a fresh batch doesn't always start with the same item.
   */
  pick(random: () => number = Math.random): Keepsake | null {
    const items = this.data.keepsakes;
    if (items.length === 0) return null;
    const age = (keepsake: Keepsake) => (keepsake.usedAt === null ? -Infinity : Date.parse(keepsake.usedAt));
    const oldest = Math.min(...items.map(age));
    const candidates = items.filter((keepsake) => age(keepsake) === oldest);
    return candidates[Math.floor(random() * candidates.length)] ?? null;
  }

  async addCard(card: Omit<Card, "id" | "at" | "inGame">): Promise<Card> {
    const stored: Card = { ...card, id: newId(), at: now(), inGame: false };
    this.data.cards = [...this.data.cards, stored].slice(-STORED_CARDS);
    const keepsake = card.keepsakeId ? this.get(card.keepsakeId) : null;
    if (keepsake) keepsake.usedAt = stored.at;
    await this.#save();
    return stored;
  }

  /** Records the game's answer for a card. Returns false if `id` isn't a card (e.g. a bubble message). */
  async cardDelivered(id: string, ok: boolean, error?: string): Promise<boolean> {
    const card = this.data.cards.find((item) => item.id === id);
    if (!card) return false;
    card.inGame = ok;
    if (ok) delete card.error;
    else card.error = error ?? "unknown reason";
    await this.#save();
    return true;
  }

  async #add(keepsakes: readonly Keepsake[]): Promise<void> {
    if (this.data.keepsakes.length + keepsakes.length > MAX_KEEPSAKES) throw new Error(`at most ${MAX_KEEPSAKES} keepsakes`);
    this.data.keepsakes = [...this.data.keepsakes, ...keepsakes];
    await this.#save();
  }

  #save(): Promise<void> {
    return writeAtomic(this.path, `${JSON.stringify(this.data, null, 2)}\n`);
  }
}

const newId = () => crypto.randomUUID().replace(/-/g, "").slice(0, 12);
const now = () => new Date().toISOString();
/** JPEG files start with the SOI marker FF D8 FF. */
const isJpeg = (bytes: Buffer) => bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
