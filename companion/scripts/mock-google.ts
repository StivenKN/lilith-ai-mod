// A fake Google for development and tests: the OAuth consent page, token, userinfo and revoke
// endpoints, and enough of the Gmail, Drive and Calendar APIs for the companion's lookups.
//   bun scripts/mock-google.ts [port]        (default 11556)
// Then run the companion with LILITH_AI_GOOGLE_URL=http://127.0.0.1:11556 and any client id and
// secret in LILITH_GOOGLE_CLIENT_ID / LILITH_GOOGLE_CLIENT_SECRET. The consent page has an "Allow"
// link back to the redirect URI (code and state) and a "Deny" link (error=access_denied).
// Fixtures: Laura's "Fotos del viaje" from yesterday, the landlord's "Re: arriendo de octubre"
// (HTML only), an Amazon shipping mail, a Steam Guard code, a bank statement in Latin-1, a huge
// newsletter, a Sheet "Presupuesto octubre", a Doc "CV Alex",
// a text file "notas.txt", a calendar event "Dentista" tomorrow at 15:00 and a "Reunión de equipo"
// yesterday at 9:00.

/** A local time `days` from today at `hour`, so "ayer" and "mañana" mean the same whenever the mock runs. */
const dayAt = (days: number, hour: number) => {
  const date = new Date();
  date.setDate(date.getDate() + days);
  date.setHours(hour, 0, 0, 0);
  return date;
};

/** `htmlOnly`: no text/plain part, like a newsletter. `charset`: the text/plain part's bytes, like an older corporate sender. */
const mails: Array<{ id: string; from: string; subject: string; at: number; text: string; htmlOnly?: true; charset?: "iso-8859-1" }> = [
  { id: "m-laura", from: "Laura Pérez <laura@example.com>", subject: "Fotos del viaje", at: dayAt(-1, 10).getTime(), text: "Hola Alex, te mando las fotos del viaje a Cartagena. Están en https://photos.example.com/viaje-2026 y hay una tuya en el muelle que te va a gustar. ¡Nos vemos el sábado!" },
  { id: "m-casero", from: "Jorge Ramírez <casero@example.com>", subject: "Re: arriendo de octubre", at: dayAt(-3, 18).getTime(), text: "Hola Alex, sí, el pago del arriendo de octubre ya llegó. Gracias por la puntualidad. Saludos, Jorge", htmlOnly: true },
  { id: "m-amazon", from: "Amazon.com <shipment-tracking@amazon.com>", subject: "Your package has shipped", at: dayAt(-2, 9).getTime(), text: "Your package with Logitech MX Keys is on its way and will arrive Friday. Track it at https://www.amazon.com/track/123" },
  { id: "m-steam", from: "Steam Support <noreply@steampowered.com>", subject: "Your Steam Guard code", at: dayAt(0, 0).getTime() + 30 * 60_000, text: "Your Steam Guard code is 7KQ2M. If you did not request this code, change your password." },
  { id: "m-banco", from: "Banco Andino <alertas@bancoandino.com>", subject: "Tu extracto de septiembre", at: dayAt(-4, 8).getTime(), text: "Hola Alex, tu extracto de septiembre ya está disponible. Saldo: $1'250.000. ¡Gracias por confiar en nosotros!", charset: "iso-8859-1" },
  { id: "m-boletin", from: "Universidad <boletin@uni.example.com>", subject: "Boletín semanal", at: dayAt(-5, 7).getTime(), text: "Boletín semanal de la universidad. ".repeat(10_000) },
];

