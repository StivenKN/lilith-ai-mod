// "Copy diagnostic report": everything needed to debug a problem in one paste-able Markdown
// block. Secrets are masked/redacted; nothing here contains chat content.

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Brain } from "./brain.ts";
import { publicConfig, type Config } from "./config.ts";
import { formatEntry, type Logger } from "./log.ts";
import { resolveLanguage } from "./languages.ts";
import { capabilityNames } from "./protocol.ts";
import type { UpdateStatus } from "./updater.ts";

export async function buildReport(input: {
  version: string;
  mode: string;
  config: Config;
  brain: Brain;
  logger: Logger;
  update: UpdateStatus;
  gameDir: string | null;
}): Promise<string> {
  const { brain, config, logger } = input;
  const snapshot = brain.snapshot();
  const hello = snapshot.hello;
  const lines: string[] = [
    "## Lilith AI Companion: diagnostic report",
    "",
    `- Generated: ${new Date().toISOString()}`,
    `- Companion: ${input.version} (${input.mode}), ${process.platform} ${process.arch}, Bun ${Bun.version}`,
    hello
      ? `- Plugin: ${hello.pluginVersion} (${snapshot.connected ? "connected" : "disconnected"}), game ${hello.gameVersion}, Unity ${hello.unityVersion}, BepInEx ${hello.bepinexVersion}`
      : "- Plugin: never connected (game not running, or the mod didn't load)",
    `- Game language: raw "${snapshot.state?.langRaw ?? "?"}" → ${resolveLanguage(snapshot.state?.langRaw) ?? "unrecognized"}; replies in ${snapshot.replyLanguage}; UI ${snapshot.uiLocale}`,
    `- Provider: ${config.provider.preset} · ${config.provider.model || "(no model)"} · ${config.provider.baseUrl} · key ${config.apiKeys[config.provider.preset] ? "set" : "not set"}`,
    `- Computer: ${JSON.stringify(snapshot.computer)}`,
    snapshot.lastTurn ? `- Last reply: ${snapshot.lastTurn.at}, ${snapshot.lastTurn.latencyMs} ms, ${snapshot.lastTurn.model}` : "- Last reply: none yet",
    `- Update: ${input.update.state}${"version" in input.update ? ` ${input.update.version}` : ""}${input.update.state === "failed" ? ` (${input.update.detail})` : ""}`,
    snapshot.lastError ? `- Last error: ${snapshot.lastError.at} · ${snapshot.lastError.kind} · ${snapshot.lastError.detail}` : "- Last error: none",
    "",
    "### Game capabilities",
    "",
    ...(hello
      ? capabilityNames.map((name) => `- ${hello.caps[name] === "ok" ? "✅" : "❌"} ${name}${hello.caps[name] && hello.caps[name] !== "ok" ? `: ${hello.caps[name]}` : ""}`)
      : ["- (no plugin connection)"]),
    "",
    "### Settings (keys masked)",
    "",
    "```json",
    JSON.stringify({ ...publicConfig(config), persona: { custom: config.persona.custom ? `(${config.persona.custom.length} chars)` : null } }, null, 2),
    "```",
    "",
    "### Recent log",
    "",
    "```",
    ...logger.recent(200).map(formatEntry),
    "```",
  ];

  const gameDir = input.gameDir ?? hello?.gameDir ?? null;
  if (gameDir) {
    const bepinexLog = await readFile(join(gameDir, "BepInEx", "LogOutput.log"), "utf8").catch(() => null);
    lines.push("", "### BepInEx log (tail)", "", "```", bepinexLog ? bepinexLog.split(/\r?\n/).slice(-80).join("\n") : "(not found)", "```");
  }
  return logger.redact(lines.join("\n"));
}
