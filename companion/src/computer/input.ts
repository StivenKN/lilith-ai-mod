// Synthetic input events and their encoding as Win32 `INPUT` records for `SendInput`.
// Layout on x64 (40 bytes): DWORD type, 4 bytes padding, then a 32-byte union at offset 8:
//   MOUSEINPUT  { LONG dx; LONG dy; DWORD mouseData; DWORD dwFlags; DWORD time; ULONG_PTR extra }
//   KEYBDINPUT  { WORD wVk; WORD wScan; DWORD dwFlags; DWORD time; ULONG_PTR extra }

export type MouseButton = "left" | "right" | "middle";

export type InputEvent =
  /** Absolute move in normalized primary-monitor coordinates (0..65535). */
  | { type: "move"; nx: number; ny: number }
  | { type: "button"; button: MouseButton; down: boolean }
  /** Wheel clicks: positive is up (or right, when horizontal). */
  | { type: "wheel"; clicks: number; horizontal: boolean }
  | { type: "key"; vk: number; scan: number; extended: boolean; down: boolean }
  /** One UTF-16 code unit typed regardless of keyboard layout. */
  | { type: "unicode"; unit: number; down: boolean };

export const INPUT_SIZE = 40;

/** A short SendInput write can leave a key/button down. Release the accepted prefix before failing. */
export function sendCheckedInputs(events: readonly InputEvent[], write: (events: readonly InputEvent[]) => number): void {
  if (!events.length) return;
  const count = write(events);
  if (count === events.length) return;
  const held = new Map<string, Extract<InputEvent, { down: boolean }>>();
  for (const event of events.slice(0, count)) {
    if (!("down" in event)) continue;
    const id = event.type === "button" ? `button:${event.button}`
      : event.type === "unicode" ? `unicode:${event.unit}` : `key:${event.vk}:${event.scan}:${event.extended}`;
    if (event.down) held.set(id, event);
    else held.delete(id);
  }
  const releases = [...held.values()].reverse().map((event) => ({ ...event, down: false }));
  if (releases.length) write(releases);
  throw new Error(`Windows accepted ${count}/${events.length} input events. The app may require administrator permissions.`);
}

const INPUT_MOUSE = 0;
const INPUT_KEYBOARD = 1;
const MOUSEEVENTF_MOVE = 0x0001;
const MOUSEEVENTF_ABSOLUTE = 0x8000;
const MOUSEEVENTF_WHEEL = 0x0800;
const MOUSEEVENTF_HWHEEL = 0x1000;
const BUTTON_FLAGS: Record<MouseButton, { down: number; up: number }> = {
  left: { down: 0x0002, up: 0x0004 },
  right: { down: 0x0008, up: 0x0010 },
  middle: { down: 0x0020, up: 0x0040 },
};
const KEYEVENTF_EXTENDEDKEY = 0x0001;
const KEYEVENTF_KEYUP = 0x0002;
const KEYEVENTF_UNICODE = 0x0004;
const WHEEL_DELTA = 120;

/** Packs events into the contiguous `INPUT[]` buffer SendInput expects. */
export function encodeInputs(events: readonly InputEvent[], extraInfo = 0n, swappedButtons = false): Uint8Array {
  const buffer = new Uint8Array(events.length * INPUT_SIZE);
  const view = new DataView(buffer.buffer);
  events.forEach((event, index) => {
    const base = index * INPUT_SIZE;
    const union = base + 8;
    switch (event.type) {
      case "move":
        view.setUint32(base, INPUT_MOUSE, true);
        view.setInt32(union, event.nx, true);
        view.setInt32(union + 4, event.ny, true);
        view.setUint32(union + 12, MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE | 0x4000, true); // VIRTUALDESK
        break;
      case "button":
        view.setUint32(base, INPUT_MOUSE, true);
        const button = swappedButtons && event.button !== "middle" ? event.button === "left" ? "right" : "left" : event.button;
        view.setUint32(union + 12, event.down ? BUTTON_FLAGS[button].down : BUTTON_FLAGS[button].up, true);
        break;
      case "wheel":
        view.setUint32(base, INPUT_MOUSE, true);
        view.setInt32(union + 8, event.clicks * WHEEL_DELTA, true);
        view.setUint32(union + 12, event.horizontal ? MOUSEEVENTF_HWHEEL : MOUSEEVENTF_WHEEL, true);
        break;
      case "key":
        view.setUint32(base, INPUT_KEYBOARD, true);
        view.setUint16(union, event.vk, true);
        view.setUint16(union + 2, event.scan, true);
        view.setUint32(union + 4, (event.extended ? KEYEVENTF_EXTENDEDKEY : 0) | (event.down ? 0 : KEYEVENTF_KEYUP), true);
        break;
      case "unicode":
        view.setUint32(base, INPUT_KEYBOARD, true);
        view.setUint16(union + 2, event.unit, true);
        view.setUint32(union + 4, KEYEVENTF_UNICODE | (event.down ? 0 : KEYEVENTF_KEYUP), true);
        break;
    }
    view.setBigUint64(union + (event.type === "key" || event.type === "unicode" ? 16 : 24), extraInfo, true);
  });
  return buffer;
}

/** Key-down then key-up events that type `text` as Unicode (newlines and tabs become real keys). */
export function typeEvents(text: string, keyFor: (vk: number) => InputEvent[]): InputEvent[] {
  const events: InputEvent[] = [];
  for (const char of text.replace(/\r\n?/g, "\n")) {
    if (char === "\n") events.push(...keyFor(0x0d));
    else if (char === "\t") events.push(...keyFor(0x09));
    else {
      // Characters outside the BMP are two UTF-16 units; each is sent as its own down/up pair.
      for (let i = 0; i < char.length; i++) {
        const unit = char.charCodeAt(i);
        events.push({ type: "unicode", unit, down: true }, { type: "unicode", unit, down: false });
      }
    }
  }
  return events;
}
