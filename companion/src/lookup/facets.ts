// The vocabulary of what Lilith can look up: one row per facet. The model only ever sees facets,
// never services or accounts, so the tool list stays the same size however many accounts share one.

type Localized = { readonly en: string; readonly es: string };

export const facets = {
  web: {
    exposure: "public",
    tool: "web_search",
    when: "current information: news, weather, prices, sports results, release dates, specific facts",
    tag: ["search", "web search", "buscar", "busca", "búsqueda", "busqueda"],
    label: { en: "the internet", es: "internet" },
  },
} as const satisfies Record<string, { exposure: "public" | "private"; tool: string; when: string; tag: readonly string[]; label: Localized }>;

export type Facet = keyof typeof facets;
