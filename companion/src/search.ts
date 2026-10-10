// Web search for Lilith's replies. Two backends:
// - "local": DuckDuckGo's lite page, queried straight from this PC. Free, no account or key.
// - "firecrawl": Firecrawl's search API with the user's key. Sturdier, never rate-limited by a captcha.

import { z } from "zod";
import { requestJson } from "./providers/http.ts";

export const searchModes = ["off", "local", "firecrawl"] as const;
export type SearchMode = (typeof searchModes)[number];

export interface SearchSettings {
  mode: SearchMode;
  /** Firecrawl key; ignored by the other modes. */
  apiKey: string;
}

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

export type Searcher = (query: string, signal?: AbortSignal) => Promise<SearchResult[]>;

const MAX_RESULTS = 5;
const TIMEOUT_MS = 15_000;
const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36";

/** The search function for the current settings, or null when search is off or not usable yet. */
export function createSearcher(settings: SearchSettings): Searcher | null {
  switch (settings.mode) {
    case "off":
      return null;
    case "local":
      return searchDuckDuckGo;
    case "firecrawl":
      return settings.apiKey ? (query, signal) => searchFirecrawl(query, settings.apiKey, signal) : null;
  }
}

export async function searchDuckDuckGo(query: string, signal?: AbortSignal): Promise<SearchResult[]> {
  const timeout = AbortSignal.timeout(TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetch("https://lite.duckduckgo.com/lite/", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", "user-agent": USER_AGENT },
      body: new URLSearchParams({ q: query }),
      signal: signal ? AbortSignal.any([timeout, signal]) : timeout,
    });
  } catch (error) {
    if (timeout.aborted) throw new Error(`DuckDuckGo did not answer within ${TIMEOUT_MS / 1000} s`);
    throw new Error(`Could not reach DuckDuckGo (${error instanceof Error ? error.message : String(error)})`);
  }
  const html = await response.text();
  if (!response.ok) throw new Error(`HTTP ${response.status} from DuckDuckGo`);
  const results = parseDuckDuckGoLite(html);
  // A bot check comes back as a 200/202 page without results.
  if (results.length === 0 && /anomaly|captcha|challenge/i.test(html)) {
    throw new Error("DuckDuckGo is temporarily blocking searches from this PC; try again later or use Firecrawl");
  }
  return results;
}

/** Pulls results out of lite.duckduckgo.com: each `result-link` anchor is followed by its `result-snippet` cell. */
export function parseDuckDuckGoLite(html: string): SearchResult[] {
  const results: SearchResult[] = [];
  const links = [...html.matchAll(/<a[^>]*href="([^"]+)"[^>]*class=['"]result-link['"][^>]*>([\s\S]*?)<\/a>/g)];
  for (const [index, link] of links.entries()) {
    const url = resolveDuckDuckGoUrl(decodeEntities(link[1]!));
    if (!url) continue;
    const end = links[index + 1]?.index ?? html.length;
    const snippet = /class=['"]result-snippet['"][^>]*>([\s\S]*?)<\/td>/.exec(html.slice(link.index, end))?.[1] ?? "";
    results.push({ title: cleanHtml(link[2]!), url, snippet: cleanHtml(snippet) });
    if (results.length >= MAX_RESULTS) break;
  }
  return results;
}

/** Unwraps DuckDuckGo's redirect links and drops its own (ad) links. */
function resolveDuckDuckGoUrl(href: string): string | null {
  try {
    const url = new URL(href, "https://duckduckgo.com");
    if (url.hostname.endsWith("duckduckgo.com")) {
      const target = url.searchParams.get("uddg");
      return target && /^https?:/.test(target) ? target : null;
    }
    return url.href;
  } catch {
    return null;
  }
}

const FirecrawlResponse = z.object({
  data: z.object({
    web: z.array(z.object({ title: z.string().nullish(), url: z.string(), description: z.string().nullish() })).default([]),
  }),
});

export async function searchFirecrawl(query: string, apiKey: string, signal?: AbortSignal): Promise<SearchResult[]> {
  const json = await requestJson(
    "https://api.firecrawl.dev/v2/search",
    { headers: { authorization: `Bearer ${apiKey}` }, body: { query: query.slice(0, 500), limit: MAX_RESULTS, sources: ["web"] } },
    { timeoutMs: TIMEOUT_MS, signal },
  );
  const parsed = FirecrawlResponse.safeParse(json);
  if (!parsed.success) throw new Error(`Unexpected Firecrawl response: ${JSON.stringify(json).slice(0, 200)}`);
  return parsed.data.data.web.map((result) => ({
    title: result.title ?? result.url,
    url: result.url,
    snippet: result.description ?? "",
  }));
}

const cleanHtml = (html: string): string =>
  decodeEntities(html.replace(/<[^>]+>/g, ""))
    .replace(/\s+/g, " ")
    .trim();

const namedEntities: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, entity: string) => {
    if (entity[0] === "#") {
      const code = entity[1] === "x" || entity[1] === "X" ? Number.parseInt(entity.slice(2), 16) : Number(entity.slice(1));
      return Number.isFinite(code) ? String.fromCodePoint(code) : match;
    }
    return namedEntities[entity.toLowerCase()] ?? match;
  });
}
