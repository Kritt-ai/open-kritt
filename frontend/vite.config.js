import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Version injected as the compile-time constant __APP_VERSION__ so the UI never
// hardcodes a version. The root VERSION file is the source of truth, but it isn't
// present inside the frontend-only Docker image — so we read frontend/package.json
// (which scripts/sync-version.mjs keeps in lockstep with VERSION and which is always
// co-located with the frontend). An explicit APP_VERSION env wins if provided.
const here = dirname(fileURLToPath(import.meta.url));
function resolveAppVersion() {
  if (process.env.APP_VERSION) return process.env.APP_VERSION.trim();
  try {
    return JSON.parse(readFileSync(join(here, 'package.json'), 'utf8')).version;
  } catch {
    return '0.0.0-dev';
  }
}
const appVersion = resolveAppVersion();

// Dev server proxies /api to the backend so the frontend can use same-origin calls.
// VITE_PROXY_TARGET is the *server-side* backend address (e.g. http://backend:3002
// inside Docker, http://localhost:3002 locally). The browser keeps using relative
// /api unless VITE_API_BASE_URL is set explicitly.
export default defineConfig({
  plugins: [react()],
  define: {
    __APP_VERSION__: JSON.stringify(appVersion),
  },
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: process.env.VITE_PROXY_TARGET || 'http://localhost:3002',
        changeOrigin: true,
      },
    },
  },
});
