// One computer turn's use of the browser: which tab she's on, which element numbers she has seen,
// and the guards that turn a small model's typical mistakes into a message instead of a wrong click.
// The extension executes; every word the model reads about the browser is written here.

import { checkedUrl } from "../open.ts";
import { elementLine, formatLook, nameOf, roleOf, type Formatted } from "./format.ts";
import { browserKeys } from "./keys.ts";
import type { ErrorCode, Inputs, Op, Output, RawElement } from "./protocol.ts";

/** A connected, paired browser (hub.ts). */
export interface BrowserLink {
  call<K extends Op>(op: K, input: Inputs[K], signal?: AbortSignal): Promise<Output<K>>;
  /** The player cancelled Chrome's "is debugging this browser" bar. Returns the unsubscribe. */
  onStop(listener: () => void): () => void;
}

export class BrowserError extends Error {
  override readonly name = "BrowserError";

  constructor(readonly code: ErrorCode, readonly detail?: string, readonly element?: RawElement) {
    super(detail ? `${code}: ${detail}` : code);
  }
}

/** What the model asked the browser tool for (open_url arrives through `open`). */
export type BrowserAction =
  | { op: "click"; ref: number }
  /** `ref: null` types into the focused field. */
  | { op: "type"; ref: number | null; text: string; submit: boolean }
  | { op: "key"; keys: string }
  | { op: "scroll"; direction: "up" | "down" }
  /** Only looks: `read` swaps the next page's elements for its text; `look` just shows it again. */
  | { op: "read" | "look" | "back" }
  | { op: "switchTab"; tab: number }
  | { op: "closeTab"; tab: number | null };

/** The page after a batch: text for every model, a picture of the tab for those that see. */
export interface Observation {
  page: string;
  image?: Uint8Array;
  /** Identical to the previous observation (null for the first): the action changed nothing. */
  same: boolean | null;
}

export class BrowserSession {
  /** The tab she's on. Null until the first look, which picks the tab the player is on. */
  #tab: number | null = null;
  #shown: Formatted["shown"] = null;
  /** Tab ids by the numbers she was shown. */
  #tabs: number[] = [];
  /** Tabs in her group: the ones she may close. */
  #mine = new Set<number>();
  #read = false;
  #lastPage: number | bigint | undefined;
  #used = false;

  constructor(private readonly link: BrowserLink, private readonly options: { vision: boolean }) {}

  onStop(listener: () => void): () => void {
    return this.link.onStop(listener);
  }

  /** open_url: a new tab in her group, or her current tab when it's already hers. */
  async open(url: string, signal: AbortSignal): Promise<string> {
    const target = checkedUrl(url);
    const reuse = this.#tab !== null && this.#mine.has(this.#tab) ? this.#tab : null;
    const { tab } = await this.#call("open", { url: target, reuse }, signal);
    this.#tab = tab;
    this.#mine.add(tab);
    return reuse === null ? "Opened in a new tab." : "Opened.";
  }

