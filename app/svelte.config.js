import adapter from '@sveltejs/adapter-static';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

/**
 * tabla is a local-first, end-to-end encrypted app: there is nothing for a
 * server to render, and the invite key lives in a URL fragment that must never
 * reach one. So the app builds as a pure SPA and is served as static assets by
 * the relay Worker, which owns only /api/* and /ws/*.
 *
 * @type {import('@sveltejs/kit').Config}
 */
export default {
  preprocess: vitePreprocess(),
  kit: {
    adapter: adapter({ fallback: 'index.html', strict: false }),
    serviceWorker: { register: false },
    alias: { $shared: '../shared/src' },
  },
};
