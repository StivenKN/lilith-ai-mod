// A lookup query as every source receives it: the model's words with the parts that mean a
// time window or a sender taken out, so Gmail, Drive and Calendar each apply them their own way.

/** Half-open, in local time. */
export interface Window {
  since: Date;
  until: Date;
}

export interface Query {
  /** The words left to search for, whitespace collapsed. */
  text: string;
  /** The same words folded (lowercase, no accents), for sources that match on their own. */
  words: readonly string[];
  /** "ayer", "this week". Null when the query names no day. */
  window: Window | null;
  /** `from:laura` as written by the model, without the operator. */
  from: string | null;
}

const startOfDay = (date: Date) => new Date(date.getFullYear(), date.getMonth(), date.getDate());
const daysFrom = (day: Date, offset: number) => new Date(day.getFullYear(), day.getMonth(), day.getDate() + offset);
const days = (from: number, to: number) => (today: Date): Window => ({ since: daysFrom(today, from), until: daysFrom(today, to) });

/** Day words in Spanish and English, each with the window it means relative to today. */
const DAY_WORDS: ReadonlyArray<{ pattern: RegExp; window: (today: Date) => Window }> = [
  { pattern: /\b(?:hoy|today)\b/iu, window: days(0, 1) },
  { pattern: /\b(?:mañana|manana|tomorrow)\b/iu, window: days(1, 2) },
  { pattern: /\b(?:ayer|yesterday)\b/iu, window: days(-1, 0) },
  {
    pattern: /\b(?:esta semana|this week)\b/iu,
    window: (today) => {
      const monday = daysFrom(today, -((today.getDay() + 6) % 7));
      return { since: monday, until: daysFrom(monday, 7) };
    },
  },
];

const FROM = /\bfrom:\(?([^\s()]+)\)?/iu;

export const foldWords = (text: string): string[] =>
  text.toLowerCase().normalize("NFD").replace(/\p{M}/gu, "").split(/[^\p{L}\p{N}]+/u).filter((word) => word.length >= 2);

export function parseQuery(raw: string, now = new Date()): Query {
  let text = raw;
  const from = FROM.exec(text)?.[1] ?? null;
  if (from !== null) text = text.replace(FROM, " ");
  let window: Window | null = null;
  for (const day of DAY_WORDS) {
    if (!day.pattern.test(text)) continue;
    window = day.window(startOfDay(now));
    text = text.replace(day.pattern, " ");
    break;
  }
  text = text.replace(/\s+/g, " ").trim();
  return { text, words: foldWords(text), window, from };
}
