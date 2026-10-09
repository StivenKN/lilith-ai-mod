// The extension's service worker. It connects to Lilith AI Companion on this PC, pairs with the
// secret the companion wrote into this folder, and does what the companion asks in the browser:
// look at a tab, open a page, click or type into element 12, press keys, scroll.
//
// Input goes through Chrome's debugger protocol, so it reaches the page as real clicks and typing
// without moving the player's mouse. While it's attached, Chrome shows its "is debugging this
// browser" bar; cancelling it stops Lilith. Pages she opens go into a "Lilith" tab group.

import type { CompanionMessage, ErrorCode, ExtensionMessage, Inputs, KeyEvent, Look, Op, Output, RawElement, Tab } from "../src/browser/protocol.ts";
import { BROWSER_PROTOCOL, DASHBOARD_PORTS, isDashboard, pairingProof, randomHex, sameProof } from "../src/browser/shared.ts";
import type { Failure, PageApi } from "./page.ts";

const manifest = chrome.runtime.getManifest();
const VERSION = manifest.version_name ?? manifest.version;
const GROUP = "Lilith";
const spanish = navigator.language.toLowerCase().startsWith("es");

interface Connection {
  port: number;
  socket: WebSocket;
  nonce: string;
  /** The companion proved it knows the secret. */
  trusted: boolean;
  ready: boolean;
  /** Tabs this companion had debugged, released when it's done or gone. */
  tabs: Set<number>;
  /** Calls received and not started. A cancelled call leaves this set and never runs. */
  queued: Set<number>;
  /** The player cancelled the debugging bar: nothing attaches again until the turn is released. */
  halted: boolean;
}

const connections = new Map<number, Connection>();
/** Tabs with the debugger attached, and messages of dialogs dismissed there since the last look. */
const debugged = new Set<number>();
const alerts = new Map<number, string>();
/** One thing at a time: two companions, or two calls, never interleave clicks and typing. */
let queue: Promise<unknown> = Promise.resolve();

class Refusal extends Error {
  constructor(readonly code: ErrorCode, readonly detail?: string, readonly element?: RawElement) {
    super(detail ?? code);
  }
}
const refuse = (failure: Failure) => new Refusal(failure.failed, failure.detail, failure.element);

// ── Connection ──────────────────────────────────────────────────────────────

/** The browser's name for the dashboard: "Google Chrome 152", "Microsoft Edge 141", "Brave 1"… */
function browserName(): string {
  const brands = (navigator as Navigator & { userAgentData?: { brands: Array<{ brand: string; version: string }> } }).userAgentData?.brands ?? [];
  const brand = brands.find((each) => !/chromium|not.?a.?brand/i.test(each.brand)) ?? brands.find((each) => /chromium/i.test(each.brand));
  return brand ? `${brand.brand} ${brand.version}` : "Chromium";
}

async function readSecret(): Promise<string | null> {
  try {
    const pairing = (await (await fetch(chrome.runtime.getURL("pairing.json"), { cache: "no-store" })).json()) as { secret?: unknown };
    return typeof pairing.secret === "string" ? pairing.secret : null;
  } catch {
    return null;
  }
}

function send(connection: Connection, message: ExtensionMessage): void {
  if (connection.socket.readyState === WebSocket.OPEN) connection.socket.send(JSON.stringify(message));
}

/**
 * Connects to each companion that listed itself in this folder and isn't connected yet. Knocking
 * on every dashboard port instead would log an error for each closed one on chrome://extensions.
 */
async function scan(): Promise<void> {
  const secret = await readSecret();
  if (!secret) return showStatus();
  const listed = await fetch(chrome.runtime.getURL("companions.json"), { cache: "no-store" }).then((response) => response.json() as Promise<{ ports?: unknown }>).catch(() => ({ ports: [] }));
  const ports = Array.isArray(listed.ports) ? listed.ports.filter((port): port is number => DASHBOARD_PORTS.includes(port)) : [];
  for (const port of ports) if (!connections.has(port)) connect(port, secret);
}

function connect(port: number, secret: string): void {
  const connection: Connection = { port, socket: new WebSocket(`ws://127.0.0.1:${port}/api/browser`), nonce: randomHex(), trusted: false, ready: false, tabs: new Set(), queued: new Set(), halted: false };
  connections.set(port, connection);
  connection.socket.onopen = () => send(connection, { t: "hello", protocol: BROWSER_PROTOCOL, version: VERSION, browser: browserName(), nonce: connection.nonce });
  connection.socket.onmessage = (event) => void receive(connection, secret, JSON.parse(String(event.data)) as CompanionMessage).catch(() => connection.socket.close());
  connection.socket.onclose = () => {
    connections.delete(port);
    void release(connection);
    showStatus();
  };
}

