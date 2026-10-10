// The page as the model reads it after each browser action: its tabs, its address and its
// elements, each with a number. Sized for a 4B model with an 8k context: about 2,000 characters,
// an open dialog first (it blocks everything else), then what's on screen (the page's content
// before the site's menus), then what's further down.

import type { Look, RawElement } from "./protocol.ts";
import { isDashboard } from "./shared.ts";

export const PAGE_BUDGET = 2000;

export interface Formatted {
  text: string;
  /** The refs the model saw and their document. Null when no page was shown. */
  shown: { doc: string; refs: ReadonlySet<number> } | null;
  /** Tab ids by the number the model sees (1 is the window's first tab). */
  tabs: number[];
}

const clean = (text: string | undefined, max: number) => {
  const flat = (text ?? "").replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};
const quoted = (text: string) => `"${text.replaceAll('"', "'")}"`;

const BUTTON_TYPES = new Set(["button", "submit", "reset", "image"]);
const INPUT_ROLES: Record<string, string> = { checkbox: "checkbox", radio: "radio", search: "searchbox", range: "slider", number: "spinbutton", file: "file chooser" };

/** The element's role as ARIA names it, from its explicit role or its tag. */
export function roleOf(element: RawElement): string {
  const explicit = element.role?.trim().split(/\s+/)[0]?.toLowerCase();
  if (explicit && explicit !== "presentation" && explicit !== "none" && explicit !== "generic") return explicit;
  switch (element.tag) {
    case "a": return "link";
    case "button": case "summary": return "button";
    case "select": return "combobox";
    case "textarea": return "textbox";
    case "input": {
      const type = element.type ?? "text";
      return BUTTON_TYPES.has(type) ? "button" : INPUT_ROLES[type] ?? "textbox";
    }
    default: return /^h[1-6]$/.test(element.tag) ? "heading" : element.tag === "iframe" ? "frame" : element.ref ? "clickable" : element.tag;
  }
}

const FIELDS = new Set(["textbox", "searchbox", "combobox", "spinbutton", "slider"]);

/** What a screen reader would call it: an explicit label first, then what it shows. */
export function nameOf(element: RawElement): string {
  const role = roleOf(element);
  const candidates = FIELDS.has(role)
    ? [element.aria, element.label, element.placeholder, element.title]
    : [element.aria, element.label, element.text, element.alt, element.title, BUTTON_TYPES.has(element.type ?? "") ? element.value : undefined, element.placeholder];
  const name = candidates.map((candidate) => clean(candidate, 80)).find(Boolean);
  if (name) return name;
  if (role === "link" && element.href) {
    try {
      const url = new URL(element.href);
      return clean(`${url.pathname}${url.search}`, 80);
    } catch { return clean(element.href, 80); }
  }
  return "";
}

/** `[12] checkbox "Remember me" (checked)`, or null for an element not worth a line. */
export function elementLine(element: RawElement): string | null {
  const role = roleOf(element);
  if (role === "heading") {
    const text = clean(element.text ?? element.aria, 80);
    return text ? `${"#".repeat(Math.min(3, element.level ?? 2))} ${text}` : null;
  }
  if (role === "frame") return `(embedded frame${element.title ? ` ${quoted(clean(element.title, 60))}` : ""}: its content can't be used)`;
  if (!element.ref) return null;
  const name = nameOf(element);
  // An unnamed link is usually a picture that repeats the link next to it.
  if (role === "link" && !name) return null;
  const parts = [`[${element.ref}] ${role}`];
  if (name) parts.push(quoted(name));
  const value = role === "button" || role === "link" ? "" : clean(element.value, 60);
  if (value && value !== name) parts.push(`= ${quoted(value)}`);
  const states = [
    element.checked !== undefined && (element.checked ? "checked" : "not checked"),
    element.selected && "selected",
    element.expanded !== undefined && (element.expanded ? "expanded" : "collapsed"),
    element.disabled && "disabled",
    element.focused && "focused",
  ].filter(Boolean);
  if (states.length) parts.push(`(${states.join(", ")})`);
  return parts.join(" ");
}

