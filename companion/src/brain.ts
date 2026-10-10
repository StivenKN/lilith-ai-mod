// Orchestrates conversations: one turn at a time, thinking indicator, explicit timeouts, the
// empty-reply and repetition retries, bubble paging, and plain-language errors that always
// reach the player (in the bubble and the chat window) instead of a stock in-character line.
// Also writes the cards she leaves in the game's inbox, from what the player chose to share.
// With voice on, each bubble page is spoken too, and microphone recordings become chat turns.
// An Ollama model is in memory only while it's needed: it loads when the player opens the chat,
// Ollama frees it after the idle time in the settings, and it's freed at once when the game
// closes or another model is chosen.
// Memory upkeep (updating the notes, folding old turns into the summary) runs when the player
// pauses, between turns, and a new message interrupts it, so it never delays a reply.

import { rm } from "node:fs/promises";
import type { AccountStore } from "./accounts/store.ts";
import type { Config, ConfigStore } from "./config.ts";
import { apiKeyFor, type Hotkey } from "./config.ts";
import type { BrowserHub } from "./browser/hub.ts";
import { BrowserSession } from "./browser/session.ts";
import { runComputerTurn } from "./computer/agent.ts";
import { getDesktop, type DesktopStatus } from "./computer/desktop.ts";
import { computerTools, type Action } from "./computer/actions.ts";
import type { Capabilities, ChatRequest, ChatResult, ChatTurn } from "./providers/types.ts";
import { translator, type Translate } from "./i18n.ts";
import { resolveLanguage, uiLocaleFor, type Language, type UiLocale } from "./languages.ts";
import type { Log, Logger } from "./log.ts";
import { errorMessage } from "./log.ts";
import type { Card, Keepsake, Keepsakes, Picture } from "./keepsakes.ts";
import { contextBudget, noteChangesFormat, parseNoteChanges, parseSummaryLines, type Memory, type StoredTurn, type UpkeepJob } from "./memory.ts";
import {
  avoidRepeatComputerCue,
  avoidRepeatCue,
  buildCardPrompt,
  buildSystemPrompt,
  CARD_MAX_CHARS,
  defaultPersona,
  describePicturePrompt,
  keepsakeCue,
  notesPrompt,
  speakFirstCue,
  summaryPrompt,
  withTurnNote,
  type PromptContext,
} from "./prompt.ts";
import { createProvider, isLocalProvider, ProviderError, type ErrorKind, type Provider } from "./providers/index.ts";
import type { ProviderSettings } from "./providers/index.ts";
import { isOllamaModelLoaded, unloadOllama, warmUpOllama } from "./providers/ollama.ts";
import { getPreset } from "./providers/presets.ts";
import { PROTOCOL_VERSION, type CompanionMessage, type Emotion, type GameState, type HelloMessage, type PluginMessage } from "./protocol.ts";
import { paginate, parseReply, repeatedSentences, withoutSentences } from "./reply.ts";
import { facets, type Facet } from "./lookup/facets.ts";
import { audienceOf, originOf, type Audience, type Gate } from "./lookup/gate.ts";
import { openShelf, stripLookupTags, type Found, type LookupRequest, type Shelf } from "./lookup/shelf.ts";
import type { SpokenLanguage } from "./voice/catalog.ts";
import { VoiceError, type Spoken, type VoiceService } from "./voice/index.ts";

const MAX_TOKENS = 1024;
const RETRY_MAX_TOKENS = 4096;
/** The notes are updated once this many new messages from the player have come in. */
const LEARN_EVERY = 4;
/** Memory upkeep starts once the player has paused this long after her reply. */
const UPKEEP_DELAY_MS = 15_000;
/** Upkeep runs in the background and a new message stops it, so it may take its time on slow PCs. */
const UPKEEP_TIMEOUT_MS = 300_000;
/** A reply that repeats her is kept, minus the repeats, if this much new is left; otherwise it's asked again. */
const MIN_FRESH_CHARS = 24;
/** Automatic cards: at most one this often, only after this much new to write about, while the player is away. */
const AUTO_CARD_EVERY_MS = 20 * 3600_000;
const AUTO_CARD_MIN_MESSAGES = 4;
const AUTO_CARD_AWAY_MS = 10 * 60_000;
/** After an automatic attempt (failed or not), wait this long before the next, so an AI outage isn't retried every minute. */
const AUTO_CARD_RETRY_MS = 3600_000;
/** Cards written while the game was closed are delivered on its next start if they're this recent. */
const PENDING_CARD_MAX_AGE_MS = 7 * 24 * 3600_000;
/** Without a store (tests, the provider test), she has no accounts to look in. */
const NO_ACCOUNTS: Pick<AccountStore, "sources"> = { sources: () => [] };

export type TurnFailure = { kind: ErrorKind | "internal"; message: string; detail: string };
export type TurnResult =
  | { ok: true; text: string; emotion: Emotion; latencyMs: number; model: string }
  | { ok: false; error: TurnFailure };
export type CardResult = { ok: true; card: Card } | { ok: false; error: TurnFailure };
/** Upkeep requests share one timeout and the signal that stops them when a message comes in. */
type UpkeepHttp = Required<Pick<ChatRequest, "timeoutMs" | "signal">>;
/** What a memory upkeep pass did, for the dashboard's "Summarize now". */
export type UpkeepResult = { summarized: number; notesChanged: number; error?: TurnFailure };

export interface BrainOptions {
  version: string;
  config: ConfigStore;
  memory: Memory;
  keepsakes: Keepsakes;
  logger: Logger;
  voice: VoiceService;
  /** Sends a message to the plugin (no-op when the game isn't attached). */
  send: (message: CompanionMessage) => void;
  dashboardUrl: () => string;
  openDashboard: () => void;
  /** Called when the plugin speaks an incompatible protocol version. */
  onFatal: (reason: string) => void;
  systemLocale?: string;
  desktop?: DesktopStatus;
  /** The browser extension's connections. Without it (tests), she has no browser tool. */
  browser?: Pick<BrowserHub, "current" | "status" | "onChange">;
  /** The player's connected accounts. Without it (tests), she has none to look in. */
  accounts?: Pick<AccountStore, "sources">;
}

