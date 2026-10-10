import { z } from "zod";
import type { BrowserAction } from "../browser/session.ts";
import type { ToolCall, ToolSpec } from "../providers/types.ts";
import type { MouseButton } from "./input.ts";
import { parseKeys } from "./keys.ts";

const integer = z.number().int().nonnegative();
const point = z.tuple([integer, integer]);
const direction = z.enum(["up", "down", "left", "right"]);
const text = z.string().min(1).max(4000);
const modifiers = z.string().max(80).optional();
const clicks = z.number().int().min(1).max(100);
const repeat = clicks.default(1);

export interface Point { x: number; y: number }
export interface Size { width: number; height: number }
export interface Region extends Point, Size {}

/**
 * Custom tools take coordinates on a 1000 × 1000 grid laid over the screen, whatever its shape.
 * Qwen-VL and Gemini models are trained to point this way; Claude's own toolset uses pixels.
 */
export const GRID = 1000;

export const windowOps = ["list", "focus", "maximize", "minimize", "close"] as const;
export type WindowOp = (typeof windowOps)[number];

/** What the desktop does. Points are pixels in the screenshot the model was sent. */
export type Action =
  | { type: "screenshot" | "cursor" }
  | { type: "zoom"; region: Region }
  | { type: "click"; at: Point | null; button: MouseButton; count: number; modifiers: string }
  /** `from: null` drags from wherever the cursor is. */
  | { type: "drag"; from: Point | null; to: Point; modifiers: string }
  | { type: "move"; at: Point }
  | { type: "scroll"; at: Point | null; direction: z.infer<typeof direction>; amount: number; modifiers: string }
  | { type: "type"; text: string }
  | { type: "key"; combo: string; repeat: number }
  | { type: "wait"; seconds: number }
  | { type: "openApp"; name: string }
  | { type: "openUrl"; url: string }
  | { type: "window"; op: WindowOp; title: string | null }
  /** Done in the browser by the extension, on the page's elements (browser/session.ts). */
  | { type: "browser"; op: BrowserAction }
  /** The model says the task is over, with any answer it gave. Nothing happens on the desktop. */
  | { type: "finish"; answer: string };

// The `computer_use` tool mirrors the one in Qwen3-VL's computer-use cookbook, wording included,
// because that's the format a small Qwen model was trained to drive a desktop with.
const actions = {
  screenshot: { sight: true, help: "Look at the screen. You also see it again after every other action." },
  key: { sight: false, help: "Performs key down presses on the arguments passed in order, then performs key releases in reverse order." },
  type: { sight: false, help: "Type a string of text on the keyboard." },
  mouse_move: { sight: true, help: "Move the cursor to a specified (x, y) pixel coordinate on the screen." },
  left_click: { sight: true, help: "Click the left mouse button at a specified (x, y) pixel coordinate on the screen." },
  left_click_drag: { sight: true, help: "Click and drag the cursor to a specified (x, y) pixel coordinate on the screen." },
  right_click: { sight: true, help: "Click the right mouse button at a specified (x, y) pixel coordinate on the screen." },
  middle_click: { sight: true, help: "Click the middle mouse button at a specified (x, y) pixel coordinate on the screen." },
  double_click: { sight: true, help: "Double-click the left mouse button at a specified (x, y) pixel coordinate on the screen." },
  triple_click: { sight: true, help: "Triple-click the left mouse button at a specified (x, y) pixel coordinate on the screen." },
  scroll: { sight: true, help: "Performs a scroll of the mouse scroll wheel." },
  hscroll: { sight: true, help: "Performs a horizontal scroll." },
  wait: { sight: false, help: "Wait specified seconds for the change to happen." },
  terminate: { sight: false, help: "Terminate the current task and report its completion status." },
  answer: { sight: false, help: "Answer a question." },
} as const;
type ActionName = keyof typeof actions;
const actionNames = Object.keys(actions) as ActionName[];

