// The 12 languages the game ships, how to recognise them in `GameSetting.Language`
// (raw values are not documented, so matching is deliberately forgiving), and what the
// dashboard should use for its own UI.

export const languages = {
  es: { english: "Latin American Spanish", native: "Español (Latinoamérica)" },
  en: { english: "English", native: "English" },
  "zh-Hans": { english: "Simplified Chinese", native: "简体中文" },
  "zh-Hant": { english: "Traditional Chinese", native: "繁體中文" },
  ja: { english: "Japanese", native: "日本語" },
  ko: { english: "Korean", native: "한국어" },
  ru: { english: "Russian", native: "Русский" },
  th: { english: "Thai", native: "ไทย" },
  vi: { english: "Vietnamese", native: "Tiếng Việt" },
  id: { english: "Indonesian", native: "Bahasa Indonesia" },
  tr: { english: "Turkish", native: "Türkçe" },
  "pt-BR": { english: "Brazilian Portuguese", native: "Português (Brasil)" },
} as const;

export type Language = keyof typeof languages;
export const languageCodes = Object.keys(languages) as [Language, ...Language[]];

// Checked in order; the first match wins (Traditional before Simplified, etc.).
const matchers: ReadonlyArray<readonly [RegExp, Language]> = [
  [/^es\b|^es[-_]|spanish|espa[nñ]ol/i, "es"],
  [/^zh[-_](tw|hk|mo|hant)|traditional|繁/i, "zh-Hant"],
  [/^zh|^cn$|chinese|simplified|简|中文/i, "zh-Hans"],
  [/^ja\b|^ja[-_]|^jp$|japan|日本/i, "ja"],
  [/^ko\b|^ko[-_]|korean|한국/i, "ko"],
  [/^ru\b|^ru[-_]|russian|рус/i, "ru"],
  [/^th\b|^th[-_]|thai|ไทย/i, "th"],
  [/^vi\b|^vi[-_]|vietnam/i, "vi"],
  [/^id\b|^id[-_]|^in[-_]id|indones/i, "id"],
  [/^tr\b|^tr[-_]|turk/i, "tr"],
  [/^pt|portug/i, "pt-BR"],
  [/^en\b|^en[-_]|english/i, "en"],
];

/** Maps a raw game/OS language string to one of the game's languages, or null if unknown. */
export function resolveLanguage(raw: string | null | undefined): Language | null {
  const value = raw?.trim();
  if (!value) return null;
  return matchers.find(([pattern]) => pattern.test(value))?.[1] ?? null;
}

export type UiLocale = "es" | "en";

/** The dashboard and in-game status lines are translated to Spanish and English. */
export const uiLocaleFor = (language: Language | null): UiLocale => (language === "es" ? "es" : "en");
