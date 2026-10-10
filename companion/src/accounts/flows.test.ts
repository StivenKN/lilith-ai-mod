// Signing in with Google, from connectAccount to the callback: the state is single use and expires,
// a denied consent is reported, and the real dashboard server takes the callback with no cookie.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startMockGoogle, type MockGoogle } from "../../scripts/mock-google.ts";
import { Brain } from "../brain.ts";
import { BrowserHub } from "../browser/hub.ts";
import { ConfigStore } from "../config.ts";
import { translator } from "../i18n.ts";
import { Keepsakes } from "../keepsakes.ts";
import { Logger } from "../log.ts";
import { Memory } from "../memory.ts";
import { dataPaths } from "../paths.ts";
import { startServer, type DashboardServer } from "../server.ts";
import { Updater } from "../updater.ts";
import { Voice } from "../voice/index.ts";
import { PendingFlows } from "./flows.ts";
import { catalog } from "./registry.ts";
import { AccountStore } from "./store.ts";

let root = "";
let mock: MockGoogle;
const env = { url: process.env.LILITH_AI_GOOGLE_URL, id: process.env.LILITH_GOOGLE_CLIENT_ID, secret: process.env.LILITH_GOOGLE_CLIENT_SECRET };
const cleanups: Array<() => void> = [];
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "lilith-flows-"));
  mock = startMockGoogle();
  process.env.LILITH_AI_GOOGLE_URL = mock.url;
  process.env.LILITH_GOOGLE_CLIENT_ID = "mock-client";
  process.env.LILITH_GOOGLE_CLIENT_SECRET = "GOCSPX-mock-secret";
});
afterAll(async () => {
  for (const cleanup of cleanups) cleanup();
  mock.stop();
  process.env.LILITH_AI_GOOGLE_URL = env.url;
  process.env.LILITH_GOOGLE_CLIENT_ID = env.id;
  process.env.LILITH_GOOGLE_CLIENT_SECRET = env.secret;
  await rm(root, { recursive: true, force: true });
});

const logger = new Logger(null);
const google = catalog[0];
/** The link Google's page would send the player's browser to. */
async function allowLink(consentUrl: string, choice: "allow" | "deny" = "allow"): Promise<URL> {
  const page = await (await fetch(consentUrl)).text();
  return new URL(new RegExp(`id="${choice}" href="([^"]+)"`).exec(page)![1]!.replace(/&amp;/g, "&"));
}
/** The outcome as the dashboard reads it, from the hash of the page it lands on. */
const outcome = (response: Response) => {
  expect(response.status).toBe(302);
  const { hash } = new URL(response.headers.get("location")!, "http://127.0.0.1/");
  expect(hash).toStartWith("#accounts?");
  return new URLSearchParams(hash.split("?")[1]).get("result");
};

describe("PendingFlows", () => {
  async function flows(now?: () => number) {
    const store = await AccountStore.load(join(root, crypto.randomUUID()), logger.scope("accounts"), () => {});
    cleanups.push(() => store.close());
    return { store, flows: new PendingFlows({ store, port: () => 47321, log: logger.scope("accounts"), tr: () => translator("en"), ...(now ? { now } : {}) }) };
  }

  test("a sign-in finishes once; the same callback again reads 'already finished', an unknown state 'expired'", async () => {
    const { store, flows: pending } = await flows();
    const started = pending.start(google, true);
    expect(started.kind).toBe("consent");
    if (started.kind !== "consent") return;
    expect(new URL(started.url).searchParams.get("redirect_uri")).toBe("http://127.0.0.1:47321/api/accounts/callback");
    const callback = await allowLink(started.url);
    expect(outcome(await pending.finish(callback))).toBe("connected");
    expect(store.list()).toEqual([expect.objectContaining({ label: "alex@gmail.com", policy: { enabled: true, shareOnline: true } })]);
    expect(outcome(await pending.finish(callback))).toBe("finished");
    callback.searchParams.set("state", "never-issued");
    expect(outcome(await pending.finish(callback))).toBe("expired");
    expect(store.list()).toHaveLength(1);
  });

  test("a player who takes more than ten minutes on Google's page is refused", async () => {
    let clock = Date.now();
    const { store, flows: pending } = await flows(() => clock);
    const started = pending.start(google, false);
    if (started.kind !== "consent") throw new Error(started.message);
    const callback = await allowLink(started.url);
    clock += 11 * 60_000;
    expect(outcome(await pending.finish(callback))).toBe("expired");
    expect(store.list()).toEqual([]);
  });

  test("denying on Google's page comes back as denied, with nothing stored", async () => {
    const { store, flows: pending } = await flows();
    const started = pending.start(google, false);
    if (started.kind !== "consent") throw new Error(started.message);
    expect(outcome(await pending.finish(await allowLink(started.url, "deny")))).toBe("denied");
    expect(store.list()).toEqual([]);
  });

  test("a build without a Google client says so instead of a consent page", async () => {
    const { flows: pending } = await flows();
    const id = process.env.LILITH_GOOGLE_CLIENT_ID;
    delete process.env.LILITH_GOOGLE_CLIENT_ID;
    try {
      expect(pending.start(google, false)).toEqual({ kind: "failed", message: expect.stringContaining("built without Google sign-in") });
    } finally {
      process.env.LILITH_GOOGLE_CLIENT_ID = id;
    }
  });
});

