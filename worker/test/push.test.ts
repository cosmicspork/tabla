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
import { SELF, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

import {
  HASH_LEN,
  HEARTBEAT_REQUEST,
  HEARTBEAT_RESPONSE,
  PRESENCE_STALE_MS,
  PROTOCOL_VERSION,
  toBase64Url,
} from '@tabla/shared';
import type { PushSubscriptionJson } from '@tabla/shared';

import { call, gameIdBytes, makeChain, roomStub } from './helpers.ts';

const ALICE = toBase64Url(new Uint8Array(HASH_LEN).fill(0xa1));
const BOB = toBase64Url(new Uint8Array(HASH_LEN).fill(0xb2));

/**
 * A real P-256 point and auth secret. The encryption in RFC 8291 rejects a
 * fabricated key outright, so this has to be genuine curve material even though
 * nobody holds the private half.
 */
const subscription: PushSubscriptionJson = {
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

/** A second real P-256 point, for the same person's other device. */
const laptopSubscription: PushSubscriptionJson = {
  endpoint: 'https://push.example/send/def456',
  keys: {
    p256dh:
      'BFXyfmiUiJ7iUcHUeRUC3Ils8Fl2WMbP3fH1rrPQu8eBMwtb8HFdOI2yj8Fp4EBqXjLGKMd2v8yEwQ4hs4zGvwo',
    auth: 'zqbxT6JKtdKu8FkVSVGiGw',
  },
};

/** One device with a real socket on a room, as a browser would have. */
class Device {
  private constructor(
    readonly socket: WebSocket,
    readonly received: string[],
  ) {}

  static async open(gameId: string, keyHash: string): Promise<Device> {
    const response = await SELF.fetch(`https://tabla.test/ws/game/${gameId}`, {
      headers: { Upgrade: 'websocket' },
    });
    const socket = response.webSocket;
    if (!socket) throw new Error(`expected a websocket, got ${response.status}`);

    const received: string[] = [];
    socket.accept();
    socket.addEventListener('message', (event) => {
      received.push(String(event.data));
    });

    socket.send(
      JSON.stringify({ t: 'hello', v: PROTOCOL_VERSION, keyHash, tipSeq: -1, tipHash: null }),
    );
    await settle();

    return new Device(socket, received);
  }

  async watchFor(subscription: PushSubscriptionJson): Promise<void> {
    this.socket.send(JSON.stringify({ t: 'push_sub', subscription }));
    await settle();
  }

  async beat(): Promise<void> {
    this.socket.send(HEARTBEAT_REQUEST);
    await settle();
  }
}

/** Lets queued socket frames be delivered before anything is asserted. */
function settle(): Promise<void> {
  return scheduler.wait(10);
}

/**
 * Winds every socket's last-heard-from back, as though the devices behind them
 * were frozen with the page open — a locked phone, a closed lid, a suspended
 * background tab. The socket stays listed either way, which is the whole
 * problem: it is not evidence of anyone looking.
 */
async function goQuiet(stub: ReturnType<typeof roomStub>) {
  await runInDurableObject(stub, async (_instance, state) => {
    const long = Date.now() - PRESENCE_STALE_MS * 2;
    for (const socket of state.getWebSockets()) {
      const attachment = socket.deserializeAttachment() as Record<string, unknown>;
      socket.serializeAttachment({ ...attachment, lastSeen: long });
    }
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
  const laptop = laptopSubscription;

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

/**
 * What "they already have the move" is allowed to mean.
 *
 * The relay used to read an open socket as a person watching the board, and
 * skip the notification on that basis. Under the Hibernation API a socket
 * outlives the page: an installed app frozen when a phone locks, a laptop lid
 * closed mid-game and a suspended background tab all keep one. Every one of
 * those was a turn nobody was told about — and only in production, because a
 * test that closes its sockets and a browser on a desk never look like that.
 */
describe('what counts as someone watching', () => {
  it('says nothing to a device that is looking at the board', async () => {
    const { gameId, bytes, stub } = room('push-awake-0001');
    const bob = await Device.open(gameId, BOB);
    await bob.watchFor(subscription);

    await stub.append(gameId, ALICE, await makeChain(bytes, 1), Date.now());

    expect((await pushStats(stub)).attempts).toBe(0);
    bob.socket.close();
  });

  it('tells a device whose socket is open but has gone quiet', async () => {
    const { gameId, bytes, stub } = room('push-frozen-001');
    const bob = await Device.open(gameId, BOB);
    await bob.watchFor(subscription);

    // The socket is still listed. Nobody is behind it.
    await goQuiet(stub);
    await stub.append(gameId, ALICE, await makeChain(bytes, 1), Date.now());

    expect((await pushStats(stub)).attempts).toBe(1);
    bob.socket.close();
  });

  it('believes a device again as soon as it beats', async () => {
    const { gameId, bytes, stub } = room('push-revive-001');
    const bob = await Device.open(gameId, BOB);
    await bob.watchFor(subscription);
    await goQuiet(stub);

    // Answered by the runtime, without waking the room — and that answer is
    // what puts the device back in the "someone is looking" column.
    await bob.beat();
    expect(bob.received).toContain(HEARTBEAT_RESPONSE);

    await stub.append(gameId, ALICE, await makeChain(bytes, 1), Date.now());

    expect((await pushStats(stub)).attempts).toBe(0);
    bob.socket.close();
  });

  it('tells the phone in a pocket even while a laptop is open', async () => {
    // Decided per device, not per person. One open board used to silence every
    // other device that person owned, which is the opposite of what having
    // more than one is for.
    const { gameId, bytes, stub } = room('push-both-00001');
    const now = Date.now();

    await stub.setPushSubscription(BOB, subscription, now);
    const laptop = await Device.open(gameId, BOB);
    await laptop.watchFor(laptopSubscription);

    await stub.append(gameId, ALICE, await makeChain(bytes, 1), now);

    // The phone, and only the phone.
    expect((await pushStats(stub)).attempts).toBe(1);
    laptop.socket.close();
  });

  it('still tells a device that never registered a subscription elsewhere', async () => {
    // A socket with no endpoint against it cannot be the device a given
    // subscription belongs to, so it must not silence one.
    const { gameId, bytes, stub } = room('push-anon-00001');
    const now = Date.now();

    await stub.setPushSubscription(BOB, subscription, now);
    const other = await Device.open(gameId, BOB);

    await stub.append(gameId, ALICE, await makeChain(bytes, 1), now);

    expect((await pushStats(stub)).attempts).toBe(1);
    other.socket.close();
  });
});

/**
 * Registering without opening the board.
 *
 * Notifications are switched on once, in settings, for every game at once. A
 * room used to be reachable only down its own WebSocket, so the games already
 * in progress went on saying nothing until each board happened to be opened
 * again — which is exactly what "I turned notifications on and never heard
 * about my turn" looks like from the inside.
 */
describe('registering over HTTP', () => {
  const push = (gameId: string, body: unknown) =>
    SELF.fetch(`https://tabla.test/api/game/${gameId}/push`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

  it('subscribes a game this device has not opened', async () => {
    const { gameId, bytes, stub } = room('push-http-00001');

    const response = await push(gameId, { keyHash: BOB, subscription });
    expect(response.status).toBe(200);

    await stub.append(gameId, ALICE, await makeChain(bytes, 1), Date.now());

    expect((await pushStats(stub)).attempts).toBe(1);
  });

  it('retires one endpoint without opening the board either', async () => {
    const { gameId, bytes, stub } = room('push-http-00002');
    await stub.setPushSubscription(BOB, subscription, Date.now());
    await stub.setPushSubscription(BOB, laptopSubscription, Date.now());

    await push(gameId, { keyHash: BOB, subscription: null, endpoint: laptopSubscription.endpoint });

    await stub.append(gameId, ALICE, await makeChain(bytes, 1), Date.now());

    expect((await pushStats(stub)).attempts).toBe(1);
  });

  it('refuses a body that is not a subscription', async () => {
    const { gameId } = room('push-http-00003');

    expect((await push(gameId, { keyHash: BOB })).status).toBe(400);
    expect((await push(gameId, { subscription })).status).toBe(400);
  });

  it('refuses anything but PUT', async () => {
    const { gameId } = room('push-http-00004');
    const response = await SELF.fetch(`https://tabla.test/api/game/${gameId}/push`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ keyHash: BOB, subscription }),
    });

    expect(response.status).toBe(405);
  });
});

/**
 * Saying out loud that push is switched on at all.
 *
 * A relay with no VAPID secrets is healthy in every other respect and can
 * notify nobody: `pushConfigured` is false, so every send is skipped before it
 * starts. That is a thing to learn from a deploy check rather than from two
 * people wondering for a month why neither of them hears about their turns.
 */
describe('health', () => {
  it('reports whether push is configured, and never the keys', async () => {
    const body = (await (await call('/api/health')).json()) as Record<string, unknown>;

    expect(body).toEqual({ ok: true, push: true });
    expect(JSON.stringify(body)).not.toContain('VAPID');
  });
});
