import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';

const RELAY = 'http://127.0.0.1:8787';

export default defineConfig({
  plugins: [sveltekit()],

  // The plugin host and the WASM module are loaded as ES module workers, which
  // is what lets `wasm-pack --target web` output work unchanged in a worker.
  worker: { format: 'es' },

  server: {
    proxy: {
      '/api': { target: RELAY, changeOrigin: true },
      '/ws': { target: RELAY, ws: true, changeOrigin: true },
    },
  },

  test: {
    include: ['src/**/*.{test,spec}.ts'],
    environment: 'node',
  },
});
