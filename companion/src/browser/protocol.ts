// Messages between the companion and the browser extension, as JSON over the /api/browser
// WebSocket. The companion parses what the extension sends with zod (pages are untrusted text);
// the extension imports types only and trusts a companion that proved it knows the pairing secret.
//
//   extension → hello{protocol, version, browser, nonce}
//   companion → challenge{nonce, proof}     the companion proves first: a stranger on the port learns nothing
//   extension → proof{proof}
//   companion → ready{reload}                then calls, until the socket closes
//
// Calls are primitives (look at a tab, click ref 12 in document D…). Model-facing wording, guards
// and formatting stay in the companion (session.ts, format.ts), where bun test covers them.

import { z } from "zod";

const text = (max: number) => z.string().max(max);

/** What the page script reports about one element. format.ts turns it into a line like `[12] button "Search"`. */
export const RawElement = z.object({
  /** Interactive elements only. Headings and frames are listed for orientation, without a number. */
  ref: z.number().int().positive().optional(),
  tag: text(40),
  type: text(40).optional(),
  role: text(40).optional(),
  aria: text(300).optional(),
  label: text(300).optional(),
  text: text(300).optional(),
  alt: text(300).optional(),
  title: text(300).optional(),
  placeholder: text(300).optional(),
  /** Never sent for password fields. */
  value: text(300).optional(),
  href: text(500).optional(),
  checked: z.boolean().optional(),
  disabled: z.boolean().optional(),
  expanded: z.boolean().optional(),
  selected: z.boolean().optional(),
  focused: z.boolean().optional(),
  level: z.number().int().min(1).max(6).optional(),
  /** In an open dialog, in the viewport, or scrolled past it. */
  where: z.enum(["dialog", "view", "above", "below"]),
});
export type RawElement = z.infer<typeof RawElement>;

export const PageFacts = z.object({
  /** Random per document. Refs belong to one document, so an action names the one the model saw. */
  doc: text(64),
  url: text(4000),
  title: text(1000),
  /** Name of an open modal dialog ("" when it has none). Its elements come first. */
  dialog: text(300).optional(),
  elements: z.array(RawElement).max(600),
  /** With `read`: the page's text from where it is scrolled to, and whether there is more below. */
  text: text(20_000).optional(),
  more: z.boolean().optional(),
});
export type PageFacts = z.infer<typeof PageFacts>;

export const Tab = z.object({
  id: z.number().int(),
  title: text(1000),
  url: text(4000),
  /** In her "Lilith" tab group: opened by her, so she may close it. */
  mine: z.boolean(),
  active: z.boolean(),
});
export type Tab = z.infer<typeof Tab>;

const Look = z.object({
  /** The tab looked at, and its window's tabs in order. */
  tab: z.number().int(),
  tabs: z.array(Tab).max(500),
  /** `unavailable`: a browser page extensions can't enter, or Lilith's own dashboard. */
  page: z.union([PageFacts, z.object({ unavailable: z.enum(["browser", "dashboard"]) })]),
  /** Base64 PNG of the tab, for models that can see. Missing when the browser didn't paint it in time. */
  image: z.string().optional(),
  /** A JavaScript dialog (alert, confirm) the page opened, which was dismissed. */
  alert: text(1000).optional(),
});
export type Look = z.infer<typeof Look>;

/** One key event for CDP's Input.dispatchKeyEvent, or text inserted as typed. Resolved in browser/keys.ts. */
export type KeyEvent =
  | { type: "rawKeyDown" | "keyDown" | "keyUp"; key: string; code: string; windowsVirtualKeyCode: number; modifiers: number; text?: string }
  | { type: "insertText"; text: string };

/** What each call takes. Tabs are Chrome tab ids; `doc` is the document of the refs the model saw. */
export interface Inputs {
  /** `tab: null` looks at the active tab of the last-focused window: the tab the player is on. */
  look: { tab: number | null; image: boolean; read: boolean };
  /** `reuse` navigates that tab (hers) instead of opening a new one. */
  open: { url: string; reuse: number | null };
  click: { tab: number; doc: string; ref: number };
  /** `ref: null` types into the focused field. On a dropdown, `text` names the option to choose. */
  type: { tab: number; doc: string | null; ref: number | null; text: string; submit: boolean };
  key: { tab: number; events: KeyEvent[] };
  scroll: { tab: number; direction: "up" | "down" };
  back: { tab: number };
  activate: { tab: number };
  close: { tab: number };
  /** The turn is over: stop debugging every tab this companion used. */
  release: Record<string, never>;
}
export type Op = keyof Inputs;

/** Input that may have opened a new tab, which she follows. */
const Acted = z.object({ opened: z.number().int().optional() });
const Done = z.object({});

export const outputs = {
  look: Look,
  open: z.object({ tab: z.number().int() }),
  click: Acted,
  type: Acted,
  key: Acted,
  scroll: Done,
  back: Done,
  activate: Done,
  close: Done,
  release: Done,
} satisfies Record<Op, z.ZodType>;
export type Output<K extends Op> = z.infer<(typeof outputs)[K]>;

/** Why a call failed. session.ts words each for the model. */
export const errorCodes = [
  "noWindow", "closed", "unavailable", "stale", "gone", "covered", "password", "file", "noOption", "noHistory", "notYours", "failed",
] as const;
export type ErrorCode = (typeof errorCodes)[number];

export const ExtensionMessage = z.discriminatedUnion("t", [
  z.object({ t: z.literal("hello"), protocol: z.number().int(), version: text(40), browser: text(200), nonce: z.string().regex(/^[0-9a-f]{32}$/) }),
  z.object({ t: z.literal("proof"), proof: z.string().regex(/^[0-9a-f]{64}$/) }),
  /** Keeps the service worker alive: Chrome suspends idle extension workers after 30 s. */
  z.object({ t: z.literal("ping") }),
  /** A window of this browser got focus: with two browsers, the last one used gets the tasks. */
  z.object({ t: z.literal("focus") }),
  /** The player cancelled Chrome's "is debugging this browser" bar. */
  z.object({ t: z.literal("stopped") }),
  z.object({ t: z.literal("result"), id: z.number().int(), output: z.unknown() }),
  /** `element` is what covers a click target, or the dropdown whose options `detail` lists. */
  z.object({ t: z.literal("failed"), id: z.number().int(), code: z.enum(errorCodes), detail: text(2000).optional(), element: RawElement.optional() }),
]);
export type ExtensionMessage = z.input<typeof ExtensionMessage>;

export type CompanionMessage =
  | { t: "challenge"; nonce: string; proof: string }
  /** `reload`: the extension is older than the files the companion wrote; it reloads itself from them. */
  | { t: "ready"; reload: boolean }
  /**
   * `deadline` (Date.now(), one clock on one PC): when the companion stops waiting. A call still
   * queued by then is dropped, so nothing the model already gave up on happens late.
   */
  | { [K in Op]: { t: "call"; id: number; op: K; input: Inputs[K]; deadline: number } }[Op]
  /** The turn was stopped while this call was pending: drop it if it hasn't started. */
  | { t: "cancel"; id: number };
