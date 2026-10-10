import { expect, test } from "bun:test";
import { parseQuery } from "./query.ts";

// A Thursday evening; "this week" runs Monday the 5th to Monday the 12th.
const now = new Date(2026, 9, 8, 19, 30);
const day = (date: number) => new Date(2026, 9, date);

test("day words become a local-time window and leave the query, in Spanish and English", () => {
  expect(parseQuery("Laura ayer", now)).toMatchObject({ text: "Laura", words: ["laura"], window: { since: day(7), until: day(8) } });
  expect(parseQuery("dentist tomorrow", now).window).toEqual({ since: day(9), until: day(10) });
  expect(parseQuery("reunión hoy", now).window).toEqual({ since: day(8), until: day(9) });
  expect(parseQuery("plans this week", now)).toMatchObject({ text: "plans", window: { since: day(5), until: day(12) } });
  expect(parseQuery("mañanas de lunes", now).window).toBeNull();
});

test("from: is taken out for sources that have no such operator, and the words are folded", () => {
  expect(parseQuery("from:laura fotos del viaje")).toMatchObject({ text: "fotos del viaje", from: "laura", words: ["fotos", "del", "viaje"] });
  expect(parseQuery("from:(casero@example.com) arriendo")).toMatchObject({ from: "casero@example.com", text: "arriendo" });
  expect(parseQuery("  Presupuesto   Octubre ")).toEqual({ text: "Presupuesto Octubre", words: ["presupuesto", "octubre"], window: null, from: null });
});
