// Turns whatever the model returned into text the game's speech bubble can show.
// Lenient by design: small local models and "thinking" models break strict formats, so we
// accept plain text, an optional [emotion] tag in Spanish or English, and clean up the rest.

import type { Emotion } from "./protocol.ts";

const emotionAliases: Record<string, Emotion> = {
  neutral: "neutral", neutra: "neutral", calm: "neutral", calma: "neutral", tranquila: "neutral", serena: "neutral",
  happy: "happy", joy: "happy", smile: "happy", feliz: "happy", alegre: "happy", contenta: "happy", sonriente: "happy", divertida: "happy", playful: "happy",
  sad: "sad", triste: "sad", melancolica: "sad", melancholic: "sad", dolida: "sad",
  angry: "angry", annoyed: "angry", enojada: "angry", enfadada: "angry", molesta: "angry", irritada: "angry",
  surprised: "surprised", surprise: "surprised", sorprendida: "surprised", sorpresa: "surprised", asombrada: "surprised",
  shy: "shy", embarrassed: "shy", blush: "shy", timida: "shy", avergonzada: "shy", sonrojada: "shy", apenada: "shy",
};

const stripAccents = (text: string) => text.normalize("NFD").replace(/\p{M}/gu, "");

export interface ParsedReply {
  text: string;
  emotion: Emotion;
  /** The model produced reasoning but no visible answer. */
  reasoningOnly: boolean;
}

