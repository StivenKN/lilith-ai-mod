/** RAWINPUTDEVICE is 16 bytes on x64. NULL target unregisters the mouse and keyboard. */
export function rawInputDevices(hwnd: bigint | null): Uint8Array {
  const bytes = new Uint8Array(32), view = new DataView(bytes.buffer);
  for (const [index, usage] of [2, 6].entries()) {
    const at = index * 16;
    view.setUint16(at, 1, true); // generic desktop usage page
    view.setUint16(at + 2, usage, true);
    view.setUint32(at + 4, hwnd === null ? 1 : 0x100, true); // REMOVE or INPUTSINK
    view.setBigUint64(at + 8, hwnd ?? 0n, true);
  }
  return bytes;
}

/** Mouse/keyboard RAWINPUT has a 24-byte header and a DWORD extra-info marker. */
export function playerRawInput(bytes: Uint8Array, marker: number): boolean {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length < 24) throw new Error("Incomplete raw input header");
  const type = view.getUint32(0, true);
  const offset = type === 0 ? 44 : type === 1 ? 36 : null;
  if (offset === null || bytes.length < offset + 4) throw new Error("Unexpected raw input packet");
  return view.getUint32(offset, true) !== marker;
}
