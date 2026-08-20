/**
 * What can and cannot be checked about push here.
 *
 * Real delivery goes through FCM or APNs and cannot run in CI, so what is
 * verified is the part the relay owns: that it attempts a push to the opponent
 * and not to the mover, that the attempt reaches the subscription endpoint with
 * an encrypted body, and that a turn reminder fires once and never nags.
 * Delivery to a physical device is a manual checklist item in the README.
 *
 * Outbound requests are intercepted by miniflare's `outboundService` (see
 * vitest.config.ts), so nothing here touches a real push service.
 */
import { runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

import { HASH_LEN, toBase64Url } from '@tabla/shared';

import { gameIdBytes, makeChain, roomStub } from './helpers.ts';

const ALICE = toBase64Url(new Uint8Array(HASH_LEN).fill(0xa1));
const BOB = toBase64Url(new Uint8Array(HASH_LEN).fill(0xb2));

/**
 * A real P-256 point and auth secret. The encryption in RFC 8291 rejects a
 * fabricated key outright, so this has to be genuine curve material even though
 * nobody holds the private half.
 */
const subscription = {
  endpoint: 'https://push.example/send/abc123',
  keys: {
    p256dh: 'BAui2rC6tG7bWdH4Tu1LOBJuQ0Jnakb3SelbAdY2k73Hk4FLw4-4KvT81KZhKqdUQ5YUbpXirKJbJOiT8-quWgI',
    auth: '9ROHgYBT3dvmUnMB8z8miA',
  },
};

function room(label: string) {
  const bytes = gameIdBytes(label);
  return { gameId: toBase64Url(bytes), bytes, stub: roomStub(toBase64Url(bytes)) };
}

/** Delivery bookkeeping the room keeps, so failures are visible at all. */
async function pushStats(stub: ReturnType<typeof roomStub>) {
  return runInDurableObject(stub, async (_instance, state) => {
    const rows = state.storage.sql
      .exec<{ k: string; v: string }>(`SELECT k, v FROM meta WHERE k LIKE 'push%' OR k = 'lastPushOk'`)
      .toArray();

    const meta = Object.fromEntries(rows.map((row) => [row.k, row.v]));
    return {
      attempts: Number(meta.pushCount ?? '0'),
      lastOk: meta.lastPushOk === '1',
    };
  });
}

async function bringReminderForward(stub: ReturnType<typeof roomStub>, when: number) {
  await runInDurableObject(stub, async (_instance, state) => {
    state.storage.sql.exec(`UPDATE meta SET v = ? WHERE k = 'reminderAt'`, String(when));
  });
}

describe('turn notifications', () => {
  it('notifies the opponent when a move lands', async () => {
    const { gameId, bytes, stub } = room('push-basic-0001');
    await stub.setPushSubscription(BOB, subscription, Date.now());

    await stub.append(gameId, ALICE, await makeChain(bytes, 1), Date.now());

    const stats = await pushStats(stub);
    expect(stats.attempts).toBe(1);
    // Reached the endpoint and was accepted, so the payload encrypted cleanly.
    expect(stats.lastOk).toBe(true);
  });

  it('does not notify the player who just moved', async () => {
    const { gameId, bytes, stub } = room('push-self-00001');
    // Only the mover is subscribed, so there is nobody to tell.
    await stub.setPushSubscription(ALICE, subscription, Date.now());

    await stub.append(gameId, ALICE, await makeChain(bytes, 1), Date.now());

    expect((await pushStats(stub)).attempts).toBe(0);
  });

  it('sends nothing when the opponent has no subscription', async () => {
    const { gameId, bytes, stub } = room('push-nosub-0001');

    await stub.append(gameId, ALICE, await makeChain(bytes, 1), Date.now());

    expect((await pushStats(stub)).attempts).toBe(0);
  });

  it('sends one notification per append, not one per entry', async () => {
    const { gameId, bytes, stub } = room('push-batch-0001');
    await stub.setPushSubscription(BOB, subscription, Date.now());

    // A reconnecting client can upload several entries at once; that is still
    // one thing that happened, so it is one notification.
    await stub.append(gameId, ALICE, await makeChain(bytes, 4), Date.now());

    expect((await pushStats(stub)).attempts).toBe(1);
  });
});

describe('the 24 hour reminder', () => {
  it('nudges the player who has not answered', async () => {
    const { gameId, bytes, stub } = room('push-remind-001');
    const now = Date.now();

    await stub.setPushSubscription(BOB, subscription, now);
    await stub.append(gameId, ALICE, await makeChain(bytes, 1), now);
    expect((await pushStats(stub)).attempts).toBe(1);

    // Bring the deadline forward rather than waiting a day.
    await bringReminderForward(stub, now - 1);
    expect(await runDurableObjectAlarm(stub)).toBe(true);

    expect((await pushStats(stub)).attempts).toBe(2);
  });

  it('does not nag once the reminder has been sent', async () => {
    const { gameId, bytes, stub } = room('push-nonag-0001');
    const now = Date.now();

    await stub.setPushSubscription(BOB, subscription, now);
    await stub.append(gameId, ALICE, await makeChain(bytes, 1), now);
    await bringReminderForward(stub, now - 1);
    await runDurableObjectAlarm(stub);
    expect((await pushStats(stub)).attempts).toBe(2);

    // The reminder was consumed when it fired; waking again changes nothing.
    await runDurableObjectAlarm(stub);
    expect((await pushStats(stub)).attempts).toBe(2);
  });

  it('starts a fresh reminder when the next move arrives', async () => {
    const { gameId, bytes, stub } = room('push-refresh-01');
    const now = Date.now();

    await stub.setPushSubscription(BOB, subscription, now);
    const entries = await makeChain(bytes, 2);
    await stub.append(gameId, ALICE, [entries[0]], now);
    await bringReminderForward(stub, now - 1);
    await runDurableObjectAlarm(stub);

    await stub.append(gameId, ALICE, [entries[1]], now + 1000);

    await runInDurableObject(stub, async (_instance, state) => {
      const row = state.storage.sql
        .exec<{ v: string }>(`SELECT v FROM meta WHERE k = 'reminderAt'`)
        .toArray()[0];
      expect(row).toBeDefined();
      expect(Number(row.v)).toBeGreaterThan(now);
    });
  });
});

describe('a player with more than one device', () => {
  /** A second real P-256 point, for the same person's other device. */
  const laptop = {
    endpoint: 'https://push.example/send/def456',
    keys: {
      p256dh:
        'BFXyfmiUiJ7iUcHUeRUC3Ils8Fl2WMbP3fH1rrPQu8eBMwtb8HFdOI2yj8Fp4EBqXjLGKMd2v8yEwQ4hs4zGvwo',
      auth: 'zqbxT6JKtdKu8FkVSVGiGw',
    },
  };

  it('tells every device, not just whichever subscribed last', async () => {
    // The old shape kept one subscription per participant, so a person who
    // opened the game on a laptop silently stopped hearing about it on their
    // phone — a failure nobody reports, because it looks like nothing.
    const { gameId, bytes, stub } = room('push-devices-01');
    const now = Date.now();

    await stub.setPushSubscription(BOB, subscription, now);
    await stub.setPushSubscription(BOB, laptop, now);

    await stub.append(gameId, ALICE, await makeChain(bytes, 1), now);

    expect((await pushStats(stub)).attempts).toBe(2);
  });

  it('retires one device without unsubscribing the other', async () => {
    const { gameId, bytes, stub } = room('push-devices-02');
    const now = Date.now();

    await stub.setPushSubscription(BOB, subscription, now);
    await stub.setPushSubscription(BOB, laptop, now);
    await stub.setPushSubscription(BOB, null, now, laptop.endpoint);

    await stub.append(gameId, ALICE, await makeChain(bytes, 1), now);

    expect((await pushStats(stub)).attempts).toBe(1);
  });

  it('carries forward a subscription written before devices existed', async () => {
    // Rooms already in flight have one in the old column. Left there it would
    // simply stop receiving pushes.
    const { gameId, bytes, stub } = room('push-devices-03');
    const now = Date.now();

    await stub.setPushSubscription(BOB, subscription, now);
    await runInDurableObject(stub, async (_instance, state) => {
      state.storage.sql.exec(`DELETE FROM push_endpoint`);
      state.storage.sql.exec(
        `UPDATE participant SET push_sub = ? WHERE key_hash = ?`,
        JSON.stringify(subscription),
        BOB,
      );
    });

    await stub.append(gameId, ALICE, await makeChain(bytes, 1), now);
    expect((await pushStats(stub)).attempts).toBe(1);

    // And it was moved, not copied: a second move does not push twice.
    await runInDurableObject(stub, async (_instance, state) => {
      const row = state.storage.sql
        .exec<{ n: number }>(`SELECT COUNT(*) AS n FROM push_endpoint WHERE key_hash = ?`, BOB)
        .toArray()[0];
      expect(row.n).toBe(1);
    });
  });
});
