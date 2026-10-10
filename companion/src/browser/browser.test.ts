import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MANIFEST_KEY } from "../../extension/build.ts";
import { parseCall } from "../computer/actions.ts";
import { formatLook } from "./format.ts";
import { BrowserHub } from "./hub.ts";
import { installExtension, listCompanion } from "./install.ts";
import { browserKeys } from "./keys.ts";
import type { Inputs, Look, Op, Output, RawElement } from "./protocol.ts";
import { BrowserError, BrowserSession, type BrowserLink } from "./session.ts";
import { EXTENSION_ID, isDashboard, pairingProof, randomHex } from "./shared.ts";

const log = { debug() {}, info() {}, warn() {}, error() {} };
const screen = { width: 1280, height: 720 };
const signal = new AbortController().signal;

const element = (ref: number, facts: Partial<RawElement> = {}): RawElement => ({ ref, tag: "button", text: `Button ${ref}`, where: "view", ...facts });
const look = (elements: RawElement[], extra: Partial<Extract<Look["page"], { doc: string }>> = {}): Look => ({
  tab: 2,
  tabs: [
    { id: 1, title: "Inbox (3) - Gmail", url: "https://mail.google.com/", mine: false, active: false },
    { id: 2, title: "cats - YouTube", url: "https://www.youtube.com/results?search_query=cats", mine: true, active: true },
    { id: 3, title: "Settings", url: "http://127.0.0.1:47321/?t=secret-token", mine: false, active: false },
  ],
  page: { doc: "doc-1", url: "https://www.youtube.com/results?search_query=cats", title: "cats - YouTube", elements, ...extra },
});

describe("pairing", () => {
  test("the manifest key pins the extension ID the companion accepts", () => {
    const hash = createHash("sha256").update(Buffer.from(MANIFEST_KEY, "base64")).digest("hex").slice(0, 32);
    expect(hash.replace(/[0-9a-f]/g, (digit) => String.fromCharCode(97 + parseInt(digit, 16)))).toBe(EXTENSION_ID);
  });

  test("proofs differ by role, nonce and port, so they can't be replayed or relayed", async () => {
    const handshake = { companion: randomHex(), extension: randomHex(), port: 47321 };
    const companion = await pairingProof("secret", "companion", handshake);
    expect(companion).toMatch(/^[0-9a-f]{64}$/);
    expect(await pairingProof("secret", "extension", handshake)).not.toBe(companion);
    expect(await pairingProof("secret", "companion", { ...handshake, extension: randomHex() })).not.toBe(companion);
    expect(await pairingProof("secret", "companion", { ...handshake, port: 47322 })).not.toBe(companion);
    expect(await pairingProof("other", "companion", handshake)).not.toBe(companion);
  });

  test("the dashboard is recognized on every loopback name and port it may use", () => {
    for (const url of ["http://127.0.0.1:47321/", "http://localhost:47340/?t=x", "http://[::1]:47325/", "http://127.1.2.3:47330/api"]) expect(isDashboard(new URL(url))).toBe(true);
    for (const url of ["http://127.0.0.1:8080/", "https://example.com:47321/", "http://localhost/"]) expect(isDashboard(new URL(url))).toBe(false);
  });
});

describe("keys", () => {
  test("Enter types a carriage return, so it submits forms", () => {
    expect(browserKeys("Return")).toEqual([
      { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, modifiers: 0, text: "\r" },
      { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, modifiers: 0 },
    ]);
  });

  test("ctrl+a holds ctrl and sends no text; characters without a key are inserted", () => {
    expect(browserKeys("ctrl+a").map((event) => [event.type, "key" in event ? event.key : event.text, "modifiers" in event ? event.modifiers : null])).toEqual([
      ["rawKeyDown", "Control", 2], ["rawKeyDown", "a", 2], ["keyUp", "a", 2], ["keyUp", "Control", 0],
    ]);
    expect(browserKeys("ñ")).toEqual([{ type: "insertText", text: "ñ" }]);
    expect(browserKeys("shift+Tab")[1]).toMatchObject({ type: "rawKeyDown", key: "Tab", modifiers: 8 });
  });

  test("browser shortcuts are refused with what to use instead", () => {
    for (const keys of ["ctrl+t", "ctrl+w", "alt+Left", "super+d"]) expect(() => browserKeys(keys)).toThrow(/open_url|back|switch_tab/);
    expect(() => browserKeys("volumeup")).toThrow(/does nothing inside a webpage/);
  });
});