describe("the dashboard server", () => {
  let server: DashboardServer;
  let cookie = "";
  const paths = () => dataPaths(join(root, "server"));

  beforeAll(async () => {
    const config = await ConfigStore.load(paths().config);
    const memory = await Memory.load(paths().memory);
    const keepsakes = await Keepsakes.load(paths().keepsakes, paths().pictures);
    const accounts = await AccountStore.load(paths().accounts, logger.scope("accounts"), () => {});
    const voice = new Voice(paths().voice, logger.scope("voice"));
    const brain = new Brain({ version: "test", config, memory, keepsakes, logger, voice, send: () => {}, dashboardUrl: () => "", openDashboard: () => {}, onFatal: () => {} });
    server = await startServer({
      version: "test", mode: "setup", config, memory, keepsakes, accounts, logger, brain, voice, paths: paths(), payloadDir: root, selfExe: null, openPath: () => {},
      browser: new BrowserHub({ secret: "0".repeat(64), version: "test", log: logger.scope("browser") }),
      updater: new Updater({ version: "test", modDir: null, downloadDir: join(root, "updates"), autoInstall: () => false, log: logger.scope("update") }),
    });
    cleanups.push(() => { server.stop(); accounts.close(); });
    const login = await fetch(`http://127.0.0.1:${server.port}/api/session`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: new URL(server.loginUrl).searchParams.get("t") }) });
    cookie = login.headers.get("set-cookie")!.split(";")[0]!;
  });

  const rpc = async (name: string, input: unknown = {}): Promise<unknown> => {
    const response = await fetch(`http://127.0.0.1:${server.port}/api/rpc/${name}`, { method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify(input) });
    return response.json();
  };

  test("connectAccount hands out the consent URL and the callback lands with no cookie at all", async () => {
    const before = (await rpc("accounts")) as { accounts: unknown[]; googleConfigured: boolean; toolsSupported: boolean | null };
    expect(before).toMatchObject({ accounts: [], googleConfigured: true, toolsSupported: null });
    const started = (await rpc("connectAccount", { entry: "google", shareOnline: false })) as { kind: string; url: string };
    expect(started.kind).toBe("consent");
    expect(new URL(started.url).searchParams.get("redirect_uri")).toBe(`http://127.0.0.1:${server.port}/api/accounts/callback`);
    const callback = await allowLink(started.url);
    const landed = await fetch(callback, { redirect: "manual" });
    expect(landed.status).toBe(302);
    expect(landed.headers.get("location")).toBe("/#accounts?result=connected");
    const after = (await rpc("accounts")) as { accounts: Array<{ id: string; label: string }> };
    expect(after.accounts).toEqual([expect.objectContaining({ label: "alex@gmail.com", status: "ok" })]);
    expect(JSON.stringify(after)).not.toContain("1//");
    // Only the Host check guards the callback: a rebinding host is refused before the flow is touched.
    const rebound = await fetch(callback, { redirect: "manual", headers: { host: "evil.example:80" } });
    expect(rebound.status).toBe(403);
    expect(await rpc("disconnectAccount", { id: after.accounts[0]!.id })).toEqual({ ok: true });
    expect(((await rpc("accounts")) as { accounts: unknown[] }).accounts).toEqual([]);
  });
});
