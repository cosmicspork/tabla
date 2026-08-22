/**
 * Subscribing this device to content-free notifications.
 *
 * iOS shapes this whole flow: push works only when the app has been installed
 * to the home screen, and the permission prompt must come from a real user
 * gesture. Rather than working around that, the UI is built for it — the app
 * detects standalone mode, walks Safari users through installing, and only ever
 * asks for permission from a button the person pressed.
 */
import { fromBase64Url, toBase64Url } from '@tabla/shared';
import type { PushSubscriptionJson } from '@tabla/shared';

import { getMeta, listGames, setMeta } from './db/store.ts';
import { loadIdentity } from './identity.ts';
import { isIos, isStandalone } from './lifecycle.ts';
import { registerGamePush } from './relay.ts';

/**
 * Whether this device asked for notifications.
 *
 * Distinct from whether it *can* have them: a person who has never been asked
 * and one who turned them off look identical to the browser, and the settings
 * page needs to tell those apart.
 */
const PUSH_PREFERENCE = 'pushEnabled';
/** The endpoint of a subscription this device gave up, until a room is told. */
const RETIRED_ENDPOINT = 'retiredPushEndpoint';

export type PushAvailability =
  /** Ready to ask. */
  | 'available'
  /** Already subscribed. */
  | 'enabled'
  /** iOS, but not installed to the home screen yet. */
  | 'needs-install'
  /** The person said no. Only they can undo that, in browser settings. */
  | 'denied'
  /**
   * The relay has no VAPID keys, so it can notify nobody, on any device.
   *
   * Told apart from `unsupported` because they are not the same situation and
   * do not have the same answer: one is this browser's limit and nothing can be
   * done about it, the other is a secret nobody set and is fixed in a minute.
   * Folding them together is how a relay stays unable to send anything for a
   * month while everyone reads "this browser cannot" and believes it.
   */
  | 'relay-unconfigured'
  /** This browser has no push support. */
  | 'unsupported';

export function pushSupported(): boolean {
  return (
    typeof window !== 'undefined' &&
    'serviceWorker' in navigator &&
    'PushManager' in window &&
    'Notification' in window
  );
}

export async function pushAvailability(): Promise<PushAvailability> {
  if (!pushSupported()) return 'unsupported';

  // Before anything about this device, because it is not about this device: a
  // relay with no keys sends nothing to anyone, and saying "add the app to your
  // Home Screen first" to someone in that position wastes their afternoon.
  if (!(await vapidPublicKey())) return 'relay-unconfigured';

  // On iOS a PWA in a tab cannot receive push at all, so asking would only
  // produce a prompt that cannot work.
  if (isIos() && !isStandalone()) return 'needs-install';

  if (Notification.permission === 'denied') return 'denied';

  const registration = await navigator.serviceWorker.ready;
  const existing = await registration.pushManager.getSubscription();
  if (existing) return 'enabled';

  return 'available';
}

let cachedKey: string | null | undefined;

async function vapidPublicKey(): Promise<string | null> {
  if (cachedKey !== undefined) return cachedKey;

  try {
    const response = await fetch('/api/vapid');
    const { publicKey } = (await response.json()) as {
      publicKey: string | null;
    };
    cachedKey = publicKey;
  } catch {
    cachedKey = null;
  }
  return cachedKey;
}

/**
 * Requests permission and subscribes.
 *
 * **Must be called from a user gesture** — iOS requires it, and every other
 * browser prefers it. Returns the subscription for the caller to register with
 * the game's room, or `null` if the person declined.
 */
export async function enablePush(): Promise<PushSubscriptionJson | null> {
  if (!pushSupported()) return null;

  const publicKey = await vapidPublicKey();
  if (!publicKey) return null;

  const permission = await Notification.requestPermission();
  if (permission !== 'granted') return null;

  await setMeta(PUSH_PREFERENCE, true);

  const registration = await navigator.serviceWorker.ready;
  const subscription =
    (await registration.pushManager.getSubscription()) ??
    (await registration.pushManager.subscribe({
      userVisibleOnly: true,
      // Copied so the buffer is definitely an ArrayBuffer, which is what the
      // PushManager signature requires.
      applicationServerKey: new Uint8Array(fromBase64Url(publicKey)),
    }));

  return subscription.toJSON() as PushSubscriptionJson;
}

