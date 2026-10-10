import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startMockGoogle, type MockGoogle } from "../../scripts/mock-google.ts";
import { Logger } from "../log.ts";
import type { PrivateFacet } from "../lookup/facets.ts";
import { parseQuery } from "../lookup/query.ts";
import { accountId } from "./account.ts";
import { catalog } from "./registry.ts";
import { AccountStore } from "./store.ts";

let root = "";
let mock: MockGoogle;
const env = { url: process.env.LILITH_AI_GOOGLE_URL, id: process.env.LILITH_GOOGLE_CLIENT_ID, secret: process.env.LILITH_GOOGLE_CLIENT_SECRET };
const stores: AccountStore[] = [];
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "lilith-accounts-"));
  mock = startMockGoogle();
  process.env.LILITH_AI_GOOGLE_URL = mock.url;
  process.env.LILITH_GOOGLE_CLIENT_ID = "mock-client";
  process.env.LILITH_GOOGLE_CLIENT_SECRET = "GOCSPX-mock-secret";
});
afterAll(async () => {
  for (const store of stores) store.close();
  mock.stop();
  process.env.LILITH_AI_GOOGLE_URL = env.url;
  process.env.LILITH_GOOGLE_CLIENT_ID = env.id;
  process.env.LILITH_GOOGLE_CLIENT_SECRET = env.secret;
  await rm(root, { recursive: true, force: true });
});

const google = catalog[0];
const logger = new Logger(null);
async function load(name: string) {
  const store = await AccountStore.load(join(root, name), logger.scope("accounts"), (secret) => logger.addSecret(secret));
  stores.push(store);
  return store;
}
/** What a finished Google sign-in hands the store, with a refresh token the mock knows. */
async function connected(user = "alex@gmail.com", facets: readonly PrivateFacet[] = ["mail"]) {
  const page = await (await fetch(`${mock.url}/auth?${new URLSearchParams({ response_type: "code", client_id: "mock-client", redirect_uri: "http://127.0.0.1:1/cb", scope: "openid email https://www.googleapis.com/auth/gmail.readonly", code_challenge: new Bun.CryptoHasher("sha256").update("verifier-verifier-verifier-verifier-verifier").digest("base64url"), code_challenge_method: "S256", state: "s", access_type: "offline" })}`)).text();
  const code = new URL(/id="allow" href="([^"]+)"/.exec(page)![1]!.replace(/&amp;/g, "&")).searchParams.get("code")!;
  const token = (await (await fetch(`${mock.url}/token`, { method: "POST", body: new URLSearchParams({ grant_type: "authorization_code", code, code_verifier: "verifier-verifier-verifier-verifier-verifier", client_id: "mock-client", client_secret: "x" }) })).json()) as { refresh_token: string };
  return { settings: { user }, secret: { refreshToken: token.refresh_token }, label: user, facets };
}
const until = async (done: () => boolean) => {
  for (let tries = 0; !done(); tries++) {
    if (tries > 300) throw new Error("timed out");
    await Bun.sleep(10);
  }
};

