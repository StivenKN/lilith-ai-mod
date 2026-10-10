// The Google connector against scripts/mock-google.ts: sign in, look in each facet, read the top
// hit in full, and survive an expired token; a revoked refresh token asks for a reconnect.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { startMockGoogle, type MockGoogle } from "../../../scripts/mock-google.ts";
import { parseQuery } from "../../lookup/query.ts";
import { LookupError, type Source } from "../../lookup/sources.ts";
import { accountId } from "../account.ts";
import { google, GOOGLE_SCOPE_OF } from "./google.ts";

let mock: MockGoogle;
const env = { url: process.env.LILITH_AI_GOOGLE_URL, id: process.env.LILITH_GOOGLE_CLIENT_ID, secret: process.env.LILITH_GOOGLE_CLIENT_SECRET };
beforeAll(() => {
  mock = startMockGoogle();
  process.env.LILITH_AI_GOOGLE_URL = mock.url;
  process.env.LILITH_GOOGLE_CLIENT_ID = "mock-client";
  process.env.LILITH_GOOGLE_CLIENT_SECRET = "GOCSPX-mock-secret";
});
afterAll(() => {
  mock.stop();
  process.env.LILITH_AI_GOOGLE_URL = env.url;
  process.env.LILITH_GOOGLE_CLIENT_ID = env.id;
  process.env.LILITH_GOOGLE_CLIENT_SECRET = env.secret;
});

const redirectUri = "http://127.0.0.1:47321/api/accounts/callback";
const never = new AbortController().signal;

/** Signs in through the mock's consent page the way the dashboard and the callback would. */
async function signIn() {
  const codeVerifier = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");
  const codeChallenge = new Bun.CryptoHasher("sha256").update(codeVerifier).digest("base64url");
  const consent = google.consentUrl({ redirectUri, state: "state-1", codeChallenge });
  expect(consent).toStartWith(`${mock.url}/auth?`);
  const page = await (await fetch(consent!)).text();
  const allow = new URL(/id="allow" href="([^"]+)"/.exec(page)![1]!.replace(/&amp;/g, "&"));
  expect(allow.origin + allow.pathname).toBe(redirectUri);
  expect(allow.searchParams.get("state")).toBe("state-1");
  return google.finish({ code: allow.searchParams.get("code")!, redirectUri, codeVerifier }, never);
}

const open = (connected: Awaited<ReturnType<typeof signIn>>, n: number) =>
  google.open({ id: accountId("google", `${connected.label}-${n}`), label: connected.label, facets: connected.facets, settings: connected.settings, secret: connected.secret });
const source = (sources: Source[], facet: Source["facet"]) => sources.find((candidate) => candidate.facet === facet)!;

