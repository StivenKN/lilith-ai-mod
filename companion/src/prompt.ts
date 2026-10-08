// Builds the system prompt: persona (editable) + live context + reply format rules (fixed).
// The format rules stay outside the persona so a user's persona edits can't break parsing.
// Spanish gets everything written natively; other languages use English plus "reply in X".

import esPersona from "../persona/es.md" with { type: "text" };
import enPersona from "../persona/en.md" with { type: "text" };
import { languages, type Language } from "./languages.ts";
import type { GameState } from "./protocol.ts";
import type { SearchResult } from "./search.ts";

export const defaultPersona = (language: Language): string => (language === "es" ? esPersona : enPersona).trim();

export interface PromptContext {
  language: Language;
  persona: string;
  now: Date;
  playerName: string;
  state: GameState | null;
  notes: readonly string[];
  maxChars: number;
  /** "available": she may ask for a search; otherwise what a search she asked for returned. */
  search?: SearchContext;
}

export type SearchContext =
  | { kind: "available" }
  | { kind: "results"; query: string; results: readonly SearchResult[] }
  | { kind: "failed"; query: string };

const localeTag = (language: Language): string => (language === "es" ? "es-419" : language);

function describeTime(now: Date, language: Language): string {
  let formatted: string;
  try {
    formatted = new Intl.DateTimeFormat(localeTag(language), {
      weekday: "long",
      day: "numeric",
      month: "long",
      hour: "2-digit",
      minute: "2-digit",
    }).format(now);
  } catch {
    formatted = now.toString();
  }
  const hour = now.getHours();
  const es = language === "es";
  const part =
    hour < 6 ? (es ? "madrugada" : "late night") : hour < 12 ? (es ? "mañana" : "morning") : hour < 19 ? (es ? "tarde" : "afternoon") : es ? "noche" : "evening";
  return `${formatted} (${part})`;
}

function describeState(state: GameState | null, es: boolean): string | null {
  if (!state) return null;
  if (state.sleep) return es ? "estabas dormida; si te hablan, acabas de despertar" : "you were asleep; if spoken to, you just woke up";
  if (state.drag) return es ? "te están arrastrando por la pantalla" : "you are being dragged across the screen";
  if (state.interacting) return es ? "tu anfitrión está jugando contigo (tocándote)" : "your host is playing with you (touching you)";
  return es ? "tranquila en el escritorio" : "relaxing on the desktop";
}

export function buildSystemPrompt(context: PromptContext): string {
  const es = context.language === "es";
  const lines: string[] = [context.persona.trim(), ""];

  lines.push(es ? "Contexto actual (úsalo con naturalidad, no lo recites):" : "Current context (use it naturally, don't recite it):");
  lines.push(`- ${es ? "Fecha y hora local" : "Local date and time"}: ${describeTime(context.now, context.language)}`);
  lines.push(
    context.playerName
      ? `- ${es ? "Tu anfitrión se llama" : "Your host's name is"} ${context.playerName}. ${es ? "No repitas su nombre en cada mensaje." : "Don't repeat it in every message."}`
      : `- ${es ? "No sabes el nombre de tu anfitrión; si surge, puedes preguntarlo." : "You don't know your host's name; you may ask if it comes up."}`,
  );
  const state = describeState(context.state, es);
  if (state) lines.push(`- ${es ? "Ahora mismo" : "Right now"}: ${state}`);
  if (context.notes.length > 0) {
    lines.push(`- ${es ? "Lo que sabes de tu anfitrión" : "What you know about your host"}:`);
    for (const note of context.notes) lines.push(`  - ${note}`);
  }
  lines.push("");

  if (es) {
    lines.push(
      "Formato de respuesta (obligatorio):",
      "- Responde siempre en español latinoamericano.",
      `- Máximo 2 o 3 frases breves, menos de ${context.maxChars} caracteres en total: se muestra en un globo de diálogo pequeño.`,
      "- Solo texto plano: sin markdown, sin listas, sin emojis, sin acciones entre asteriscos o paréntesis.",
      "- Empieza con una etiqueta de emoción: [neutral], [feliz], [triste], [enojada], [sorprendida] o [timida].",
      "- No escribas tu nombre antes de la respuesta.",
    );
    if (context.search?.kind === "available") {
      lines.push(
        "- Puedes buscar en internet. Si necesitas información actual o que no sabes con certeza (noticias, clima, precios, resultados, fechas de estreno, datos concretos), responde solo con [buscar: consulta breve] y nada más. Recibirás los resultados y luego responderás. No busques para charla normal.",
      );
    }
  } else {
    lines.push(
      "Reply format (mandatory):",
      `- Always reply in ${languages[context.language].english}${context.language === "en" ? "" : `, even though these instructions are in English`}.`,
      `- At most 2 or 3 short sentences, under ${context.maxChars} characters in total: it is shown in a small speech bubble.`,
      "- Plain text only: no markdown, no lists, no emoji, no actions in asterisks or parentheses.",
      "- Start with an emotion tag: [neutral], [happy], [sad], [angry], [surprised] or [shy].",
      "- Don't write your name before the reply.",
    );
    if (context.search?.kind === "available") {
      lines.push(
        "- You can search the internet. If you need current information or something you don't know for sure (news, weather, prices, scores, release dates, specific facts), reply only with [search: short query] and nothing else. You will get the results, then you reply. Don't search for normal small talk.",
      );
    }
  }
  if (context.search && context.search.kind !== "available") lines.push("", describeSearch(context.search, es));
  return lines.join("\n");
}

