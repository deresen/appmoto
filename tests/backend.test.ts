import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createHash, createHmac } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import {
  createApp,
  REPORT_LIFETIME_MS,
  type AppOptions,
  type RoadReport,
} from "../server/app.js";

const validReport = {
  category: "gravel",
  latitude: 45.6076,
  longitude: 10.521,
  location: "Salò · Via Garibaldi",
  description: "Ghiaia dopo la curva.",
  severity: "attention",
};

async function start(options: AppOptions) {
  const application = createApp({
    seedDemo: false,
    serveFrontend: false,
    ...options,
  });
  const server = createServer(application.app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;
  let closed = false;
  return {
    base,
    async close() {
      if (closed) return;
      closed = true;
      application.close();
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}

function client(base: string, existingCookie = "") {
  let cookie = existingCookie;
  return {
    get cookie() {
      return cookie;
    },
    async request(path: string, init: RequestInit = {}) {
      const headers = new Headers(init.headers);
      if (cookie) headers.set("cookie", cookie);
      const response = await fetch(`${base}${path}`, { ...init, headers });
      const setCookie = response.headers.get("set-cookie");
      if (setCookie) cookie = setCookie.split(";")[0];
      return response;
    },
    async post(path: string, value?: unknown) {
      return this.request(path, {
        method: "POST",
        ...(value === undefined
          ? {}
          : {
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(value),
            }),
      });
    },
  };
}

async function eventStream(browser: ReturnType<typeof client>) {
  const controller = new AbortController();
  const response = await browser.request("/api/events", {
    signal: controller.signal,
  });
  assert.equal(response.status, 200);
  assert.match(
    response.headers.get("content-type") ?? "",
    /text\/event-stream/,
  );
  assert(response.body);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  return {
    async next(): Promise<RoadReport[]> {
      const timeout = setTimeout(() => controller.abort(), 5000);
      try {
        while (true) {
          const boundary = buffer.indexOf("\n\n");
          if (boundary >= 0) {
            const message = buffer.slice(0, boundary);
            buffer = buffer.slice(boundary + 2);
            const line = message
              .split("\n")
              .find((line) => line.startsWith("data: "));
            if (message.includes("event: reports") && line)
              return JSON.parse(line.slice(6)).reports;
            continue;
          }
          const { done, value } = await reader.read();
          assert.equal(done, false, "SSE stream must remain open");
          buffer += decoder.decode(value, { stream: true });
        }
      } finally {
        clearTimeout(timeout);
      }
    },
    close() {
      controller.abort();
      void reader.cancel().catch(() => {});
    },
  };
}

test("health and six explicitly tagged demos; seeding is repeatable", async () => {
  const directory = await mkdtemp(join(tmpdir(), "appmoto-demo-"));
  const dbPath = join(directory, "test.sqlite");
  let instance = await start({ dbPath, seedDemo: true });
  try {
    const browser = client(instance.base);
    const health = await browser.request("/api/health");
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), {
      status: "ok",
      storage: "sqlite",
      realtime: "sse",
    });
    assert.match(health.headers.get("set-cookie") ?? "", /HttpOnly/);
    assert.match(health.headers.get("set-cookie") ?? "", /SameSite=Lax/);
    const { reports } = await (await browser.request("/api/reports")).json();
    assert.equal(reports.length, 6);
    assert(
      reports.every(
        (report: RoadReport) =>
          report.source === "demo" && !report.confirmedByMe,
      ),
    );
    assert.equal(
      new Set(reports.map((report: RoadReport) => report.category)).size,
      5,
    );
    await instance.close();
    instance = await start({ dbPath, seedDemo: true });
    const refreshed = await (
      await client(instance.base).request("/api/reports")
    ).json();
    assert.equal(
      refreshed.reports.length,
      6,
      "restart must not duplicate demo data",
    );
  } finally {
    await instance.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("creates a community report and persists it, its confirmation and browser identity across restart", async () => {
  const directory = await mkdtemp(join(tmpdir(), "appmoto-persist-"));
  const dbPath = join(directory, "test.sqlite");
  let instance = await start({ dbPath });
  try {
    const browser = client(instance.base);
    const result = await browser.post("/api/reports", validReport);
    assert.equal(result.status, 201);
    const { report } = await result.json();
    assert.equal(report.source, "community");
    assert.equal(report.confirmations, 0);
    assert.equal(report.clearVotes, 0);
    assert.equal(report.clearedByMe, false);
    assert.equal(report.resolvedAt, null);
    assert.equal(
      Date.parse(report.expiresAt) - Date.parse(report.createdAt),
      REPORT_LIFETIME_MS,
    );
    assert.equal(report.location, validReport.location);
    const confirmation = await browser.post(
      `/api/reports/${report.id}/confirm`,
    );
    assert.equal(confirmation.status, 200);
    assert.equal((await confirmation.json()).report.confirmedByMe, true);
    const cookie = browser.cookie;
    await instance.close();
    instance = await start({ dbPath });
    const { reports } = await (
      await client(instance.base, cookie).request("/api/reports")
    ).json();
    assert.equal(reports.length, 1);
    assert.equal(reports[0].id, report.id);
    assert.equal(reports[0].confirmations, 1);
    assert.equal(reports[0].confirmedByMe, true);
  } finally {
    await instance.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("validates coordinates, category, text limits and malformed JSON; rejects cross-site writes", async () => {
  const instance = await start({ dbPath: ":memory:" });
  try {
    const browser = client(instance.base);
    for (const data of [
      { ...validReport, latitude: 95 },
      { ...validReport, longitude: -181 },
      { ...validReport, category: "other" },
      { ...validReport, description: "x".repeat(501) },
      { ...validReport, location: "  " },
      { ...validReport, extra: true },
    ]) {
      const response = await browser.post("/api/reports", data);
      assert.equal(response.status, 400);
      assert.equal(typeof (await response.json()).error, "string");
    }
    const malformed = await browser.request("/api/reports", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{broken",
    });
    assert.equal(malformed.status, 400);
    await malformed.json();
    const foreign = await browser.request("/api/reports", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: "https://untrusted.example",
      },
      body: JSON.stringify(validReport),
    });
    assert.equal(foreign.status, 403);
    await foreign.json();
    const missing = await browser.post("/api/reports/not-found/confirm");
    assert.equal(missing.status, 404);
    await missing.json();
    const { reports } = await (await browser.request("/api/reports")).json();
    assert.deepEqual(reports, []);
  } finally {
    await instance.close();
  }
});

test("confirmation is idempotent per browser and does not extend expiry; expired reports disappear", async () => {
  let clock = Date.parse("2026-10-22T10:00:00Z");
  const instance = await start({ dbPath: ":memory:", now: () => clock });
  try {
    const first = client(instance.base);
    const second = client(instance.base);
    const { report } = await (
      await first.post("/api/reports", validReport)
    ).json();
    const one = await (
      await first.post(`/api/reports/${report.id}/confirm`)
    ).json();
    const duplicate = await (
      await first.post(`/api/reports/${report.id}/confirm`)
    ).json();
    assert.equal(one.report.confirmations, 1);
    assert.equal(duplicate.report.confirmations, 1);
    assert.equal(duplicate.report.expiresAt, report.expiresAt);
    const otherView = await (await second.request("/api/reports")).json();
    assert.equal(otherView.reports[0].confirmedByMe, false);
    const two = await (
      await second.post(`/api/reports/${report.id}/confirm`)
    ).json();
    assert.equal(two.report.confirmations, 2);
    clock += REPORT_LIFETIME_MS + 1;
    const expired = await (await first.request("/api/reports")).json();
    assert.deepEqual(expired.reports, []);
    const late = await first.post(`/api/reports/${report.id}/confirm`);
    assert.equal(late.status, 410);
    await late.json();
    const lateClear = await first.post(`/api/reports/${report.id}/clear`, {});
    assert.equal(lateClear.status, 410);
    await lateClear.json();
  } finally {
    await instance.close();
  }
});

test("SSE sends creation, mutually exclusive votes and resolved removal with individual browser state", async () => {
  const instance = await start({ dbPath: ":memory:" });
  let firstEvents: Awaited<ReturnType<typeof eventStream>> | undefined;
  let secondEvents: Awaited<ReturnType<typeof eventStream>> | undefined;
  try {
    const first = client(instance.base);
    const second = client(instance.base);
    await (await first.request("/api/health")).json();
    await (await second.request("/api/health")).json();
    assert.notEqual(first.cookie, second.cookie);
    firstEvents = await eventStream(first);
    secondEvents = await eventStream(second);
    assert.deepEqual(await firstEvents.next(), []);
    assert.deepEqual(await secondEvents.next(), []);
    const { report } = await (
      await second.post("/api/reports", validReport)
    ).json();
    assert.equal((await firstEvents.next())[0].id, report.id);
    assert.equal((await secondEvents.next())[0].id, report.id);
    await (await first.post(`/api/reports/${report.id}/confirm`)).json();
    const firstSnapshot = await firstEvents.next();
    const secondSnapshot = await secondEvents.next();
    assert.equal(firstSnapshot[0].confirmations, 1);
    assert.equal(secondSnapshot[0].confirmations, 1);
    assert.equal(firstSnapshot[0].confirmedByMe, true);
    assert.equal(secondSnapshot[0].confirmedByMe, false);
    const cleared = await first.post(`/api/reports/${report.id}/clear`, {});
    assert.equal(cleared.status, 200);
    await cleared.json();
    const firstClear = await firstEvents.next();
    const secondClear = await secondEvents.next();
    assert.equal(firstClear[0].confirmations, 0);
    assert.equal(firstClear[0].clearVotes, 1);
    assert.equal(firstClear[0].clearedByMe, true);
    assert.equal(firstClear[0].confirmedByMe, false);
    assert.equal(secondClear[0].clearedByMe, false);
    await (await second.post(`/api/reports/${report.id}/clear`)).json();
    assert.equal((await firstEvents.next())[0].clearVotes, 2);
    assert.equal((await secondEvents.next())[0].clearedByMe, true);
    const third = client(instance.base);
    const resolved = await third.post(`/api/reports/${report.id}/clear`, {});
    assert.equal(resolved.status, 200);
    assert((await resolved.json()).report.resolvedAt);
    assert.deepEqual(await firstEvents.next(), [], "resolution must remove the report from existing SSE sessions");
    assert.deepEqual(await secondEvents.next(), []);
  } finally {
    firstEvents?.close();
    secondEvents?.close();
    await instance.close();
  }
});

test("confirms an active report outside the capped map list without losing its response", async () => {
  const directory = await mkdtemp(join(tmpdir(), "appmoto-volume-"));
  const dbPath = join(directory, "test.sqlite");
  const clock = Date.parse("2026-10-22T10:00:00Z");
  const instance = await start({ dbPath, now: () => clock });
  try {
    const fixtureDb = new DatabaseSync(dbPath);
    try {
      const insert = fixtureDb.prepare(`INSERT INTO reports
        (id, category, latitude, longitude, location, description, severity, created_at, expires_at, source)
        VALUES (?, 'gravel', ?, ?, 'Salò', '', 'attention', ?, ?, 'community')`);
      fixtureDb.exec("BEGIN");
      for (let index = 0; index < 501; index++) {
        insert.run(
          `report-${index}`,
          index === 500 ? validReport.latitude : 44,
          index === 500 ? validReport.longitude : 9,
          new Date(clock - index * 1000).toISOString(),
          new Date(clock + REPORT_LIFETIME_MS).toISOString(),
        );
      }
      fixtureDb.exec("COMMIT");
    } finally {
      fixtureDb.close();
    }
    const browser = client(instance.base);
    const { reports } = await (await browser.request("/api/reports")).json();
    assert.equal(reports.length, 500);
    assert(!reports.some((report: RoadReport) => report.id === "report-500"));
    const confirmation = await browser.post("/api/reports/report-500/confirm");
    assert.equal(confirmation.status, 200);
    const { report } = await confirmation.json();
    assert.equal(report.id, "report-500");
    assert.equal(report.confirmations, 1);
    const duplicate = await browser.post("/api/reports", validReport);
    assert.equal(duplicate.status, 409, "duplicate detection must include reports outside the capped map list");
    const conflict = await duplicate.json();
    assert.equal(conflict.code, "POSSIBLE_DUPLICATE");
    assert.deepEqual(conflict.duplicates.map((item: RoadReport) => item.id), ["report-500"]);
  } finally {
    await instance.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("trusts HTTPS headers only with proxy opt-in and keeps production cookies secure", async () => {
  const previousNodeEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = "test";
  const untrusted = await start({ dbPath: ":memory:", trustProxy: false });
  const trusted = await start({ dbPath: ":memory:", trustProxy: true });
  try {
    const ignoredHeader = await client(untrusted.base).request("/api/health", {
      headers: { "X-Forwarded-Proto": "https" },
    });
    assert.doesNotMatch(ignoredHeader.headers.get("set-cookie") ?? "", /; Secure(?:;|$)/);
    await ignoredHeader.json();

    const proxyHttps = await client(trusted.base).request("/api/health", {
      headers: { "X-Forwarded-Proto": "https" },
    });
    assert.match(proxyHttps.headers.get("set-cookie") ?? "", /; Secure(?:;|$)/);
    await proxyHttps.json();

    const spoofedHost = await client(trusted.base).request("/api/reports", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: "https://untrusted.example",
        "X-Forwarded-Host": "untrusted.example",
        "X-Forwarded-Proto": "https",
      },
      body: JSON.stringify(validReport),
    });
    assert.equal(spoofedHost.status, 403, "forwarded host must not override the origin guard");
    await spoofedHost.json();

    process.env.NODE_ENV = "production";
    const productionCookie = await client(untrusted.base).request("/api/health");
    assert.match(productionCookie.headers.get("set-cookie") ?? "", /; Secure(?:;|$)/);
    await productionCookie.json();
  } finally {
    if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousNodeEnv;
    await untrusted.close();
    await trusted.close();
  }
});

test("clear votes are unique per browser, exclusive with confirmations and terminal at three votes", async () => {
  let clock = Date.parse("2026-10-23T10:00:00Z");
  const instance = await start({ dbPath: ":memory:", now: () => clock });
  try {
    const first = client(instance.base);
    const second = client(instance.base);
    const third = client(instance.base);
    const outsider = client(instance.base);
    const { report: original } = await (await first.post("/api/reports", validReport)).json();
    const path = `/api/reports/${original.id}`;
    await (await first.post(`${path}/confirm`)).json();
    const repeated = await Promise.all([
      first.post(`${path}/clear/`, {}), first.post(`${path}/CLEAR`), first.post(`${path}/clear`, {}),
    ]);
    for (const response of repeated) {
      assert.equal(response.status, 200);
      const { report } = await response.json();
      assert.equal(report.clearVotes, 1);
      assert.equal(report.confirmations, 0);
      assert.equal(report.clearedByMe, true);
      assert.equal(report.confirmedByMe, false);
      assert.equal(report.resolvedAt, null);
      assert.equal(report.expiresAt, original.expiresAt);
    }
    const restored = await (await first.post(`${path}/confirm`, {})).json();
    assert.equal(restored.report.confirmations, 1);
    assert.equal(restored.report.clearVotes, 0);
    assert.equal(restored.report.clearedByMe, false);
    await (await first.post(`${path}/clear`)).json();
    const secondVote = await second.post(`${path}/clear`, {});
    assert.equal(secondVote.status, 200);
    assert.equal((await secondVote.json()).report.clearVotes, 2);
    clock += 60_000;
    const resolution = await third.post(`${path}/clear`);
    assert.equal(resolution.status, 200);
    const { report: resolved } = await resolution.json();
    assert.equal(resolved.clearVotes, 3);
    assert.equal(resolved.resolvedAt, new Date(clock).toISOString());
    assert.equal(resolved.expiresAt, original.expiresAt);
    assert.deepEqual(await (await first.request("/api/reports")).json(), { reports: [] });
    for (const voter of [first, second, third]) {
      const retry = await voter.post(`${path}/clear`, {});
      assert.equal(retry.status, 200);
      assert.deepEqual((await retry.json()).report, { ...resolved, clearedByMe: true });
      const revival = await voter.post(`${path}/confirm`);
      assert.equal(revival.status, 410, "a resolved report cannot be brought back by a confirmation");
      await revival.json();
    }
    const lateVote = await outsider.post(`${path}/clear`);
    assert.equal(lateVote.status, 410);
    await lateVote.json();
    clock = Date.parse(original.expiresAt);
    const expiredRetry = await third.post(`${path}/clear`);
    assert.equal(expiredRetry.status, 410, "expiry takes precedence over resolution retry idempotence");
    await expiredRetry.json();
  } finally {
    await instance.close();
  }
});

test("concurrent confirmation and clear from one browser cannot leave contradictory votes", async () => {
  const instance = await start({ dbPath: ":memory:" });
  try {
    const browser = client(instance.base);
    const { report } = await (await browser.post("/api/reports", validReport)).json();
    const requests = await Promise.all([
      browser.post(`/api/reports/${report.id}/clear`, {}),
      browser.post(`/api/reports/${report.id}/confirm`, {}),
    ]);
    for (const response of requests) {
      assert.equal(response.status, 200);
      await response.json();
    }
    const { reports } = await (await browser.request("/api/reports")).json();
    assert.equal(reports[0].clearVotes + reports[0].confirmations, 1);
    assert.notEqual(reports[0].clearedByMe, reports[0].confirmedByMe);
    const crossSite = await browser.request(`/api/reports/${report.id}/clear`, {
      method: "POST", headers: { Origin: "https://untrusted.example" },
    });
    assert.equal(crossSite.status, 403);
    await crossSite.json();
    const crossSiteHeader = await browser.request(`/api/reports/${report.id}/clear`, {
      method: "POST", headers: { "Sec-Fetch-Site": "cross-site" },
    });
    assert.equal(crossSiteHeader.status, 403);
    await crossSiteHeader.json();
    assert.deepEqual((await (await browser.request("/api/reports")).json()).reports, reports);
    const missing = await browser.post("/api/reports/not-found/clear");
    assert.equal(missing.status, 404);
    await missing.json();
  } finally {
    await instance.close();
  }
});

test("duplicate guard uses category and a 75m radius, returns the three nearest and permits distinct hazards", async () => {
  const instance = await start({ dbPath: ":memory:" });
  try {
    const browser = client(instance.base);
    const atDistance = (metres: number) => ({
      ...validReport, latitude: validReport.latitude + metres / 6_371_000 * 180 / Math.PI,
    });
    const original = await browser.post("/api/reports", atDistance(0));
    assert.equal(original.status, 201);
    const originalId = (await original.json()).report.id;
    const inside = await browser.post("/api/reports", atDistance(74.99));
    assert.equal(inside.status, 409);
    const insideBody = await inside.json();
    assert.equal(insideBody.code, "POSSIBLE_DUPLICATE");
    assert.deepEqual(insideBody.duplicates.map((report: RoadReport) => report.id), [originalId]);
    const outside = await browser.post("/api/reports", atDistance(75.01));
    assert.equal(outside.status, 201);
    await outside.json();
    const otherCategory = await browser.post("/api/reports", { ...atDistance(0), category: "oil" });
    assert.equal(otherCategory.status, 201);
    await otherCategory.json();
    const nearestIds = [originalId];
    for (const metres of [20, 40, 60]) {
      const explicit = await browser.post("/api/reports", { ...atDistance(metres), allowDuplicate: true });
      assert.equal(explicit.status, 201);
      nearestIds.push((await explicit.json()).report.id);
    }
    const conflict = await browser.post("/api/reports", atDistance(0));
    assert.equal(conflict.status, 409);
    const body = await conflict.json();
    assert.equal(typeof body.error, "string");
    assert.equal(body.code, "POSSIBLE_DUPLICATE");
    assert.deepEqual(body.duplicates.map((report: RoadReport) => report.id), nearestIds.slice(0, 3));
    const list = await (await browser.request("/api/reports")).json();
    assert.equal(list.reports.length, 6, "conflicts must not insert a report");
    const invalidOverride = await browser.post("/api/reports", { ...validReport, allowDuplicate: "true" });
    assert.equal(invalidOverride.status, 400);
    await invalidOverride.json();
  } finally {
    await instance.close();
  }
});

test("duplicate checks exclude demo, expired and resolved reports, and serialize simultaneous creation", async () => {
  let clock = Date.parse("2026-10-23T10:00:00Z");
  const instance = await start({ dbPath: ":memory:", seedDemo: true, now: () => clock });
  try {
    const first = client(instance.base);
    const demoLocation = { ...validReport, category: "pothole", latitude: 45.4714, longitude: 10.535 };
    const nearDemo = await first.post("/api/reports", demoLocation);
    assert.equal(nearDemo.status, 201, "demo reports must not block real community reports");
    await nearDemo.json();
    const simultaneous = await Promise.all([
      first.post("/api/reports", validReport), first.post("/api/reports", validReport),
    ]);
    assert.deepEqual(simultaneous.map(response => response.status).sort(), [201, 409]);
    const bodies = await Promise.all(simultaneous.map(response => response.json()));
    const report = bodies.find(body => body.report).report;
    for (const voter of [first, client(instance.base), client(instance.base)]) {
      const response = await voter.post(`/api/reports/${report.id}/clear`, {});
      assert.equal(response.status, 200);
      await response.json();
    }
    const replacement = await first.post("/api/reports", validReport);
    assert.equal(replacement.status, 201, "resolved reports must not remain duplicate candidates");
    await replacement.json();
    clock += REPORT_LIFETIME_MS;
    const afterExpiry = await first.post("/api/reports", validReport);
    assert.equal(afterExpiry.status, 201, "expired reports must not block a new hazard");
    await afterExpiry.json();
  } finally {
    await instance.close();
  }
});

test("migrates a legacy SQLite database without losing reports, confirmations or signed sessions", async () => {
  const directory = await mkdtemp(join(tmpdir(), "appmoto-legacy-"));
  const dbPath = join(directory, "legacy.sqlite");
  const clock = Date.parse("2026-10-23T10:00:00Z");
  const legacyKey = "legacy-session-key-used-by-the-previous-version";
  const identity = "1234567890abcdef1234567890abcdef";
  const participant = createHash("sha256").update(identity).digest("hex");
  const cookie = `passo_session=${identity}.${createHmac("sha256", legacyKey).update(identity).digest("hex")}`;
  const fixture = new DatabaseSync(dbPath);
  // These are the schema and cookie format used before the clear-vote feature.
  fixture.exec(`
    CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE reports (
      id TEXT PRIMARY KEY, category TEXT NOT NULL, latitude REAL NOT NULL, longitude REAL NOT NULL,
      location TEXT NOT NULL, description TEXT NOT NULL, severity TEXT NOT NULL,
      created_at TEXT NOT NULL, expires_at TEXT NOT NULL,
      initial_confirmations INTEGER NOT NULL DEFAULT 0, source TEXT NOT NULL
    );
    CREATE TABLE confirmations (
      report_id TEXT NOT NULL REFERENCES reports(id) ON DELETE CASCADE,
      participant_id TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY (report_id, participant_id)
    );
  `);
  fixture.prepare("INSERT INTO metadata VALUES ('session_key', ?)").run(legacyKey);
  fixture.prepare("INSERT INTO reports VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
    "legacy-report", validReport.category, validReport.latitude, validReport.longitude,
    validReport.location, validReport.description, validReport.severity,
    new Date(clock).toISOString(), new Date(clock + REPORT_LIFETIME_MS).toISOString(), 4, "community",
  );
  fixture.prepare("INSERT INTO confirmations VALUES (?, ?, ?)").run("legacy-report", participant, new Date(clock).toISOString());
  fixture.close();
  let instance: Awaited<ReturnType<typeof start>> | undefined;
  try {
    instance = await start({ dbPath, now: () => clock });
    const oldBrowser = client(instance.base, cookie);
    const listing = await oldBrowser.request("/api/reports");
    assert.equal(listing.headers.get("set-cookie"), null, "migration must retain the signing key");
    const { reports } = await listing.json();
    assert.equal(reports.length, 1);
    assert.equal(reports[0].id, "legacy-report");
    assert.equal(reports[0].confirmations, 5);
    assert.equal(reports[0].confirmedByMe, true);
    assert.equal(reports[0].clearVotes, 0);
    assert.equal(reports[0].clearedByMe, false);
    assert.equal(reports[0].resolvedAt, null);
    const changed = await oldBrowser.post("/api/reports/legacy-report/clear", {});
    assert.equal(changed.status, 200);
    const { report } = await changed.json();
    assert.equal(report.confirmations, 4);
    assert.equal(report.clearVotes, 1);
    assert.equal(report.clearedByMe, true);
    await instance.close();
    instance = await start({ dbPath, now: () => clock });
    const restored = await client(instance.base, cookie).request("/api/reports");
    assert.equal(restored.headers.get("set-cookie"), null);
    assert.deepEqual((await restored.json()).reports, [report]);
    for (const voter of [client(instance.base), client(instance.base)]) {
      const response = await voter.post("/api/reports/legacy-report/clear", {});
      assert.equal(response.status, 200);
      await response.json();
    }
    await instance.close();
    instance = await start({ dbPath, now: () => clock });
    const browser = client(instance.base, cookie);
    assert.deepEqual(await (await browser.request("/api/reports")).json(), { reports: [] });
    const retry = await browser.post("/api/reports/legacy-report/clear", {});
    assert.equal(retry.status, 200);
    assert.equal((await retry.json()).report.clearVotes, 3);
  } finally {
    await instance?.close();
    await rm(directory, { recursive: true, force: true });
  }
});
