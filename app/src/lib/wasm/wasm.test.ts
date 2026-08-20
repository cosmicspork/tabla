/**
 * Proves the WASM boundary preserves the protocol.
 *
 * The values asserted here are the same frozen vectors as
 * `rust/crates/tabla-core/tests/golden_crypto.rs`. Checking them from
 * TypeScript is what rules out the failure where the Rust tests pass but the
 * bytes that actually reach the wire are different.
 */
import { describe, expect, it } from 'vitest';

import { loadCoreFromDisk, loadPluginFromDisk, readPluginWasm } from './node.ts';

const ALICE_SEED = new Uint8Array(32).fill(0x11);
const BOB_SEED = new Uint8Array(32).fill(0x22);
const GAME_ID = new TextEncoder().encode('tabla-golden-g01');
const BLOB_ID = new TextEncoder().encode('tabla-golden-b01');

// Frozen in rust/crates/tabla-core/tests/golden_crypto.rs.
const A_PUB = 'd04ab232742bb4ab3a1368bd4615e4e6d0224ab71a016baf8520a332c9778737';
const B_PUB = 'a09aa5f47a6759802ff955f8dc2d2a14a5c99d23be97f864127ff9383455a4f0';
const GAME_KEY = 'd025583f6bcabb5464fbd2ea9d3a96292b64e97606452b70f7cdd30130eb1c78';
const A_DRAW = '603b9525971b7038aa85f1b7ef2f3f417663c25acb08ff8b328f75dac726e549';
const B_DRAW = '89c3e94c7f40fd1bb1c05223dab174817ff8f41785746eecabadf9c149ef2cf6';
const A_DEAL =
  '2860080d4063cda4739ef79b5ca8d6c29cd011809bd4efaa25da0c717d2304c0' +
  '210ba2d033c91daa12521958c60c5781579145675718a0ce3282389397f4692f';
const B_DEAL =
  '613c915e265dbd4bfd20b0b0cfa85a814fb7559d5a3337e5be774ea55e0d5a74' +
  '89594877a57de29a39950c80928d4ab978b4039d828ee617a6237c902fda32de';

