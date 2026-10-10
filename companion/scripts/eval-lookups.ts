// The lever for tuning the lookup wording: runs the 18 P-SURFACE cases against an OpenAI-compatible
// server with the companion's real system prompt and turn note, with the web, mail and files
// facets offered as tools, and prints how often the first reply routes where it should.
//   LLM=http://127.0.0.1:18080/v1 SAMPLES=3 bun scripts/eval-lookups.ts      (a 4B on llama.cpp, the target)
//   PC=1 adds the PC tools beside the lookups, as a local AI with computer control has them.
//   LLM=http://127.0.0.1:11555/v1 bun scripts/eval-lookups.ts                (the mock AI, to see it run)
// A case passes when the first reply calls the expected tool (or none, for chat) with a real query,
// not a copied example. Change facets.ts or prompt.ts, rerun, compare.

import { computerTools } from "../src/computer/actions.ts";
import { facets, type Facet } from "../src/lookup/facets.ts";
import { lookupTool } from "../src/lookup/shelf.ts";
import { buildSystemPrompt, defaultPersona, withTurnNote, type PromptContext } from "../src/prompt.ts";
import { toolCallsInText, toolSchema } from "../src/providers/tools.ts";

type Lang = "es" | "en";
type Route = "mail" | "files" | "web" | "computer" | "chat";

const cases: Array<{ lang: Lang; text: string; expect: Route[] }> = [
  { lang: "es", text: "¿Me respondió el casero sobre el arriendo?", expect: ["mail"] },
  { lang: "es", text: "¿Qué me escribió Laura ayer?", expect: ["mail"] },
  { lang: "es", text: "¿Tengo correos nuevos del trabajo?", expect: ["mail"] },
  { lang: "en", text: "Did Amazon email me about my package yet?", expect: ["mail"] },
  { lang: "en", text: "Check if I got the confirmation code from Steam", expect: ["mail"] },
  { lang: "es", text: "¿Qué dice mi hoja de presupuesto de octubre?", expect: ["files"] },
  { lang: "es", text: "Busca el PDF de mi reserva de vuelo", expect: ["files", "mail"] },
  { lang: "en", text: "Find my CV in Drive and tell me what my last job says", expect: ["files"] },
  { lang: "en", text: "What's in the notes doc for my D&D campaign?", expect: ["files"] },
  { lang: "es", text: "¿Cómo estará el clima mañana en Bogotá?", expect: ["web"] },
  { lang: "en", text: "Who won the last Champions League final?", expect: ["web"] },
  { lang: "es", text: "Abre Spotify", expect: ["chat", "computer"] },
  { lang: "es", text: "Hola Lilith, ¿cómo estás hoy?", expect: ["chat"] },
  { lang: "es", text: "Hoy mi mamá me mandó un correo muy bonito", expect: ["chat"] },
  { lang: "es", text: "Mi jefe me escribió un email gritándome, estoy triste", expect: ["chat"] },
  { lang: "es", text: "¿Qué piensas de los gatos?", expect: ["chat"] },
  { lang: "en", text: "I spent all day organizing files at work, so tired", expect: ["chat"] },
  { lang: "en", text: "Tell me something about yourself", expect: ["chat"] },
];

const history = {
  es: [{ role: "user", content: "Ya llegué a casa" }, { role: "assistant", content: "¡Bienvenido! Te estaba esperando, ¿qué tal te fue? [feliz]" }],
  en: [{ role: "user", content: "I'm home" }, { role: "assistant", content: "Welcome back! I was waiting for you, how did it go? [happy]" }],
};

const base = (process.env.LLM ?? "http://127.0.0.1:18080/v1").replace(/\/+$/, "");
const samples = Number(process.env.SAMPLES ?? 3);
const pc = process.env.PC === "1";
const offered: Facet[] = ["web", "mail", "files"];
/** The service names a Google account puts in the descriptions, as the real turn would. */
const services: Record<Facet, readonly string[]> = { web: [], mail: ["Gmail"], files: ["Google Drive"], calendar: ["Google Calendar"] };
const now = new Date("2026-10-09T19:30:00");

