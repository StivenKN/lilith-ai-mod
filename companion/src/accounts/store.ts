// The player's connected accounts: one folder, two files per account. <id>.json holds the settings
// (connector, label, facets, policy, status) and is written by dashboard actions; <id>.secret holds
// the credential and is written only by connect. Different writers get different files, and all
// writes are atomic, so the config.json races (#18) cannot happen here. Files parse loose: an
// account from a newer version, or on a connector this version lacks, is listed as needing a newer
// version and never rewritten, and a broken file costs that one account, never the rest. A watcher
// on the folder picks up what the other companion connects.
// There is no lock: Google refresh tokens do not rotate, so nothing is read-modify-written across
// processes yet. A rotating connector (Microsoft) will need a per-account lock around its refresh.

import { watch, type FSWatcher } from "node:fs";
import { mkdir, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { readTextFile, writeAtomic } from "../config.ts";
import type { Log } from "../log.ts";
import { isFacet, isPrivate, type PrivateFacet } from "../lookup/facets.ts";
import { mayConsult, type Gate, type Policy } from "../lookup/gate.ts";
import { LookupError, type Source } from "../lookup/sources.ts";
import { AccountId, accountId, type Connected, type Connector } from "./account.ts";
import { catalogEntry, connectors, isConnectorId, type CatalogEntry } from "./registry.ts";

const FILE_VERSION = 1;
/** Editors and atomic renames fire several events per save; settle first. */
const SETTLE_MS = 150;
const REVOKE_TIMEOUT_MS = 5_000;

const AccountFile = z.looseObject({
  version: z.int().positive(),
  id: AccountId,
  connector: z.string().min(1),
  entry: z.string().min(1),
  label: z.string(),
  facets: z.array(z.string()),
  policy: z.looseObject({ enabled: z.boolean().default(true), shareOnline: z.boolean().default(false) }).prefault({}),
  status: z.enum(["ok", "reconnect"]).default("ok"),
  addedAt: z.string(),
});
type AccountFile = z.infer<typeof AccountFile>;

/** What leaves the store: no credential field, so nothing to forget to mask. */
export interface AccountView {
  id: AccountId;
  entry: string;
  label: string;
  facets: readonly PrivateFacet[];
  policy: Policy;
  power: CatalogEntry["power"];
  /** `needs-newer-version`: this version cannot open it and leaves its files alone. */
  status: "ok" | "reconnect" | "needs-newer-version";
  addedAt: string;
}

interface Account {
  file: AccountFile;
  view: AccountView;
  /** Null when this version cannot open the account (unknown connector, newer file, unreadable secret). */
  open: (() => Source[]) | null;
  revoke: ((signal: AbortSignal) => Promise<void>) | null;
}

/** The connector's typed view of one account, once its two files parsed. Null leaves the account listed as reconnect. */
function bind<S, T>(connector: Connector<S, T>, file: AccountFile, secretJson: unknown, facets: readonly PrivateFacet[]): { secrets: string[]; open: () => Source[]; revoke: (signal: AbortSignal) => Promise<void> } | null {
  const settings = connector.settings.safeParse(file);
  const secret = connector.secret.safeParse(secretJson);
  if (!settings.success || !secret.success) return null;
  return {
    secrets: connector.secretsOf(secret.data),
    open: () => connector.open({ id: file.id, label: file.label, facets, settings: settings.data, secret: secret.data }),
    revoke: (signal) => connector.revoke(secret.data, signal),
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

  /** Sources this turn may use: the gate applied per account and facet. */
  sources(gate: Gate): Source[] {
    return [...this.#accounts.values()].flatMap((account) =>
      (account.open?.() ?? []).filter((source) => mayConsult(source.facet, account.view.policy, gate)).map((source) => this.#guarded(account, source)),
    );
  }

  /** Every source of one account, policy aside: the dashboard's Try it shows the player what Lilith would see. */
  sourcesOf(id: AccountId): Source[] {
    const account = this.#accounts.get(id);
    return account?.open ? account.open().map((source) => this.#guarded(account, source)) : [];
  }

  /** A source that reports a known-bad account without calling it, and records one that just turned bad. */
  #guarded(account: Account, source: Source): Source {
    return {
      facet: source.facet,
      label: source.label,
      search: async (query, signal) => {
        if (account.view.status === "reconnect") throw new LookupError("reconnect", `${account.view.label} needs to be connected again`);
        try {
          return await source.search(query, signal);
        } catch (error) {
          if (error instanceof LookupError && error.problem === "reconnect") await this.#write(account.file.id, { ...account.file, status: "reconnect" });
          throw error;
        }
      },
    };
  }

  /** Writes both files. The same account twice (same entry and user) lands on the same id, so it converges to one. */
  async add<S extends Record<string, unknown>, T>(entry: CatalogEntry, connected: Connected<S, T>, shareOnline: boolean): Promise<AccountView> {
    const id = accountId(entry.id, connected.label);
    const facets = connected.facets.filter((facet) => entry.facets.includes(facet));
    const file: AccountFile = { ...connected.settings, version: FILE_VERSION, id, connector: entry.connector, entry: entry.id, label: connected.label, facets, policy: { enabled: true, shareOnline }, status: "ok", addedAt: new Date().toISOString() };
    await writeAtomic(this.#secretPath(id), `${JSON.stringify(connected.secret, null, 2)}\n`);
    await this.#write(id, file);
    this.log.info(`account ${id} connected (${entry.id}: ${facets.join(", ")})`);
    return this.#view(id);
  }

  /** Writes <id>.json only. Never touches the secret, and never rewrites a file this version cannot open. */
  async update(id: AccountId, patch: { facets?: readonly PrivateFacet[]; policy?: Partial<Policy> }): Promise<AccountView> {
    const account = this.#accounts.get(id);
    if (!account) throw new Error(`No account ${id}`);
    if (account.view.status === "needs-newer-version" || !isConnectorId(account.file.connector)) throw new Error(`Account ${id} needs a newer version of Lilith AI`);
    const allowed = connectors[account.file.connector].facets;
    const facets = patch.facets ? patch.facets.filter((facet) => allowed.includes(facet)) : account.file.facets;
    await this.#write(id, { ...account.file, facets: [...facets], policy: { ...account.file.policy, ...patch.policy } });
    return this.#view(id);
  }

  /** Revocation is best effort and never blocks the removal. Removing an unknown id is fine. */
  async remove(id: AccountId): Promise<void> {
    const account = this.#accounts.get(id);
    if (account?.revoke) {
      await account.revoke(AbortSignal.timeout(REVOKE_TIMEOUT_MS)).catch((error: unknown) => this.log.warn(`could not revoke ${id}: ${error instanceof Error ? error.message : String(error)}`));
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
    for (const id of ids) await this.#load(id);
    return JSON.stringify(this.list()) !== before;
  }

  /** One account from its two files. A broken file is logged and skipped, so it costs one account, never all. */
  async #load(id: AccountId): Promise<void> {
    try {
      const text = await readTextFile(this.#jsonPath(id));
      if (text === null) return void this.#accounts.delete(id);
      const file = AccountFile.parse(JSON.parse(text));
      if (file.id !== id) throw new Error(`file names account ${file.id}`);
      const entry = catalogEntry(file.entry);
      const facets = file.facets.filter(isFacet).filter(isPrivate);
      const base = { id, entry: file.entry, label: file.label, policy: { enabled: file.policy.enabled, shareOnline: file.policy.shareOnline }, power: entry?.power ?? "read", addedAt: file.addedAt };
      if (file.version > FILE_VERSION || !isConnectorId(file.connector) || !entry) {
        this.#accounts.set(id, { file, view: { ...base, facets, status: "needs-newer-version" }, open: null, revoke: null });
        return;
      }
      const connector = connectors[file.connector];
      const secretText = await readTextFile(this.#secretPath(id));
      const bound = secretText === null ? null : bind(connector, file, JSON.parse(secretText), facets.filter((facet) => connector.facets.includes(facet)));
      for (const secret of bound?.secrets ?? []) this.hide(secret);
      this.#accounts.set(id, {
        file,
        view: { ...base, facets, status: bound ? file.status : "reconnect" },
        open: bound?.open ?? null,
        revoke: bound?.revoke ?? null,
      });
    } catch (error) {
      this.log.warn(`skipping account ${id}: ${error instanceof Error ? error.message : String(error)}`);
      this.#accounts.delete(id);
    }
  }

  #emit(): void {
    for (const listener of this.#listeners) listener();
  }
}