async function receive(connection: Connection, secret: string, message: CompanionMessage): Promise<void> {
  switch (message.t) {
    case "challenge": {
      // The port we dialed is part of the proof, so a companion's proof relayed from another port fails.
      const handshake = { companion: message.nonce, extension: connection.nonce, port: connection.port };
      // Anything else listening on the port gets nothing: not even a proof of our own.
      if (!sameProof(message.proof, await pairingProof(secret, "companion", handshake))) return connection.socket.close();
      connection.trusted = true;
      return send(connection, { t: "proof", proof: await pairingProof(secret, "extension", handshake) });
    }
    case "ready": {
      if (!connection.trusted) return connection.socket.close();
      if (message.reload) {
        // The companion wrote a newer version into this folder. Once per version: a copy loaded
        // from another folder would otherwise reload forever.
        const { reloadedFor } = await chrome.storage.local.get("reloadedFor");
        if (reloadedFor !== VERSION) {
          await chrome.storage.local.set({ reloadedFor: VERSION });
          return chrome.runtime.reload();
        }
        return;
      }
      connection.ready = true;
      return showStatus();
    }
    case "cancel": {
      connection.queued.delete(message.id);
      return;
    }
    case "call": {
      if (!connection.ready) return;
      const call = message;
      connection.queued.add(call.id);
      queue = queue.then(async () => {
        // Cancelled, past the companion's patience, or dropped when the player stopped her: never late.
        if (!connection.queued.delete(call.id) || Date.now() > call.deadline) return;
        try {
          // Bounded by the deadline too, so one stuck call can't hold up every one after it.
          const output = await withTimeout((ops[call.op] as (connection: Connection, input: unknown) => Promise<unknown>)(connection, call.input), call.deadline - Date.now());
          send(connection, { t: "result", id: call.id, output });
        } catch (error) {
          const refusal = error instanceof Refusal ? error : new Refusal("failed", error instanceof Error ? error.message : String(error));
          send(connection, { t: "failed", id: call.id, code: refusal.code, ...(refusal.detail ? { detail: refusal.detail.slice(0, 2000) } : {}), ...(refusal.element ? { element: refusal.element } : {}) });
        }
      });
    }
  }
}

function showStatus(): void {
  const ready = [...connections.values()].some((connection) => connection.ready);
  void chrome.action.setBadgeText({ text: ready ? "on" : "" });
  void chrome.action.setBadgeBackgroundColor({ color: "#f06a8a" });
  void chrome.action.setTitle({
    title: ready
      ? spanish ? "Lilith: conectada" : "Lilith: connected"
      : spanish ? "Lilith: sin conexión. Abre el juego o LilithAICompanion.exe; haz clic para reintentar." : "Lilith: not connected. Start the game or LilithAICompanion.exe; click to retry.",
  });
}

// ── Tabs ────────────────────────────────────────────────────────────────────

const pageUrl = (tab: chrome.tabs.Tab) => tab.url || tab.pendingUrl || "";
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([promise, sleep(ms).then(() => { throw new Error("the browser or the page took too long"); })]);
}

/** Pages the companion may use: http(s), never its own dashboard. */
function access(url: string): "ok" | "browser" | "dashboard" {
  try {
    const parsed = new URL(url);
    if (isDashboard(parsed)) return "dashboard";
    return /^https?:$/.test(parsed.protocol) ? "ok" : "browser";
  } catch {
    return "browser";
  }
}

/** The tab the player is on: the active tab of the window they used last. */
async function playerTab(): Promise<chrome.tabs.Tab> {
  const window = await chrome.windows.getLastFocused({ windowTypes: ["normal"] }).catch(() => null);
  const [tab] = window?.id === undefined ? [] : await chrome.tabs.query({ active: true, windowId: window.id });
  if (!tab?.id) throw new Refusal("noWindow");
  return tab;
}

async function tabById(id: number): Promise<chrome.tabs.Tab> {
  const tab = await chrome.tabs.get(id).catch(() => null);
  if (!tab?.id) throw new Refusal("closed");
  return tab;
}

