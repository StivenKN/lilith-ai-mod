import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { estimateTokens, Memory, parseNoteChanges, parseSummaryLines, relevantNotes, SUMMARY_MAX_LINES, type ContextBudget } from "./memory.ts";

const dirs: string[] = [];
afterAll(async () => {
  for (const dir of dirs) await rm(dir, { recursive: true, force: true });
});

async function path() {
  const dir = await mkdtemp(join(tmpdir(), "lilith-memory-"));
  dirs.push(dir);
  return join(dir, "memory.json");
}

const replies = [
  "Hoy el cielo se ve tranquilo.", "¿Y qué comiste al final?", "Me gusta cuando me cuentas eso.", "La lluvia suena bonita desde aquí.",
  "Seguro que te salió muy bien.", "Mochi debe estar dormida otra vez.", "A veces pienso en el País de las Maravillas.", "Qué rico, arepas con queso.",
  "Te espero aquí, como siempre.", "Ese solo de guitarra es difícil.", "Bogotá suena fría pero linda.",
];

/** Exchanges of about 30 tokens each. */
async function chatted(memory: Memory, exchanges = 10) {
  for (let i = 0; i < exchanges; i++) await memory.addExchange(`mensaje ${i} del anfitrión`, replies[i % replies.length]!, "game");
}

/** Short turns weigh 50 tokens each: a window of 10 turns, summarized past 14 down to 5. */
const tiny: ContextBudget = { window: 500, compactAt: 700, keep: 250 };

