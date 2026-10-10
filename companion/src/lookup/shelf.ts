// Where a turn looks things up. Brain opens a shelf per turn and asks it three things: which
// facets the model may consult (the rules in the system prompt and the tools), whether a reply
// asked for a lookup, and what the lookup found. Behind it sit the privacy gate, tool and tag
// parsing, the fan-out across accounts, timeouts, budgets, retries and failure capture.

import { z } from "zod";
import { errorMessage, type Log } from "../log.ts";
import type { ChatResult, ToolCall, ToolSpec } from "../providers/types.ts";
import { createSearcher, type SearchResult, type SearchSettings } from "../search.ts";
import { facets, privateFacets, type Facet, type PrivateFacet } from "./facets.ts";
import type { Audience, Gate } from "./gate.ts";
import { foldWords, parseQuery } from "./query.ts";
import { LookupError, type Finding, type Hit, type Problem, type Source } from "./sources.ts";

const offered: unique symbol = Symbol("offered");

/** A lookup this turn's shelf offered. Only `requestIn` mints one, so `look` never runs what the model wasn't allowed to ask for. */
export interface LookupRequest {
  readonly [offered]: true;
  readonly facet: Facet;
  readonly query: string;
}

export interface Section {
  facet: PrivateFacet;
  findings: readonly Finding[];
  /** The top finding read in full, within the budget, when its source can read. */
  expanded: { title: string; text: string } | null;
  /** Accounts that were asked and failed, named so she can say so. */
  problems: readonly { label: string; problem: Problem }[];
}

export type Found =
  | { kind: "results"; query: string; results: readonly SearchResult[] }
  | { kind: "failed"; query: string }
  | { kind: "consulted"; query: string; sections: readonly Section[] };

export interface Shelf {
  /** Settings, accounts and origin only, never content, so the system prompt stays the same across the turn. */
  readonly facets: readonly Facet[];
  /** One `{query}` tool per offered facet once a private facet is offered; empty while the web keeps its tag. */
  readonly tools: readonly ToolSpec[];
  /** The lookup a reply asked for, by tool call first and then by the web tag; null when none, or none was offered. */
  requestIn(step: Pick<ChatResult, "text"> & { calls?: readonly ToolCall[] }): LookupRequest | null;
  /** Runs the lookup under the turn's signal. Never throws: a failure comes back as `failed` or as a named problem. */
  look(request: LookupRequest, said: string, signal?: AbortSignal): Promise<Found>;
  /** The same shelf for a model that rejected the tools: the web keeps its tag, and her accounts stay closed this turn. */
  withoutTools(): Shelf;
}

/** How much of what she found fits in the note: a 4B on an 8k context reads less than an online model. */
export const LOOKUP_BUDGET = { local: 1500, online: 4000 } as const satisfies Record<Audience, number>;
const SOURCE_TIMEOUT_MS = 10_000;
const MAX_FINDINGS = 5;
/** Caps per field, so one 48 KB subject cannot take the whole budget. */
const TITLE_MAX_CHARS = 200;
const META_MAX_CHARS = 120;
const EXCERPT_MAX_CHARS = 300;
/** Less room than this for the full text, and only the findings go in. */
const MIN_EXPANSION_CHARS = 80;

/** Newest first, except the calendar: what is coming up, soonest first, and only then the most recent past. */
function order(facet: Facet, now: number): (a: Hit, b: Hit) => number {
  if (facet !== "calendar") return (a, b) => b.at - a.at;
  return (a, b) => {
    const [aUp, bUp] = [a.at >= now, b.at >= now];
    if (aUp !== bUp) return aUp ? -1 : 1;
    return aUp ? a.at - b.at : b.at - a.at;
  };
}

const QueryInput = z.object({ query: z.string().trim().min(1).max(200) });

export const lookupTool = (facet: Facet): ToolSpec => ({ name: facets[facet].tool, description: facets[facet].description, input: QueryInput });

/** Matches the model's request for a search, in English or Spanish: `[search: weather in Lima]`. */
const TAG = new RegExp(`[[(（【]\\s*(?:${facets.web.tag.join("|")})\\s*[:：]\\s*([^\\]）】\\n]{2,200}?)\\s*[\\])）】]`, "i");