describe("page format", () => {
  test("tabs, address and elements, with the dashboard's address never shown", () => {
    const { text, shown, tabs } = formatLook(look([
      element(1, { tag: "input", type: "search", aria: "Search", value: "cats" }),
      element(2, { tag: "a", text: "Funny cats", href: "https://www.youtube.com/watch?v=1" }),
      { tag: "h2", text: "Results", level: 2, where: "view" },
      element(3, { tag: "input", type: "checkbox", label: "Remember me", checked: true }),
      element(4, { tag: "a", text: "", href: "https://www.youtube.com/watch?v=1" }),
    ]), { read: false });
    expect(text).toBe([
      'Tabs: 1 "Inbox (3) - Gmail" · 2 "cats - YouTube" (current, yours) · 3 "Lilith\'s settings"',
      'Page: "cats - YouTube" https://www.youtube.com/results?search_query=cats',
      '[1] searchbox "Search" = "cats"',
      '[2] link "Funny cats"',
      "## Results",
      '[3] checkbox "Remember me" (checked)',
      '[4] link "/watch?v=1"',
    ].join("\n"));
    expect(text).not.toContain("secret-token");
    expect(shown).toEqual({ doc: "doc-1", refs: new Set([1, 2, 3, 4]) });
    expect(tabs).toEqual([1, 2, 3]);
  });

  test("an open dialog comes first; what doesn't fit is counted, and only what was listed is usable", () => {
    const below = Array.from({ length: 80 }, (_, index) => element(10 + index, { tag: "a", text: `Video number ${index}`, where: "below" }));
    const { text, shown } = formatLook(look([element(1, { where: "view" }), element(2, { text: "Accept all", where: "dialog" }), ...below], { dialog: "Before you continue" }), { read: false });
    const lines = text.split("\n");
    expect(lines.slice(2, 6)).toEqual(['A dialog is open: "Before you continue". Deal with it first:', '[2] button "Accept all"', "Behind it:", '[1] button "Button 1"']);
    expect(text.length).toBeLessThanOrEqual(2000);
    expect(lines.at(-1)).toMatch(/^… and \d+ more further down: scroll down to see them\.$/);
    expect(shown!.refs.has(89)).toBe(false);
  });

  test("the page's content comes before a sidebar that precedes it, and menus that don't fit are counted apart", () => {
    const channels = Array.from({ length: 80 }, (_, index) => element(10 + index, { tag: "a", text: `Subscribed channel ${index}`, menu: true }));
    const videos = Array.from({ length: 3 }, (_, index) => element(100 + index, { tag: "a", text: `Video ${index}` }));
    const { text, shown } = formatLook(look([element(1, { role: "combobox", aria: "Search" }), ...channels, ...videos]), { read: false });
    const lines = text.split("\n");
    expect(lines.slice(2, 6)).toEqual(['[1] combobox "Search"', '[100] link "Video 0"', '[101] link "Video 1"', '[102] link "Video 2"']);
    expect(lines[6]).toBe("Menus:");
    expect(shown?.refs.has(10)).toBe(true);
    expect(lines.at(-1)).toMatch(/^… and \d+ more in the site's menus\.$/);
  });

  test("reading swaps the elements for the text, and browser pages can't be used", () => {
    const read = formatLook(look([element(1)], { text: "Line one\n\n\nLine two", more: true }), { read: true });
    expect(read.text).toContain("Text from where the page is scrolled to:\nLine one\nLine two\n… There is more below");
    expect(read.shown).toBeNull();
    const blocked = formatLook({ ...look([]), page: { unavailable: "browser" } }, { read: false });
    expect(blocked.text).toContain("browser page: its content can't be read or used. Open a website with open_url.");
  });
});

/** A browser that answers from a script, recording what it was asked. */
function fakeLink(answers: Partial<{ [K in Op]: (input: Inputs[K]) => Output<K> }> = {}) {
  const calls: Array<{ op: Op; input: unknown }> = [];
  const link: BrowserLink = {
    async call(op, input) {
      calls.push({ op, input });
      const answer = answers[op] as ((input: unknown) => unknown) | undefined;
      if (answer) return answer(input) as never;
      return (op === "look" ? look([element(1), element(2, { tag: "input", type: "password", label: "Password" })]) : op === "open" ? { tab: 7 } : {}) as never;
    },
    onStop: () => () => {},
  };
  return { link, calls };
}

describe("browser session", () => {
  test("numbers she never saw are refused before reaching the browser", async () => {
    const { link, calls } = fakeLink();
    const session = new BrowserSession(link, { vision: false });
    await expect(session.run({ op: "click", ref: 1 }, signal)).rejects.toThrow("haven't seen this page's elements yet");
    await session.observe(signal);
    await expect(session.run({ op: "click", ref: 9 }, signal)).rejects.toThrow("there is no element [9]");
    expect(await session.run({ op: "click", ref: 1 }, signal)).toBe("Clicked.");
    expect(calls.map((call) => call.op)).toEqual(["look", "click"]);
    expect(calls[1]!.input).toEqual({ tab: 2, doc: "doc-1", ref: 1 });
  });

  test("the extension's refusals become instructions the model can follow", async () => {
    const refuse = (code: BrowserError["code"], extra?: RawElement) => () => { throw new BrowserError(code, undefined, extra); };
    const { link } = fakeLink({ type: refuse("password"), click: refuse("covered", element(40, { text: "Accept all" })) });
    const session = new BrowserSession(link, { vision: false });
    await session.observe(signal);
    await expect(session.run({ op: "type", ref: 2, text: "hunter2", submit: false }, signal)).rejects.toThrow("Never type passwords: ask your host to log in");
    await expect(session.run({ op: "click", ref: 1 }, signal)).rejects.toThrow('[1] is behind another element, [40] button "Accept all". Close or use that first.');
    // What covers it gets a number she may use.
    await expect(session.run({ op: "click", ref: 40 }, signal)).rejects.toThrow("behind another element");
  });

  test("open_url reuses her tab, a click that opens a tab is followed, and only her tabs close", async () => {
    const { link, calls } = fakeLink({ click: () => ({ opened: 9 }) });
    const session = new BrowserSession(link, { vision: false });
    expect(await session.open("https://example.com", signal)).toBe("Opened in a new tab.");
    await session.observe(signal);
    expect(await session.open("https://example.org", signal)).toBe("Opened.");
    expect(calls.at(-1)!.input).toEqual({ url: "https://example.org/", reuse: 2 });
    expect(await session.run({ op: "click", ref: 1 }, signal)).toContain("opened a new tab");
    await expect(session.run({ op: "closeTab", tab: 1 }, signal)).rejects.toThrow("isn't one you opened");
    await expect(session.open("http://localhost:47321/", signal)).rejects.toThrow("settings page");
  });

  test("an unchanged page is reported, and a closed tab falls back to the player's", async () => {
    const looked: Array<number | null> = [];
    const { link } = fakeLink({
      open: () => ({ tab: 5 }),
      look: (input) => {
        looked.push(input.tab);
        if (input.tab === 5) throw new BrowserError("closed");
        return look([element(1)]);
      },
    });
    const session = new BrowserSession(link, { vision: false });
    expect((await session.observe(signal)).same).toBeNull();
    expect((await session.observe(signal)).same).toBe(true);
    await session.open("https://example.com", signal);
    expect((await session.observe(signal)).page).toContain('Page: "cats - YouTube"');
    expect(looked).toEqual([null, 2, 5, null]);
  });
});

describe("browser tool parsing", () => {
  const parse = (name: string, input: unknown, browser = true) => parseCall({ id: "1", name, input }, screen, browser);

  test("the browser tool and the names small models use for it", () => {
    expect(parse("browser", { action: "click", ref: 12 })).toEqual({ type: "browser", op: { op: "click", ref: 12 } });
    expect(parse("browser_click", { element: "Search button", ref: "e12" })).toEqual({ type: "browser", op: { op: "click", ref: 12 } });
    expect(parse("click_element_by_index", { index: 4 })).toEqual({ type: "browser", op: { op: "click", ref: 4 } });
    expect(parse("input_text", { index: 3, text: "cats" })).toEqual({ type: "browser", op: { op: "type", ref: 3, text: "cats", submit: false } });
    expect(parse("browser", { action: "type", ref: "[3]", text: "cats", submit: true })).toMatchObject({ op: { op: "type", ref: 3, submit: true } });
    expect(parse("browser_navigate", { url: "youtube.com" })).toEqual({ type: "openUrl", url: "https://youtube.com" });
    expect(parse("browser", { action: "scroll_up" })).toEqual({ type: "browser", op: { op: "scroll", direction: "up" } });
    expect(parse("browser", { action: "extract_content" })).toEqual({ type: "browser", op: { op: "read" } });
    expect(parse("browser", { action: "switch_tab", tab: "2" })).toEqual({ type: "browser", op: { op: "switchTab", tab: 2 } });
  });

  test("a ref means the page: never a desktop click at the cursor", () => {
    expect(parse("click", { ref: 12 })).toEqual({ type: "browser", op: { op: "click", ref: 12 } });
    expect(parse("computer_use", { action: "left_click", ref: "ref_5" })).toEqual({ type: "browser", op: { op: "click", ref: 5 } });
    expect(parse("computer_use", { action: "read" })).toEqual({ type: "browser", op: { op: "read" } });
    expect(parse("click", { ref: 12 }, false)).toEqual({ error: expect.stringContaining("extension isn't connected") });
    expect(parse("computer_use", { action: "left_click", coordinate: [500, 500] })).toMatchObject({ type: "click" });
    expect(parse("browser", { action: "click" })).toEqual({ error: expect.stringContaining("click needs ref") });
  });

  test("a stray number on other tools is no ref, and opening a site needs no extension", () => {
    expect(parse("window", { action: "focus", title: "Chrome", index: 1 })).toEqual({ type: "window", op: "focus", title: "Chrome" });
    expect(parse("open_app", { name: "Spotify", index: 1 })).toEqual({ type: "openApp", name: "Spotify" });
    expect(parse("computer_use", { action: "left_click", x: 10, y: 20, index: 3 })).toMatchObject({ type: "click", at: { x: 13, y: 14 } });
    expect(parse("go_to_url", { url: "example.com" }, false)).toEqual({ type: "openUrl", url: "https://example.com" });
  });

  test("scroll signs follow the field: computer_use pixels up when positive, a page's amount down", () => {
    expect(parse("browser", { action: "scroll", amount: 500 })).toMatchObject({ op: { direction: "down" } });
    expect(parse("browser", { action: "scroll", pixels: 5 })).toMatchObject({ op: { direction: "up" } });
    expect(parse("browser", { action: "scroll", down: false })).toMatchObject({ op: { direction: "up" } });
    expect(parse("browser", { action: "scroll" })).toMatchObject({ op: { direction: "down" } });
  });
});

describe("extension install", () => {
  const files = (marker: string) => async () => new Map([["manifest.json", new TextEncoder().encode(marker)], ["icons/16.png", new Uint8Array([1])]]);

  test("writes the folder once per version, never downgrades, and keeps the pairing secret", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lilith-extension-"));
    try {
      const first = await installExtension(dir, "0.1.0-beta.7", files("beta.7"), log);
      expect(first.secret).toMatch(/^[0-9a-f]{64}$/);
      expect(await readFile(join(dir, "icons", "16.png"))).toEqual(Buffer.from([1]));
      expect((await installExtension(dir, "0.1.0", files("1.0"), log)).secret).toBe(first.secret);
      expect(await readFile(join(dir, "manifest.json"), "utf8")).toBe("1.0");
      await installExtension(dir, "0.1.0-beta.7", files("old"), log);
      expect(await readFile(join(dir, "manifest.json"), "utf8")).toBe("1.0");
      await writeFile(join(dir, "pairing.json"), "{broken");
      expect((await installExtension(dir, "0.1.0", files("1.0"), log)).secret).not.toBe(first.secret);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("companions list themselves for the extension, dropping ones that stopped answering", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lilith-extension-"));
    const listed = async () => JSON.parse(await readFile(join(dir, "companions.json"), "utf8")) as { ports: number[] };
    try {
      await installExtension(dir, "0.1.0", files("1.0"), log);
      expect(await listed()).toEqual({ ports: [] });
      const running = new Set([47321]);
      const answers = async (port: number) => running.has(port);
      await listCompanion(dir, 47321, answers);
      await listCompanion(dir, 47322, answers);
      expect(await listed()).toEqual({ ports: [47321, 47322] });
      // 47321 crashed without unlisting itself; 47322 leaves properly.
      running.clear();
      await listCompanion(dir, 47322, answers, true);
      expect(await listed()).toEqual({ ports: [] });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("hub", () => {
  const origin = `chrome-extension://${EXTENSION_ID}`;

  async function served(version = "0.2.0") {
    const hub = new BrowserHub({ secret: "s".repeat(64), version, log });
    const server = Bun.serve({ port: 0, hostname: "127.0.0.1", websocket: hub.websocket, fetch: (request, server) => hub.upgrade(request, server, true) });
    return { hub, server, url: `ws://127.0.0.1:${server.port}/api/browser` };
  }

  /**
   * Plays the extension's side of pairing: like the real one, it hangs up on a companion that can't
   * prove the secret for the port it dialed (`dialed`, when a relay sits in between).
   */
  async function pair(url: string, secret: string, version = "0.2.0", dialed = Number(new URL(url).port)) {
    // Bun's WebSocket takes headers; the DOM types this project also loads (for the dashboard) don't know them.
    const BunSocket = WebSocket as unknown as new (url: string, options: Bun.WebSocketOptions) => WebSocket;
    const socket = new BunSocket(url, { headers: { origin } });
    const messages: Array<Record<string, unknown>> = [];
    const closed = new Promise<number>((resolve) => { socket.onclose = (event) => resolve(event.code); });
    let next: ((message: Record<string, unknown>) => void) | null = null;
    socket.onmessage = (event) => { const message = JSON.parse(String(event.data)) as Record<string, unknown>; messages.push(message); next?.(message); };
    const received = () => new Promise<Record<string, unknown>>((resolve) => { next = resolve; });
    await new Promise((resolve) => { socket.onopen = resolve; });
    const nonce = randomHex();
    socket.send(JSON.stringify({ t: "hello", protocol: 1, version, browser: "Test Browser 1", nonce }));
    const challenge = await received();
    const handshake = { companion: String(challenge.nonce), extension: nonce, port: dialed };
    if (challenge.proof !== await pairingProof(secret, "companion", handshake)) socket.close();
    else socket.send(JSON.stringify({ t: "proof", proof: await pairingProof(secret, "extension", handshake) }));
    return { socket, messages, closed, received };
  }

  test("webpages can't connect: only the pinned extension's origin", async () => {
    const { server } = await served();
    try {
      const response = await fetch(`http://127.0.0.1:${server.port}/api/browser`, { headers: { origin: "https://evil.example", upgrade: "websocket", connection: "Upgrade", "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==", "sec-websocket-version": "13" } });
      expect(response.status).toBe(403);
    } finally { server.stop(true); }
  });

  test("a proof that doesn't match is refused", async () => {
    const { hub, server, url } = await served();
    try {
      const socket = new (WebSocket as unknown as new (url: string, options: Bun.WebSocketOptions) => WebSocket)(url, { headers: { origin } });
      const closed = new Promise<number>((resolve) => { socket.onclose = (event) => resolve(event.code); });
      socket.onmessage = () => socket.send(JSON.stringify({ t: "proof", proof: "0".repeat(64) }));
      socket.onopen = () => socket.send(JSON.stringify({ t: "hello", protocol: 1, version: "0.2.0", browser: "Forger", nonce: randomHex() }));
      expect(await closed).toBe(4003);
      expect(hub.status()).toMatchObject({ state: "unpaired" });
    } finally { server.stop(true); }
  });

  test("an extension with another secret hangs up and is reported; the right one pairs and carries calls", async () => {
    const { hub, server, url } = await served();
    try {
      const stranger = await pair(url, "t".repeat(64));
      await stranger.closed;
      await Bun.sleep(20);
      expect(hub.status()).toMatchObject({ state: "unpaired" });
      expect(hub.current()).toBeNull();

      const extension = await pair(url, "s".repeat(64));
      expect(await extension.received()).toEqual({ t: "ready", reload: false });
      expect(hub.status()).toEqual({ state: "connected", browser: "Test Browser 1", version: "0.2.0" });

      const link = hub.current()!;
      const pending = link.call("open", { url: "https://example.com/", reuse: null });
      const call = await extension.received();
      extension.socket.send(JSON.stringify({ t: "result", id: call.id, output: { tab: 4 } }));
      expect(await pending).toEqual({ tab: 4 });

      const refused = link.call("close", { tab: 1 });
      const second = await extension.received();
      extension.socket.send(JSON.stringify({ t: "failed", id: second.id, code: "notYours" }));
      await expect(refused).rejects.toMatchObject({ code: "notYours" });

      let stopped = false;
      link.onStop(() => { stopped = true; });
      extension.socket.send(JSON.stringify({ t: "stopped" }));
      await Bun.sleep(20);
      expect(stopped).toBe(true);
      extension.socket.close();
    } finally { server.stop(true); }
  });

  test("a handshake relayed from another port fails, even with the right secret", async () => {
    const { hub, server, url } = await served();
    try {
      // The extension dialed a stranger on 47399, which passed its hello on to the real companion.
      const relayed = await pair(url, "s".repeat(64), "0.2.0", 47399);
      await relayed.closed;
      expect(hub.current()).toBeNull();
    } finally { server.stop(true); }
  });

  test("an older extension is told to reload from the folder the companion updated", async () => {
    const { hub, server, url } = await served("0.3.0");
    try {
      const old = await pair(url, "s".repeat(64), "0.2.0");
      expect(await old.received()).toEqual({ t: "ready", reload: true });
      expect(hub.current()).toBeNull();
    } finally { server.stop(true); }
  });
});
