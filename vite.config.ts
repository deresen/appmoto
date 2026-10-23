import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { readFileSync } from "node:fs";
import { advertisingOwnership } from "./shared/advertising.ts";

function readAdvertisingConfiguration(): unknown {
  try {
    return JSON.parse(readFileSync(new URL("./public/ads-config.json", import.meta.url), "utf8"));
  } catch { return {}; }
}

export function advertisingOwnershipPlugin(readConfiguration = readAdvertisingConfiguration): Plugin {
  return {
    name: "passo-advertising-ownership",
    transformIndexHtml() {
      const ownership = advertisingOwnership(readConfiguration());
      return ownership ? [{ tag: "meta", attrs: { name: "google-adsense-account", content: ownership.clientId }, injectTo: "head" as const }] : [];
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