/** Removes lookup tags from a reply (a model may still write one after it got its results). */
export const stripLookupTags = (text: string): string => text.replace(new RegExp(TAG.source, "gi"), "");

function tagQuery(text: string): string | null {
  const cleaned = text.replace(/<think(ing)?>[\s\S]*?<\/think(ing)?>/gi, "");
  return TAG.exec(cleaned)?.[1]?.trim().replace(/^["“«]|["”»]$/g, "") || null;
}

const closed: Shelf = { facets: [], tools: [], requestIn: () => null, look: async ({ query }) => ({ kind: "failed", query }), withoutTools: () => closed };

export function openShelf(options: {
  gate: Gate;
  /** Whether the model takes tools. False keeps today's web tag and offers no private facet (P-SURFACE run 4). */
  tools: boolean;
  search: SearchSettings;
  /** What the gate let through for this turn (`AccountStore.sources`), gathered once per turn. */
  sources: readonly Source[];
  log: Log;
}): Shelf {
  const { gate, tools, search, log } = options;
  const searcher = createSearcher(search);
  const sources = tools ? options.sources : [];
  const privates = privateFacets.filter((facet) => sources.some((source) => source.facet === facet));
  const offeredFacets: Facet[] = [...(searcher ? ["web" as const] : []), ...privates];
  if (offeredFacets.length === 0) return closed;
  // One wire per session: once a private facet is offered, the web is a tool too and its tag rule leaves the prompt.
  const toolList = privates.length ? offeredFacets.map(lookupTool) : [];
  const facetOfTool = new Map<string, Facet>(offeredFacets.map((facet) => [facets[facet].tool, facet]));
  const mint = (facet: Facet, query: string): LookupRequest => ({ [offered]: true, facet, query });
  return {
    facets: offeredFacets,
    tools: toolList,
    requestIn(step) {
      for (const call of step.calls ?? []) {
        const facet = toolList.length ? facetOfTool.get(call.name) : undefined;
        if (!facet || call.error) continue;
        const input = QueryInput.safeParse(call.input);
        if (input.success) return mint(facet, input.data.query);
      }
      const query = searcher ? tagQuery(step.text) : null;
      return query ? mint("web", query) : null;
    },
    async look(request, said, signal) {
      if (request.facet === "web") {
        if (!searcher) return { kind: "failed", query: request.query };
        try {
          const results = await searcher(request.query, signal);
          log.info(`web search (${search.mode}) "${request.query}": ${results.length} result(s)`);
          return { kind: "results", query: request.query, results };
        } catch (error) {
          log.warn(`web search (${search.mode}) "${request.query}" failed: ${errorMessage(error)}`);
          return { kind: "failed", query: request.query };
        }
      }
      if (!privates.includes(request.facet)) return { kind: "failed", query: request.query };
      const section = await consult({ sources: sources.filter((source) => source.facet === request.facet), facet: request.facet, query: request.query, said, budget: LOOKUP_BUDGET[gate.audience], log, ...(signal ? { signal } : {}) });
      return { kind: "consulted", query: request.query, sections: [section] };
    },
    withoutTools: () => openShelf({ ...options, tools: false }),
  };
}

/** Operators and copied examples: a query the model made up rather than took from the player. */
const INVENTED = /\b\w+:\S|\b(?:the words to (?:look|search) for|consulta breve|short query|from:name)\b/i;

/**
 * Looks in every source of one facet, in parallel and under the turn's signal with 10 s each,
 * merges the findings, reads the top one in full within the budget, and names the accounts that
 * failed. Never throws, and never logs the query or what was found. An invented query that finds
 * nothing is tried once more with the player's own words.
 */
