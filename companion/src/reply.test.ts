import { describe, expect, test } from "bun:test";
import { isRepeat, paginate, parseReply, textWidth, truncate, wrapLines } from "./reply.ts";

describe("parseReply", () => {
  test("reads a Spanish emotion tag and keeps Spanish punctuation intact", () => {
    const reply = parseReply("[feliz] ¿De verdad? ¡Qué alegría, pingüino! Mañana hacemos pastel de fresa.", 240);
    expect(reply.emotion).toBe("happy");
    expect(reply.text).toBe("¿De verdad? ¡Qué alegría, pingüino! Mañana hacemos pastel de fresa.");
  });

  test("accepts accent-less and English tags anywhere, removing them from the text", () => {
    expect(parseReply("Hmm… [timida] no me mires así.", 240)).toMatchObject({ emotion: "shy", text: "Hmm… no me mires así." });
    expect(parseReply("(Surprised) Oh!", 240)).toMatchObject({ emotion: "surprised", text: "Oh!" });
  });

  test("strips reasoning blocks, including ones whose opening tag was eaten", () => {
    expect(parseReply("<think>debo ser breve</think>[triste] Te extrañé.", 240)).toMatchObject({ emotion: "sad", text: "Te extrañé." });
    expect(parseReply("razonando...</think>Hola de nuevo.", 240).text).toBe("Hola de nuevo.");
  });

  test("flags replies that only contain reasoning", () => {
    expect(parseReply("<think>pensando sin parar", 240)).toMatchObject({ text: "", reasoningOnly: true });
  });

  test("removes markdown, stage directions, emoji, name prefixes and wrapping quotes", () => {
    const reply = parseReply('Lilith: "*sonríe* **Claro** que sí 🍓✨, ¿vamos?"', 240);
    expect(reply.text).toBe("Claro que sí, ¿vamos?");
  });

  test("keeps unknown bracketed text that is part of the sentence", () => {
    expect(parseReply("Me gusta (como a ti) el silencio.", 240).text).toBe("Me gusta (como a ti) el silencio.");
  });
});

describe("truncate", () => {
  test("cuts at the last sentence end when it's past the halfway point", () => {
    expect(truncate("Hola. ¿Cómo estás hoy? Yo bien, gracias por preguntar siempre.", 30)).toBe("Hola. ¿Cómo estás hoy?");
  });

  test("falls back to a word boundary with an ellipsis", () => {
    expect(truncate("una frase muy larga sin puntos que sigue y sigue", 20)).toBe("una frase muy larga…");
  });
});

describe("wrapping and paging", () => {
  test("counts CJK as double width", () => {
    expect(textWidth("ñandú")).toBe(5);
    expect(textWidth("莉莉丝")).toBe(6);
  });

  test("wraps Spanish at word boundaries without exceeding the width", () => {
    const lines = wrapLines("¿Sabes? A veces me pregunto si los recuerdos también sueñan con nosotros.", 20);
    for (const line of lines) expect(textWidth(line)).toBeLessThanOrEqual(20);
    expect(lines.join(" ")).toBe("¿Sabes? A veces me pregunto si los recuerdos también sueñan con nosotros.");
  });

  test("breaks CJK anywhere", () => {
    expect(wrapLines("我想和你一起吃草莓蛋糕", 8)).toEqual(["我想和你", "一起吃草", "莓蛋糕"]);
  });

  test("groups lines into pages with bounded reading times", () => {
    const pages = paginate("uno dos tres cuatro cinco seis siete ocho nueve diez once doce", 10, 2);
    expect(pages.length).toBeGreaterThan(1);
    for (const page of pages) {
      expect(page.text.split("\n").length).toBeLessThanOrEqual(2);
      expect(page.seconds).toBeGreaterThanOrEqual(3);
      expect(page.seconds).toBeLessThanOrEqual(12);
    }
  });
});

describe("isRepeat", () => {
  test("catches near-identical replies but not different ones", () => {
    const previous = ["¿Sabías que el pastel de fresa es mi favorito?"];
    expect(isRepeat("¿Sabías que el pastel de fresa es mi favorito!", previous)).toBe(true);
    expect(isRepeat("Hoy el cielo se ve tranquilo, ¿no crees?", previous)).toBe(false);
  });
});