/** Gmail escapes snippets like HTML text, and HTML bodies arrive with named and numeric entities. */
const escapeText = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
const NAMED: Record<string, string> = { á: "&aacute;", é: "&eacute;", í: "&iacute;", ó: "&oacute;", ú: "&uacute;", ñ: "&ntilde;", "¡": "&iexcl;" };
const escapeHtml = (text: string) => escapeText(text).replace(/[^\x20-\x7e]/g, (char) => NAMED[char] ?? `&#${char.codePointAt(0)};`);
const partOf = (mimeType: string, text: string, charset: "iso-8859-1" | "utf-8") =>
  ({ mimeType, headers: [{ name: "Content-Type", value: `${mimeType}; charset="${charset.toUpperCase()}"` }], body: { data: Buffer.from(text, charset === "iso-8859-1" ? "latin1" : "utf8").toString("base64url") } });

const files = [
  { id: "f-presupuesto", name: "Presupuesto octubre", mimeType: "application/vnd.google-apps.spreadsheet", at: dayAt(-1, 20).getTime(), text: "Concepto,Monto\nArriendo,1200000\nMercado,450000\nInternet,90000\nAhorro,300000" },
  { id: "f-cv", name: "CV Alex", mimeType: "application/vnd.google-apps.document", at: dayAt(-17, 12).getTime(), text: "Alex Rivera\nDesarrollador de software\n\nExperiencia\nGlobant, desarrollador senior, 2023 a 2026. Lideré el equipo de pagos.\nRappi, desarrollador, 2020 a 2023." },
  { id: "f-notas", name: "notas.txt", mimeType: "text/plain", at: dayAt(0, 0).getTime() + 15 * 60_000, text: "Comprar pilas y leche. Llamar a mamá el domingo." },
];

const dentist = dayAt(1, 15);
const standup = dayAt(-1, 9);
const events = [
  { id: "e-dentista", summary: "Dentista", start: dentist, end: new Date(dentist.getTime() + 3600_000), location: "Clínica Sonrisa, calle 85" },
  { id: "e-standup", summary: "Reunión de equipo", start: standup, end: new Date(standup.getTime() + 1800_000), location: "Meet" },
];

const fold = (text: string) => text.toLowerCase().normalize("NFD").replace(/\p{M}/gu, "");
const words = (text: string) => fold(text).split(/[^\p{L}\p{N}]+/u).filter(Boolean);
const contains = (haystack: string, needles: string[]) => needles.every((word) => fold(haystack).includes(word));
/** Gmail reads after:2026/10/08 in the user's time zone, so the mock does too. */
const gmailDay = (ymd: string) => {
  const [y = 0, m = 1, d = 1] = ymd.split("/").map(Number);
  return new Date(y, m - 1, d).getTime();
};

export interface MockGoogle {
  port: number;
  url: string;
  /** How many refresh-token grants the companion asked for. */
  refreshes: number;
  /** Which scopes the next consent grants, when the player unticks some. */
  grantOnly(scopes: string[] | null): void;
  /** Every access token stops working, as after an hour. */
  expireTokens(): void;
  /** Every refresh token stops working, as after the player removes the app from their Google account. */
  revokeRefreshTokens(): void;
  /** Every API call answers this status (a rate limit, a disabled API) until cleared with null. */
  deny(status: 401 | 403 | null): void;
  stop(): void;
}

