// Shared by the companion and the browser extension, which bundles this file. It has no
// dependencies, so the extension stays small and readable.

/** Bump for breaking changes to protocol.ts. An older extension reloads itself from the folder the companion keeps current. */
export const BROWSER_PROTOCOL = 1;

/** Pinned by the public `key` in the extension's manifest (extension/build.ts). Unpacked extensions don't need the private key. */
export const EXTENSION_ID = "bfcodagkdinmohamlmnlgpbalbkfbhbl";

/** Each companion serves its dashboard on the first free one, so the extension looks for companions here. */
export const DASHBOARD_PORTS: readonly number[] = Array.from({ length: 20 }, (_, i) => 47321 + i);

/**
 * Lilith's own dashboard. A browser tab shares its saved login, so a page that talked her into
 * opening it could have her change the AI server and send the API keys elsewhere. Never opened.
 */
export function isDashboard(url: URL): boolean {
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  const loopback = host === "localhost" || host.endsWith(".localhost") || /^127\.\d+\.\d+\.\d+$/.test(host) || host === "::1" || host === "0.0.0.0";
  const port = Number(url.port || (url.protocol === "https:" ? 443 : 80));
  return loopback && DASHBOARD_PORTS.includes(port);
}

const hex = (bytes: Uint8Array) => Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");

/** 128 random bits as hex: pairing nonces, and the secret itself (with more bytes). */
export const randomHex = (bytes = 16) => hex(crypto.getRandomValues(new Uint8Array(bytes)));

/** What a pairing proof covers besides the secret: both nonces, and the port the extension dialed. */
export interface Handshake { companion: string; extension: string; port: number }

/**
 * Shows that one side knows the pairing secret without sending it: HMAC-SHA256 over the side's
 * role, both nonces and the companion's port. So a proof can't be replayed in the other direction
 * or another session, and can't be relayed: a stranger on another port passing our hello to the
 * real companion gets back a proof for the real companion's port, which the extension refuses.
 * WebCrypto runs the same in Bun and in the extension's service worker.
 */
export async function pairingProof(secret: string, role: "companion" | "extension", handshake: Handshake): Promise<string> {
  const encode = (text: string) => new TextEncoder().encode(text);
  const key = await crypto.subtle.importKey("raw", encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return hex(new Uint8Array(await crypto.subtle.sign("HMAC", key, encode(`${role}\n${handshake.companion}\n${handshake.extension}\n${handshake.port}`))));
}

/** Compares proofs in constant time. */
export function sameProof(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let difference = 0;
  for (let i = 0; i < a.length; i++) difference |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return difference === 0;
}