/**
 * A tab she may act on: an http(s) page. Looking, reading, keys and pictures work in a background
 * tab, so the player keeps the tab they're on. The mouse doesn't: a hidden tab drops pointer
 * input, so for the mouse (`front`) her tab becomes the shown one in its window.
 */
async function usable(id: number, front = false): Promise<chrome.tabs.Tab & { id: number }> {
  const tab = await tabById(id);
  if (access(pageUrl(tab)) !== "ok") throw new Refusal("unavailable");
  if (front && !tab.active) {
    await chrome.tabs.update(id, { active: true });
    await sleep(150);
  }
  return { ...tab, id };
}

async function groupIds(windowId: number): Promise<Set<number>> {
  return new Set((await chrome.tabGroups.query({ windowId, title: GROUP })).map((group) => group.id));
}

async function groupInto(tabId: number): Promise<void> {
  const tab = await tabById(tabId);
  const [group] = await groupIds(tab.windowId);
  if (group !== undefined) await chrome.tabs.group({ groupId: group, tabIds: tabId });
  else await chrome.tabGroups.update(await chrome.tabs.group({ tabIds: tabId, createProperties: { windowId: tab.windowId } }), { title: GROUP, color: "pink" });
}

/** Waits for a tab to finish loading, but never fails: a slow page still has something to see. */
async function loaded(tabId: number, ms: number): Promise<void> {
  await new Promise<void>((resolve) => {
    const done = () => { clearTimeout(timer); chrome.tabs.onUpdated.removeListener(update); resolve(); };
    const update = (id: number, change: { status?: string }) => { if (id === tabId && change.status === "complete") done(); };
    const timer = setTimeout(done, ms);
    chrome.tabs.onUpdated.addListener(update);
    void chrome.tabs.get(tabId).then((tab) => { if (tab.status === "complete") done(); }, done);
  });
}

/** Runs input on a tab, then waits for what it started: a page load, or a new tab she follows. */
async function settle(tabId: number, input: () => Promise<void>): Promise<{ opened?: number }> {
  let opened: number | undefined;
  const created = (tab: chrome.tabs.Tab) => { if (tab.openerTabId === tabId && tab.id !== undefined) opened ??= tab.id; };
  chrome.tabs.onCreated.addListener(created);
  try {
    await input();
    await sleep(350);
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (tab?.status === "loading") await loaded(tabId, 15_000);
  } finally {
    chrome.tabs.onCreated.removeListener(created);
  }
  if (opened === undefined) return {};
  await groupInto(opened).catch(() => {});
  await loaded(opened, 15_000);
  return { opened };
}

// ── Pages ───────────────────────────────────────────────────────────────────

/**
 * Calls page.ts in the tab, injecting it the first time. Bounded, because a page held by a dialog
 * never answers (dialogs her own input opens are dismissed through the debugger, see below).
 */
async function inPage<M extends keyof PageApi>(tabId: number, method: M, ...args: Parameters<PageApi[M]>): Promise<ReturnType<PageApi[M]>> {
  const run = async () => (await chrome.scripting.executeScript({
    target: { tabId },
    func: (name: string, values: unknown[]) => {
      const api = globalThis.__lilith as unknown as Record<string, (...args: unknown[]) => unknown> | undefined;
      return api ? { value: api[name]!(...values) } : null;
    },
    args: [method, args],
  }))[0]?.result;
  let result = await withTimeout(run(), 8_000);
  if (!result) {
    await withTimeout(chrome.scripting.executeScript({ target: { tabId }, files: ["page.js"] }), 8_000);
    result = await withTimeout(run(), 8_000);
  }
  if (!result) throw new Error("the page didn't answer");
  return result.value as ReturnType<PageApi[M]>;
}

async function cdp<T = Record<string, unknown>>(tabId: number, method: string, params?: { [key: string]: unknown }): Promise<T> {
  return (await withTimeout(chrome.debugger.sendCommand({ tabId }, method, params), 5_000)) as T;
}

/** Attaches the debugger once per tab. The bar Chrome shows then takes room from the page, so it settles first. */
async function debug(connection: Connection, tabId: number): Promise<void> {
  if (connection.halted) throw new Refusal("failed", "the player stopped Lilith");
  connection.tabs.add(tabId);
  if (debugged.has(tabId)) return;
  await chrome.debugger.attach({ tabId }, "1.3");
  debugged.add(tabId);
  await cdp(tabId, "Page.enable");
  await sleep(200);
}