/**
 * Turns notifications off for this device.
 *
 * Every room this device plays in is told directly, because each holds a row
 * per endpoint and a row nobody retires is a push going to a device whose owner
 * said no, on behalf of a person who did not. A room that cannot be reached
 * keeps its row; the endpoint is remembered so the next board opened can say
 * so, and failing even that the row lapses when the push service answers 410.
 *
 * The browser permission is deliberately left alone. Only the person can grant
 * or revoke that, and taking it away here would mean asking for it again later.
 */
export async function disablePush(): Promise<void> {
  await setMeta(PUSH_PREFERENCE, false);

  const registration = await navigator.serviceWorker.getRegistration();
  const subscription = await registration?.pushManager.getSubscription();

  if (subscription) {
    await setMeta(RETIRED_ENDPOINT, subscription.endpoint);
    await retireGamesFromPush(subscription.endpoint);
  }

  await subscription?.unsubscribe();
}

/** The endpoint this device last turned off, if it has not been told yet. */
export async function retiredEndpoint(): Promise<string | undefined> {
  return getMeta<string>(RETIRED_ENDPOINT);
}

export async function clearRetiredEndpoint(): Promise<void> {
  await setMeta(RETIRED_ENDPOINT, undefined);
}

/** Whether this device has asked for notifications, as opposed to being able to. */
export async function pushPreference(): Promise<boolean> {
  return (await getMeta<boolean>(PUSH_PREFERENCE)) ?? false;
}

/** The current subscription, if this device already has one. */
export async function currentSubscription(): Promise<PushSubscriptionJson | null> {
  if (!pushSupported()) return null;

  const registration = await navigator.serviceWorker.ready;
  const subscription = await registration.pushManager.getSubscription();
  return subscription ? (subscription.toJSON() as PushSubscriptionJson) : null;
}

// -- telling the rooms ------------------------------------------------------

/**
 * Games whose room could still have something to say. A finished game has
 * nothing left to notify about, and an unclaimed invite has no opponent yet.
 */
async function notifiableGames(): Promise<string[]> {
  const games = await listGames();
  return games.filter((game) => game.status === 'active').map((game) => game.gameId);
}

/**
 * Says the same thing to every room this device plays in.
 *
 * Best effort throughout: one unreachable room must not cost the others their
 * notifications, and every board re-registers on open regardless.
 */
async function tellRooms(
  subscription: PushSubscriptionJson | null,
  endpoint?: string,
): Promise<void> {
  const [gameIds, { identity }] = await Promise.all([notifiableGames(), loadIdentity()]);
  const keyHash = toBase64Url(identity.keyHash());

  await Promise.all(
    gameIds.map((gameId) =>
      registerGamePush(gameId, keyHash, subscription, endpoint).catch(() => {}),
    ),
  );
}

/**
 * Tells every game this device is in that it wants notifications.
 *
 * Notifications are one decision about all of them, made in settings — but a
 * room only ever heard about a subscription down its own socket, so turning
 * them on left every game already in progress silent until its board happened
 * to be opened again. Which is exactly the shape of "I turned notifications on
 * and never got told it was my turn".
 */
export async function registerGamesForPush(subscription: PushSubscriptionJson): Promise<void> {
  await tellRooms(subscription);
}

/**
 * Tells every game this device is in to stop, for a subscription just given up.
 *
 * The rows would lapse on their own once the endpoint starts returning 410, but
 * "lapse" means pushes to a device whose owner said no, on behalf of a person
 * who did not, for as long as the push service takes to notice.
 */
export async function retireGamesFromPush(endpoint: string): Promise<void> {
  await tellRooms(null, endpoint);
}

/**
 * Takes down the nudge about a game, now that its board is open.
 *
 * The relay decides per device whether to send one, and it errs towards sending
 * — a socket that has gone quiet may be a frozen phone, and the wrong guess
 * there is silence about a turn. So the correction belongs on this side: when
 * the board is actually in front of someone, the notification about it has
 * nothing left to say.
 */
export async function clearGameNotifications(gameId: string): Promise<void> {
  if (!pushSupported()) return;

  try {
    const registration = await navigator.serviceWorker.getRegistration();
    const shown = await registration?.getNotifications({ tag: `game-${gameId}` });
    for (const notification of shown ?? []) notification.close();
  } catch {
    // Not every engine implements `getNotifications`; nothing here is load-bearing.
  }
}