function describeSearch(search: Exclude<SearchContext, { kind: "available" }>, es: boolean): string {
  if (search.kind === "failed" || search.results.length === 0) {
    return es
      ? `Buscaste en internet "${search.query}" pero no obtuviste resultados. Dilo con naturalidad y responde con lo que sabes, sin inventar datos.`
      : `You searched the internet for "${search.query}" but got no results. Say so naturally and answer with what you know, without making up facts.`;
  }
  const header = es
    ? `Resultados de tu búsqueda en internet "${search.query}". Úsalos para responder con tus palabras y en tu formato; no leas direcciones web ni digas que eres un buscador:`
    : `Results of your internet search for "${search.query}". Use them to answer in your own words and format; don't read out web addresses or act like a search engine:`;
  const items = search.results.map((result, index) => {
    let host = result.url;
    try {
      host = new URL(result.url).hostname.replace(/^www\./, "");
    } catch {
      // keep the raw URL
    }
    return `${index + 1}. ${result.title} (${host}): ${result.snippet.slice(0, 400)}`;
  });
  return [header, ...items].join("\n");
}

/** Stand-in user turn when Lilith speaks first (providers need the last turn to be the user's). */
export const speakFirstCue = (language: Language, idleMinutes: number): string =>
  language === "es"
    ? `[Momento tranquilo: nadie te ha hablado en ${idleMinutes} minutos. Di algo breve por iniciativa propia: un pensamiento, una pregunta suave o algo sobre la hora. No repitas lo que ya dijiste.]`
    : `[Quiet moment: nobody has spoken to you for ${idleMinutes} minutes. Say something short on your own: a thought, a gentle question, or something about the time. Don't repeat what you said before.]`;

/** Extra instruction for the one retry after a near-duplicate reply. */
export const avoidRepeatCue = (language: Language): string =>
  language === "es"
    ? "\n\nImportante: tu respuesta anterior repetía algo que ya habías dicho. Di algo nuevo, con otras palabras."
    : "\n\nImportant: your previous reply repeated something you already said. Say something new, in different words.";

/** Prompt for the occasional memory pass that extracts lasting facts about the user. */
export function learnFactsPrompt(language: Language, known: readonly string[]): string {
  const target = languages[language].english;
  return [
    "You maintain a short list of durable facts about the user of a companion app, based on their messages.",
    "Extract only facts that will still matter in a week: name, preferences, hobbies, job or studies, important people, ongoing goals.",
    "Ignore moods of the moment, small talk, and anything sensitive (passwords, addresses, health details, finances).",
    `Write each new fact as one short line in ${target}, starting with "- ". Write nothing else.`,
    "If there is nothing new worth keeping, answer exactly: NONE",
    known.length > 0 ? `Already known (don't repeat):\n${known.map((fact) => `- ${fact}`).join("\n")}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}