  async run(action: BrowserAction, signal: AbortSignal): Promise<string> {
    switch (action.op) {
      case "look": return "OK";
      case "read": this.#read = true; return "OK";
      case "click": {
        const doc = this.#seen(action.ref);
        return this.#follow((await this.#call("click", { tab: await this.#current(signal), doc, ref: action.ref }, signal, action.ref)).opened) ?? "Clicked.";
      }
      case "type": {
        const doc = action.ref === null ? null : this.#seen(action.ref);
        const input = { tab: await this.#current(signal), doc, ref: action.ref, text: action.text, submit: action.submit };
        return this.#follow((await this.#call("type", input, signal, action.ref ?? undefined)).opened) ?? (action.submit ? "Typed and pressed Enter." : "Typed.");
      }
      case "key": {
        const events = browserKeys(action.keys);
        return this.#follow((await this.#call("key", { tab: await this.#current(signal), events }, signal)).opened) ?? "Pressed.";
      }
      case "scroll":
        await this.#call("scroll", { tab: await this.#current(signal), direction: action.direction }, signal);
        return "Scrolled.";
      case "back":
        await this.#call("back", { tab: await this.#current(signal) }, signal);
        return "Went back.";
      case "switchTab": {
        const tab = this.#numbered(action.tab);
        await this.#call("activate", { tab }, signal);
        this.#tab = tab;
        return `Now on tab ${action.tab}.`;
      }
      case "closeTab": {
        const tab = action.tab === null ? await this.#current(signal) : this.#numbered(action.tab);
        if (!this.#mine.has(tab)) throw new Error("Not closed: that tab isn't one you opened. Only close tabs marked (yours).");
        await this.#call("close", { tab }, signal);
        if (tab === this.#tab) this.#tab = null;
        return "Closed.";
      }
    }
  }

  /** The page after a batch. A tab closed meanwhile falls back to the one the player is on. */
  async observe(signal: AbortSignal): Promise<Observation> {
    const read = this.#read;
    this.#read = false;
    const look = await this.#call("look", { tab: this.#tab, image: this.options.vision, read }, signal).catch(async (error: unknown) => {
      if (!(error instanceof Error && error.cause instanceof BrowserError && error.cause.code === "closed")) throw error;
      this.#tab = null;
      return this.#call("look", { tab: null, image: this.options.vision, read }, signal);
    });
    this.#tab = look.tab;
    for (const tab of look.tabs) if (tab.mine) this.#mine.add(tab.id);
    const formatted = formatLook(look, { read });
    this.#tabs = formatted.tabs;
    // Read text replaces the elements on screen, but the ones she saw before are still there.
    if (formatted.shown || "unavailable" in look.page) this.#shown = formatted.shown;
    const page = Bun.hash(formatted.text);
    const same = this.#lastPage === undefined ? null : page === this.#lastPage;
    this.#lastPage = page;
    return { page: formatted.text, ...(look.image ? { image: Uint8Array.from(Buffer.from(look.image, "base64")) } : {}), same };
  }

  /** The turn is over: Chrome stops showing that it's being debugged. */
  release(): void {
    if (this.#used) this.link.call("release", {}).catch(() => {});
  }

  /** The document of a ref she was shown. Numbers she never saw are guesses. */
  #seen(ref: number): string {
    if (!this.#shown) throw new Error(`Not executed: you haven't seen this page's elements yet, so [${ref}] is a guess. Use a number from the page below.`);
    if (!this.#shown.refs.has(ref)) throw new Error(`Not executed: there is no element [${ref}] on the page you saw. Use a number from the page below.`);
    return this.#shown.doc;
  }

  #numbered(number: number): number {
    const tab = this.#tabs[number - 1];
    if (tab === undefined) throw new Error(`There is no tab ${number}. The tabs are numbered at the top of the page.`);
    return tab;
  }

  /** Her tab. Before her first look, it's the tab the player is on. */
  async #current(signal: AbortSignal): Promise<number> {
    this.#tab ??= (await this.#call("look", { tab: null, image: false, read: false }, signal)).tab;
    return this.#tab;
  }

  /** A click that opened a tab takes her there, as it would take the player. */
  #follow(opened: number | undefined): string | undefined {
    if (opened === undefined) return undefined;
    this.#tab = opened;
    this.#mine.add(opened);
    return "It opened a new tab, which you're on now.";
  }

  async #call<K extends Op>(op: K, input: Inputs[K], signal: AbortSignal, ref?: number): Promise<Output<K>> {
    this.#used = true;
    try {
      return await this.link.call(op, input, signal);
    } catch (error) {
      if (!(error instanceof BrowserError)) throw error;
      // What covers a target gets a number of its own, so she can deal with it.
      if (error.code === "covered" && error.element?.ref && this.#shown) this.#shown = { ...this.#shown, refs: new Set([...this.#shown.refs, error.element.ref]) };
      throw new Error(explain(error, ref), { cause: error });
    }
  }
}

function explain(error: BrowserError, ref: number | undefined): string {
  const it = ref === undefined ? "that element" : `[${ref}]`;
  switch (error.code) {
    case "noWindow": return "No browser window is open. Open a website with open_url.";
    case "closed": return "That tab was closed. The tabs left are at the top of the page below.";
    case "unavailable": return "This tab can't be used: it's a browser page or Lilith's settings. Open a website with open_url.";
    case "stale": return "Not executed: a new page loaded since you last saw it, so that number belonged to the old page. Use the numbers from the page below.";
    case "gone": return `Not executed: ${it} is no longer on the page. Use the page below.`;
    case "covered": {
      // A numbered element reads as its line; a dialog's backdrop by its role and name.
      const cover = error.element && (elementLine(error.element) ?? [roleOf(error.element), nameOf(error.element) && `"${nameOf(error.element)}"`].filter(Boolean).join(" "));
      return `Not clicked: ${it} is behind another element${cover ? `, ${cover}` : ""}. Close or use that first.`;
    }
    case "password": return "Not typed: that is a password field. Never type passwords: ask your host to log in themselves, then continue.";
    case "file": return "Not clicked: that opens a file chooser. Ask your host to choose the file themselves.";
    case "noOption": return `Not chosen: ${it} has no option like that.${error.detail ? ` Its options are: ${error.detail}.` : ""}`;
    case "noHistory": return "There is no previous page in this tab.";
    case "notYours": return "Not closed: that tab isn't one you opened. Only close tabs marked (yours).";
    case "failed": return `The browser could not do that${error.detail ? `: ${error.detail}` : ""}.`;
  }
}
