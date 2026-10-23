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

    await t.test("mantiene il limite antiabuso dopo un riavvio e un cambio di browser", async () => {
      const limited = browser(instance!.base, savedCookie);
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
      assert.equal(reports.length, 1, "la richiesta limitata non deve inserire un report");
    });
  } finally {
    firstSocket?.close(); secondSocket?.close();
    await instance?.stop();
    await rm(directory, { recursive: true, force: true });
  }
});
