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
    // Downloadable games and their word lists are excluded from the
    // install-time precache. They are hundreds of kilobytes each and matter
    // only to the people who play those games, so making every visitor take
    // one before the app will start would be a poor trade. They are fetched on
    // first use, checked against the signed manifest, and kept in the database
    // — which, unlike a cache, survives an app update and can be given back
    // when a player removes the game.
    serviceWorker: {
      register: true,
      files: (path) => !path.startsWith('dict/') && !path.startsWith('plugins/'),
    },
    alias: { $shared: '../shared/src' },
  },
};
