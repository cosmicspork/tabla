/**
 * What one device tells another, and what the other does about it.
 *
 * Both halves run here against one database, which is exactly what makes the
 * test possible: every device of a person holds the same identity seed, so a
 * notice sealed for the laptop can be opened by pretending to be the laptop.
 * The relay is a map — what it holds is opaque to it, which is the property
 * being relied on rather than the one being tested.
 */
import 'fake-indexeddb/auto';

import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { toBase64Url } from '@tabla/shared';

const posted = new Map<string, { messageId: string; body: string; createdAt: number }[]>();
let nextMessageId = 0;

vi.mock('./relay.ts', () => ({
  postMailbox: vi.fn(async (mailboxId: string, body: string) => {
    const messageId = `m${(nextMessageId += 1)}`;
    posted.set(mailboxId, [
      ...(posted.get(mailboxId) ?? []),
      { messageId, body, createdAt: Date.now() },
    ]);
    return { messageId, expiresAt: Date.now() + 1000 };
  }),
  pollMailboxes: vi.fn(async (ids: string[]) =>
    Object.fromEntries(ids.map((id) => [id, posted.get(id) ?? []])),
  ),
  deleteMailboxMessage: vi.fn(async (mailboxId: string, messageId: string) => {
    posted.set(
      mailboxId,
      (posted.get(mailboxId) ?? []).filter((m) => m.messageId !== messageId),
    );
  }),
}));

const { announce, announceContact, announceGame, announceGameGone, pollDevices, removedBy } =
  await import('./devices.ts');
const { closeDatabase, resetDatabaseHandle } = await import('./db/schema.ts');
const store = await import('./db/store.ts');
const { forgetIdentity, loadIdentity } = await import('./identity.ts');
const { displayName } = await import('./profile.ts');
const { loadCoreFromDisk } = await import('./wasm/node.ts');

import type { GameRecord } from './db/schema.ts';

const PHONE = toBase64Url(new Uint8Array(16).fill(1));
const LAPTOP = toBase64Url(new Uint8Array(16).fill(2));

beforeAll(async () => {
  await loadCoreFromDisk();
});

/** Sets up two devices and answers as `me` from here on. */
async function asDevice(me: string, other: string) {
  await loadIdentity();
  await store.setMeta('deviceId', me);
  await store.putDevice({ id: me, name: me === PHONE ? 'Phone' : 'Laptop', linkedAt: 1 });
  await store.putDevice({ id: other, name: other === PHONE ? 'Phone' : 'Laptop', linkedAt: 2 });
}

function game(overrides: Partial<GameRecord> = {}): GameRecord {
  return {
    gameId: toBase64Url(new Uint8Array(16).fill(3)),
    blobId: toBase64Url(new Uint8Array(16).fill(4)),
    pluginId: 'letras',
    pluginVersion: 3,
    role: 'initiator',
    initiatorPubKey: toBase64Url(new Uint8Array(32).fill(5)),
    seed: toBase64Url(new Uint8Array(32).fill(6)),
    status: 'pending',
    createdAt: 1_780_000_000_000,
    lastActivity: 1_780_000_000_000,
    ...overrides,
  };
}

afterEach(() => {
  posted.clear();
  closeDatabase();
  resetDatabaseHandle();
  indexedDB.deleteDatabase('tabla');
  forgetIdentity();
});

describe('telling the other devices', () => {
  it('leaves a sealed notice the relay cannot read', async () => {
    await asDevice(PHONE, LAPTOP);
    await announceGameGone(game().gameId);

    const [[mailboxId, messages]] = [...posted.entries()];
    expect(messages).toHaveLength(1);
    // The mailbox is a capability, not a name: nothing about the device is in it.
    expect(mailboxId).not.toContain(LAPTOP.slice(0, 8));
    expect(messages[0].body).not.toContain(game().gameId.slice(0, 8));
  });

  it('says nothing when there is nobody to tell', async () => {
    await loadIdentity();
    await store.setMeta('deviceId', PHONE);
    await store.putDevice({ id: PHONE, name: 'Phone', linkedAt: 1 });

    await announceGameGone(game().gameId);
    expect(posted.size).toBe(0);
  });

  it('does not fail the thing it was reporting when the relay is down', async () => {
    await asDevice(PHONE, LAPTOP);
    const relay = await import('./relay.ts');
    vi.mocked(relay.postMailbox).mockRejectedValueOnce(new Error('offline'));

    await expect(announceGameGone(game().gameId)).resolves.toBeUndefined();
  });
});

