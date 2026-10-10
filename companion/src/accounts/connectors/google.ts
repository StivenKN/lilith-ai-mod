// One Google sign-in serves three facets: Gmail, Drive and Calendar, each read-only. The mod owns
// one "Desktop app" OAuth client whose id and secret are injected at build time (build.ts) and read
// from the environment in development. Access tokens live in memory with their expiry; the refresh
// token is the only thing on disk. Every response is parsed with Zod here, so nothing past this file
// sees Google's JSON.

import { z } from "zod";
import { privateFacets, type PrivateFacet } from "../../lookup/facets.ts";
import type { Query } from "../../lookup/query.ts";
import { LookupError, type Hit, type Reader } from "../../lookup/sources.ts";
import type { AccountId, Connector, OpenAccount } from "../account.ts";

const TIMEOUT_MS = 10_000;
const MAX_RESULTS = 5;
/** Most of a document read in full; the shelf trims it further to the audience's budget. */
const READ_MAX_BYTES = 64 * 1024;
/** A full message larger than this (inline pictures, a long thread) is not read; its snippet stands in. */
const FULL_MESSAGE_MAX_BYTES = 256 * 1024;
/** Without a day in the query, the calendar is read from now to two months ahead: "what are my plans?" means what is coming. */
const CALENDAR_AHEAD_DAYS = 60;

/** Set at build time through `bun build --define`; in development, from the shell. Neither value lives in the repo. */
export function googleClient(): { id: string; secret: string } | null {
  const id = process.env.LILITH_GOOGLE_CLIENT_ID;
  const secret = process.env.LILITH_GOOGLE_CLIENT_SECRET;
  return id && secret ? { id, secret } : null;
}

export const GOOGLE_SCOPE_OF = {
  mail: "https://www.googleapis.com/auth/gmail.readonly",
  files: "https://www.googleapis.com/auth/drive.readonly",
  calendar: "https://www.googleapis.com/auth/calendar.readonly",
} as const satisfies Record<PrivateFacet, string>;
const SCOPES = ["openid", "email", ...privateFacets.map((facet) => GOOGLE_SCOPE_OF[facet])];

/** Google's endpoints, or one local base for the mock and the tests (`LILITH_AI_GOOGLE_URL`). */
function endpoints() {
  const base = process.env.LILITH_AI_GOOGLE_URL?.replace(/\/+$/, "");
  if (base) return { auth: `${base}/auth`, token: `${base}/token`, revoke: `${base}/revoke`, userinfo: `${base}/userinfo`, gmail: `${base}/gmail/v1`, drive: `${base}/drive/v3`, calendar: `${base}/calendar/v3` };
  return {
    auth: "https://accounts.google.com/o/oauth2/v2/auth",
    token: "https://oauth2.googleapis.com/token",
    revoke: "https://oauth2.googleapis.com/revoke",
    userinfo: "https://openidconnect.googleapis.com/v1/userinfo",
    gmail: "https://gmail.googleapis.com/gmail/v1",
    drive: "https://www.googleapis.com/drive/v3",
    calendar: "https://www.googleapis.com/calendar/v3",
  };
}

const Settings = z.object({ user: z.string() });
const Secret = z.object({ refreshToken: z.string().min(1) });
type Settings = z.infer<typeof Settings>;
type Secret = z.infer<typeof Secret>;
type Account = OpenAccount<Settings, Secret>;

const TokenResponse = z.object({ access_token: z.string().min(1), expires_in: z.number().default(3600), refresh_token: z.string().optional(), scope: z.string().default("") });
const TokenError = z.object({ error: z.string(), error_description: z.string().optional() });
const UserInfo = z.object({ email: z.string().min(1) });

/** Access tokens by account, refreshed lazily inside a lookup. Never written to disk. */
const tokens = new Map<AccountId, { token: string; expiresAt: number }>();

