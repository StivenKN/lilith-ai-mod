import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Keepsakes } from "./keepsakes.ts";

const dirs: string[] = [];
afterAll(async () => {
  for (const dir of dirs) await rm(dir, { recursive: true, force: true });
});

async function store() {
  const dir = await mkdtemp(join(tmpdir(), "lilith-keepsakes-"));
  dirs.push(dir);
  return Keepsakes.load(join(dir, "keepsakes.json"), join(dir, "keepsakes"));
}

const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
const exists = (path: string) => stat(path).then(() => true, () => false);

describe("Keepsakes", () => {
  test("cards draw on what hasn't been used yet, then on what was used longest ago", async () => {
    const keepsakes = await store();
    const guitar = await keepsakes.addNote("I'm learning guitar");
    const exam = await keepsakes.addNote("Exam on Friday");
    await keepsakes.addCard({ text: "Good luck!", trigger: "manual", keepsakeId: exam.id });
    expect(keepsakes.pick()?.id).toBe(guitar.id);

    await Bun.sleep(5); // a distinct timestamp, so "used longest ago" isn't a tie
    await keepsakes.addCard({ text: "Play me a song?", trigger: "auto", keepsakeId: guitar.id });
    expect(keepsakes.pick()?.id).toBe(exam.id);
  });

  test("only stores JPEGs, and removing a picture deletes it from disk", async () => {
    const keepsakes = await store();
    await expect(keepsakes.addPictures([Buffer.from("<svg/>")])).rejects.toThrow("not a JPEG");

    const [picture] = await keepsakes.addPictures([jpeg]);
    const path = keepsakes.picturePath(picture!);
    expect(await exists(path)).toBe(true);
    await keepsakes.remove(picture!.id);
    expect(await exists(path)).toBe(false);
    expect(keepsakes.list).toHaveLength(0);
  });
});
