import { expect, test } from "bun:test";
import { audienceOf, mayConsult, originOf } from "./gate.ts";

const shared = { enabled: true, shareOnline: true };
const kept = { enabled: true, shareOnline: false };
const paused = { enabled: false, shareOnline: true };

test("private facets: player turns only, enabled accounts only, online only when shared", () => {
  expect(mayConsult("mail", kept, { origin: "player", audience: "local" })).toBe(true);
  expect(mayConsult("mail", kept, { origin: "player", audience: "online" })).toBe(false);
  expect(mayConsult("mail", shared, { origin: "player", audience: "online" })).toBe(true);
  expect(mayConsult("mail", paused, { origin: "player", audience: "local" })).toBe(false);
  expect(mayConsult("mail", null, { origin: "player", audience: "local" })).toBe(false);
  for (const audience of ["local", "online"] as const) expect(mayConsult("mail", shared, { origin: "autonomous", audience })).toBe(false);
});

test("the web is public: every turn may search it, with or without an account", () => {
  expect(mayConsult("web", null, { origin: "autonomous", audience: "online" })).toBe(true);
});

test("speak-first and keepsake reactions are autonomous; the game and the dashboard are the player", () => {
  expect(originOf).toEqual({ game: "player", dashboard: "player", speakFirst: "autonomous", keepsake: "autonomous" });
});

test("the audience is online unless the AI is on this PC or LAN", () => {
  expect(audienceOf({ baseUrl: "http://127.0.0.1:11434" })).toBe("local");
  expect(audienceOf({ baseUrl: "http://192.168.1.4:8080/v1" })).toBe("local");
  expect(audienceOf({ baseUrl: "https://api.openai.com/v1" })).toBe("online");
});
