import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import WebSocket from "ws";

interface Report {
  id: string;
  source: string;
  confirmations: number;
  confirmedByMe: boolean;
  clearVotes: number;
  clearedByMe: boolean;
  resolvedAt: string | null;
  createdAt: string;
  expiresAt: string;
  location: string;
}

const validReport = {
  category: "pothole", latitude: 45.4714, longitude: 10.535,
  location: "Desenzano · Via Marconi", description: "Buche dopo la rotonda.", severity: "attention",
};

async function availablePort() {
  const server = createServer();
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert(address && typeof address !== "string");
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return address.port;
}

async function startWorker(directory: string, port: number) {
  const env = { ...process.env };
  for (const name of Object.keys(env)) if (/^(?:CLOUDFLARE_|CF_)/.test(name)) delete env[name];
  Object.assign(env, {
    CI: "true", WRANGLER_SEND_METRICS: "false", XDG_CONFIG_HOME: join(directory, "config"),
    WRANGLER_LOG_PATH: join(directory, "wrangler.log"),
  });
  const child = spawn(process.execPath, [
    resolve("node_modules/wrangler/bin/wrangler.js"), "dev", "--local", "--config", join(directory, "wrangler.json"),
    "--persist-to", join(directory, "state"), "--ip", "127.0.0.1", "--port", String(port), "--log-level", "error",
  ], { cwd: resolve("."), env, stdio: ["ignore", "pipe", "pipe"], detached: process.platform !== "win32" });
  let logs = "";
  child.stdout?.on("data", chunk => { logs = (logs + String(chunk)).slice(-12_000); });
  child.stderr?.on("data", chunk => { logs = (logs + String(chunk)).slice(-12_000); });
  const exited = new Promise<void>(resolve => child.once("exit", () => resolve()));
  const base = `http://127.0.0.1:${port}`;
  async function stop() {
    if (child.exitCode !== null || child.signalCode !== null) return;
    try {
      if (process.platform !== "win32" && child.pid) process.kill(-child.pid, "SIGTERM");
      else child.kill("SIGTERM");
    } catch { /* Process already exited. */ }
    await Promise.race([exited, delay(2000)]);
    if (child.exitCode === null && child.signalCode === null) {
      try {
        if (process.platform !== "win32" && child.pid) process.kill(-child.pid, "SIGKILL");
        else child.kill("SIGKILL");
      } catch { /* Process already exited. */ }
      await exited;
    }
  }
  try {
    const deadline = Date.now() + 40_000;
    while (Date.now() < deadline) {
      if (child.exitCode !== null || child.signalCode !== null) throw new Error(`Wrangler si è arrestato:\n${logs}`);
      try {
        const response = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(1000) });
        if (response.ok && (await response.json()).realtime === "websocket") return { base, stop, get logs() { return logs; } };
      } catch { /* The local workerd server is still starting. */ }
      await delay(200);
    }
    throw new Error(`Timeout avvio locale Wrangler:\n${logs}`);
  } catch (error) {
    await stop();
    throw error;
  }
}

function browser(base: string, existingCookie = "") {
  let cookie = existingCookie;
  return {
    get cookie() { return cookie; },
    async request(path: string, init: RequestInit = {}) {
      const headers = new Headers(init.headers);
      if (cookie) headers.set("Cookie", cookie);
      const response = await fetch(`${base}${path}`, { ...init, headers });
      const next = response.headers.get("Set-Cookie");
      if (next) cookie = next.split(";")[0];
      return response;
    },
    async post(path: string, body?: unknown) {
      return this.request(path, { method: "POST", ...(body === undefined ? {} : {
        headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
      }) });
    },
  };
}

