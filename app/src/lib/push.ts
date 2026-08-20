/**
 * Subscribing this device to content-free notifications.
 *
 * iOS shapes this whole flow: push works only when the app has been installed
 * to the home screen, and the permission prompt must come from a real user
 * gesture. Rather than working around that, the UI is built for it — the app
 * detects standalone mode, walks Safari users through installing, and only ever
 * asks for permission from a button the person pressed.
 */
import { fromBase64Url } from '@tabla/shared';
import type { PushSubscriptionJson } from '@tabla/shared';

import { getMeta, setMeta } from './db/store.ts';
import { isIos, isStandalone } from './lifecycle.ts';

/**
 * Whether this device asked for notifications.
 *
 * Distinct from whether it *can* have them: a person who has never been asked
 * and one who turned them off look identical to the browser, and the settings
 * page needs to tell those apart.
 */
const PUSH_PREFERENCE = 'pushEnabled';

export type PushAvailability =
  /** Ready to ask. */
  | 'available'
  /** Already subscribed. */
  | 'enabled'
  /** iOS, but not installed to the home screen yet. */
  | 'needs-install'
  /** The person said no. Only they can undo that, in browser settings. */
  | 'denied'
  /** No push support, or the relay has no VAPID key configured. */
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

  // On iOS a PWA in a tab cannot receive push at all, so asking would only
  // produce a prompt that cannot work.
  if (isIos() && !isStandalone()) return 'needs-install';

  if (Notification.permission === 'denied') return 'denied';

  const registration = await navigator.serviceWorker.ready;
  const existing = await registration.pushManager.getSubscription();
  if (existing) return 'enabled';

  return (await vapidPublicKey()) ? 'available' : 'unsupported';
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
 * Unsubscribing is the whole of it: the relay keeps a subscription per game
 * room, and there is no message on the wire for withdrawing one — but a push to
 * an unsubscribed endpoint comes back 404 or 410, and the room drops the row
 * when it does. So the rows lapse rather than being deleted, and nothing is
 * ever delivered in the meantime.
 *
 * The browser permission is deliberately left alone. Only the person can grant
 * or revoke that, and taking it away here would mean asking for it again later.
 */
export async function disablePush(): Promise<void> {
  await setMeta(PUSH_PREFERENCE, false);

  const registration = await navigator.serviceWorker.getRegistration();
  const subscription = await registration?.pushManager.getSubscription();
  await subscription?.unsubscribe();
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
