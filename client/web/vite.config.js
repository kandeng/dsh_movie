import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

// matrix-js-sdk references the Node `global` binding in a few code paths; alias
// it to `globalThis` so the browser bundle resolves it without a polyfill.
export default defineConfig({
  plugins: [vue()],
  define: {
    global: 'globalThis',
  },
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
  },
})