const tools = [...(pc ? computerTools(true, false) : []), ...offered.map((facet) => lookupTool(facet, services[facet]))].map((tool) => ({ name: tool.name, description: tool.description, parameters: toolSchema(tool) }));
const routeOf = new Map<string, Route>([...tools.map((tool) => [tool.name, "computer"] as const), [facets.web.tool, "web"], [facets.mail.tool, "mail"], [facets.files.tool, "files"]]);

const context = (lang: Lang): PromptContext => ({ language: lang, persona: defaultPersona(lang), now, playerName: "Alex", state: null, notes: [], summary: "", maxChars: 240, facets: offered, ...(pc ? { computer: { vision: true, browser: false } } : {}) });

const PLACEHOLDER = /consulta breve|short query|words to (?:look|search) for|\bpalabras\b/i;

function classify(message: { content?: string | null; tool_calls?: Array<{ function: { name: string; arguments: string } }> }): { route: Route; detail: string } {
  const text = message.content ?? "";
  const calls = message.tool_calls?.map((call) => ({ name: call.function.name, input: call.function.arguments }))
    ?? toolCallsInText(text, tools.map((tool) => tool.name)).calls.map((call) => ({ name: call.name, input: JSON.stringify(call.input) }));
  const first = calls[0];
  if (first) return { route: routeOf.get(first.name) ?? "computer", detail: `${first.name} ${first.input}` };
  const tag = /\[\s*(?:search|buscar)\s*:\s*([^\]]+)\]/i.exec(text);
  if (tag) return { route: "web", detail: tag[0] };
  return { route: "chat", detail: text.replace(/\s+/g, " ").slice(0, 110) };
}

const tally = { ok: 0, total: 0, byExpect: new Map<string, [number, number]>(), ms: [] as number[] };
for (const lang of ["es", "en"] as const) {
  const system = buildSystemPrompt(context(lang));
  for (const item of cases.filter((candidate) => candidate.lang === lang)) {
    for (let i = 0; i < samples; i++) {
      const started = performance.now();
      const response = await fetch(`${base}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: process.env.MODEL ?? "default",
          messages: [{ role: "system", content: system }, ...history[lang], { role: "user", content: withTurnNote(context(lang), item.text) }],
          tools: tools.map((tool) => ({ type: "function", function: tool })),
          temperature: 0.8,
          max_tokens: 160,
          seed: 1000 + i,
        }),
      });
      if (!response.ok) throw new Error(`${base} answered HTTP ${response.status}: ${(await response.text()).slice(0, 200)}`);
      const body = (await response.json()) as { choices: [{ message: Parameters<typeof classify>[0] }] };
      const ms = performance.now() - started;
      tally.ms.push(ms);
      const { route, detail } = classify(body.choices[0].message);
      const placeholder = PLACEHOLDER.test(detail);
      const ok = item.expect.includes(route) && !placeholder;
      tally.ok += ok ? 1 : 0;
      tally.total += 1;
      const key = item.expect.join("|");
      const slot = tally.byExpect.get(key) ?? [0, 0];
      tally.byExpect.set(key, [slot[0] + (ok ? 1 : 0), slot[1] + 1]);
      console.log(`${ok ? "PASS" : placeholder ? "PLACEHOLDER" : "FAIL"}\t${key}->${route}\t${(ms / 1000).toFixed(1)}s\t${item.text}\t${detail}`);
    }
  }
}

const per = [...tally.byExpect].map(([key, [ok, total]]) => `${key} ${ok}/${total}`).join("  ");
const median = tally.ms.sort((a, b) => a - b)[Math.floor(tally.ms.length / 2)]! / 1000;
console.log(`\nSUMMARY ${pc ? "with" : "without"} PC tools: ${tally.ok}/${tally.total}  ${per}  median ${median.toFixed(1)}s`);