export async function consult(options: { sources: readonly Source[]; facet: PrivateFacet; query: string; said?: string; budget: number; signal?: AbortSignal; log: Log }): Promise<Section> {
  const started = performance.now();
  let section = await gather(options);
  const { said } = options;
  if (section.findings.length === 0 && section.problems.length === 0 && said && INVENTED.test(options.query) && foldWords(said).join(" ") !== foldWords(options.query).join(" ")) {
    options.log.info(`${options.facet} lookup found nothing for an invented query; trying the player's words`);
    section = await gather({ ...options, query: said });
  }
  const problems = section.problems.map((problem) => `${problem.label} ${problem.problem}`).join(", ");
  options.log.info(`${options.facet} lookup: ${section.findings.length} finding(s) from ${options.sources.length} account(s) in ${Math.round(performance.now() - started)} ms${section.expanded ? ", top read in full" : ""}${problems ? ` (${problems})` : ""}`);
  return section;
}

async function gather({ sources, facet, query, budget, signal, log }: Parameters<typeof consult>[0]): Promise<Section> {
  const parsed = parseQuery(query);
  const perSource = () => {
    const timeout = AbortSignal.timeout(SOURCE_TIMEOUT_MS);
    return { timeout, signal: signal ? AbortSignal.any([signal, timeout]) : timeout };
  };
  const problem = (error: unknown, timeout: AbortSignal): Problem => (error instanceof LookupError ? error.problem : timeout.aborted || signal?.aborted ? "timeout" : "unreachable");
  const answers = await Promise.all(sources.map(async (source) => {
    const { timeout, signal } = perSource();
    try {
      return { source, hits: await source.search(parsed, signal) };
    } catch (error) {
      log.warn(`${facet} lookup: ${source.label} failed: ${errorMessage(error)}`);
      return { source, problem: problem(error, timeout) };
    }
  }));
  const problems = answers.flatMap((answer) => ("problem" in answer ? [{ label: answer.source.label, problem: answer.problem }] : []));
  const byRelevance = order(facet, Date.now());
  const hits = answers
    .flatMap((answer) => ("hits" in answer ? answer.hits.map((hit) => ({ source: answer.source, hit })) : []))
    .sort((a, b) => byRelevance(a.hit, b.hit))
    .slice(0, MAX_FINDINGS);
  // The budget covers the whole section: findings are listed while they fit, and the full text gets what is left.
  const kept: Array<{ source: Source; hit: Hit; finding: Finding }> = [];
  let used = 0;
  for (const { source, hit } of hits) {
    const finding = shape(hit);
    const size = finding.title.length + finding.meta.length + finding.excerpt.length + 8;
    if (used + size > budget) break;
    kept.push({ source, hit, finding });
    used += size;
  }
  let expanded: Section["expanded"] = null;
  const top = kept[0];
  const room = budget - used;
  if (top?.hit.read && room >= MIN_EXPANSION_CHARS) {
    const { timeout, signal } = perSource();
    try {
      const text = clean(await top.hit.read(signal), true).slice(0, room);
      if (text) expanded = { title: top.finding.title, text };
    } catch (error) {
      log.warn(`${facet} lookup: could not read the top finding from ${top.source.label}: ${errorMessage(error)}`);
      problems.push({ label: top.source.label, problem: error instanceof LookupError ? error.problem : timeout.aborted ? "timeout" : "unreadable" });
    }
  }
  return { facet, findings: kept.map(({ finding }) => finding), expanded, problems };
}

/**
 * No URLs, no square brackets (the note's fence, which nothing from their accounts may close), and
 * no runs of whitespace; `keepLines` leaves paragraph breaks in a full text.
 */
function clean(text: string, keepLines = false): string {
  const fenced = text.replace(/https?:\/\/[^\s)>\]]+/gi, "(link)").replace(/\[/g, "(").replace(/\]/g, ")");
  return (keepLines ? fenced.replace(/[ \t\r\f\v]+/g, " ").replace(/ ?\n ?/g, "\n").replace(/\n{3,}/g, "\n\n") : fenced.replace(/\s+/g, " ")).trim();
}

const shape = (hit: Hit): Finding => ({ title: clean(hit.title).slice(0, TITLE_MAX_CHARS), meta: clean(hit.meta).slice(0, META_MAX_CHARS), excerpt: clean(hit.excerpt).slice(0, EXCERPT_MAX_CHARS) });
