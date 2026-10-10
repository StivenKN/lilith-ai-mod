// The whole privacy policy for lookups, as one pure function: who asked, where the answer goes,
// and what the player allowed for the account.

import type { StoredTurn } from "../memory.ts";
import { isLocalUrl } from "../providers/presets.ts";
import { facets, type Facet } from "./facets.ts";

export type Origin = "player" | "autonomous";
export type Audience = "local" | "online";

export interface Gate {
  readonly origin: Origin;
  readonly audience: Audience;
}

/** A new turn source does not compile until it gets a row here. */
export const originOf = {
  game: "player",
  dashboard: "player",
  speakFirst: "autonomous",
  keepsake: "autonomous",
} as const satisfies Record<StoredTurn["source"], Origin>;

/** Whether the AI runs on this PC or LAN: the same check that turns computer control on. */
export const audienceOf = (settings: { baseUrl: string }): Audience => (isLocalUrl(settings.baseUrl) ? "local" : "online");

export interface Policy {
  readonly enabled: boolean;
  readonly shareOnline: boolean;
}

/** Public facets always; private ones on player turns, for enabled accounts, online only when shared. */
export function mayConsult(facet: Facet, policy: Policy | null, gate: Gate): boolean {
  if (facets[facet].exposure === "public") return true;
  return gate.origin === "player" && policy !== null && policy.enabled && (gate.audience === "local" || policy.shareOnline);
}
