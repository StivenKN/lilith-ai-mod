import { expect, test } from "bun:test";

// An undefined CSS variable fails silently in the browser (the property just drops), so a theme
// rename can leave a page unstyled with no error anywhere. Every `var(--x)` in the dashboard
// must name a variable declared in styles.css; uses with a fallback (`var(--x, …)`) are optional.
test("every CSS variable the dashboard uses is declared", async () => {
  const styles = await Bun.file(`${import.meta.dir}/styles.css`).text();
  const declared = new Set(Array.from(styles.matchAll(/(--[\w-]+)\s*:/g), ([, name]) => name));

  const undeclared: string[] = [];
  for await (const path of new Bun.Glob("**/*.{css,tsx}").scan(import.meta.dir)) {
    const source = await Bun.file(`${import.meta.dir}/${path}`).text();
    for (const [, name] of source.matchAll(/var\(\s*(--[\w-]+)\s*\)/g)) {
      if (!declared.has(name)) undeclared.push(`${path}: ${name}`);
    }
  }

  expect(undeclared).toEqual([]);
});
