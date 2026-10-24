import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { build } from "vite";

test("the published site has readable linked publisher content without JavaScript or ads on utility pages", { timeout: 30_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "passo-publisher-build-"));
  const pageFiles = [
    "index.html", "guide/index.html", "guide/segnalare-un-pericolo/index.html",
    "guide/leggere-la-mappa/index.html", "guide/fondo-stradale/index.html",
    "progetto/index.html", "privacy/index.html", "404.html",
  ];
  try {
    await build({
      configFile: resolve("vite.config.ts"), logLevel: "silent",
      build: { outDir: directory, emptyOutDir: true },
    });
    const pages = new Map(await Promise.all(pageFiles.map(async (path) => [path, await readFile(join(directory, path), "utf8")] as const)));
    const home = pages.get("index.html")!;
    assert(!home.includes("<!--passo-publisher-introduction-->"));
    assert.match(home, /Come segnalare un pericolo in modo utile/);
    assert.match(home, /Conferme, scadenze e attendibilità della mappa/);
    assert.match(home, /Ghiaia, fango e fondo dissestato/);
    assert.match(home, /<noscript>/);
    const introduction = (await readFile(resolve("src/publisher-introduction.html"), "utf8")).trim();
    assert(home.includes(introduction), "the initial document must contain the same introduction that the interactive app displays");

    const titles = new Set<string>();
    for (const [path, html] of pages) {
      assert.match(html, /<html lang="it">/, path);
      assert.equal((html.match(/<h1\b/g) ?? []).length, 1, path);
      assert.match(html, /<main\b/, path);
      assert.match(html, /name="description"/, path);
      assert.match(html, /name="google-adsense-account" content="ca-pub-1655314992046081"/, path);
      assert.doesNotMatch(html, /googlesyndication|fundingchoices|class="adsbygoogle|advertising-placeholder/, path);
      const title = /<title>(.*?)<\/title>/.exec(html)?.[1];
      assert(title && !titles.has(title), `page title must be present and unique: ${path}`);
      titles.add(title);
      if (path !== "index.html") assert.doesNotMatch(html, /<script\b/, `this page must remain fully readable without JavaScript: ${path}`);

      for (const match of html.matchAll(/href="(\/[^"#?]*)"/g)) {
        const target = match[1];
        if (target.endsWith(".css") || target.startsWith("/assets/")) continue;
        const file = target === "/" ? "index.html" : target.endsWith("/") ? `${target.slice(1)}index.html` : target.slice(1);
        assert(await readFile(join(directory, file)), `broken internal link ${target} in ${path}`);
      }
    }
    assert.match(pages.get("404.html")!, /name="robots" content="noindex"/);
    assert.equal((await readFile(join(directory, "ads.txt"), "utf8")).trim(), "google.com, pub-1655314992046081, DIRECT, f08c47fec0942fa0");
    const sitemap = await readFile(join(directory, "sitemap.xml"), "utf8");
    for (const file of pageFiles.filter(path => path !== "404.html")) {
      const path = file === "index.html" ? "/" : `/${file.replace(/index\.html$/, "")}`;
      assert(sitemap.includes(`<loc>https://appmoto.pages.dev${path}</loc>`), `sitemap must list ${path}`);
    }
    assert.match(await readFile(join(directory, "robots.txt"), "utf8"), /Disallow: \/api\//);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