/** Google's token and revoke endpoints take form bodies. Errors come back as LookupErrors so a turn never throws. */
async function postForm(url: string, form: Record<string, string>, signal: AbortSignal): Promise<unknown> {
  const timeout = AbortSignal.timeout(TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetch(url, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(form), signal: AbortSignal.any([signal, timeout]) });
  } catch (error) {
    if (signal.aborted) throw error;
    throw new LookupError(timeout.aborted ? "timeout" : "unreachable", `Could not reach ${url.split("?")[0]} (${error instanceof Error ? error.message : String(error)})`);
  }
  const json: unknown = await response.json().catch(() => null);
  if (response.ok) return json;
  const failure = TokenError.safeParse(json);
  const reason = failure.success ? failure.data.error : `HTTP ${response.status}`;
  // The refresh token was revoked, expired (7 days in Testing status) or belongs to another client.
  throw new LookupError(reason === "invalid_grant" ? "reconnect" : "unreachable", `Google answered ${reason}${failure.success && failure.data.error_description ? `: ${failure.data.error_description}` : ""}`);
}

async function accessToken(account: Account, signal: AbortSignal): Promise<string> {
  const cached = tokens.get(account.id);
  if (cached && cached.expiresAt > Date.now() + 30_000) return cached.token;
  const client = googleClient();
  if (!client) throw new LookupError("unreachable", "This build has no Google client");
  const json = await postForm(endpoints().token, { grant_type: "refresh_token", refresh_token: account.secret.refreshToken, client_id: client.id, client_secret: client.secret }, signal);
  const parsed = TokenResponse.safeParse(json);
  if (!parsed.success) throw new LookupError("unreachable", "Unexpected token response from Google");
  tokens.set(account.id, { token: parsed.data.access_token, expiresAt: Date.now() + parsed.data.expires_in * 1000 });
  return parsed.data.access_token;
}

/**
 * One authenticated GET. A 401 refreshes the token once. A second one, or a 403, passes: Google
 * answers 403 for rate limits, a disabled API, a missing scope and export limits, so only a dead
 * refresh token (`invalid_grant`, from the refresh itself) means the account must be connected again.
 */
async function call(account: Account, url: string, signal: AbortSignal, retry = true): Promise<Response> {
  const token = await accessToken(account, signal);
  const timeout = AbortSignal.timeout(TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetch(url, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.any([signal, timeout]) });
  } catch (error) {
    if (signal.aborted) throw error;
    throw new LookupError(timeout.aborted ? "timeout" : "unreachable", `Could not reach Google (${error instanceof Error ? error.message : String(error)})`);
  }
  if (response.status === 401 && retry) {
    tokens.delete(account.id);
    return call(account, url, signal, false);
  }
  if (!response.ok) throw new LookupError(response.status >= 500 ? "unreachable" : "unreadable", `Google answered HTTP ${response.status}`);
  return response;
}

const getJson = async (account: Account, url: string, signal: AbortSignal): Promise<unknown> => (await call(account, url, signal)).json();

/** Reads at most `maxBytes` of a body, so a huge export never sits in memory whole, and says whether that was all of it. */
async function readBody(response: Response, maxBytes: number): Promise<{ bytes: Uint8Array; complete: boolean }> {
  const reader = response.body?.getReader();
  if (!reader) return { bytes: new Uint8Array(), complete: true };
  const chunks: Uint8Array[] = [];
  let size = 0;
  let complete = false;
  while (size <= maxBytes) {
    const { done, value } = await reader.read();
    if (done) {
      complete = true;
      break;
    }
    chunks.push(value);
    size += value.length;
  }
  await reader.cancel().catch(() => {});
  return { bytes: Buffer.concat(chunks).subarray(0, maxBytes), complete };
}

async function getText(account: Account, url: string, signal: AbortSignal): Promise<string> {
  const { bytes } = await readBody(await call(account, url, signal), READ_MAX_BYTES);
  return new TextDecoder().decode(bytes);
}

const parseOr = <T>(schema: z.ZodType<T>, json: unknown, what: string): T => {
  const parsed = schema.safeParse(json);
  if (!parsed.success) throw new LookupError("unreadable", `Unexpected ${what} response from Google`);
  return parsed.data;
};

const jsonOf = (bytes: Uint8Array): unknown => {
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return null;
  }
};

const ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ",
  aacute: "á", eacute: "é", iacute: "í", oacute: "ó", uacute: "ú", ntilde: "ñ", uuml: "ü",
  Aacute: "Á", Eacute: "É", Iacute: "Í", Oacute: "Ó", Uacute: "Ú", Ntilde: "Ñ", Uuml: "Ü",
  iexcl: "¡", iquest: "¿", ordf: "ª", ordm: "º", deg: "°", euro: "€", copy: "©", reg: "®",
  hellip: "…", ndash: "–", mdash: "—", lsquo: "‘", rsquo: "’", ldquo: "“", rdquo: "”", laquo: "«", raquo: "»",
};

/** Gmail escapes snippets like HTML text, and HTML bodies carry named and numeric entities. */
const decodeEntities = (text: string): string =>
  text.replace(/&(?:#(\d+)|#x([0-9a-f]+)|(\w+));/gi, (match, decimal: string | undefined, hex: string | undefined, name: string | undefined) => {
    const code = decimal ? Number(decimal) : hex ? parseInt(hex, 16) : null;
    if (code !== null) return code <= 0x10ffff ? String.fromCodePoint(code) : match;
    return (name && ENTITIES[name]) ?? match;
  });

const stripHtml = (html: string): string =>
  decodeEntities(html.replace(/<style[\s\S]*?<\/style>|<script[\s\S]*?<\/script>/gi, "").replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();

/** Bytes in the charset a mail part declares; an unknown label reads as UTF-8. */
function decodeText(bytes: Uint8Array, charset: string | undefined): string {
  try {
    return new TextDecoder(charset ?? "utf-8").decode(bytes);
  } catch {
    return new TextDecoder().decode(bytes);
  }
}

const pad = (n: number) => String(n).padStart(2, "0");
const localDate = (date: Date) => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
const localDateTime = (date: Date) => `${localDate(date)} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
const gmailDate = (date: Date) => `${date.getFullYear()}/${pad(date.getMonth() + 1)}/${pad(date.getDate())}`;

// ── Gmail ────────────────────────────────────────────────────────────────────────

const GmailList = z.object({ messages: z.array(z.object({ id: z.string() })).default([]) });
const GmailHeaders = z.object({ payload: z.object({ headers: z.array(z.object({ name: z.string(), value: z.string() })).default([]) }).optional(), snippet: z.string().default(""), internalDate: z.string().optional() });
const Header = z.object({ name: z.string(), value: z.string() });
interface GmailPart { mimeType?: string | undefined; headers?: z.infer<typeof Header>[] | undefined; body?: { data?: string | undefined } | undefined; parts?: GmailPart[] | undefined }
const GmailPart: z.ZodType<GmailPart> = z.lazy(() => z.object({ mimeType: z.string().optional(), headers: z.array(Header).optional(), body: z.object({ data: z.string().optional() }).optional(), parts: z.array(GmailPart).optional() }));
const GmailFull = z.object({ payload: GmailPart.optional() });

/**
 * The first part of the wanted type, depth first (a multipart/alternative mail holds text/plain
 * before text/html), in the charset its own Content-Type declares: Latin-1 senders are still common.
 */
function partText(part: GmailPart | undefined, mimeType: string): string | null {
  if (!part) return null;
  if (part.mimeType === mimeType && part.body?.data) {
    const contentType = part.headers?.find((header) => header.name.toLowerCase() === "content-type")?.value ?? "";
    return decodeText(Buffer.from(part.body.data, "base64url"), /charset="?([\w-]+)"?/i.exec(contentType)?.[1]);
  }
  for (const child of part.parts ?? []) {
    const text = partText(child, mimeType);
    if (text !== null) return text;
  }
  return null;
}

/** "Laura Pérez <laura@example.com>" shows as Laura Pérez; a bare address stays an address. */
const senderName = (from: string): string => /^\s*"?([^"<]+?)"?\s*</.exec(from)?.[1] ?? from.trim();

function mailSource(account: Account): Reader {
  const base = `${endpoints().gmail}/users/me/messages`;
  return {
    facet: "mail",
    label: account.label,
    async search(query, signal) {
      const q = [query.text, query.from && `from:${query.from}`, query.window && `after:${gmailDate(query.window.since)}`, query.window && `before:${gmailDate(query.window.until)}`].filter(Boolean).join(" ");
      const list = parseOr(GmailList, await getJson(account, `${base}?${new URLSearchParams({ q, maxResults: String(MAX_RESULTS) })}`, signal), "mail list");
      const hits = await Promise.all(list.messages.map(async ({ id }): Promise<Hit> => {
        const url = `${base}/${encodeURIComponent(id)}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`;
        const message = parseOr(GmailHeaders, await getJson(account, url, signal), "mail");
        const header = (name: string) => message.payload?.headers.find((entry) => entry.name.toLowerCase() === name)?.value ?? "";
        const at = Number(message.internalDate) || Date.parse(header("date")) || 0;
        const snippet = decodeEntities(message.snippet);
        return {
          title: header("subject") || "(no subject)",
          meta: [senderName(header("from")), at ? localDateTime(new Date(at)) : ""].filter(Boolean).join(", "),
          excerpt: snippet,
          at,
          read: async (signal) => {
            const { bytes, complete } = await readBody(await call(account, `${base}/${encodeURIComponent(id)}?format=full`, signal), FULL_MESSAGE_MAX_BYTES);
            if (!complete) return snippet;
            const full = parseOr(GmailFull, jsonOf(bytes), "mail body");
            const plain = partText(full.payload, "text/plain");
            if (plain !== null) return plain;
            const html = partText(full.payload, "text/html");
            return html !== null ? stripHtml(html) : snippet;
          },
        };
      }));
      return hits;
    },
  };
}

// ── Drive ────────────────────────────────────────────────────────────────────────

const DriveList = z.object({ files: z.array(z.object({ id: z.string(), name: z.string(), mimeType: z.string(), modifiedTime: z.string().optional() })).default([]) });

/** How a native Drive file is read in full: Docs and Slides export as text, Sheets as CSV. Anything else is named only. */
const driveExports = new Map([
  ["application/vnd.google-apps.document", { kind: "Google Docs", as: "text/plain" }],
  ["application/vnd.google-apps.presentation", { kind: "Google Slides", as: "text/plain" }],
  ["application/vnd.google-apps.spreadsheet", { kind: "Google Sheets", as: "text/csv" }],
]);

const driveKind = (mimeType: string): string =>
  driveExports.get(mimeType)?.kind ?? (mimeType === "application/vnd.google-apps.folder" ? "folder" : mimeType.split("/")[1] ?? mimeType);

/** Drive's query language quotes with single quotes and escapes with backslashes. */
const driveEscape = (text: string) => text.replace(/\\/g, "\\\\").replace(/'/g, "\\'");

function filesSource(account: Account): Reader {
  const base = `${endpoints().drive}/files`;
  return {
    facet: "files",
    label: account.label,
    async search(query, signal) {
      const terms = ["trashed = false", query.text && `fullText contains '${driveEscape(query.text)}'`].filter(Boolean).join(" and ");
      const params = new URLSearchParams({ q: terms, fields: "files(id,name,mimeType,modifiedTime)", pageSize: String(MAX_RESULTS), ...(query.text ? {} : { orderBy: "modifiedTime desc" }) });
      const list = parseOr(DriveList, await getJson(account, `${base}?${params}`, signal), "file list");
      return list.files.map((file): Hit => {
        const at = file.modifiedTime ? Date.parse(file.modifiedTime) : 0;
        const exported = driveExports.get(file.mimeType);
        const id = encodeURIComponent(file.id);
        const readUrl = exported ? `${base}/${id}/export?mimeType=${encodeURIComponent(exported.as)}` : file.mimeType.startsWith("text/") ? `${base}/${id}?alt=media` : null;
        return {
          title: file.name,
          meta: [driveKind(file.mimeType), at ? localDate(new Date(at)) : ""].filter(Boolean).join(", "),
          excerpt: "",
          at,
          ...(readUrl ? { read: (signal: AbortSignal) => getText(account, readUrl, signal) } : {}),
        };
      });
    },
  };
}

// ── Calendar ─────────────────────────────────────────────────────────────────────

const CalendarTime = z.object({ dateTime: z.string().optional(), date: z.string().optional() });
const CalendarList = z.object({ items: z.array(z.object({ summary: z.string().optional(), start: CalendarTime.optional(), end: CalendarTime.optional(), location: z.string().optional(), description: z.string().optional() })).default([]) });

/** An all-day event has a date; a timed one a dateTime. Both read in local time. */
function eventStart(time: z.infer<typeof CalendarTime> | undefined): { at: number; text: string } {
  if (time?.dateTime) {
    const at = Date.parse(time.dateTime);
    return { at, text: localDateTime(new Date(at)) };
  }
  if (time?.date) {
    const [y = 0, m = 1, d = 1] = time.date.split("-").map(Number);
    return { at: new Date(y, m - 1, d).getTime(), text: time.date };
  }
  return { at: 0, text: "" };
}

function calendarSource(account: Account): Reader {
  return {
    facet: "calendar",
    label: account.label,
    async search(query, signal) {
      const now = new Date();
      const window = query.window ?? { since: now, until: new Date(now.getTime() + CALENDAR_AHEAD_DAYS * 86400_000) };
      const params = new URLSearchParams({ singleEvents: "true", orderBy: "startTime", timeMin: window.since.toISOString(), timeMax: window.until.toISOString(), maxResults: "10", ...(query.text ? { q: query.text } : {}) });
      const list = parseOr(CalendarList, await getJson(account, `${endpoints().calendar}/calendars/primary/events?${params}`, signal), "calendar");
      return list.items.map((event): Hit => {
        const start = eventStart(event.start);
        return { title: event.summary || "(untitled)", meta: start.text, excerpt: [event.location, event.description].filter(Boolean).join(". ").slice(0, 300), at: start.at };
      });
    },
  };
}

const sourceFor = { mail: mailSource, files: filesSource, calendar: calendarSource } as const satisfies Record<PrivateFacet, (account: Account) => Reader>;

export const google: Connector<Settings, Secret> = {
  facets: privateFacets,
  settings: Settings,
  secret: Secret,
  secretsOf: (secret) => Object.values(secret).filter((value): value is string => typeof value === "string"),

  consentUrl({ redirectUri, state, codeChallenge }) {
    const client = googleClient();
    if (!client) return null;
    const url = new URL(endpoints().auth);
    url.search = new URLSearchParams({
      response_type: "code",
      client_id: client.id,
      redirect_uri: redirectUri,
      scope: SCOPES.join(" "),
      code_challenge: codeChallenge,
      code_challenge_method: "S256",
      state,
      access_type: "offline",
      // Every sign-in asks for every scope afresh. Incremental grants would bring back a scope the
      // player unticked this time from an earlier grant that still stands.
      prompt: "consent",
    }).toString();
    return url.href;
  },

  async finish({ code, redirectUri, codeVerifier }, signal) {
    const client = googleClient();
    if (!client) throw new Error("This build has no Google client");
    const token = TokenResponse.safeParse(await postForm(endpoints().token, { grant_type: "authorization_code", code, redirect_uri: redirectUri, code_verifier: codeVerifier, client_id: client.id, client_secret: client.secret }, signal));
    if (!token.success) throw new Error("Unexpected token response from Google");
    if (!token.data.refresh_token) throw new Error("Google did not send a refresh token. Remove Lilith AI under your Google account's third-party access and sign in again.");
    // Granular consent: the account's facets are only the scopes Google actually granted.
    const granted = new Set(token.data.scope.split(/\s+/));
    const facets = privateFacets.filter((facet) => granted.has(GOOGLE_SCOPE_OF[facet]));
    if (facets.length === 0) throw new Error("No access was granted. Tick at least one of Gmail, Drive or Calendar on Google's page.");
    const who = await fetch(endpoints().userinfo, { headers: { authorization: `Bearer ${token.data.access_token}` }, signal: AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT_MS)]) });
    const user = UserInfo.safeParse(await who.json().catch(() => null));
    if (!who.ok || !user.success) throw new Error("Google did not say which account signed in");
    return { settings: { user: user.data.email }, secret: { refreshToken: token.data.refresh_token }, label: user.data.email, facets };
  },

  async revoke(secret, signal) {
    await postForm(endpoints().revoke, { token: secret.refreshToken }, signal);
  },

  open(account) {
    return account.facets.map((facet) => sourceFor[facet](account));
  },
};
