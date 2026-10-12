import { describe, expect, test } from "bun:test";
import { changesIn } from "./changelog.ts";

const changelog = `# Changelog

What changed in each release.

## Unreleased

## 0.1.0-beta.11 (2026-10-12)

- Eleventh change. (#27)
- Another eleventh change.

## 0.1.0-beta.2 (2026-10-01)

## 0.1.0-beta.1 (2026-09-30)

- First change.
`;

describe("changesIn", () => {
  test("returns the version's lines, stopping before the next heading", () => {
    expect(changesIn(changelog, "0.1.0-beta.11")).toBe("- Eleventh change. (#27)\n- Another eleventh change.");
  });

  test("a version that prefixes another matches only its own heading", () => {
    expect(changesIn(changelog, "0.1.0-beta.1")).toBe("- First change.");
  });

  test("a missing version or an empty section is null", () => {
    expect(changesIn(changelog, "0.1.0-beta.12")).toBeNull();
    expect(changesIn(changelog, "0.1.0-beta.2")).toBeNull();
    expect(changesIn(changelog, "Unreleased")).toBeNull();
  });
});
