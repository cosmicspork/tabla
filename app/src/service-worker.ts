/// <reference types="@sveltejs/kit" />
/// <reference lib="webworker" />

/**
 * The service worker: offline shell, and the receiver for content-free pushes.
 *
 * It caches the app itself, never game data. Games live in IndexedDB, which the
 * page reads directly — there is nothing here that would benefit from being in
 * a cache, and a cached response containing game state is exactly the sort of
 * accidental plaintext this project exists to avoid.
 */
import { build, files, version } from '$service-worker';

const worker = self as unknown as ServiceWorkerGlobalScope;

/** A new cache per build, so an upgrade never serves a half-old shell. */
const CACHE = `tabla-shell-${version}`;
const SHELL = [...build, ...files];

worker.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(SHELL))
      .then(() => worker.skipWaiting()),
  );
});

worker.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      for (const key of await caches.keys()) {
        if (key !== CACHE) await caches.delete(key);
      }
      await worker.clients.claim();
    })(),
  );
});

worker.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  // The relay is never cached: its answers are about right now.
  if (url.origin !== location.origin) return;
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/ws/')) return;

  event.respondWith(serve(request, url));
});

/**
 * Downloaded games and their word lists, which the page keeps itself.
 *
 * Caching them here too would store more than a megabyte twice, lose it on
 * every app update — this cache is dropped whenever a new version activates —
 * and leave a copy behind after a player removed the game to get the space
 * back. The page stores them in IndexedDB instead, where none of that is true.
 */
function ownedByThePage(pathname: string): boolean {
  return pathname.startsWith('/dict/') || pathname.startsWith('/plugins/');
}

async function serve(request: Request, url: URL): Promise<Response> {
  const cache = await caches.open(CACHE);

  // Build artifacts are content-hashed, so a hit is always correct.
  if (build.includes(url.pathname)) {
    const hit = await cache.match(url.pathname);
    if (hit) return hit;
  }

  try {
    const response = await fetch(request);
    if (response.ok && response.type === 'basic' && !ownedByThePage(url.pathname)) {
      cache.put(request, response.clone()).catch(() => {});
    }
    return response;
  } catch {
    const hit = (await cache.match(request)) ?? (await cache.match('/'));
    if (hit) return hit;
    throw new Error('offline and not cached');
  }
}

// -- push -------------------------------------------------------------------

/**
 * Content-free notifications.
 *
 * The payload carries at most an opaque game id. The wording below is fixed and
 * written here, not sent by the relay: RFC 8291 encrypts a push in transit, but
 * APNs and FCM still relay it, and a notification that said what your opponent
 * just played would leak exactly what this design protects.
 */
worker.addEventListener('push', (event) => {
  let gameId: string | undefined;
  try {
    gameId = event.data?.json()?.gameId;
  } catch {
    gameId = undefined;
  }

  event.waitUntil(
    worker.registration.showNotification('Your turn', {
      body: 'Your opponent has played.',
      icon: '/icons/icon-192.png',
      badge: '/icons/icon-192.png',
      tag: gameId ? `game-${gameId}` : 'tabla',
      renotify: Boolean(gameId),
      data: { gameId },
    } as NotificationOptions),
  );
});

worker.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const gameId = (event.notification.data as { gameId?: string } | undefined)?.gameId;
  const target = gameId ? `/g/${encodeURIComponent(gameId)}` : '/';

  event.waitUntil(
    (async () => {
      const clients = await worker.clients.matchAll({
        type: 'window',
        includeUncontrolled: true,
      });

      for (const client of clients) {
        if ('focus' in client) {
          await client.focus();
          // Tell the page to sync now, rather than reloading it out from under
          // whatever the person was doing.
          client.postMessage({ type: 'tabla:open-game', gameId });
          return;
        }
      }

      await worker.clients.openWindow(target);
    })(),
  );
});
