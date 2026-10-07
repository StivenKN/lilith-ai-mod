import { expect, test } from "bun:test";
import { resolveLanguage } from "./languages.ts";

test.each([
  ["es", "es"], ["es-419", "es"], ["es_MX", "es"], ["Spanish", "es"], ["Español", "es"],
  ["zh-TW", "zh-Hant"], ["zh-Hant", "zh-Hant"], ["zh-CN", "zh-Hans"], ["zh", "zh-Hans"],
  ["ja-JP", "ja"], ["pt-BR", "pt-BR"], ["Portuguese", "pt-BR"], ["en-US", "en"], ["id", "id"],
] as const)("%s → %s", (raw, expected) => {
  expect(resolveLanguage(raw)).toBe(expected);
});

test("unknown or empty values are not guessed", () => {
  expect(resolveLanguage("")).toBeNull();
  expect(resolveLanguage("klingon")).toBeNull();
});
