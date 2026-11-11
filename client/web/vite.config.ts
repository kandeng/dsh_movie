import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
import { i18nPlugin } from "@dsh-movie/i18n/vite";

// matrix-js-sdk references the Node `global` binding in a few code paths; alias
// it to `globalThis` so the browser bundle resolves it without a polyfill.
export default defineConfig({
  define: {
    global: "globalThis",
  },
  server: {
    host: "127.0.0.1",
    port: 5173,
    strictPort: true,
    proxy: {
      // Same-origin access to the local Synapse homeserver. The SDK talks to
      // Synapse directly (absolute URL); this proxy also lets relative
      // /_matrix fetches (e.g. authenticated media) work in dev. In production
      // a reverse proxy (Caddy) plays the same role.
      "/_matrix": { target: "http://127.0.0.1:8008", changeOrigin: true },
    },
  },
  resolve: {
    alias: [
      { find: "@", replacement: fileURLToPath(new URL("./src", import.meta.url)) },
    ],
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
  plugins: [
    // Auto-extracts/translates CJK string literals under client/web/src into
    // `translate()` calls (vendored from vidsay). English literals are left
    // untouched, so the Phase-2 skeleton is unaffected until the Chat port.
    i18nPlugin(),
    vue(),
  ],
});
