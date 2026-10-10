// What a connected account looks like to the shelf: a few read-only sources, one per facet, that
// answer a Query with findings. Connectors parse their wire format into these at the boundary, so
// nothing past here sees Google's JSON.

import type { PrivateFacet } from "./facets.ts";
import type { Query } from "./query.ts";

/** One thing found, shaped for a small model: no URLs, no HTML, trimmed. */
export interface Finding {
  title: string;
  meta: string;
  excerpt: string;
}

/** A finding as a source returns it: when it is from, for merging newest first, and how to read it in full. */
export interface Hit extends Finding {
  at: number;
  read?: (signal: AbortSignal) => Promise<string>;
}

/** A live, read-only place to look. `search` is its only verb. */
export interface Source {
  readonly facet: PrivateFacet;
  /** "alex@gmail.com": named in problems and in the dashboard's Try it. */
  readonly label: string;
  search(query: Query, signal: AbortSignal): Promise<Hit[]>;
}

export type Problem = "reconnect" | "unreachable" | "timeout" | "unreadable";

/** Why a source could not answer, in the four words the note and the dashboard know. */
export class LookupError extends Error {
  override readonly name = "LookupError";

  constructor(
    readonly problem: Problem,
    message: string,
  ) {
    super(message);
  }
}
