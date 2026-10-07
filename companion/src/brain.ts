// Orchestrates conversations: one turn at a time, thinking indicator, explicit timeouts, the
// empty-reply and repetition retries, bubble paging, and plain-language errors that always
// reach the player (in the bubble and the chat window) instead of a stock in-character line.

import type { ConfigStore } from "./config.ts";
import { apiKeyFor } from "./config.ts";
import { translator, type Translate } from "./i18n.ts";
import { resolveLanguage, uiLocaleFor, type Language, type UiLocale } from "./languages.ts";
import type { Log, Logger } from "./log.ts";
import { errorMessage } from "./log.ts";
import type { Memory, StoredTurn } from "./memory.ts";
import { avoidRepeatCue, buildSystemPrompt, defaultPersona, learnFactsPrompt, speakFirstCue } from "./prompt.ts";
import { createProvider, isLocalProvider, ProviderError, type ErrorKind, type Provider } from "./providers/index.ts";
import type { ProviderSettings } from "./providers/index.ts";
import { isOllamaModelLoaded, warmUpOllama } from "./providers/ollama.ts";
import { getPreset } from "./providers/presets.ts";
import { PROTOCOL_VERSION, type CompanionMessage, type Emotion, type GameState, type HelloMessage, type PluginMessage } from "./protocol.ts";
import { isRepeat, paginate, parseReply } from "./reply.ts";

const MAX_TOKENS = 1024;
const RETRY_MAX_TOKENS = 4096;
const LEARN_EVERY = 6;

export type TurnFailure = { kind: ErrorKind | "internal"; message: string; detail: string };
export type TurnResult =
  | { ok: true; text: string; emotion: Emotion; latencyMs: number; model: string }
  | { ok: false; error: TurnFailure };

export interface BrainOptions {
  version: string;
  config: ConfigStore;
  memory: Memory;
  logger: Logger;
  /** Sends a message to the plugin (no-op when the game isn't attached). */
  send: (message: CompanionMessage) => void;
  dashboardUrl: () => string;
  openDashboard: () => void;
  /** Called when the plugin speaks an incompatible protocol version. */
  onFatal: (reason: string) => void;
  systemLocale?: string;
}

export interface BrainEvent {
  type: "plugin" | "turn" | "error";
}

export class Brain {
  readonly #log: Log;
  #hello: HelloMessage | null = null;
  #connected = false;
  #state: GameState | null = null;
  #queue: Promise<unknown> = Promise.resolve();
  #turnActive = false;
  #pagingToken = 0;
  #lastActivity = Date.now();
  #warm = new Set<string>();
  #openedSetup = false;
  #speakFirstTimer: ReturnType<typeof setInterval> | null = null;
  #listeners = new Set<(event: BrainEvent) => void>();
  lastError: (TurnFailure & { at: string }) | null = null;
  lastTurn: { at: string; latencyMs: number; model: string } | null = null;