async function socketFor(base: string, cookie: string) {
  const socket = new WebSocket(`${base.replace("http:", "ws:")}/api/events`, { headers: { Cookie: cookie, Origin: base } });
  const queued: Report[][] = [];
  const pending: Array<{ resolve: (reports: Report[]) => void; reject: (error: Error) => void }> = [];
  let receivedPong: (() => void) | undefined;
  socket.on("message", data => {
    const text = data.toString();
    if (text === "pong") { receivedPong?.(); return; }
    const message = JSON.parse(text) as { reports: Report[] };
    const waiter = pending.shift();
    if (waiter) waiter.resolve(message.reports);
    else queued.push(message.reports);
  });
  socket.on("error", error => { for (const waiter of pending.splice(0)) waiter.reject(error); });
  await new Promise<void>((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  return {
    next(): Promise<Report[]> {
      if (queued.length) return Promise.resolve(queued.shift()!);
      return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error("Nessuno snapshot WebSocket ricevuto.")), 5000);
        pending.push({ resolve: value => { clearTimeout(timeout); resolve(value); }, reject: error => { clearTimeout(timeout); reject(error); } });
      });
    },
    ping(): Promise<void> {
      return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error("Nessun pong WebSocket ricevuto.")), 5000);
        receivedPong = () => { clearTimeout(timeout); resolve(); };
        socket.send("ping");
      });
    },
    close() { socket.terminate(); },
  };
}

