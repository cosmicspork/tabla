/**
 * Web Push from the relay.
 *
 * Payloads are **content-free**: at most an opaque game id. RFC 8291 encrypts a
 * push in transit, but APNs and FCM still relay it, and the notification text
 * itself is written by the service worker on the device. The relay could not
 * write a meaningful message even if it wanted to — it cannot read the game.
 */
import { buildPushPayload } from '@block65/webcrypto-web-push';
import type { PushSubscription } from '@block65/webcrypto-web-push';

import type { PushPayload, PushSubscriptionJson } from '@tabla/shared';

import type { Env } from './env.ts';

export interface PushOutcome {
  ok: boolean;
  status?: number;
  /** The endpoint is gone; the subscription should be forgotten. */
  expired?: boolean;
}

export function pushConfigured(env: Env): boolean {
  return Boolean(env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY && env.VAPID_SUBJECT);
}

/**
 * Sends one content-free notification.
 *
 * Never throws: a push that fails is a missed convenience, not a lost move, and
 * must not take down the append that triggered it.
 */
export async function sendPush(
  env: Env,
  subscription: PushSubscriptionJson,
  payload: PushPayload,
): Promise<PushOutcome> {
  if (!pushConfigured(env)) return { ok: false };

  try {
    const target: PushSubscription = {
      endpoint: subscription.endpoint,
      expirationTime: null,
      keys: subscription.keys,
    };

    const request = await buildPushPayload(
      {
        data: payload,
        // The topic collapses repeats: a second nudge about the same game or
        // the same mailbox replaces the first rather than stacking.
        options: {
          ttl: 60 * 60 * 24,
          urgency: 'normal',
          topic: 'gameId' in payload ? payload.gameId : payload.mailbox,
        },
      },
      target,
      {
        subject: env.VAPID_SUBJECT,
        publicKey: env.VAPID_PUBLIC_KEY,
        privateKey: env.VAPID_PRIVATE_KEY,
      },
    );

    const response = await fetch(subscription.endpoint, request as RequestInit);

    return {
      ok: response.ok,
      status: response.status,
      // 404 and 410 mean the push service has dropped this endpoint for good.
      expired: response.status === 404 || response.status === 410,
    };
  } catch (error) {
    console.error('push failed', error);
    return { ok: false };
  }
}
