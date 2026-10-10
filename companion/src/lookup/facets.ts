// The vocabulary of what Lilith can look up: one row per facet. The model only ever sees facets,
// never services or accounts, so the tool list stays the same size however many accounts share one.
// Tool names are fixed nouns and the descriptions are measured wording (P-SURFACE run 7: 51/54 on
// the 4B target); tune them with scripts/eval-lookups.ts in hand.

export type Localized = { readonly en: string; readonly es: string };

export const facets = {
  web: {
    exposure: "public",
    tool: "web_search",
    description: "Search the internet for current information: news, weather, prices, sports results, release dates, specific facts. `query`: the words to search for.",
    tag: ["search", "web search", "buscar", "busca", "búsqueda", "busqueda"],
    noun: { en: "the internet", es: "internet" },
    label: { en: "the internet", es: "internet" },
  },
  mail: {
    exposure: "private",
    tool: "email",
    description: "Look in your host's email. Use it when they ask whether someone wrote, replied or sent something, or about a message. `query`: the words to look for (from:name works).",
    tag: [],
    noun: { en: "email", es: "el correo" },
    label: { en: "your email", es: "tu correo" },
  },
  files: {
    exposure: "private",
    tool: "files",
    description: "Look in your host's documents and cloud files. Use it when they ask about a file or what a document says. `query`: the words to look for.",
    tag: [],
    noun: { en: "files", es: "los archivos" },
    label: { en: "your files", es: "tus archivos" },
  },
  calendar: {
    exposure: "private",
    tool: "calendar",
    description: "Look in your host's calendar. Use it when they ask about plans, meetings or dates. `query`: the words or day to look for.",
    tag: [],
    noun: { en: "calendar", es: "el calendario" },
    label: { en: "your calendar", es: "tu calendario" },
  },
} as const satisfies Record<string, {
  exposure: "public" | "private";
  tool: string;
  description: string;
  tag: readonly string[];
  /** How the rules name it to the model, with its Spanish article ("el correo" becomes "su correo"). */
  noun: Localized;
  /** How the status line names it to the player. */
  label: Localized;
}>;

export type Facet = keyof typeof facets;
export type PrivateFacet = { [F in Facet]: (typeof facets)[F]["exposure"] extends "private" ? F : never }[Facet];

export const isFacet = (value: string): value is Facet => Object.hasOwn(facets, value);
export const isPrivate = (facet: Facet): facet is PrivateFacet => facets[facet].exposure === "private";
export const privateFacets = Object.keys(facets).filter(isFacet).filter(isPrivate);
