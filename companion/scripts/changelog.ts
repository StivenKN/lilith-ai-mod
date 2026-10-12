// Reads one version's changes from CHANGELOG.md, for the release notes (scripts/release.ts).
//
//   bun scripts/changelog.ts    prints this package.json version's changes, or fails when there are none
//
// The release workflow runs it before building, so a release without changelog lines fails early.

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import pkg from "../package.json" with { type: "json" };

/** The lines under `## <version> ...` up to the next `## ` heading, trimmed; null when missing or empty. */
export function changesIn(changelog: string, version: string): string | null {
  const section = changelog.split(/^## /m).slice(1).find((section) => section.split(/\s/, 1)[0] === version);
  return section?.replace(/^.*/, "").trim() || null;
}

if (import.meta.main) {
  const changes = changesIn(await readFile(resolve("..", "CHANGELOG.md"), "utf8"), pkg.version);
  if (!changes) {
    console.error(`::error title=Changelog missing::CHANGELOG.md has no changes under "## ${pkg.version}". Move the Unreleased lines under a "## ${pkg.version} (<date>)" heading.`);
    process.exit(1);
  }
  console.log(changes);
}
