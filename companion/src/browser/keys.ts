// Keys for the browser tool: the same names the computer tool accepts (computer/keys.ts), turned
// into CDP key events for the page. They reach the page, not Chrome's own window, so browser
// shortcuts (ctrl+t, ctrl+w, alt+left) would do nothing: they're refused with what to use instead.

import { KeyError, parseKeys, type VirtualKey } from "../computer/keys.ts";
import type { KeyEvent } from "./protocol.ts";

/** CDP modifier bits: Alt 1, Ctrl 2, Meta 4, Shift 8. */
const MODIFIER_BITS = new Map([[0x12, 1], [0xa5, 1], [0x11, 2], [0xa3, 2], [0x5b, 4], [0x5c, 4], [0x10, 8], [0xa1, 8]]);

const NAMED = new Map<number, [key: string, code: string]>([
  [0x08, ["Backspace", "Backspace"]], [0x09, ["Tab", "Tab"]], [0x0d, ["Enter", "Enter"]], [0x1b, ["Escape", "Escape"]],
  [0x20, [" ", "Space"]], [0x21, ["PageUp", "PageUp"]], [0x22, ["PageDown", "PageDown"]], [0x23, ["End", "End"]],
  [0x24, ["Home", "Home"]], [0x25, ["ArrowLeft", "ArrowLeft"]], [0x26, ["ArrowUp", "ArrowUp"]], [0x27, ["ArrowRight", "ArrowRight"]],
  [0x28, ["ArrowDown", "ArrowDown"]], [0x2d, ["Insert", "Insert"]], [0x2e, ["Delete", "Delete"]],
  [0x10, ["Shift", "ShiftLeft"]], [0xa1, ["Shift", "ShiftRight"]], [0x11, ["Control", "ControlLeft"]], [0xa3, ["Control", "ControlRight"]],
  [0x12, ["Alt", "AltLeft"]], [0xa5, ["Alt", "AltRight"]], [0x5b, ["Meta", "MetaLeft"]], [0x5c, ["Meta", "MetaRight"]],
]);

/** Editing keys that work with ctrl in any page: select all, copy, paste, cut, undo, redo, word moves. */
const CTRL_EDITING = new Set([0x41, 0x43, 0x56, 0x58, 0x5a, 0x59, 0x08, 0x2e, 0x25, 0x26, 0x27, 0x28, 0x24, 0x23, 0x0d]);

function domKey(vk: number, shift: boolean): { key: string; code: string; text?: string } {
  const named = NAMED.get(vk);
  if (named) return { key: named[0], code: named[1], ...(vk === 0x0d ? { text: "\r" } : vk === 0x20 ? { text: " " } : {}) };
  if (vk >= 0x70 && vk <= 0x87) return { key: `F${vk - 0x6f}`, code: `F${vk - 0x6f}` };
  if (vk >= 0x41 && vk <= 0x5a) {
    const letter = String.fromCharCode(vk);
    const key = shift ? letter : letter.toLowerCase();
    return { key, code: `Key${letter}`, text: key };
  }
  if (vk >= 0x30 && vk <= 0x39) {
    const digit = String.fromCharCode(vk);
    return { key: digit, code: `Digit${digit}`, ...(shift ? {} : { text: digit }) };
  }
  throw new KeyError("That key does nothing inside a webpage. Use keys like Enter, Tab, Escape, Backspace, arrows, Page_Down or ctrl+a.");
}

/** "ctrl+a Delete", "Return", "shift+Tab" → the events that press them in order. */
export function browserKeys(text: string): KeyEvent[] {
  return parseKeys(text).flatMap(({ modifiers, key }) => {
    if ("char" in key) {
      if (modifiers.length) throw new KeyError(`"${text}" is not a key combination that works in a webpage.`);
      return [{ type: "insertText" as const, text: key.char }];
    }
    const bits = modifiers.map((modifier) => MODIFIER_BITS.get(modifier.vk) ?? 0);
    const all = bits.reduce((sum, bit) => sum | bit, 0);
    const commanding = all & (1 | 2 | 4);
    if (commanding && (all & (1 | 4) || !CTRL_EDITING.has(key.vk))) {
      throw new KeyError("Browser shortcuts don't work in the browser tool. To open a site use open_url; to go back, change or close tabs use back, switch_tab or close_tab.");
    }
    const events: KeyEvent[] = [];
    let held = 0;
    const press = (modifier: VirtualKey, index: number) => {
      held |= bits[index]!;
      const { key, code } = domKey(modifier.vk, false);
      events.push({ type: "rawKeyDown", key, code, windowsVirtualKeyCode: modifier.vk, modifiers: held });
    };
    modifiers.forEach(press);
    const main = domKey(key.vk, (all & 8) !== 0);
    // Text makes a keypress: Enter submits a form and letters type. With ctrl there is none.
    const typed = commanding ? undefined : main.text;
    events.push({ type: typed ? "keyDown" : "rawKeyDown", key: main.key, code: main.code, windowsVirtualKeyCode: key.vk, modifiers: held, ...(typed ? { text: typed } : {}) });
    events.push({ type: "keyUp", key: main.key, code: main.code, windowsVirtualKeyCode: key.vk, modifiers: held });
    modifiers.toReversed().forEach((modifier, reversed) => {
      held &= ~bits[modifiers.length - 1 - reversed]!;
      const { key, code } = domKey(modifier.vk, false);
      events.push({ type: "keyUp", key, code, windowsVirtualKeyCode: modifier.vk, modifiers: held });
    });
    return events;
  });
}
