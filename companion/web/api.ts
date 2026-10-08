// Typed client for the companion's RPC table: inputs and outputs are inferred from the server.

import { useCallback, useEffect, useState } from "react";
import type { Api } from "../src/server.ts";
import type { LogEntry } from "../src/log.ts";

export class Unauthorized extends Error {}

export async function call<K extends keyof Api>(name: K, ...[input]: undefined extends Api[K]["input"] ? [Api[K]["input"]?] : [Api[K]["input"]]): Promise<Api[K]["output"]> {
  const response = await fetch(`/api/rpc/${name}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input ?? {}),
  });
  if (response.status === 401 || response.status === 403) throw new Unauthorized();
  const body: unknown = await response.json();
  if (!response.ok) throw new Error((body as { error?: string }).error ?? `HTTP ${response.status}`);
  return body as Api[K]["output"];
}

export type Output<K extends keyof Api> = Api[K]["output"];

/** Loads a procedure once on mount; `reload` refetches. */
export function useRpc<K extends keyof Api>(name: K) {
  const [data, setData] = useState<Api[K]["output"] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const reload = useCallback(async () => {
    try {
      setData(await (call as (name: K) => Promise<Api[K]["output"]>)(name));
      setError(null);
    } catch (caught) {
      setError(caught instanceof Unauthorized ? "unauthorized" : caught instanceof Error ? caught.message : String(caught));
    }
  }, [name]);
  useEffect(() => {
    void reload();
  }, [reload]);
  return { data, error, reload, setData };
}

/** Exchanges the one-run token from the URL for a session cookie, then hides it from the URL. */
export async function startSession(): Promise<void> {
  const url = new URL(location.href);
  const token = url.searchParams.get("t");
  if (!token) return;
  await fetch("/api/session", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token }) });
  url.searchParams.delete("t");
  history.replaceState(null, "", url.pathname + url.hash);
}

/** Live server events: log lines and "something changed" pings from the brain, the updater and the settings. */
export function useServerEvents(onLog: ((entry: LogEntry) => void) | null, onChange: () => void) {
  useEffect(() => {
    const source = new EventSource("/api/events");
    if (onLog) source.addEventListener("log", (event) => onLog(JSON.parse((event as MessageEvent<string>).data) as LogEntry));
    source.addEventListener("brain", () => onChange());
    source.addEventListener("update", () => onChange());
    source.addEventListener("config", () => onChange());
    return () => source.close();
  }, [onLog, onChange]);
}
