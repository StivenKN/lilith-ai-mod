// Key names as models write them (xdotool style, which Claude's computer tool uses): "Return",
// "ctrl+s", "alt+Tab", "super", "Page_Down", "ctrl+a Delete". Resolved to Windows virtual-key codes.
// Characters without a fixed key (",", "ñ", "?") are left as characters: the native layer maps
// them through the active keyboard layout, or types them as Unicode.

export interface VirtualKey {
  vk: number;
  /** Arrows, Home/End, Insert/Delete, Page keys, right-hand modifiers... need the extended flag. */
  extended: boolean;
}
export type KeyTarget = VirtualKey | { char: string };
export interface Combo {
  modifiers: VirtualKey[];
  key: KeyTarget;
}

const key = (vk: number, extended = false): VirtualKey => ({ vk, extended });

const MODIFIERS: Record<string, VirtualKey> = {
  ctrl: key(0x11), control: key(0x11), ctrl_l: key(0x11), control_l: key(0x11),
  ctrl_r: key(0xa3, true), control_r: key(0xa3, true),
  shift: key(0x10), shift_l: key(0x10), shift_r: key(0xa1),
  alt: key(0x12), alt_l: key(0x12), alt_r: key(0xa5, true), altgr: key(0xa5, true), option: key(0x12),
  super: key(0x5b, true), super_l: key(0x5b, true), super_r: key(0x5c, true),
  win: key(0x5b, true), windows: key(0x5b, true), meta: key(0x5b, true), cmd: key(0x5b, true), command: key(0x5b, true),
};

const NAMED: Record<string, KeyTarget> = {
  ...MODIFIERS,
  return: key(0x0d), enter: key(0x0d), kp_enter: key(0x0d, true),
  tab: key(0x09), iso_left_tab: key(0x09),
  escape: key(0x1b), esc: key(0x1b),
  backspace: key(0x08),
  space: key(0x20),
  delete: key(0x2e, true), del: key(0x2e, true),
  insert: key(0x2d, true),
  home: key(0x24, true), end: key(0x23, true),
  page_up: key(0x21, true), pageup: key(0x21, true), prior: key(0x21, true),
  page_down: key(0x22, true), pagedown: key(0x22, true), next: key(0x22, true),
  left: key(0x25, true), up: key(0x26, true), right: key(0x27, true), down: key(0x28, true),
  print: key(0x2c, true), printscreen: key(0x2c, true),
  pause: key(0x13), caps_lock: key(0x14), capslock: key(0x14), num_lock: key(0x90, true), scroll_lock: key(0x91),
  menu: key(0x5d, true), apps: key(0x5d, true),
  xf86audioplay: key(0xb3, true), xf86audiopause: key(0xb3, true), xf86audiostop: key(0xb2, true),
  xf86audionext: key(0xb0, true), xf86audioprev: key(0xb1, true), xf86audiomute: key(0xad, true),
  xf86audioraisevolume: key(0xaf, true), xf86audiolowervolume: key(0xae, true),
  xf86back: key(0xa6, true), xf86forward: key(0xa7, true), xf86reload: key(0xa8, true), xf86refresh: key(0xa8, true),
  xf86homepage: key(0xac, true),
  // xdotool spells punctuation out; these go through the keyboard layout like any character.
  plus: { char: "+" }, minus: { char: "-" }, equal: { char: "=" }, comma: { char: "," }, period: { char: "." },
  slash: { char: "/" }, backslash: { char: "\\" }, semicolon: { char: ";" }, apostrophe: { char: "'" },
  grave: { char: "`" }, bracketleft: { char: "[" }, bracketright: { char: "]" },
};

/** Thrown for key names we can't map; the message goes back to the model so it can retry. */
export class KeyError extends Error {
  override readonly name = "KeyError";
}

/** Resolves one key name: a named key, F1-F24, a letter or digit, or any single character. */
function resolve(name: string): KeyTarget {
  const lower = name.toLowerCase();
  const named = NAMED[lower];
  if (named) return named;
  const fn = /^f([1-9]|1\d|2[0-4])$/.exec(lower);
  if (fn) return key(0x6f + Number(fn[1]));
  if (/^[a-z0-9]$/.test(lower)) return key(lower.toUpperCase().charCodeAt(0)); // VK codes equal ASCII for A-Z, 0-9
  if ([...name].length === 1) return { char: name };
  throw new KeyError(`Unknown key "${name}". Use names like Return, Tab, Escape, BackSpace, Delete, Up, Page_Down, F5, ctrl+c.`);
}

/** Parses one combo such as "ctrl+shift+t" or "ctrl++". Every part but the last must be a modifier. */
function parseCombo(text: string): Combo {
  // A trailing "+" after a separator is the plus key itself ("ctrl++").
  const parts = text.endsWith("++") ? [...text.slice(0, -2).split("+"), "+"] : text.split("+");
  if (parts.some((part) => !part)) throw new KeyError(`Malformed key combination "${text}"`);
  const last = parts.pop()!;
  const modifiers = parts.map((part) => {
    const modifier = MODIFIERS[part.toLowerCase()];
    if (!modifier) throw new KeyError(`"${part}" in "${text}" is not a modifier (ctrl, shift, alt, super)`);
    return modifier;
  });
  return { modifiers, key: resolve(last) };
}

/** Parses a key sequence: combos separated by spaces, pressed one after another ("ctrl+a Delete"). */
export function parseKeys(text: string): Combo[] {
  const combos = text.trim().split(/\s+/).filter(Boolean);
  if (combos.length === 0) throw new KeyError("No key given");
  return combos.map(parseCombo);
}

/** Parses click/scroll modifiers ("shift", "ctrl+shift"). Empty means none. */
export function parseModifiers(text: string | undefined): VirtualKey[] {
  if (!text?.trim()) return [];
  return text.split("+").map((part) => {
    const modifier = MODIFIERS[part.trim().toLowerCase()];
    if (!modifier) throw new KeyError(`"${part}" is not a modifier (ctrl, shift, alt, super)`);
    return modifier;
  });
}
