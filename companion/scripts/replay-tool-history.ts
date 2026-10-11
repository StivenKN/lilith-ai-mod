// Replays the companion's first computer-turn request against a local Ollama, as ollama.ts sends
// it, and counts whether the model calls a tool or answers in words. What varies is the history
// before the request: PC exchanges as her words alone (HISTORY=real, what memory stored before
// past calls were kept), the same exchanges with their calls rendered by the Ollama adapter from
// stored turns (HISTORY=tools, what memory sends now), and controls. Needs Ollama running locally
// with the model pulled.
//
//   bun scripts/replay-tool-history.ts
//   HISTORY=none|short|real|chatonly|textmark|tools  LANG_CASE=es|en  BROWSER=1  WEB=1  FOLLOW=1
//   SAMPLES=2  MODEL=qwen3-vl:4b-instruct  NUM_CTX=8192  ONLY="Abre Spotify"  OLLAMA=http://127.0.0.1:11434
//
// A row is PASS when the model acted on a PC request or talked on a casual one; SUMMARY counts both.

import { computerTools } from "../src/computer/actions.ts";
import { buildSystemPrompt, defaultPersona, withTurnNote, type PromptContext } from "../src/prompt.ts";
import { turnMessages } from "../src/providers/ollama.ts";
import { toolSchema } from "../src/providers/tools.ts";
import { normalizeTurns, type ChatTurn } from "../src/providers/types.ts";

type Lang = "es" | "en";
type Message = ReturnType<typeof turnMessages>[number];
const lang: Lang = process.env.LANG_CASE === "en" ? "en" : "es";
const model = process.env.MODEL ?? "qwen3-vl:4b-instruct";
const samples = Number(process.env.SAMPLES ?? 2);
const historyKind = process.env.HISTORY ?? "none";
const browser = process.env.BROWSER === "1";
const numCtx = Number(process.env.NUM_CTX ?? 8192);
const only = process.env.ONLY;
const ollama = process.env.OLLAMA ?? "http://127.0.0.1:11434";

const cases: Record<Lang, Array<{ text: string; act: boolean }>> = {
  es: [
    { text: "Abre el bloc de notas", act: true },
    { text: "Pon música lofi en YouTube", act: true },
    { text: "Abre Spotify", act: true },
    { text: "Cierra esta ventana", act: true },
    { text: "Busca recetas de arepas en Google", act: true },
    { text: "Activa el bluetooth", act: true },
    { text: "Hola Lilith, ¿cómo estás?", act: false },
    { text: "Hoy estoy muy cansado del trabajo", act: false },
  ],
  en: [
    { text: "Open Notepad", act: true },
    { text: "Play some lofi music on YouTube", act: true },
    { text: "Open the calculator", act: true },
    { text: "Minimize this window", act: true },
    { text: "Search Google for arepa recipes", act: true },
    { text: "Turn on Bluetooth", act: true },
    { text: "Hi Lilith, how are you?", act: false },
    { text: "I'm so tired from work today", act: false },
  ],
};

const real: Record<Lang, ChatTurn[]> = {
  es: [
    { role: "user", content: "Hola Lilith" },
    { role: "assistant", content: "¡Hola! Qué bueno verte por aquí otra vez." },
    { role: "user", content: "Abre la calculadora" },
    { role: "assistant", content: "Listo, ya abrí la calculadora para ti." },
    { role: "user", content: "gracias" },
    { role: "assistant", content: "De nada, para eso estoy." },
    { role: "user", content: "Pon algo de música en YouTube" },
    { role: "assistant", content: "Abrí YouTube con música para ti, ¡disfrútala!" },
    { role: "user", content: "¿Qué hiciste hoy?" },
    { role: "assistant", content: "Estuve aquí pensando en ti y mirando por la ventana." },
  ],
  en: [
    { role: "user", content: "Hi Lilith" },
    { role: "assistant", content: "Hi! It's good to see you again." },
    { role: "user", content: "Open the calculator" },
    { role: "assistant", content: "Done, I opened the calculator for you." },
    { role: "user", content: "thanks" },
    { role: "assistant", content: "You're welcome, that's what I'm here for." },
    { role: "user", content: "Put some music on YouTube" },
    { role: "assistant", content: "I opened YouTube with some music for you, enjoy!" },
    { role: "user", content: "What did you do today?" },
    { role: "assistant", content: "I stayed here thinking about you and looking out the window." },
  ],
};

const pcTools = computerTools(true, browser);
const offered = pcTools.map((tool) => tool.name);
const stored = (lang: Lang): ChatTurn[] => real[lang].map((turn, i) =>
  i === 3 ? { ...turn, acted: [{ name: "open_app", input: { name: lang === "es" ? "calculadora" : "calculator" } }] }
  : i === 7 ? { ...turn, acted: [{ name: "open_url", input: { url: `https://www.youtube.com/results?search_query=${lang === "es" ? "musica" : "music"}` } }] }
  : turn);
