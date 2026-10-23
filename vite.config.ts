import { defineConfig, type HtmlTagDescriptor, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { readFileSync } from "node:fs";
import { ADSENSE_SCRIPT_ID, adSenseScriptUrl, advertisingOwnership, parseAdvertisingConfig } from "./shared/advertising.ts";

function readAdvertisingConfiguration(): unknown {
  try {
    return JSON.parse(readFileSync(new URL("./public/ads-config.json", import.meta.url), "utf8"));
  } catch { return {}; }
}

export function advertisingOwnershipPlugin(readConfiguration = readAdvertisingConfiguration): Plugin {
  return {
    name: "passo-advertising-ownership",
    transformIndexHtml() {
      const input = readConfiguration();
      const ownership = advertisingOwnership(input);
      if (!ownership) return [];
      const tags: HtmlTagDescriptor[] = [{ tag: "meta", attrs: { name: "google-adsense-account", content: ownership.clientId }, injectTo: "head" }];
      if (parseAdvertisingConfig(input).loadScriptInHead) {
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
  plugins: [react(), advertisingOwnershipPlugin()],
  server: {
    host: "0.0.0.0",
    port: 5173,
    strictPort: true,
    proxy: { "/api": { target: "http://127.0.0.1:3001" } },
  },
});
