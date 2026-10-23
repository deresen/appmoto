import { DurableObject } from "cloudflare:workers";
import { z } from "zod";

export interface Env {
  ROAD_REPORTS: DurableObjectNamespace<RoadReports>;
  ASSETS: Fetcher;
}

const LIFETIME_MS = 24 * 60 * 60 * 1000;
const COOKIE_NAME = "passo_session";
const encoder = new TextEncoder();
const reportSchema = z.object({
  category: z.enum(["pothole", "gravel", "oil", "obstacle", "closure"]),
  latitude: z.number().finite().min(-90).max(90),
  longitude: z.number().finite().min(-180).max(180),
  location: z.string().trim().min(3).max(140),
  description: z.string().trim().max(500).optional().default(""),
  severity: z.enum(["attention", "danger"]),
}).strict();

type ReportRow = {
  id: string;
  category: string;
  latitude: number;
  longitude: number;
  location: string;
  description: string;
  severity: string;
  created_at: string;
  expires_at: string;
  confirmations: number;
  confirmed_by_me: number;
};

class HttpError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

function hex(bytes: ArrayBuffer | Uint8Array): string {
  const array = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  return [...array].map(byte => byte.toString(16).padStart(2, "0")).join("");
}

function unhex(value: string): Uint8Array {
  return new Uint8Array(value.match(/.{2}/g)!.map(pair => parseInt(pair, 16)));
}

function json(value: unknown, status = 200, cookie?: string): Response {
  const headers = new Headers({
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  if (cookie) headers.set("Set-Cookie", cookie);
  return new Response(JSON.stringify(value), { status, headers });
}

function toReport(row: ReportRow) {
  return {
    id: row.id, category: row.category, latitude: row.latitude, longitude: row.longitude,
    location: row.location, description: row.description, severity: row.severity,
    createdAt: row.created_at, expiresAt: row.expires_at, confirmations: row.confirmations,
    confirmedByMe: Boolean(row.confirmed_by_me), source: "community" as const,
  };
}

async function readJson(request: Request, optional = false): Promise<unknown> {
  const isJson = request.headers.get("Content-Type")?.split(";")[0].trim() === "application/json";
  if (!optional && !isJson) {
    throw new HttpError(415, "Invia la segnalazione in formato JSON.");
  }
  const reader = request.body?.getReader();
  if (!reader) {
    if (optional) return undefined;
    throw new HttpError(400, "Formato JSON non valido.");
  }
  const decoder = new TextDecoder();
  let text = "";
  let size = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > 16 * 1024) {
      await reader.cancel();
      throw new HttpError(413, "Richiesta troppo grande.");
    }
    text += decoder.decode(value, { stream: true });
  }
  text += decoder.decode();
  if (optional && size === 0) return undefined;
  if (!isJson) throw new HttpError(415, "Invia la segnalazione in formato JSON.");
  try { return JSON.parse(text); }
  catch { throw new HttpError(400, "Formato JSON non valido."); }
}