  constructor(private readonly options: BrainOptions) {
    this.#log = options.logger.scope("brain");
    options.config.onChange(() => {
      if (this.#connected) this.#sendReady();
      this.#registerSecrets();
    });
    this.#registerSecrets();
  }

  start(): void {
    this.#speakFirstTimer = setInterval(() => this.#maybeSpeakFirst(), 60_000);
  }

  stop(): void {
    if (this.#speakFirstTimer) clearInterval(this.#speakFirstTimer);
  }

  onEvent(listener: (event: BrainEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  // ── Plugin side ────────────────────────────────────────────────────────────

  handlePluginMessage(message: PluginMessage): void {
    switch (message.type) {
      case "hello":
        return this.#onHello(message);
      case "state": {
        const { type: _, ...state } = message;
        const languageChanged = state.langRaw !== this.#state?.langRaw;
        if (state.interacting) this.#lastActivity = Date.now();
        this.#state = state;
        if (languageChanged && this.#connected) this.#sendReady();
        return;
      }
      case "chat":
        void this.chat(message.text, "game");
        return;
      case "action":
        this.options.openDashboard();
        return;
      case "result":
        if (!message.ok) this.#log.warn(`plugin could not show message ${message.id}: ${message.error ?? "unknown reason"}`);
        return;
      case "log":
        this.options.logger.write(message.level, "plugin", message.msg);
        return;
    }
  }

  pluginDisconnected(): void {
    this.#connected = false;
    this.#emit({ type: "plugin" });
  }

  #onHello(hello: HelloMessage): void {
    if (hello.v !== PROTOCOL_VERSION) {
      this.#log.error(`plugin speaks protocol v${hello.v}, companion speaks v${PROTOCOL_VERSION}: update both parts`);
      this.options.onFatal("protocol version mismatch");
      return;
    }
    this.#hello = hello;
    this.#connected = true;
    this.#log.info(
      `plugin ${hello.pluginVersion} connected (game ${hello.gameVersion}, Unity ${hello.unityVersion}, BepInEx ${hello.bepinexVersion})`,
    );
    for (const [name, status] of Object.entries(hello.caps)) {
      if (status === "ok") this.#log.info(`capability ${name}: ok`);
      else this.#log.warn(`capability ${name}: unavailable (${status})`);
    }
    this.#sendReady();
    this.#emit({ type: "plugin" });

    const { provider } = this.options.config.current;
    if (!provider.configured && !this.#openedSetup) {
      this.#openedSetup = true;
      this.#log.info("no AI provider configured yet; opening the setup page");
      this.options.openDashboard();
    } else if (provider.preset === "ollama" && provider.model) {
      this.#log.info(`warming up Ollama model ${provider.model}`);
      warmUpOllama(provider.baseUrl, provider.model).then(
        () => this.#log.info(`Ollama model ${provider.model} is loaded`),
        (error: unknown) => this.#log.warn(`could not warm up Ollama: ${errorMessage(error)}`),
      );
    }
  }

  #sendReady(): void {
    const tr = translator(this.uiLocale());
    const { hotkey } = this.options.config.current;
    this.options.send({
      type: "ready",
      v: PROTOCOL_VERSION,
      version: this.options.version,
      dashboardUrl: this.options.dashboardUrl(),
      hotkey,
      strings: {
        placeholder: tr("plugin.placeholder"),
        thinking: tr("plugin.thinking"),
        send: tr("plugin.send"),
        settings: tr("plugin.settings"),
        trayTalk: tr("plugin.trayTalk"),
        traySettings: tr("plugin.traySettings"),
      },
    });
  }

  // ── Languages ──────────────────────────────────────────────────────────────

  /** Explicit setting, else the game's language, else the dashboard language the player picked, else the OS. */
  replyLanguage(): Language {
    const { replyLanguage, uiLanguage } = this.options.config.current;
    if (replyLanguage !== "auto") return replyLanguage;
    return (
      resolveLanguage(this.#state?.langRaw) ??
      (uiLanguage !== "auto" ? uiLanguage : null) ??
      resolveLanguage(this.options.systemLocale) ??
      "en"
    );
  }

  uiLocale(): UiLocale {
    const setting = this.options.config.current.uiLanguage;
    return setting === "auto" ? uiLocaleFor(this.replyLanguage()) : setting;
  }

  // ── Conversation ───────────────────────────────────────────────────────────

  /** Queues a user message. Resolves with Lilith's reply or a classified, localized error. */
  chat(text: string, source: StoredTurn["source"]): Promise<TurnResult> {
    this.#lastActivity = Date.now();
    return this.#enqueue(() => this.#runTurn({ user: text.trim(), source }));
  }

  /** One-off check from the dashboard: a real persona prompt, nothing stored or shown in game. */
  async testProvider(settings: ProviderSettings): Promise<TurnResult> {
    const started = performance.now();
    const language = this.replyLanguage();
    try {
      const provider = createProvider(settings, (message) => this.#log.warn(message));
      const { text, emotion, model } = await this.#ask(provider, settings, language, [
        { role: "user", content: language === "es" ? "Hola, Lilith. ¿Me escuchas?" : "Hi Lilith. Can you hear me?" },
      ]);
      return { ok: true, text, emotion, model, latencyMs: Math.round(performance.now() - started) };
    } catch (error) {
      const failure = this.#describe(error, settings);
      this.#log.warn(`provider test failed: ${failure.kind}: ${failure.detail}`);
      return { ok: false, error: failure };
    }
  }

  #enqueue<T>(run: () => Promise<T>): Promise<T> {
    const result = this.#queue.then(run, run);
    this.#queue = result.catch(() => {});
    return result;
  }

  get busy(): boolean {
    return this.#turnActive;
  }

  async #runTurn(input: { user: string | null; source: StoredTurn["source"]; idleMinutes?: number }): Promise<TurnResult> {
    const config = this.options.config.current;
    const settings = this.#providerSettings();
    const tr = translator(this.uiLocale());
    const speakFirst = input.user === null;
    const inGame = this.#connected;
    const started = performance.now();
    this.#turnActive = true;
    this.#pagingToken++;

    if (!speakFirst) {
      this.options.send({ type: "chatStatus", kind: "thinking", text: tr("plugin.thinking") });
      if (inGame) this.#say("…", "neutral", 120);
    }
    const escalation = this.#escalateWhileWaiting(settings, tr, started, !speakFirst);

    try {
      const language = this.replyLanguage();
      const provider = createProvider(settings, (message) => this.#log.warn(message));
      const userTurn = input.user ?? speakFirstCue(language, Math.round(input.idleMinutes ?? 0));
      const { text, emotion, model } = await this.#ask(provider, settings, language, [
        ...this.options.memory.promptTurns(),
        { role: "user", content: userTurn },
      ]);
      const latencyMs = Math.round(performance.now() - started);
      const stored = await this.options.memory.addExchange(input.user, text, input.source);
      if (!stored) this.#log.info("reply was still a near-repeat; shown, but kept out of her context");
      this.#log.info(`reply in ${latencyMs} ms from ${model} (${input.source})`);

      this.lastTurn = { at: new Date().toISOString(), latencyMs, model };
      this.options.send({ type: "chatStatus", kind: "idle", text });
      if (inGame) void this.#showPages(text, emotion, speakFirst);
      this.#emit({ type: "turn" });

      if (config.features.learnFacts && this.options.memory.pendingForLearning >= LEARN_EVERY) {
        void this.#enqueue(() => this.#learnFacts(provider, settings, language));
      }
      return { ok: true, text, emotion, latencyMs, model };
    } catch (error) {
      const failure = this.#describe(error, settings);
      this.#log.error(`${speakFirst ? "speak-first" : "reply"} failed: ${failure.kind}: ${failure.detail}`);
      this.lastError = { ...failure, at: new Date().toISOString() };
      if (!speakFirst) {
        this.options.send({ type: "chatStatus", kind: "error", text: failure.message });
        if (inGame) this.#say(`${tr("bubble.errorPrefix")}${failure.message}`, "sad", 10);
      }
      this.#emit({ type: "error" });
      return { ok: false, error: failure };
    } finally {
      clearInterval(escalation);
      this.#turnActive = false;
    }
  }

  /** Calls the model and shapes the answer, with one retry each for empty and repeated replies. */
  async #ask(provider: Provider, settings: ProviderSettings, language: Language, turns: Parameters<Provider["chat"]>[0]["turns"]) {
    const config = this.options.config.current;
    const system = buildSystemPrompt({
      language,
      persona: config.persona.custom?.trim() || defaultPersona(language),
      now: new Date(),
      playerName: this.#state?.playerName ?? "",
      state: this.#state,
      notes: this.options.memory.notes,
      maxChars: config.advanced.maxReplyChars,
    });
    const request = {
      system,
      turns,
      maxTokens: MAX_TOKENS,
      temperature: config.advanced.temperature,
      timeoutMs: await this.#timeoutFor(settings),
    };

    let result = await provider.chat(request);
    let reply = parseReply(result.text, config.advanced.maxReplyChars);
    if (!reply.text) {
      this.#log.warn(`empty reply (finish: ${result.finish}, reasoning: ${result.reasoning.length} chars); retrying with a larger budget`);
      result = await provider.chat({ ...request, maxTokens: RETRY_MAX_TOKENS });
      reply = parseReply(result.text, config.advanced.maxReplyChars);
      if (!reply.text) throw new ProviderError("empty_reply", `No visible text after retry (finish: ${result.finish})`);
    }
    if (isRepeat(reply.text, this.options.memory.recentReplies())) {
      this.#log.info("near-duplicate reply; asking once for something new");
      const retry = parseReply((await provider.chat({ ...request, system: system + avoidRepeatCue(language) })).text, config.advanced.maxReplyChars);
      if (retry.text) reply = retry;
    }
    this.#warm.add(warmKey(settings));
    return { text: reply.text, emotion: reply.emotion, model: result.model };
  }

  async #timeoutFor(settings: ProviderSettings): Promise<number> {
    const override = this.options.config.current.advanced.timeoutSeconds;
    if (override) return override * 1000;
    if (!isLocalProvider(settings)) return 60_000;
    const warm =
      getPreset(settings.preset).kind === "ollama"
        ? await isOllamaModelLoaded(settings.baseUrl, settings.model)
        : this.#warm.has(warmKey(settings));
    return warm ? 60_000 : 180_000;
  }

  /** Keeps the player informed during slow replies (e.g. a local model loading). */
  #escalateWhileWaiting(settings: ProviderSettings, tr: Translate, started: number, visible: boolean) {
    const local = isLocalProvider(settings);
    return setInterval(() => {
      if (!visible) return;
      const seconds = Math.round((performance.now() - started) / 1000);
      const text = local && !this.#warm.has(warmKey(settings)) ? tr("status.loadingModel") : tr("status.stillThinking", { seconds });
      this.options.send({ type: "chatStatus", kind: "thinking", text });
    }, 8_000);
  }

  async #showPages(text: string, emotion: Emotion, ambient: boolean): Promise<void> {
    const token = ++this.#pagingToken;
    const { bubbleLineUnits, bubbleLines } = this.options.config.current.advanced;
    const pages = paginate(text, bubbleLineUnits, bubbleLines);
    for (const [index, page] of pages.entries()) {
      if (token !== this.#pagingToken) return; // a newer turn took over the bubble
      if (ambient && index === 0 && this.#state?.busy) {
        this.#log.info("speak-first remark dropped: Lilith is busy");
        return;
      }
      const last = index === pages.length - 1;
      this.#say(page.text, emotion, page.seconds + (last ? 2 : 0.5));
      if (!last) await Bun.sleep(page.seconds * 1000);
    }
  }

  #say(text: string, emotion: Emotion, seconds: number): void {
    this.options.send({ type: "say", id: crypto.randomUUID().slice(0, 8), text, emotion, seconds: Math.round(seconds * 10) / 10 });
  }

  #maybeSpeakFirst(): void {
    const config = this.options.config.current;
    const { speakFirst, speakFirstMinutes } = config.features;
    const state = this.#state;
    if (!speakFirst || !this.#connected || !config.provider.configured || this.#turnActive || !state) return;
    if (state.sleep || state.busy || state.drag || state.interacting) return;
    const idleMinutes = (Date.now() - this.#lastActivity) / 60_000;
    if (idleMinutes < speakFirstMinutes || Math.random() < 0.5) return;
    this.#lastActivity = Date.now();
    void this.#enqueue(() => this.#runTurn({ user: null, source: "speakFirst", idleMinutes }));
  }

  async #learnFacts(provider: Provider, settings: ProviderSettings, language: Language): Promise<void> {
    try {
      const messages = this.options.memory.recentUserMessages(12);
      const result = await provider.chat({
        system: learnFactsPrompt(language, this.options.memory.notes),
        turns: [{ role: "user", content: messages.map((message) => `- ${message}`).join("\n") }],
        maxTokens: 600,
        temperature: 0.2,
        timeoutMs: await this.#timeoutFor(settings),
      });
      const facts = result.text
        .replace(/<think(ing)?>[\s\S]*?<\/think(ing)?>/gi, "")
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.startsWith("-"))
        .map((line) => line.replace(/^-\s*/, ""));
      const added = await this.options.memory.addNotes(facts);
      if (added.length > 0) this.#log.info(`learned ${added.length} new note(s) about the player`);
    } catch (error) {
      this.#log.warn(`could not update notes: ${errorMessage(error)}`);
    }
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  #providerSettings(): ProviderSettings {
    const { provider } = this.options.config.current;
    return { preset: provider.preset, baseUrl: provider.baseUrl, model: provider.model, apiKey: apiKeyFor(this.options.config.current) };
  }

  #describe(error: unknown, settings: ProviderSettings): TurnFailure {
    const tr = translator(this.uiLocale());
    const params = { provider: providerLabel(settings), model: settings.model, detail: "" };
    if (!(error instanceof ProviderError)) {
      return { kind: "internal", message: tr("error.internal"), detail: errorMessage(error) };
    }
    const detail = this.options.logger.redact(error.message);
    const key = error.kind === "unreachable" && isLocalProvider(settings) ? "error.unreachable_local" : (`error.${error.kind}` as const);
    return { kind: error.kind, message: tr(key, { ...params, detail: detail.slice(0, 160) }), detail };
  }

  #registerSecrets(): void {
    for (const key of Object.values(this.options.config.current.apiKeys)) if (key) this.options.logger.addSecret(key);
  }

  #emit(event: BrainEvent): void {
    for (const listener of this.#listeners) listener(event);
  }

  snapshot() {
    return {
      connected: this.#connected,
      hello: this.#hello,
      state: this.#state,
      busy: this.#turnActive,
      replyLanguage: this.replyLanguage(),
      uiLocale: this.uiLocale(),
      lastError: this.lastError,
      lastTurn: this.lastTurn,
    };
  }
}

const warmKey = (settings: ProviderSettings) => `${settings.baseUrl}|${settings.model}`;

/** Label used in error messages: the preset name, or the host for custom servers. */
export function providerLabel(settings: Pick<ProviderSettings, "preset" | "baseUrl">): string {
  if (settings.preset !== "custom") return getPreset(settings.preset).label.replace(/ \((local|Claude|Grok)\)$/, "");
  try {
    return new URL(settings.baseUrl).host;
  } catch {
    return getPreset(settings.preset).label;
  }
}
