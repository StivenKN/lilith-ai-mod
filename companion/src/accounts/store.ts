// The player's connected accounts: one folder, two files per account. <id>.json holds the settings
// (connector, label, facets, policy, status) and is written by dashboard actions; <id>.secret holds
// the credential and is written only by connect. Different writers get different files, and all
// writes are atomic, so the config.json races (#18) cannot happen here. Files parse loose: an
// account from a newer version, or on a connector this version lacks, is listed as needing a newer
// version and never rewritten, and a broken file costs that one account, never the rest. A watcher
// on the folder picks up what the other companion connects.
// A turn's sources look the account up again on every call, so a pause, a disconnect or a
// reconnect while the model thinks is honored, and a credential that turns bad is recorded only
// while it is still the one in use.
// There is no lock: Google refresh tokens do not rotate, so nothing is read-modify-written across
// processes yet. A rotating connector (Microsoft) will need a per-account lock around its refresh.

import { watch, type FSWatcher } from "node:fs";
import { mkdir, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { readTextFile, writeAtomic } from "../config.ts";
import { errorMessage, type Log } from "../log.ts";
import { isFacet, isPrivate, type PrivateFacet } from "../lookup/facets.ts";
import { mayConsult, type Gate, type Policy } from "../lookup/gate.ts";
import { LookupError, type Reader, type Source } from "../lookup/sources.ts";
import { AccountId, accountId, type Connected, type Connector } from "./account.ts";
import { catalogEntry, connectors, isConnectorId, type CatalogEntry } from "./registry.ts";

const FILE_VERSION = 1;
/** Editors and atomic renames fire several events per save; settle first. */
const SETTLE_MS = 150;
const REVOKE_TIMEOUT_MS = 5_000;

/** Enough of any version's file to list it: a newer file still shows its name and facets. */
const Listing = z.looseObject({
  version: z.int().positive(),
  id: AccountId,
  connector: z.string().min(1),
  entry: z.string().min(1),
  label: z.string().default(""),
  facets: z.array(z.string()).default([]),
  policy: z.looseObject({ enabled: z.boolean().default(true), shareOnline: z.boolean().default(false) }).prefault({}),
  addedAt: z.string().default(""),
});
/** What this version reads in full and writes. A file that lists but does not parse as this (a status it does not know) needs a newer version. */
const AccountFile = Listing.extend({
  /** What the sign-in granted: the most the player can tick `facets` up to without connecting again. */
  granted: z.array(z.string()),
  status: z.enum(["ok", "reconnect"]),
});
type AccountFile = z.infer<typeof AccountFile>;

const parseJson = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
};

/** What leaves the store: no credential field, so nothing to forget to mask. */
export interface AccountView {
  id: AccountId;
  entry: string;
  label: string;
  facets: readonly PrivateFacet[];
  /** What the sign-in granted: `facets` can be narrowed and widened within it. */
  granted: readonly PrivateFacet[];
  policy: Policy;
  power: CatalogEntry["power"];
  /** `needs-newer-version`: this version cannot open it and leaves its files alone. */
  status: "ok" | "reconnect" | "needs-newer-version";
  addedAt: string;
}

/** The connector's typed view of one account, once its two files parsed. */
interface Bound {
  /** The credential file as read, to tell a failure on it from one on a newer credential. */
  readonly secret: string;
  readonly readers: readonly Reader[];
  revoke(signal: AbortSignal): Promise<void>;
}

type Account =
  /** Listed only: a newer version or an unknown connector. Never written. */
  | { readonly view: AccountView; readonly file: null; readonly bound: null }
  /** This version's file. `bound` is null while the secret is missing or unreadable (listed as reconnect). */
  | { readonly view: AccountView; readonly file: AccountFile; readonly bound: Bound | null };

function bind<S, T>(connector: Connector<S, T>, file: AccountFile, secretText: string, facets: readonly PrivateFacet[]): { secrets: string[]; bound: Bound } | null {
  const settings = connector.settings.safeParse(file);
  const secret = connector.secret.safeParse(parseJson(secretText));
  if (!settings.success || !secret.success) return null;
  return {
    secrets: connector.secretsOf(secret.data),
    bound: {
      secret: secretText,
      readers: connector.open({ id: file.id, label: file.label, facets, settings: settings.data, secret: secret.data }),
      revoke: (signal) => connector.revoke(secret.data, signal),
    },
  };
}

export class AccountStore {
  #accounts = new Map<AccountId, Account>();
  #listeners = new Set<() => void>();
  #watcher: FSWatcher | null = null;
  #reloadTimer: ReturnType<typeof setTimeout> | null = null;

  private constructor(
    readonly dir: string,
    private readonly log: Log,
    private readonly hide: (secret: string) => void,
  ) {}

