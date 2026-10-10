// What the adapters share for tool turns: a tool's input as the JSON schema the APIs take, and
// the calls a local server leaves in the reply text instead of returning them as tool calls.

import { z } from "zod";
import type { ToolCall, ToolSpec } from "./types.ts";

export function toolSchema(tool: ToolSpec): Record<string, unknown> {
  const { $schema, ...schema } = z.toJSONSchema(tool.input, { target: "draft-7", io: "input" });
  return schema;
}

const TextCall = z.object({ name: z.string().min(1), arguments: z.union([z.string().transform((json) => JSON.parse(json) as unknown), z.unknown()]) });

/**
 * Local servers sometimes leave a call in the reply text, in the `<tool_call>` format Qwen and
 * Hermes models write, instead of returning it as a tool call. A bare JSON reply counts only when
 * it names one of our tools. A malformed call is charged to the first tool offered (computer_use
 * on a PC turn), so the error reaches the model as a tool result.
 */
export function toolCallsInText(content: string, tools: readonly string[]): { calls: Array<Omit<ToolCall, "id">>; text: string } {
  const parse = (json: string): Omit<ToolCall, "id"> => {
    try {
      const call = TextCall.parse(JSON.parse(json));
      return { name: call.name, input: call.arguments };
    } catch { return { name: tools[0] ?? "", input: null, error: "Malformed tool call. Send one valid JSON object inside <tool_call></tool_call>." }; }
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
