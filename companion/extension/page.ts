// Runs inside a webpage, in the extension's isolated world, only once Lilith looks at or acts on
// that page (background.ts injects it). It reports the page's elements as raw facts and finds the
// ones she names by number; the companion decides what they're called and what she may do.
// Password values never leave the page.

import type { ErrorCode, PageFacts, RawElement } from "../src/browser/protocol.ts";

export type Failure = { failed: ErrorCode; detail?: string; element?: RawElement };
export type Point = { x: number; y: number };

export interface PageApi {
  look(read: boolean): PageFacts;
  /** Where to click element `ref`, once scrolled into view and checked that nothing covers it. */
  target(doc: string, ref: number): Point | Failure;
  /** After the click: if it never reached the element (a hidden window ignores input), click it from here. */
  landed(): void;
  /** What typing into `ref` (or the focused element) means: a dropdown to choose in, or a field to click first. */
  field(doc: string | null, ref: number | null): { kind: "select" } | ({ kind: "field" } & Point) | { kind: "focused" } | Failure;
  /** Focuses the field and selects its text, so typed text replaces it. */
  prepare(doc: string | null, ref: number | null): { ok: true } | Failure;
  /** Chooses an option of dropdown `ref`, or of the focused one. */
  choose(doc: string | null, ref: number | null, option: string): { ok: true } | Failure;
  /** Whether keys would type into a password field. */
  secretFocused(): boolean;
  /** The middle of the viewport, where the wheel scrolls the page. */
  center(): Point & { height: number };
}

declare global {
  var __lilith: PageApi | undefined;
}

const INTERACTIVE = [
  "a[href]", "button", 'input:not([type="hidden"])', "select", "textarea", "summary", '[contenteditable=""]', '[contenteditable="true"]',
  ...["button", "link", "checkbox", "radio", "switch", "tab", "menuitem", "menuitemcheckbox", "menuitemradio", "option", "combobox", "textbox", "searchbox", "slider", "spinbutton", "treeitem"].map((role) => `[role="${role}"]`),
  '[tabindex]:not([tabindex="-1"])',
].join(", ");
const HEADINGS = 'h1, h2, h3, [role="heading"]';
const DIALOGS = 'dialog[open], [role="dialog"], [role="alertdialog"], [aria-modal="true"]';
const MAX_ELEMENTS = 300;
const MAX_TEXT = 8000;

