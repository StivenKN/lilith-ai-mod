import { describe, expect, test } from "bun:test";
import { isRepeat, paginate, parseReply, repeatedSentences, splitSentences, textWidth, truncate, withoutSentences, wrapLines } from "./reply.ts";

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

describe("repeatedSentences", () => {
  test("catches the closing question a small model tacks onto every reply", () => {
    const previous = ["Me encanta que lo hiciéramos juntos. ¿Te gustaría que lo hiciéramos juntos?", "Mi animal favorito es el perro. ¿Te gustan los animales?"];
    const reply = "¡Qué bueno! Los perros son muy leales. ¿Te gustaría que lo hiciéramos juntos?";
    expect(repeatedSentences(reply, previous)).toEqual(["¿Te gustaría que lo hiciéramos juntos?"]);
    expect(withoutSentences(reply, ["¿Te gustaría que lo hiciéramos juntos?"])).toBe("¡Qué bueno! Los perros son muy leales.");
  });

  test("catches a catchphrase that comes back with a word or two changed, but not common openings", () => {
    const previous = ["¿Quieres que te cuente una historia… o que te acompañe a dormir?", "¿Cómo te fue en el trabajo hoy?"];
    expect(repeatedSentences("Entiendo. ¿Quieres que te cuente algo… o que te acompañe a dormir?", previous)).toEqual(["¿Quieres que te cuente algo… o que te acompañe a dormir?"]);
    expect(repeatedSentences("¿Cómo te fue en el examen de inglés?", previous)).toEqual([]);
  });

  test("catches a sentence said twice in one reply, but lets short interjections come back", () => {
    expect(repeatedSentences("Me quedo aquí contigo un ratito. Me quedo aquí contigo un ratito más.", [])).toEqual(["Me quedo aquí contigo un ratito más."]);
    expect(repeatedSentences("¡Qué bueno! Hoy llueve en la ciudad.", ["¡Qué bueno! Me alegra mucho."])).toEqual([]);
  });

  test("splits after full stops and CJK punctuation, but not after an ellipsis", () => {
    expect(splitSentences("Hmm... no sé. ¿Quieres? O… ¿qué te gusta más?")).toEqual(["Hmm... no sé.", "¿Quieres?", "O… ¿qué te gusta más?"]);
    expect(splitSentences("今天下雨了。你还好吗？")).toEqual(["今天下雨了。", "你还好吗？"]);
  });
});
