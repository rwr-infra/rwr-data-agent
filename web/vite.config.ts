import { defineConfig, loadEnv } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import tailwindcss from '@tailwindcss/vite';

// Follow the backend's PORT from the repo-root .env so the two never drift.
const rootEnv = loadEnv('development', '..', '');
const proxyUrl = `http://localhost:${rootEnv.PORT || 3000}`;

export default defineConfig({
  plugins: [tailwindcss(), svelte()],
  root: '.',
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