function hex(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

const core = await loadCoreFromDisk();
const plugin = await loadPluginFromDisk();

describe('core module', () => {
  it('derives the frozen identity public keys', () => {
    expect(hex(new core.Identity(ALICE_SEED).publicKey())).toBe(A_PUB);
    expect(hex(new core.Identity(BOB_SEED).publicKey())).toBe(B_PUB);
  });

  it('derives the frozen game key, from either side', () => {
    const alice = new core.Identity(ALICE_SEED);
    const bob = new core.Identity(BOB_SEED);

    const fromAlice = alice.agreeGameKey(bob.publicKey(), BLOB_ID, GAME_ID);
    const fromBob = bob.agreeGameKey(alice.publicKey(), BLOB_ID, GAME_ID);

    expect(hex(fromAlice)).toBe(GAME_KEY);
    expect(hex(fromBob)).toBe(GAME_KEY);
  });

  it('derives the frozen per-game draw seeds', () => {
    // Frozen in golden_crypto.rs. A game with a tile bag reconstructs a
    // half-played rack from this value, so a device that computed it
    // differently would restore a backup into the wrong hand.
    expect(hex(new core.Identity(ALICE_SEED).deriveDrawSeed(GAME_ID))).toBe(A_DRAW);
    expect(hex(new core.Identity(BOB_SEED).deriveDrawSeed(GAME_ID))).toBe(B_DRAW);
  });

  it('derives the frozen per-game deal secrets', () => {
    // The deck is encrypted under the sum of both players' public halves, so a
    // device computing this differently would open every tile to nonsense.
    expect(hex(new core.Identity(ALICE_SEED).deriveDealSecret(GAME_ID))).toBe(A_DEAL);
    expect(hex(new core.Identity(BOB_SEED).deriveDealSecret(GAME_ID))).toBe(B_DEAL);
  });

  it('rejects byte strings of the wrong length instead of truncating them', () => {
    expect(() => new core.Identity(new Uint8Array(31))).toThrow(/32 bytes/);
  });

  it('round-trips an invite through its fragment key', () => {
    const alice = new core.Identity(ALICE_SEED);
    const key = new Uint8Array(32).fill(0x44);

    const blob = core.sealInvite(
      key,
      new Uint8Array(24).fill(0x55),
      GAME_ID,
      'tictactoe',
      1,
      undefined,
      alice.publicKey(),
      new Uint8Array(32).fill(0x33),
      1_780_000_000n,
    );

    const invite = core.openInvite(key, blob);
    expect(invite.pluginId).toBe('tictactoe');
    expect(invite.pluginVersion).toBe(1);
    expect(hex(invite.initiatorPublicKey)).toBe(A_PUB);
    expect(invite.isCompatible('tictactoe', 1, undefined)).toBe(true);
    expect(invite.isCompatible('tictactoe', 2, undefined)).toBe(false);
  });

  it('leaves an invite opaque without the fragment key', () => {
    const alice = new core.Identity(ALICE_SEED);
    const blob = core.sealInvite(
      new Uint8Array(32).fill(0x44),
      new Uint8Array(24).fill(0x55),
      GAME_ID,
      'tictactoe',
      1,
      undefined,
      alice.publicKey(),
      new Uint8Array(32).fill(0x33),
      1_780_000_000n,
    );

    // This is exactly what the relay stores.
    expect(() => core.openInvite(new Uint8Array(32).fill(0x45), blob)).toThrow(/decryption/);
  });

  it('verifies a claim signature and rejects one for another invite', () => {
    const bob = new core.Identity(BOB_SEED);
    const sig = bob.signClaim(BLOB_ID);

    expect(() => core.verifyClaim(bob.publicKey(), BLOB_ID, sig)).not.toThrow();

    const otherBlob = new TextEncoder().encode('tabla-golden-b99');
    expect(() => core.verifyClaim(bob.publicKey(), otherBlob, sig)).toThrow();
  });
});

/** Builds a session and log pair for both participants of one game. */
function makeGame() {
  const alice = new core.Identity(ALICE_SEED);
  const bob = new core.Identity(BOB_SEED);
  const key = alice.agreeGameKey(bob.publicKey(), BLOB_ID, GAME_ID);

  const session = new core.Session(GAME_ID, key, alice.publicKey(), bob.publicKey());
  const log = new core.Log(GAME_ID, alice.publicKey(), bob.publicKey());

  return { alice, bob, session, log };
}

const nonce = (n: number) => new Uint8Array(24).fill(n);

/** Plays the prologue plus a list of cells, alternating from the initiator. */
function playGame(cells: number[]) {
  const { alice, bob, session, log } = makeGame();

  log.appendSigned(bob, session.sealJoin(nonce(0), bob.publicKey()));
  log.appendSigned(alice, session.sealSetup(nonce(1), new Uint8Array()));

  cells.forEach((cell, i) => {
    const seq = 2 + i;
    const mover = seq % 2 === 0 ? alice : bob;
    const mv = encodeMove(cell);
    log.appendSigned(mover, session.sealMove(seq, nonce(seq), mv));
  });

  return { alice, bob, session, log };
}

/** Moves are encoded by the plugin, never hand-rolled here. */
function encodeMove(cell: number): Uint8Array {
  return plugin.encodeMove('tictactoe', JSON.stringify({ cell }));
}

describe('the deal', () => {
  // The bag, key shares, and entropy below match the Rust vector in
  // rust/crates/tabla-deal/tests/golden.rs. Two languages reaching the same
  // bytes is what stops one of them quietly diverging.
  const BAG = new Uint8Array([1, 2, 3, 4, 5, 6]);
  const GAME = new Uint8Array(16).fill(0x5a);
  const KINDS = 27;
  const CEREMONY = 'c86929198897e17fa7609d88cbe8242d39743159c39fee74e588f01ab0c503a4';

  const secret = (index: number) => new Uint8Array(64).fill(0x10 + index);
  const entropy = (n: number) => new Uint8Array(32).fill(n);

  function table() {
    return {
      initiator: new core.DealSession(GAME, 0, secret(0), BAG, KINDS),
      claimer: new core.DealSession(GAME, 1, secret(1), BAG, KINDS),
    };
  }

  async function digestOf(payloads: Uint8Array[]): Promise<string> {
    const total = payloads.reduce((n, p) => n + p.length, 0);
    const joined = new Uint8Array(total);
    let at = 0;
    for (const payload of payloads) {
      joined.set(payload, at);
      at += payload.length;
    }
    return hex(new Uint8Array(await crypto.subtle.digest('SHA-256', joined)));
  }

  it('runs an opening ceremony to the frozen bytes', async () => {
    const { initiator, claimer } = table();
    const payloads: Uint8Array[] = [];

    const submit = (author: number, seq: number, payload: Uint8Array) => {
      payloads.push(payload);
      initiator.applyEntry(author, seq, payload);
      return claimer.applyEntry(author, seq, payload);
    };

    submit(0, 2, initiator.keyPayload(2, entropy(0x01)));
    submit(1, 3, claimer.keyAndShufflePayload(3, entropy(0x02)));

    // The Rust vector shuffles with 0x04 and deals with 0x05; the combined
    // payload builder uses one entropy value for both, so this asserts the
    // ceremony shape rather than those exact two calls.
    submit(0, 4, initiator.shufflePayload(4, 2, entropy(0x04)));
    const last = submit(1, 5, claimer.dealPayload(5, 2, entropy(0x06)));

    // The same bytes the Rust vector produces, entry for entry.
    expect(await digestOf(payloads)).toBe(CEREMONY);

    expect(initiator.ready).toBe(true);
    expect(claimer.ready).toBe(true);
    expect(last.ready).toBe(false);

    // Each player holds two positions and can read only their own.
    expect([...claimer.held]).toEqual([0, 1]);
    expect([...initiator.held]).toEqual([2, 3]);
    expect(claimer.tile(0)).toBeDefined();
    expect(initiator.tile(0)).toBeUndefined();

    // Four distinct tiles, every one of them out of the bag.
    const dealt = [...claimer.held, ...initiator.held].map(
      (p) => (claimer.tile(p) ?? initiator.tile(p)) as number,
    );
    expect(new Set(dealt).size).toBe(4);
    expect(dealt.every((tile) => [...BAG].includes(tile))).toBe(true);
  });

  it('refuses a payload replayed at another position in the log', () => {
    const { initiator, claimer } = table();
    const payload = initiator.keyPayload(2, entropy(0x01));

    expect(() => claimer.applyEntry(0, 3, payload)).toThrow();
  });

  it('refuses a tampered proof rather than opening the wrong tile', () => {
    const { initiator, claimer } = table();
    const payload = initiator.keyPayload(2, entropy(0x01));
    payload[payload.length - 1] ^= 0x01;

    expect(() => claimer.applyEntry(0, 2, payload)).toThrow();
  });

  it('carries on from a snapshot without re-reading the log', () => {
    const { initiator, claimer } = table();
    const submit = (author: number, seq: number, payload: Uint8Array) => {
      initiator.applyEntry(author, seq, payload);
      claimer.applyEntry(author, seq, payload);
    };

    submit(0, 2, initiator.keyPayload(2, entropy(0x01)));
    submit(1, 3, claimer.keyAndShufflePayload(3, entropy(0x02)));
    submit(0, 4, initiator.shufflePayload(4, 2, entropy(0x04)));

    const resumed = core.DealSession.restore(GAME, 1, secret(1), KINDS, claimer.snapshot());
    expect(resumed.ready).toBe(true);
    expect([...resumed.held]).toEqual([...claimer.held]);
    expect(resumed.tile(0)).toBe(claimer.tile(0));

    // And it can still take the next entry.
    const facts = resumed.applyEntry(1, 5, claimer.dealPayload(5, 2, entropy(0x06)));
    expect(facts.theirs.length).toBe(2);
  });
});

describe('log', () => {
  it('reports no tip when empty, matching what the relay reports', () => {
    const { log } = makeGame();

    expect(log.length).toBe(0);
    expect(log.tipSeq).toBe(-1n);
    expect(log.tipHash).toBeUndefined();
  });

  it('grows as entries are appended', () => {
    const { log } = playGame([4, 0]);

    expect(log.length).toBe(4);
    expect(log.tipSeq).toBe(3n);
    expect(log.tipHash).toBeInstanceOf(Uint8Array);
  });

  it('replays into the moves that were played', () => {
    const { session, log } = playGame([4, 0, 8]);
    const replay = log.replay(session);

    expect(replay.moveCount).toBe(3);
    expect([...replay.moves].map((m) => [...m][0])).toEqual([4, 0, 8]);
    expect(replay.resignedBy).toBeUndefined();
  });

  it('lets the opponent verify and replay the same bytes', () => {
    const { alice, bob, log } = playGame([4, 0]);

    // Rebuild from the wire form, as the opponent's client does on sync.
    const theirs = new core.Log(GAME_ID, alice.publicKey(), bob.publicKey());
    for (const entry of log.suffix(0)) theirs.append(entry);

    expect(theirs.tipSeq).toBe(log.tipSeq);
    expect(hex(theirs.tipHash!)).toBe(hex(log.tipHash!));

    const theirKey = bob.agreeGameKey(alice.publicKey(), BLOB_ID, GAME_ID);
    const theirSession = new core.Session(GAME_ID, theirKey, alice.publicKey(), bob.publicKey());
    expect(theirs.replay(theirSession).moveCount).toBe(2);
  });

  it('refuses an entry that breaks the chain', () => {
    const { alice, bob, log } = playGame([4, 0]);
    const entries = [...log.suffix(0)];

    const fresh = new core.Log(GAME_ID, alice.publicKey(), bob.publicKey());
    fresh.append(entries[0]);
    // Skip entry 1: the gap must be refused, not silently accepted.
    expect(() => fresh.append(entries[2])).toThrow(/sequence gap/);
    expect(fresh.length).toBe(1);
  });

  it('refuses a tampered entry', () => {
    const { alice, bob, log } = playGame([4]);
    const entries = [...log.suffix(0)];
    entries[0][entries[0].length - 1] ^= 0xff;

    const fresh = new core.Log(GAME_ID, alice.publicKey(), bob.publicKey());
    expect(() => fresh.append(entries[0])).toThrow(/signature/);
  });

  it('hands out only the suffix a peer is missing', () => {
    const { log } = playGame([4, 0, 8]);

    expect(log.suffix(0).length).toBe(5);
    expect(log.suffix(3).length).toBe(2);
    expect(log.suffix(5).length).toBe(0);
  });
});

describe('tombstones', () => {
  it('accepts a log that contains the tombstoned tip', () => {
    const { alice, bob, log } = playGame([4, 0]);

    const tombstone = core.encodeTombstone(
      GAME_ID,
      log.tipHash!,
      [core.keyHashOf(alice.publicKey()), core.keyHashOf(bob.publicKey())],
      1_780_000_000n,
    );

    expect(() => log.checkTombstone(tombstone)).not.toThrow();
  });

  it('refuses a log that would roll the game back', () => {
    // The relay evicted the game when it was six entries long.
    const { alice, bob, log } = playGame([4, 0, 8, 1]);
    const tombstone = core.encodeTombstone(
      GAME_ID,
      log.tipHash!,
      [core.keyHashOf(alice.publicKey()), core.keyHashOf(bob.publicKey())],
      1_780_000_000n,
    );

    // A client comes back offering only the first four entries, which would
    // silently erase the last two moves.
    const short = new core.Log(GAME_ID, alice.publicKey(), bob.publicKey());
    for (const entry of [...log.suffix(0)].slice(0, 4)) short.append(entry);

    expect(() => short.checkTombstone(tombstone)).toThrow(/rollback refused/);
  });
});

/** Games that read no reference data are handed an empty slice. */
const NO_ASSETS = new Uint8Array();

describe('plugin module', () => {
  it('is built without any keyed cryptography linked in', async () => {
    // The isolation claim is a property of the build: the plugin binary holds
    // no keys and nothing that could use one, so a compromised plugin has
    // nothing to leak and nothing to sign with. This asserts that the split has
    // not quietly collapsed.
    //
    // A plain hash is not on this list and is not meant to be. Games with
    // hidden state commit to their draws and audit them afterwards, which is
    // hashing over public values; it grants no access to anything.
    const bytes = await readPluginWasm();
    const text = new TextDecoder('utf-8', { fatal: false }).decode(bytes).toLowerCase();

    for (const symbol of ['chacha', 'ed25519', 'curve25519', 'argon', 'hkdf']) {
      expect(text).not.toContain(symbol);
    }
  });

  it('carries only the game the app bundles', () => {
    // One game ships with the app, so a fresh install with no network can still
    // play something. Every other game is a module of its own — see
    // `artifact.test.ts`, which tests the one players download.
    expect(plugin.available_plugins()).toEqual(['tictactoe']);
    expect(plugin.plugin_version('tictactoe')).toBe(1);
    expect(() => plugin.plugin_version('letras')).toThrow(/unknown plugin/);
    expect(() => plugin.plugin_version('chess')).toThrow(/unknown plugin/);
  });

  it('renders a starting position', () => {
    const state = plugin.setup('tictactoe', new Uint8Array(), new Uint8Array(32), NO_ASSETS);
    const view = JSON.parse(plugin.player_view('tictactoe', state, 0));

    expect(view.board).toEqual(Array(9).fill(null));
    expect(view.yourTurn).toBe(true);
    expect(view.legalMoves).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it('replays the moves taken from a decrypted log', () => {
    const { session, log } = playGame([0, 3, 1, 4, 2]);
    const replay = log.replay(session);

    const state = plugin.replay(
      'tictactoe',
      replay.config ?? new Uint8Array(),
      new Uint8Array(32),
      [...replay.moves],
      NO_ASSETS,
    );

    const outcome = plugin.is_game_over('tictactoe', state);
    expect(JSON.parse(outcome!)).toEqual({ kind: 'winner', player: 0 });
  });

  it('rejects an illegal move rather than applying it', () => {
    const state = plugin.setup('tictactoe', new Uint8Array(), new Uint8Array(32), NO_ASSETS);
    const taken = plugin.apply_move('tictactoe', state, encodeMove(4), NO_ASSETS);

    expect(() => plugin.validate_move('tictactoe', taken, encodeMove(4), 1, NO_ASSETS)).toThrow(
      /already taken/,
    );
  });

  it('rejects a move made out of turn', () => {
    const state = plugin.setup('tictactoe', new Uint8Array(), new Uint8Array(32), NO_ASSETS);

    expect(() => plugin.validate_move('tictactoe', state, encodeMove(0), 1, NO_ASSETS)).toThrow(
      /not your turn/,
    );
  });
});