describe("Google connector", () => {
  test("signs in with PKCE, learns the address, and reads mail, files and calendar", async () => {
    const connected = await signIn();
    expect(connected).toMatchObject({ label: "alex@gmail.com", settings: { user: "alex@gmail.com" }, facets: ["mail", "files", "calendar"] });
    expect(connected.secret.refreshToken).toStartWith("1//");
    expect(google.secretsOf(connected.secret)).toEqual([connected.secret.refreshToken]);
    const sources = open(connected, 1);

    const mail = await source(sources, "mail").search(parseQuery("laura"), never);
    expect(mail).toHaveLength(1);
    expect(mail[0]).toMatchObject({ title: "Fotos del viaje", meta: expect.stringMatching(/^Laura Pérez, \d{4}-\d{2}-\d{2} \d{2}:\d{2}$/), excerpt: expect.stringContaining("fotos del viaje a Cartagena") });
    expect(await mail[0]!.read!(never)).toContain("hay una tuya en el muelle");
    // Gmail's operators go through; a day word becomes after:/before: and finds yesterday's mail only.
    expect((await source(sources, "mail").search(parseQuery("from:casero"), never)).map((hit) => hit.title)).toEqual(["Re: arriendo de octubre"]);
    expect((await source(sources, "mail").search(parseQuery("ayer"), never)).map((hit) => hit.title)).toEqual(["Fotos del viaje"]);

    const files = await source(sources, "files").search(parseQuery("presupuesto"), never);
    expect(files.map((hit) => [hit.title, hit.meta.split(",")[0]])).toEqual([["Presupuesto octubre", "Google Sheets"]]);
    expect(await files[0]!.read!(never)).toContain("Arriendo,1200000");
    const doc = await source(sources, "files").search(parseQuery("globant"), never);
    expect(await doc[0]!.read!(never)).toContain("Lideré el equipo de pagos");
    const text = await source(sources, "files").search(parseQuery("pilas"), never);
    expect(await text[0]!.read!(never)).toBe("Comprar pilas y leche. Llamar a mamá el domingo.");

    const events = await source(sources, "calendar").search(parseQuery("mañana"), never);
    expect(events).toEqual([{ title: "Dentista", meta: expect.stringMatching(/^\d{4}-\d{2}-\d{2} 15:00$/), excerpt: "Clínica Sonrisa, calle 85", at: expect.any(Number) }]);
    // Without a day word the calendar starts now, so yesterday's meeting shows only when asked for.
    expect((await source(sources, "calendar").search(parseQuery(""), never)).map((hit) => hit.title)).toEqual(["Dentista"]);
    expect((await source(sources, "calendar").search(parseQuery("ayer"), never)).map((hit) => hit.title)).toEqual(["Reunión de equipo"]);
  });

  test("an expired access token is refreshed once, inside the lookup", async () => {
    const sources = open(await signIn(), 2);
    await source(sources, "mail").search(parseQuery("steam"), never);
    const before = mock.refreshes;
    mock.expireTokens();
    expect((await source(sources, "mail").search(parseQuery("steam"), never)).map((hit) => hit.title)).toEqual(["Your Steam Guard code"]);
    expect(mock.refreshes).toBe(before + 1);
  });

  test("a revoked refresh token means the account must be connected again", async () => {
    const sources = open(await signIn(), 3);
    mock.revokeRefreshTokens();
    mock.expireTokens();
    const failure = await source(sources, "files").search(parseQuery("cv"), never).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(LookupError);
    expect((failure as LookupError).problem).toBe("reconnect");
  });

  test("a rate limit, a credential Google rejects after a refresh, or a build without a client pass; only a dead refresh token asks for a reconnect", async () => {
    const sources = open(await signIn(), 6);
    const problem = (facet: Source["facet"]) => source(sources, facet).search(parseQuery("laura"), never).then(() => "none", (error: unknown) => (error instanceof LookupError ? error.problem : "thrown"));
    try {
      mock.deny(403);
      expect(await problem("mail")).toBe("unreadable");
      mock.deny(401);
      expect(await problem("calendar")).toBe("unreadable");
    } finally {
      mock.deny(null);
    }
    const id = process.env.LILITH_GOOGLE_CLIENT_ID;
    delete process.env.LILITH_GOOGLE_CLIENT_ID;
    try {
      mock.expireTokens();
      expect(await problem("files")).toBe("unreachable");
    } finally {
      process.env.LILITH_GOOGLE_CLIENT_ID = id;
    }
  });

  test("every sign-in asks for every scope afresh, so an unticked one does not come back from an older grant", () => {
    const consent = new URL(google.consentUrl({ redirectUri, state: "s", codeChallenge: "c" })!);
    expect(consent.searchParams.has("include_granted_scopes")).toBe(false);
    expect(consent.searchParams.get("prompt")).toBe("consent");
  });

  test("the account gets only the facets Google actually granted", async () => {
    mock.grantOnly(["openid", "email", GOOGLE_SCOPE_OF.calendar]);
    try {
      const connected = await signIn();
      expect(connected.facets).toEqual(["calendar"]);
      expect(open(connected, 4).map((candidate) => candidate.facet)).toEqual(["calendar"]);
    } finally {
      mock.grantOnly(null);
    }
  });

  test("without a client in this build, there is no consent page", () => {
    const id = process.env.LILITH_GOOGLE_CLIENT_ID;
    delete process.env.LILITH_GOOGLE_CLIENT_ID;
    try {
      expect(google.consentUrl({ redirectUri, state: "s", codeChallenge: "c" })).toBeNull();
    } finally {
      process.env.LILITH_GOOGLE_CLIENT_ID = id;
    }
  });
});