const marked = (lang: Lang): ChatTurn[] => real[lang].map((turn, i) =>
  i === 3 ? { ...turn, content: `(open_app: ${lang === "es" ? "calculadora" : "calculator"}) ${turn.content}` }
  : i === 7 ? { ...turn, content: `(open_url: https://www.youtube.com/results?search_query=music) ${turn.content}` }
  : turn);
const chatOnly = (lang: Lang): ChatTurn[] => real[lang].filter((_, i) => i < 2 || (i >= 4 && i < 6) || i >= 8);
const words = (turns: ChatTurn[]): Message[] => turns.map(({ role, content }) => ({ role, content }));

const histories: Record<string, Record<Lang, Message[]>> = {
  none: { es: [], en: [] },
  short: {
    es: [{ role: "user", content: "Ya llegué a casa" }, { role: "assistant", content: "¡Bienvenido! Te estaba esperando, ¿qué tal te fue?" }],
    en: [{ role: "user", content: "I'm home" }, { role: "assistant", content: "Welcome back! I was waiting for you, how did it go?" }],
  },
  real: { es: words(real.es), en: words(real.en) },
  chatonly: { es: words(chatOnly("es")), en: words(chatOnly("en")) },
  textmark: { es: words(marked("es")), en: words(marked("en")) },
  tools: { es: normalizeTurns(stored("es"), offered).flatMap(turnMessages), en: normalizeTurns(stored("en"), offered).flatMap(turnMessages) },
};

if (process.env.FOLLOW === "1") {
  cases.es = [{ text: "Ahora ciérrala", act: true }, { text: "Ábrela otra vez", act: true }];
  cases.en = [{ text: "Now close it", act: true }, { text: "Open it again", act: true }];
  for (const kind of Object.keys(histories)) for (const l of ["es", "en"] as const) {
    const h = histories[kind]![l];
    const at = h.findIndex((turn, i) => i > 3 && turn.role === "user" && h[i - 1]?.role === "assistant");
    histories[kind]![l] = at > 0 && kind !== "none" && kind !== "short" ? h.slice(0, at) : h;
  }
}

const history = histories[historyKind];
if (!history) throw new Error(`HISTORY must be one of: ${Object.keys(histories).join(", ")}`);

const context: PromptContext = {
  language: lang, persona: defaultPersona(lang), now: new Date("2026-10-11T19:30:00"), playerName: "Alex", state: null,
  notes: [], summary: "", maxChars: 240, facets: process.env.WEB === "1" ? ["web"] : [],
  computer: { vision: true, browser },
};
const tools = pcTools.map((tool) => ({ type: "function", function: { name: tool.name, description: tool.description, parameters: toolSchema(tool) } }));
const system = buildSystemPrompt(context);

let acted = 0, actTotal = 0, chatted = 0, chatTotal = 0;
for (const item of cases[lang].filter((c) => !only || c.text === only)) {
  for (let i = 0; i < samples; i++) {
    const messages: Message[] = [{ role: "system", content: system }, ...history[lang], { role: "user", content: withTurnNote(context, item.text) }];
    const started = performance.now();
    const response = await fetch(`${ollama}/api/chat`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ model, messages, stream: false, think: false, keep_alive: "30m", tools, options: { num_ctx: numCtx, num_predict: 300, temperature: 0.8, seed: 1000 + i } }),
    });
    const body = await response.json() as { message?: { content: string; tool_calls?: Array<{ function: { name: string; arguments: unknown } }> }; prompt_eval_count?: number; error?: string };
    const secs = ((performance.now() - started) / 1000).toFixed(0);
    if (!body.message) { console.log(`ERROR ${response.status} ${body.error}`); continue; }
    const call = body.message.tool_calls?.[0];
    const tool = !!call || /<tool_call>|^\s*\{/.test(body.message.content);
    const ok = tool === item.act;
    if (item.act) { actTotal++; if (tool) acted++; } else { chatTotal++; if (!tool) chatted++; }
    console.log(`${ok ? "PASS" : "FAIL"}\t${item.act ? "act " : "chat"}\tprompt=${body.prompt_eval_count}\t${secs}s\t${item.text}\t${call ? `${call.function.name} ${JSON.stringify(call.function.arguments)}` : body.message.content.replace(/\s+/g, " ").slice(0, 140)}`);
  }
}
console.log(`\nSUMMARY ${model} lang=${lang} history=${historyKind} browser=${browser} ctx=${numCtx}: acted ${acted}/${actTotal}, chatted ${chatted}/${chatTotal}`);