  static async load(dir: string, log: Log, hide: (secret: string) => void): Promise<AccountStore> {
    const store = new AccountStore(dir, log, hide);
    await mkdir(dir, { recursive: true });
    await store.#reloadAll();
    return store;
  }

  list(): AccountView[] {
    return [...this.#accounts.values()].map((account) => account.view).sort((a, b) => a.addedAt.localeCompare(b.addedAt) || a.label.localeCompare(b.label));
  }

  /** Sources this turn may use: the gate applied per account and facet, now and again at every call. */
  sources(gate: Gate): Source[] {
    return [...this.#accounts.values()].flatMap((account) =>
      (account.bound?.readers ?? [])
        .filter((reader) => mayConsult(reader.facet, account.view.policy, gate))
        .map((reader) => this.#guarded(account, reader, gate)),
    );
  }

  /** Every source of one account, policy aside: the dashboard's Try it shows the player what Lilith would see. */
  sourcesOf(id: AccountId): Source[] {
    const account = this.#accounts.get(id);
    return account ? (account.bound?.readers ?? []).map((reader) => this.#guarded(account, reader, null)) : [];
  }

  /**
   * A source that finds the account again when the model finally calls, with the credential and
   * policy of that moment, reports a known-bad one without calling it, and records one that just
   * turned bad.
   */
  #guarded(account: Account, reader: Reader, gate: Gate | null): Source {
    const { id, label, policy } = account.view;
    const { facet } = reader;
    const live = (): { source: Reader; secret: string } => {
      const current = this.#accounts.get(id);
      const source = current?.bound?.readers.find((candidate) => candidate.facet === facet);
      if (!current?.bound || !source || (gate && !mayConsult(facet, current.view.policy, gate))) throw new LookupError("unreadable", `account ${id} is no longer open to this turn`);
      if (current.view.status === "reconnect") throw new LookupError("reconnect", `${label} needs to be connected again`);
      return { source, secret: current.bound.secret };
    };
    const recording = async <T>(secret: string, run: () => Promise<T>): Promise<T> => {
      try {
        return await run();
      } catch (error) {
        if (error instanceof LookupError && error.problem === "reconnect") await this.#markReconnect(id, secret);
        throw error;
      }
    };
    return {
      facet,
      label,
      audience: policy.shareOnline ? "online" : "local",
      search: async (query, signal) => {
        const { source, secret } = live();
        const hits = await recording(secret, () => source.search(query, signal));
        return hits.map((hit) => {
          const { read } = hit;
          return read ? { ...hit, read: (signal: AbortSignal) => recording(secret, () => read(signal)) } : hit;
        });
      },
    };
  }

  /** Records a credential that just failed, on the account as it is on disk now, and only while that credential is still the one in use. */
  async #markReconnect(id: AccountId, secret: string): Promise<void> {
    await this.#load(id);
    const account = this.#accounts.get(id);
    if (!account?.file || account.bound?.secret !== secret) return;
    await this.#write(id, { ...account.file, status: "reconnect" });
  }

  /**
   * Writes both files. The same account twice (same entry and user) lands on the same id, so it
   * converges to one: a reconnect keeps the policy and the facets the player chose, within what
   * Google granted this time.
   */
  async add<S extends Record<string, unknown>, T>(entry: CatalogEntry, connected: Connected<S, T>, shareOnline: boolean): Promise<AccountView> {
    const id = accountId(entry.id, connected.label);
    const existing = this.#accounts.get(id)?.view;
    const granted = connected.facets.filter((facet) => entry.facets.includes(facet));
    const facets = existing ? existing.facets.filter((facet) => granted.includes(facet)) : granted;
    const policy = existing ? { ...existing.policy } : { enabled: true, shareOnline };
    const file: AccountFile = { ...connected.settings, version: FILE_VERSION, id, connector: entry.connector, entry: entry.id, label: connected.label, facets, granted, policy, status: "ok", addedAt: existing?.addedAt || new Date().toISOString() };
    await writeAtomic(this.#secretPath(id), `${JSON.stringify(connected.secret, null, 2)}\n`);
    await this.#write(id, file);
    this.log.info(`account ${id} connected (${entry.id}: ${facets.join(", ")})`);
    return this.#view(id);
  }

  /** Writes <id>.json only. Never touches the secret, and never rewrites a file this version cannot open. */
  async update(id: AccountId, patch: { facets?: readonly PrivateFacet[] | undefined; policy?: { [K in keyof Policy]?: Policy[K] | undefined } | undefined }): Promise<AccountView> {
    const account = this.#accounts.get(id);
    if (!account) throw new Error(`No account ${id}`);
    if (!account.file) throw new Error(`Account ${id} needs a newer version of Lilith AI`);
    const facets = patch.facets ? patch.facets.filter((facet) => account.view.granted.includes(facet)) : account.file.facets;
    const policy = { enabled: patch.policy?.enabled ?? account.file.policy.enabled, shareOnline: patch.policy?.shareOnline ?? account.file.policy.shareOnline };
    await this.#write(id, { ...account.file, facets: [...facets], policy });
    return this.#view(id);
  }

  /** Revocation is best effort and never blocks the removal. Removing an unknown id is fine. */
  async remove(id: AccountId): Promise<void> {
    const account = this.#accounts.get(id);
    if (account?.bound) {
      await account.bound.revoke(AbortSignal.timeout(REVOKE_TIMEOUT_MS)).catch((error: unknown) => this.log.warn(`could not revoke ${id}: ${error instanceof Error ? error.message : String(error)}`));
    }
    await rm(this.#jsonPath(id), { force: true });
    await rm(this.#secretPath(id), { force: true });
    if (this.#accounts.delete(id)) {
      this.log.info(`account ${id} removed`);
      this.#emit();
    }
  }

  onChange(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /** Picks up the other companion's connects and disconnects. Watches the folder: atomic saves replace files. */
  watch(): void {
    if (this.#watcher) return;
    this.#watcher = watch(this.dir, () => {
      if (this.#reloadTimer) clearTimeout(this.#reloadTimer);
      this.#reloadTimer = setTimeout(() => {
        void this.#reloadAll().then((changed) => { if (changed) this.#emit(); });
      }, SETTLE_MS);
    });
    this.#watcher.on("error", (error) => this.log.warn(`stopped watching accounts: ${String(error)}`));
  }

  close(): void {
    if (this.#reloadTimer) clearTimeout(this.#reloadTimer);
    this.#watcher?.close();
    this.#watcher = null;
  }

  #jsonPath = (id: AccountId) => join(this.dir, `${id}.json`);
  #secretPath = (id: AccountId) => join(this.dir, `${id}.secret`);

  #view(id: AccountId): AccountView {
    const account = this.#accounts.get(id);
    if (!account) throw new Error(`Account ${id} vanished`);
    return account.view;
  }

  async #write(id: AccountId, file: AccountFile): Promise<void> {
    await writeAtomic(this.#jsonPath(id), `${JSON.stringify(file, null, 2)}\n`);
    await this.#load(id);
    this.#emit();
  }

  /** Reads every account from disk. Returns whether what the dashboard sees changed. */
  async #reloadAll(): Promise<boolean> {
    const before = JSON.stringify(this.list());
    const names = await readdir(this.dir).catch(() => []);
    const ids = names.flatMap((name) => {
      const id = AccountId.safeParse(name.replace(/\.json$/, ""));
      return name.endsWith(".json") && id.success ? [id.data] : [];
    });
    for (const id of this.#accounts.keys()) if (!ids.includes(id)) this.#accounts.delete(id);
    for (const id of ids) {
      await this.#load(id).catch((error: unknown) => {
        this.log.warn(`skipping account ${id}: ${errorMessage(error)}`);
        this.#accounts.delete(id);
      });
    }
    return JSON.stringify(this.list()) !== before;
  }

  /**
   * One account from its two files. A file that does not even list is logged (never with the
   * parser's words, which can echo the file) and skipped, so it costs one account, never all.
   */
  async #load(id: AccountId): Promise<void> {
    const text = await readTextFile(this.#jsonPath(id));
    if (text === null) return void this.#accounts.delete(id);
    const json = parseJson(text);
    const listing = Listing.safeParse(json);
    if (!listing.success || listing.data.id !== id) {
      this.log.warn(`skipping account ${id}: its settings file is not one this version can read`);
      this.#accounts.delete(id);
      return;
    }
    const { data: listed } = listing;
    const entry = catalogEntry(listed.entry);
    const facets = listed.facets.filter(isFacet).filter(isPrivate);
    const base = { id, entry: listed.entry, label: listed.label, policy: { enabled: listed.policy.enabled, shareOnline: listed.policy.shareOnline }, power: entry?.power ?? "read", addedAt: listed.addedAt };
    const file = AccountFile.safeParse(json);
    if (!file.success || listed.version > FILE_VERSION || !isConnectorId(listed.connector) || !entry) {
      this.#accounts.set(id, { file: null, view: { ...base, facets, granted: facets, status: "needs-newer-version" }, bound: null });
      return;
    }
    const connector = connectors[listed.connector];
    const granted = file.data.granted.filter(isFacet).filter(isPrivate).filter((facet) => connector.facets.includes(facet));
    const secretText = await readTextFile(this.#secretPath(id));
    const opened = secretText === null ? null : bind(connector, file.data, secretText, facets.filter((facet) => granted.includes(facet)));
    for (const secret of opened?.secrets ?? []) this.hide(secret);
    this.#accounts.set(id, { file: file.data, view: { ...base, facets, granted, status: opened ? file.data.status : "reconnect" }, bound: opened?.bound ?? null });
  }

  #emit(): void {
    for (const listener of this.#listeners) listener();
  }
}