export function startMockGoogle(port = 0): MockGoogle {
  const pending = new Map<string, { challenge: string; scopes: string }>();
  const accessTokens = new Map<string, number>();
  const refreshTokens = new Set<string>();
  let grant: string[] | null = null;
  let denied: 401 | 403 | null = null;
  let issued = 0;
  const mock = { refreshes: 0 };

  const issue = (scopes: string) => {
    const access = `ya29.mock-${++issued}`;
    accessTokens.set(access, Date.now() + 3600_000);
    return { access_token: access, expires_in: 3599, scope: scopes, token_type: "Bearer" };
  };
  const bearer = (request: Request) => {
    const token = /^Bearer (.+)$/.exec(request.headers.get("authorization") ?? "")?.[1];
    return token !== undefined && (accessTokens.get(token) ?? 0) > Date.now();
  };
  const unauthorized = () => Response.json({ error: { code: 401, message: "Invalid Credentials", status: "UNAUTHENTICATED" } }, { status: 401 });
  const notFound = () => Response.json({ error: { code: 404, message: "Not found" } }, { status: 404 });

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port,
    async fetch(request) {
      const url = new URL(request.url);
      const path = url.pathname;
      const query = url.searchParams;

      if (path === "/auth") {
        const required = { response_type: "code", code_challenge_method: "S256", access_type: "offline" };
        for (const [key, value] of Object.entries(required)) if (query.get(key) !== value) return new Response(`Bad request: ${key} must be ${value}`, { status: 400 });
        const redirect = query.get("redirect_uri"), state = query.get("state"), challenge = query.get("code_challenge");
        if (!redirect || !state || !challenge || !query.get("client_id")) return new Response("Bad request: missing parameters", { status: 400 });
        const code = `4/mock-${++issued}`;
        const asked = (query.get("scope") ?? "").split(/\s+/).filter(Boolean);
        pending.set(code, { challenge, scopes: (grant ? asked.filter((scope) => grant!.includes(scope)) : asked).join(" ") });
        const back = (params: Record<string, string>) => `${redirect}?${new URLSearchParams({ ...params, state })}`;
        return new Response(`<!doctype html><title>Mock Google</title><h1>Lilith AI wants to read your Gmail, Drive and Calendar</h1><p><a id="allow" href="${back({ code })}">Allow</a> <a id="deny" href="${back({ error: "access_denied" })}">Deny</a></p>`, { headers: { "content-type": "text/html; charset=utf-8" } });
      }

      if (path === "/token" && request.method === "POST") {
        const form = new URLSearchParams(await request.text());
        if (!form.get("client_id") || !form.get("client_secret")) return Response.json({ error: "invalid_client" }, { status: 401 });
        if (form.get("grant_type") === "authorization_code") {
          const flow = pending.get(form.get("code") ?? "");
          pending.delete(form.get("code") ?? "");
          const verifier = form.get("code_verifier") ?? "";
          const challenge = new Bun.CryptoHasher("sha256").update(verifier).digest("base64url");
          if (!flow || challenge !== flow.challenge) return Response.json({ error: "invalid_grant", error_description: "Bad code or verifier" }, { status: 400 });
          const refresh = `1//mock-refresh-${++issued}`;
          refreshTokens.add(refresh);
          return Response.json({ ...issue(flow.scopes), refresh_token: refresh });
        }
        if (form.get("grant_type") === "refresh_token") {
          mock.refreshes++;
          if (!refreshTokens.has(form.get("refresh_token") ?? "")) return Response.json({ error: "invalid_grant", error_description: "Token has been expired or revoked." }, { status: 400 });
          return Response.json(issue(form.get("scope") ?? ""));
        }
        return Response.json({ error: "unsupported_grant_type" }, { status: 400 });
      }

      if (path === "/revoke" && request.method === "POST") {
        const form = new URLSearchParams(await request.text());
        refreshTokens.delete(form.get("token") ?? "");
        return Response.json({});
      }

      if (!bearer(request)) return unauthorized();
      if (denied) return Response.json({ error: { code: denied, message: denied === 403 ? "Rate Limit Exceeded" : "Invalid Credentials" } }, { status: denied });

      if (path === "/userinfo") return Response.json({ sub: "1", email: "alex@gmail.com", email_verified: true });

      if (path === "/gmail/v1/users/me/messages") {
        const terms = (query.get("q") ?? "").split(/\s+/).filter(Boolean);
        const matching = mails.filter((mail) => terms.every((term) => {
          if (term.startsWith("from:")) return fold(mail.from).includes(fold(term.slice(5)));
          if (term.startsWith("after:")) return mail.at >= gmailDay(term.slice(6));
          if (term.startsWith("before:")) return mail.at < gmailDay(term.slice(7));
          return contains(`${mail.from} ${mail.subject} ${mail.text}`, words(term));
        })).sort((a, b) => b.at - a.at).slice(0, Number(query.get("maxResults") ?? 100));
        return Response.json({ messages: matching.map((mail) => ({ id: mail.id, threadId: mail.id })), resultSizeEstimate: matching.length });
      }
      const message = /^\/gmail\/v1\/users\/me\/messages\/([^/]+)$/.exec(path);
      if (message) {
        const mail = mails.find((candidate) => candidate.id === message[1]);
        if (!mail) return notFound();
        const headers = [{ name: "From", value: mail.from }, { name: "Subject", value: mail.subject }, { name: "Date", value: new Date(mail.at).toUTCString() }];
        const snippet = escapeText(mail.text.slice(0, 100));
        if (query.get("format") === "full") {
          const parts = [
            ...(mail.htmlOnly ? [] : [partOf("text/plain", mail.text, mail.charset ?? "utf-8")]),
            partOf("text/html", `<div>${escapeHtml(mail.text)}</div>`, "utf-8"),
          ];
          return Response.json({ id: mail.id, threadId: mail.id, snippet, internalDate: String(mail.at), payload: { mimeType: "multipart/alternative", headers, parts } });
        }
        return Response.json({ id: mail.id, threadId: mail.id, snippet, internalDate: String(mail.at), payload: { mimeType: "multipart/alternative", headers } });
      }

      if (path === "/drive/v3/files") {
        const needle = /fullText contains '((?:[^'\\]|\\.)*)'/.exec(query.get("q") ?? "")?.[1]?.replace(/\\(.)/g, "$1") ?? "";
        const matching = files.filter((file) => contains(`${file.name} ${file.text}`, words(needle))).sort((a, b) => b.at - a.at).slice(0, Number(query.get("pageSize") ?? 100));
        return Response.json({ files: matching.map((file) => ({ id: file.id, name: file.name, mimeType: file.mimeType, modifiedTime: new Date(file.at).toISOString() })) });
      }
      const file = /^\/drive\/v3\/files\/([^/]+)(\/export)?$/.exec(path);
      if (file) {
        const found = files.find((candidate) => candidate.id === file[1]);
        if (!found) return notFound();
        if (file[2] && !found.mimeType.startsWith("application/vnd.google-apps.")) return Response.json({ error: { code: 403, message: "Export only supports Google Docs." } }, { status: 403 });
        if (!file[2] && query.get("alt") !== "media") return Response.json({ id: found.id, name: found.name, mimeType: found.mimeType });
        return new Response(found.text, { headers: { "content-type": `${file[2] ? query.get("mimeType") ?? "text/plain" : found.mimeType}; charset=utf-8` } });
      }

      if (path === "/calendar/v3/calendars/primary/events") {
        const since = Date.parse(query.get("timeMin") ?? "") || 0;
        const until = Date.parse(query.get("timeMax") ?? "") || Number.POSITIVE_INFINITY;
        const needle = words(query.get("q") ?? "");
        const matching = events.filter((event) => event.start.getTime() >= since && event.start.getTime() < until && contains(`${event.summary} ${event.location}`, needle));
        return Response.json({ items: matching.map((event) => ({ id: event.id, summary: event.summary, location: event.location, start: { dateTime: event.start.toISOString() }, end: { dateTime: event.end.toISOString() } })) });
      }

      return notFound();
    },
  });

  return {
    port: server.port ?? port,
    url: `http://127.0.0.1:${server.port ?? port}`,
    get refreshes() { return mock.refreshes; },
    grantOnly: (scopes) => { grant = scopes; },
    expireTokens: () => accessTokens.clear(),
    revokeRefreshTokens: () => refreshTokens.clear(),
    deny: (status) => { denied = status; },
    stop: () => void server.stop(true),
  };
}

if (import.meta.main) {
  const mock = startMockGoogle(Number(process.argv[2] ?? 11556));
  console.log(`mock Google on ${mock.url} (set LILITH_AI_GOOGLE_URL to it)`);
}