export function parseReply(raw: string, maxChars: number): ParsedReply {
  let text = raw.replace(/\r\n?/g, "\n");

  // Reasoning blocks: complete, closing-only (opening tag eaten by the server), or never closed.
  const hadThinking = /<\/?think(ing)?>/i.test(text);
  text = text.replace(/<think(ing)?>[\s\S]*?<\/think(ing)?>/gi, "");
  const closing = text.search(/<\/think(ing)?>/i);
  if (closing >= 0) text = text.slice(text.indexOf(">", closing) + 1);
  const opening = text.search(/<think(ing)?>/i);
  if (opening >= 0) text = text.slice(0, opening);

  let emotion: Emotion = "neutral";
  let tagged = false;
  text = text.replace(/[[(（【]\s*([\p{L} ]{2,24}?)\s*[\])）】]/gu, (match, word: string, offset: number) => {
    const key = stripAccents(word.trim().toLowerCase());
    const known = emotionAliases[key];
    if (known && !tagged) {
      emotion = known;
      tagged = true;
      return "";
    }
    if (known) return "";
    // An unknown single-word tag at the very start is still a (misspelled) emotion tag.
    return offset === 0 && !key.includes(" ") ? "" : match;
  });

  text = text
    .replace(/^\s*(lilith(-chan)?|莉莉丝|莉莉絲|リリス)\s*[:：]\s*/i, "")
    .replace(/\[([^\]]+)\]\((?:https?:)?[^)]*\)/g, "$1") // markdown links → their text
    .replace(/(\*\*|__)(.+?)\1/g, "$2") // bold
    .replace(/(^|[\s"“«])\*[^*\n]{1,80}\*(?=\s|$|[.,!?¡¿"”»])/g, "$1") // *stage directions*
    .replace(/`+([^`]*)`+/g, "$1")
    .replace(/^\s*#{1,6}\s+/gm, "")
    .replace(/^\s*(?:[-*•]|\d+[.)])\s+/gm, "")
    .replace(/[\p{Extended_Pictographic}\u{FE0F}\u{200D}\u{20E3}\u{2600}-\u{27BF}]/gu, "")
    .replace(/\s+/g, " ")
    .replace(/\s+([,.;:!?…)\]])/g, "$1")
    .replace(/(["“«])\s+/g, "$1")
    .trim();

  const quoted = /^["“«「](.*)["”»」]$/s.exec(text);
  if (quoted?.[1]) text = quoted[1].trim();

  return { text: truncate(text, maxChars), emotion, reasoningOnly: hadThinking && text.length === 0 };
}

/** Cuts long replies at the last sentence end, or at a word boundary with an ellipsis. */
export function truncate(text: string, maxChars: number): string {
  const chars = Array.from(text);
  if (chars.length <= maxChars) return text;
  const head = chars.slice(0, maxChars).join("");
  const sentenceEnd = Math.max(...[".", "!", "?", "…", "。", "！", "？"].map((mark) => head.lastIndexOf(mark)));
  if (sentenceEnd >= maxChars * 0.5) return head.slice(0, sentenceEnd + 1).trim();
  const space = head.lastIndexOf(" ");
  return `${(space >= maxChars * 0.5 ? head.slice(0, space) : head).trim()}…`;
}

const WIDE = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}　-〿！-｠￠-￦]/u;

/** Visual width in bubble units: CJK and full-width characters count double. */
export const charWidth = (char: string): number => (/\p{M}/u.test(char) ? 0 : WIDE.test(char) ? 2 : 1);
export const textWidth = (text: string): number => Array.from(text).reduce((sum, char) => sum + charWidth(char), 0);

/** Word-wraps for the speech bubble. Latin text breaks at spaces; CJK can break anywhere. */
export function wrapLines(text: string, lineUnits: number): string[] {
  const lines: string[] = [];
  let line = "";
  let width = 0;
  const push = () => {
    if (line.trim()) lines.push(line.trim());
    line = "";
    width = 0;
  };

  for (const token of text.split(/(\s+)/)) {
    if (!token) continue;
    if (/^\s+$/.test(token)) {
      if (width > 0 && width + 1 <= lineUnits) {
        line += " ";
        width += 1;
      }
      continue;
    }
    const tokenWidth = textWidth(token);
    if (!WIDE.test(token) && tokenWidth <= lineUnits) {
      if (width + tokenWidth > lineUnits) push();
      line += token;
      width += tokenWidth;
      continue;
    }
    // CJK runs and over-long words: place character by character.
    for (const char of Array.from(token)) {
      const w = charWidth(char);
      if (width + w > lineUnits) push();
      line += char;
      width += w;
    }
  }
  push();
  return lines;
}

export interface Page {
  text: string;
  seconds: number;
}

/** Splits a reply into bubble pages with a reading time for each. */
export function paginate(text: string, lineUnits: number, linesPerPage: number): Page[] {
  const lines = wrapLines(text, lineUnits);
  const pages: Page[] = [];
  for (let i = 0; i < lines.length; i += linesPerPage) {
    const pageLines = lines.slice(i, i + linesPerPage);
    const units = pageLines.reduce((sum, line) => sum + textWidth(line), 0);
    pages.push({ text: pageLines.join("\n"), seconds: readingSeconds(units) });
  }
  return pages;
}

export const readingSeconds = (units: number): number => Math.min(12, Math.max(3, 2 + units * 0.07));

const trigrams = (text: string): Set<string> => {
  const clean = ` ${stripAccents(text.toLowerCase()).replace(/[^\p{L}\p{N} ]/gu, "").replace(/\s+/g, " ").trim()} `;
  const grams = new Set<string>();
  for (let i = 0; i < clean.length - 2; i++) grams.add(clean.slice(i, i + 3));
  return grams;
};

/** Jaccard similarity of character trigrams, 0..1. Cheap and language-agnostic. */
export function similarity(a: string, b: string): number {
  const x = trigrams(a);
  const y = trigrams(b);
  if (x.size === 0 || y.size === 0) return 0;
  let shared = 0;
  for (const gram of x) if (y.has(gram)) shared++;
  return shared / (x.size + y.size - shared);
}

export const isRepeat = (reply: string, previous: readonly string[], threshold = 0.8): boolean =>
  previous.some((earlier) => similarity(reply, earlier) >= threshold);
