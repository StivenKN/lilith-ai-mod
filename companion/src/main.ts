// Entry point. One executable, two modes:
//   (no args)  setup: double-clicked by the player; opens the setup wizard in the browser.
//   --bridge   brain: launched by the game plugin; speaks JSON lines on stdin/stdout.
// Flags: --dev (hot reload, from source), --no-open (don't launch a browser).

import { rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { AccountStore } from "./accounts/store.ts";
import { Brain } from "./brain.ts";
import { extensionFiles } from "./browser/embedded.ts";
import { BrowserHub } from "./browser/hub.ts";
import { installExtension, listCompanion } from "./browser/install.ts";
import { randomHex } from "./browser/shared.ts";
import { startBridge } from "./bridge.ts";
import { ConfigStore, readTextFile, writeAtomic } from "./config.ts";
import { Keepsakes } from "./keepsakes.ts";
import { errorMessage, Logger } from "./log.ts";
import { Memory } from "./memory.ts";
import { dataPaths } from "./paths.ts";
import { openPath as openWithDefaultHandler } from "./open.ts";
import type { CompanionMessage } from "./protocol.ts";
import { APP_NAME, companionAt, startServer, type AppContext } from "./server.ts";
import { Updater } from "./updater.ts";
import { Voice } from "./voice/index.ts";
import pkg from "../package.json" with { type: "json" };

const args = new Set(process.argv.slice(2));
const mode: AppContext["mode"] = args.has("--bridge") ? "bridge" : args.has("--dev") ? "dev" : "setup";
const VERSION = pkg.version;
const paths = dataPaths();
const logger = new Logger(paths.logFile);
const log = logger.scope("main");

if (mode === "bridge") {
  // stdout belongs to the protocol: anything printed must go to the log instead.
  const toLog = (level: "info" | "warn" | "error") => (...values: unknown[]) => logger.write(level, "console", values.map(String).join(" "));
  console.log = console.info = console.debug = toLog("info");
  console.warn = toLog("warn");
  console.error = toLog("error");
}
process.on("uncaughtException", (error) => log.error(`uncaught: ${errorMessage(error)}\n${error.stack ?? ""}`));
process.on("unhandledRejection", (reason) => log.error(`unhandled rejection: ${errorMessage(reason)}`));

/** Opens a URL or folder with the OS default handler. */
function openPath(target: string): void {
  try {
    // Never `windowsHide` here: rundll32/explorer are GUI programs (no console flash), and a hidden
    // launch is passed on to the browser they start, which then opens invisible.
    openWithDefaultHandler(target);
    log.info(`opened ${target}`);
  } catch (error) {
    log.warn(`could not open ${target}: ${errorMessage(error)}`);
  }
}

/** If another instance already serves the dashboard, open it there instead of starting twice. */
async function handOffToRunningInstance(): Promise<boolean> {
  try {
    const text = await readTextFile(paths.instance);
    if (text === null) return false;
    const instance = JSON.parse(text) as { pid: number; port: number; loginUrl: string };
    process.kill(instance.pid, 0);
    const ping = (await (await fetch(`http://127.0.0.1:${instance.port}/api/ping`, { signal: AbortSignal.timeout(1500) })).json()) as { app?: string };
    if (ping.app !== APP_NAME) return false;
    log.info(`another instance (pid ${instance.pid}) is running; opening its dashboard`);
    openPath(instance.loginUrl);
    return true;
  } catch {
    return false;
  }
}

async function main(): Promise<void> {
  log.info(`Lilith AI Companion ${VERSION} starting (${mode}, ${process.platform}, Bun ${Bun.version})`);
  if (mode === "setup" && (await handOffToRunningInstance())) {
    console.log("Lilith AI Companion ya está abierto: abrí su panel en tu navegador. / Already running: opened its dashboard.");
    await Bun.sleep(3000);
    process.exit(0);
  }

  log.info("loading settings, memory and keepsakes");
  const config = await ConfigStore.load(paths.config, (message) => log.warn(message));
  await config.watch(logger.scope("config"));
  const memory = await Memory.load(paths.memory, (message) => log.warn(message));
  const keepsakes = await Keepsakes.load(paths.keepsakes, paths.pictures, (message) => log.warn(message));
  const accounts = await AccountStore.load(paths.accounts, logger.scope("accounts"), (secret) => logger.addSecret(secret));
  accounts.watch();
  const voice = new Voice(paths.voice, logger.scope("voice"));
  // The extension folder the player loads in their browser, kept current. Without it she just has no browser tool.
  const pairing = await installExtension(paths.browserExtension, VERSION, extensionFiles, logger.scope("browser"), mode === "dev")
    .catch((error: unknown) => { log.warn(`could not write the browser extension: ${errorMessage(error)}`); return null; });
  const browser = new BrowserHub({ secret: pairing?.secret ?? randomHex(32), version: VERSION, log: logger.scope("browser") });

  let bridge: { send: (message: CompanionMessage) => void } | null = null;
  let dashboardUrl = "";
  const brain = new Brain({
    version: VERSION,
    config,
    memory,
    keepsakes,
    logger,
    voice,
    send: (message) => bridge?.send(message),
    dashboardUrl: () => dashboardUrl,
    openDashboard: () => openPath(dashboardUrl),
    onFatal: (reason) => shutdown(2, reason),
    systemLocale: Intl.DateTimeFormat().resolvedOptions().locale,
    browser,
    accounts,
  });

  const exeDir = dirname(process.execPath);
  // Only the copy the game launches (inside the game folder) replaces itself; the setup exe just reports new versions.
  const updater = new Updater({
    version: VERSION,
    modDir: mode === "bridge" && Bun.isStandaloneExecutable ? exeDir : null,
    downloadDir: join(paths.root, "updates"),
    autoInstall: () => config.current.features.autoUpdate,
    log: logger.scope("update"),
  });
  const server = await startServer({
    version: VERSION,
    mode,
    config,
    memory,
    keepsakes,
    accounts,
    logger,
    brain,
    browser,
    updater,
    voice,
    paths,
    payloadDir: process.env.LILITH_AI_PAYLOAD_DIR ?? join(exeDir, "payload"),
    selfExe: Bun.isStandaloneExecutable ? process.execPath : null,
    openPath,
  });
  dashboardUrl = server.loginUrl;
  await writeAtomic(paths.instance, JSON.stringify({ pid: process.pid, port: server.port, loginUrl: server.loginUrl, mode }));
  // Where the browser extension finds this companion.
  const listInExtension = (leaving = false) => listCompanion(paths.browserExtension, server.port, companionAt, leaving)
    .catch((error: unknown) => log.warn(`could not list this companion for the browser extension: ${errorMessage(error)}`));
  await listInExtension();
  const relist = setInterval(() => void listInExtension(), 60_000);
  brain.start();
  if (mode !== "dev") updater.start(mode === "setup" ? 0 : undefined);

  async function shutdown(code: number, reason: string): Promise<never> {
    log.info(`shutting down: ${reason}`);
    clearInterval(relist);
    await listInExtension(true);
    await brain.stop();
    updater.stop();
    config.close();
    accounts.close();
    server.stop();
    await rm(paths.instance, { force: true });
    process.exit(code);
  }
  process.on("SIGINT", () => void shutdown(0, "interrupted"));
  process.on("SIGTERM", () => void shutdown(0, "terminated"));

  if (mode === "bridge") {
    bridge = startBridge({
      onMessage: (message) => brain.handlePluginMessage(message),
      onClose: () => void brain.pluginDisconnected().finally(() => shutdown(0, "game closed the connection")),
      log: logger.scope("bridge"),
    });
    return;
  }

  console.log(
    [
      "",
      `  Lilith AI Companion ${VERSION}`,
      "  ─────────────────────────────────────────────",
      "  ES  La configuración se abrió en tu navegador. Si no aparece, abre:",
      "  EN  Setup opened in your browser. If it didn't, open:",
      "",
      `      ${server.loginUrl}`,
      "",
      "  ES  Cierra esta ventana para salir.   EN  Close this window to exit.",
      `      Log: ${paths.logFile}`,
      "",
    ].join("\n"),
  );
  if (!args.has("--no-open")) openPath(server.loginUrl);
}

main().catch((error: unknown) => {
  log.error(`fatal: ${errorMessage(error)}`);
  console.error(`Lilith AI Companion could not start: ${errorMessage(error)}\nLog: ${paths.logFile}`);
  // Double-clicked: keep the window open so the message can be read.
  if (mode === "setup") prompt("Pulsa Enter para cerrar / Press Enter to close");
  process.exit(1);
});
