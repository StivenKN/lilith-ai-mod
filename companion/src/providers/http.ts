// Shared HTTP plumbing for the adapters: explicit timeouts, error classification, one retry.

import { ProviderError, type ErrorKind } from "./types.ts";
import { setTimeout } from "node:timers/promises";

export interface HttpOptions {
  timeoutMs: number;
  signal?: AbortSignal | undefined;
}

/** Shared capability probes must still let each caller stop waiting with its own signal. */
export function awaitWithAbort<T>(pending: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return pending;
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    void pending.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

/** Performs a request and returns the parsed JSON body, or throws a classified ProviderError. */
export async function requestJson(
  url: string,
  init: { method?: string; headers?: Record<string, string>; body?: unknown },
  options: HttpOptions,
): Promise<unknown> {
  const response = await send(url, init, options);
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new ProviderError("bad_response", `Expected JSON from ${safeUrl(url)}, got: ${text.slice(0, 200)}`, response.status);
  }
}

/** Like requestJson but returns the raw response (for streamed bodies). Non-2xx still throws. */
export async function send(
  url: string,
  init: { method?: string; headers?: Record<string, string>; body?: unknown },
  options: HttpOptions,
): Promise<Response> {
  const timeout = AbortSignal.timeout(options.timeoutMs);
  const signal = options.signal ? AbortSignal.any([timeout, options.signal]) : timeout;
  let response: Response;
  try {
    response = await fetch(url, {
      method: init.method ?? (init.body === undefined ? "GET" : "POST"),
      headers: { ...(init.body === undefined ? {} : { "content-type": "application/json" }), ...init.headers },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      signal,
    });
  } catch (error) {
    throw networkError(error, url, options, timeout);
  }
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    const message = extractErrorMessage(body) || response.statusText || `HTTP ${response.status}`;
    throw new ProviderError(
      classifyStatus(response.status, message),
      `HTTP ${response.status} from ${safeUrl(url)}: ${message}`,
      response.status,
      parseRetryAfter(response.headers.get("retry-after")),
    );
  }
  return response;
}

function networkError(error: unknown, url: string, options: HttpOptions, timeout: AbortSignal): unknown {
  if (timeout.aborted) {
    return new ProviderError("timeout", `No answer from ${safeUrl(url)} within ${Math.round(options.timeoutMs / 1000)} s`);
  }
  if (options.signal?.aborted) return error;
  const detail = error instanceof Error ? `${(error as { code?: string }).code ?? error.name}: ${error.message}` : String(error);
  return new ProviderError("unreachable", `Could not connect to ${safeUrl(url)} (${detail})`);
}

/** Pulls a human-readable message out of the many error body shapes providers use. */
export function extractErrorMessage(body: string): string {
  try {
    const json: unknown = JSON.parse(body);
    const candidates = [
      pick(json, "error", "message"),
      pick(json, "error"),
      pick(json, "message"),
      pick(json, "detail"),
      pick(json, 0, "error", "message"),
    ];
    const found = candidates.find((value): value is string => typeof value === "string" && value.length > 0);
    if (found) return found;
  } catch {
    // Not JSON: fall through to the raw text.
  }
  return body.trim().slice(0, 300);
}

const pick = (value: unknown, ...path: Array<string | number>): unknown =>
  path.reduce<unknown>((node, key) => (node && typeof node === "object" ? (node as Record<string | number, unknown>)[key] : undefined), value);

export function classifyStatus(status: number, message: string): ErrorKind {
  const billing = /insufficient|balance|credit|quota|billing|payment|arrear/i.test(message);
  // "Unsupported parameter ... with this model" is about a field, not a missing model.
  const fieldError = /parameter|argument|field|unrecognized/i.test(message);
  const model =
    !fieldError &&
    /model/i.test(message) &&
    /not (exist|found|available|supported)|does not exist|unknown|invalid|no such|not a valid|decommissioned|retired|deprecated/i.test(message);
  if (status === 401 || status === 403) return billing ? "billing" : "auth";
  if (status === 402) return "billing";
  if (status === 429) return billing ? "billing" : "rate_limit";
  if (status === 404) return /model/i.test(message) ? "model_not_found" : "not_found";
  if (status === 408 || status === 504) return "timeout";
  if (status >= 500) return "server";
  if (model) return "model_not_found";
  if (billing) return "billing";
  return "bad_request";
}

/** Invalid tool transcripts and schemas are errors, not evidence that a model lacks tools. */
export function toolsUnsupported(error: ProviderError): boolean {
  if ([400, 500].includes(error.status ?? 0) && /\b(tools?|tool_choice)\b.*requires --jinja\b/i.test(error.message)) return true;
  return error.status === 400 && /\b(tools?|functions?|function calling|tool_choice)\b/i.test(error.message)
    && /does not support|not supported|unsupported|not available|not implemented|disabled|requires --(?:jinja|enable-auto-tool-choice)/i.test(error.message);
}

export function parseRetryAfter(header: string | null): number | undefined {
  if (!header) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(header);
  return Number.isNaN(date) ? undefined : Math.max(0, date - Date.now());
}

/** Retries once on transient failures (rate limit, server error), honoring short Retry-After values. */
export async function withRetry<T>(run: () => Promise<T>, onRetry: (error: ProviderError, waitMs: number) => void, signal?: AbortSignal): Promise<T> {
  signal?.throwIfAborted();
  try {
    return await run();
  } catch (error) {
    signal?.throwIfAborted();
    if (!(error instanceof ProviderError) || toolsUnsupported(error)) throw error;
    const waitMs =
      error.kind === "rate_limit" ? (error.retryAfterMs ?? 2000) : error.kind === "server" ? 1500 : Number.POSITIVE_INFINITY;
    if (waitMs > 15_000) throw error;
    onRetry(error, waitMs);
    await setTimeout(waitMs, undefined, { signal });
    return run();
  }
}

/** URL without query string (some providers put keys there). */
export const safeUrl = (url: string): string => url.split("?")[0] ?? url;

export const trimSlash = (url: string): string => url.trim().replace(/\/+$/, "");
