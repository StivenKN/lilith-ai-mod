// Bridge protocol between the C# plugin (inside the game) and this companion process.
// Transport: one JSON object per line over the child's stdin/stdout, UTF-8 without BOM.
// stdout carries protocol messages only; all logging goes to the log file.
// Keep in sync with plugin/src/Protocol.cs. Bump PROTOCOL_VERSION on breaking changes.
// Startup order: the plugin sends `state` then `hello`; the companion answers `ready` (and sends
// `ready` again whenever settings or the game language change).

import { z } from "zod";

export const PROTOCOL_VERSION = 1;

/** Emotions accepted by the game's `DialogueManager.ForceSay(text, emotion, seconds)`. */
export const emotions = ["neutral", "happy", "sad", "angry", "surprised", "shy"] as const;
export type Emotion = (typeof emotions)[number];

/** Game features the plugin probes at startup; each is "ok" or the reason it's unavailable. */
export const capabilityNames = [
  "say",
  "busy",
  "position",
  "state",
  "language",
  "playerName",
  "tray",
  "hotkey",
  "chatWindow",
] as const;
export type CapabilityName = (typeof capabilityNames)[number];

const GameState = z.object({
  idle: z.boolean(),
  sleep: z.boolean(),
  busy: z.boolean(),
  interacting: z.boolean(),
  drag: z.boolean(),
  langRaw: z.string(),
  playerName: z.string(),
});
export type GameState = z.infer<typeof GameState>;

export const PluginMessage = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("hello"),
    v: z.number().int(),
    pluginVersion: z.string(),
    gameVersion: z.string(),
    unityVersion: z.string(),
    bepinexVersion: z.string(),
    gameDir: z.string(),
    caps: z.record(z.string(), z.string()),
  }),
  GameState.extend({ type: z.literal("state") }),
  z.object({ type: z.literal("chat"), text: z.string().min(1).max(4000) }),
  z.object({ type: z.literal("action"), name: z.enum(["dashboard"]) }),
  z.object({ type: z.literal("result"), id: z.string(), ok: z.boolean(), error: z.string().optional() }),
  z.object({ type: z.literal("log"), level: z.enum(["debug", "info", "warn", "error"]), msg: z.string() }),
]);
export type PluginMessage = z.infer<typeof PluginMessage>;
export type HelloMessage = Extract<PluginMessage, { type: "hello" }>;

/** Strings the plugin shows itself; everything else it displays arrives already localized. */
export interface PluginStrings {
  placeholder: string;
  thinking: string;
  send: string;
  settings: string;
  trayTalk: string;
  traySettings: string;
}

export type CompanionMessage =
  | {
      type: "ready";
      v: number;
      version: string;
      dashboardUrl: string;
      hotkey: { key: string; ctrl: boolean; alt: boolean; shift: boolean };
      strings: PluginStrings;
    }
  | { type: "say"; id: string; text: string; emotion: Emotion; seconds: number }
  | { type: "chatStatus"; kind: "idle" | "thinking" | "error"; text?: string };
