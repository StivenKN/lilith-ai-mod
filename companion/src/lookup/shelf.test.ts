import { describe, expect, spyOn, test } from "bun:test";
import { Logger } from "../log.ts";
import type { Gate } from "./gate.ts";
import { consult, openShelf, stripLookupTags } from "./shelf.ts";
import { LookupError, type Hit, type Source } from "./sources.ts";

const log = new Logger(null).scope("test");
const off = { mode: "off" as const, apiKey: "" };
const firecrawl = { mode: "firecrawl" as const, apiKey: "fc-test-key-123456" };
const player: Gate = { origin: "player", audience: "local" };
const none = { sources: () => [] };

/** A mail account that answers every query with the same hits, or throws. */
const mailbox = (label: string, hits: Hit[] | Error): Source => ({
  facet: "mail",
  label,
  search: async () => { if (hits instanceof Error) throw hits; return hits; },
});
const hit = (title: string, at: number, extra: Partial<Hit> = {}): Hit => ({ title, meta: `Someone, ${at}`, excerpt: `about ${title}`, at, ...extra });
const call = (name: string, input: unknown, error?: string) => ({ id: "c1", name, input, ...(error ? { error } : {}) });

describe("openShelf", () => {
  test("offers the web only when search is usable, and reads the tag the model wrote", () => {
    expect(openShelf({ gate: player, tools: false, search: off, accounts: none, log }).facets).toEqual([]);
    expect(openShelf({ gate: player, tools: false, search: { ...firecrawl, apiKey: "" }, accounts: none, log }).facets).toEqual([]);
    const shelf = openShelf({ gate: player, tools: false, search: firecrawl, accounts: none, log });
    expect(shelf.facets).toEqual(["web"]);
    expect(shelf.tools).toEqual([]);
    for (const [reply, query] of [
      ["[search: weather in Lima today]", "weather in Lima today"],
      ["[buscar: precio del dólar]", "precio del dólar"],
      ['<think>maybe [search: no]</think> [Search: "new Zelda release date"]', "new Zelda release date"],
      ["[happy] Of course!", null],
    ] as const) expect(shelf.requestIn({ text: reply })?.query ?? null).toBe(query);
    expect(openShelf({ gate: player, tools: false, search: off, accounts: none, log }).requestIn({ text: "[search: anything]" })).toBeNull();
  });

  test("a private facet is offered as a tool, and takes the web with it, only when the model takes tools and the gate lets the account through", () => {
    const accounts = { sources: (gate: Gate) => (gate.origin === "player" ? [mailbox("alex@gmail.com", [])] : []) };
    const shelf = openShelf({ gate: player, tools: true, search: firecrawl, accounts, log });
    expect(shelf.facets).toEqual(["web", "mail"]);
    expect(shelf.tools.map((tool) => tool.name)).toEqual(["web_search", "email"]);
    expect(openShelf({ gate: player, tools: false, search: firecrawl, accounts, log })).toMatchObject({ facets: ["web"], tools: [] });
    expect(openShelf({ gate: { origin: "autonomous", audience: "local" }, tools: true, search: firecrawl, accounts, log })).toMatchObject({ facets: ["web"], tools: [] });
    expect(openShelf({ gate: player, tools: true, search: off, accounts, log })).toMatchObject({ facets: ["mail"] });
    expect(openShelf({ gate: player, tools: true, search: off, accounts, log }).tools.map((tool) => tool.name)).toEqual(["email"]);
  });

  test("with tools offered, the request comes from a lookup call; a malformed one or a PC tool is not a lookup", () => {
    const accounts = { sources: () => [mailbox("alex@gmail.com", [])] };
    const shelf = openShelf({ gate: player, tools: true, search: firecrawl, accounts, log });
    expect(shelf.requestIn({ text: "", calls: [call("email", { query: " laura " })] })).toMatchObject({ facet: "mail", query: "laura" });
    expect(shelf.requestIn({ text: "", calls: [call("web_search", { query: "clima en Lima" })] })).toMatchObject({ facet: "web", query: "clima en Lima" });
    expect(shelf.requestIn({ text: "", calls: [call("email", { q: "laura" })] })).toBeNull();
    expect(shelf.requestIn({ text: "", calls: [call("email", null, "Malformed tool call.")] })).toBeNull();
    expect(shelf.requestIn({ text: "", calls: [call("open_app", { name: "Notepad" })] })).toBeNull();
    expect(shelf.requestIn({ text: "[buscar: clima en Lima]", calls: [] })).toMatchObject({ facet: "web" });
    // Without tools, a call named like a lookup tool is nobody's request.
    expect(openShelf({ gate: player, tools: false, search: firecrawl, accounts, log }).requestIn({ text: "", calls: [call("email", { query: "laura" })] })).toBeNull();
  });

  test("stripLookupTags leaves the rest of the reply", () => {
    expect(stripLookupTags("[feliz] Ya busqué. [buscar: algo]").trim()).toBe("[feliz] Ya busqué.");
  });

  test("look searches under the turn's signal; a failure or an abort comes back as failed, never thrown", async () => {
    const shelf = openShelf({ gate: player, tools: false, search: firecrawl, accounts: none, log });
    const request = shelf.requestIn({ text: "[search: weather in Lima]" })!;
    const realFetch = globalThis.fetch;
    const signals: AbortSignal[] = [];
    let answer: "results" | "error" | "hang" = "results";
    let started = () => {};
    const spy = spyOn(globalThis, "fetch").mockImplementation((async (input: RequestInfo | URL, init?: RequestInit) => {
      if (!String(input).startsWith("https://api.firecrawl.dev/")) return realFetch(input, init);
      const signal = init?.signal;
      if (signal) signals.push(signal);
      if (answer === "error") return Response.json({ error: "nope" }, { status: 500 });
      if (answer === "results") return Response.json({ success: true, data: { web: [{ title: "Lima weather", url: "https://www.bbc.com/weather/lima", description: "19 °C" }] } });
      started();
      return new Promise<Response>((_resolve, reject) => signal?.addEventListener("abort", () => reject(signal.reason)));
    }) as typeof fetch);
    try {
      expect(await shelf.look(request, "")).toEqual({ kind: "results", query: "weather in Lima", results: [{ title: "Lima weather", url: "https://www.bbc.com/weather/lima", snippet: "19 °C" }] });
      answer = "error";
      expect(await shelf.look(request, "")).toEqual({ kind: "failed", query: "weather in Lima" });
      answer = "hang";
      const reached = new Promise<void>((resolve) => { started = resolve; });
      const turn = new AbortController();
      const pending = shelf.look(request, "", turn.signal);
      await reached;
      turn.abort();
      expect(await pending).toEqual({ kind: "failed", query: "weather in Lima" });
      expect(signals.at(-1)?.aborted).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });

  test("a lookup in her accounts comes back as one section the prompt can describe", async () => {
    const accounts = { sources: () => [mailbox("alex@gmail.com", [hit("Fotos del viaje", 2)])] };
    const shelf = openShelf({ gate: player, tools: true, search: off, accounts, log });
    const request = shelf.requestIn({ text: "", calls: [call("email", { query: "laura" })] })!;
    expect(await shelf.look(request, "¿qué me escribió Laura?")).toEqual({
      kind: "consulted", query: "laura",
      sections: [{ facet: "mail", findings: [{ title: "Fotos del viaje", meta: "Someone, 2", excerpt: "about Fotos del viaje" }], expanded: null, problems: [] }],
    });
  });
});

describe("consult", () => {
  const options = { facet: "mail" as const, query: "viaje", budget: 1500, log };

  test("fans out to every account, merges newest first, keeps five, reads the top one, and drops links", async () => {
    const read = async () => "Hola Alex, las fotos están en https://photos.example.com/x y hay una tuya.\n\n\n\nNos vemos.";
    const work = mailbox("alex@work.com", [hit("Reunión", 5), hit("Viejo", 1)]);
    const home = mailbox("alex@gmail.com", [hit("Fotos del viaje", 7, { read, excerpt: "mira https://t.co/abc ahora" }), hit("Uno", 2), hit("Dos", 3), hit("Tres", 4)]);
    const section = await consult({ ...options, sources: [work, home] });
    expect(section.findings.map((finding) => finding.title)).toEqual(["Fotos del viaje", "Reunión", "Tres", "Dos", "Uno"]);
    expect(section.findings[0]?.excerpt).toBe("mira (link) ahora");
    expect(section.expanded).toEqual({ title: "Fotos del viaje", text: "Hola Alex, las fotos están en (link) y hay una tuya.\n\nNos vemos." });
    expect(section.problems).toEqual([]);
  });

  test("the calendar lists what is coming up first, soonest first, and only then the most recent past", async () => {
    const day = 86400_000;
    const now = Date.now();
    const event = (days: number): Hit => ({ title: `Standup ${days > 0 ? "+" : ""}${days}d`, meta: "", excerpt: "", at: now + days * day });
    const calendar: Source = { facet: "calendar", label: "alex@gmail.com", search: async () => [-6, -5, -4, -2, -1, 1, 3].map(event) };
    const section = await consult({ ...options, facet: "calendar", sources: [calendar] });
    expect(section.findings.map((finding) => finding.title)).toEqual(["Standup +1d", "Standup +3d", "Standup -1d", "Standup -2d", "Standup -4d"]);
  });

  test("the full text is cut to the audience's budget, and skipped when the findings leave no room", async () => {
    const long = mailbox("a", [hit("Carta", 1, { read: async () => "x".repeat(5000) })]);
    const [finding] = (await consult({ ...options, sources: [long] })).findings;
    const listed = finding!.title.length + finding!.meta.length + finding!.excerpt.length + 8;
    expect((await consult({ ...options, sources: [long] })).expanded?.text.length).toBe(1500 - listed);
    expect((await consult({ ...options, sources: [long], budget: 60 })).expanded).toBeNull();
  });

  test("a failed account is named with its problem, and the others still answer", async () => {
    const gone = mailbox("alex@old.com", new LookupError("reconnect", "invalid_grant"));
    const down = mailbox("alex@work.com", new Error("socket hang up"));
    const fine = mailbox("alex@gmail.com", [hit("Fotos", 1)]);
    const section = await consult({ ...options, sources: [gone, down, fine] });
    expect(section.findings.map((finding) => finding.title)).toEqual(["Fotos"]);
    expect(section.problems).toEqual([{ label: "alex@old.com", problem: "reconnect" }, { label: "alex@work.com", problem: "unreachable" }]);
    const unreadable = mailbox("alex@gmail.com", [hit("Fotos", 1, { read: async () => { throw new Error("export failed"); } })]);
    expect((await consult({ ...options, sources: [unreadable] })).problems).toEqual([{ label: "alex@gmail.com", problem: "unreadable" }]);
  });

  test("an invented operator query that finds nothing is retried once with the player's own words", async () => {
    const asked: string[] = [];
    const source: Source = { facet: "mail", label: "alex@gmail.com", search: async (query) => { asked.push(query.text); return query.words.includes("casero") ? [hit("Re: arriendo", 1)] : []; } };
    const section = await consult({ ...options, sources: [source], query: "from:work@example.com", said: "¿me respondió el casero?" });
    expect(asked).toEqual(["", "¿me respondió el casero?"]);
    expect(section.findings).toHaveLength(1);
    // The player's own words that find nothing are not tried twice.
    asked.length = 0;
    await consult({ ...options, sources: [source], query: "fotos", said: "¿tengo fotos nuevas?" });
    expect(asked).toEqual(["fotos"]);
  });
});