describe("Memory", () => {
  test("upgrades a version 1 file: turns get ids, notes stay, and only recent turns wait for a summary", async () => {
    const file = await path();
    const history = Array.from({ length: 100 }, (_, i) => ({ role: i % 2 ? "assistant" : "user", content: `turno ${i}`, at: "2026-10-01T12:00:00.000Z" }));
    await writeFile(file, JSON.stringify({ version: 1, history, notes: ["Se llama Daniel"], userMessagesSinceLearn: 3 }));
    const memory = await Memory.load(file);
    expect(memory.history.map((turn) => turn.id)).toEqual(Array.from({ length: 100 }, (_, i) => i + 1));
    expect(memory.notes).toEqual(["Se llama Daniel"]);
    expect(memory.compaction({ window: 9999, compactAt: 0, keep: 0 })?.turns[0]?.id).toBe(21);
    // The old notes came from these turns already.
    expect(memory.learning(1)).toBeNull();
  });

  test("the model sees the turns after the summary, as many recent ones as fit the window", async () => {
    const memory = await Memory.load(await path());
    await chatted(memory);
    const window = memory.promptTurns(tiny);
    expect(window.at(-1)?.content).toBe(replies[9]);
    expect(window.reduce((sum, turn) => sum + estimateTokens(turn.content), 0)).toBeLessThanOrEqual(tiny.window);
    expect(memory.overdue(tiny)).toBe(true);

    const job = memory.compaction(tiny)!;
    expect(await memory.applySummary(job, ["Daniel contó que es enfermero."])).toBe(true);
    expect(memory.summary).toBe("- Daniel contó que es enfermero.");
    expect(memory.promptTurns({ ...tiny, window: 9999 })[0]?.content).toBe(memory.history.find((turn) => turn.id === job.through + 1)?.content);
  });

  test("compaction waits for the threshold, then folds the oldest turns down to `keep`, ending on her reply", async () => {
    const memory = await Memory.load(await path());
    await chatted(memory, 3);
    expect(memory.compaction(tiny)).toBeNull();
    await chatted(memory, 7);
    const job = memory.compaction(tiny)!;
    expect(job.turns[0]?.id).toBe(1);
    expect(job.turns.at(-1)?.role).toBe("assistant");
    // Five turns' worth stays, plus the player's message that would have split an exchange.
    expect(memory.history.filter((turn) => turn.id > job.through)).toHaveLength(6);
    // Forced (the dashboard's "Summarize now"), it doesn't wait for the threshold.
    const small = await Memory.load(await path());
    await chatted(small, 5);
    expect(small.compaction(tiny)).toBeNull();
    expect(small.compaction(tiny, true)?.turns.length).toBeGreaterThan(0);
  });

  test("work started before the player cleared or edited her memory is thrown away", async () => {
    const memory = await Memory.load(await path());
    await chatted(memory);
    const summary = memory.compaction(tiny)!;
    const notes = memory.learning(1)!;
    await memory.clearHistory();
    expect(await memory.applySummary(summary, ["Daniel contó algo de una conversación borrada."])).toBe(false);
    expect(await memory.applyNoteChanges(notes, { add: ["Le gusta la lluvia"], update: [], remove: [] })).toBeNull();
    expect(memory.summary).toBe("");
    expect(memory.notes).toEqual([]);
  });

  test("the summary keeps its lines and adds new ones, skipping repeats and retiring the oldest when full", async () => {
    const memory = await Memory.load(await path());
    await chatted(memory);
    await memory.applySummary(memory.compaction(tiny, true)!, ["Daniel contó que es enfermero.", "Daniel tiene examen de inglés el lunes."]);
    await chatted(memory, 6);
    await memory.applySummary(memory.compaction(tiny, true)!, ["Daniel contó que es enfermero!", "Daniel prometió contarle cómo le fue."]);
    expect(memory.summary).toBe("- Daniel contó que es enfermero.\n- Daniel tiene examen de inglés el lunes.\n- Daniel prometió contarle cómo le fue.");
    const later = [
      "Fue al cine el sábado con Laura.", "Su hermana se casa en mayo.", "Compró una bicicleta azul.", "Le duele la rodilla izquierda.",
      "Aprobó el examen de manejo.", "Adoptó un loro llamado Kiwi.", "Cocinó lentejas para su abuela.", "Perdió las llaves del carro.",
      "Ganó un torneo de ajedrez.", "Pintó su cuarto de verde.", "Viajó a Cartagena en bus.", "Empezó clases de natación.",
    ];
    for (const line of later) {
      await chatted(memory, 6);
      await memory.applySummary(memory.compaction(tiny, true)!, [line]);
    }
    expect(memory.summary.split("\n")).toHaveLength(SUMMARY_MAX_LINES);
    expect(memory.summary).not.toContain("enfermero");
  });

  test("an exchange that read the player's accounts is replayed in the prompt but never learned, summarized or put on a card", async () => {
    const memory = await Memory.load(await path());
    await memory.addExchange("¿me respondió el casero?", "Sí, dice que el pago del arriendo llegó.", "game", true);
    expect(memory.promptTurns(tiny).map((turn) => turn.content)).toContain("Sí, dice que el pago del arriendo llegó.");
    expect(memory.learning(1)).toBeNull();
    expect(memory.compaction({ ...tiny, keep: 0 }, true)).toMatchObject({ turns: [], through: 2 });
    await memory.addExchange("mi gata se llama Mochi", "Qué nombre tan lindo.", "game");
    const job = memory.learning(1)!;
    expect(job.turns.map((turn) => turn.content)).toEqual(["mi gata se llama Mochi", "Qué nombre tan lindo."]);
    expect(job.through).toBe(4);
    expect(memory.recentUserMessages(8)).toEqual(["mi gata se llama Mochi"]);
    expect(memory.history.filter((turn) => turn.consulted)).toHaveLength(2);
  });

  test("reads the summary lines the model wrote, or that there was nothing worth keeping", () => {
    expect(parseSummaryLines("- Daniel contó que es enfermero.\n- **Daniel** vive en Bogotá desde hace tres años.")).toEqual(["Daniel contó que es enfermero.", "Daniel vive en Bogotá desde hace tres años."]);
    expect(parseSummaryLines("NONE")).toEqual([]);
    expect(parseSummaryLines("ok")).toBeNull();
  });

  test("finds the notes a message is about, matching words by their stem", () => {
    const notes = ["Se llama Daniel", "Trabaja como enfermero en un hospital", "Tiene una gata llamada Mochi", "Quiere irse a trabajar a Canadá el próximo año"];
    expect(relevantNotes(notes, "¿te acuerdas cómo se llama mi gata?")[0]).toBe("Tiene una gata llamada Mochi");
    expect(relevantNotes(notes, "¿a qué país me quiero ir?")).toEqual(["Quiere irse a trabajar a Canadá el próximo año"]);
    expect(relevantNotes(notes, "jaja ok")).toEqual([]);
  });

  test("note changes are checked before they're applied", async () => {
    const memory = await Memory.load(await path());
    await memory.setNotes(["Se llama Daniel", "Tiene examen de inglés el viernes", "Vive en Bogotá", "Tiene una gata llamada Mochi"]);
    await chatted(memory, 4);
    const job = memory.learning(4)!;
    const applied = await memory.applyNoteChanges(job, {
      add: ["- Toca la guitarra", "Se llama Daniel.", "¿Le gusta el café?", "ok"],
      update: [{ number: 2, text: "Tiene examen de inglés el lunes 13 de octubre" }, { number: 9, text: "No existe" }],
      remove: [3, 0],
    });
    expect(applied).toEqual({ added: 1, updated: 1, removed: 1 });
    expect(memory.notes).toEqual(["Se llama Daniel", "Tiene una gata llamada Mochi", "Tiene examen de inglés el lunes 13 de octubre", "Toca la guitarra"]);
    // Those messages were read; a confused pass can't wipe out most of what she knows.
    expect(memory.learning(1)).toBeNull();
    await chatted(memory, 1);
    await memory.applyNoteChanges(memory.learning(1)!, { add: [], update: [], remove: [1, 2, 3] });
    expect(memory.notes).toHaveLength(4);
  });

  test("reads the notes update even when the model wraps it in prose or a code fence", () => {
    expect(parseNoteChanges('Claro:\n```json\n{"add": ["Toca la guitarra"]}\n```')).toEqual({ add: ["Toca la guitarra"], update: [], remove: [] });
    expect(parseNoteChanges("NONE")).toBeNull();
  });
});
