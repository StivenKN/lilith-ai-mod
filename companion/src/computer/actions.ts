import { z } from "zod";
import type { ToolCall, ToolSpec } from "../providers/types.ts";
import type { MouseButton } from "./input.ts";

const integer = z.number().int().nonnegative();
const point = z.tuple([integer, integer]);
const direction = z.enum(["up", "down", "left", "right"]);
const text = z.string().min(1).max(4000);
const modifiers = z.string().max(80).optional();
const clicks = z.number().int().min(1).max(100);
const repeat = clicks.default(1);
const xy = { x: integer, y: integer };

export interface Point { x: number; y: number }
export interface Size { width: number; height: number }
export interface Region extends Point, Size {}

export type Action =
  | { type: "screenshot" | "cursor" }
  | { type: "zoom"; region: Region }
  | { type: "click"; at: Point | null; button: MouseButton; count: number; modifiers: string }
  | { type: "drag"; from: Point; to: Point; modifiers: string }
  | { type: "move"; at: Point }
  | { type: "scroll"; at: Point | null; direction: z.infer<typeof direction>; amount: number; modifiers: string }
  | { type: "type"; text: string }
  | { type: "key"; combo: string; repeat: number }
  | { type: "wait"; seconds: number }
  | { type: "openApp"; name: string }
  | { type: "openUrl"; url: string };

const custom = {
  screenshot: { description: "Look at the primary screen. Coordinates for other tools are pixels in this image.", input: z.object({}) },
  click: { description: "Click a point in the latest screenshot.", input: z.object({ ...xy, button: z.enum(["left", "right", "middle"]).default("left"), double: z.boolean().default(false) }) },
  scroll: { description: "Scroll at a point in the screenshot. Amount is wheel clicks.", input: z.object({ ...xy, direction, amount: clicks }) },
  type_text: { description: "Type literal text in the focused app. Never type commands or passwords.", input: z.object({ text }) },
  press_key: { description: "Press keys, such as Return, ctrl+s, alt+Tab or F5.", input: z.object({ key: z.string().min(1).max(100), repeat }) },
  open_app: { description: "Open an installed app by its Start menu name, including localized names.", input: z.object({ name: z.string().trim().min(1).max(150) }) },
  open_url: { description: "Open an http or https URL in the default browser.", input: z.object({ url: z.string().url().max(2000) }) },
} satisfies Record<string, Omit<ToolSpec, "name">>;

export function computerTools(vision: boolean): ToolSpec[] {
  return Object.entries(custom)
    .filter(([name]) => vision || ["type_text", "press_key", "open_app", "open_url"].includes(name))
    .map(([name, tool]) => ({ name, ...tool }));
}

export function toolSchema(tool: ToolSpec): Record<string, unknown> {
  const { $schema, ...schema } = z.toJSONSchema(tool.input, { target: "draft-7", io: "input" });
  return schema;
}

const pos = ([x, y]: z.infer<typeof point>): Point => ({ x, y });

/** Parse only declared computer members and custom tools. Invalid inputs never reach the desktop. */
export function parseCall(call: ToolCall): Action | { error: string } {
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
    switch (call.name) {
      case "screenshot": custom.screenshot.input.parse(input); return { type: "screenshot" };
      case "click": {
        const data = custom.click.input.parse(input);
        return { type: "click", at: { x: data.x, y: data.y }, button: data.button, count: data.double ? 2 : 1, modifiers: "" };
      }
      case "scroll": {
        const data = custom.scroll.input.parse(input);
        return { type: "scroll", at: { x: data.x, y: data.y }, direction: data.direction, amount: data.amount, modifiers: "" };
      }
      case "type_text": return { type: "type", text: custom.type_text.input.parse(input).text };
      case "press_key": {
        const data = custom.press_key.input.parse(input);
        return { type: "key", combo: data.key, repeat: data.repeat };
      }
      case "open_app": return { type: "openApp", name: custom.open_app.input.parse(input).name };
      case "open_url": return { type: "openUrl", url: custom.open_url.input.parse(input).url };
      default: throw new Error(`Unknown tool: ${call.name}`);
    }
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
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
