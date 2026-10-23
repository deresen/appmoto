import assert from "node:assert/strict";
import { test } from "node:test";
import { onRequest } from "../functions/api/[[path]].js";

test("Pages forwards the original write request through the service binding and preserves the response", async (t) => {
  t.mock.method(globalThis, "fetch", () => { throw new Error("External fetch must not be used"); });
  const body = JSON.stringify({ category: "pothole", description: "Buca sulla carreggiata" });
  const request = new Request("https://passo-test.pages.dev/api/reports?test=1", {
    method: "POST",
    headers: {
      Origin: "https://passo-test.pages.dev", "Content-Type": "application/json",
      Cookie: "passo_session=browser-signature", "Sec-Fetch-Site": "same-origin",
    },
    body,
  });
  const upstream = new Response('{"report":{"id":"report-1"}}', {
    status: 201,
    headers: {
      "Content-Type": "application/json", "Cache-Control": "no-store",
      "Set-Cookie": "passo_session=browser-signature; HttpOnly; Secure; SameSite=Lax; Path=/",
    },
  });
  let calls = 0;
  const response = await onRequest({ request, env: { APPMOTO_API: {
    async fetch(forwarded) {
      calls += 1;
      assert.equal(forwarded, request);
      assert.equal(forwarded.url, "https://passo-test.pages.dev/api/reports?test=1");
      assert.equal(forwarded.method, "POST");
      assert.equal(forwarded.headers.get("Origin"), "https://passo-test.pages.dev");
      assert.equal(forwarded.headers.get("Cookie"), "passo_session=browser-signature");
      assert.equal(forwarded.headers.get("Sec-Fetch-Site"), "same-origin");
      assert.equal(await forwarded.text(), body);
      return upstream;
    },
  } } });
  assert.equal(calls, 1);
  assert.equal(response, upstream);
  assert.equal(response.status, 201);
  assert.match(response.headers.get("Set-Cookie") ?? "", /HttpOnly; Secure; SameSite=Lax; Path=\//);
});

test("Pages preserves WebSocket upgrades and does not wrap the binding's 101 response", async (t) => {
  t.mock.method(globalThis, "fetch", () => { throw new Error("External fetch must not be used"); });
  const request = new Request("https://passo-test.pages.dev/api/events?segnalazione=report-1", {
    headers: {
      Upgrade: "websocket", Connection: "Upgrade", Origin: "https://passo-test.pages.dev",
      Cookie: "passo_session=browser-signature",
    },
  });
  // Node's Response rejects status 101; the real workerd response also carries
  // its WebSocket endpoint, so preserving this object is essential.
  const upstream = { status: 101, webSocket: { endpoint: "client" } } as unknown as Response;
  const response = await onRequest({ request, env: { APPMOTO_API: {
    async fetch(forwarded) {
      assert.equal(forwarded, request);
      assert.equal(forwarded.headers.get("Upgrade"), "websocket");
      assert.equal(new URL(forwarded.url).searchParams.get("segnalazione"), "report-1");
      return upstream;
    },
  } } });
  assert.equal(response, upstream);
});

test("Pages returns an uncached Italian error when its service binding is missing or unavailable", async (t) => {
  t.mock.method(globalThis, "fetch", () => { throw new Error("External fetch must not be used"); });
  const request = new Request("https://passo-test.pages.dev/api/health");
  for (const env of [
    {},
    { APPMOTO_API: { async fetch(): Promise<Response> { throw new Error("Internal binding details must stay private"); } } },
  ]) {
    const response = await onRequest({ request, env });
    assert.equal(response.status, 503);
    assert.equal(response.headers.get("Cache-Control"), "no-store");
    assert.match(response.headers.get("Content-Type") ?? "", /^application\/json/);
    const error = await response.json();
    assert.deepEqual(error, { error: "Il servizio delle segnalazioni non è disponibile. Riprova tra poco." });
  }
});
