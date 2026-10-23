import express, {
  type ErrorRequestHandler,
  type Request,
  type Response,
} from "express";
import {
  createHash,
  createHmac,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { z } from "zod";

export const REPORT_LIFETIME_MS = 24 * 60 * 60 * 1000;
const COOKIE_NAME = "passo_session";
const CATEGORY_VALUES = [
  "pothole",
  "gravel",
  "oil",
  "obstacle",
  "closure",
] as const;

export interface RoadReport {
  id: string;
  category: (typeof CATEGORY_VALUES)[number];
  latitude: number;
  longitude: number;
  location: string;
  description: string;
  severity: "attention" | "danger";
  createdAt: string;
  expiresAt: string;
  confirmations: number;
  confirmedByMe: boolean;
  source: "community" | "demo";
}

interface ReportRow {
  id: string;
  category: RoadReport["category"];
  latitude: number;
  longitude: number;
  location: string;
  description: string;
  severity: RoadReport["severity"];
  created_at: string;
  expires_at: string;
  initial_confirmations: number;
  source: RoadReport["source"];
  confirmations: number;
  confirmed_by_me: number;
}

export interface AppOptions {
  dbPath?: string;
  seedDemo?: boolean;
  now?: () => number;
  serveFrontend?: boolean;
  trustProxy?: boolean;
}

const reportSchema = z
  .object({
    category: z.enum(CATEGORY_VALUES),
    latitude: z.number().finite().min(-90).max(90),
    longitude: z.number().finite().min(-180).max(180),
    location: z.string().trim().min(3).max(140),
    description: z.string().trim().max(500).optional().default(""),
    severity: z.enum(["attention", "danger"]),
  })
  .strict();

export function createApp(options: AppOptions = {}) {
  const now = options.now ?? Date.now;
  const dbPath =
    options.dbPath ?? resolve(process.env.DATA_DIR || "data", "appmoto.sqlite");
  const seedDemo =
    options.seedDemo ?? !["0", "false"].includes(process.env.SEED_DEMO ?? "");
  if (dbPath !== ":memory:") mkdirSync(dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    PRAGMA busy_timeout = 5000;
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
      expires_at TEXT NOT NULL,
      initial_confirmations INTEGER NOT NULL DEFAULT 0,
      source TEXT NOT NULL CHECK (source IN ('community','demo'))
    );
    CREATE TABLE IF NOT EXISTS confirmations (
      report_id TEXT NOT NULL REFERENCES reports(id) ON DELETE CASCADE,
      participant_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (report_id, participant_id)
    );
    CREATE INDEX IF NOT EXISTS reports_expiry ON reports(expires_at);
  `);
  let signingKey = (
    db
      .prepare("SELECT value FROM metadata WHERE key = ?")
      .get("session_key") as { value: string } | undefined
  )?.value;
  if (!signingKey) {
    signingKey = randomBytes(32).toString("hex");
    db.prepare("INSERT INTO metadata (key, value) VALUES (?, ?)").run(
      "session_key",
      signingKey,
    );
  }
  const sessionKey = signingKey;
  const insertReport = db.prepare(`INSERT INTO reports
    (id, category, latitude, longitude, location, description, severity, created_at, expires_at, initial_confirmations, source)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);

  if (
    seedDemo &&
    !db.prepare("SELECT key FROM metadata WHERE key = ?").get("demo_seeded")
  ) {
    const demoReports = [
      [
        "pothole",
        45.4714,
        10.535,
        "Desenzano del Garda · Via Marconi",
        "Buche sul lato destro della carreggiata, prima della rotonda. Rallenta in avvicinamento.",
        "attention",
        12,
        8,
      ],
      [
        "gravel",
        45.6076,
        10.521,
        "Salò · Strada panoramica",
        "Ghiaia in uscita dalla curva. Particolare attenzione alle due ruote.",
        "danger",
        24,
        12,
      ],
      [
        "oil",
        45.6209,
        10.5644,
        "Gardone Riviera · Via Roma",
        "Traccia di olio vicino al bordo strada. Fondo scivoloso.",
        "danger",
        38,
        5,
      ],
      [
        "closure",
        45.4868,
        10.6071,
        "Sirmione · Via XXV Aprile",
        "Tratto chiuso per lavori. Seguire le indicazioni sul posto.",
        "attention",
        55,
        6,
      ],
      [
        "obstacle",
        45.4606,
        10.4834,
        "Lonato del Garda · Via Mantova",
        "Ramo sulla carreggiata dopo il bivio. Passaggio da affrontare con cautela.",
        "attention",
        72,
        3,
      ],
      [
        "gravel",
        45.5531,
        10.5515,
        "Manerba del Garda · Via della Rocca",
        "Sabbia e ghiaia trascinate dalla pioggia sulla curva in discesa.",
        "attention",
        98,
        4,
      ],
    ] as const;
    db.exec("BEGIN");
    try {
      for (const [
        category,
        latitude,
        longitude,
        location,
        description,
        severity,
        minutes,
        confirmations,
      ] of demoReports) {
        const createdAt = now() - minutes * 60_000;
        insertReport.run(
          randomUUID(),
          category,
          latitude,
          longitude,
          location,
          description,
          severity,
          new Date(createdAt).toISOString(),
          new Date(createdAt + REPORT_LIFETIME_MS).toISOString(),
          confirmations,
          "demo",
        );
      }
      db.prepare("INSERT INTO metadata (key, value) VALUES (?, ?)").run(
        "demo_seeded",
        "1",
      );
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      db.close();
      throw error;
    }
  }

  const reportSelection = `
    SELECT r.*, r.initial_confirmations + (SELECT COUNT(*) FROM confirmations c WHERE c.report_id = r.id) AS confirmations,
      EXISTS(SELECT 1 FROM confirmations c WHERE c.report_id = r.id AND c.participant_id = ?) AS confirmed_by_me
    FROM reports r`;
  const activeReports = db.prepare(
    `${reportSelection} WHERE r.expires_at > ? ORDER BY r.created_at DESC, r.id DESC LIMIT 500`,
  );
  const activeReportById = db.prepare(
    `${reportSelection} WHERE r.id = ? AND r.expires_at > ?`,
  );
  const findReport = db.prepare(
    "SELECT id, expires_at FROM reports WHERE id = ?",
  );
  const confirmReport = db.prepare(
    "INSERT OR IGNORE INTO confirmations (report_id, participant_id, created_at) VALUES (?, ?, ?)",
  );

  function toReport(row: ReportRow): RoadReport {
    return {
      id: row.id,
      category: row.category,
      latitude: row.latitude,
      longitude: row.longitude,
      location: row.location,
      description: row.description,
      severity: row.severity,
      createdAt: row.created_at,
      expiresAt: row.expires_at,
      confirmations: row.confirmations,
      confirmedByMe: Boolean(row.confirmed_by_me),
      source: row.source,
    };
  }
  function reportsFor(participantId: string): RoadReport[] {
    return (
      activeReports.all(
        participantId,
        new Date(now()).toISOString(),
      ) as unknown as ReportRow[]
    ).map(toReport);
  }
  function reportFor(
    id: string,
    participantId: string,
  ): RoadReport | undefined {
    const row = activeReportById.get(
      participantId,
      id,
      new Date(now()).toISOString(),
    ) as unknown as ReportRow | undefined;
    return row ? toReport(row) : undefined;
  }

  const app = express();
  app.disable("x-powered-by");
  app.set(
    "trust proxy",
    (options.trustProxy ?? process.env.TRUST_PROXY === "1") ? 1 : false,
  );
  app.use("/api", (_req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    next();
  });
  app.use("/api", (req, res, next) => {
    if (["POST", "PUT", "PATCH", "DELETE"].includes(req.method)) {
      const origin = req.get("origin");
      let foreignOrigin = false;
      if (origin) {
        try {
          foreignOrigin = new URL(origin).host !== req.get("host");
        } catch {
          foreignOrigin = true;
        }
      }
      if (foreignOrigin || req.get("sec-fetch-site") === "cross-site") {
        res
          .status(403)
          .json({ error: "Richiesta da un sito esterno non consentita." });
        return;
      }
    }
    next();
  });
  app.use("/api", express.json({ limit: "16kb" }));
  app.use("/api", (req, res, next) => {
    const cookie = req.headers.cookie
      ?.split(";")
      .map((part) => part.trim())
      .find((part) => part.startsWith(`${COOKIE_NAME}=`))
      ?.slice(COOKIE_NAME.length + 1);
    let identity: string | undefined;
    if (cookie && /^[a-f0-9]{32}\.[a-f0-9]{64}$/.test(cookie)) {
      const [candidate, signature] = cookie.split(".");
      const expected = createHmac("sha256", sessionKey)
        .update(candidate)
        .digest();
      const received = Buffer.from(signature, "hex");
      if (timingSafeEqual(expected, received)) identity = candidate;
    }
    if (!identity) {
      identity = randomBytes(16).toString("hex");
      const signature = createHmac("sha256", sessionKey)
        .update(identity)
        .digest("hex");
      res.cookie(COOKIE_NAME, `${identity}.${signature}`, {
        httpOnly: true,
        sameSite: "lax",
        secure: process.env.NODE_ENV === "production" || req.secure,
        maxAge: 365 * 24 * 60 * 60 * 1000,
        path: "/",
      });
    }
    res.locals.participantId = createHash("sha256")
      .update(identity)
      .digest("hex");
    next();
  });

  const clients = new Set<{ response: Response; participantId: string }>();
  function sendSnapshot(client: { response: Response; participantId: string }) {
    client.response.write(
      `event: reports\ndata: ${JSON.stringify({ reports: reportsFor(client.participantId) })}\n\n`,
    );
  }
  function broadcast() {
    for (const client of clients) {
      if (client.response.destroyed) clients.delete(client);
      else sendSnapshot(client);
    }
  }
  const rateWindows = new Map<string, { count: number; resetAt: number }>();
  function rateLimit(kind: string, limit: number) {
    return (req: Request, res: Response, next: () => void) => {
      const key = `${kind}:${req.ip ?? "local"}`;
      let bucket = rateWindows.get(key);
      if (!bucket || bucket.resetAt <= now()) {
        bucket = { count: 0, resetAt: now() + 10 * 60_000 };
        rateWindows.set(key, bucket);
      }
      bucket.count++;
      if (bucket.count > limit) {
        res.setHeader(
          "Retry-After",
          String(Math.max(1, Math.ceil((bucket.resetAt - now()) / 1000))),
        );
        res
          .status(429)
          .json({
            error: "Troppe richieste. Attendi qualche minuto e riprova.",
          });
        return;
      }
      next();
    };
  }

  app.get("/api/health", (_req, res) => {
    res.json({ status: "ok", storage: "sqlite", realtime: "sse" });
  });
  app.get("/api/reports", (_req, res) => {
    res.json({ reports: reportsFor(res.locals.participantId) });
  });
  app.post("/api/reports", rateLimit("create", 20), (req, res) => {
    if (!req.is("application/json")) {
      res.status(415).json({ error: "Invia la segnalazione in formato JSON." });
      return;
    }
    const result = reportSchema.safeParse(req.body);
    if (!result.success) {
      res
        .status(400)
        .json({
          error:
            "Controlla categoria, posizione, località e descrizione (massimo 500 caratteri).",
        });
      return;
    }
    const id = randomUUID();
    const createdAt = now();
    const data = result.data;
    insertReport.run(
      id,
      data.category,
      data.latitude,
      data.longitude,
      data.location,
      data.description,
      data.severity,
      new Date(createdAt).toISOString(),
      new Date(createdAt + REPORT_LIFETIME_MS).toISOString(),
      0,
      "community",
    );
    const report = reportFor(id, res.locals.participantId);
    res.status(201).json({ report });
    broadcast();
  });
  app.post(
    "/api/reports/:id/confirm",
    rateLimit("confirm", 100),
    (req, res) => {
      const row = findReport.get(String(req.params.id)) as
        { id: string; expires_at: string } | undefined;
      if (!row) {
        res.status(404).json({ error: "Segnalazione non trovata." });
        return;
      }
      if (Date.parse(row.expires_at) <= now()) {
        res
          .status(410)
          .json({
            error: "Questa segnalazione è scaduta. Puoi crearne una nuova.",
          });
        return;
      }
      confirmReport.run(
        row.id,
        res.locals.participantId,
        new Date(now()).toISOString(),
      );
      const report = reportFor(row.id, res.locals.participantId);
      res.json({ report });
      broadcast();
    },
  );
  app.get("/api/events", (_req, res) => {
    const participantId = String(res.locals.participantId);
    if (
      clients.size >= 500 ||
      [...clients].filter((client) => client.participantId === participantId)
        .length >= 5
    ) {
      res
        .status(429)
        .json({
          error: "Troppe connessioni aperte. Chiudi una scheda e riprova.",
        });
      return;
    }
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders();
    res.write("retry: 3000\n\n");
    const client = { response: res, participantId };
    clients.add(client);
    sendSnapshot(client);
    res.on("close", () => clients.delete(client));
  });

  const heartbeat = setInterval(() => {
    for (const client of clients) {
      if (client.response.destroyed) clients.delete(client);
      else client.response.write(": heartbeat\n\n");
    }
  }, 20_000);
  heartbeat.unref();
  const expirySweep = setInterval(() => {
    broadcast();
    for (const [key, value] of rateWindows)
      if (value.resetAt <= now()) rateWindows.delete(key);
  }, 30_000);
  expirySweep.unref();

  app.use("/api", (_req, res) =>
    res.status(404).json({ error: "Endpoint non trovato." }),
  );
  const distPath = resolve("dist");
  if (
    options.serveFrontend !== false &&
    existsSync(resolve(distPath, "index.html"))
  ) {
    app.use(express.static(distPath));
    app.use((req, res, next) => {
      if (req.method === "GET" && req.accepts("html"))
        res.sendFile(resolve(distPath, "index.html"));
      else next();
    });
  }
  const errorHandler: ErrorRequestHandler = (error, _req, res, _next) => {
    const status =
      error.type === "entity.too.large"
        ? 413
        : error.type === "entity.parse.failed"
          ? 400
          : 500;
    if (status === 500)
      console.error(
        "Errore API:",
        error instanceof Error ? error.name : "errore sconosciuto",
      );
    res
      .status(status)
      .json({
        error:
          status === 413
            ? "Richiesta troppo grande."
            : status === 400
              ? "Formato JSON non valido."
              : "Errore del server. Riprova tra poco.",
      });
  };
  app.use(errorHandler);

  let closed = false;
  return {
    app,
    close() {
      if (closed) return;
      closed = true;
      clearInterval(heartbeat);
      clearInterval(expirySweep);
      for (const client of clients) client.response.end();
      clients.clear();
      db.close();
    },
  };
}
