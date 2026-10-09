import { expect, test } from "bun:test";
import { installedApps, parseApps, START_APPS_COMMAND } from "./apps.ts";

test.skipIf(process.platform !== "win32")("Start app enumeration works under Restricted PowerShell policy", async () => {
  const proc = Bun.spawn(["powershell.exe", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Restricted", "-Command", START_APPS_COMMAND], { windowsHide: true, stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => proc.kill(), 10_000);
  try {
    const [output, errors, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    expect(errors).toBe("");
    expect(code).toBe(0);
    expect(parseApps(output).length).toBeGreaterThan(0);
  } finally { clearTimeout(timer); if (proc.exitCode === null) proc.kill(); }
}, 15_000);

test.skipIf(process.platform !== "win32" || process.arch !== "x64")("Windows desktop binds, captures opaque pixels, and ignores injected input", async () => {
  const { createWindowsDesktop } = await import("./windows.ts");
  const desktop = createWindowsDesktop();
  try {
    expect(desktop.screen.width).toBeGreaterThan(0);
    const png = desktop.capture();
    expect(png[25]).toBe(2);
    expect(await installedApps()).toBeArray();
    // Window titles, enumeration, DWM cloaking and styles all go through bindings only Windows can check.
    expect(desktop.foreground().title).toBeString();
    expect(await desktop.execute({ type: "window", op: "list", title: null }, new AbortController().signal)).toMatch(/^(Open windows, front to back:|No app windows are open\.)/);
    const watch = desktop.watchInput();
    try {
      expect(watch.changed()).toBe(false);
      // Input verification is opt-in on a real PC. CI enables it on its isolated Windows runner.
      if (process.env.LILITH_AI_TEST_INPUT === "1") {
        const cursor = desktop.cursor();
        const target = { x: cursor.x === 0 ? 1 : cursor.x - 1, y: cursor.y };
        try {
          await desktop.execute({ type: "move", at: target }, new AbortController().signal);
          await Bun.sleep(20);
          expect(watch.changed()).toBe(false);
          expect(desktop.cursor()).toEqual(target);
        } finally { await desktop.execute({ type: "move", at: cursor }, new AbortController().signal); }
      }
    } finally { watch.close(); }
  } finally { desktop.close(); }
});