describe("AccountStore", () => {
  test("what leaves the store carries no credential, and the secret is hidden from the log", async () => {
    const store = await load("views");
    const account = await connected();
    const view = await store.add(google, account, false);
    expect(view).toMatchObject({ id: accountId("google", "alex@gmail.com"), entry: "google", label: "alex@gmail.com", facets: ["mail"], policy: { enabled: true, shareOnline: false }, power: "read", status: "ok" });
    expect(JSON.stringify(store.list())).not.toContain(account.secret.refreshToken);
    expect(logger.redact(`token ${account.secret.refreshToken} leaked`)).toBe("token *** leaked");
    // The same account connected again converges to the one entry and keeps what the player chose.
    await store.add(google, await connected(), true);
    expect(store.list()).toHaveLength(1);
    expect(store.list()[0]?.policy.shareOnline).toBe(false);
  });

  test("the player's choices outlive a reconnect, and the facets never widen past what Google granted", async () => {
    const store = await load("granted");
    const all = ["mail", "files", "calendar"] as const;
    const gate = { origin: "player", audience: "local" } as const;
    const view = await store.add(google, await connected("alex@gmail.com", all), true);
    await store.update(view.id, { facets: ["calendar"], policy: { enabled: false } });
    // Reconnected with Gmail unticked on Google's page: the policy stays, the facets stay narrow, the grant shrinks.
    await store.add(google, await connected("alex@gmail.com", ["files", "calendar"]), false);
    expect(store.list()).toHaveLength(1);
    expect(store.list()[0]).toMatchObject({ facets: ["calendar"], granted: ["files", "calendar"], policy: { enabled: false, shareOnline: true } });
    // Widening in the dashboard stops at the grant.
    expect((await store.update(view.id, { facets: [...all], policy: { enabled: true } })).facets).toEqual(["files", "calendar"]);
    expect(store.sources(gate).map((source) => source.facet)).toEqual(["files", "calendar"]);
  });

  test("a passing failure leaves the file alone; a dead credential met while reading in full is recorded like one met while searching", async () => {
    const store = await load("transient");
    const gate = { origin: "player", audience: "local" } as const;
    const view = await store.add(google, await connected(), false);
    mock.deny(403);
    try {
      await expect(store.sources(gate)[0]!.search(parseQuery("laura"), AbortSignal.timeout(2000))).rejects.toMatchObject({ problem: "unreadable" });
    } finally {
      mock.deny(null);
    }
    expect(JSON.parse(await readFile(join(store.dir, `${view.id}.json`), "utf8"))).toMatchObject({ status: "ok" });
    const [hit] = await store.sources(gate)[0]!.search(parseQuery("laura"), AbortSignal.timeout(2000));
    mock.revokeRefreshTokens();
    mock.expireTokens();
    await expect(hit!.read!(AbortSignal.timeout(2000))).rejects.toMatchObject({ problem: "reconnect" });
    expect(store.list()[0]?.status).toBe("reconnect");
  });

  test("the gate decides which sources a turn gets; the dashboard's Try it gets them all", async () => {
    const store = await load("gate");
    await store.add(google, await connected(), false);
    const [view] = store.list();
    expect(store.sources({ origin: "player", audience: "local" }).map((source) => [source.facet, source.label])).toEqual([["mail", "alex@gmail.com"]]);
    expect(store.sources({ origin: "player", audience: "online" })).toEqual([]);
    expect(store.sources({ origin: "autonomous", audience: "local" })).toEqual([]);
    await store.update(view!.id, { policy: { shareOnline: true } });
    expect(store.sources({ origin: "player", audience: "online" })).toHaveLength(1);
    await store.update(view!.id, { policy: { enabled: false } });
    expect(store.sources({ origin: "player", audience: "local" })).toEqual([]);
    expect(store.sourcesOf(view!.id)).toHaveLength(1);
  });

  test("a revoked token marks the account for reconnecting, in the file too", async () => {
    const store = await load("reconnect");
    await store.add(google, await connected(), false);
    const [view] = store.list();
    mock.revokeRefreshTokens();
    const [source] = store.sources({ origin: "player", audience: "local" });
    await expect(source!.search(parseQuery("laura"), AbortSignal.timeout(2000))).rejects.toMatchObject({ problem: "reconnect" });
    expect(store.list()[0]?.status).toBe("reconnect");
    expect(JSON.parse(await readFile(join(store.dir, `${view!.id}.json`), "utf8"))).toMatchObject({ status: "reconnect" });
    // Known bad: the next lookup says so without calling Google, naming the account by id since the shelf logs the message.
    const calls = mock.refreshes;
    await expect(store.sources({ origin: "player", audience: "local" })[0]!.search(parseQuery("laura"), AbortSignal.timeout(2000))).rejects.toMatchObject({ problem: "reconnect", message: expect.not.stringContaining("@") });
    expect(mock.refreshes).toBe(calls);
    expect(store.sources({ origin: "player", audience: "local" })[0]).toMatchObject({ id: view!.id, label: "alex@gmail.com" });
  });

  test("a source opened when the turn started follows the account as it is when the model finally calls", async () => {
    const store = await load("live");
    const gate = { origin: "player", audience: "local" } as const;
    const view = await store.add(google, await connected(), false);
    const [stale] = store.sources(gate);
    // The player shares the account online while the model thinks; the credential then turns bad.
    // The file records that on the current entry, without rolling the policy back.
    await store.update(view.id, { policy: { shareOnline: true } });
    mock.revokeRefreshTokens();
    mock.expireTokens();
    await expect(stale!.search(parseQuery("laura"), AbortSignal.timeout(2000))).rejects.toMatchObject({ problem: "reconnect" });
    expect(JSON.parse(await readFile(join(store.dir, `${view.id}.json`), "utf8"))).toMatchObject({ status: "reconnect", policy: { enabled: true, shareOnline: true } });
    // Reconnected mid-turn: the lookup already in flight uses the new credential and leaves the status alone.
    await store.add(google, await connected(), false);
    expect(store.list()[0]?.status).toBe("ok");
    expect((await stale!.search(parseQuery("laura"), AbortSignal.timeout(2000))).map((hit) => hit.title)).toEqual(["Fotos del viaje"]);
    expect(store.list()[0]?.status).toBe("ok");
    // Paused mid-turn: refused, and a disconnect mid-turn never brings the account back.
    await store.update(view.id, { policy: { enabled: false } });
    await expect(stale!.search(parseQuery("laura"), AbortSignal.timeout(2000))).rejects.toMatchObject({ problem: "unreadable" });
    await store.remove(view.id);
    await expect(stale!.search(parseQuery("laura"), AbortSignal.timeout(2000))).rejects.toMatchObject({ problem: "unreadable" });
    expect(await readdir(store.dir)).toEqual([]);
    expect(store.list()).toEqual([]);
  });

  test("an account from a newer version is listed as such and survives a save by this version", async () => {
    const dir = join(root, "newer");
    await mkdir(dir, { recursive: true });
    const id = accountId("outlook", "alex@outlook.com");
    const newer = { version: 1, id, connector: "graph", entry: "outlook", label: "alex@outlook.com", facets: ["mail", "files"], policy: { enabled: true, shareOnline: false }, status: "ok", addedAt: "2027-01-01T00:00:00.000Z", tenant: "common" };
    await writeFile(join(dir, `${id}.json`), JSON.stringify(newer));
    await writeFile(join(dir, `${id}.secret`), JSON.stringify({ refreshToken: "1//outlook-secret-abcdefghijklmnop" }));
    await writeFile(join(dir, "broken.json"), "{ not json");
    const store = await load("newer");
    await store.add(google, await connected(), false);
    expect(store.list().map((view) => [view.entry, view.status])).toEqual([["google", "ok"], ["outlook", "needs-newer-version"]]);
    expect(store.list()[1]).toMatchObject({ facets: ["mail", "files"], label: "alex@outlook.com" });
    await expect(store.update(id, { policy: { enabled: false } })).rejects.toThrow("newer version");
    expect(JSON.parse(await readFile(join(dir, `${id}.json`), "utf8"))).toEqual(newer);
    expect(store.sources({ origin: "player", audience: "local" }).map((source) => source.label)).toEqual(["alex@gmail.com"]);
  });

  test("a newer file with a status this version lacks is listed as such, and a corrupt secret shows as reconnect and can be removed", async () => {
    const dir = join(root, "tolerant");
    await mkdir(dir, { recursive: true });
    const sam = accountId("google", "sam@gmail.com");
    const newer = { version: 2, id: sam, connector: "google", entry: "google", label: "sam@gmail.com", facets: ["mail"], policy: { enabled: true, shareOnline: false }, status: "paused", addedAt: "2027-01-01T00:00:00.000Z" };
    await writeFile(join(dir, `${sam}.json`), JSON.stringify(newer));
    await writeFile(join(dir, `${sam}.secret`), JSON.stringify({ refreshToken: "1//sam-secret-abcdefghijklmnop" }));
    const kim = accountId("google", "kim@gmail.com");
    await writeFile(join(dir, `${kim}.json`), JSON.stringify({ version: 1, id: kim, connector: "google", entry: "google", label: "kim@gmail.com", facets: ["mail"], granted: ["mail"], policy: { enabled: true, shareOnline: false }, status: "ok", addedAt: "2026-01-01T00:00:00.000Z" }));
    await writeFile(join(dir, `${kim}.secret`), "plain:1//0gRealRefreshTokenAbc");
    const store = await load("tolerant");
    expect(store.list().map((view) => [view.label, view.status])).toEqual([["kim@gmail.com", "reconnect"], ["sam@gmail.com", "needs-newer-version"]]);
    await expect(store.update(sam, { policy: { enabled: false } })).rejects.toThrow("newer version");
    expect(JSON.parse(await readFile(join(dir, `${sam}.json`), "utf8"))).toEqual(newer);
    await store.remove(kim);
    expect((await readdir(dir)).filter((name) => name.startsWith(kim))).toEqual([]);
    // The corrupt secret's bytes never reach the log through a parser message.
    expect(JSON.stringify(logger.recent())).not.toContain("0gRealRefreshTokenAbc");
  });

  test("an access token lives with the account it was minted for: removed and connected again, the account refreshes afresh", async () => {
    const store = await load("cache");
    const gate = { origin: "player", audience: "local" } as const;
    const view = await store.add(google, await connected(), false);
    await store.sources(gate)[0]!.search(parseQuery("laura"), AbortSignal.timeout(2000));
    const before = mock.refreshes;
    await store.remove(view.id);
    await store.add(google, await connected(), false);
    expect((await store.sources(gate)[0]!.search(parseQuery("laura"), AbortSignal.timeout(2000))).map((hit) => hit.title)).toEqual(["Fotos del viaje"]);
    expect(mock.refreshes).toBe(before + 1);
  });

  test("two companions see each other's connects and disconnects through the folder watcher", async () => {
    const game = await load("shared");
    const setup = await AccountStore.load(game.dir, logger.scope("accounts"), () => {});
    stores.push(setup);
    game.watch();
    setup.watch();
    let gameChanges = 0;
    game.onChange(() => gameChanges++);
    await setup.add(google, await connected(), false);
    await until(() => game.list().length === 1);
    expect(game.list()[0]).toMatchObject({ label: "alex@gmail.com" });
    expect(game.sources({ origin: "player", audience: "local" })).toHaveLength(1);
    await game.remove(game.list()[0]!.id);
    await until(() => setup.list().length === 0);
    expect(gameChanges).toBe(2);
    expect(await readdir(game.dir)).toEqual([]);
  });

  test("overlapping saves use their own temp files, so both land and none is left behind", async () => {
    const store = await load("parallel");
    const [a, b] = await Promise.all([connected("alex@gmail.com"), connected("sam@gmail.com")]);
    await Promise.all([store.add(google, a, false), store.add(google, b, true)]);
    const names = (await readdir(store.dir)).sort();
    expect(names.filter((name) => name.endsWith(".tmp"))).toEqual([]);
    expect(names).toHaveLength(4);
    expect(store.list().map((view) => [view.label, view.policy.shareOnline])).toEqual([["alex@gmail.com", false], ["sam@gmail.com", true]]);
  });
});
