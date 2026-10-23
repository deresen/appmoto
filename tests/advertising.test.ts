import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { build } from "vite";
import {
  advertisingOwnership,
  hasAdvertisingConsent,
  isAdvertisingConfigured,
  normalizePublisherId,
  parseAdvertisingConfig,
} from "../shared/advertising.js";
import { advertisingOwnershipPlugin } from "../vite.config.js";

const publisherId = "pub-1234567890123456";
const configured = {
  enabled: true, publisherId,
  slots: { afterMap: "1234567890", footer: "2345678901" },
  cmpScriptUrl: `https://fundingchoicesmessages.google.com/i/${publisherId}?ers=1`,
};
const consent = {
  cmpStatus: "loaded", eventStatus: "useractioncomplete", gdprApplies: true,
  purpose: { consents: { "1": true, "3": true, "4": true } },
  vendor: { consents: { "755": true } },
};

test("advertising stays inactive until explicit activation, valid ad units and a matching Google CMP are configured", () => {
  assert.equal(isAdvertisingConfigured(parseAdvertisingConfig({ ...configured, enabled: false })), false);
  for (const input of [undefined, null, [], "true", {}, { ...configured, enabled: "true" },
    { ...configured, publisherId: "pub-invalid" }, { ...configured, slots: {} }, { ...configured, cmpScriptUrl: "" }]) {
    assert.equal(isAdvertisingConfigured(parseAdvertisingConfig(input)), false);
  }
  assert.equal(isAdvertisingConfigured(parseAdvertisingConfig(configured)), true);
  assert.equal(normalizePublisherId(`ca-${publisherId}`), publisherId);
  assert.equal(parseAdvertisingConfig({ ...configured, slots: { afterMap: "javascript:alert(1)" } }).slots.afterMap, "");
  assert.equal(parseAdvertisingConfig({ ...configured, slots: { afterMap: "1234567890\n" } }).slots.afterMap, "");
});

test("CMP configuration cannot load a different publisher, an unrelated host or extra script parameters", () => {
  for (const url of [
    "http://fundingchoicesmessages.google.com/i/pub-1234567890123456?ers=1",
    "https://fundingchoicesmessages.google.com.evil.example/i/pub-1234567890123456?ers=1",
    "https://fundingchoicesmessages.google.com/i/pub-0000000000000000?ers=1",
    `${configured.cmpScriptUrl}&callback=anything`, `${configured.cmpScriptUrl}#fragment`,
    "https://name:password@fundingchoicesmessages.google.com/i/pub-1234567890123456?ers=1",
  ]) assert.equal(isAdvertisingConfigured(parseAdvertisingConfig({ ...configured, cmpScriptUrl: url })), false);
  assert.equal(parseAdvertisingConfig(configured).cmpScriptUrl, configured.cmpScriptUrl);
});

test("advertising consent requires a loaded CMP and explicit Google, storage and personalisation permissions", () => {
  assert.equal(hasAdvertisingConsent(consent), true);
  assert.equal(hasAdvertisingConsent({ ...consent, eventStatus: "tcloaded" }), true);
  for (const input of [undefined, null, {}, { ...consent, cmpStatus: "loading" },
    { ...consent, eventStatus: "cmpuishown" }, { ...consent, gdprApplies: false },
    { ...consent, gdprApplies: undefined }, { ...consent, vendor: { consents: { "755": false } } },
    { ...consent, vendor: { consents: { "755": "true" } } },
    ...["1", "3", "4"].map(purpose => ({ ...consent, purpose: { consents: { ...consent.purpose.consents, [purpose]: false } } })),
  ]) assert.equal(hasAdvertisingConsent(input), false);
  assert.equal(hasAdvertisingConsent({ ...consent, purpose: { legitimateInterests: { "1": true, "3": true, "4": true } } }), false);
});

test("ownership verification is independent from serving ads and rejects malformed publisher identifiers", () => {
  assert.deepEqual(advertisingOwnership({ ...configured, enabled: false }), {
    clientId: `ca-${publisherId}`,
    adsTxt: `google.com, ${publisherId}, DIRECT, f08c47fec0942fa0\n`,
  });
  for (const input of ["", "pub-1", "pub-12345678901234567", "pub-1234567890123456\" onload=anything", 123]) {
    assert.equal(advertisingOwnership({ publisherId: input }), null);
  }
});

test("a production build exposes account verification and ads.txt without inserting an advertising script", async () => {
  const directory = await mkdtemp(join(tmpdir(), "passo-advertising-build-"));
  try {
    await writeFile(join(directory, "index.html"), "<!doctype html><html><head><title>Passo</title></head><body>Passo</body></html>");
    const result = await build({
      configFile: false, root: directory, logLevel: "silent",
      plugins: [advertisingOwnershipPlugin(() => ({ ...configured, enabled: false }))],
      build: { write: false },
    });
    const outputs = (Array.isArray(result) ? result : [result]).flatMap(bundle => "output" in bundle ? bundle.output : []);
    const index = outputs.find(asset => asset.type === "asset" && asset.fileName === "index.html");
    const ads = outputs.find(asset => asset.type === "asset" && asset.fileName === "ads.txt");
    assert(index?.type === "asset" && ads?.type === "asset");
    const html = String(index.source);
    assert.match(html, /name="google-adsense-account"/);
    assert(html.includes(`content="ca-${publisherId}"`));
    assert.doesNotMatch(html, /<script|googlesyndication|fundingchoices/);
    assert.equal(String(ads.source), `google.com, ${publisherId}, DIRECT, f08c47fec0942fa0\n`);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