/** Detaches from the tabs this companion used, unless another one still uses them. */
async function release(connection: Connection): Promise<void> {
  for (const tabId of connection.tabs) {
    if ([...connections.values()].some((other) => other !== connection && other.tabs.has(tabId))) continue;
    debugged.delete(tabId);
    await chrome.debugger.detach({ tabId }).catch(() => {});
  }
  connection.tabs.clear();
}

async function click(tabId: number, { x, y }: { x: number; y: number }): Promise<void> {
  await cdp(tabId, "Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
  await cdp(tabId, "Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
  await cdp(tabId, "Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
}

async function press(tabId: number, events: readonly KeyEvent[]): Promise<void> {
  for (const event of events) {
    if (event.type === "insertText") await cdp(tabId, "Input.insertText", { text: event.text });
    else await cdp(tabId, "Input.dispatchKeyEvent", event);
  }
}

/** A picture of the tab, at most 1024 px wide. A window hidden behind others may not paint: then there's none. */
async function screenshot(connection: Connection, tabId: number): Promise<string | undefined> {
  try {
    await debug(connection, tabId);
    const { cssVisualViewport: view } = await cdp<{ cssVisualViewport: { pageX: number; pageY: number; clientWidth: number; clientHeight: number } }>(tabId, "Page.getLayoutMetrics");
    const scale = Math.min(1, 1024 / Math.max(view.clientWidth, view.clientHeight));
    const clip = { x: view.pageX, y: view.pageY, width: view.clientWidth, height: view.clientHeight, scale };
    return (await withTimeout(cdp<{ data: string }>(tabId, "Page.captureScreenshot", { format: "png", clip }), 3_000)).data;
  } catch {
    return undefined;
  }
}

async function tabsOf(windowId: number): Promise<Tab[]> {
  const groups = await groupIds(windowId);
  return (await chrome.tabs.query({ windowId })).flatMap((tab) => tab.id === undefined ? [] : [{
    id: tab.id, title: tab.title ?? "", url: pageUrl(tab), mine: groups.has(tab.groupId), active: tab.active,
  }]);
}

// ── Calls ───────────────────────────────────────────────────────────────────

const ops: { [K in Op]: (connection: Connection, input: Inputs[K]) => Promise<Output<K>> } = {
  async look(connection, { tab, image, read }) {
    const target = tab === null ? await playerTab() : await tabById(tab);
    const id = target.id!;
    const kind = access(pageUrl(target));
    let page: Look["page"];
    if (kind !== "ok") page = { unavailable: kind };
    else {
      try { page = await inPage(id, "look", read); }
      // The Web Store and a few other pages refuse every extension.
      catch (error) {
        if (!(error instanceof Error && /cannot be scripted|cannot access|extensions gallery/i.test(error.message))) throw error;
        page = { unavailable: "browser" };
      }
    }
    const picture = image && !("unavailable" in page) ? await screenshot(connection, id) : undefined;
    const alert = alerts.get(id);
    alerts.delete(id);
    return { tab: id, tabs: await tabsOf(target.windowId), page, ...(picture ? { image: picture } : {}), ...(alert ? { alert } : {}) };
  },

  async open(_, { url, reuse }) {
    if (access(url) !== "ok") throw new Refusal("unavailable");
    const existing = reuse === null ? null : await chrome.tabs.get(reuse).catch(() => null);
    let id: number | undefined;
    if (existing?.id !== undefined) id = (await chrome.tabs.update(existing.id, { url, active: true }))?.id;
    else {
      const window = await chrome.windows.getLastFocused({ windowTypes: ["normal"] }).catch(() => null);
      id = window?.id !== undefined
        ? (await chrome.tabs.create({ windowId: window.id, url, active: true })).id
        : (await chrome.windows.create({ url, focused: false }))?.tabs?.[0]?.id;
      if (id !== undefined) await groupInto(id);
    }
    if (id === undefined) throw new Refusal("noWindow");
    await sleep(300);
    await loaded(id, 15_000);
    return { tab: id };
  },

  async click(connection, { tab, doc, ref }) {
    const target = await usable(tab, true);
    await debug(connection, target.id);
    const point = await inPage(target.id, "target", doc, ref);
    if ("failed" in point) throw refuse(point);
    return settle(target.id, async () => {
      await click(target.id, point).catch(() => {});
      // A link may already be taking the page away.
      await inPage(target.id, "landed").catch(() => {});
    });
  },

  async type(connection, { tab, doc, ref, text, submit }) {
    const target = await usable(tab, ref !== null);
    await debug(connection, target.id);
    const field = await inPage(target.id, "field", doc, ref);
    if ("failed" in field) throw refuse(field);
    if (field.kind === "select") {
      const chosen = await inPage(target.id, "choose", doc, ref, text);
      if ("failed" in chosen) throw refuse(chosen);
      return {};
    }
    return settle(target.id, async () => {
      if (field.kind === "field") await click(target.id, field);
      const ready = await inPage(target.id, "prepare", doc, ref);
      if ("failed" in ready) throw refuse(ready);
      await cdp(target.id, "Input.insertText", { text });
      if (submit) await press(target.id, [
        { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, modifiers: 0, text: "\r" },
        { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, modifiers: 0 },
      ]);
    });
  },

  async key(connection, { tab, events }) {
    const target = await usable(tab);
    await debug(connection, target.id);
    const types = events.some((event) => event.type === "insertText" || (event.type === "keyDown" && event.text && event.text !== "\r"));
    if (types && await inPage(target.id, "secretFocused")) throw new Refusal("password");
    return settle(target.id, () => press(target.id, events));
  },

  async scroll(connection, { tab, direction }) {
    const target = await usable(tab, true);
    await debug(connection, target.id);
    const { x, y, height } = await inPage(target.id, "center");
    await cdp(target.id, "Input.dispatchMouseEvent", { type: "mouseWheel", x, y, deltaX: 0, deltaY: (direction === "down" ? 1 : -1) * Math.round(height * 0.8) });
    // Smooth scrolling, and pages that load more as they're scrolled.
    await sleep(500);
    return {};
  },

  async back(_, { tab }) {
    const target = await usable(tab);
    await chrome.tabs.goBack(target.id).catch(() => { throw new Refusal("noHistory"); });
    await sleep(300);
    await loaded(target.id, 15_000);
    return {};
  },

  async activate(_, { tab }) {
    await tabById(tab);
    await chrome.tabs.update(tab, { active: true });
    return {};
  },

  async close(_, { tab }) {
    const target = await tabById(tab);
    if (!(await groupIds(target.windowId)).has(target.groupId)) throw new Refusal("notYours");
    await chrome.tabs.remove(tab);
    return {};
  },

  async release(connection) {
    await release(connection);
    connection.halted = false;
    return {};
  },
};

// ── Events (registered at the top level, as Manifest V3 requires) ───────────

chrome.debugger.onEvent.addListener((source, method, params) => {
  if (method !== "Page.javascriptDialogOpening" || source.tabId === undefined) return;
  // Dismissed (a confirm's safe answer); she reads its message on her next look.
  alerts.set(source.tabId, String((params as { message?: unknown } | undefined)?.message ?? "").slice(0, 1000));
  void chrome.debugger.sendCommand(source, "Page.handleJavaScriptDialog", { accept: false }).catch(() => {});
});

chrome.debugger.onDetach.addListener((source, reason) => {
  if (source.tabId === undefined) return;
  debugged.delete(source.tabId);
  for (const connection of connections.values()) {
    // The player cancelled the "is debugging this browser" bar: that's how they stop her. What's
    // queued is dropped, and nothing attaches again (bringing the bar back) until the turn ends.
    if (reason === "canceled_by_user" && connection.ready && connection.tabs.has(source.tabId)) {
      connection.queued.clear();
      connection.halted = true;
      send(connection, { t: "stopped" });
    }
    connection.tabs.delete(source.tabId);
  }
});

chrome.windows.onFocusChanged.addListener((windowId) => {
  if (windowId === chrome.windows.WINDOW_ID_NONE) return;
  for (const connection of connections.values()) if (connection.ready) send(connection, { t: "focus" });
});

// Chrome stops an idle service worker after 30 s; traffic on an open WebSocket keeps it running.
setInterval(() => { for (const connection of connections.values()) if (connection.ready) send(connection, { t: "ping" }); }, 20_000);

// While no companion runs, the worker sleeps and this alarm wakes it to look again.
chrome.alarms.onAlarm.addListener(() => void scan());
void chrome.alarms.get("scan").then(async (alarm) => { if (!alarm) await chrome.alarms.create("scan", { periodInMinutes: 0.5 }); });
chrome.action.onClicked.addListener(() => void scan());

showStatus();
void scan();
