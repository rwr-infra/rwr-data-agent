import { defineConfig, loadEnv } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import tailwindcss from '@tailwindcss/vite';

// Follow the backend's PORT from the repo-root .env so the two never drift.
const rootEnv = loadEnv('development', '..', '');
const proxyUrl = `http://localhost:${rootEnv.PORT || 3000}`;

// CI passes the release tag as APP_VERSION (see .github/workflows/docker-publish.yml).
// Local builds fall back to .env or 'dev', so the badge never shows a stale number.
const rawVersion = process.env.APP_VERSION || rootEnv.APP_VERSION || 'dev';
const appVersion = /^\d/.test(rawVersion) ? `v${rawVersion}` : rawVersion;

export default defineConfig({
  plugins: [tailwindcss(), svelte()],
  root: '.',
  define: {
    __APP_VERSION__: JSON.stringify(appVersion),
  },
  build: {
    outDir: '../public',
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    proxy: {
      '/v1': proxyUrl,
      '/health': proxyUrl,
    },
  },
});
