// OAuth sign-ins in flight, held in memory by the process that served connectAccount. The callback
// is authenticated by a single-use state and the PKCE verifier, never by the session cookie: the
// browser does not send it on that request (P-CALLBACK). The consent URL is handed to the dashboard,
// which navigates to it; it is never opened or logged here, and neither is the callback's query.

import type { Translate } from "../i18n.ts";
import { errorMessage, type Log } from "../log.ts";
import { connectors, type CatalogEntry } from "./registry.ts";
import type { AccountStore } from "./store.ts";

/** How long the player has on Google's page. */
const FLOW_TTL_MS = 10 * 60_000;
const FINISH_TIMEOUT_MS = 30_000;

/** What the dashboard reads from `/#accounts?result=`. */
export type Outcome = "connected" | "denied" | "failed" | "expired" | "finished";

interface Flow {
  entry: CatalogEntry;
  shareOnline: boolean;
  verifier: string;
  redirectUri: string;
  expiresAt: number;
}

const randomToken = () => Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");

export class PendingFlows {
  #flows = new Map<string, Flow>();
  /** States already used, so a replayed callback reads "already finished" instead of "expired". */
  #finished = new Map<string, number>();

  constructor(
    private readonly options: {
      store: AccountStore;
      /** This process's dashboard port, known once the server listens. */
      port: () => number;
      log: Log;
      tr: () => Translate;
      now?: () => number;
    },
  ) {}

  #now = () => this.options.now?.() ?? Date.now();

  redirectUri(): string {
    return `http://127.0.0.1:${this.options.port()}/api/accounts/callback`;
  }

  start(entry: CatalogEntry, shareOnline: boolean): { kind: "consent"; url: string } | { kind: "failed"; message: string } {
    this.#prune();
    const state = randomToken();
    const verifier = randomToken();
    const redirectUri = this.redirectUri();
    const url = connectors[entry.connector].consentUrl({ redirectUri, state, codeChallenge: new Bun.CryptoHasher("sha256").update(verifier).digest("base64url") });
    if (!url) return { kind: "failed", message: this.options.tr()("accounts.noClient") };
    this.#flows.set(state, { entry, shareOnline, verifier, redirectUri, expiresAt: this.#now() + FLOW_TTL_MS });
    this.options.log.info(`${entry.id} sign-in started`);
    return { kind: "consent", url };
  }

  /** GET /api/accounts/callback. Always a 302 back to the dashboard's Accounts tab with an outcome. */
  async finish(url: URL): Promise<Response> {
    const state = url.searchParams.get("state") ?? "";
    const flow = this.#flows.get(state);
    if (!flow) return redirect(this.#finished.has(state) ? "finished" : "expired");
    this.#flows.delete(state);
    this.#finished.set(state, this.#now());
    const { entry } = flow;
    const error = url.searchParams.get("error");
    if (error === "access_denied") {
      this.options.log.info(`${entry.id} sign-in denied by the player`);
      return redirect("denied");
    }
    if (error) {
      this.options.log.warn(`${entry.id} sign-in failed: ${error}`);
      return redirect("failed");
    }
    const code = url.searchParams.get("code");
    if (!code) return redirect("failed");
    if (flow.expiresAt < this.#now()) return redirect("expired");
    try {
      const connected = await connectors[entry.connector].finish({ code, redirectUri: flow.redirectUri, codeVerifier: flow.verifier }, AbortSignal.timeout(FINISH_TIMEOUT_MS));
      await this.options.store.add(entry, connected, flow.shareOnline);
      return redirect("connected");
    } catch (failure) {
      this.options.log.warn(`${entry.id} sign-in failed: ${errorMessage(failure)}`);
      return redirect("failed");
    }
  }

  #prune(): void {
    const now = this.#now();
    for (const [state, flow] of this.#flows) if (flow.expiresAt < now) this.#flows.delete(state);
    for (const [state, at] of this.#finished) if (at + FLOW_TTL_MS < now) this.#finished.delete(state);
  }
}

const redirect = (result: Outcome) => new Response(null, { status: 302, headers: { location: `/#accounts?result=${result}` } });
