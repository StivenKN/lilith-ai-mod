#!/usr/bin/env bun
// Drives the run's headless Chrome over the DevTools protocol, one command per call.
// Reads CDP_PORT from the environment (eval "$(session.sh env)").
//
//   cdp.ts open <url>                 navigate and wait for load (use "$LOGIN_URL" first: it sets the session cookie)
//   cdp.ts click <target>             real mouse click on the element's center; confirm() dialogs are accepted
//   cdp.ts type <field> <text>        click a field, select its text and type over it (React sees onChange)
//   cdp.ts press <key>                Enter | Tab | Escape | Backspace | ArrowDown | ArrowUp
//   cdp.ts upload file <file...>      set files on the first <input type=file> (or css=<selector>), as the "Add pictures…" picker does
//   cdp.ts wait <text> [ms]           until the page's visible text contains <text> (default 15000 ms)
//   cdp.ts gone <text> [ms]           until it no longer does
//   cdp.ts text [css=<selector>]      print visible text of the page (or the first match)
//   cdp.ts shot <file.png>            screenshot of the full page
//   cdp.ts eval <js>                  print the value of an expression (reading only; don't drive the UI with it)
//
// <target> and <field> are the user-visible name: exact button/tab/link/summary/label text (or its first
// line, for choices with a hint under the name) or aria-label,
// a field's aria-label, placeholder or <label> text. Prefix with css= for a CSS selector.
// Exits non-zero, with what it saw, when nothing matches.

import { resolve } from "node:path";

const commands = ["open", "click", "type", "press", "upload", "wait", "gone", "text", "shot", "eval"];
if (!commands.includes(process.argv[2] ?? "")) {
  console.error((await Bun.file(import.meta.path).text()).split("\n").slice(1, 20).join("\n"));
  process.exit(2);
}
const port = process.env.CDP_PORT;
if (!port) throw new Error("CDP_PORT is not set: eval \"$(session.sh env)\" first");

type Target = { id: string; type: string; webSocketDebuggerUrl: string };
const targets = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()) as Target[];
const page = targets.find((target) => target.type === "page");
if (!page) throw new Error("no page target in Chrome");

const socket = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  socket.onopen = resolve;
  socket.onerror = reject;
});
let nextId = 1;
const pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>();
const listeners: Array<(method: string, params: any) => void> = [];
socket.onmessage = (event) => {
  const message = JSON.parse(String(event.data));
  if (message.id && pending.has(message.id)) {
    const waiter = pending.get(message.id)!;
    pending.delete(message.id);
    message.error ? waiter.reject(new Error(message.error.message)) : waiter.resolve(message.result);
  } else if (message.method) for (const listener of listeners) listener(message.method, message.params);
};
const send = (method: string, params: Record<string, unknown> = {}): Promise<any> =>
  new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params }));
  });

/** Evaluates in the page and returns the value; page exceptions become errors here. */
async function evaluate<T>(expression: string): Promise<T> {
  const result = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
  return result.result.value as T;
}

// Finds an element by what the user sees. Runs in the page; `kind` picks the candidate set.
const finder = (kind: "clickable" | "field", query: string) => `(() => {
  const query = ${JSON.stringify(query)};
  const visible = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  if (query.startsWith("css=")) return [...document.querySelectorAll(query.slice(4))].find(visible) ?? null;
  const norm = (s) => (s ?? "").replace(/\\s+/g, " ").trim();
  const pool = ${kind === "clickable"
    ? `[...document.querySelectorAll("button, a, [role=tab], [role=button], [role=switch], [role=checkbox], summary, label, input[type=checkbox], input[type=radio], option")]`
    : `[...document.querySelectorAll("input, textarea, select, [contenteditable=true]")]`};
  const names = (el) => [el.getAttribute("aria-label"), el.getAttribute("placeholder"), el.getAttribute("title"),
    ${kind === "clickable" ? "el.innerText, el.innerText?.split(\"\\n\")[0]" : "el.labels?.[0]?.innerText, el.id && document.querySelector('label[for=\"' + el.id + '\"]')?.innerText"}].map(norm);
  return pool.filter(visible).find((el) => names(el).includes(norm(query))) ?? null;
})()`;

/** Where to click: the element's center, scrolled into view first. Throws listing what was there. */
async function locate(kind: "clickable" | "field", query: string): Promise<{ x: number; y: number }> {
  const box = await evaluate<{ x: number; y: number } | null>(`(() => {
    const el = ${finder(kind, query)};
    if (!el) return null;
    el.scrollIntoView({ block: "center" });
    const r = el.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  })()`);
  if (box) return box;
  const seen = await evaluate<string[]>(`[...document.querySelectorAll(${JSON.stringify(kind === "clickable" ? "button, a, [role=tab], summary" : "input, textarea, select")})]
    .map((el) => (el.getAttribute("aria-label") || el.getAttribute("placeholder") || el.innerText || el.id || el.tagName).replace(/\\s+/g, " ").trim()).filter(Boolean).slice(0, 60)`);
  throw new Error(`no ${kind} matching ${JSON.stringify(query)}. On the page: ${JSON.stringify(seen)}`);
}