export class RoadReports extends DurableObject<Env> {
  private readonly sql: SqlStorage;
  private readonly signingKey: Promise<CryptoKey>;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS reports (
        id TEXT PRIMARY KEY,
        category TEXT NOT NULL CHECK (category IN ('pothole','gravel','oil','obstacle','closure')),
        latitude REAL NOT NULL CHECK (latitude BETWEEN -90 AND 90),
        longitude REAL NOT NULL CHECK (longitude BETWEEN -180 AND 180),
        location TEXT NOT NULL,
        description TEXT NOT NULL,
        severity TEXT NOT NULL CHECK (severity IN ('attention','danger')),
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS confirmations (
        report_id TEXT NOT NULL REFERENCES reports(id) ON DELETE CASCADE,
        participant_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (report_id, participant_id)
      );
      CREATE TABLE IF NOT EXISTS rate_windows (
        bucket TEXT PRIMARY KEY,
        count INTEGER NOT NULL,
        reset_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS reports_expiry ON reports(expires_at);
    `);
    let secret = this.sql.exec<{ value: string }>("SELECT value FROM metadata WHERE key = 'session_key'").toArray()[0]?.value;
    if (!secret) {
      secret = hex(crypto.getRandomValues(new Uint8Array(32)));
      this.sql.exec("INSERT INTO metadata (key, value) VALUES ('session_key', ?)", secret);
    }
    this.signingKey = crypto.subtle.importKey("raw", unhex(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
  }

  private async session(request: Request) {
    const cookie = request.headers.get("Cookie")?.split(";").map(part => part.trim())
      .find(part => part.startsWith(`${COOKIE_NAME}=`))?.slice(COOKIE_NAME.length + 1);
    const key = await this.signingKey;
    let identity: string | undefined;
    if (cookie && /^[a-f0-9]{32}\.[a-f0-9]{64}$/.test(cookie)) {
      const [candidate, signature] = cookie.split(".");
      if (await crypto.subtle.verify("HMAC", key, unhex(signature), encoder.encode(candidate))) identity = candidate;
    }
    let setCookie: string | undefined;
    if (!identity) {
      identity = hex(crypto.getRandomValues(new Uint8Array(16)));
      const signature = hex(await crypto.subtle.sign("HMAC", key, encoder.encode(identity)));
      setCookie = `${COOKIE_NAME}=${identity}.${signature}; Path=/; Max-Age=31536000; HttpOnly; SameSite=Lax${new URL(request.url).protocol === "https:" ? "; Secure" : ""}`;
    }
    const participantId = hex(await crypto.subtle.digest("SHA-256", encoder.encode(identity)));
    return { participantId, setCookie };
  }

  private selection = `SELECT r.*,
    (SELECT COUNT(*) FROM confirmations c WHERE c.report_id = r.id) AS confirmations,
    EXISTS(SELECT 1 FROM confirmations c WHERE c.report_id = r.id AND c.participant_id = ?) AS confirmed_by_me
    FROM reports r`;

  private reports(participantId: string) {
    return this.sql.exec<ReportRow>(`${this.selection} WHERE r.expires_at > ? ORDER BY r.created_at DESC, r.id DESC LIMIT 500`,
      participantId, new Date().toISOString()).toArray().map(toReport);
  }

  private report(id: string, participantId: string) {
    const row = this.sql.exec<ReportRow>(`${this.selection} WHERE r.id = ?`, participantId, id).toArray()[0];
    return row ? toReport(row) : undefined;
  }

  private broadcast() {
    for (const socket of this.ctx.getWebSockets()) {
      const attachment = socket.deserializeAttachment() as { participantId?: string } | null;
      if (!attachment?.participantId) { socket.close(1008, "Sessione non valida."); continue; }
      if (socket.readyState !== WebSocket.OPEN) continue;
      try { socket.send(JSON.stringify({ reports: this.reports(attachment.participantId) })); }
      catch { try { socket.close(1011, "Connessione interrotta."); } catch { /* Already disconnected. */ } }
    }
  }

  private assertOrigin(request: Request) {
    const origin = request.headers.get("Origin");
    // Proxies used by local development may normalize schemes. The public
    // Worker validates the complete origin; keep checking the host here too.
    if (origin && (() => { try { return new URL(origin).host !== new URL(request.url).host; } catch { return true; } })()) {
      throw new HttpError(403, "Richiesta da un sito esterno non consentita.");
    }
    if (request.headers.get("Sec-Fetch-Site") === "cross-site") {
      throw new HttpError(403, "Richiesta da un sito esterno non consentita.");
    }
  }

  private async rateLimit(request: Request, participantId: string, kind: string, maximum: number) {
    const ip = request.headers.get("CF-Connecting-IP") || "local";
    const ipHash = hex(await crypto.subtle.sign("HMAC", await this.signingKey, encoder.encode(ip)));
    const now = Date.now();
    this.ctx.storage.transactionSync(() => {
      for (const bucket of [`${kind}:person:${participantId}`, `${kind}:ip:${ipHash}`]) {
        const previous = this.sql.exec<{ count: number; reset_at: number }>("SELECT count, reset_at FROM rate_windows WHERE bucket = ?", bucket).toArray()[0];
        if (previous && previous.reset_at > now && previous.count >= maximum) {
          throw new HttpError(429, "Troppe richieste. Attendi qualche minuto e riprova.");
        }
        this.sql.exec(`INSERT INTO rate_windows (bucket, count, reset_at) VALUES (?, 1, ?)
          ON CONFLICT(bucket) DO UPDATE SET count = ?, reset_at = ?`, bucket, now + 600_000,
          previous && previous.reset_at > now ? previous.count + 1 : 1,
          previous && previous.reset_at > now ? previous.reset_at : now + 600_000);
      }
    });
    await this.scheduleMaintenance();
  }

  private async scheduleMaintenance() {
    const now = Date.now();
    const nowIso = new Date(now).toISOString();
    const nextExpiry = this.sql.exec<{ value: string | null }>("SELECT MIN(expires_at) AS value FROM reports WHERE expires_at > ?", nowIso).toArray()[0]?.value;
    const nextPurge = this.sql.exec<{ value: string | null }>("SELECT MIN(expires_at) AS value FROM reports WHERE expires_at <= ?", nowIso).toArray()[0]?.value;
    const nextRate = this.sql.exec<{ value: number | null }>("SELECT MIN(reset_at) AS value FROM rate_windows").toArray()[0]?.value;
    const next = Math.min(nextExpiry ? Date.parse(nextExpiry) : Infinity,
      nextPurge ? Date.parse(nextPurge) + LIFETIME_MS : Infinity, nextRate ?? Infinity);
    if (Number.isFinite(next)) await this.ctx.storage.setAlarm(Math.max(now + 1000, next));
    else await this.ctx.storage.deleteAlarm();
  }

  async fetch(request: Request): Promise<Response> {
    let setCookie: string | undefined;
    try {
      const url = new URL(request.url);
      const wantsSocket = request.headers.get("Upgrade")?.toLowerCase() === "websocket";
      if (["POST", "PUT", "PATCH", "DELETE"].includes(request.method) || wantsSocket) this.assertOrigin(request);
      const session = await this.session(request);
      const participantId = session.participantId;
      setCookie = session.setCookie;
      if (request.method === "GET" && url.pathname === "/api/health") {
        return json({ status: "ok", storage: "sqlite", realtime: "websocket" }, 200, setCookie);
      }
      if (request.method === "GET" && url.pathname === "/api/reports") {
        return json({ reports: this.reports(participantId) }, 200, setCookie);
      }
      if (request.method === "GET" && url.pathname === "/api/events") {
        if (!wantsSocket) throw new HttpError(426, "Apri una connessione WebSocket per gli aggiornamenti.");
        if (this.ctx.getWebSockets().length >= 500 || this.ctx.getWebSockets(participantId).length >= 5) {
          throw new HttpError(429, "Troppe connessioni aperte. Chiudi una scheda e riprova.");
        }
        const pair = new WebSocketPair();
        const [client, server] = Object.values(pair);
        this.ctx.acceptWebSocket(server, [participantId]);
        server.serializeAttachment({ participantId });
        server.send(JSON.stringify({ reports: this.reports(participantId) }));
        const headers = new Headers();
        if (setCookie) headers.set("Set-Cookie", setCookie);
        return new Response(null, { status: 101, webSocket: client, headers });
      }
      if (request.method === "POST" && url.pathname === "/api/reports") {
        await this.rateLimit(request, participantId, "create", 20);
        const parsed = reportSchema.safeParse(await readJson(request));
        if (!parsed.success) throw new HttpError(400, "Controlla categoria, posizione, località e descrizione (massimo 500 caratteri).");
        const report = parsed.data;
        const id = crypto.randomUUID();
        const now = Date.now();
        this.sql.exec(`INSERT INTO reports
          (id, category, latitude, longitude, location, description, severity, created_at, expires_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, id, report.category, report.latitude, report.longitude,
          report.location, report.description, report.severity, new Date(now).toISOString(), new Date(now + LIFETIME_MS).toISOString());
        await this.scheduleMaintenance();
        this.broadcast();
        return json({ report: this.report(id, participantId) }, 201, setCookie);
      }
      const confirmationMatch = /^\/api\/reports\/([^/]+)\/confirm$/.exec(url.pathname);
      if (request.method === "POST" && confirmationMatch) {
        await readJson(request, true);
        await this.rateLimit(request, participantId, "confirm", 100);
        const report = this.report(confirmationMatch[1], participantId);
        if (!report) throw new HttpError(404, "Segnalazione non trovata.");
        if (Date.parse(report.expiresAt) <= Date.now()) throw new HttpError(410, "Questa segnalazione è scaduta. Puoi crearne una nuova.");
        this.sql.exec("INSERT OR IGNORE INTO confirmations (report_id, participant_id, created_at) VALUES (?, ?, ?)", report.id, participantId, new Date().toISOString());
        await this.scheduleMaintenance();
        this.broadcast();
        return json({ report: this.report(report.id, participantId) }, 200, setCookie);
      }
      throw new HttpError(404, "Endpoint non trovato.");
    } catch (error) {
      if (error instanceof HttpError) return json({ error: error.message }, error.status, setCookie);
      console.error("Errore API Cloud:", error instanceof Error ? error.name : "errore sconosciuto");
      return json({ error: "Errore del server. Riprova tra poco." }, 500, setCookie);
    }
  }

  async alarm() {
    const now = Date.now();
    const cutoff = new Date(now - LIFETIME_MS).toISOString();
    this.ctx.storage.transactionSync(() => {
      this.sql.exec("DELETE FROM confirmations WHERE report_id IN (SELECT id FROM reports WHERE expires_at <= ?)", cutoff);
      this.sql.exec("DELETE FROM reports WHERE expires_at <= ?", cutoff);
      this.sql.exec("DELETE FROM rate_windows WHERE reset_at <= ?", now);
    });
    this.broadcast();
    await this.scheduleMaintenance();
  }

  webSocketMessage(socket: WebSocket, message: string | ArrayBuffer) {
    if (message === "ping") socket.send("pong");
    else socket.close(1008, "Sono consentiti solo aggiornamenti dal server.");
  }

  webSocketClose(socket: WebSocket, code: number, reason: string) {
    const validCode = code >= 1000 && code < 5000 && ![1004, 1005, 1006, 1015].includes(code) ? code : 1000;
    socket.close(validCode, reason);
  }
  webSocketError(socket: WebSocket) { socket.close(1011, "Connessione interrotta."); }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (new URL(request.url).pathname.startsWith("/api/")) {
      if (["POST", "PUT", "PATCH", "DELETE"].includes(request.method) || request.headers.get("Upgrade")?.toLowerCase() === "websocket") {
        const origin = request.headers.get("Origin");
        let foreignOrigin = request.headers.get("Sec-Fetch-Site") === "cross-site";
        if (origin) {
          try { foreignOrigin ||= new URL(origin).origin !== new URL(request.url).origin; }
          catch { foreignOrigin = true; }
        }
        if (foreignOrigin) return json({ error: "Richiesta da un sito esterno non consentita." }, 403);
      }
      const id = env.ROAD_REPORTS.idFromName("global");
      return env.ROAD_REPORTS.get(id).fetch(request);
    }
    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;
