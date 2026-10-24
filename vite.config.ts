import { defineConfig, type HtmlTagDescriptor, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { ADSENSE_SCRIPT_ID, adSenseScriptUrl, advertisingOwnership, isPublisherArticlePath, parseAdvertisingConfig } from "./shared/advertising.ts";

export { isPublisherArticlePath } from "./shared/advertising.ts";

function readAdvertisingConfiguration(): unknown {
  try {
    return JSON.parse(readFileSync(new URL("./public/ads-config.json", import.meta.url), "utf8"));
  } catch { return {}; }
}

export function publisherIntroductionPlugin(): Plugin {
  return {
    name: "passo-publisher-introduction",
    transformIndexHtml: {
      order: "pre",
      handler(html) {
        if (!html.includes("<!--passo-publisher-introduction-->")) return html;
        const introduction = readFileSync(new URL("./src/publisher-introduction.html", import.meta.url), "utf8");
        return html.replace("<!--passo-publisher-introduction-->", introduction);
      },
    },
  };
}

export function advertisingOwnershipPlugin(readConfiguration = readAdvertisingConfiguration): Plugin {
  return {
    name: "passo-advertising-ownership",
    transformIndexHtml(_html, context) {
      const input = readConfiguration();
      const ownership = advertisingOwnership(input);
      if (!ownership) return [];
      const tags: HtmlTagDescriptor[] = [{ tag: "meta", attrs: { name: "google-adsense-account", content: ownership.clientId }, injectTo: "head" }];
      if (parseAdvertisingConfig(input).loadScriptInHead && isPublisherArticlePath(context.path)) {
        tags.push({
          tag: "script",
          attrs: {
            id: ADSENSE_SCRIPT_ID,
            async: true,
            src: adSenseScriptUrl(ownership.clientId),
            crossorigin: "anonymous",
            "data-passo-load-state": "pending",
            onload: "this.dataset.passoLoadState='loaded'",
            onerror: "this.dataset.passoLoadState='error'",
          },
          injectTo: "head",
        });
      }
      return tags;
    },
    generateBundle() {
      const ownership = advertisingOwnership(readConfiguration());
      if (ownership) this.emitFile({ type: "asset", fileName: "ads.txt", source: ownership.adsTxt });
    },
  };
}

export default defineConfig({
  plugins: [react(), publisherIntroductionPlugin(), advertisingOwnershipPlugin()],
  build: {
    rolldownOptions: {
      input: Object.fromEntries([
        "index.html",
        "guide/index.html",
        "guide/segnalare-un-pericolo/index.html",
        "guide/leggere-la-mappa/index.html",
        "guide/fondo-stradale/index.html",
        "progetto/index.html",
        "privacy/index.html",
        "404.html",
      ].map((path) => [path, fileURLToPath(new URL(path, import.meta.url))])),
    },
  },
  server: {
    host: "0.0.0.0",
    port: 5173,
    strictPort: true,
    proxy: { "/api": { target: "http://127.0.0.1:3001" } },
  },
});
