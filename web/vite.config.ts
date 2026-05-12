import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import tailwindcss from '@tailwindcss/vite';

const proxyUrl = "http://localhost:3000";

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
