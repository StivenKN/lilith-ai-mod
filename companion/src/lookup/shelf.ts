// Where a turn looks things up. Brain opens a shelf per turn and asks it three things: which
// facets the model may consult (the rules in the system prompt), whether a reply asked for a
// lookup, and what the lookup found.

import { errorMessage, type Log } from "../log.ts";
import type { ChatResult, ToolSpec } from "../providers/types.ts";
import { createSearcher, type SearchResult, type SearchSettings } from "../search.ts";
import { facets, type Facet } from "./facets.ts";

const offered: unique symbol = Symbol("offered");

/** A lookup this turn's shelf offered. Only `requestIn` mints one, so `look` never runs what the model wasn't allowed to ask for. */
export interface LookupRequest {
  readonly [offered]: true;
  readonly facet: Facet;
  readonly query: string;
}

export type Found =
  | { kind: "results"; query: string; results: readonly SearchResult[] }
  | { kind: "failed"; query: string };

export interface Shelf {
  /** Settings only, never content, so the system prompt stays the same across the turn. */
  readonly facets: readonly Facet[];
  /** Empty while only the web is offered, since it keeps its tag; a private facet is offered as a tool. */
  readonly tools: readonly ToolSpec[];
  /** The lookup a reply asked for, or null when it asked for none or none was offered. */
  requestIn(step: Pick<ChatResult, "text">): LookupRequest | null;
  /** Runs the lookup under the turn's signal. Never throws: a failure comes back as `failed`. */
  look(request: LookupRequest, signal?: AbortSignal): Promise<Found>;
}

/** Matches the model's request for a search, in English or Spanish: `[search: weather in Lima]`. */
const TAG = new RegExp(`[[(（【]\\s*(?:${facets.web.tag.join("|")})\\s*[:：]\\s*([^\\]）】\\n]{2,200}?)\\s*[\\])）】]`, "i");

/** Removes lookup tags from a reply (a model may still write one after it got its results). */
export const stripLookupTags = (text: string): string => text.replace(new RegExp(TAG.source, "gi"), "");

function tagQuery(text: string): string | null {
  const cleaned = text.replace(/<think(ing)?>[\s\S]*?<\/think(ing)?>/gi, "");
  return TAG.exec(cleaned)?.[1]?.trim().replace(/^["“«]|["”»]$/g, "") || null;
}

const closed: Shelf = { facets: [], tools: [], requestIn: () => null, look: async ({ query }) => ({ kind: "failed", query }) };

export function openShelf({ search, log }: { search: SearchSettings; log: Log }): Shelf {
  const searcher = createSearcher(search);
  if (!searcher) return closed;
  return {
    facets: ["web"],
    tools: [],
    requestIn(step) {
      const query = tagQuery(step.text);
      return query ? { [offered]: true, facet: "web", query } : null;
    },
    async look(request, signal) {
      try {
        const results = await searcher(request.query, signal);
        log.info(`web search (${search.mode}) "${request.query}": ${results.length} result(s)`);
        return { kind: "results", query: request.query, results };
      } catch (error) {
        log.warn(`web search (${search.mode}) "${request.query}" failed: ${errorMessage(error)}`);
        return { kind: "failed", query: request.query };
      }
    },
  };
}
