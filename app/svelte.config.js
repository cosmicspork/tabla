import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import adapter from '@sveltejs/adapter-static';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

/**
 * The released version, read from the manifest release-please maintains.
 *
 * Taken from the repository root rather than this package's own `version` so
 * there is one answer to what version the app is, and it is the one the tags
 * and the changelog agree on.
 */
const { '.': APP_VERSION } = JSON.parse(
  readFileSync(fileURLToPath(new URL('../.release-please-manifest.json', import.meta.url)), 'utf8'),
);

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
    // Names the build after the release rather than a timestamp, which is what
    // the About page shows and what SvelteKit compares to notice an update.
    version: { name: APP_VERSION },
    // Registered automatically. It caches the app shell only; game data lives
    // in IndexedDB and is never written to a cache.
    //
    // Downloadable games, their word lists, and the QR decoder are excluded
    // from the install-time precache. They are hundreds of kilobytes each and matter
    // only to the people who play those games, so making every visitor take
    // one before the app will start would be a poor trade. They are fetched on
    // first use, checked against the signed manifest, and kept in the database
    // — which, unlike a cache, survives an app update and can be given back
    // when a player removes the game.
    //
    // `qr/` is the same trade for the same reason. Only an engine without
    // `BarcodeDetector` needs a decoder at all — Safari, in practice — and only
    // once somebody taps Scan. Precaching it would hand it to every device on
    // install, including all the ones that will never run a line of it.
    serviceWorker: {
      register: true,
      files: (path) =>
        !path.startsWith('dict/') && !path.startsWith('plugins/') && !path.startsWith('qr/'),
    },
    alias: { $shared: '../shared/src' },
  },
};
