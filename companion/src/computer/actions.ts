import { z } from "zod";
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

export function computerTools(vision: boolean): ToolSpec[] {
  return [computerUse(vision), ...Object.entries(custom).map(([name, tool]) => ({ name, ...tool }))];
}

export function toolSchema(tool: ToolSpec): Record<string, unknown> {
  const { $schema, ...schema } = z.toJSONSchema(tool.input, { target: "draft-7", io: "input" });
  return schema;
}

const pos = ([x, y]: z.infer<typeof point>): Point => ({ x, y });

/** Parse only declared computer members and custom tools. Invalid inputs never reach the desktop. */
export function parseCall(call: ToolCall, screen: Size): Action | { error: string } {
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
    if (call.name === "computer_use") return computerAction(input, screen);
    const action = customAction(call.name, input);
    if (action) return action;
    // A small model sometimes calls an action as if it were a tool of its own.
    const named = actionNamed(call.name);
    if (named) return computerAction({ ...z.record(z.string(), z.unknown()).catch({}).parse(input), action: named }, screen);
    throw new Error(`Unknown tool: ${call.name}. Use computer_use, open_app, open_url or window.`);
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
  const wrapped = z.looseObject({ arguments: z.record(z.string(), z.unknown()) }).safeParse(input);
  const data = ComputerInput.parse(wrapped.success ? { ...wrapped.data, ...wrapped.data.arguments } : input);
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

const TextCall = z.object({ name: z.string().min(1), arguments: z.union([z.string().transform((json) => JSON.parse(json) as unknown), z.unknown()]) });

/**
 * Local servers sometimes leave a call in the reply text, in the `<tool_call>` format Qwen and
 * Hermes models write, instead of returning it as a tool call. Returns those calls and the rest.
 * A bare JSON reply counts only when it names one of our tools.
 */
export function toolCallsInText(content: string, tools: readonly string[]): { calls: Array<Omit<ToolCall, "id">>; text: string } {
  const parse = (json: string): Omit<ToolCall, "id"> => {
    try {
      const call = TextCall.parse(JSON.parse(json));
      return { name: call.name, input: call.arguments };
    } catch { return { name: "computer_use", input: null, error: "Malformed tool call. Send one valid JSON object inside <tool_call></tool_call>." }; }
  };
  const tagged = [...content.matchAll(/<tool_call>([\s\S]*?)(?:<\/tool_call>|$)/g)];
  if (tagged.length) return { calls: tagged.map((match) => parse(match[1]!.trim())), text: content.replace(/<tool_call>[\s\S]*?(?:<\/tool_call>|$)/g, "").trim() };
  const bare = content.trim();
  if (bare.startsWith("{") && bare.endsWith("}")) {
    const call = parse(bare);
    if (!call.error && tools.includes(call.name)) return { calls: [call], text: "" };
  }
  return { calls: [], text: content };
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
