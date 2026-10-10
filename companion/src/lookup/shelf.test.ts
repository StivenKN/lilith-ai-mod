import { describe, expect, spyOn, test } from "bun:test";
import { Logger } from "../log.ts";
import { openShelf, stripLookupTags } from "./shelf.ts";

const log = new Logger(null).scope("test");
const off = { mode: "off" as const, apiKey: "" };
const firecrawl = { mode: "firecrawl" as const, apiKey: "fc-test-key-123456" };

describe("openShelf", () => {
  test("offers the web only when search is usable, and reads the tag the model wrote", () => {
    expect(openShelf({ search: off, log }).facets).toEqual([]);
    expect(openShelf({ search: { ...firecrawl, apiKey: "" }, log }).facets).toEqual([]);
    const shelf = openShelf({ search: firecrawl, log });
    expect(shelf.facets).toEqual(["web"]);
    expect(shelf.tools).toEqual([]);
    for (const [reply, query] of [
      ["[search: weather in Lima today]", "weather in Lima today"],
      ["[buscar: precio del dólar]", "precio del dólar"],
      ['<think>maybe [search: no]</think> [Search: "new Zelda release date"]', "new Zelda release date"],
      ["[happy] Of course!", null],
    ] as const) expect(shelf.requestIn({ text: reply })?.query ?? null).toBe(query);
    expect(openShelf({ search: off, log }).requestIn({ text: "[search: anything]" })).toBeNull();
  });

  test("stripLookupTags leaves the rest of the reply", () => {
    expect(stripLookupTags("[feliz] Ya busqué. [buscar: algo]").trim()).toBe("[feliz] Ya busqué.");
  });

  test("look searches under the turn's signal; a failure or an abort comes back as failed, never thrown", async () => {
    const shelf = openShelf({ search: firecrawl, log });
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
      expect(await shelf.look(request)).toEqual({ kind: "results", query: "weather in Lima", results: [{ title: "Lima weather", url: "https://www.bbc.com/weather/lima", snippet: "19 °C" }] });
      answer = "error";
      expect(await shelf.look(request)).toEqual({ kind: "failed", query: "weather in Lima" });
      answer = "hang";
      const reached = new Promise<void>((resolve) => { started = resolve; });
      const turn = new AbortController();
      const pending = shelf.look(request, turn.signal);
      await reached;
      turn.abort();
      expect(await pending).toEqual({ kind: "failed", query: "weather in Lima" });
      expect(signals.at(-1)?.aborted).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });
});