export interface BrainEvent {
  type: "plugin" | "turn" | "error" | "keepsakes" | "memory";
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
  /** The Ollama model being loaded ahead of a message (its warmKey), until it's ready. */
  #loading: string | null = null;
  #openedSetup = false;
  #speakFirstTimer: ReturnType<typeof setInterval> | null = null;
  #nextAutoCardAt = 0;
  #listeners = new Set<(event: BrainEvent) => void>();
  #desktop: DesktopStatus = { available: false, reason: "Checking desktop support" };
  #desktopReady: Promise<DesktopStatus>;
  #computerCapabilities: Capabilities | undefined;
  #computerAbort: AbortController | null = null;
  #computerDone: Promise<void> = Promise.resolve();
  #computerEpoch = 0;
  #computerActed = false;
  #upkeepTimer: ReturnType<typeof setTimeout> | null = null;
  /** The running upkeep pass. Once its summary is overdue, a new message no longer stops it. */
  #upkeepRun: { abort: AbortController; overdue: boolean } | null = null;
  #stopped = false;
  lastError: (TurnFailure & { at: string }) | null = null;
  lastVoiceError: { at: string; detail: string } | null = null;
  lastTurn: { at: string; latencyMs: number; model: string } | null = null;

  constructor(private readonly options: BrainOptions) {
    this.#log = options.logger.scope("brain");
    this.#desktopReady = options.desktop ? Promise.resolve(options.desktop) : getDesktop();
    void this.#desktopReady.then((status) => { this.#desktop = status; this.#emit({ type: "plugin" }); });
    options.browser?.onChange(() => this.#emit({ type: "plugin" }));
    let model = ollamaModel(options.config.current);
    options.config.onChange((config) => {
      this.#computerEpoch++;
      if (this.#computerActed) this.#computerAbort?.abort();
      this.#computerCapabilities = undefined;
      if (this.#connected) this.#sendReady();
      this.#registerSecrets();
      const previous = model;
      model = ollamaModel(config);
      if (previous && warmKey(previous) !== (model && warmKey(model))) void this.#unloadModel(previous, "another model was chosen");
    });
    this.#registerSecrets();
  }

  start(): void {
    this.#speakFirstTimer = setInterval(() => {
      this.#maybeSpeakFirst();
      this.#maybeWriteCard();
    }, 60_000);
  }

  async stop(): Promise<void> {
    this.#stopped = true;
    if (this.#speakFirstTimer) clearInterval(this.#speakFirstTimer);
    this.#pauseUpkeep(true);
    this.#cancelComputer();
    await this.#computerDone;
  }

  #cancelComputer(): void {
    this.#computerEpoch++;
    this.#computerAbort?.abort();
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
      case "chatOpened":
        this.#loadModel();
        return;
      case "voice":
        void this.voiceChat(message.path, "game");
        return;
      case "voiceError": {
        this.#log.warn(`microphone failed: ${message.detail}`);
        const text = translator(this.uiLocale())("voice.error.microphone");
        this.options.send({ type: "chatStatus", kind: "error", text });
        this.#say(`${translator(this.uiLocale())("bubble.errorPrefix")}${text}`, "sad", 10);
        return;
      }
      case "action":
        this.options.openDashboard();
        return;
      case "result":
        if (!message.ok) this.#log.warn(`plugin could not show message ${message.id}: ${message.error ?? "unknown reason"}`);
        void this.options.keepsakes.cardDelivered(message.id, message.ok, message.error).then((isCard) => {
          if (isCard) this.#emit({ type: "keepsakes" });
        });
        return;
      case "log":
        this.options.logger.write(message.level, "plugin", message.msg);
        return;
    }
  }

  /** The game closed: stop any computer task and memory upkeep, and free the local model, which nothing needs until it's back. */
  async pluginDisconnected(): Promise<void> {
    this.#cancelComputer();
    this.#pauseUpkeep(true);
    this.#connected = false;
    this.#emit({ type: "plugin" });
    const model = ollamaModel(this.options.config.current);
    if (model) await this.#unloadModel(model, "the game closed");
  }

  #onHello(hello: HelloMessage): void {
    if (hello.v !== PROTOCOL_VERSION) {
      this.#log.error(`plugin speaks protocol v${hello.v}, companion speaks v${PROTOCOL_VERSION}: update both parts`);
      this.options.onFatal("protocol version mismatch");
      return;
    }
    // The plugin says hello again whenever one of its capabilities changes; only a new connection
    // gets the cards written while the game was closed, so none is delivered twice.
    const newConnection = !this.#connected;
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
    if (newConnection) this.#deliverPendingCards();

