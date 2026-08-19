import { runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

import {
  ENTRY_PREV_HASH_OFFSET,
  HASH_LEN,
  MAX_ENTRY_BYTES,
  RETENTION_MS,
  TURN_REMINDER_MS,
  toBase64Url,
} from '@tabla/shared';

import { gameIdBytes, makeChain, makeEntry, roomStub } from './helpers.ts';

const ALICE = toBase64Url(new Uint8Array(HASH_LEN).fill(0xa1));
const BOB = toBase64Url(new Uint8Array(HASH_LEN).fill(0xb2));

/** Each test gets its own room, since storage persists across a test file. */
function freshRoom(name: string) {
  const bytes = gameIdBytes(name);
  return { gameId: toBase64Url(bytes), bytes, room: roomStub(toBase64Url(bytes)) };
}

describe('appending entries', () => {
  it('reports nothing before the first append', async () => {
    const { room } = freshRoom('empty-room-0001');
    const state = await room.state();

    // -1 is how both the relay and the client describe "no history".
    expect(state.tipSeq).toBe(-1);
    expect(state.tipHash).toBeNull();
    expect(state.tombstone).toBeNull();
  });

  it('stores a chain and advances the tip', async () => {
    const { gameId, bytes, room } = freshRoom('append-ok-00001');
    const entries = await makeChain(bytes, 3);

    const result = await room.append(gameId, ALICE, entries, Date.now());

    expect(result.ok).toBe(true);
    expect(result.tipSeq).toBe(2);
    expect(result.tipHash).not.toBeNull();
  });

  it('accepts entries arriving one at a time', async () => {
    const { gameId, bytes, room } = freshRoom('append-drip-001');
    const entries = await makeChain(bytes, 3);

    for (const entry of entries) {
      expect((await room.append(gameId, ALICE, [entry], Date.now())).ok).toBe(true);
    }

    expect((await room.state()).tipSeq).toBe(2);
  });

  it('refuses a gap in the sequence', async () => {
    const { gameId, bytes, room } = freshRoom('append-gap-0001');
    const entries = await makeChain(bytes, 4);

    await room.append(gameId, ALICE, [entries[0]], Date.now());
    const result = await room.append(gameId, ALICE, [entries[2]], Date.now());

    expect(result.ok).toBe(false);
    expect(result.code).toBe('seq_gap');
    expect((await room.state()).tipSeq).toBe(0);
  });

  it('refuses an entry that does not continue the stored log', async () => {
    const { gameId, bytes, room } = freshRoom('append-fork-000');
    const entries = await makeChain(bytes, 2);
    await room.append(gameId, ALICE, entries, Date.now());

    // A second entry 2 built on a history the relay never saw.
    const forked = makeEntry({
      seq: 2,
      prevHash: new Uint8Array(HASH_LEN).fill(0x99),
      gameId: bytes,
    });

    const result = await room.append(gameId, ALICE, [forked], Date.now());
    expect(result.ok).toBe(false);
    expect(result.code).toBe('chain_mismatch');
  });

  it('refuses a first entry that does not start from genesis', async () => {
    const { gameId, bytes, room } = freshRoom('append-nogen-00');
    const notGenesis = makeEntry({
      seq: 0,
      prevHash: new Uint8Array(HASH_LEN).fill(0x77),
      gameId: bytes,
    });

    const result = await room.append(gameId, ALICE, [notGenesis], Date.now());
    expect(result.ok).toBe(false);
    expect(result.code).toBe('chain_mismatch');
  });

  it('treats a re-sent identical entry as already done', async () => {
    const { gameId, bytes, room } = freshRoom('append-resend-0');
    const entries = await makeChain(bytes, 3);

    await room.append(gameId, ALICE, entries, Date.now());
    // Reconnecting clients routinely re-send what they already sent.
    const again = await room.append(gameId, ALICE, entries, Date.now());

    expect(again.ok).toBe(true);
    expect(again.tipSeq).toBe(2);
  });

  it('refuses a different entry at a sequence it already holds', async () => {
    const { gameId, bytes, room } = freshRoom('append-rewrite-');
    const entries = await makeChain(bytes, 2);
    await room.append(gameId, ALICE, entries, Date.now());

    // Same position and same predecessor, different contents.
    const rewritten = makeEntry({
      seq: 1,
      prevHash: entries[1].slice(ENTRY_PREV_HASH_OFFSET, ENTRY_PREV_HASH_OFFSET + HASH_LEN),
      gameId: bytes,
      payload: new TextEncoder().encode('different'),
    });

    const result = await room.append(gameId, ALICE, [rewritten], Date.now());
    expect(result.ok).toBe(false);
    expect(result.code).toBe('chain_mismatch');
  });

  it('refuses an oversized entry', async () => {
    const { gameId, bytes, room } = freshRoom('append-huge-000');
    const huge = makeEntry({
      seq: 0,
      prevHash: new Uint8Array(HASH_LEN),
      gameId: bytes,
      payload: new Uint8Array(MAX_ENTRY_BYTES + 1),
    });

    const result = await room.append(gameId, ALICE, [huge], Date.now());
    expect(result.ok).toBe(false);
    expect(result.code).toBe('entry_too_large');
  });

  it('applies a batch all or nothing', async () => {
    const { gameId, bytes, room } = freshRoom('append-atomic-0');
    const entries = await makeChain(bytes, 4);

    // Third entry in the batch is bad; nothing from the batch should land.
    const bad = makeEntry({ seq: 2, prevHash: new Uint8Array(HASH_LEN).fill(0x55), gameId: bytes });
    const result = await room.append(gameId, ALICE, [entries[0], entries[1], bad], Date.now());

    expect(result.ok).toBe(false);
    expect((await room.state()).tipSeq).toBe(-1);
  });
});

describe('serving a peer that is behind', () => {
  it('returns only the missing suffix', async () => {
    const { gameId, bytes, room } = freshRoom('suffix-00000001');
    await room.append(gameId, ALICE, await makeChain(bytes, 5), Date.now());

    expect(await room.entriesFrom(0)).toHaveLength(5);
    expect(await room.entriesFrom(3)).toHaveLength(2);
    expect(await room.entriesFrom(5)).toHaveLength(0);
  });

  it('returns entries in order with their sequence numbers', async () => {
    const { gameId, bytes, room } = freshRoom('suffix-order-00');
    await room.append(gameId, ALICE, await makeChain(bytes, 3), Date.now());

    expect((await room.entriesFrom(0)).map((e) => e.seq)).toEqual([0, 1, 2]);
  });
});

describe('alarms', () => {
  it('schedules a turn reminder before retention', async () => {
    const { gameId, bytes, room } = freshRoom('alarm-order-000');
    const now = Date.now();
    await room.append(gameId, ALICE, await makeChain(bytes, 1), now);

    await runInDurableObject(room, async (_instance, state) => {
      // One alarm, set to whichever schedule comes first.
      expect(await state.storage.getAlarm()).toBe(now + TURN_REMINDER_MS);
    });
  });

  it('does nothing if it wakes before either deadline', async () => {
    const { gameId, bytes, room } = freshRoom('alarm-early-000');
    const now = Date.now();
    await room.append(gameId, ALICE, await makeChain(bytes, 1), now);

    await runDurableObjectAlarm(room);

    // Still waiting on the reminder, and the log is untouched.
    await runInDurableObject(room, async (_instance, state) => {
      expect(await state.storage.getAlarm()).toBe(now + TURN_REMINDER_MS);
    });
    expect((await room.state()).tipSeq).toBe(0);
  });

  it('rearms for retention once the reminder has fired', async () => {
    const { gameId, bytes, room } = freshRoom('alarm-rearm-000');
    const now = Date.now();
    await room.append(gameId, ALICE, await makeChain(bytes, 1), now);

    // Bring the reminder deadline forward rather than waiting a day.
    await runInDurableObject(room, async (_instance, state) => {
      state.storage.sql.exec(`UPDATE meta SET v = ? WHERE k = 'reminderAt'`, String(now - 1));
    });
    await runDurableObjectAlarm(room);

    await runInDurableObject(room, async (_instance, state) => {
      // The reminder is spent; only retention remains, so that is the next wake.
      expect(await state.storage.getAlarm()).toBe(now + RETENTION_MS);
    });
  });

  it('sends only one reminder per turn', async () => {
    const { gameId, bytes, room } = freshRoom('alarm-once-0000');
    const now = Date.now();
    await room.append(gameId, ALICE, await makeChain(bytes, 1), now);

    await runInDurableObject(room, async (_instance, state) => {
      state.storage.sql.exec(`UPDATE meta SET v = ? WHERE k = 'reminderAt'`, String(now - 1));
    });
    await runDurableObjectAlarm(room);

    // The reminder row is consumed, so waking again cannot nag.
    await runInDurableObject(room, async (_instance, state) => {
      const rows = state.storage.sql
        .exec(`SELECT v FROM meta WHERE k = 'reminderAt'`)
        .toArray();
      expect(rows).toHaveLength(0);
    });
  });
});

describe('retention and tombstones', () => {
  /** Runs eviction directly rather than waiting ninety days. */
  async function evict(room: ReturnType<typeof roomStub>) {
    await room.wipeForTest();
  }

  it('deletes the ciphertext but keeps a tombstone', async () => {
    const { gameId, bytes, room } = freshRoom('evict-basic-000');
    await room.append(gameId, ALICE, await makeChain(bytes, 4), Date.now());
    await room.setPushSubscription(BOB, null, Date.now());

    const before = await room.state();
    await evict(room);
    const after = await room.state();

    expect(await room.entriesFrom(0)).toHaveLength(0);
    expect(after.tipSeq).toBe(-1);
    expect(after.tombstone).not.toBeNull();
    // The tombstone records the tip the relay actually held.
    expect(after.tombstone!.tipHash).toBe(before.tipHash);
    expect(after.tombstone!.gameId).toBe(gameId);
  });

  it('records who was playing, by key hash only', async () => {
    const { gameId, bytes, room } = freshRoom('evict-parties-0');
    const now = Date.now();
    await room.append(gameId, ALICE, await makeChain(bytes, 2), now);
    await room.setPushSubscription(BOB, null, now);

    await evict(room);

    const { tombstone } = await room.state();
    expect(tombstone!.participantKeyHashes.toSorted()).toEqual([ALICE, BOB].toSorted());
  });

  it('leaves a room that can be used again after eviction', async () => {
    const { gameId, bytes, room } = freshRoom('evict-reuse-000');
    const entries = await makeChain(bytes, 3);
    await room.append(gameId, ALICE, entries, Date.now());
    await evict(room);

    // The first client back re-uploads its whole log.
    const result = await room.append(gameId, ALICE, entries, Date.now());

    expect(result.ok).toBe(true);
    expect(result.tipSeq).toBe(2);
    // The tombstone survives the restore, so rollback stays detectable.
    expect((await room.state()).tombstone).not.toBeNull();
  });

  it('keeps the tombstone across repeated evictions', async () => {
    const { gameId, bytes, room } = freshRoom('evict-twice-000');
    await room.append(gameId, ALICE, await makeChain(bytes, 2), Date.now());
    await evict(room);
    const first = (await room.state()).tombstone!;

    const longer = await makeChain(bytes, 4);
    await room.append(gameId, ALICE, longer, Date.now());
    await evict(room);
    const second = (await room.state()).tombstone!;

    // Updated to the newer tip, never lost.
    expect(second.gameId).toBe(first.gameId);
    expect(second.tipHash).not.toBe(first.tipHash);
  });

  it('evicts when the retention alarm actually fires', async () => {
    // The backdoor above shares evict() with retention, but this exercises the
    // real trigger: an alarm firing with the retention deadline in the past.
    const { gameId, bytes, room } = freshRoom('evict-byalarm-0');
    await room.append(gameId, ALICE, await makeChain(bytes, 3), Date.now());

    await runInDurableObject(room, async (_instance, state) => {
      state.storage.sql.exec(`UPDATE meta SET v = ? WHERE k = 'retentionAt'`, String(Date.now() - 1));
    });
    expect(await runDurableObjectAlarm(room)).toBe(true);

    const after = await room.state();
    expect(after.tipSeq).toBe(-1);
    expect(after.tombstone).not.toBeNull();
  });

  it('clears its alarm when evicting', async () => {
    const { gameId, bytes, room } = freshRoom('evict-alarm-000');
    await room.append(gameId, ALICE, await makeChain(bytes, 1), Date.now());
    await evict(room);

    await runInDurableObject(room, async (_instance, state) => {
      expect(await state.storage.getAlarm()).toBeNull();
    });
  });
});
