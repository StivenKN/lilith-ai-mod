// What a connector is to the account store: how to sign the player in, how to read what they
// granted, and how to hide every secret it holds. A protocol module implements this once; a service
// on that protocol is a catalog line (registry.ts).

import { z } from "zod";
import type { PrivateFacet } from "../lookup/facets.ts";
import type { Source } from "../lookup/sources.ts";

/** "google-3f9a2c1b0d4e": the catalog entry plus a hash of the user, so the same account twice converges to one. */
export const AccountId = z.string().regex(/^[a-z0-9][a-z0-9-]*$/).brand<"AccountId">();
export type AccountId = z.infer<typeof AccountId>;

export const accountId = (entry: string, user: string): AccountId =>
  AccountId.parse(`${entry}-${new Bun.CryptoHasher("sha256").update(`${entry}\n${user.trim().toLowerCase()}`).digest("hex").slice(0, 12)}`);

/** What a finished sign-in yields: the two files' contents, the name shown for the account, and what the player granted. */
export interface Connected<Settings, Secret> {
  settings: Settings;
  secret: Secret;
  label: string;
  facets: readonly PrivateFacet[];
}

export interface OpenAccount<Settings, Secret> {
  id: AccountId;
  label: string;
  facets: readonly PrivateFacet[];
  settings: Settings;
  secret: Secret;
}

export interface Connector<Settings, Secret> {
  facets: readonly PrivateFacet[];
  settings: z.ZodType<Settings>;
  secret: z.ZodType<Secret>;
  /** Every literal the logger must hide. Derived from the secret itself, so a new field cannot skip redaction. */
  secretsOf(secret: Secret): string[];
  /** The consent page the dashboard sends the player to, or null when this build has no client. */
  consentUrl(flow: { redirectUri: string; state: string; codeChallenge: string }): string | null;
  /** Trades the callback's code for the account. Throws with a message the dashboard can show. */
  finish(grant: { code: string; redirectUri: string; codeVerifier: string }, signal: AbortSignal): Promise<Connected<Settings, Secret>>;
  /** Best effort: a failure never blocks a disconnect. */
  revoke(secret: Secret, signal: AbortSignal): Promise<void>;
  /** One read-only source per facet of the account. Parses its wire format into findings at the boundary. */
  open(account: OpenAccount<Settings, Secret>): Source[];
}
