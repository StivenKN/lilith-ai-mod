// Minimal PNG encoder for screenshots. Windows GDI gives us top-down BGRA where the alpha byte is
// left at 0, so we drop alpha and emit a 24-bit RGB (color type 2) image. The Up filter (each row
// predicted from the one above) compresses flat UI regions well; zlib does the rest.

import { deflateSync } from "node:zlib";

const SIGNATURE = Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);

/** Encodes a top-down BGRA buffer (4 bytes/pixel) as an RGB PNG. */
export function bgraToPng(bgra: Uint8Array, width: number, height: number): Uint8Array {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0 || bgra.length !== width * height * 4) throw new Error("Invalid BGRA dimensions");
  const stride = width * 3;
  // One filter-type byte per row, then the filtered RGB scanline.
  const raw = new Uint8Array((stride + 1) * height);
  const prev = new Uint8Array(stride);
  const row = new Uint8Array(stride);
  for (let y = 0; y < height; y++) {
    const src = y * width * 4;
    for (let x = 0; x < width; x++) {
      const s = src + x * 4;
      const d = x * 3;
      row[d] = bgra[s + 2]!; // R ← B-G-R-A, so index +2 is red
      row[d + 1] = bgra[s + 1]!;
      row[d + 2] = bgra[s]!;
    }
    const out = y * (stride + 1);
    raw[out] = 2; // filter type: Up
    for (let i = 0; i < stride; i++) raw[out + 1 + i] = (row[i]! - prev[i]! + 256) & 0xff;
    prev.set(row);
  }

  const ihdr = new Uint8Array(13);
  const view = new DataView(ihdr.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // color type: truecolour (RGB)
  // bytes 10-12 (compression, filter, interlace) stay 0

  const idat = deflateSync(raw);
  return concat([SIGNATURE, chunk("IHDR", ihdr), chunk("IDAT", idat), chunk("IEND", new Uint8Array(0))]);
}

/** A PNG chunk: length, type, data, CRC32 of (type + data). */
function chunk(type: string, data: Uint8Array): Uint8Array {
  const typeBytes = Uint8Array.from(type, (c) => c.charCodeAt(0));
  const body = concat([typeBytes, data]);
  const out = new Uint8Array(8 + data.length + 4);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  out.set(body, 4);
  view.setUint32(4 + body.length, Bun.hash.crc32(body));
  return out;
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}
