import assert from "node:assert/strict";
import { createServer } from "node:http";
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
  } finally {
    await instance.close();
  }
});

test("SSE sends real creations and confirmations to two browsers with individual confirmation state", async () => {
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
        VALUES (?, 'gravel', 45.6, 10.5, 'Salò', '', 'attention', ?, ?, 'community')`);
      fixtureDb.exec("BEGIN");
      for (let index = 0; index < 501; index++) {
        insert.run(
          `report-${index}`,
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
