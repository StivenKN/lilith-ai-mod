import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Logger } from "../log.ts";
import { componentFor, isComponentId, voiceIdsFor, voices } from "./catalog.ts";
import { cleanTranscript, download, forSpeech, runProcess, whisperLanguage } from "./index.ts";
import { applyGain, encodeWav, readWav } from "./wav.ts";

describe("wav", () => {
  test("round-trips a mono 16-bit file and knows its length", () => {
    const wav = encodeWav(new Float32Array(16_000).fill(0.5), 16_000);
    expect(readWav(wav)).toMatchObject({ sampleRate: 16_000, channels: 1, bitsPerSample: 16, dataOffset: 44, seconds: 1 });
  });

  test("scales volume and clamps instead of wrapping", () => {
    const wav = encodeWav(new Float32Array([0.5, -1]), 22_050);
    const info = readWav(wav);
    applyGain(wav, info, 0.5);
    const samples = new Int16Array(wav.buffer, 44, 2);
    expect([...samples]).toEqual([8192, -16383]);
    applyGain(wav, info, 4); // a corrupt setting must not turn into noise
    expect(new Int16Array(wav.buffer, 44, 2)[1]).toBe(-32768);
  });

  test("reads a streamed file whose data size was never filled in", () => {
    const wav = encodeWav(new Float32Array(22_050), 22_050);
    new DataView(wav.buffer).setUint32(40, 0, true);
    expect(readWav(wav).seconds).toBe(1);
  });

  test("rejects files that aren't PCM WAV", () => {
    expect(() => readWav(new TextEncoder().encode("ID3 not a wav at all"))).toThrow("not a WAV file");
  });
});

describe("text in and out of the engines", () => {
  test("speech input is one line, so Piper doesn't stop at the bubble's line breaks", () => {
    expect(forSpeech("Hola…\n¿cómo  estás?\n")).toBe("Hola... ¿cómo estás?");
  });

  test("whisper's non-speech annotations are dropped", () => {
    expect(cleanTranscript(" [BLANK_AUDIO]\n")).toBe("");
    expect(cleanTranscript(" (música) Hola, Lilith. *risas*\n ¿Me oyes?\n")).toBe("Hola, Lilith. ¿Me oyes?");
  });

  test("game languages map to whisper's codes", () => {
    expect(whisperLanguage("es")).toBe("es");
    expect(whisperLanguage("zh-Hant")).toBe("zh");
    expect(whisperLanguage("pt-BR")).toBe("pt");
    expect(whisperLanguage(null)).toBe("auto");
  });
});

describe("catalog", () => {
  test("every voice is filed under the right language, and the model is its ready marker", () => {
    for (const id of voiceIdsFor("es")) expect(voices[id].language).toBe("es");
    for (const id of voiceIdsFor("en")) expect(voices[id].language).toBe("en");
    for (const voice of Object.values(voices)) expect(voice.files.at(-1)?.path).toBe(voice.ready);
  });

  test("component ids are validated", () => {
    expect(isComponentId("voice:es_AR-daniela-high")).toBe(true);
    expect(isComponentId("stt:small")).toBe(true);
    expect(isComponentId("voice:../../evil")).toBe(false);
    expect(componentFor("stt:base").ready).toBe("models/ggml-base-q8_0.bin");
  });
});

describe("download", () => {
  let dir = "";
  let server: ReturnType<typeof Bun.serve>;
  const payload = new TextEncoder().encode("pretend this is a voice model");
  const sha256 = new Bun.CryptoHasher("sha256").update(payload).digest("hex");
  let zip = new Uint8Array();
  const log = new Logger(null).scope("test");

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "lilith-voice-"));
    // A zip shaped like Piper's release: one top-level folder.
    const source = join(dir, "zip-source");
    await mkdir(join(source, "piper"), { recursive: true });
    await writeFile(join(source, "piper", "piper.exe"), "fake engine");
    const zipPath = join(dir, "engine.zip");
    expect((await runProcess(["tar", "--format=zip", "-cf", zipPath, "-C", source, "piper"], { cwd: dir })).code).toBe(0);
    zip = new Uint8Array(await readFile(zipPath));
    server = Bun.serve({ port: 0, fetch: (request) => new Response(new URL(request.url).pathname === "/engine.zip" ? zip : payload) });
  });
  afterAll(async () => {
    server.stop(true);
    await rm(dir, { recursive: true, force: true });
  });

  const exists = (path: string) => stat(path).then(() => true, () => false);

  test("verifies the checksum before putting a file in place", async () => {
    const root = join(dir, "ok");
    await download({ url: `http://127.0.0.1:${server.port}/model`, sha256, bytes: payload.length, path: "voices/a.onnx" }, root, log, () => {});
    expect(await readFile(join(root, "voices", "a.onnx"), "utf8")).toBe("pretend this is a voice model");
  });

  test("refuses a file whose checksum doesn't match and leaves nothing behind", async () => {
    const root = join(dir, "bad");
    const file = { url: `http://127.0.0.1:${server.port}/model`, sha256: "0".repeat(64), bytes: payload.length, path: "voices/a.onnx" };
    expect(download(file, root, log, () => {})).rejects.toThrow("checksum mismatch");
    await Bun.sleep(50);
    expect(await exists(join(root, "voices", "a.onnx"))).toBe(false);
    expect(await exists(join(root, "voices", "a.onnx.part"))).toBe(false);
  });

  test("unpacks an archive into place and removes the download", async () => {
    const root = join(dir, "zip");
    const zipSha = new Bun.CryptoHasher("sha256").update(zip).digest("hex");
    await download({ url: `http://127.0.0.1:${server.port}/engine.zip`, sha256: zipSha, bytes: zip.length, path: "downloads/engine.zip", extract: "bin" }, root, log, () => {});
    expect(await readFile(join(root, "bin", "piper", "piper.exe"), "utf8")).toBe("fake engine");
    expect(await exists(join(root, "downloads", "engine.zip.part"))).toBe(false);
  });
});