test("Cloudflare: API, asset, SQLite e WebSocket reali nel runtime locale workerd", { timeout: 100_000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), "passo-cloud-test-"));
  await mkdir(join(directory, "assets"));
  await writeFile(join(directory, "assets", "index.html"), "<!doctype html><title>Passo cloud fixture</title><main>Passo</main>");
  await writeFile(join(directory, "wrangler.json"), JSON.stringify({
    name: "passo-cloud-test", main: resolve("worker/index.ts"), compatibility_date: "2026-10-19",
    assets: { directory: join(directory, "assets"), binding: "ASSETS", not_found_handling: "single-page-application", run_worker_first: ["/api/*"] },
    durable_objects: { bindings: [{ name: "ROAD_REPORTS", class_name: "RoadReports" }] },
    migrations: [{ tag: "v1", new_sqlite_classes: ["RoadReports"] }],
  }));
  const port = await availablePort();
  let instance: Awaited<ReturnType<typeof startWorker>> | undefined;
  let firstSocket: Awaited<ReturnType<typeof socketFor>> | undefined;
  let secondSocket: Awaited<ReturnType<typeof socketFor>> | undefined;
  let createdId = "";
  let savedCookie = "";
  try {
    instance = await startWorker(directory, port);
    const first = browser(instance.base);
    const second = browser(instance.base);

    await t.test("serve gli asset e una API vuota senza segnalazioni demo", async () => {
      const page = await first.request("/");
      assert.equal(page.status, 200);
      assert.match(await page.text(), /Passo cloud fixture/);
      const health = await first.request("/api/health");
      assert.equal(health.status, 200);
      assert.deepEqual(await health.json(), { status: "ok", storage: "sqlite", realtime: "websocket" });
      assert.match(health.headers.get("set-cookie") ?? "", /HttpOnly/);
      assert.match(health.headers.get("set-cookie") ?? "", /SameSite=Lax/);
      assert.deepEqual(await (await first.request("/api/reports")).json(), { reports: [] });
      await (await second.request("/api/health")).json();
      assert.notEqual(first.cookie, second.cookie);
      const missing = await first.request("/api/missing");
      assert.equal(missing.status, 404);
      await missing.json();
    });

    await t.test("rifiuta posizione e JSON invalidi, origini esterne HTTP e WebSocket", async () => {
      const invalid = await first.post("/api/reports", { ...validReport, latitude: 91 });
      assert.equal(invalid.status, 400);
      await invalid.json();
      const malformed = await first.request("/api/reports", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{broken" });
      assert.equal(malformed.status, 400);
      await malformed.json();
      const ownOrigin = await first.request("/api/reports", {
        method: "POST", headers: { "Content-Type": "application/json", Origin: instance!.base }, body: "{broken",
      });
      assert.equal(ownOrigin.status, 400, "l'origine pubblica HTTP locale deve superare il controllo e raggiungere la validazione JSON");
      await ownOrigin.json();
      // Wrangler's local proxy rewrites same-host Origin schemes before the
      // Worker sees them. Test external origins here, not a rewritten request.
      const foreign = await first.request("/api/reports", {
        method: "POST", headers: { "Content-Type": "application/json", Origin: "https://untrusted.example" }, body: JSON.stringify(validReport),
      });
      assert.equal(foreign.status, 403);
      await foreign.json();
      const rejectedUpgrade = await new Promise<number>((resolve, reject) => {
        const foreignSocket = new WebSocket(`${instance!.base.replace("http:", "ws:")}/api/events`, {
          headers: { Cookie: first.cookie, Origin: "https://untrusted.example" },
        });
        foreignSocket.once("unexpected-response", (_request, response) => { response.resume(); resolve(response.statusCode ?? 0); });
        foreignSocket.once("open", () => { foreignSocket.terminate(); reject(new Error("WebSocket cross-site accettato.")); });
        foreignSocket.once("error", reject);
      });
      assert.equal(rejectedUpgrade, 403);
    });

    await t.test("trasmette inserimento e conferme a due browser con stato personale", async () => {
      firstSocket = await socketFor(instance!.base, first.cookie);
      secondSocket = await socketFor(instance!.base, second.cookie);
      assert.deepEqual(await firstSocket.next(), []);
      assert.deepEqual(await secondSocket.next(), []);
      const creation = await first.post("/api/reports", validReport);
      assert.equal(creation.status, 201);
      const { report } = await creation.json();
      createdId = report.id;
      assert.equal(report.source, "community");
      assert.equal(report.confirmations, 0);
      assert.equal(Date.parse(report.expiresAt) - Date.parse(report.createdAt), 86_400_000);
      assert.equal((await firstSocket.next())[0].id, createdId);
      assert.equal((await secondSocket.next())[0].id, createdId);
      const confirmationLogStart = instance!.logs.length;
      const confirmed = await second.post(`/api/reports/${createdId}/confirm`, {});
      assert.equal(confirmed.status, 200);
      await confirmed.json();
      const firstState = await firstSocket.next();
      const secondState = await secondSocket.next();
      assert.equal(firstState[0].confirmations, 1);
      assert.equal(secondState[0].confirmations, 1);
      assert.equal(firstState[0].confirmedByMe, false);
      assert.equal(secondState[0].confirmedByMe, true);
      const duplicate = await second.post(`/api/reports/${createdId}/confirm`);
      assert.equal((await duplicate.json()).report.confirmations, 1);
      await firstSocket.next();
      await secondSocket.next();
      await firstSocket.ping();
      await delay(100);
      assert.doesNotMatch(instance!.logs.slice(confirmationLogStart), /Can't read from request stream after response has been sent/,
        "la conferma JSON deve consumare il corpo prima della risposta, senza eccezioni workerd");
      savedCookie = second.cookie;
      firstSocket.close(); firstSocket = undefined;
      secondSocket.close(); secondSocket = undefined;
    });

    await t.test("rifiuta cookie manomessi e mantiene SQLite e firma dopo un riavvio", async () => {
      const tampered = savedCookie.slice(0, -1) + (savedCookie.endsWith("a") ? "b" : "a");
      const invalidBrowser = browser(instance!.base, tampered);
      const response = await invalidBrowser.request("/api/reports");
      assert(response.headers.get("set-cookie"), "un cookie manomesso deve essere sostituito");
      const { reports } = await response.json();
      assert.equal(reports[0].confirmedByMe, false);
      await instance!.stop();
      instance = await startWorker(directory, port);
      const restored = browser(instance.base, savedCookie);
      const stored = await (await restored.request("/api/reports")).json();
      assert.equal(stored.reports.length, 1);
      assert.equal(stored.reports[0].id, createdId);
      assert.equal(stored.reports[0].confirmations, 1);
      assert.equal(stored.reports[0].confirmedByMe, true);
      assert.equal((await (await restored.post(`/api/reports/${createdId}/confirm`)).json()).report.confirmations, 1);
    });

    await t.test("voti risolto esclusivi, idempotenti e concorrenti; il terzo voto rimuove la segnalazione dai WebSocket", async () => {
      const voters = [browser(instance!.base), browser(instance!.base), browser(instance!.base)];
      for (const voter of voters) await (await voter.request("/api/health")).json();
      const creation = await voters[0].post("/api/reports", { ...validReport, latitude: validReport.latitude + 0.02 });
      assert.equal(creation.status, 201);
      const { report: original } = await creation.json();
      const path = `/api/reports/${original.id}`;
      const sockets = [await socketFor(instance!.base, voters[0].cookie), await socketFor(instance!.base, voters[1].cookie)];
      try {
        for (const socket of sockets) assert((await socket.next()).some(report => report.id === original.id));
        const confirmation = await voters[0].post(`${path}/confirm`, {});
        assert.equal(confirmation.status, 200);
        await confirmation.json();
        for (const socket of sockets) await socket.next();
        const clear = await voters[0].post(`${path}/clear`, {});
        assert.equal(clear.status, 200);
        const { report: cleared } = await clear.json();
        assert.equal(cleared.clearVotes, 1);
        assert.equal(cleared.confirmations, 0);
        assert.equal(cleared.confirmedByMe, false);
        assert.equal(cleared.clearedByMe, true);
        assert.equal(cleared.expiresAt, original.expiresAt);
        const views = await Promise.all(sockets.map(socket => socket.next()));
        assert.equal(views[0].find(report => report.id === original.id)?.clearedByMe, true);
        assert.equal(views[1].find(report => report.id === original.id)?.clearedByMe, false);
        const back = await voters[0].post(`${path}/confirm`);
        assert.equal(back.status, 200);
        const { report: confirmed } = await back.json();
        assert.equal(confirmed.clearVotes, 0);
        assert.equal(confirmed.confirmations, 1);
        for (const socket of sockets) await socket.next();
      } finally {
        for (const socket of sockets) socket.close();
      }
      const repeats = await Promise.all([
        voters[0].post(`${path}/clear`), voters[0].post(`${path}/clear`, {}), voters[0].post(`${path}/clear`),
      ]);
      for (const response of repeats) {
        assert.equal(response.status, 200);
        assert.equal((await response.json()).report.clearVotes, 1);
      }
      const blocked = await voters[0].request(`${path}/clear`, { method: "POST", headers: { Origin: "https://untrusted.example" } });
      assert.equal(blocked.status, 403);
      await blocked.json();
      const second = await voters[1].post(`${path}/clear`, {});
      assert.equal(second.status, 200);
      assert.equal((await second.json()).report.clearVotes, 2);
      const removalSockets = [await socketFor(instance!.base, voters[0].cookie), await socketFor(instance!.base, voters[1].cookie)];
      let resolved: Report;
      try {
        for (const socket of removalSockets) assert((await socket.next()).some(report => report.id === original.id));
        const resolution = await voters[2].post(`${path}/clear`, {});
        assert.equal(resolution.status, 200);
        resolved = (await resolution.json()).report;
        assert.equal(resolved.clearVotes, 3);
        assert(resolved.resolvedAt);
        assert.equal(resolved.expiresAt, original.expiresAt);
        for (const socket of removalSockets) {
          assert(!(await socket.next()).some(report => report.id === original.id), "resolution must remove the report from an existing WebSocket");
        }
      } finally {
        for (const socket of removalSockets) socket.close();
      }
      for (const voter of voters) {
        const repeat = await voter.post(`${path}/clear`);
        assert.equal(repeat.status, 200);
        assert.equal((await repeat.json()).report.resolvedAt, resolved.resolvedAt);
        const revival = await voter.post(`${path}/confirm`, {});
        assert.equal(revival.status, 410);
        await revival.json();
      }
      const newVote = await browser(instance!.base).post(`${path}/clear`, {});
      assert.equal(newVote.status, 410);
      await newVote.json();
      const replacement = await voters[0].post("/api/reports", { ...validReport, latitude: validReport.latitude + 0.02 });
      assert.equal(replacement.status, 201, "resolved reports cannot block a new hazard");
      await replacement.json();
    });

    await t.test("duplicati entro 75m: massimo tre più vicini, categoria, override e creazione concorrente", async () => {
      const author = browser(instance!.base);
      const atDistance = (metres: number) => ({
        ...validReport, latitude: validReport.latitude + 1 + metres / 6_371_000 * 180 / Math.PI,
      });
      const initial = await author.post("/api/reports", atDistance(0));
      assert.equal(initial.status, 201);
      const firstId = (await initial.json()).report.id;
      const inside = await author.post("/api/reports", atDistance(74.99));
      assert.equal(inside.status, 409);
      const insideBody = await inside.json();
      assert.equal(insideBody.code, "POSSIBLE_DUPLICATE");
      assert.deepEqual(insideBody.duplicates.map((report: Report) => report.id), [firstId]);
      const outside = await author.post("/api/reports", atDistance(75.01));
      assert.equal(outside.status, 201);
      await outside.json();
      const category = await author.post("/api/reports", { ...atDistance(0), category: "oil" });
      assert.equal(category.status, 201);
      await category.json();
      const nearest = [firstId];
      for (const metres of [20, 40, 60]) {
        const distinct = await author.post("/api/reports", { ...atDistance(metres), allowDuplicate: true });
        assert.equal(distinct.status, 201);
        nearest.push((await distinct.json()).report.id);
      }
      const before = (await (await author.request("/api/reports")).json()).reports.length;
      const conflict = await author.post("/api/reports", atDistance(0));
      assert.equal(conflict.status, 409);
      const body = await conflict.json();
      assert.equal(body.code, "POSSIBLE_DUPLICATE");
      assert.equal(typeof body.error, "string");
      assert.deepEqual(body.duplicates.map((report: Report) => report.id), nearest.slice(0, 3));
      assert.equal((await (await author.request("/api/reports")).json()).reports.length, before);
      const concurrentReport = { ...validReport, latitude: validReport.latitude + 2 };
      const race = await Promise.all([author.post("/api/reports", concurrentReport), author.post("/api/reports", concurrentReport)]);
      assert.deepEqual(race.map(response => response.status).sort(), [201, 409]);
      for (const response of race) await response.json();
    });

    await t.test("mantiene il limite antiabuso dopo un riavvio e un cambio di browser", async () => {
      const limited = browser(instance!.base, savedCookie);
      const before = (await (await limited.request("/api/reports")).json()).reports.length;
      let rejected = false;
      for (let attempt = 0; attempt < 21; attempt++) {
        const response = await limited.post("/api/reports", { ...validReport, latitude: 91 });
        await response.json();
        if (response.status === 429) { rejected = true; break; }
        assert.equal(response.status, 400);
      }
      assert(rejected, "il limite deve bloccare richieste ripetute anche se non valide");
      await instance!.stop();
      instance = await startWorker(directory, port);
      const newBrowser = browser(instance.base);
      const response = await newBrowser.post("/api/reports", validReport);
      assert.equal(response.status, 429, "riavvio e nuovo cookie non devono azzerare il limite IP");
      await response.json();
      const { reports } = await (await newBrowser.request("/api/reports")).json();
      assert.equal(reports.length, before, "la richiesta limitata non deve inserire un report");
    });
  } finally {
    firstSocket?.close(); secondSocket?.close();
    await instance?.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

test("Cloudflare migrates actual legacy Durable Object SQLite state and retains browser identity across restarts", { timeout: 120_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "passo-cloud-legacy-"));
  const configPath = join(directory, "wrangler.json");
  const legacyPath = join(directory, "legacy.ts");
  // An isolated previous-version Worker creates genuine persisted workerd
  // state. No private Miniflare directory or database filename is assumed.
  await writeFile(legacyPath, `
    import { DurableObject } from "cloudflare:workers";
    const identity = "1234567890abcdef1234567890abcdef";
    const secret = "12".repeat(32);
    const encoder = new TextEncoder();
    const hex = value => [...new Uint8Array(value)].map(byte => byte.toString(16).padStart(2, "0")).join("");
    export class RoadReports extends DurableObject {
      constructor(ctx, env) {
        super(ctx, env);
        this.sql = ctx.storage.sql;
        this.sql.exec(\`CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
          CREATE TABLE IF NOT EXISTS reports (
            id TEXT PRIMARY KEY, category TEXT NOT NULL, latitude REAL NOT NULL, longitude REAL NOT NULL,
            location TEXT NOT NULL, description TEXT NOT NULL, severity TEXT NOT NULL,
            created_at TEXT NOT NULL, expires_at TEXT NOT NULL);
          CREATE TABLE IF NOT EXISTS confirmations (
            report_id TEXT NOT NULL REFERENCES reports(id) ON DELETE CASCADE,
            participant_id TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY (report_id, participant_id));
          CREATE TABLE IF NOT EXISTS rate_windows (bucket TEXT PRIMARY KEY, count INTEGER NOT NULL, reset_at INTEGER NOT NULL);
        \`);
      }
      async fetch() {
        const participant = hex(await crypto.subtle.digest("SHA-256", encoder.encode(identity)));
        if (!this.sql.exec("SELECT key FROM metadata WHERE key = 'session_key'").toArray().length) {
          const now = Date.now();
          this.ctx.storage.transactionSync(() => {
            this.sql.exec("INSERT INTO metadata VALUES ('session_key', ?)", secret);
            const insert = (id, category, latitude, created, expires) => this.sql.exec(
              "INSERT INTO reports VALUES (?, ?, ?, ?, 'Legacy road', 'Legacy report', 'attention', ?, ?)",
              id, category, latitude, ${validReport.longitude}, new Date(created).toISOString(), new Date(expires).toISOString());
            insert("legacy-active", "pothole", ${validReport.latitude}, now - 1000, now + 86_400_000);
            insert("legacy-expired", "pothole", ${validReport.latitude + 3}, now - 90_000_000, now - 1000);
            for (let index = 0; index < 500; index++) insert("filler-" + index, "oil", 0, now, now + 86_400_000);
            this.sql.exec("INSERT INTO confirmations VALUES ('legacy-active', ?, ?)", participant, new Date(now).toISOString());
          });
        }
        const key = await crypto.subtle.importKey("raw", new Uint8Array(32).fill(0x12), {name:"HMAC", hash:"SHA-256"}, false, ["sign"]);
        const signature = hex(await crypto.subtle.sign("HMAC", key, encoder.encode(identity)));
        return new Response(JSON.stringify({status:"ok",storage:"sqlite",realtime:"websocket"}), {headers:{
          "Content-Type":"application/json", "Set-Cookie":"passo_session=" + identity + "." + signature + "; Path=/; HttpOnly; SameSite=Lax"
        }});
      }
    }
    export default {fetch(request, env) {return env.ROAD_REPORTS.get(env.ROAD_REPORTS.idFromName("global")).fetch(request);}};
  `);
  const config = {
    name: "passo-cloud-legacy", main: legacyPath, compatibility_date: "2026-10-19",
    durable_objects: { bindings: [{ name: "ROAD_REPORTS", class_name: "RoadReports" }] },
    migrations: [{ tag: "v1", new_sqlite_classes: ["RoadReports"] }],
  };
  await writeFile(configPath, JSON.stringify(config));
  const port = await availablePort();
  let instance: Awaited<ReturnType<typeof startWorker>> | undefined;
  try {
    instance = await startWorker(directory, port);
    const legacy = browser(instance.base);
    await (await legacy.request("/api/health")).json();
    const cookie = legacy.cookie;
    assert(cookie.startsWith("passo_session="));
    await instance.stop();
    await writeFile(configPath, JSON.stringify({ ...config, main: resolve("worker/index.ts") }));
    instance = await startWorker(directory, port);
    let restored = browser(instance.base, cookie);
    const listing = await restored.request("/api/reports");
    assert.equal(listing.headers.get("set-cookie"), null, "the legacy session signing key must survive migration");
    const { reports } = await listing.json();
    assert.equal(reports.length, 500);
    assert(!reports.some((report: Report) => report.id === "legacy-active"));
    const conflict = await restored.post("/api/reports", validReport);
    assert.equal(conflict.status, 409, "Worker duplicate checks must find a legacy report outside the map's 500-report cap");
    const conflictBody = await conflict.json();
    assert.equal(conflictBody.code, "POSSIBLE_DUPLICATE");
    assert.equal(conflictBody.duplicates.length, 1);
    const legacyReport = conflictBody.duplicates[0];
    assert.equal(legacyReport.id, "legacy-active");
    assert.equal(legacyReport.confirmations, 1);
    assert.equal(legacyReport.confirmedByMe, true);
    assert.equal(legacyReport.clearVotes, 0);
    assert.equal(legacyReport.clearedByMe, false);
    assert.equal(legacyReport.resolvedAt, null);
    const clear = await restored.post("/api/reports/legacy-active/clear", {});
    assert.equal(clear.status, 200);
    const { report: cleared } = await clear.json();
    assert.equal(cleared.clearVotes, 1);
    assert.equal(cleared.confirmations, 0);
    assert.equal(cleared.clearedByMe, true);
    assert.equal(cleared.expiresAt, legacyReport.expiresAt);
    for (const action of ["clear", "confirm"]) {
      const expired = await restored.post(`/api/reports/legacy-expired/${action}`, {});
      assert.equal(expired.status, 410);
      await expired.json();
    }
    const replacement = await restored.post("/api/reports", { ...validReport, latitude: validReport.latitude + 3 });
    assert.equal(replacement.status, 201, "expired persisted reports must not block creation");
    await replacement.json();
    await instance.stop();
    instance = await startWorker(directory, port);
    restored = browser(instance.base, cookie);
    const retry = await restored.post("/api/reports/legacy-active/clear", {});
    assert.equal(retry.status, 200);
    assert.equal(retry.headers.get("set-cookie"), null);
    assert.deepEqual((await retry.json()).report, cleared, "clear votes and browser identity must persist across restarts");
    for (const voter of [browser(instance.base), browser(instance.base)]) {
      const response = await voter.post("/api/reports/legacy-active/clear", {});
      assert.equal(response.status, 200);
      await response.json();
    }
    await instance.stop();
    instance = await startWorker(directory, port);
    restored = browser(instance.base, cookie);
    const terminal = await restored.post("/api/reports/legacy-active/clear");
    assert.equal(terminal.status, 200);
    const resolved = (await terminal.json()).report;
    assert.equal(resolved.clearVotes, 3);
    assert(resolved.resolvedAt);
    const revival = await restored.post("/api/reports/legacy-active/confirm", {});
    assert.equal(revival.status, 410);
    await revival.json();
    const newReport = await restored.post("/api/reports", validReport);
    assert.equal(newReport.status, 201, "resolution must remain terminal after restart and stop blocking new reports");
    await newReport.json();
  } finally {
    await instance?.stop();
    await rm(directory, { recursive: true, force: true });
  }
});
