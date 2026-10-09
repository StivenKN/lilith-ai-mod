// The browser extension's connections to this companion, over the dashboard server's /api/browser
// WebSocket. Every browser with the extension connects to every companion that runs (the setup exe
// and the game's copy can both be open), so the hub pairs each one and hands turns the browser
// the player used last.
//
// Pairing: 127.0.0.1 is shared by every Windows user, and the extension's ID is public. So the
// Origin check only keeps webpages out; both sides then prove they know the secret in the
// extension folder this companion wrote (per user, in %APPDATA%). The companion proves first,
// so neither a stranger listening on the port nor another user's companion learns anything.

import type { Server, ServerWebSocket, WebSocketHandler } from "bun";
import { z } from "zod";
import type { Log } from "../log.ts";
import { ExtensionMessage, outputs, type CompanionMessage, type Inputs, type Op, type Output } from "./protocol.ts";
import { BrowserError, type BrowserLink } from "./session.ts";
import { BROWSER_PROTOCOL, EXTENSION_ID, pairingProof, randomHex, sameProof, type Handshake } from "./shared.ts";

/** `port`: where the extension reached us, which pairing proofs cover. */
export interface SocketData { id: number; port: number }

export type BrowserStatus =
  | { state: "connected"; browser: string; version: string }
  /** An extension connected but couldn't pair: loaded from another folder, or from another Windows user. */
  | { state: "unpaired"; at: string }
  | { state: "absent" };

interface Pending { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout>; op: Op }

interface Connection {
  socket: ServerWebSocket<SocketData>;
  /** `leaving`: told to reload, so its hanging up isn't a pairing failure. */
  stage: "hello" | "proof" | "ready" | "leaving";
  handshake: Handshake | null;
  browser: string;
  version: string;
  protocol: number;
  /** When a window of this browser last got focus (or it connected). */
  usedAt: number;
  pending: Map<number, Pending>;
  stops: Set<() => void>;
}

/** Long enough for a page to load after a click; a screenshot of a hidden window gives up sooner (extension). */
const CALL_TIMEOUT_MS: Record<Op, number> = {
  look: 20_000, open: 30_000, click: 20_000, type: 20_000, key: 20_000, scroll: 10_000, back: 20_000, activate: 10_000, close: 10_000, release: 5_000,
};
const HANDSHAKE_MS = 10_000;

export class BrowserHub {
  #connections = new Map<number, Connection>();
  #problem: string | null = null;
  #listeners = new Set<() => void>();
  #nextSocket = 0;
  #nextCall = 0;

  constructor(private readonly options: { secret: string; version: string; log: Log }) {}

