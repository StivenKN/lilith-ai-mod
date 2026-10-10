// Protocols times services. A connector speaks one protocol; a catalog entry is one tile in the
// dashboard's Add list, a service on a known protocol. Only Google ships for now; IMAP, folders,
// ICS and MCP come back as one connector module plus a catalog line each.

import type { Localized, PrivateFacet } from "../lookup/facets.ts";
import { google, googleClient } from "./connectors/google.ts";

export { googleClient };

/** Keys are persisted in account files: never renamed once shipped. */
export const connectors = { google } as const;
export type ConnectorId = keyof typeof connectors;
export const isConnectorId = (value: string): value is ConnectorId => Object.hasOwn(connectors, value);

export interface CatalogEntry {
  id: string;
  connector: ConnectorId;
  name: string;
  facets: readonly PrivateFacet[];
  /** "full" when the credential can do more than Lilith does (an app password). The tile says so. */
  power: "read" | "full";
  help: Localized;
}

export const catalog = [
  {
    id: "google",
    connector: "google",
    name: "Google",
    facets: ["mail", "files", "calendar"],
    power: "read",
    help: {
      en: "Sign in with Google. Lilith can read your Gmail, Drive and Calendar when you ask her to; she never writes or sends anything. On Google's page, untick anything she shouldn't see.",
      es: "Inicia sesión con Google. Lilith puede leer tu Gmail, Drive y Calendar cuando se lo pidas; nunca escribe ni envía nada. En la página de Google, desmarca lo que no quieras que vea.",
    },
  },
] as const satisfies readonly CatalogEntry[];

export const catalogEntry = (id: string): CatalogEntry | null => catalog.find((entry) => entry.id === id) ?? null;