describe('acting on what another device says', () => {
  it('adds a game it has never seen', async () => {
    await asDevice(PHONE, LAPTOP);
    await announceGame(game({ opponentName: 'Pooja' }));

    await asDevice(LAPTOP, PHONE);
    expect(await pollDevices()).toBe(1);

    const learned = await store.getGame(game().gameId);
    expect(learned?.opponentName).toBe('Pooja');
    expect(learned?.status).toBe('pending');
  });

  it('believes whichever device saw the game move most recently', async () => {
    await asDevice(PHONE, LAPTOP);
    // The phone is behind: it last saw the game an hour before this device did.
    await announceGame(game({ status: 'active', lastActivity: 1, lastPlay: 'stale' }));

    await asDevice(LAPTOP, PHONE);
    await store.putGame(game({ status: 'active', lastActivity: 999, lastPlay: 'fresh' }));
    await pollDevices();

    expect((await store.getGame(game().gameId))?.lastPlay).toBe('fresh');
  });

  it('takes a game back when an invitation is withdrawn', async () => {
    await asDevice(LAPTOP, PHONE);
    await store.putGame(game());

    await asDevice(PHONE, LAPTOP);
    await announceGameGone(game().gameId);

    await asDevice(LAPTOP, PHONE);
    await pollDevices();
    expect(await store.getGame(game().gameId)).toBeUndefined();
  });

  it('carries a name a contact was given elsewhere', async () => {
    const key = toBase64Url(new Uint8Array(32).fill(7));

    await asDevice(LAPTOP, PHONE);
    await store.rememberContact(key, 'Opponent', 1);

    await asDevice(PHONE, LAPTOP);
    await announceContact(key, 'Pooja', 1);

    await asDevice(LAPTOP, PHONE);
    await pollDevices();

    // A rename is a decision, so it replaces the placeholder rather than
    // waiting for one — which is the difference from a handshake arriving.
    expect((await store.getContact(key))?.name).toBe('Pooja');
  });

  it('carries a change of display name without sending it back', async () => {
    await asDevice(PHONE, LAPTOP);
    await announce({ NameChanged: 'Josh' });

    await asDevice(LAPTOP, PHONE);
    await pollDevices();

    expect(await displayName()).toBe('Josh');
    // If applying it announced it, the phone would answer, and so on forever:
    // the notice is consumed and nothing takes its place.
    expect([...posted.values()].flat()).toHaveLength(0);
  });

  it('learns about a device it has not met', async () => {
    const tablet = toBase64Url(new Uint8Array(16).fill(9));

    await asDevice(PHONE, LAPTOP);
    await announce({
      DeviceAdded: { id: [...new Uint8Array(16).fill(9)], name: 'Tablet', linked_at: 5 },
    });

    await asDevice(LAPTOP, PHONE);
    await pollDevices();

    expect((await store.getDevice(tablet))?.name).toBe('Tablet');
  });

  it('stops when it is told it was the one removed', async () => {
    await asDevice(PHONE, LAPTOP);
    await announce({ DeviceRemoved: { id: [...new Uint8Array(16).fill(2)] } });

    await asDevice(LAPTOP, PHONE);
    await pollDevices();

    // Cooperative by necessity: nothing can take the seed back off a device.
    expect(await removedBy()).toBe(PHONE);
    // And it does not delete itself from its own list, which would leave the
    // screen it is about to show unable to say who removed it.
    expect(await store.getDevice(LAPTOP)).toBeDefined();
  });

  it('forgets a device that some other one removed', async () => {
    const tablet = toBase64Url(new Uint8Array(16).fill(9));

    await asDevice(LAPTOP, PHONE);
    await store.putDevice({ id: tablet, name: 'Tablet', linkedAt: 5 });

    await asDevice(PHONE, LAPTOP);
    await announce({ DeviceRemoved: { id: [...new Uint8Array(16).fill(9)] } });

    await asDevice(LAPTOP, PHONE);
    await pollDevices();
    expect(await store.getDevice(tablet)).toBeUndefined();
  });

  it('notes when it last heard from the device that wrote', async () => {
    await asDevice(PHONE, LAPTOP);
    await announceGameGone(game().gameId);

    await asDevice(LAPTOP, PHONE);
    await pollDevices();

    expect((await store.getDevice(PHONE))?.lastSeenAt).toBeGreaterThan(0);
  });

  it('takes each notice exactly once', async () => {
    await asDevice(PHONE, LAPTOP);
    await announceGame(game());

    await asDevice(LAPTOP, PHONE);
    expect(await pollDevices()).toBe(1);
    expect(await pollDevices()).toBe(0);
  });

  it('ignores a blob that will not open', async () => {
    await asDevice(LAPTOP, PHONE);
    const { identity } = await loadIdentity();
    const mailboxId = toBase64Url(identity.deviceMailbox(new Uint8Array(16).fill(2)));
    posted.set(mailboxId, [
      { messageId: 'x', body: toBase64Url(new Uint8Array(80).fill(0)), createdAt: 1 },
    ]);

    expect(await pollDevices()).toBe(0);
  });
});