    if (!this.options.config.current.provider.configured && !this.#openedSetup) {
      this.#openedSetup = true;
      this.#log.info("no AI provider configured yet; opening the setup page");
      this.options.openDashboard();
    }
  }

  #sendReady(): void {
    const tr = translator(this.uiLocale());
    const { hotkey, voice } = this.options.config.current;
    this.options.send({
      type: "ready",
      v: PROTOCOL_VERSION,
      version: this.options.version,
      dashboardUrl: this.options.dashboardUrl(),
      hotkey,
      voiceHotkey: voice.listen ? voice.hotkey : null,
      strings: {
        placeholder: tr("plugin.placeholder"),
        thinking: tr("plugin.thinking"),
        send: tr("plugin.send"),
        settings: tr("plugin.settings"),
        trayTalk: tr("plugin.trayTalk"),
        traySettings: tr("plugin.traySettings"),
        listening: tr("plugin.listening", { key: hotkeyLabel(voice.hotkey) }),
        talk: tr("plugin.talk"),
      },
    });
  }

  // ── Languages ──────────────────────────────────────────────────────────────

  /**
   * A fixed voice language while she speaks aloud, else the explicit setting, else the game's
   * language, else the dashboard language the player picked, else the OS.
   */
  replyLanguage(): Language {
    const { replyLanguage, uiLanguage, voice } = this.options.config.current;
    if (voice.speak && voice.language !== "auto") return voice.language;
    if (replyLanguage !== "auto") return replyLanguage;
    return (
      resolveLanguage(this.#state?.langRaw) ??
      (uiLanguage !== "auto" ? uiLanguage : null) ??
      resolveLanguage(this.options.systemLocale) ??
      "en"
    );
  }

  /** The language her voice speaks, or null when she replies in one Piper has no voice for. */
  spokenLanguage(): SpokenLanguage | null {
    const language = this.replyLanguage();
    return language === "es" || language === "en" ? language : null;
  }

  uiLocale(): UiLocale {
    const setting = this.options.config.current.uiLanguage;
    return setting === "auto" ? uiLocaleFor(this.replyLanguage()) : setting;
  }

  // ── Conversation ───────────────────────────────────────────────────────────

  /**
   * Queues a user message. Resolves with Lilith's reply or a classified, localized error.
   * `thinking` replaces the usual status line while she answers.
   */
  chat(text: string, source: StoredTurn["source"], thinking?: string): Promise<TurnResult> {
    this.#computerEpoch++;
    if (this.#computerActed) this.#computerAbort?.abort();
    const computerEpoch = this.#computerEpoch;
    this.#lastActivity = Date.now();
    this.#pauseUpkeep();
    return this.#enqueue(() => this.#runTurn({ user: text.trim(), source, computerEpoch, thinking }));
  }

  /**
   * A microphone recording: transcribe it, then treat the words as a chat message. Failures are
   * explained like any other error, in the chat window and the bubble.
   */
  async voiceChat(path: string, source: StoredTurn["source"]): Promise<TurnResult | null> {
    const tr = translator(this.uiLocale());
    const { voice } = this.options.config.current;
    this.#lastActivity = Date.now();
    this.options.send({ type: "chatStatus", kind: "thinking", text: tr("voice.transcribing") });
    const heard = await this.options.voice.transcribe(path, { model: voice.sttModel, language: this.replyLanguage() }).then(
      (text) => ({ text }),
      (error: unknown) => ({ error }),
    );
    // The plugin's recording is ours to delete, whatever happened.
    if (source === "game") await rm(path, { force: true }).catch(() => {});
    if ("error" in heard) {
      const kind = heard.error instanceof VoiceError ? heard.error.kind : "failed";
      this.#log.warn(`speech recognition failed (${kind}): ${errorMessage(heard.error)}`);
      if (kind !== "no_speech") this.lastVoiceError = { at: new Date().toISOString(), detail: errorMessage(heard.error) };
      const message = tr(`voice.error.${kind}`);
      this.options.send({ type: "chatStatus", kind: "error", text: message });
      if (this.#connected && kind !== "no_speech") this.#say(`${tr("bubble.errorPrefix")}${message}`, "sad", 10);
      this.#emit({ type: "error" });
      return null;
    }
    const { text } = heard;
    this.#log.info(`heard ${text.length} chars from the microphone`);
    // The status line shows what was heard while she thinks, so a misheard word is obvious.
    return this.chat(text, source, tr("voice.heard", { text }));
  }

  /** One-off check from the dashboard: a real persona prompt, nothing stored or shown in game. */
  async testProvider(settings: ProviderSettings): Promise<TurnResult> {
    const started = performance.now();
    const language = this.replyLanguage();
    try {
      const provider = createProvider(settings, (message) => this.#log.warn(message));
      // A check is nobody's turn: it may search the web, never the player's accounts.
      const shelf = this.#openShelf({ origin: "autonomous", audience: audienceOf(settings) });
      const { text, emotion, model } = await this.#ask(provider, settings, language, [
        { role: "user", content: language === "es" ? "Hola, Lilith. ¿Me escuchas?" : "Hi Lilith. Can you hear me?" },
      ], shelf);
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

  async #runTurn(input: { user: string | null; source: StoredTurn["source"]; idleMinutes?: number; computerEpoch?: number; thinking?: string | undefined }): Promise<TurnResult> {
    const config = this.options.config.current;
    const settings = this.#providerSettings();
    const tr = translator(this.uiLocale());
    const speakFirst = input.user === null;
    const inGame = this.#connected;
    const started = performance.now();
    this.#turnActive = true;
    this.#pagingToken++;

    if (!speakFirst) {
      this.options.send({ type: "chatStatus", kind: "thinking", text: input.thinking ?? tr("plugin.thinking") });
      if (inGame) this.#say("…", "neutral", 120);
    }
    const escalation = this.#escalateWhileWaiting(settings, tr, started, !speakFirst);

    try {
      const language = this.replyLanguage();
      const provider = createProvider(settings, (message) => this.#log.warn(message));
      const userTurn = input.user ?? speakFirstCue(language, Math.round(input.idleMinutes ?? 0));
      const onLookup = (request: LookupRequest) => {
        if (!speakFirst) this.options.send({ type: "chatStatus", kind: "thinking", text: this.#lookupStatus(request, tr) });
      };
      const gate: Gate = { origin: originOf[input.source], audience: audienceOf(settings) };
      const budget = contextBudget(isLocalProvider(settings));
      const turns: ChatTurn[] = [...this.options.memory.promptTurns(budget, gate.audience), { role: "user", content: userTurn }];
      const shelf = this.#openShelf(gate);
      const desktop = await this.#desktopReady;
      const useComputer = !speakFirst && computerEnabled(config.features.computerControl, settings) && desktop.available;
      const { text, emotion, model, consulted } = useComputer
        ? await this.#askComputer(provider, settings, language, turns, shelf, desktop, () => clearInterval(escalation), onLookup, input.computerEpoch)
        : await this.#ask(provider, settings, language, turns, shelf, { onLookup });
      const latencyMs = Math.round(performance.now() - started);
      const stored = await this.options.memory.addExchange(input.user, text, input.source, consulted);
      if (!stored) this.#log.info("reply was still a near-repeat; shown, but kept out of her context");
      this.#log.info(`reply in ${latencyMs} ms from ${model} (${input.source})`);

      this.lastTurn = { at: new Date().toISOString(), latencyMs, model };
      this.options.send({ type: "chatStatus", kind: "idle", text });
      if (inGame) void this.#showPages(text, emotion, speakFirst);
      this.#emit({ type: "turn" });

      this.#scheduleUpkeep();
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

  async computerCheck(refresh = true) {
    const status = await this.#desktopReady;
    if (!status.available) return { available: false, reason: status.reason, tools: false, vision: false };
    const config = this.options.config.current;
    const settings = this.#providerSettings();
    try {
      const provider = createProvider(settings, (message) => this.#log.warn(message));
      const capabilities = await provider.capabilities({ timeoutMs: 30_000 }, refresh);
      if (config === this.options.config.current) {
        this.#computerCapabilities = capabilities;
        this.#emit({ type: "plugin" });
      }
      return { available: true, ...capabilities };
    } catch (error) {
      return { available: true, tools: false, vision: false, reason: this.options.logger.redact(errorMessage(error)) };
    }
  }

  async #askComputer(
    provider: Provider,
    settings: ProviderSettings,
    language: Language,
    turns: Parameters<Provider["chat"]>[0]["turns"],
    shelf: Shelf,
    status: Extract<DesktopStatus, { available: true }>,
    actionsStarted: () => void,
    onLookup: (request: LookupRequest) => void,
    epoch: number | undefined,
  ) {
    const config = this.options.config.current;
    const tr = translator(this.uiLocale());
    const stopped = () => ({ text: tr("computer.stopped"), emotion: "neutral" as const, model: settings.model, consulted: null });
    if (this.#stopped) return stopped();
    if (epoch !== this.#computerEpoch) return this.#ask(provider, settings, language, turns, shelf, { onLookup });
    const controller = new AbortController();
    this.#computerAbort = controller;
    this.#computerActed = false;
    let done = () => {};
    this.#computerDone = new Promise<void>((resolve) => { done = resolve; });
    let acted = false;
    let fellBack = false;
    // Ordinary chat instead, on this turn's shelf unless the model is known to reject tools.
    const fallback = async (asked: LookupRequest | null = null, open = shelf) => {
      fellBack = true;
      try { return await this.#ask(provider, settings, language, turns, open, { onLookup, signal: controller.signal, asked }); }
      catch (error) { if (controller.signal.aborted) return stopped(); throw error; }
    };
    try {
      const http = { timeoutMs: Math.min(180_000, await this.#timeoutFor(settings)), signal: controller.signal };
      const capabilities = await provider.capabilities(http);
      controller.signal.throwIfAborted();
      if (config === this.options.config.current) this.#computerCapabilities = capabilities;
      if (epoch !== this.#computerEpoch) return await fallback();
      if (!capabilities.tools) return await fallback(null, shelf.withoutTools());
      const link = this.options.browser?.current();
      const browser = link ? new BrowserSession(link, { vision: capabilities.vision }) : undefined;
      const context: PromptContext = { ...this.#promptContext(language, shelf.facets), computer: { vision: capabilities.vision, browser: !!browser } };
      let lastStatus = "";
      const run = (asked: readonly ChatTurn[], temperature: number) => runComputerTurn({
        session: provider.agent({ system: buildSystemPrompt(context), turns: withNote(asked, context), tools: [...computerTools(capabilities.vision, !!browser), ...shelf.tools], vision: capabilities.vision, maxTokens: RETRY_MAX_TOKENS, temperature }),
        desktop: status.desktop, vision: capabilities.vision, http, task: turns.at(-1)?.content ?? "",
        lookupTools: shelf.tools.map((tool) => tool.name),
        ...(browser ? { browser } : {}),
        canAct: () => epoch === this.#computerEpoch,
        yieldFocus: () => this.options.send({ type: "yieldFocus" }),
        log: (message) => this.#log.info(message),
        onStatus: (action) => {
          acted = true;
          this.#computerActed = true;
          actionsStarted();
          const text = this.#actionStatus(action, tr);
          if (text === lastStatus) return;
          lastStatus = text;
          this.options.send({ type: "chatStatus", kind: "thinking", text });
          if (this.#connected) this.#say(text, "neutral", 120);
        },
      });
      let result = await run(turns, config.advanced.temperature);
      if (!acted && result.outcome === "superseded") return await fallback();
      const answered = () => result.outcome === "done" || result.outcome === "lookup";
      if (!acted && answered()) {
        // A lookup asked before any action goes to ordinary chat with the request already chosen, so
        // the model isn't asked twice.
        const lookup = shelf.requestIn(result);
        if (lookup) return await fallback(lookup);
        const initialReply = parseReply(stripLookupTags(result.text), config.advanced.maxReplyChars);
        if (!initialReply.text) return await fallback();
        // A plain answer that mostly repeats her is often a repeated PC request answered in words
        // ("I opened it"), so the retry keeps the tools; tool-less chat could never act on it.
        if (repeats(initialReply.text, this.options.memory.recentReplies()).mostly) {
          this.#log.info("computer reply mostly repeated her earlier words; asking once more with tools");
          const cued = turns.map((turn, index) => (index === turns.length - 1 ? { ...turn, content: turn.content + avoidRepeatComputerCue(language) } : turn));
          result = await run(cued, Math.min(2, config.advanced.temperature + 0.2));
          if (!acted && result.outcome === "superseded") return await fallback();
        }
      }
      let text = result.outcome === "stopped" ? tr("computer.stopped") : result.text;
      const asked = answered() ? shelf.requestIn(result) : null;
      let consulted: Audience | null = null;
      if (asked) {
        onLookup(asked);
        const found = await shelf.look(asked, turns.at(-1)?.content ?? "", controller.signal);
        if (found.kind === "consulted") consulted = found.audience;
        // This final answer has no tools, so what was found cannot drive desktop actions.
        const answer = await provider.chat({
          system: buildSystemPrompt(context),
          turns: withNote([...withNote(turns, context), { role: "assistant", content: text || "…" }, { role: "user", content: asked.facet === "web" ? "Answer using the search results. Do not perform or claim any additional computer actions." : "Answer using what you found. Do not perform or claim any additional computer actions." }], context, found),
          maxTokens: MAX_TOKENS, temperature: config.advanced.temperature, ...http,
        });
        text = answer.text;
      }
      const reply = parseReply(stripLookupTags(text), config.advanced.maxReplyChars);
      this.#warm.add(warmKey(settings));
      return { ...reply, text: repeats(reply.text, this.options.memory.recentReplies()).text || tr("computer.empty"), model: result.model || settings.model, consulted };
    } catch (error) {
      if (controller.signal.aborted) return stopped();
      if (config === this.options.config.current && error instanceof ProviderError && error.kind === "no_tools") {
        this.#computerCapabilities = { tools: false, vision: this.#computerCapabilities?.vision ?? false };
      }
      // Before any action, provider compatibility errors must not break ordinary chat.
      // After actions, a fresh chat would lose their results and could claim success.
      if (!acted && !fellBack && error instanceof ProviderError && !["auth", "billing", "rate_limit", "unreachable", "timeout", "refused", "empty_reply"].includes(error.kind)) {
        this.#log.warn(`computer request failed before actions; using ordinary chat: ${error.message}`);
        return await fallback(null, error.kind === "no_tools" ? shelf.withoutTools() : shelf);
      }
      throw error;
    } finally {
      if (this.#computerAbort === controller) { this.#computerAbort = null; this.#computerActed = false; }
      done();
    }
  }

  #actionStatus(action: Action, tr: Translate): string {
    switch (action.type) {
      case "screenshot": case "zoom": case "cursor": return tr("computer.looking");
      case "openApp": return tr("computer.openingApp", { name: action.name });
      case "openUrl": return tr("computer.openingUrl");
      case "browser": return tr(action.op.op === "read" ? "computer.reading" : "computer.browsing");
      case "window": return tr("computer.windows");
      case "type": case "key": return tr("computer.typing");
      case "wait": return tr("computer.waiting");
      default: return tr("computer.clicking");
    }
  }

  /**
   * Calls the model and shapes the answer. If the model asks for a lookup (a tool call when her
   * accounts are offered, else `[search: query]`), or the computer turn already got one (`asked`),
   * runs it and asks again, tool-free, with what it found. Then one retry each for empty and
   * repeated replies, tool-free on the same system prompt.
   */
  async #ask(
    provider: Provider,
    settings: ProviderSettings,
    language: Language,
    turns: Parameters<Provider["chat"]>[0]["turns"],
    shelf: Shelf,
    { onLookup = () => {}, signal, asked = null }: { onLookup?: (request: LookupRequest) => void; signal?: AbortSignal; asked?: LookupRequest | null } = {},
  ) {
    const config = this.options.config.current;
    const http = { timeoutMs: await this.#timeoutFor(settings), ...(signal ? { signal } : {}) };
    let open = shelf;
    let context = this.#promptContext(language, open.facets);
    const requestFor = (context: PromptContext, found?: Found): ChatRequest => ({ system: buildSystemPrompt(context), turns: withNote(turns, context, found), maxTokens: MAX_TOKENS, temperature: config.advanced.temperature, ...http });
    let request = requestFor(context);

    let result: ChatResult | undefined;
    let lookup = asked;
    if (!lookup && open.tools.length > 0) {
      // The first step offers only the lookup tools. A call ends it; the answer comes from a chat without tools.
      try {
        const step = await provider.agent({ ...request, tools: open.tools, vision: false }).next([], http);
        result = { text: step.text, reasoning: "", finish: step.finish, model: step.model };
        lookup = open.requestIn(step);
      } catch (error) {
        if (!(error instanceof ProviderError && error.kind === "no_tools")) throw error;
        // No probe asked the model first: a rejection here is how she learns, and her accounts stay closed this turn.
        this.#log.warn(`${settings.model} rejected the lookup tools; answering without her accounts`);
        open = open.withoutTools();
        context = this.#promptContext(language, open.facets);
        request = requestFor(context);
      }
    }
    if (!lookup && !result) {
      result = await provider.chat(request);
      lookup = open.requestIn(result);
    }
    let consulted: Audience | null = null;
    if (lookup) {
      onLookup(lookup);
      const found = await open.look(lookup, turns.at(-1)?.content ?? "", signal);
      if (found.kind === "consulted") consulted = found.audience;
      request = requestFor(context, found);
      result = await provider.chat(request);
    }
    const { reply: first, model } = await this.#complete(provider, request, config.advanced.maxReplyChars, result);
    let reply = first;
    // Small models fall into loops (the same closing question on every reply). A reply that's
    // mostly repeats is asked for again; whatever repeats remain are left out, so they never
    // reach her history and can't feed the loop.
    const recent = this.options.memory.recentReplies();
    if (repeats(reply.text, recent).mostly) {
      this.#log.info("reply mostly repeated her earlier words; asking once for something new");
      const cued = request.turns.map((turn, index) => (index === request.turns.length - 1 ? { ...turn, content: turn.content + avoidRepeatCue(language) } : turn));
      const retried = await provider.chat({ ...request, turns: cued, temperature: Math.min(2, request.temperature + 0.2) });
      const retry = parseReply(stripLookupTags(retried.text), config.advanced.maxReplyChars);
      if (retry.text) reply = retry;
    }
    const kept = repeats(reply.text, recent);
    if (kept.text !== reply.text) {
      this.#log.info(`left out ${kept.repeated} sentence(s) she had already said`);
      reply = { ...reply, text: kept.text };
    }
    this.#warm.add(warmKey(settings));
    return { text: reply.text, emotion: reply.emotion, model, consulted };
  }

  /**
   * One shelf per turn: the gate is asked once, and the tools are offered without probing the
   * model first (a probe costs an image request on online providers). A model that rejects them
   * gets the same shelf without, so players without an account pay nothing new.
   */
  #openShelf(gate: Gate): Shelf {
    const { config, accounts = NO_ACCOUNTS } = this.options;
    return openShelf({ gate, tools: true, search: config.current.search, sources: accounts.sources(gate), log: this.#log });
  }

  #lookupStatus(request: LookupRequest, tr: Translate): string {
    return request.facet === "web" ? tr("status.searching", { query: request.query }) : tr("status.looking", { what: facets[request.facet].label[this.uiLocale()] });
  }

  /**
   * One model call shaped for display, retried once with a larger budget if only reasoning came
   * back. Pass `result` when the first answer was already fetched (e.g. after a web search).
   */
  async #complete(provider: Provider, request: ChatRequest, maxChars: number, result?: ChatResult) {
    result ??= await provider.chat(request);
    let reply = parseReply(stripLookupTags(result.text), maxChars);
    if (!reply.text) {
      this.#log.warn(`empty reply (finish: ${result.finish}, reasoning: ${result.reasoning.length} chars); retrying with a larger budget`);
      result = await provider.chat({ ...request, maxTokens: RETRY_MAX_TOKENS });
      reply = parseReply(stripLookupTags(result.text), maxChars);
      if (!reply.text) throw new ProviderError("empty_reply", `No visible text after retry (finish: ${result.finish})`);
    }
    return { reply, model: result.model };
  }

  async #timeoutFor(settings: ProviderSettings): Promise<number> {
    const override = this.options.config.current.advanced.timeoutSeconds;
    if (override) return override * 1000;
    if (!isLocalProvider(settings)) return 60_000;
    return (await this.#isWarm(settings)) ? 60_000 : 180_000;
  }

  /**
   * Whether a local model can answer without loading first. Ollama says what it holds in memory,
   * but it lists a model while it's still loading too, so one we're loading counts as cold until
   * it's ready. Other local servers count as warm after their first reply.
   */
  async #isWarm(settings: ProviderSettings): Promise<boolean> {
    if (getPreset(settings.preset).kind !== "ollama") return this.#warm.has(warmKey(settings));
    return this.#loading !== warmKey(settings) && (await isOllamaModelLoaded(settings.baseUrl, settings.model));
  }

  /** Keeps the player informed during slow replies (e.g. a local model loading). */
  #escalateWhileWaiting(settings: ProviderSettings, tr: Translate, started: number, visible: boolean) {
    let loading = false;
    if (visible && isLocalProvider(settings)) void this.#isWarm(settings).then((warm) => { loading = !warm; });
    return setInterval(() => {
      if (!visible) return;
      const seconds = Math.round((performance.now() - started) / 1000);
      const text = loading ? tr("status.loadingModel") : tr("status.stillThinking", { seconds });
      this.options.send({ type: "chatStatus", kind: "thinking", text });
    }, 8_000);
  }

  /**
   * The player opened the chat: load the Ollama model now, so it's ready by the time they send.
   * If it's already in memory, this restarts its idle countdown instead.
   */
  #loadModel(): void {
    const config = this.options.config.current;
    const model = ollamaModel(config);
    if (!model) return;
    const key = warmKey(model);
    if (this.#loading === key) return;
    const started = performance.now();
    this.#loading = key;
    void warmUpOllama(model.baseUrl, model.model, config.advanced.unloadAfterMinutes)
      .then(
        () => this.#log.info(`Ollama model ${model.model} ready after ${Math.round(performance.now() - started)} ms`),
        (error: unknown) => this.#log.warn(`could not load Ollama model ${model.model}: ${errorMessage(error)}`),
      )
      .finally(() => {
        if (this.#loading === key) this.#loading = null;
      });
  }

  /** Frees an Ollama model's memory now, instead of when its idle time runs out. */
  async #unloadModel(model: OllamaModel, reason: string): Promise<void> {
    if (await unloadOllama(model.baseUrl, model.model)) this.#log.info(`unloaded Ollama model ${model.model}: ${reason}`);
  }

  async #showPages(text: string, emotion: Emotion, ambient: boolean): Promise<void> {
    const token = ++this.#pagingToken;
    const { bubbleLineUnits, bubbleLines } = this.options.config.current.advanced;
    const pages = paginate(text, bubbleLineUnits, bubbleLines);
    // Every page is queued for speech at once; the voice runs them in order, so page 2 is being
    // synthesized while page 1 plays.
    const audio = pages.map((page) => this.#speak(page.text));
    for (const [index, page] of pages.entries()) {
      const spoken = await audio[index];
      if (token !== this.#pagingToken) return; // a newer turn took over the bubble
      if (ambient && index === 0 && this.#state?.busy) {
        this.#log.info("speak-first remark dropped: Lilith is busy");
        return;
      }
      const last = index === pages.length - 1;
      // The page stays up for as long as she's reading it or saying it, whichever is longer.
      const seconds = Math.max(page.seconds, (spoken?.seconds ?? 0) + 0.3);
      this.#say(page.text, emotion, seconds + (last ? 2 : 0.5), spoken?.file);
      if (!last) await Bun.sleep(seconds * 1000);
    }
  }

  /** Speech for one page, or null when the voice is off or failed (she still shows the text). */
  async #speak(text: string): Promise<Spoken | null> {
    const { voice } = this.options.config.current;
    const language = this.spokenLanguage();
    if (!voice.speak || !language) return null;
    try {
      return await this.options.voice.speak(text, { voice: language === "es" ? voice.esVoice : voice.enVoice, speed: voice.speed, volume: voice.volume });
    } catch (error) {
      const detail = errorMessage(error);
      // Once per distinct problem, so a missing voice doesn't flood the log every reply.
      if (this.lastVoiceError?.detail !== detail) this.#log.warn(`could not speak: ${detail}`);
      this.lastVoiceError = { at: new Date().toISOString(), detail };
      return null;
    }
  }

  #say(text: string, emotion: Emotion, seconds: number, audio?: string): void {
    this.options.send({
      type: "say",
      id: crypto.randomUUID().slice(0, 8),
      text,
      emotion,
      seconds: Math.round(seconds * 10) / 10,
      ...(audio ? { audio } : {}),
    });
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

  // ── Memory upkeep ──────────────────────────────────────────────────────────

  /** Upkeep waits for a pause after her reply, so it doesn't hold up the player's next message. */
  #scheduleUpkeep(): void {
    if (this.#stopped) return;
    if (this.#upkeepTimer) clearTimeout(this.#upkeepTimer);
    this.#upkeepTimer = setTimeout(() => {
      this.#upkeepTimer = null;
      void this.#enqueue(() => this.#upkeep(false));
    }, UPKEEP_DELAY_MS);
    this.#upkeepTimer.unref();
  }

  /**
   * A new message comes first: upkeep waits for the next pause, and a running pass stops unless its
   * summary is overdue. `closing` stops that one too: no reply is waiting, and the local model is
   * about to be freed, which another request would load again.
   */
  #pauseUpkeep(closing = false): void {
    if (this.#upkeepTimer) clearTimeout(this.#upkeepTimer);
    this.#upkeepTimer = null;
    if (closing || !this.#upkeepRun?.overdue) this.#upkeepRun?.abort.abort();
  }

  /**
   * Runs memory upkeep now instead of at the next pause. With `compact`, everything but the recent
   * turns is folded into the summary, even below the usual threshold (the dashboard's "Summarize
   * now"). Resolves once it's done.
   */
  tidyMemory(compact = false): Promise<UpkeepResult> {
    if (this.#upkeepTimer) clearTimeout(this.#upkeepTimer);
    this.#upkeepTimer = null;
    return this.#enqueue(() => this.#upkeep(compact));
  }

  /**
   * Updates the notes from the exchanges they haven't read, then folds the oldest turns into the
   * summary if the conversation has grown past its budget. Each step is one small, focused request
   * a 4B model handles well, and each is saved as soon as it's done. A new message stops it, unless
   * the turns have already outgrown the window: then the summary is overdue, and finishing it
   * once is cheaper than every following reply dropping turns it never summarized.
   */
  async #upkeep(compact: boolean): Promise<UpkeepResult> {
    const result: UpkeepResult = { summarized: 0, notesChanged: 0 };
    const config = this.options.config.current;
    if (!config.provider.configured || this.#stopped) return result;
    const { memory } = this.options;
    const settings = this.#providerSettings();
    const language = this.replyLanguage();
    const budget = contextBudget(isLocalProvider(settings));
    const run = { abort: new AbortController(), overdue: false };
    this.#upkeepRun = run;
    try {
      const provider = createProvider(settings, (message) => this.#log.warn(message));
      const http = { timeoutMs: UPKEEP_TIMEOUT_MS, signal: run.abort.signal };
      if (config.features.learnFacts) {
        for (let job = memory.learning(compact ? 1 : LEARN_EVERY); job; job = memory.learning(compact ? 1 : LEARN_EVERY)) {
          const changed = await this.#updateNotes(provider, job, language, http);
          if (changed === null) break;
          result.notesChanged += changed;
        }
      }
      run.overdue = memory.overdue(budget);
      for (let job = memory.compaction(budget, compact); job; job = memory.compaction(budget, compact)) {
        if (!(await this.#summarize(provider, job, language, http))) break;
        result.summarized += job.turns.length;
      }
    } catch (error) {
      if (run.abort.signal.aborted) {
        this.#log.info("memory upkeep paused; it continues after her next reply");
      } else {
        const failure = this.#describe(error, settings);
        this.#log.warn(`memory upkeep failed: ${failure.kind}: ${failure.detail}`);
        result.error = failure;
      }
    } finally {
      if (this.#upkeepRun === run) this.#upkeepRun = null;
    }
    if (result.summarized > 0 || result.notesChanged > 0) this.#emit({ type: "memory" });
    return result;
  }

  /**
   * One notes update from a slice of the conversation. Returns how many notes changed, or null if
   * the player edited her memory meanwhile. An unusable answer skips those messages rather than
   * asking again forever. Nothing the player said is logged.
   */
  async #updateNotes(provider: Provider, job: UpkeepJob, language: Language, http: UpkeepHttp): Promise<number | null> {
    const { memory } = this.options;
    // Only exchanges that read the player's accounts: read past them, learn nothing.
    if (!job.turns.some((turn) => turn.role === "user")) {
      await memory.skipLearning(job);
      return 0;
    }
    const { system, user } = notesPrompt(language, memory.notes, job.turns, new Date());
    const answer = await provider.chat({ system, turns: [{ role: "user", content: user }], maxTokens: 600, temperature: 0.2, json: noteChangesFormat, ...http });
    const changes = parseNoteChanges(answer.text);
    if (!changes) {
      this.#log.warn(`notes update was not valid JSON (${answer.text.length} chars, finish: ${answer.finish}); skipping those messages`);
      await memory.skipLearning(job);
      return 0;
    }
    const applied = await memory.applyNoteChanges(job, changes);
    if (!applied) return null;
    const changed = applied.added + applied.updated + applied.removed;
    if (changed > 0) this.#log.info(`notes updated: ${applied.added} added, ${applied.updated} corrected, ${applied.removed} removed`);
    return changed;
  }

  /** Folds one slice of older turns into the summary. Returns false if it couldn't (try again later). */
  async #summarize(provider: Provider, job: UpkeepJob, language: Language, http: UpkeepHttp): Promise<boolean> {
    // Only exchanges that read the player's accounts: fold past them without a line about them.
    if (!job.turns.some((turn) => turn.role === "user")) return this.options.memory.applySummary(job, []);
    const { system, user } = summaryPrompt(language, this.options.memory.summary, job.turns);
    const answer = await provider.chat({ system, turns: [{ role: "user", content: user }], maxTokens: 400, temperature: 0.2, ...http });
    const lines = parseSummaryLines(answer.text);
    if (!lines) {
      this.#log.warn(`summary lines came back unusable (${answer.text.length} chars, finish: ${answer.finish}); trying again at the next pause`);
      return false;
    }
    if (!(await this.options.memory.applySummary(job, lines))) return false;
    this.#log.info(`summarized ${job.turns.length} older messages in ${lines.length} line(s)`);
    return true;
  }

  // ── Keepsakes and cards ─────────────────────────────────────────────────────

  /** Whether the game can take cards right now (the plugin found the note inbox). */
  get canLeaveCards(): boolean {
    return this.#connected && this.#hello?.caps.card === "ok";
  }

  /** Keeps a note the player shared and lets her react to it in the bubble. */
  async shareNote(text: string): Promise<Keepsake> {
    const note = await this.options.keepsakes.addNote(text);
    this.#emit({ type: "keepsakes" });
    if (this.options.config.current.provider.configured) void this.#enqueue(() => this.#react([note]));
    return note;
  }

  /**
   * Keeps pictures the player shared. In the background she looks at each one once (if the model
   * can see) and then reacts to the whole batch in one bubble.
   */
  async sharePictures(images: readonly Buffer[]): Promise<Picture[]> {
    const pictures = await this.options.keepsakes.addPictures(images);
    this.#emit({ type: "keepsakes" });
    if (this.options.config.current.provider.configured) {
      void this.#enqueue(async () => {
        for (const picture of pictures) await this.#lookAt(picture);
        this.#emit({ type: "keepsakes" });
        const seen = pictures.map((picture) => this.options.keepsakes.get(picture.id)).filter((item) => item !== null);
        if (seen.length > 0) await this.#react(seen);
      });
    }
    return pictures;
  }

  /** Writes a card and leaves it in the game's inbox (or keeps it for the game's next start). */
  writeCard(trigger: Card["trigger"]): Promise<CardResult> {
    return this.#enqueue(() => this.#writeCard(trigger));
  }

  #react(keepsakes: readonly Keepsake[]): Promise<TurnResult> {
    return this.#runTurn({ user: keepsakeCue(this.replyLanguage(), keepsakes), source: "keepsake" });
  }

  /** Asks the model once what a picture shows. Models that can't see just leave it to the caption. */
  async #lookAt(picture: Picture): Promise<void> {
    const settings = this.#providerSettings();
    try {
      const provider = createProvider(settings, (message) => this.#log.warn(message));
      const data = (await this.options.keepsakes.readPicture(picture)).toString("base64");
      const result = await provider.chat({
        system: describePicturePrompt(this.replyLanguage()),
        turns: [{ role: "user", content: "Describe the picture.", images: [{ mediaType: "image/jpeg", data }] }],
        maxTokens: 400,
        temperature: 0.2,
        timeoutMs: await this.#timeoutFor(settings),
      });
      const seen = parseReply(result.text, 300).text;
      if (seen) await this.options.keepsakes.describe(picture.id, { seen });
    } catch (error) {
      const failure = this.#describe(error, settings);
      this.#log.info(`could not look at a shared picture (${failure.kind}: ${failure.detail}); she'll go by its caption`);
    }
  }

  async #writeCard(trigger: Card["trigger"]): Promise<CardResult> {
    const settings = this.#providerSettings();
    const { keepsakes, memory } = this.options;
    const language = this.replyLanguage();
    const keepsake = keepsakes.pick();
    try {
      const provider = createProvider(settings, (message) => this.#log.warn(message));
      const { system, user } = buildCardPrompt({
        language,
        persona: this.#persona(language),
        now: new Date(),
        playerName: this.#state?.playerName ?? "",
        state: this.#state,
        notes: memory.notes,
        summary: memory.summary,
        keepsake,
        recentMessages: memory.recentUserMessages(8),
        previousCards: keepsakes.cards.slice(0, 4).map((card) => card.text),
      });
      const { reply, model } = await this.#complete(
        provider,
        {
          system,
          turns: [{ role: "user", content: user }],
          maxTokens: MAX_TOKENS,
          temperature: this.options.config.current.advanced.temperature,
          timeoutMs: await this.#timeoutFor(settings),
        },
        CARD_MAX_CHARS,
      );
      const card = await keepsakes.addCard({ text: reply.text, trigger, keepsakeId: keepsake?.id ?? null });
      this.#log.info(`wrote a ${trigger} card with ${model}${keepsake ? ` about a shared ${keepsake.kind}` : ""}`);
      if (this.canLeaveCards) this.options.send({ type: "card", id: card.id, text: card.text });
      this.#emit({ type: "keepsakes" });
      return { ok: true, card };
    } catch (error) {
      const failure = this.#describe(error, settings);
      this.#log.error(`card failed: ${failure.kind}: ${failure.detail}`);
      this.lastError = { ...failure, at: new Date().toISOString() };
      this.#emit({ type: "error" });
      return { ok: false, error: failure };
    }
  }

  /** Cards written while the game was closed (e.g. from the setup dashboard) go out once it connects. */
  #deliverPendingCards(): void {
    if (!this.canLeaveCards) return;
    const cutoff = Date.now() - PENDING_CARD_MAX_AGE_MS;
    const pending = this.options.keepsakes.cards.filter((card) => !card.inGame && !card.error && Date.parse(card.at) > cutoff);
    for (const card of pending.toReversed()) this.options.send({ type: "card", id: card.id, text: card.text });
    if (pending.length > 0) this.#log.info(`delivering ${pending.length} card(s) written while the game was closed`);
  }

  /**
   * At most one automatic card a day, and only once there's something new to write about (a few
   * messages, or something shared), delivered while the player is away so it reads as a surprise.
   */
  #maybeWriteCard(): void {
    const config = this.options.config.current;
    const state = this.#state;
    if (!config.features.cards || !config.provider.configured || !this.canLeaveCards || this.#turnActive || !state) return;
    if (state.sleep || state.busy || state.drag || state.interacting) return;
    if (Date.now() - this.#lastActivity < AUTO_CARD_AWAY_MS) return;
    const { keepsakes, memory } = this.options;
    const since = Date.parse(keepsakes.lastCard?.at ?? "1970-01-01T00:00:00Z");
    if (Date.now() - since < AUTO_CARD_EVERY_MS) return;
    const newMessages = memory.history.filter((turn) => turn.role === "user" && Date.parse(turn.at) > since).length;
    const newKeepsakes = keepsakes.list.filter((keepsake) => Date.parse(keepsake.addedAt) > since).length;
    if (newMessages < AUTO_CARD_MIN_MESSAGES && newKeepsakes === 0) return;
    if (Date.now() < this.#nextAutoCardAt || Math.random() > 0.1) return; // spread out, not the first minute it's allowed
    this.#nextAutoCardAt = Date.now() + AUTO_CARD_RETRY_MS;
    void this.writeCard("auto");
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  #persona(language: Language): string {
    return this.options.config.current.persona.custom?.trim() || defaultPersona(language);
  }

  /** What a chat prompt is built from: persona, what she remembers, and the moment. */
  #promptContext(language: Language, facets: readonly Facet[]): PromptContext {
    const { config, memory } = this.options;
    return {
      language,
      persona: this.#persona(language),
      now: new Date(),
      playerName: this.#state?.playerName ?? "",
      state: this.#state,
      notes: memory.notes,
      summary: memory.summary,
      lastTalked: memory.lastUserMessageAt,
      recentReplies: memory.recentReplies(2),
      maxChars: config.current.advanced.maxReplyChars,
      facets,
    };
  }

  #providerSettings(): ProviderSettings {
    const config = this.options.config.current;
    const { provider } = config;
    return { preset: provider.preset, baseUrl: provider.baseUrl, model: provider.model, apiKey: apiKeyFor(config), unloadAfterMinutes: config.advanced.unloadAfterMinutes };
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
    const { apiKeys, search } = this.options.config.current;
    for (const key of [...Object.values(apiKeys), search.apiKey]) if (key) this.options.logger.addSecret(key);
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
      spokenLanguage: this.spokenLanguage(),
      uiLocale: this.uiLocale(),
      lastError: this.lastError,
      lastVoiceError: this.lastVoiceError,
      lastTurn: this.lastTurn,
      computer: {
        mode: this.options.config.current.features.computerControl,
        enabled: computerEnabled(this.options.config.current.features.computerControl, this.#providerSettings()),
        available: this.#desktop.available,
        ...(!this.#desktop.available ? { reason: this.#desktop.reason } : {}),
        ...this.#computerCapabilities,
        browser: this.options.browser?.status() ?? { state: "absent" as const },
      },
    };
  }
}

const warmKey = (settings: Pick<ProviderSettings, "baseUrl" | "model">) => `${settings.baseUrl}|${settings.model}`;

type OllamaModel = Pick<ProviderSettings, "baseUrl" | "model">;
/** The Ollama model Lilith is set up to use, or null when she uses another kind of AI. */
const ollamaModel = ({ provider }: Config): OllamaModel | null =>
  provider.configured && getPreset(provider.preset).kind === "ollama" && provider.model ? { baseUrl: provider.baseUrl, model: provider.model } : null;

/**
 * Sentences of a reply that she already said lately. `text` leaves them out when enough is left to
 * stand on its own (a repeat beats a fragment like "O…"); `mostly` means it's worth asking again.
 */
function repeats(text: string, recent: readonly string[]): { text: string; repeated: number; mostly: boolean } {
  const repeated = repeatedSentences(text, recent);
  const fresh = withoutSentences(text, repeated);
  const enough = Array.from(fresh).length >= MIN_FRESH_CHARS;
  return { text: repeated.length > 0 && enough ? fresh : text, repeated: repeated.length, mostly: repeated.length > 0 && !enough };
}

/** The turns as the model gets them: the note for this moment goes in front of the latest message. */
const withNote = (turns: readonly ChatTurn[], context: PromptContext, found?: Found): ChatTurn[] =>
  turns.map((turn, index) => (index === turns.length - 1 ? { ...turn, content: withTurnNote(context, turn.content, found) } : turn));

export const computerEnabled = (mode: "auto" | "on" | "off", settings: Pick<ProviderSettings, "preset" | "baseUrl" | "model">): boolean =>
  mode === "on" || (mode === "auto" && audienceOf(settings) === "local");
const hotkeyLabel = (hotkey: Hotkey) => [hotkey.ctrl && "Ctrl", hotkey.alt && "Alt", hotkey.shift && "Shift", hotkey.key].filter(Boolean).join("+");

/** Label used in error messages: the preset name, or the host for custom servers. */
export function providerLabel(settings: Pick<ProviderSettings, "preset" | "baseUrl">): string {
  if (settings.preset !== "custom") return getPreset(settings.preset).label.replace(/ \((local|Claude|Grok)\)$/, "");
  try {
    return new URL(settings.baseUrl).host;
  } catch {
    return getPreset(settings.preset).label;
  }
}
