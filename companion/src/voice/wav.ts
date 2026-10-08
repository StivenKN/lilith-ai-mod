// Just enough RIFF/WAVE to handle 16-bit PCM: read the format, scale the volume (the game plugin
// plays files with PlaySound, which has no volume of its own), and build files for tests and the
// dashboard's microphone.

export interface WavInfo {
  sampleRate: number;
  channels: number;
  bitsPerSample: number;
  /** Byte offset and length of the sample data. */
  dataOffset: number;
  dataLength: number;
  seconds: number;
}

/** Parses the header of a PCM WAV file; throws on anything else. */
export function readWav(bytes: Uint8Array): WavInfo {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = (offset: number) => String.fromCharCode(...bytes.subarray(offset, offset + 4));
  if (bytes.length < 12 || tag(0) !== "RIFF" || tag(8) !== "WAVE") throw new Error("not a WAV file");

  let format: Pick<WavInfo, "sampleRate" | "channels" | "bitsPerSample"> | null = null;
  for (let offset = 12; offset + 8 <= bytes.length; ) {
    const id = tag(offset);
    const size = view.getUint32(offset + 4, true);
    const body = offset + 8;
    if (id === "fmt ") {
      if (view.getUint16(body, true) !== 1) throw new Error("WAV is not PCM");
      format = { channels: view.getUint16(body + 2, true), sampleRate: view.getUint32(body + 4, true), bitsPerSample: view.getUint16(body + 14, true) };
    } else if (id === "data") {
      if (!format) throw new Error("WAV data before format");
      // Streaming writers (Piper writing to a pipe) may leave the size at 0 or 0xFFFFFFFF.
      const dataLength = size === 0 || body + size > bytes.length ? bytes.length - body : size;
      const bytesPerSecond = format.sampleRate * format.channels * (format.bitsPerSample / 8);
      return { ...format, dataOffset: body, dataLength, seconds: dataLength / bytesPerSecond };
    }
    offset = body + size + (size % 2); // chunks are word-aligned
  }
  throw new Error("WAV has no data");
}

/** Scales 16-bit samples in place by `gain` (0–1), clamping instead of wrapping. */
export function applyGain(bytes: Uint8Array, info: WavInfo, gain: number): void {
  if (info.bitsPerSample !== 16 || gain === 1) return;
  const samples = new Int16Array(bytes.buffer, bytes.byteOffset + info.dataOffset, Math.floor(info.dataLength / 2));
  for (let i = 0; i < samples.length; i++) samples[i] = Math.max(-32768, Math.min(32767, Math.round(samples[i]! * gain)));
}

/** A mono 16-bit PCM WAV from float samples in [-1, 1]. */
export function encodeWav(samples: Float32Array, sampleRate: number): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(44 + samples.length * 2);
  const view = new DataView(bytes.buffer);
  const ascii = (offset: number, text: string) => [...text].forEach((char, i) => view.setUint8(offset + i, char.charCodeAt(0)));
  ascii(0, "RIFF");
  view.setUint32(4, 36 + samples.length * 2, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  ascii(36, "data");
  view.setUint32(40, samples.length * 2, true);
  samples.forEach((sample, i) => view.setInt16(44 + i * 2, Math.round(Math.max(-1, Math.min(1, sample)) * 32767), true));
  return bytes;
}