function tabsLine(look: Look): { line: string; ids: number[] } {
  const ids = look.tabs.map((tab) => tab.id);
  // Long tab strips cost context: the first few, plus the current one and hers wherever they are.
  const shown = look.tabs.filter((tab, index) => index < 6 || tab.id === look.tab || tab.mine);
  const label = (title: string, url: string) => {
    try { if (isDashboard(new URL(url))) return "Lilith's settings"; } catch {}
    return clean(title, 40) || "New tab";
  };
  const items = shown.map((tab) => {
    const notes = [tab.id === look.tab && "current", tab.mine && "yours"].filter(Boolean);
    return `${ids.indexOf(tab.id) + 1} ${quoted(label(tab.title, tab.url))}${notes.length ? ` (${notes.join(", ")})` : ""}`;
  });
  const hidden = look.tabs.length - shown.length;
  return { line: `Tabs: ${items.join(" · ")}${hidden > 0 ? ` · and ${hidden} more` : ""}`, ids };
}

/**
 * Formats what the extension saw. With `read`, the page's text replaces its elements: the model
 * asked to read, and both wouldn't fit. Its refs stay valid, so `shown` is null then (the caller
 * keeps the elements it showed before).
 */
export function formatLook(look: Look, options: { read: boolean; budget?: number }): Formatted {
  const budget = options.budget ?? PAGE_BUDGET;
  const { line, ids } = tabsLine(look);
  const lines = [line];
  if (look.alert) lines.push(`The page showed a message, which was dismissed: ${quoted(clean(look.alert, 200))}`);
  const { page } = look;
  if ("unavailable" in page) {
    lines.push(page.unavailable === "dashboard"
      ? "This tab is Lilith's settings page, which she can't use."
      : "This tab is a browser page: its content can't be read or used. Open a website with open_url.");
    return { text: lines.join("\n"), shown: null, tabs: ids };
  }
  lines.push(`Page: ${quoted(clean(page.title, 100))} ${clean(page.url, 200)}`);

  if (options.read) {
    const text = (page.text ?? "").replace(/[ \t]+/g, " ").replace(/\n\s*\n+/g, "\n").trim();
    const room = Math.max(200, budget - lines.join("\n").length - 80);
    const cut = text.length > room;
    lines.push("Text from where the page is scrolled to:", cut ? `${text.slice(0, room)}…` : text || "(No text here.)");
    lines.push(cut || page.more ? "… There is more below: scroll down and read again." : "(End of the page.)");
    return { text: lines.join("\n"), shown: null, tabs: ids };
  }

  const refs = new Set<number>();
  let length = lines.join("\n").length;
  // Room left for the closing lines that count what didn't fit.
  const room = budget - 100;
  const add = (text: string) => {
    if (length + text.length + 1 > room) return false;
    lines.push(text);
    length += text.length + 1;
    return true;
  };
  const elements = page.elements;
  // The page's own content before its menus: a site's sidebar comes first in the page and would
  // otherwise fill the budget (YouTube's lists every subscribed channel above the videos).
  const groups: Array<{ heading: string | null; where: RawElement["where"]; menu: boolean }> = page.dialog !== undefined
    ? [{ heading: `A dialog is open${page.dialog ? `: ${quoted(clean(page.dialog, 80))}` : ""}. Deal with it first:`, where: "dialog", menu: false }, { heading: "Behind it:", where: "view", menu: false }]
    : [{ heading: null, where: "view", menu: false }];
  groups.push({ heading: "Menus:", where: "view", menu: true }, { heading: "Further down:", where: "below", menu: false }, { heading: "Menus further down:", where: "below", menu: true });
  let left = 0;
  let menus = 0;
  for (const group of groups) {
    const members = elements.filter((element) => element.where === group.where && (group.where === "dialog" || !!element.menu === group.menu));
    const skip = (count: number) => { if (group.menu) menus += count; else left += count; };
    let headed = group.heading === null;
    for (const element of members) {
      const text = elementLine(element);
      if (!text) continue;
      if (!headed) {
        if (!add(group.heading!)) { skip(members.filter((member) => member.ref).length); break; }
        headed = true;
      }
      if (add(text)) { if (element.ref) refs.add(element.ref); }
      else if (element.ref) skip(1);
    }
  }
  const above = elements.filter((element) => element.where === "above" && element.ref).length;
  if (!refs.size && !left && !menus) lines.push("(Nothing to click or fill on this part of the page.)");
  if (left) lines.push(`… and ${left} more further down: scroll down to see them.`);
  if (menus) lines.push(`… and ${menus} more in the site's menus.`);
  if (above) lines.push(`(${above} more above: scroll up to see them.)`);
  return { text: lines.join("\n"), shown: { doc: page.doc, refs }, tabs: ids };
}