function create(): PageApi {
  // Refs are numbers per document: stable for an element while it lives, never reused.
  const doc = Array.from(crypto.getRandomValues(new Uint8Array(8)), (byte) => byte.toString(16).padStart(2, "0")).join("");
  const refs = new Map<number, WeakRef<Element>>();
  const ids = new WeakMap<Element, number>();
  let next = 1;
  let pending: { element: Element; landed: boolean; listener: (event: Event) => void } | null = null;

  const refFor = (element: Element) => {
    let ref = ids.get(element);
    if (!ref) {
      ref = next++;
      ids.set(element, ref);
      refs.set(ref, new WeakRef(element));
    }
    return ref;
  };

  const resolve = (wanted: string | null, ref: number): Element | Failure => {
    if (wanted !== doc) return { failed: "stale" };
    const element = refs.get(ref)?.deref();
    return element?.isConnected ? element : { failed: "gone" };
  };

  /** Every element in document order, inside open and closed shadow roots too. */
  function* walk(root: Node): Generator<Element> {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const element = node as Element;
      yield element;
      const shadow = element instanceof HTMLElement ? chrome.dom.openOrClosedShadowRoot(element) : null;
      if (shadow) yield* walk(shadow);
    }
  }

  /** The focused element, through shadow roots. */
  const focused = () => {
    let active = document.activeElement;
    while (active?.shadowRoot?.activeElement) active = active.shadowRoot.activeElement;
    return active;
  };

  /** Whether `inner` is `outer` or inside it, crossing shadow roots. */
  const within = (inner: Node | null, outer: Element) => {
    for (let node = inner; node; node = node.parentNode ?? (node instanceof ShadowRoot ? node.host : null)) if (node === outer) return true;
    return false;
  };

  const clip = (text: string | null | undefined, max = 200) => {
    const flat = text?.replace(/\s+/g, " ").trim();
    return flat ? flat.slice(0, max) : undefined;
  };
  const isSecret = (element: Element | null) => element instanceof HTMLInputElement && element.type === "password";
  const isFile = (element: Element) => element instanceof HTMLInputElement && element.type === "file";
  const shown = (element: Element) => element.checkVisibility({ checkOpacity: false, checkVisibilityCSS: true });

  /** Text of the elements an attribute points to by id (aria-labelledby), in the element's own document or shadow root. */
  const byIds = (element: Element, attribute: string) => {
    const root = element.getRootNode();
    if (!(root instanceof Document || root instanceof ShadowRoot)) return undefined;
    return clip(element.getAttribute(attribute)?.split(/\s+/).map((id) => root.getElementById(id)?.textContent ?? "").join(" "));
  };
  /** A label's own words: one wrapped around a dropdown would otherwise include all its options. */
  const labelText = (label: HTMLLabelElement) => {
    const copy = label.cloneNode(true) as HTMLLabelElement;
    for (const control of copy.querySelectorAll("input, select, textarea, button")) control.remove();
    return copy.textContent;
  };
  /** A heading's level: h1–h6, or aria-level (2 when a role="heading" doesn't say). */
  const headingLevel = (element: Element) => Number(element.getAttribute("aria-level")) || (/^H[1-6]$/.test(element.tagName) ? Number(element.tagName[1]) : 2);

  function describe(element: Element, where: RawElement["where"], ref?: number): RawElement {
    const tag = element.tagName.toLowerCase();
    const input = element instanceof HTMLInputElement ? element : null;
    const field = input ?? (element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement ? element : null);
    const html = element instanceof HTMLElement ? element : null;
    const toggle = input && (input.type === "checkbox" || input.type === "radio");
    const ariaChecked = element.getAttribute("aria-checked");
    const expanded = element.getAttribute("aria-expanded");
    // A link or button showing only a picture is named by the picture.
    const picture = !field ? element.querySelector("img[alt], svg[aria-label], [role='img'][aria-label]") : null;
    const value = element instanceof HTMLSelectElement ? element.selectedOptions[0]?.text
      : field && !toggle && !isSecret(field) && !isFile(field) ? field.value : undefined;
    const facts: RawElement = {
      tag,
      where,
      ...(ref ? { ref } : {}),
      ...(input ? { type: input.type } : {}),
      ...(element.getAttribute("role") ? { role: element.getAttribute("role")! } : {}),
      aria: clip(element.getAttribute("aria-label")) ?? byIds(element, "aria-labelledby"),
      label: field ? clip(Array.from(field.labels ?? [], labelText).join(" ")) : undefined,
      text: field ? undefined : clip(html?.innerText ?? element.textContent),
      alt: clip(element.getAttribute("alt") ?? picture?.getAttribute("alt") ?? picture?.getAttribute("aria-label")),
      title: clip(element.getAttribute("title")),
      placeholder: clip(element.getAttribute("placeholder") ?? element.getAttribute("aria-placeholder")),
      value: clip(value),
      href: element instanceof HTMLAnchorElement ? element.href.slice(0, 500) : undefined,
      checked: toggle ? input.checked : ariaChecked === null ? undefined : ariaChecked !== "false",
      disabled: (field ?? (element instanceof HTMLButtonElement ? element : null))?.disabled || element.getAttribute("aria-disabled") === "true" || undefined,
      expanded: expanded === null ? (tag === "summary" ? (element.parentElement as HTMLDetailsElement | null)?.open : undefined) : expanded === "true",
      selected: element.getAttribute("aria-selected") === "true" || undefined,
      focused: element === focused() || undefined,
      ...(!ref && element.matches(HEADINGS) ? { level: Math.min(6, headingLevel(element)) } : {}),
    };
    // Undefined fields would only cost bytes.
    return Object.fromEntries(Object.entries(facts).filter(([, value]) => value !== undefined)) as RawElement;
  }

  const interactiveAncestor = (element: Element) => {
    for (let node: Element | null = element; node; node = node.parentElement ?? (node.parentNode instanceof ShadowRoot ? node.parentNode.host : null)) {
      if (node.matches(INTERACTIVE)) return node;
    }
    return null;
  };

  /** The element under a point, inside shadow roots too. */
  const hitAt = (x: number, y: number) => {
    let hit = document.elementFromPoint(x, y);
    for (let inner = hit?.shadowRoot?.elementFromPoint(x, y); hit && inner && inner !== hit; inner = hit.shadowRoot?.elementFromPoint(x, y)) hit = inner;
    return hit;
  };

  /** Scrolls `element` into view and returns its middle, or what covers it. */
  function aim(element: Element): Point | Failure {
    let target = element;
    // A checkbox drawn by its label, with the real one shrunk out of sight, is clicked through the label.
    const box = element.getBoundingClientRect();
    if ((box.width < 4 || box.height < 4) && element instanceof HTMLInputElement && element.labels?.[0]) target = element.labels[0];
    target.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
    const rect = target.getBoundingClientRect();
    const point = { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) };
    const hit = hitAt(point.x, point.y);
    const labelled = element instanceof HTMLInputElement && Array.from(element.labels ?? []).some((label) => within(hit, label));
    if (hit && (within(hit, target) || within(target, hit) || labelled)) return point;
    const cover = hit && (interactiveAncestor(hit) ?? hit.closest(DIALOGS) ?? hit);
    return { failed: "covered", ...(cover ? { element: describe(cover, "view", cover.matches(INTERACTIVE) ? refFor(cover) : undefined) } : {}) };
  }

  /** The page's text from where it's scrolled to, block by block, from its main part when it marks one. */
  function readText(): { text: string; more: boolean } {
    const main = document.querySelector("main, [role='main'], article");
    const root = main && shown(main) ? main : document.body;
    const range = document.createRange();
    const blocks = new Map<Element, Element>();
    const blockOf = (element: Element): Element => {
      const known = blocks.get(element);
      if (known) return known;
      const display = getComputedStyle(element).display;
      const block = display.startsWith("inline") || display === "contents" ? (element.parentElement ? blockOf(element.parentElement) : element) : element;
      blocks.set(element, block);
      return block;
    };
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let text = "";
    let last: Element | null = null;
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const content = node.textContent?.replace(/\s+/g, " ");
      const parent = node.parentElement;
      if (!content?.trim() || !parent || parent.closest("script, style, noscript, template, [aria-hidden='true']")) continue;
      range.selectNodeContents(node);
      const rect = range.getBoundingClientRect();
      if ((!rect.width && !rect.height) || rect.bottom < 0 || !shown(parent)) continue;
      const block = blockOf(parent);
      text += block !== last && text ? `\n${content.trim()}` : content;
      last = block;
      if (text.length > MAX_TEXT) return { text: text.slice(0, MAX_TEXT), more: true };
    }
    return { text, more: false };
  }

  return {
    look(read) {
      const dialogs = Array.from(document.querySelectorAll(DIALOGS)).filter((dialog) => shown(dialog) && dialog.getBoundingClientRect().width > 0);
      const dialog = dialogs.at(-1);
      const candidates: Array<{ element: Element; where: RawElement["where"]; interactive: boolean }> = [];
      for (const element of walk(document.documentElement)) {
        const interactive = element.matches(INTERACTIVE);
        const heading = !interactive && element.matches(HEADINGS) && headingLevel(element) <= 3;
        const frame = element.tagName === "IFRAME";
        if (!interactive && !heading && !frame) continue;
        if (!shown(element) || element.closest("[aria-hidden='true'], [inert]")) continue;
        const rect = element.getBoundingClientRect();
        const hiddenToggle = element instanceof HTMLInputElement && !!element.labels?.length;
        if (rect.width * rect.height === 0 && !hiddenToggle) continue;
        if (frame && rect.width * rect.height < 150 * 150) continue;
        // Carousel items off to the side can't be reached by scrolling the page.
        if (rect.right < 0 || rect.left > innerWidth) continue;
        const where = dialog && within(element, dialog) ? "dialog" : rect.bottom < 0 ? "above" : rect.top > innerHeight ? "below" : "view";
        candidates.push({ element, where, interactive });
      }
      // What's in the dialog and on screen matters most; then what's just below.
      const order = { dialog: 0, view: 1, below: 2, above: 3 } as const;
      const chosen = new Set(candidates.toSorted((a, b) => order[a.where] - order[b.where]).slice(0, MAX_ELEMENTS));
      const elements = candidates.filter((candidate) => chosen.has(candidate))
        .map(({ element, where, interactive }) => describe(element, where, interactive ? refFor(element) : undefined));
      const name = dialog && (clip(dialog.getAttribute("aria-label")) ?? byIds(dialog, "aria-labelledby") ?? clip(dialog.querySelector("h1, h2, h3, [role='heading']")?.textContent) ?? "");
      return {
        doc,
        url: location.href,
        title: document.title,
        ...(name !== undefined ? { dialog: name } : {}),
        elements,
        ...(read ? readText() : {}),
      };
    },

    target(wanted, ref) {
      const element = resolve(wanted, ref);
      if ("failed" in element) return element;
      if (isFile(element)) return { failed: "file" };
      const point = aim(element);
      if ("failed" in point) return point;
      if (pending) removeEventListener("mousedown", pending.listener, true);
      const entry = { element, landed: false, listener: (_: Event) => {} };
      entry.listener = (event) => { if (event.composedPath().some((node) => node instanceof Node && within(node, element))) entry.landed = true; };
      pending = entry;
      addEventListener("mousedown", entry.listener, true);
      return point;
    },

    landed() {
      if (!pending) return;
      removeEventListener("mousedown", pending.listener, true);
      if (!pending.landed && pending.element.isConnected && pending.element instanceof HTMLElement) pending.element.click();
      pending = null;
    },

    field(wanted, ref) {
      const element = ref === null ? focused() : resolve(wanted, ref);
      if (!element || element === document.body) return { failed: "failed", detail: "no field is focused; give the field's number as ref" };
      if ("failed" in element) return element;
      if (isSecret(element)) return { failed: "password" };
      if (isFile(element)) return { failed: "file" };
      if (element instanceof HTMLSelectElement) return { kind: "select" };
      if (ref === null) return { kind: "focused" };
      const point = aim(element);
      return "failed" in point ? point : { kind: "field", ...point };
    },

    prepare(wanted, ref) {
      const element = ref === null ? focused() : resolve(wanted, ref);
      if (!element) return { failed: "gone" };
      if ("failed" in element) return element;
      if (ref !== null && !within(focused(), element)) (element as HTMLElement).focus();
      // A custom field can hand focus to an input inside it: that's where the text goes.
      const active = focused() ?? element;
      if (isSecret(active)) return { failed: "password" };
      if (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement) active.select();
      else if (active instanceof HTMLElement && active.isContentEditable) getSelection()?.selectAllChildren(active);
      return { ok: true };
    },

    choose(wanted, ref, option) {
      const element = ref === null ? focused() : resolve(wanted, ref);
      if (!element) return { failed: "gone" };
      if ("failed" in element) return element;
      if (!(element instanceof HTMLSelectElement)) return { failed: "failed", detail: "that element is not a dropdown list" };
      const plain = (text: string) => text.normalize("NFD").replace(/\p{Diacritic}/gu, "").replace(/\s+/g, " ").trim().toLowerCase();
      const wantedText = plain(option);
      const options = Array.from(element.options);
      const match = options.find((each) => plain(each.text) === wantedText || plain(each.value) === wantedText) ?? options.find((each) => plain(each.text).includes(wantedText));
      if (!match) return { failed: "noOption", detail: options.slice(0, 20).map((each) => `"${clip(each.text, 60) ?? each.value}"`).join(", ") };
      if (element.multiple) match.selected = true;
      else element.value = match.value;
      element.dispatchEvent(new Event("input", { bubbles: true }));
      element.dispatchEvent(new Event("change", { bubbles: true }));
      return { ok: true };
    },

    secretFocused: () => isSecret(focused()),

    center: () => ({ x: Math.round(innerWidth / 2), y: Math.round(innerHeight / 2), height: innerHeight }),
  };
}

globalThis.__lilith ??= create();
