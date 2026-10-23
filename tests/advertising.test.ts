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

test("the app's ad units require explicit activation, valid slots and a matching Google CMP", () => {
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

test("head script loading is an explicit boolean and does not activate the app's ad units", () => {
  assert.equal(parseAdvertisingConfig({ ...configured, loadScriptInHead: true }).loadScriptInHead, true);
  for (const value of [undefined, false, "true", 1, null]) {
    assert.equal(parseAdvertisingConfig({ ...configured, loadScriptInHead: value }).loadScriptInHead, false);
  }
  for (const input of [
    { ...configured, loadScriptInHead: true, enabled: false },
    { ...configured, loadScriptInHead: true, slots: {} },
    { ...configured, loadScriptInHead: true, cmpScriptUrl: "" },
    { publisherId, loadScriptInHead: true },
  ]) assert.equal(isAdvertisingConfigured(parseAdvertisingConfig(input)), false);
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

async function buildAdvertisingFixture(configuration: unknown) {
  const directory = await mkdtemp(join(tmpdir(), "passo-advertising-build-"));
  try {
    await writeFile(join(directory, "index.html"), "<!doctype html><html><head><title>Passo</title></head><body>Passo</body></html>");
    const result = await build({
      configFile: false, root: directory, logLevel: "silent",
      plugins: [advertisingOwnershipPlugin(() => configuration)],
      build: { write: false },
    });
    const outputs = (Array.isArray(result) ? result : [result]).flatMap(bundle => "output" in bundle ? bundle.output : []);
    const index = outputs.find(asset => asset.type === "asset" && asset.fileName === "index.html");
    const ads = outputs.find(asset => asset.type === "asset" && asset.fileName === "ads.txt");
    assert(index?.type === "asset");
    return { html: String(index.source), adsTxt: ads?.type === "asset" ? String(ads.source) : undefined };
  } finally { await rm(directory, { recursive: true, force: true }); }
}

function scriptTags(html: string) {
  return html.match(/<script\b[^>]*>/gi) ?? [];
}

function attributes(tag: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const match of tag.matchAll(/([\w:-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g)) {
    values[match[1].toLowerCase()] = (match[2] ?? match[3] ?? match[4] ?? "")
      .replaceAll("&quot;", '"').replaceAll("&#39;", "'").replaceAll("&apos;", "'").replaceAll("&amp;", "&");
  }
  return values;
}

test("a production build keeps verification and ads.txt without loading the SDK when the head option is absent or false", async () => {
  for (const extra of [{}, { loadScriptInHead: false }]) {
    const { html, adsTxt } = await buildAdvertisingFixture({ ...configured, enabled: false, ...extra });
    assert.match(html, /name="google-adsense-account"/);
    assert(html.includes(`content="ca-${publisherId}"`));
    assert.equal(scriptTags(html).length, 0);
    assert.doesNotMatch(html, /googlesyndication|fundingchoices/);
    assert.equal(adsTxt, `google.com, ${publisherId}, DIRECT, f08c47fec0942fa0\n`);
  }
});

test("the requested production head contains exactly one canonical AdSense script with reliable load and error markers", async () => {
  const { html, adsTxt } = await buildAdvertisingFixture({ ...configured, enabled: false, loadScriptInHead: true });
  const head = /<head\b[^>]*>([\s\S]*?)<\/head>/i.exec(html)?.[1];
  assert(head, "the script belongs inside the generated HTML head");
  const headScripts = scriptTags(head);
  assert.equal(headScripts.length, 1);
  assert.equal(scriptTags(html).length, 1, "no duplicate script belongs elsewhere in the page");
  const attrs = attributes(headScripts[0]);
  assert.equal(attrs.id, "passo-google-adsense");
  assert.equal(attrs.src, `https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=ca-${publisherId}`);
  assert(Object.hasOwn(attrs, "async"));
  assert.equal(attrs.crossorigin, "anonymous");
  assert.equal(attrs["data-passo-load-state"], "pending");
  assert(attrs.onload && attrs.onerror);
  const element = { dataset: { passoLoadState: "pending" } };
  // Run only the first-party handlers emitted by this build; no Google code is fetched.
  new Function(attrs.onload).call(element);
  assert.equal(element.dataset.passoLoadState, "loaded");
  new Function(attrs.onerror).call(element);
  assert.equal(element.dataset.passoLoadState, "error");
  assert.match(head, /name="google-adsense-account"/);
  assert.equal(adsTxt, `google.com, ${publisherId}, DIRECT, f08c47fec0942fa0\n`);
});

test("an invalid publisher never produces a Google SDK tag, verification meta or ads.txt even when requested", async () => {
  const { html, adsTxt } = await buildAdvertisingFixture({ ...configured, publisherId: "pub-invalid", loadScriptInHead: true });
  assert.equal(scriptTags(html).length, 0);
  assert.doesNotMatch(html, /google-adsense-account|googlesyndication|fundingchoices/);
  assert.equal(adsTxt, undefined);
});