  /** For Bun.serve's `fetch`: only the pinned extension may open /api/browser. */
  upgrade(request: Request, server: Server<SocketData>, hostOk: boolean): Response | undefined {
    if (!hostOk) return new Response("Forbidden host", { status: 403 });
    if (request.headers.get("origin") !== `chrome-extension://${EXTENSION_ID}`) return new Response("Forbidden origin", { status: 403 });
    if (server.upgrade(request, { data: { id: ++this.#nextSocket, port: server.port ?? 0 } })) return undefined;
    return new Response("WebSocket only", { status: 426 });
  }

  readonly websocket: WebSocketHandler<SocketData> = {
    open: (socket) => {
      this.#connections.set(socket.data.id, { socket, stage: "hello", handshake: null, browser: "", version: "", protocol: 0, usedAt: Date.now(), pending: new Map(), stops: new Set() });
      setTimeout(() => { if (this.#connections.get(socket.data.id)?.stage !== "ready") socket.close(4001, "pairing timed out"); }, HANDSHAKE_MS);
    },
    message: (socket, data) => void this.#receive(socket.data.id, String(data)).catch((error: unknown) => {
      this.options.log.warn(`browser message failed: ${error instanceof Error ? error.message : String(error)}`);
      socket.close(4002, "bad message");
    }),
    close: (socket) => {
      const connection = this.#connections.get(socket.data.id);
      this.#connections.delete(socket.data.id);
      if (!connection) return;
      for (const pending of connection.pending.values()) { clearTimeout(pending.timer); pending.reject(new BrowserError("failed", "the browser disconnected")); }
      // It hung up on our proof: its folder holds another secret (another copy, or another Windows user's).
      if (connection.stage === "proof") this.#unpaired(`an extension in ${connection.browser} couldn't pair: it was loaded from another folder`);
      if (connection.stage === "ready") {
        this.options.log.info(`browser disconnected (${connection.browser})`);
        this.#changed();
      }
    },
  };

  /** The paired browser the player used last, or null. */
  current(): BrowserLink | null {
    const connection = this.#latest();
    return connection ? this.#link(connection) : null;
  }

  status(): BrowserStatus {
    const connection = this.#latest();
    if (connection) return { state: "connected", browser: connection.browser, version: connection.version };
    return this.#problem ? { state: "unpaired", at: this.#problem } : { state: "absent" };
  }

  #latest(): Connection | undefined {
    return [...this.#connections.values()].filter((connection) => connection.stage === "ready").sort((a, b) => b.usedAt - a.usedAt)[0];
  }

  /** An extension connected but can't be used: the dashboard says so until one pairs. */
  #unpaired(reason: string): void {
    this.options.log.warn(reason);
    this.#problem = new Date().toISOString();
    this.#changed();
  }

  onChange(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  #changed(): void {
    for (const listener of this.#listeners) listener();
  }

  #send(connection: Connection, message: CompanionMessage): void {
    connection.socket.send(JSON.stringify(message));
  }

  async #receive(id: number, data: string): Promise<void> {
    const connection = this.#connections.get(id);
    if (!connection) return;
    const message = ExtensionMessage.parse(JSON.parse(data));
    switch (message.t) {
      case "hello": {
        if (connection.stage !== "hello") throw new Error("hello twice");
        connection.handshake = { companion: randomHex(), extension: message.nonce, port: connection.socket.data.port };
        connection.browser = message.browser;
        connection.version = message.version;
        connection.protocol = message.protocol;
        connection.stage = "proof";
        // The protocol is checked only after pairing: an older extension can still be told to reload.
        this.#send(connection, { t: "challenge", nonce: connection.handshake.companion, proof: await pairingProof(this.options.secret, "companion", connection.handshake) });
        return;
      }
      case "proof": {
        if (connection.stage !== "proof" || !connection.handshake) throw new Error("proof out of turn");
        if (!sameProof(message.proof, await pairingProof(this.options.secret, "extension", connection.handshake))) {
          this.#unpaired(`an extension in ${connection.browser} couldn't pair: it was loaded from another folder`);
          connection.stage = "leaving";
          connection.socket.close(4003, "not paired");
          return;
        }
        const reload = Bun.semver.order(connection.version, this.options.version) < 0;
        this.#send(connection, { t: "ready", reload });
        if (reload) {
          // Until it comes back current: one loaded from another folder never will, and the dashboard says so.
          this.#unpaired(`browser extension ${connection.version} is older than ${this.options.version}; it reloads`);
          connection.stage = "leaving";
          connection.socket.close(1000, "reloading");
          return;
        }
        if (connection.protocol !== BROWSER_PROTOCOL) {
          this.options.log.warn(`browser extension ${connection.version} speaks protocol ${connection.protocol}, not ${BROWSER_PROTOCOL}; update Lilith AI Companion`);
          connection.stage = "leaving";
          connection.socket.close(4004, "protocol");
          return;
        }
        connection.stage = "ready";
        connection.usedAt = Date.now();
        this.#problem = null;
        this.options.log.info(`browser connected (${connection.browser}, extension ${connection.version})`);
        this.#changed();
        return;
      }
      default:
        if (connection.stage !== "ready") throw new Error(`${message.t} before pairing`);
    }
    switch (message.t) {
      case "ping": return;
      case "focus": connection.usedAt = Date.now(); return;
      case "stopped": for (const stop of connection.stops) stop(); return;
      case "result": case "failed": {
        const pending = connection.pending.get(message.id);
        if (!pending) return;
        connection.pending.delete(message.id);
        clearTimeout(pending.timer);
        if (message.t === "failed") pending.reject(new BrowserError(message.code, message.detail, message.element));
        else {
          const output = (outputs[pending.op] as z.ZodType).safeParse(message.output);
          if (output.success) pending.resolve(output.data);
          else pending.reject(new BrowserError("failed", `unexpected answer from the extension: ${z.prettifyError(output.error).slice(0, 300)}`));
        }
      }
    }
  }

  #link(connection: Connection): BrowserLink {
    return {
      call: <K extends Op>(op: K, input: Inputs[K], signal?: AbortSignal) => new Promise<Output<K>>((resolve, reject) => {
        if (signal?.aborted) return reject(signal.reason);
        if (!this.#connections.has(connection.socket.data.id)) return reject(new BrowserError("failed", "the browser disconnected"));
        const id = ++this.#nextCall;
        const done = () => { connection.pending.delete(id); signal?.removeEventListener("abort", abort); };
        // A stopped turn's calls must not happen later: the extension drops it if it hasn't started.
        const abort = () => { clearTimeout(timer); done(); this.#send(connection, { t: "cancel", id }); reject(signal?.reason); };
        const timer = setTimeout(() => { done(); reject(new BrowserError("failed", "the browser didn't answer in time")); }, CALL_TIMEOUT_MS[op]);
        connection.pending.set(id, {
          op,
          resolve: (value) => { done(); resolve(value as Output<K>); },
          reject: (error) => { done(); reject(error); },
          timer,
        });
        signal?.addEventListener("abort", abort, { once: true });
        this.#send(connection, { t: "call", id, op, input, deadline: Date.now() + CALL_TIMEOUT_MS[op] } as CompanionMessage);
      }),
      onStop: (listener) => {
        connection.stops.add(listener);
        return () => connection.stops.delete(listener);
      },
    };
  }
}

