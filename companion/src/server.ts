// Local dashboard server (127.0.0.1 only). The API is a typed RPC table: the web client imports
// `type Api` and gets end-to-end inferred inputs/outputs. Security for a local server that holds
// API keys: Host header check (DNS rebinding), per-run session token in a SameSite=Strict
// cookie, JSON-only POSTs, and keys never returned in full.

import { z } from "zod";
import dashboard from "../web/index.html";
import type { Brain } from "./brain.ts";
import { apiKeyFor, publicConfig, type ConfigStore, type SettingsPatch } from "./config.ts";
import { buildReport } from "./diagnostics.ts";
import { findGameDirs, inspectGame, install, payloadStatus, steamRoots, uninstall } from "./installer.ts";
import { languages } from "./languages.ts";
import { errorMessage, type Logger } from "./log.ts";
import type { Memory } from "./memory.ts";
import type { DataPaths } from "./paths.ts";
import { defaultPersona } from "./prompt.ts";
import { createProvider, ProviderError } from "./providers/index.ts";
import { listOllamaModels, ollamaVersion, pullOllamaModel } from "./providers/ollama.ts";
import { presetIds } from "./providers/presets.ts";

export const APP_NAME = "lilith-ai-companion";
const PORTS = Array.from({ length: 20 }, (_, i) => 47321 + i);
const COOKIE = "lac_session";

export interface AppContext {
  version: string;
  mode: "setup" | "bridge" | "dev";
  config: ConfigStore;
  memory: Memory;
  logger: Logger;
  brain: Brain;
  paths: DataPaths;
  payloadDir: string;
  /** The running exe, copied into the game on install (null when running from source). */
  selfExe: string | null;
  openPath: (path: string) => void;
}

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
  });

  return {
    overview: procedure(none, async () => {
      const snapshot = ctx.brain.snapshot();
      return {
        app: { version: ctx.version, mode: ctx.mode, dataDir: ctx.paths.root, logFile: ctx.paths.logFile, platform: process.platform },
        config: publicConfig(ctx.config.current),
        brain: snapshot,
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

    ollamaStatus: procedure(z.object({ baseUrl: z.string() }), async ({ baseUrl }) => {
      const version = await ollamaVersion(baseUrl);
      return { version, models: version ? await listOllamaModels(baseUrl).catch(() => []) : [] };
    }),

    chat: procedure(z.object({ text: z.string().min(1).max(4000) }), async ({ text }) => ctx.brain.chat(text, "dashboard")),

    history: procedure(none, async () => ctx.memory.history),

    clearHistory: procedure(none, async () => {
      await ctx.memory.clearHistory();
      log.info("conversation history cleared");
      return { ok: true };
    }),

    notes: procedure(none, async () => ctx.memory.notes),

    saveNotes: procedure(z.object({ notes: z.array(z.string()) }), async ({ notes }) => {
      await ctx.memory.setNotes(notes);
      return ctx.memory.notes;
    }),

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
        gameDir: null,
      }),
    })),

    openFolder: procedure(z.object({ which: z.enum(["logs", "data", "game"]) }), async ({ which }) => {
      const target = which === "logs" ? ctx.paths.logs : which === "data" ? ctx.paths.root : ctx.brain.snapshot().hello?.gameDir;
      if (target) ctx.openPath(target);
      return { ok: Boolean(target) };
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

export function startServer(ctx: AppContext): DashboardServer {
  const token = crypto.randomUUID().replace(/-/g, "");
  const procedures = createProcedures(ctx);
  const log = ctx.logger.scope("server");
  let allowedHosts = new Set<string>();

  const hostOk = (request: Request) => allowedHosts.has(request.headers.get("host") ?? "");
  const authed = (request: Request) =>
    hostOk(request) &&
    (request.headers.get("cookie") ?? "").split(/;\s*/).some((pair) => pair === `${COOKIE}=${token}`);
  const deny = (request: Request) =>
    hostOk(request) ? Response.json({ error: "unauthorized" }, { status: 401 }) : new Response("Forbidden host", { status: 403 });

  const routes = {
    "/": dashboard,
    "/api/ping": () => Response.json({ app: APP_NAME, version: ctx.version, mode: ctx.mode }),
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
    "/api/events": (request: Request) => {
      if (!authed(request)) return deny(request);
      let cleanup = () => {};
      const stream = new ReadableStream<string>({
        start(controller) {
          const send = (event: string, data: unknown) => controller.enqueue(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
          const stopLogs = ctx.logger.subscribe((entry) => send("log", entry));
          const stopBrain = ctx.brain.onEvent((event) => send("brain", event));
          const ping = setInterval(() => controller.enqueue(": ping\n\n"), 20_000);
          cleanup = () => {
            stopLogs();
            stopBrain();
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

  for (const port of PORTS) {
    try {
      const server = Bun.serve({
        hostname: "127.0.0.1",
        port,
        // Long enough for a local model's first load during a chat request.
        idleTimeout: 255,
        development: ctx.mode === "dev",
        routes,
        fetch: () => new Response("Not found", { status: 404 }),
      });
      allowedHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
      const loginUrl = `http://127.0.0.1:${port}/?t=${token}`;
      log.info(`dashboard listening on http://127.0.0.1:${port}`);
      return { port, loginUrl, stop: () => void server.stop(true) };
    } catch (error) {
      log.debug(`port ${port} unavailable (${errorMessage(error)})`);
    }
  }
  throw new Error(`No free port for the dashboard (tried ${PORTS[0]}-${PORTS.at(-1)})`);
}