/** Names small models use instead of the schema's, as action values or as tool names of their own. */
const aliases = new Map<string, ActionName>([
  ...actionNames.map((name) => [name, name] as const),
  ["click", "left_click"], ["tap", "left_click"], ["doubleclick", "double_click"], ["rightclick", "right_click"],
  ["move", "mouse_move"], ["hover", "mouse_move"], ["drag", "left_click_drag"],
  ["type_text", "type"], ["write", "type"], ["press", "key"], ["press_key", "key"], ["hotkey", "key"], ["key_press", "key"],
  ["take_screenshot", "screenshot"], ["sleep", "wait"], ["done", "terminate"], ["finish", "terminate"],
]);
const actionNamed = (name: string) => aliases.get(name.trim().toLowerCase());

function computerUse(vision: boolean): ToolSpec {
  const names = actionNames.filter((name) => vision || !actions[name].sight);
  const description = vision ? [
    "Use a mouse and keyboard to interact with a computer, and take screenshots.",
    "* This is an interface to a Windows desktop GUI. You do not have access to a terminal. Start applications with open_app and switch between open windows with window.",
    "* Some applications may take time to start or process actions, so you may need to wait and take successive screenshots to see the results of your actions.",
    `* The screen's resolution is ${GRID}x${GRID}.`,
    "* Whenever you intend to move the cursor to click on an element like an icon, you should consult a screenshot to determine the coordinates of the element before moving the cursor.",
    "* If you tried clicking on a program or link but it failed to load, even after waiting, try adjusting your cursor position so that the tip of the cursor visually falls on the element that you want to click.",
    "* Make sure to click any buttons, links, icons, etc with the cursor tip in the center of the element. Don't click boxes on their edges.",
  ] : [
    "Use the keyboard to interact with a computer. You cannot see the screen.",
    "* This is an interface to a Windows desktop. You do not have access to a terminal. Start applications with open_app and switch between open windows with window.",
    "* After each action you are told which window is active. Keys and text go to that window.",
  ];
  return {
    name: "computer_use",
    description: description.join("\n"),
    input: z.object({
      action: z.enum(names).describe(`The action to perform. The available actions are:\n${names.map((name) => `* \`${name}\`: ${actions[name].help}`).join("\n")}`),
      keys: z.array(z.string()).optional().describe("Required only by `action=key`."),
      text: z.string().optional().describe("Required only by `action=type` and `action=answer`."),
      ...(vision ? {
        coordinate: z.array(z.number()).optional().describe("(x, y): The x (pixels from the left edge) and y (pixels from the top edge) coordinates to move the mouse to."),
        pixels: z.number().optional().describe("The amount of scrolling to perform. Positive values scroll up (or right, for hscroll), negative values scroll down (or left). Required only by `action=scroll` and `action=hscroll`."),
      } : {}),
      time: z.number().optional().describe("The seconds to wait. Required only by `action=wait`."),
      status: z.enum(["success", "failure"]).optional().describe("The status of the task. Required only by `action=terminate`."),
    }),
  };
}

// The browser tool follows computer_use's shape, one function and an `action`, so a small model
// meets one convention. Elements are named by the numbers in the page it gets after each action:
// a 4B model picks [12] from a list far more reliably than a spot on a screenshot, and a model
// without vision can browse at all.
const browserActions = {
  click: "Click element `ref`: a link, button, checkbox, tab or menu item.",
  type: "Replace the text of field `ref` with `text` (without `ref`, type into the focused field). In a dropdown list, choose the option named `text`. Set `submit` to press Enter afterwards, as in a search box.",
  key: 'Press keys on the page, such as ["escape"], ["tab"] or ["ctrl", "a"].',
  scroll: "Scroll the page `direction` by about one screen.",
  read: "Get the page's text from where it is scrolled to, to read it or answer about it.",
  back: "Go back to the previous page in this tab.",
  switch_tab: "Show tab number `tab`.",
  close_tab: "Close tab number `tab`, or the current one. Only tabs you opened.",
} as const;
type BrowserActionName = keyof typeof browserActions;
const browserActionNames = Object.keys(browserActions) as BrowserActionName[];

const browserTool: ToolSpec = {
  name: "browser",
  description: [
    "Use the web browser through the elements of its page. Inside a webpage this is more reliable than the mouse, and it works without seeing the screen.",
    '* After each action you get the page: its tabs, its address and its elements, each with a number, like [12] button "Search". Pass that number as `ref`.',
    "* The numbers stay valid while the page is open, so you can fill several fields and click in one go. Elements further down are listed too and can be used directly.",
    "* Open a website with open_url.",
  ].join("\n"),
  input: z.object({
    action: z.enum(browserActionNames).describe(`The action to perform. The available actions are:\n${browserActionNames.map((name) => `* \`${name}\`: ${browserActions[name]}`).join("\n")}`),
    ref: z.number().int().optional().describe("The element's number from the page, like 12 for [12]. Required by `action=click`; the field to fill for `action=type`."),
    text: z.string().optional().describe("Required only by `action=type`."),
    submit: z.boolean().optional().describe("Press Enter after typing. Only for `action=type`."),
    keys: z.array(z.string()).optional().describe("Required only by `action=key`."),
    direction: z.enum(["up", "down"]).optional().describe("Required only by `action=scroll`."),
    tab: z.number().int().optional().describe("A tab's number from the top of the page. Required by `action=switch_tab`."),
  }),
};

/** Browser actions as small models write them: Playwright MCP's names, browser-use's, and plain verbs. */
const browserAliases = new Map<string, BrowserActionName | "look" | "open" | "wait">([
  ...browserActionNames.map((name) => [name, name] as const),
  ...["left_click", "tap", "click_element", "click_element_by_index", "browser_click"].map((name) => [name, "click"] as const),
  ...["input_text", "input", "fill", "fill_in", "type_text", "enter_text", "write", "browser_type", "browser_fill", "select", "select_option", "choose", "browser_select_option"].map((name) => [name, "type"] as const),
  ...["press", "press_key", "keypress", "key_press", "hotkey", "send_keys", "browser_press_key"].map((name) => [name, "key"] as const),
  ...["scroll_down", "scroll_up", "browser_scroll", "scroll_page"].map((name) => [name, "scroll"] as const),
  ...["read_page", "get_text", "get_page_text", "extract_content", "extract", "extract_page_content", "browser_get_text"].map((name) => [name, "read"] as const),
  ...["look", "snapshot", "browser_snapshot", "screenshot", "take_screenshot", "browser_take_screenshot", "observe", "get_state"].map((name) => [name, "look"] as const),
  ...["go_back", "navigate_back", "browser_navigate_back", "browser_go_back"].map((name) => [name, "back"] as const),
  ...["select_tab", "focus_tab", "browser_tab_select", "browser_switch_tab"].map((name) => [name, "switch_tab"] as const),
  ...["browser_tab_close", "browser_close_tab"].map((name) => [name, "close_tab"] as const),
  ...["open", "open_url", "navigate", "go_to_url", "goto", "go_to", "visit", "browser_navigate", "open_tab", "new_tab", "browser_tab_new"].map((name) => [name, "open"] as const),
  ...["wait", "sleep", "browser_wait", "browser_wait_for"].map((name) => [name, "wait"] as const),
]);
/**
 * Names that only mean something in the browser (read_page, go_back, browser_click…). Plain verbs
 * the computer tool knows (click, type, scroll) go to the browser only with an element number.
 */
const browserOnly = (name: string) => name.startsWith("browser_") || (browserAliases.has(name) && !actionNamed(name) && !Object.hasOwn(custom, name));

const custom = {
  open_app: { description: "Open an installed app by its Start menu name, including localized names. An app that's already open comes to the front.", input: z.object({ name: z.string().trim().min(1).max(150) }) },
  open_url: {
    description: "Open an http or https URL in the default browser.",
    input: z.object({ url: z.string().trim().min(1).max(2000).transform((url) => /^[a-z][a-z\d+.-]*:/i.test(url) ? url : `https://${url}`).pipe(z.url()) }),
  },
  window: {
    description: "Work with open windows. `list` names them, front to back. `focus` brings the window whose title or app contains `title` to the front. `maximize`, `minimize` and `close` act on that window, or on the active window when `title` is left out.",
    input: z.object({ action: z.enum(windowOps), title: z.string().trim().min(1).max(200).optional() }),
  },
} satisfies Record<string, Omit<ToolSpec, "name">>;
const windowAliases = new Map<string, WindowOp>([["switch", "focus"], ["activate", "focus"], ["show", "focus"], ["restore", "focus"], ["open", "focus"], ["maximise", "maximize"], ["minimise", "minimize"]]);

/** The tools for one turn. With the browser extension connected, `browser` joins them and open_url opens a tab in it. */
export function computerTools(vision: boolean, browser = false): ToolSpec[] {
  return [
    computerUse(vision),
    ...(browser ? [browserTool] : []),
    ...Object.entries(custom).map(([name, tool]) => ({
      name,
      ...tool,
      ...(browser && name === "open_url" ? { description: "Open an http or https URL in a browser tab. You then get the page and its elements." } : {}),
    })),
  ];
}

const pos = ([x, y]: z.infer<typeof point>): Point => ({ x, y });

/**
 * Parse only declared computer members and custom tools. Invalid inputs never reach the desktop.
 * `browser`: the extension is connected this turn, so browser actions are allowed.
 */
export function parseCall(call: ToolCall, screen: Size, browser = false): Action | { error: string } {
  try {
    if (call.error) throw new Error(call.error);
    const input = call.input;
    if (call.toolset !== undefined && call.toolset !== "computer") throw new Error(`Unknown toolset: ${call.toolset}`);
    if (call.toolset === "computer") {
      const mouse = () => z.object({ coordinate: point.optional(), text: modifiers }).parse(input);
      switch (call.name) {
        case "screenshot": case "cursor_position":
          z.object({}).parse(input);
          return { type: call.name === "screenshot" ? "screenshot" : "cursor" };
        case "zoom": {
          const { region: [x, y, right, bottom] } = z.object({ region: z.tuple([integer, integer, integer, integer]) }).parse(input);
          if (right <= x || bottom <= y) throw new Error("Zoom region must have positive width and height");
          return { type: "zoom", region: { x, y, width: right - x, height: bottom - y } };
        }
        case "left_click": case "right_click": case "middle_click": case "double_click": case "triple_click": {
          const { coordinate, text } = mouse();
          return { type: "click", at: coordinate ? pos(coordinate) : null, button: call.name === "right_click" ? "right" : call.name === "middle_click" ? "middle" : "left", count: call.name === "double_click" ? 2 : call.name === "triple_click" ? 3 : 1, modifiers: text ?? "" };
        }
        case "left_click_drag": {
          const data = z.object({ start_coordinate: point, coordinate: point, text: modifiers }).parse(input);
          return { type: "drag", from: pos(data.start_coordinate), to: pos(data.coordinate), modifiers: data.text ?? "" };
        }
        case "mouse_move": return { type: "move", at: pos(z.object({ coordinate: point }).parse(input).coordinate) };
        case "scroll": {
          const data = z.object({ coordinate: point.optional(), scroll_direction: direction, scroll_amount: clicks, text: modifiers }).parse(input);
          return { type: "scroll", at: data.coordinate ? pos(data.coordinate) : null, direction: data.scroll_direction, amount: data.scroll_amount, modifiers: data.text ?? "" };
        }
        case "type": return { type: "type", text: z.object({ text }).parse(input).text };
        case "key": {
          const data = z.object({ text: z.string().min(1).max(100), repeat }).parse(input);
          return { type: "key", combo: data.text, repeat: data.repeat };
        }
        case "wait": return { type: "wait", seconds: z.object({ duration: z.number().min(0).max(300) }).parse(input).duration };
        default: throw new Error(`Unsupported computer member: ${call.name}`);
      }
    }
    const fields = unwrapped(input);
    if (call.name === "browser") return browserCall(fields, browser);
    // Once refs are in the transcript, {"name": "click", "arguments": {"ref": 12}} means the page.
    // Taken as a desktop click without a point, it would land wherever the cursor is.
    const onElement = refOf(fields) !== null && fields.coordinate === undefined && fields.x === undefined && fields.y === undefined;
    if (call.name === "computer_use") {
      const action = typeof fields.action === "string" ? fields.action.trim().toLowerCase() : "";
      if (onElement) return browserCall({ ...fields, action: action || "click" }, browser);
      // Browser actions written into the computer tool ({"action": "read"}) go to the browser too.
      if (browser && browserOnly(action)) return browserCall(fields, browser);
      return computerAction(fields, screen);
    }
    const action = customAction(call.name, input);
    if (action) return action;
    if (browserOnly(call.name)) return browserCall({ ...fields, action: call.name }, browser);
    // A small model sometimes calls an action as if it were a tool of its own.
    const named = actionNamed(call.name);
    if (named && onElement) return browserCall({ ...fields, action: call.name }, browser);
    if (named) return computerAction({ ...fields, action: named }, screen);
    throw new Error(`Unknown tool: ${call.name}. Use ${browser ? "browser, " : ""}computer_use, open_app, open_url or window.`);
  } catch (error) {
    // The model reads this, so a schema error is spelled out rather than dumped as JSON.
    return { error: error instanceof z.ZodError ? `Invalid ${call.name} input: ${z.prettifyError(error)}` : error instanceof Error ? error.message : String(error) };
  }
}

/** open_app, open_url and window, or undefined for any other name. */
function customAction(name: string, input: unknown): Action | undefined {
  switch (name) {
    case "open_app": return { type: "openApp", name: custom.open_app.input.parse(input).name };
    case "open_url": return { type: "openUrl", url: custom.open_url.input.parse(input).url };
    case "window": {
      const data = z.looseObject({ action: z.string().optional(), title: z.string().optional(), name: z.string().optional() }).parse(input);
      // A title alone means "go to that window".
      const op = data.action?.trim().toLowerCase() ?? (data.title ?? data.name ? "focus" : "list");
      const { action, title } = custom.window.input.parse({ action: windowAliases.get(op) ?? op, title: data.title ?? data.name });
      if (action === "focus" && !title) throw new Error("focus needs the title (or app name) of the window. Use action list to see them.");
      return { type: "window", op: action, title: title ?? null };
    }
  }
}

/** A call's fields, with ones wrapped once more ({"action": …, "arguments": {…}}) brought up a level. */
function unwrapped(input: unknown): Record<string, unknown> {
  const fields = z.record(z.string(), z.unknown()).catch({}).parse(input);
  const inner = z.record(z.string(), z.unknown()).safeParse(fields.arguments);
  return inner.success ? { ...fields, ...inner.data } : fields;
}

/** An element number as models write it: 12, "12", "[12]", "e12" (Playwright MCP) or "ref_12" (Claude in Chrome). */
function refOf(fields: Record<string, unknown>): number | null {
  for (const name of ["ref", "index", "element", "element_id", "element_index", "ref_id"]) {
    const value = fields[name];
    if (typeof value === "number" && Number.isInteger(value) && value > 0) return value;
    const match = typeof value === "string" ? /^\s*\[?(?:ref_?|e)?(\d+)\]?\s*$/i.exec(value) : null;
    if (match) return Number(match[1]);
  }
  return null;
}

const firstText = (...values: unknown[]) => values.find((value) => typeof value === "string" || typeof value === "number");

/** A tab's number, under whichever name the model gave it (an `index` reads as a ref first). */
function tabNumber(fields: Record<string, unknown>, ref: number | null): number | null {
  const tab = numberish.pipe(z.number().int().positive()).safeParse(fields.tab ?? fields.tab_index ?? fields.page_id ?? fields.number ?? ref ?? undefined);
  return tab.success ? tab.data : null;
}

/** Parses the browser tool, and browser actions models send under other names. Opening and waiting work without the extension. */
function browserCall(fields: Record<string, unknown>, connected: boolean): Action {
  const written = typeof fields.action === "string" ? fields.action.trim().toLowerCase() : "";
  const name = browserAliases.get(written);
  if (!connected && name !== "open" && name !== "wait") throw new Error("The browser extension isn't connected, so there are no page elements to use. Use open_url, computer_use and the keyboard.");
  if (!name) throw new Error(`Unknown browser action "${written || String(fields.action)}". Use one of: ${browserActionNames.join(", ")}`);
  const ref = refOf(fields);
  const needRef = () => {
    if (ref === null) throw new Error(`${name} needs ref: the element's number from the page, like 12 for [12]`);
    return ref;
  };
  const browser = (op: BrowserAction): Action => ({ type: "browser", op });
  switch (name) {
    case "click": return browser({ op: "click", ref: needRef() });
    case "type": {
      const typed = text.safeParse(String(firstText(fields.text, fields.value, fields.option, fields.query, fields.content) ?? ""));
      if (!typed.success) throw new Error("type needs text (up to 4000 characters)");
      const submit = [fields.submit, fields.enter, fields.press_enter].some((value) => value === true || value === "true");
      return browser({ op: "type", ref, text: typed.data, submit });
    }
    case "key": {
      const keys = z.union([z.string().trim().min(1).transform((key) => [key]), z.array(z.string().trim().min(1)).min(1)]).safeParse(fields.keys ?? fields.key ?? fields.text);
      if (!keys.success) throw new Error('key needs keys, such as ["enter"] or ["ctrl", "a"]');
      return browser({ op: "key", keys: keys.data.join("+") });
    }
    case "scroll": {
      // Signs follow where the model learned the field: computer_use's `pixels` scroll up when
      // positive (pyautogui); a web page's `amount` or `delta_y` scroll down (wheel deltaY).
      const way = String(fields.direction ?? fields.scroll_direction ?? "").toLowerCase();
      const pixels = numberish.safeParse(fields.pixels);
      const amount = numberish.safeParse(fields.amount ?? fields.delta_y ?? fields.deltaY);
      const up = way ? way === "up"
        : typeof fields.down === "boolean" ? !fields.down
        : written.endsWith("_up") || (pixels.success && pixels.data > 0) || (amount.success && amount.data < 0);
      return browser({ op: "scroll", direction: up ? "up" : "down" });
    }
    case "read": case "look": case "back": return browser({ op: name });
    case "switch_tab": {
      const tab = tabNumber(fields, ref);
      if (tab === null) throw new Error("switch_tab needs tab: a tab's number from the top of the page");
      return browser({ op: "switchTab", tab });
    }
    case "close_tab": return browser({ op: "closeTab", tab: tabNumber(fields, ref) });
    case "open": return { type: "openUrl", url: custom.open_url.input.parse({ url: firstText(fields.url, fields.text, fields.href) }).url };
    case "wait": {
      const seconds = numberish.safeParse(fields.time ?? fields.seconds ?? fields.duration);
      return { type: "wait", seconds: seconds.success ? Math.min(60, Math.max(0, seconds.data)) : 2 };
    }
  }
}

const numberish = z.union([z.number(), z.string().trim().regex(/^-?\d+(\.\d+)?$/).transform(Number)]);
/** [x, y], {x, y} or "(x, y)": small models write points every way. */
const pair = z.union([
  z.tuple([numberish, numberish]),
  z.object({ x: numberish, y: numberish }).transform(({ x, y }) => [x, y] as const),
  z.string().transform((value, ctx) => {
    const [x, y, ...rest] = value.match(/-?\d+(?:\.\d+)?/g) ?? [];
    if (x === undefined || y === undefined || rest.length) {
      ctx.addIssue({ code: "custom", message: "Expected two numbers" });
      return z.NEVER;
    }
    return [Number(x), Number(y)] as const;
  }),
]);
/** Every other field stays `unknown` until the action says which ones it needs. */
const ComputerInput = z.looseObject({ action: z.string({ error: "computer_use needs an action, such as left_click, type or key" }) });

/** Parses `computer_use`, accepting the near misses a small model makes so they don't cost a step. */
function computerAction(input: unknown, screen: Size): Action {
  // Fields wrapped once more, as {"action": "open_url", "arguments": {"url": …}}, are unwrapped.
  const data = ComputerInput.parse(unwrapped(input));
  const name = actionNamed(data.action);
  if (!name) {
    // Small models put other tools, or the keys themselves, where the action goes:
    // {"action": "open_app", "name": "Spotify"}, {"action": "ctrl+w"}.
    const { action, ...rest } = data;
    const tool = customAction(action.trim().toLowerCase(), rest);
    if (tool) return tool;
    if (isKeys(action)) return { type: "key", combo: action.trim(), repeat: 1 };
    throw new Error(`Unknown action "${data.action}". Use one of: ${actionNames.join(", ")}`);
  }
  const optional = (value: unknown): Point | null => value === undefined || value === null ? null : gridPoint(value, screen);
  const required = (value: unknown): Point => {
    if (value === undefined || value === null) throw new Error(`${name} needs coordinate [x, y]`);
    return gridPoint(value, screen);
  };
  const target = data.coordinate ?? (data.x !== undefined || data.y !== undefined ? { x: data.x, y: data.y } : undefined);
  switch (name) {
    case "screenshot": return { type: "screenshot" };
    case "left_click": case "right_click": case "middle_click": case "double_click": case "triple_click":
      return { type: "click", at: optional(target), button: name === "right_click" ? "right" : name === "middle_click" ? "middle" : "left", count: name === "double_click" ? 2 : name === "triple_click" ? 3 : 1, modifiers: "" };
    case "mouse_move": return { type: "move", at: required(target) };
    case "left_click_drag": return { type: "drag", from: optional(data.start_coordinate), to: required(target), modifiers: "" };
    case "scroll": case "hscroll": {
      const amount = numberish.refine((value) => value !== 0).safeParse(data.pixels);
      if (!amount.success) throw new Error(`${name} needs pixels: positive scrolls ${name === "scroll" ? "up" : "right"}, negative ${name === "scroll" ? "down" : "left"}`);
      // pyautogui counts wheel notches, so models write -5; some write -300 meaning pixels.
      const size = Math.abs(amount.data);
      const notches = Math.min(25, Math.max(1, Math.round(size > 25 ? size / 100 : size)));
      const way = name === "scroll" ? (amount.data > 0 ? "up" : "down") : (amount.data > 0 ? "right" : "left");
      return { type: "scroll", at: optional(target), direction: way, amount: notches, modifiers: "" };
    }
    case "type": {
      const typed = text.safeParse(data.text);
      if (!typed.success) throw new Error("type needs text (up to 4000 characters)");
      return { type: "type", text: typed.data };
    }
    case "key": {
      const keys = z.union([z.string().trim().min(1).transform((key) => [key]), z.array(z.string().trim().min(1)).min(1)]).safeParse(data.keys ?? data.key ?? data.text);
      if (!keys.success) throw new Error('key needs keys, such as ["ctrl", "c"] or ["enter"]');
      const combo = keys.data.join("+");
      if (combo.length > 100) throw new Error("Too many keys at once");
      return { type: "key", combo, repeat: 1 };
    }
    case "wait": {
      const seconds = numberish.safeParse(data.time ?? data.seconds);
      return { type: "wait", seconds: seconds.success ? Math.min(60, Math.max(0, seconds.data)) : 2 };
    }
    case "terminate": case "answer": return { type: "finish", answer: typeof data.text === "string" ? data.text.trim() : "" };
  }
}

const isKeys = (text: string) => {
  try { return text.length <= 100 && parseKeys(text).length > 0; } catch { return false; }
};

/** A point on the model's grid, in screenshot pixels. */
function gridPoint(value: unknown, screen: Size): Point {
  const parsed = pair.safeParse(value);
  if (!parsed.success) throw new Error("coordinate must be [x, y]");
  const [x, y] = parsed.data;
  if (x < 0 || y < 0 || x > GRID || y > GRID) throw new Error(`Coordinates go from 0 to ${GRID}: [0, 0] is the top-left corner of the screen and [${GRID}, ${GRID}] the bottom-right`);
  const image = screenshotSize(screen);
  return { x: Math.min(image.width - 1, Math.round(x * image.width / GRID)), y: Math.min(image.height - 1, Math.round(y * image.height / GRID)) };
}

export function screenshotSize(size: Size): Size {
  const scale = Math.min(1, 1280 / Math.max(size.width, size.height));
  return { width: Math.max(1, Math.round(size.width * scale)), height: Math.max(1, Math.round(size.height * scale)) };
}

export function physicalPoint(point: Point, screen: Size): Point {
  const image = screenshotSize(screen);
  if (point.x < 0 || point.y < 0 || point.x >= image.width || point.y >= image.height) throw new Error("Coordinates are outside the primary screen");
  return { x: Math.min(screen.width - 1, Math.round(point.x * screen.width / image.width)), y: Math.min(screen.height - 1, Math.round(point.y * screen.height / image.height)) };
}

export function screenshotPoint(point: Point, screen: Size): Point {
  const image = screenshotSize(screen);
  const coordinate = (value: number, physical: number, pixels: number) => {
    if (value < 0) return -1;
    if (value >= physical) return pixels;
    return Math.min(pixels - 1, Math.round(value * pixels / physical));
  };
  return { x: coordinate(point.x, screen.width, image.width), y: coordinate(point.y, screen.height, image.height) };
}
