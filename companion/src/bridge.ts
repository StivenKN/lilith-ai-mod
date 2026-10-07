// The plugin ↔ companion transport: JSON lines on stdin/stdout. The plugin owns this process;
// when it closes our stdin (game exit, crash, plugin unload) we shut down, so we never orphan.

import type { Log } from "./log.ts";
import { PluginMessage, type CompanionMessage } from "./protocol.ts";

/** Splits a byte stream into lines, decoding UTF-8 correctly across chunk boundaries. */
export function createLineDecoder(onLine: (line: string) => void) {
  const decoder = new TextDecoder("utf-8");
  let buffer = "";
  const flushLines = () => {
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      const trimmed = line.replace(/\r$/, "").replace(/^﻿/, "");
      if (trimmed.trim()) onLine(trimmed);
    }
  };
  return {
    push(chunk: Uint8Array) {
      buffer += decoder.decode(chunk, { stream: true });
      flushLines();
    },
    end() {
      buffer += `${decoder.decode()}\n`;
      flushLines();
    },
  };
}

export interface BridgeHandlers {
  onMessage: (message: PluginMessage) => void;
  onClose: () => void;
  log: Log;
}

export function startBridge(handlers: BridgeHandlers, input: ReadableStream<Uint8Array> = Bun.stdin.stream()) {
  const lines = createLineDecoder((line) => {
    let json: unknown;
    try {
      json = JSON.parse(line);
    } catch {
      handlers.log.warn(`ignoring non-JSON line from plugin: ${line.slice(0, 200)}`);
      return;
    }
    const parsed = PluginMessage.safeParse(json);
    if (!parsed.success) {
      handlers.log.warn(`ignoring unknown plugin message: ${line.slice(0, 200)}`);
      return;
    }
    try {
      handlers.onMessage(parsed.data);
    } catch (error) {
      handlers.log.error(`error handling plugin message "${parsed.data.type}": ${String(error)}`);
    }
  });

  void (async () => {
    try {
      for await (const chunk of input) lines.push(chunk);
    } catch (error) {
      handlers.log.warn(`stdin closed with an error: ${String(error)}`);
    }
    lines.end();
    handlers.onClose();
  })();

  return {
    send(message: CompanionMessage) {
      process.stdout.write(`${JSON.stringify(message)}\n`);
    },
  };
}
