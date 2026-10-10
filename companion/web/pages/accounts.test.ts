// The sign-in callback and the dashboard must agree on the way back: Google sends the player's tab
// to the callback, whose redirect has to open the Accounts tab with an outcome the tab can announce.

import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PendingFlows } from "../../src/accounts/flows.ts";
import { catalog } from "../../src/accounts/registry.ts";
import { AccountStore, type AccountView } from "../../src/accounts/store.ts";
import { translator } from "../../src/i18n.ts";
import { Logger } from "../../src/log.ts";
import { linkedTab } from "../app.tsx";
import { facetSwitch, outcomeIn, withFacet } from "./accounts.tsx";

test("the callback's redirect opens the Accounts tab and names its outcome", async () => {
  const dir = await mkdtemp(join(tmpdir(), "lilith-accounts-tab-"));
  const log = new Logger(null).scope("accounts");
  const flows = new PendingFlows({ store: await AccountStore.load(dir, log, () => {}), port: () => 47321, log, tr: () => translator("en") });
  // A state this companion never issued: the callback answers without calling Google.
  const response = await flows.finish(new URL("http://127.0.0.1:47321/api/accounts/callback?state=unknown"));
  const { hash } = new URL(response.headers.get("location") ?? "", "http://127.0.0.1:47321");
  await rm(dir, { recursive: true, force: true });

  expect({ tab: linkedTab(hash), outcome: outcomeIn(hash) }).toEqual({ tab: "accounts", outcome: "expired" });
});

// Anyone can type a hash; one the tab has no message for must not show as a banner.
test("a result the callback never sends is not announced", () => {
  expect(outcomeIn("#accounts?result=hello")).toBeNull();
  expect(outcomeIn("#accounts")).toBeNull();
});

// What the card sends when a switch flips has to be what the account keeps, or a switch turned off
// could never come back. Past the grant, only a new sign-in can widen it.
test("a facet switched off comes back on within what Google granted; one it didn't grant stays unavailable", async () => {
  const dir = await mkdtemp(join(tmpdir(), "lilith-accounts-switches-"));
  const store = await AccountStore.load(dir, new Logger(null).scope("accounts"), () => {});
  const google = catalog[0];
  const account = await store.add(google, { settings: { user: "alex@gmail.com" }, secret: { refreshToken: "1//mock-refresh" }, label: "alex@gmail.com", facets: ["mail", "files"] }, false);
  const seen = (view: AccountView) => ({ switches: google.facets.map((facet) => facetSwitch(view, facet)), opened: store.sourcesOf(view.id).map((source) => source.facet) });

  const connected = seen(account);
  const switchedOff = await store.update(account.id, { facets: withFacet(account, "files", false) });
  const off = seen(switchedOff);
  const on = seen(await store.update(account.id, { facets: withFacet(switchedOff, "files", true) }));
  await rm(dir, { recursive: true, force: true });

  expect(connected).toEqual({ switches: ["on", "on", "unavailable"], opened: ["mail", "files"] });
  expect(off).toEqual({ switches: ["on", "off", "unavailable"], opened: ["mail"] });
  expect(on).toEqual(connected);
});
