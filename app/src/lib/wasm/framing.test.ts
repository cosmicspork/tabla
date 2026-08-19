/**
 * Guards the one piece of the log format the relay is allowed to understand.
 *
 * `@tabla/shared/framing` re-implements, in TypeScript, how to read an entry's
 * sequence number and previous hash and how to compute its hash. That
 * duplication is a real risk: if it ever disagrees with the Rust core, the relay
 * silently rejects valid appends or writes tombstones that point at nothing.
 *
 * So the constants are checked against entries the Rust core actually produced,
 * rather than against themselves.
 */
import { describe, expect, it } from 'vitest';

import {
  ENTRY_DOMAIN,
  ENTRY_GAME_ID_OFFSET,
  ENTRY_HEADER_LEN,
  ENTRY_PREV_HASH_OFFSET,
  HASH_LEN,
  MIN_ENTRY_LEN,
  entryHash,
  entryPrevHash,
  entrySeq,
  isGenesisPrevHash,
} from '@tabla/shared';

import { loadCoreFromDisk } from './node.ts';

const core = await loadCoreFromDisk();

const GAME_ID = new TextEncoder().encode('tabla-framing-01');
const alice = new core.Identity(new Uint8Array(32).fill(0x11));
const bob = new core.Identity(new Uint8Array(32).fill(0x22));

function hex(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** A real signed chain, built by the Rust core exactly as a client would. */
function realChain(count: number): { entries: Uint8Array[]; tipHash: Uint8Array } {
  const key = alice.agreeGameKey(bob.publicKey(), GAME_ID, GAME_ID);
  const session = new core.Session(GAME_ID, key, alice.publicKey(), bob.publicKey());
  const log = new core.Log(GAME_ID, alice.publicKey(), bob.publicKey());

  log.appendSigned(bob, session.sealJoin(new Uint8Array(24).fill(0), bob.publicKey()));
  if (count > 1) {
    log.appendSigned(alice, session.sealSetup(new Uint8Array(24).fill(1), new Uint8Array()));
  }
  for (let seq = 2; seq < count; seq++) {
    const mover = seq % 2 === 0 ? alice : bob;
    log.appendSigned(
      mover,
      session.sealMove(seq, new Uint8Array(24).fill(seq), new Uint8Array([seq])),
    );
  }

  return { entries: [...log.suffix(0)], tipHash: log.tipHash! };
}

describe('entry framing', () => {
  it('reads the sequence number the core wrote', () => {
    const { entries } = realChain(4);

    entries.forEach((entry, i) => {
      expect(entrySeq(entry)).toBe(i);
    });
  });

  it('computes the same entry hash as the core', async () => {
    // This is the assertion that keeps tombstones meaningful: the relay derives
    // the tip hash itself, and it has to be the same hash the clients chain on.
    const { entries, tipHash } = realChain(5);

    expect(hex(await entryHash(entries.at(-1)!))).toBe(hex(tipHash));
  });

  it('reads a previous hash that matches the preceding entry', async () => {
    const { entries } = realChain(4);

    for (let i = 1; i < entries.length; i++) {
      expect(hex(entryPrevHash(entries[i]))).toBe(hex(await entryHash(entries[i - 1])));
    }
  });

  it('recognizes the genesis previous hash', () => {
    const { entries } = realChain(3);

    expect(isGenesisPrevHash(entryPrevHash(entries[0]))).toBe(true);
    expect(isGenesisPrevHash(entryPrevHash(entries[1]))).toBe(false);
  });

  it('finds the domain tag and game id where it expects them', () => {
    const { entries } = realChain(2);
    const entry = entries[0];

    expect(new TextDecoder().decode(entry.subarray(0, ENTRY_DOMAIN.length))).toBe(ENTRY_DOMAIN);
    expect(hex(entry.subarray(ENTRY_GAME_ID_OFFSET, ENTRY_GAME_ID_OFFSET + 16))).toBe(hex(GAME_ID));
  });

  it('agrees with the core on how long an entry is', () => {
    const { entries } = realChain(3);

    for (const entry of entries) {
      expect(entry.length).toBeGreaterThanOrEqual(MIN_ENTRY_LEN);
    }
    // Header, then payload, then a 64-byte signature.
    expect(ENTRY_PREV_HASH_OFFSET + HASH_LEN).toBe(ENTRY_GAME_ID_OFFSET);
    expect(ENTRY_HEADER_LEN).toBe(100);
  });

  it('refuses to read something too short to be an entry', () => {
    expect(() => entrySeq(new Uint8Array(10))).toThrow(/minimum/);
    expect(() => entryPrevHash(new Uint8Array(MIN_ENTRY_LEN - 1))).toThrow(/minimum/);
  });
});
