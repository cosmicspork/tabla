/**
 * When to sync.
 *
 * iOS gives a web app no Background Sync and no reliable background execution,
 * so tabla never relies on either. Instead it syncs at the moments it is
 * actually running: when the app is opened or brought forward, when the network
 * comes back, and when a push wakes it. That is enough for correspondence play,
 * and it behaves identically on every platform rather than well on one.
 */

export type ResyncReason = 'visible' | 'online' | 'push' | 'focus';

type Handler = (reason: ResyncReason, gameId?: string) => void;

/**
 * Calls `handler` whenever the app should catch up with the relay.
 *
 * Returns a teardown function.
 */
export function onShouldResync(handler: Handler): () => void {
  const onVisible = () => {
    if (document.visibilityState === 'visible') handler('visible');
  };
  const onOnline = () => handler('online');
  const onFocus = () => handler('focus');

  const onMessage = (event: MessageEvent) => {
    if (event.data?.type === 'tabla:open-game') handler('push', event.data.gameId);
  };

  document.addEventListener('visibilitychange', onVisible);
  window.addEventListener('online', onOnline);
  window.addEventListener('focus', onFocus);
  navigator.serviceWorker?.addEventListener('message', onMessage);

  return () => {
    document.removeEventListener('visibilitychange', onVisible);
    window.removeEventListener('online', onOnline);
    window.removeEventListener('focus', onFocus);
    navigator.serviceWorker?.removeEventListener('message', onMessage);
  };
}

/** Whether the app is running as an installed PWA rather than in a tab. */
export function isStandalone(): boolean {
  if (typeof window === 'undefined') return false;

  // A dev-only escape hatch for exercising the installed-only paths on desktop.
  if (new URLSearchParams(location.search).get('simulate') === 'ios-standalone') return true;

  return (
    window.matchMedia('(display-mode: standalone)').matches ||
    (navigator as { standalone?: boolean }).standalone === true
  );
}

export function isIos(): boolean {
  if (typeof navigator === 'undefined') return false;
  if (new URLSearchParams(location.search).get('simulate') === 'ios-standalone') return true;

  return (
    /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    // iPadOS reports itself as a Mac, distinguishable only by touch support.
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
  );
}

/**
 * Asks the browser to keep our storage.
 *
 * Without this, IndexedDB is evictable under storage pressure, and evicting it
 * would destroy game logs and the identity key. Called at the first moment the
 * request is justified — when a real game exists — because browsers weigh
 * engagement when deciding.
 */
export async function requestPersistentStorage(): Promise<boolean> {
  if (!navigator.storage?.persist) return false;
  if (await navigator.storage.persisted()) return true;

  try {
    return await navigator.storage.persist();
  } catch {
    return false;
  }
}
