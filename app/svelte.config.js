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
    // Registered automatically. It caches the app shell only; game data lives
    // in IndexedDB and is never written to a cache.
    //
    // Dictionaries are excluded from the install-time precache: they are half a
    // megabyte each and only matter to people who play the word game, so making
    // every visitor download one before the app will start would be a poor
    // trade. They are fetched on first use and kept by the runtime cache from
    // then on, so a game stays playable offline after one online session.
    serviceWorker: {
      register: true,
      files: (path) => !path.startsWith('dict/'),
    },
    alias: { $shared: '../shared/src' },
  },
};
