import type { z } from "zod";
import type { HttpOptions } from "./http.ts";

export interface ChatTurn {
  role: "user" | "assistant";
  content: string;
}

export interface ChatRequest {
  system: string;
  turns: ChatTurn[];
  maxTokens: number;
  temperature: number;
  timeoutMs: number;
  signal?: AbortSignal;
}

export interface ChatResult {
  text: string;
  /** Visible reasoning some servers return separately (`reasoning_content`, Ollama `thinking`). */
  reasoning: string;
  finish: "stop" | "length" | "refusal" | "other";
  model: string;
}

export interface ModelInfo {
  id: string;
  /** Download size, for local models. */
  sizeBytes?: number;
}

export interface Provider {
  chat(request: ChatRequest): Promise<ChatResult>;
  listModels(timeoutMs?: number): Promise<ModelInfo[]>;
  capabilities(http: HttpOptions, refresh?: boolean): Promise<Capabilities>;
  agent(request: AgentRequest): AgentSession;
}

export interface Capabilities {
  tools: boolean;
  vision: boolean;
}

export interface ToolSpec {
  name: string;
  description: string;
  input: z.ZodObject;
}

export interface ToolCall {
  id: string;
  name: string;
  input: unknown;
  toolset?: string;
  error?: string;
}

export interface ToolResult {
  id: string;
  text: string;
  image?: Uint8Array;
  isError?: boolean;
}

export interface AgentRequest extends Pick<ChatRequest, "system" | "turns" | "maxTokens" | "temperature"> {
  vision: boolean;
}

export interface AgentStep extends Pick<ChatResult, "text" | "model" | "finish"> {
  calls: ToolCall[];
}

/** One computer turn. The adapter owns its transcript, including provider-specific fields. */
export interface AgentSession {
  next(results: readonly ToolResult[], http: HttpOptions): Promise<AgentStep>;
}

/** Every failure is classified so the user sees a specific, fixable message instead of a stock line. */
export const errorKinds = [
  "not_configured",
  "auth",
  "billing",
  "model_not_found",
  "not_found",
  "rate_limit",
  "server",
  "timeout",
  "unreachable",
  "bad_request",
  "bad_response",
  "empty_reply",
  "refused",
  "no_tools",
] as const;
export type ErrorKind = (typeof errorKinds)[number];

export class ProviderError extends Error {
  override readonly name = "ProviderError";

  constructor(
    readonly kind: ErrorKind,
    /** Technical detail for logs and the dashboard (already free of secrets). */
    message: string,
    readonly status?: number,
    readonly retryAfterMs?: number,
  ) {
    super(message);
  }
}

/** Providers need strictly alternating turns that start with the user. */
export function normalizeTurns(turns: readonly ChatTurn[]): ChatTurn[] {
  const out: ChatTurn[] = [];
  for (const turn of turns) {
    const content = turn.content.trim();
    if (!content) continue;
    const last = out.at(-1);
    if (last?.role === turn.role) last.content = `${last.content}\n${content}`;
    else out.push({ role: turn.role, content });
  }
  while (out[0]?.role === "assistant") out.shift();
  return out;
}
