// Local dashboard server (127.0.0.1 only). The API is a typed RPC table: the web client imports
// `type Api` and gets end-to-end inferred inputs/outputs. Security for a local server that holds
// API keys: Host header check (DNS rebinding), per-run session token in a SameSite=Strict
// cookie, JSON-only POSTs, and keys never returned in full.

import { rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import dashboard from "../web/index.html";
import type { Brain } from "./brain.ts";
import type { BrowserHub, SocketData } from "./browser/hub.ts";
import { DASHBOARD_PORTS } from "./browser/shared.ts";
import { apiKeyFor, publicConfig, type ConfigStore, type SettingsPatch } from "./config.ts";
import { buildReport } from "./diagnostics.ts";
import { findGameDirs, inspectGame, install, payloadStatus, steamRoots, uninstall } from "./installer.ts";
import { languages } from "./languages.ts";
import { errorMessage, type Logger } from "./log.ts";
import { MAX_PICTURE_BYTES, type Keepsake, type Keepsakes } from "./keepsakes.ts";
import { SUMMARY_MAX_CHARS, type Memory } from "./memory.ts";
import type { DataPaths } from "./paths.ts";
import { defaultPersona } from "./prompt.ts";
import { createProvider, ProviderError } from "./providers/index.ts";
import { listOllamaModels, ollamaVersion, pullOllamaModel } from "./providers/ollama.ts";
import { presetIds } from "./providers/presets.ts";
import { createSearcher, searchModes } from "./search.ts";
import type { Updater } from "./updater.ts";
import { translator } from "./i18n.ts";
import { isComponentId, voiceIds, voices } from "./voice/catalog.ts";
import { sampleLine, VoiceError, type Voice } from "./voice/index.ts";

export const APP_NAME = "lilith-ai-companion";
const COOKIE = "lac_session";

export interface AppContext {
  version: string;
  mode: "setup" | "bridge" | "dev";
  config: ConfigStore;
  memory: Memory;
  keepsakes: Keepsakes;
  logger: Logger;
  brain: Brain;
  /** The browser extension's connections (served on /api/browser). */
  browser: BrowserHub;
  updater: Updater;
  voice: Voice;
  paths: DataPaths;
  payloadDir: string;
  /** The running exe, copied into the game on install (null when running from source). */
  selfExe: string | null;
  openPath: (path: string) => void;
}

/** Keepsakes as the dashboard sees them: pictures carry the URL of their (authenticated) image. */
const forDashboard = (keepsake: Keepsake) =>
  keepsake.kind === "picture" ? { ...keepsake, url: `/api/pictures/${keepsake.id}.jpg` } : keepsake;
/** Base64 JPEG from the dashboard; the length cap keeps a runaway upload from reaching the disk. */
const PictureUpload = z.base64().max(Math.ceil((MAX_PICTURE_BYTES * 4) / 3) + 4);

const procedure = <S extends z.ZodType, R>(input: S, run: (input: z.output<S>) => Promise<R>) => ({ input, run });
const none = z.object({}).optional();
const ProviderInput = z.object({
  preset: z.enum(presetIds),
  baseUrl: z.string(),
  model: z.string().default(""),
  /** Omitted or empty: use the saved key for this provider. */
  apiKey: z.string().optional(),
});

export function createProcedures(ctx: AppContext) {
  const log = ctx.logger.scope("dashboard");
  const providerSettings = (input: z.output<typeof ProviderInput>) => ({
    preset: input.preset,
    baseUrl: input.baseUrl,
    model: input.model,
    apiKey: input.apiKey?.trim() || apiKeyFor(ctx.config.current, input.preset),
    unloadAfterMinutes: ctx.config.current.advanced.unloadAfterMinutes,
  });

  return {
    overview: procedure(none, async () => {
      const snapshot = ctx.brain.snapshot();
      return {
        app: { version: ctx.version, mode: ctx.mode, dataDir: ctx.paths.root, logFile: ctx.paths.logFile, extensionDir: ctx.paths.browserExtension, platform: process.platform },
        config: publicConfig(ctx.config.current),
        brain: snapshot,
        update: ctx.updater.status,
        languageName: languages[snapshot.replyLanguage].native,
      };
    }),

    saveSettings: procedure(z.custom<SettingsPatch>((value) => typeof value === "object" && value !== null), async (patch) => {
      const next = await ctx.config.update(patch);
      log.info(`settings saved (${Object.keys(patch).join(", ")})`);
      return publicConfig(next);
    }),

    listModels: procedure(ProviderInput, async (input) => {
      try {
        const settings = providerSettings(input);
        const provider = createProvider({ ...settings, model: settings.model || "-" }, (message) => log.warn(message));
        return { ok: true as const, models: await provider.listModels() };
      } catch (error) {
        const detail = ctx.logger.redact(errorMessage(error));
        log.warn(`could not list models for ${input.preset}: ${detail}`);
        return { ok: false as const, kind: error instanceof ProviderError ? error.kind : "internal", detail };
      }
    }),

    testProvider: procedure(ProviderInput, async (input) => ctx.brain.testProvider(providerSettings(input))),

    computerCheck: procedure(none, async () => ctx.brain.computerCheck()),

    /** Runs one search with the given (possibly unsaved) settings, so the player can check them. */
    testSearch: procedure(
      z.object({
        mode: z.enum(searchModes).exclude(["off"]),
        query: z.string().trim().min(1).max(200),
        /** Omitted or empty: use the saved key. */
        apiKey: z.string().optional(),
      }),
      async ({ mode, query, apiKey }) => {
        const started = performance.now();
        try {
          const search = createSearcher({ mode, apiKey: apiKey?.trim() || ctx.config.current.search.apiKey });
          if (!search) return { ok: false as const, detail: "No Firecrawl API key set" };
          const results = await search(query);
          return { ok: true as const, results, latencyMs: Math.round(performance.now() - started) };
        } catch (error) {
          const detail = ctx.logger.redact(errorMessage(error));
          log.warn(`test search (${mode}) failed: ${detail}`);
          return { ok: false as const, detail };
        }
      },
    ),

    ollamaStatus: procedure(z.object({ baseUrl: z.string() }), async ({ baseUrl }) => {
      const version = await ollamaVersion(baseUrl);
      return { version, models: version ? await listOllamaModels(baseUrl).catch(() => []) : [] };
    }),

    chat: procedure(z.object({ text: z.string().min(1).max(4000) }), async ({ text }) => ctx.brain.chat(text, "dashboard")),

    voiceStatus: procedure(none, async () => ({
      ...(await ctx.voice.status()),
      spokenLanguage: ctx.brain.spokenLanguage(),
      lastVoiceError: ctx.brain.lastVoiceError,
    })),

    /** Speaks `text` (or a sample line) with `voice` (or the one for her current language), for the browser to play. */
    speak: procedure(z.object({ text: z.string().min(1).max(2000).optional(), voice: z.enum(voiceIds).optional() }), async (input) => {
      const settings = ctx.config.current.voice;
      const language = input.voice ? voices[input.voice].language : ctx.brain.spokenLanguage();
      if (!language) return { ok: false as const, detail: "no voice for the current reply language" };
      const voice = input.voice ?? (language === "es" ? settings.esVoice : settings.enVoice);
      try {
        const spoken = await ctx.voice.speak(input.text ?? sampleLine[language], { voice, speed: settings.speed, volume: settings.volume });
        return { ok: true as const, url: `/api/voice/audio/${spoken.name}`, seconds: spoken.seconds };
      } catch (error) {
        log.warn(`could not speak in the dashboard: ${errorMessage(error)}`);
        return { ok: false as const, detail: errorMessage(error) };
      }
    }),

    history: procedure(none, async () => ctx.memory.history),

    clearHistory: procedure(none, async () => {
      await ctx.memory.clearHistory();
      log.info("conversation history and its summary cleared");
      return { ok: true };
    }),

    /** What she remembers beyond the recent messages: her notes about the player and the summary of older talk. */
    memory: procedure(none, async () => ({ notes: ctx.memory.notes, summary: ctx.memory.summary })),

    saveNotes: procedure(z.object({ notes: z.array(z.string()) }), async ({ notes }) => {
      await ctx.memory.setNotes(notes);
      return ctx.memory.notes;
    }),

    saveSummary: procedure(z.object({ summary: z.string().max(SUMMARY_MAX_CHARS * 2) }), async ({ summary }) => {
      await ctx.memory.setSummary(summary);
      return ctx.memory.summary;
    }),

    /** Updates the notes and folds all but the recent messages into the summary, now. */
    summarizeNow: procedure(none, async () => ctx.brain.tidyMemory(true)),

    keepsakes: procedure(none, async () => ({
      keepsakes: ctx.keepsakes.list.map(forDashboard),
      cards: ctx.keepsakes.cards,
      canLeaveCards: ctx.brain.canLeaveCards,
    })),

    shareNote: procedure(z.object({ text: z.string().trim().min(1).max(500) }), async ({ text }) => forDashboard(await ctx.brain.shareNote(text))),

    sharePictures: procedure(z.object({ pictures: z.array(PictureUpload).min(1).max(12) }), async ({ pictures }) => {
      const shared = await ctx.brain.sharePictures(pictures.map((data) => Buffer.from(data, "base64")));
      log.info(`${shared.length} picture(s) shared`);
      return shared.map(forDashboard);
    }),

    captionPicture: procedure(z.object({ id: z.string(), caption: z.string().max(300) }), async ({ id, caption }) => {
      const picture = await ctx.keepsakes.describe(id, { caption });
      return picture ? forDashboard(picture) : null;
    }),

    removeKeepsake: procedure(z.object({ id: z.string() }), async ({ id }) => {
      await ctx.keepsakes.remove(id);
      return { ok: true };
    }),

    writeCard: procedure(none, async () => ctx.brain.writeCard("manual")),

    persona: procedure(none, async () => {
      const language = ctx.brain.replyLanguage();
      return { language, builtIn: defaultPersona(language), custom: ctx.config.current.persona.custom };
    }),

    logs: procedure(none, async () => ctx.logger.recent(500)),

    diagnostics: procedure(none, async () => ({
      markdown: await buildReport({
        version: ctx.version,
        mode: ctx.mode,
        config: ctx.config.current,
        brain: ctx.brain,
        logger: ctx.logger,
        update: ctx.updater.status,
        gameDir: null,
        voiceInstalled: (await ctx.voice.status()).installed,
      }),
    })),

    openFolder: procedure(z.object({ which: z.enum(["logs", "data", "game", "extension"]) }), async ({ which }) => {
      const folders = { logs: ctx.paths.logs, data: ctx.paths.root, extension: ctx.paths.browserExtension, game: ctx.brain.snapshot().hello?.gameDir };
      const target = folders[which];
      if (target) ctx.openPath(target);
      return { ok: Boolean(target) };
    }),

    installUpdate: procedure(none, async () => {
      await ctx.updater.install();
      return ctx.updater.status;
    }),

    detectGame: procedure(none, async () => {
      const fromPlugin = ctx.brain.snapshot().hello?.gameDir;
      const candidates = fromPlugin ? [fromPlugin] : await findGameDirs(await steamRoots());
      return {
        candidates,
        payload: await payloadStatus(ctx.payloadDir),
        status: candidates[0] ? await inspectGame(candidates[0]) : null,
      };
    }),

    inspectGame: procedure(z.object({ gameDir: z.string().min(1) }), async ({ gameDir }) => inspectGame(gameDir)),

    install: procedure(z.object({ gameDir: z.string().min(1), disableConflicts: z.boolean() }), async (input) => {
      log.info(`installing into ${input.gameDir}`);
      const result = await install({ ...input, payloadDir: ctx.payloadDir, selfExe: ctx.selfExe });
      for (const step of result.steps) (step.ok ? log.info : log.error)(`install ${step.id}: ${step.detail}`);
      return result;
    }),

    uninstall: procedure(z.object({ gameDir: z.string().min(1), removeBepInEx: z.boolean() }), async (input) => {
      const result = await uninstall(input);
      log.info(`uninstall from ${input.gameDir}: ${result.outcome}`);
      return result;
    }),
  };
}

export type Procedures = ReturnType<typeof createProcedures>;
/** Answer of POST /api/voice/transcribe. */
export type TranscribeResult = { ok: true; text: string } | { ok: false; message: string; detail?: string };
export type Api = {
  [K in keyof Procedures]: {
    input: z.input<Procedures[K]["input"]>;
    output: Awaited<ReturnType<Procedures[K]["run"]>>;
  };
};

export interface DashboardServer {
  port: number;
  /** URL that logs the browser in (contains the one-run session token). */
  loginUrl: string;
  stop: () => void;
}

export async function startServer(ctx: AppContext): Promise<DashboardServer> {
  const token = crypto.randomUUID().replace(/-/g, "");
  const procedures = createProcedures(ctx);
  const log = ctx.logger.scope("server");
  let allowedHosts = new Set<string>();
  let voiceInstall: Promise<void> | null = null;

  const hostOk = (request: Request) => allowedHosts.has(request.headers.get("host") ?? "");
  const authed = (request: Request) =>
    hostOk(request) &&
    (request.headers.get("cookie") ?? "").split(/;\s*/).some((pair) => pair === `${COOKIE}=${token}`);
  const deny = (request: Request) =>
    hostOk(request) ? Response.json({ error: "unauthorized" }, { status: 401 }) : new Response("Forbidden host", { status: 403 });

  const routes = {
    "/": dashboard,
    "/api/ping": () => {
      const computer = ctx.brain.snapshot().computer;
      return Response.json({ app: APP_NAME, version: ctx.version, mode: ctx.mode, desktop: computer.available ? "ok" : computer.reason });
    },
    "/api/session": {
      POST: async (request: Request) => {
        if (!hostOk(request)) return deny(request);
        const body = z.object({ token: z.string() }).safeParse(await request.json().catch(() => null));
        if (!body.success || body.data.token !== token) return Response.json({ error: "invalid token" }, { status: 401 });
        return Response.json(
          { ok: true },
          { headers: { "set-cookie": `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict` } },
        );
      },
    },
    "/api/rpc/:name": {
      POST: async (request: Request & { params: { name: string } }) => {
        if (!authed(request)) return deny(request);
        if (!request.headers.get("content-type")?.includes("application/json")) return new Response("JSON only", { status: 415 });
        const name = request.params.name;
        if (!Object.hasOwn(procedures, name)) return Response.json({ error: `unknown procedure ${name}` }, { status: 404 });
        const entry = procedures[name as keyof Procedures] as { input: z.ZodType; run: (input: unknown) => Promise<unknown> };
        const parsed = entry.input.safeParse(await request.json().catch(() => undefined));
        if (!parsed.success) return Response.json({ error: z.prettifyError(parsed.error) }, { status: 400 });
        try {
          return Response.json((await entry.run(parsed.data)) ?? null);
        } catch (error) {
          log.error(`${name} failed: ${errorMessage(error)}`);
          return Response.json({ error: ctx.logger.redact(errorMessage(error)) }, { status: 500 });
        }
      },
    },
    // Only ids of stored pictures resolve, so nothing outside the keepsakes folder can be served.
    "/api/pictures/:file": async (request: Request & { params: { file: string } }) => {
      if (!authed(request)) return deny(request);
      const keepsake = ctx.keepsakes.get(request.params.file.replace(/\.jpg$/, ""));
      const bytes = keepsake?.kind === "picture" ? await ctx.keepsakes.readPicture(keepsake).catch(() => null) : null;
      if (!bytes) return new Response("Not found", { status: 404 });
      return new Response(new Uint8Array(bytes), { headers: { "content-type": "image/jpeg", "cache-control": "private, max-age=31536000, immutable" } });
    },
    "/api/events": (request: Request) => {
      if (!authed(request)) return deny(request);
      let cleanup = () => {};
      const stream = new ReadableStream<string>({
        start(controller) {
          const send = (event: string, data: unknown) => controller.enqueue(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
          const stopLogs = ctx.logger.subscribe((entry) => send("log", entry));
          const stopBrain = ctx.brain.onEvent((event) => send("brain", event));
          const stopUpdate = ctx.updater.onChange(() => send("update", ctx.updater.status));
          const stopConfig = ctx.config.onChange(() => send("config", null));
          const ping = setInterval(() => controller.enqueue(": ping\n\n"), 20_000);
          cleanup = () => {
            stopLogs();
            stopBrain();
            stopUpdate();
            stopConfig();
            clearInterval(ping);
          };
          request.signal.addEventListener("abort", () => {
            cleanup();
            controller.close();
          });
        },
        cancel: () => cleanup(),
      });
      return new Response(stream, { headers: { "content-type": "text/event-stream", "cache-control": "no-cache" } });
    },
    "/api/voice/install": {
      POST: async (request: Request) => {
        if (!authed(request)) return deny(request);
        const body = z.object({ ids: z.array(z.string().refine(isComponentId)).min(1) }).safeParse(await request.json().catch(() => null));
        if (!body.success) return Response.json({ error: "ids must be voice components" }, { status: 400 });
        if (voiceInstall) return Response.json({ error: "another download is running" }, { status: 409 });
        const ids = body.data.ids.filter(isComponentId);
        const stream = new ReadableStream<string>({
          async start(controller) {
            const write = (data: unknown) => controller.enqueue(`${JSON.stringify(data)}\n`);
            voiceInstall = ctx.voice.install(ids, write, request.signal);
            try {
              await voiceInstall;
              write({ status: "done" });
            } catch (error) {
              log.error(`voice download failed: ${errorMessage(error)}`);
              write({ error: errorMessage(error) });
            } finally {
              voiceInstall = null;
            }
            controller.close();
          },
        });
        return new Response(stream, { headers: { "content-type": "application/x-ndjson" } });
      },
    },
    /** A WAV recorded by the dashboard's microphone button → the text she heard (not sent as chat). */
    "/api/voice/transcribe": {
      POST: async (request: Request) => {
        if (!authed(request)) return deny(request);
        if (request.headers.get("content-type") !== "audio/wav") return new Response("audio/wav only", { status: 415 });
        const audio = new Uint8Array(await request.arrayBuffer());
        if (audio.length > 16 * 1024 * 1024) return new Response("Recording too long", { status: 413 });
        const file = join(tmpdir(), `lilith-dashboard-${crypto.randomUUID()}.wav`);
        await writeFile(file, audio);
        const tr = translator(ctx.brain.uiLocale());
        try {
          const text = await ctx.voice.transcribe(file, { model: ctx.config.current.voice.sttModel, language: ctx.brain.replyLanguage() });
          return Response.json({ ok: true, text } satisfies TranscribeResult);
        } catch (error) {
          const kind = error instanceof VoiceError ? error.kind : "failed";
          log.warn(`dashboard speech recognition failed (${kind}): ${errorMessage(error)}`);
          return Response.json({ ok: false, message: tr(`voice.error.${kind}`), detail: errorMessage(error) } satisfies TranscribeResult);
        } finally {
          await rm(file, { force: true });
        }
      },
    },
    "/api/voice/audio/:name": async (request: Request & { params: { name: string } }) => {
      if (!authed(request)) return deny(request);
      const path = ctx.voice.cachedAudio(request.params.name);
      // Cached files are swept after a few minutes, so a missing one is ordinary.
      if (!path || !(await Bun.file(path).exists())) return new Response("Not found", { status: 404 });
      return new Response(Bun.file(path), { headers: { "content-type": "audio/wav", "cache-control": "no-store" } });
    },
    "/api/ollama/pull": {
      POST: async (request: Request) => {
        if (!authed(request)) return deny(request);
        const body = z.object({ baseUrl: z.string(), model: z.string().min(1) }).safeParse(await request.json().catch(() => null));
        if (!body.success) return Response.json({ error: "baseUrl and model are required" }, { status: 400 });
        const { baseUrl, model } = body.data;
        log.info(`downloading Ollama model ${model}`);
        const stream = new ReadableStream<string>({
          async start(controller) {
            const write = (data: unknown) => controller.enqueue(`${JSON.stringify(data)}\n`);
            try {
              await pullOllamaModel(baseUrl, model, write, request.signal);
              log.info(`Ollama model ${model} downloaded`);
              write({ status: "done" });
            } catch (error) {
              log.error(`Ollama download of ${model} failed: ${errorMessage(error)}`);
              write({ error: errorMessage(error) });
            }
            controller.close();
          },
        });
        return new Response(stream, { headers: { "content-type": "application/x-ndjson" } });
      },
    },
  };

  const { port, server } = await serveOnFreePort(DASHBOARD_PORTS, (port) => Bun.serve<SocketData>({
    hostname: "127.0.0.1",
    port,
    reusePort: false,
    // Long enough for a local model's first load during a chat request.
    idleTimeout: 255,
    development: ctx.mode === "dev",
    routes,
    // The browser extension connects here; its own pairing proof stands in for the session cookie.
    websocket: ctx.browser.websocket,
    fetch: (request, server) => new URL(request.url).pathname === "/api/browser"
      ? ctx.browser.upgrade(request, server, hostOk(request))
      : new Response("Not found", { status: 404 }),
  }), (message) => log.debug(message));
  allowedHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
  log.info(`dashboard listening on http://127.0.0.1:${port}`);
  return { port, loginUrl: `http://127.0.0.1:${port}/?t=${token}`, stop: () => void server.stop(true) };
}

/**
 * Serves on the first port nothing else answers on. Bun can share a port between processes
 * (SO_REUSEPORT on Linux, address reuse on Windows). A second companion, like the setup exe opened
 * while the game runs, then binds the first one's port, and the login link it opens reaches the
 * other process, whose token doesn't match: the dashboard stays locked. So a port that already
 * answers is skipped before binding, whatever the platform's socket options do.
 */
export async function serveOnFreePort<S>(ports: readonly number[], serve: (port: number) => S, log: (message: string) => void): Promise<{ port: number; server: S }> {
  for (const port of ports) {
    if (await answers(port)) {
      log(`port ${port} is in use`);
      continue;
    }
    try { return { port, server: serve(port) }; }
    catch (error) { log(`port ${port} unavailable (${errorMessage(error)})`); }
  }
  throw new Error(`No free port for the dashboard (tried ${ports[0]}-${ports.at(-1)})`);
}

/** Whether a companion (this app, not just anything) serves on this local port. */
export async function companionAt(port: number): Promise<boolean> {
  try {
    const ping = (await (await fetch(`http://127.0.0.1:${port}/api/ping`, { signal: AbortSignal.timeout(1500) })).json()) as { app?: unknown };
    return ping.app === APP_NAME;
  } catch {
    return false;
  }
}

async function answers(port: number): Promise<boolean> {
  try {
    (await Bun.connect({ hostname: "127.0.0.1", port, socket: { data() {} } })).end();
    return true;
  } catch {
    return false;
  }
}