async function click({ x, y }: { x: number; y: number }): Promise<void> {
  for (const type of ["mousePressed", "mouseReleased"] as const) await send("Input.dispatchMouseEvent", { type, x, y, button: "left", clickCount: 1 });
}

const keys: Record<string, { key: string; code: string; keyCode: number; text?: string }> = {
  Enter: { key: "Enter", code: "Enter", keyCode: 13, text: "\r" },
  Tab: { key: "Tab", code: "Tab", keyCode: 9 },
  Escape: { key: "Escape", code: "Escape", keyCode: 27 },
  Backspace: { key: "Backspace", code: "Backspace", keyCode: 8 },
  ArrowDown: { key: "ArrowDown", code: "ArrowDown", keyCode: 40 },
  ArrowUp: { key: "ArrowUp", code: "ArrowUp", keyCode: 38 },
};

const visibleText = (css?: string) => evaluate<string>(css ? `document.querySelector(${JSON.stringify(css.replace(/^css=/, ""))})?.innerText ?? ""` : "document.body.innerText");

async function waitFor(predicate: () => Promise<boolean>, ms: number, what: string): Promise<void> {
  const deadline = Date.now() + ms;
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error(`timed out after ${ms} ms waiting for ${what}. Page text:\n${(await visibleText()).slice(0, 1500)}`);
    await Bun.sleep(200);
  }
}

const [command, ...args] = process.argv.slice(2);
const arg = (index: number, name: string) => args[index] ?? (() => { throw new Error(`${command}: missing <${name}>`); })();

try {
  await send("Page.enable");
  // Accept confirm()/alert() the way a user clicking OK would ("Clear conversation history", "Uninstall").
  listeners.push((method, params) => {
    if (method === "Page.javascriptDialogOpening") {
      console.log(`[dialog accepted] ${params.message}`);
      void send("Page.handleJavaScriptDialog", { accept: true });
    }
  });
  switch (command) {
    case "open": {
      const loaded = new Promise<void>((resolve) => listeners.push((method) => method === "Page.loadEventFired" && resolve()));
      await send("Page.navigate", { url: arg(0, "url") });
      await Promise.race([loaded, Bun.sleep(15_000)]);
      await Bun.sleep(500); // the React app fetches its overview after load
      console.log(await evaluate<string>("location.href"));
      break;
    }
    case "click":
      await click(await locate("clickable", arg(0, "target")));
      await Bun.sleep(300); // let a dialog or re-render land before the socket closes
      break;
    case "type":
      await click(await locate("field", arg(0, "field")));
      // Select what's there first, so the text replaces it, as select-all then typing does.
      await send("Input.dispatchKeyEvent", { type: "rawKeyDown", key: "a", code: "KeyA", windowsVirtualKeyCode: 65, modifiers: 2, commands: ["selectAll"] });
      await send("Input.dispatchKeyEvent", { type: "keyUp", key: "a", code: "KeyA", windowsVirtualKeyCode: 65, modifiers: 2 });
      await send("Input.insertText", { text: arg(1, "text") });
      break;
    case "press": {
      const key = keys[arg(0, "key")] ?? (() => { throw new Error(`unknown key; use one of ${Object.keys(keys).join(", ")}`); })();
      await send("Input.dispatchKeyEvent", { type: "keyDown", windowsVirtualKeyCode: key.keyCode, ...key });
      await send("Input.dispatchKeyEvent", { type: "keyUp", windowsVirtualKeyCode: key.keyCode, key: key.key, code: key.code });
      await Bun.sleep(300);
      break;
    }
    case "upload": {
      const query = arg(0, "field");
      const { root } = await send("DOM.getDocument");
      const css = query.startsWith("css=") ? query.slice(4) : "input[type=file]";
      const { nodeId } = await send("DOM.querySelector", { nodeId: root.nodeId, selector: css });
      if (!nodeId) throw new Error(`no file input matching ${css}`);
      await send("DOM.setFileInputFiles", { nodeId, files: args.slice(1).map((file) => resolve(file)) });
      break;
    }
    case "wait": {
      const text = arg(0, "text");
      await waitFor(async () => (await visibleText()).includes(text), Number(args[1] ?? 15_000), JSON.stringify(text));
      break;
    }
    case "gone": {
      const text = arg(0, "text");
      await waitFor(async () => !(await visibleText()).includes(text), Number(args[1] ?? 15_000), `${JSON.stringify(text)} to disappear`);
      break;
    }
    case "text":
      console.log(await visibleText(args[0]));
      break;
    case "shot": {
      const file = arg(0, "file.png");
      const { data } = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: true });
      await Bun.write(file, Buffer.from(data, "base64"));
      console.log(file);
      break;
    }
    case "eval":
      console.log(JSON.stringify(await evaluate(arg(0, "js")), null, 2));
      break;
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
} finally {
  socket.close();
}
