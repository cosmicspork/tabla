/**
 * The acceptance test for phase 1's protocol.
 *
 * Two simulated clients play a full game of tic tac toe through the real relay,
 * using the real sync engine and real cryptography — no mocks anywhere below the
 * transport. Along the way the game goes fully asynchronous (one client is not
 * connected while the other moves), survives having the relay's storage wiped
 * mid-game, and refuses a rollback.
 *
 * Everything here runs inside workerd, so the Durable Object, its hibernating
 * WebSockets, and its SQLite storage are the ones that ship.
 */
import { SELF, evictDurableObject } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';

import { toBase64Url } from '@tabla/shared';

import { SyncEngine } from '../../app/src/lib/sync/engine.ts';
import type { SocketLike } from '../../app/src/lib/sync/engine.ts';
import { loadCore } from '../../app/src/lib/wasm/core.ts';
import { loadPlugin } from '../../app/src/lib/wasm/plugin.ts';
import type { CoreModule } from '../../app/src/lib/wasm/core.ts';
import type { PluginModule } from '../../app/src/lib/wasm/plugin.ts';
// Workers can import a `.wasm` file directly as a compiled module.
import coreWasm from '../../app/src/lib/wasm/pkg/core/tabla_core_bg.wasm';
import pluginWasm from '../../app/src/lib/wasm/pkg/plugin/tabla_plugin_bg.wasm';

import { roomStub } from './helpers.ts';

let core: CoreModule;
let plugin: PluginModule;

beforeAll(async () => {
  core = await loadCore(coreWasm);
  plugin = await loadPlugin(pluginWasm);
});

/** Opens a real WebSocket to the relay through the Worker's own router. */
const transport = async (gameId: string): Promise<SocketLike> => {
  const response = await SELF.fetch(`https://tabla.test/ws/game/${gameId}`, {
    headers: { Upgrade: 'websocket' },
  });

  const socket = response.webSocket;
  if (!socket) throw new Error(`expected a websocket, got ${response.status}`);
  socket.accept();
  return socket as unknown as SocketLike;
};

const nonce = (n: number) => new Uint8Array(24).fill(n);

/** One player: identity, log, session, and an engine pointed at the relay. */
class Client {
  readonly engine: SyncEngine;
  readonly errors: { code: string; detail?: string }[] = [];

  constructor(
    readonly identity: InstanceType<CoreModule['Identity']>,
    readonly session: InstanceType<CoreModule['Session']>,
    readonly log: InstanceType<CoreModule['Log']>,
    gameId: string,
  ) {
    this.engine = new SyncEngine({
      core,
      gameId,
      keyHash: identity.keyHash(),
      log,
      transport,
      onError: (code, detail) => this.errors.push({ code, detail }),
    });
  }

  get tipSeq(): number {
    return Number(this.log.tipSeq);
  }

  moves(): Uint8Array[] {
    return [...this.log.replay(this.session).moves];
  }

  /** The position as this player sees it, computed by the plugin. */
  view(player: number) {
    const replay = this.log.replay(this.session);
    const state = plugin.replay(
      'tictactoe',
      replay.config ?? new Uint8Array(),
      new Uint8Array(32),
      [...replay.moves],
      new Uint8Array(),
    );
    return JSON.parse(plugin.player_view('tictactoe', state, player));
  }

  outcome(): unknown {
    const replay = this.log.replay(this.session);
    const state = plugin.replay(
      'tictactoe',
      replay.config ?? new Uint8Array(),
      new Uint8Array(32),
      [...replay.moves],
      new Uint8Array(),
    );
    const raw = plugin.is_game_over('tictactoe', state);
    return raw === undefined || raw === null ? null : JSON.parse(raw);
  }
}

/** Builds both clients for one game, sharing a derived key as the real flow does. */
function makeGame(label: string) {
  const gameIdBytes = new Uint8Array(16);
  gameIdBytes.set(new TextEncoder().encode(label).subarray(0, 16));
  const gameId = toBase64Url(gameIdBytes);

  const blobId = new Uint8Array(16).fill(0x7a);
  const alice = new core.Identity(seedFor(`${label}-a`));
  const bob = new core.Identity(seedFor(`${label}-b`));

  const make = (me: InstanceType<CoreModule['Identity']>, peer: Uint8Array) => {
    const key = me.agreeGameKey(peer, blobId, gameIdBytes);
    const session = new core.Session(gameIdBytes, key, alice.publicKey(), bob.publicKey());
    const log = new core.Log(gameIdBytes, alice.publicKey(), bob.publicKey());
    return { session, log };
  };

  const a = make(alice, bob.publicKey());
  const b = make(bob, alice.publicKey());

  return {
    gameId,
    gameIdBytes,
    alice: new Client(alice, a.session, a.log, gameId),
    bob: new Client(bob, b.session, b.log, gameId),
  };
}

function seedFor(label: string): Uint8Array {
  const seed = new Uint8Array(32);
  for (let i = 0; i < label.length && i < 32; i++) seed[i] = label.charCodeAt(i);
  seed[31] = label.length;
  return seed;
}

const encodeMove = (cell: number) => plugin.encodeMove('tictactoe', JSON.stringify({ cell }));

/** Waits for one client's log to reach a sequence. */
const reaches = (who: Client, seq: number) =>
  until(() => who.tipSeq === seq, `a log to reach ${seq}`);

/** Waits for a client to finish its opening exchange with the relay. */
const connected = (who: Client) =>
  until(() => who.engine.status === 'synced', 'a client to sync');

/** Waits for the relay to confirm everything a client has written. */
const flushed = (who: Client) =>
  until(() => who.engine.pendingCount === 0, 'the relay to confirm a write');

/**
 * Waits for something to become true, rather than for a fixed interval.
 *
 * Everything here is a round trip through a Durable Object, and how long that
 * takes depends on the machine. A sleep long enough for a laptop is not long
 * enough for a loaded CI runner, and a sleep long enough for both would make
 * the suite slow for nobody's benefit.
 */
async function until(
  condition: () => boolean | Promise<boolean>,
  what: string,
): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (await condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for ${what}`);
}

describe('two clients playing through the relay', () => {
  it('completes a full game and agrees on the result', async () => {
    const { alice, bob } = makeGame('sync-full-000001');

    await alice.engine.connect();
    await bob.engine.connect();
    await connected(alice);
    await connected(bob);

    // Prologue: the claimer joins, the initiator writes the configuration.
    bob.engine.appendLocal(bob.identity, bob.session.sealJoin(nonce(0), bob.identity.publicKey(), ''));
    await reaches(alice, 0);
    alice.engine.appendLocal(alice.identity, alice.session.sealSetup(nonce(1), new Uint8Array()));
    await reaches(bob, 1);

    // Alice takes the top row; Bob answers down the middle-left.
    for (const [i, cell] of [0, 3, 1, 4, 2].entries()) {
      const seq = 2 + i;
      const mover = seq % 2 === 0 ? alice : bob;
      const waiter = seq % 2 === 0 ? bob : alice;
      mover.engine.appendLocal(
        mover.identity,
        mover.session.sealMove(seq, nonce(seq), encodeMove(cell)),
      );
      // The next move is the opponent's, so it cannot be made until they have
      // this one. Waiting for that is also what the assertion below is about.
      await reaches(waiter, seq);
    }

    expect(alice.tipSeq).toBe(6);
    expect(bob.tipSeq).toBe(6);
    expect(alice.errors).toEqual([]);
    expect(bob.errors).toEqual([]);

    // Both clients independently reach the same verdict.
    expect(alice.outcome()).toEqual({ kind: 'winner', player: 0 });
    expect(bob.outcome()).toEqual({ kind: 'winner', player: 0 });
    expect(alice.engine.status).toBe('synced');
    expect(bob.engine.status).toBe('synced');

    alice.engine.disconnect();
    bob.engine.disconnect();
  });

  it('delivers moves made while the opponent was away', async () => {
    // The normal case for correspondence play: nobody is online at the same time.
    const { alice, bob } = makeGame('sync-async-00001');

    await bob.engine.connect();
    await connected(bob);
    bob.engine.appendLocal(bob.identity, bob.session.sealJoin(nonce(0), bob.identity.publicKey(), ''));
    await flushed(bob);
    bob.engine.disconnect();

    // Alice arrives later, picks up Bob's join, and plays two entries.
    await alice.engine.connect();
    await until(() => alice.tipSeq === 0, "Alice to pick up Bob's join");

    alice.engine.appendLocal(alice.identity, alice.session.sealSetup(nonce(1), new Uint8Array()));
    alice.engine.appendLocal(alice.identity, alice.session.sealMove(2, nonce(2), encodeMove(4)));
    await flushed(alice);
    alice.engine.disconnect();

    // Bob comes back and catches up without either of them being online together.
    await bob.engine.connect();
    await until(() => bob.tipSeq === 2, 'Bob to catch up');

    expect(bob.moves().map((m) => m[0])).toEqual([4]);
    expect(bob.errors).toEqual([]);
    bob.engine.disconnect();
  });

  it('accepts a move made entirely offline once the client reconnects', async () => {
    const { gameId, alice, bob } = makeGame('sync-offline-001');

    await bob.engine.connect();
    await connected(bob);
    bob.engine.appendLocal(bob.identity, bob.session.sealJoin(nonce(0), bob.identity.publicKey(), ''));
    await flushed(bob);
    bob.engine.disconnect();

    // Alice has never connected. She plays anyway.
    alice.log.append(bob.log.entry(0)!);
    alice.engine.appendLocal(alice.identity, alice.session.sealSetup(nonce(1), new Uint8Array()));
    alice.engine.appendLocal(alice.identity, alice.session.sealMove(2, nonce(2), encodeMove(8)));
    expect(alice.tipSeq).toBe(2);

    // Connecting flushes what the relay is missing. There is no outbox to
    // replay: the log past the relay's tip *is* the queue.
    await alice.engine.connect();
    await until(() => alice.engine.pendingCount === 0, 'Alice to flush her backlog');
    expect((await roomStub(gameId).state()).tipSeq).toBe(2);
    alice.engine.disconnect();
  });
});

describe('surviving relay eviction', () => {
  it('re-uploads the log and finishes the game', async () => {
    const { gameId, alice, bob } = makeGame('sync-evicted-001');

    await alice.engine.connect();
    await bob.engine.connect();
    await connected(alice);
    await connected(bob);

    bob.engine.appendLocal(bob.identity, bob.session.sealJoin(nonce(0), bob.identity.publicKey(), ''));
    await reaches(alice, 0);
    alice.engine.appendLocal(alice.identity, alice.session.sealSetup(nonce(1), new Uint8Array()));
    await reaches(bob, 1);
    for (const [i, cell] of [0, 3].entries()) {
      const seq = 2 + i;
      const mover = seq % 2 === 0 ? alice : bob;
      const waiter = seq % 2 === 0 ? bob : alice;
      mover.engine.appendLocal(
        mover.identity,
        mover.session.sealMove(seq, nonce(seq), encodeMove(cell)),
      );
      await reaches(waiter, seq);
    }

    expect(alice.tipSeq).toBe(3);
    alice.engine.disconnect();
    bob.engine.disconnect();

    // The relay evicts the game's ciphertext, leaving only the tombstone —
    // exactly what the ninety-day retention alarm does.
    const room = roomStub(gameId);
    await room.wipeForTest();
    expect((await room.state()).tipSeq).toBe(-1);
    expect((await room.state()).tombstone).not.toBeNull();

    // Alice comes back to an empty room and re-uploads her whole log.
    await alice.engine.connect();
    await until(async () => (await room.state()).tipSeq === 3, 'the relay to be re-filled');

    expect(alice.errors).toEqual([]);

    // The game carries on as if nothing happened.
    alice.engine.appendLocal(alice.identity, alice.session.sealMove(4, nonce(4), encodeMove(1)));
    await until(async () => (await room.state()).tipSeq === 4, 'the relay to take the move');

    await bob.engine.connect();
    await reaches(bob, 4);
    expect(bob.errors).toEqual([]);

    alice.engine.disconnect();
    bob.engine.disconnect();
  });

  it('survives the Durable Object being evicted from memory mid-game', async () => {
    // Distinct from wiping storage: this drops the in-memory instance while
    // keeping its SQLite data, which is what hibernation does to an idle room.
    // The game must simply carry on.
    const { gameId, alice, bob } = makeGame('sync-hibernate-1');

    await alice.engine.connect();
    await bob.engine.connect();
    await connected(alice);
    await connected(bob);

    bob.engine.appendLocal(bob.identity, bob.session.sealJoin(nonce(0), bob.identity.publicKey(), ''));
    await reaches(alice, 0);
    alice.engine.appendLocal(alice.identity, alice.session.sealSetup(nonce(1), new Uint8Array()));
    await reaches(bob, 1);

    alice.engine.disconnect();
    bob.engine.disconnect();

    await evictDurableObject(roomStub(gameId));

    // Storage survived the eviction, so the reconnecting client finds its game
    // exactly where it left it.
    const room = roomStub(gameId);
    expect((await room.state()).tipSeq).toBe(1);

    await alice.engine.connect();
    await until(() => alice.engine.status === 'synced', 'Alice to resync');
    alice.engine.appendLocal(alice.identity, alice.session.sealMove(2, nonce(2), encodeMove(4)));
    await until(async () => (await room.state()).tipSeq === 2, 'the relay to take the move');

    expect(alice.errors).toEqual([]);
    alice.engine.disconnect();
  });

  it('refuses a log that would roll the game back', async () => {
    const { gameId, gameIdBytes, alice, bob } = makeGame('sync-rollback-01');

    await alice.engine.connect();
    await bob.engine.connect();
    await connected(alice);
    await connected(bob);

    bob.engine.appendLocal(bob.identity, bob.session.sealJoin(nonce(0), bob.identity.publicKey(), ''));
    await reaches(alice, 0);
    alice.engine.appendLocal(alice.identity, alice.session.sealSetup(nonce(1), new Uint8Array()));
    await reaches(bob, 1);
    for (const [i, cell] of [0, 3, 1].entries()) {
      const seq = 2 + i;
      const mover = seq % 2 === 0 ? alice : bob;
      const waiter = seq % 2 === 0 ? bob : alice;
      mover.engine.appendLocal(
        mover.identity,
        mover.session.sealMove(seq, nonce(seq), encodeMove(cell)),
      );
      await reaches(waiter, seq);
    }
    alice.engine.disconnect();
    bob.engine.disconnect();

    const room = roomStub(gameId);
    await room.wipeForTest();

    // A client that somehow lost its last two entries tries to restore a
    // shorter history. The tombstone records a tip that this log does not
    // contain, so the client refuses rather than silently erasing moves.
    const short = new core.Log(
      gameIdBytes,
      alice.identity.publicKey(),
      bob.identity.publicKey(),
    );
    for (let seq = 0; seq <= 2; seq++) short.append(alice.log.entry(seq)!);

    const refusals: string[] = [];
    const engine = new SyncEngine({
      core,
      gameId,
      keyHash: alice.identity.keyHash(),
      log: short,
      transport,
      onError: (code) => refusals.push(code),
    });

    await engine.connect();
    await until(() => refusals.length > 0, 'the client to refuse the rollback');

    expect(refusals).toContain('tombstone');
    expect(engine.status).toBe('refused');
    // Nothing was uploaded, so the relay still holds no truncated history.
    expect((await room.state()).tipSeq).toBe(-1);
  });
});

describe('presence', () => {
  it('tells each player when the other is connected, and when they leave', async () => {
    const { alice, bob } = makeGame('sync-presence-01');

    await alice.engine.connect();
    await connected(alice);

    // Alone in the room: nobody to be present.
    expect(alice.engine.opponentPresent).toBe(false);

    await bob.engine.connect();
    await until(() => alice.engine.opponentPresent, 'Alice to see Bob arrive');

    // Bob's hello tells Alice as much as it tells Bob.
    await until(() => bob.engine.opponentPresent, 'Bob to see Alice');

    bob.engine.disconnect();
    await until(() => !alice.engine.opponentPresent, 'Alice to see Bob leave');

    expect(alice.errors).toEqual([]);
    alice.engine.disconnect();
  });

  it('is forgotten by a client whose own connection drops', async () => {
    const { alice, bob } = makeGame('sync-presence-02');

    await alice.engine.connect();
    await bob.engine.connect();
    await until(() => alice.engine.opponentPresent, 'Alice to see Bob arrive');

    // Alice hangs up. She forgets locally rather than waiting to be told,
    // because a closed socket is exactly the state in which no frame can
    // arrive to correct her — and Bob is told in the ordinary way.
    alice.engine.disconnect();
    await until(() => !bob.engine.opponentPresent, 'Bob to be told Alice left');

    expect(alice.engine.opponentPresent).toBe(false);
    bob.engine.disconnect();
  });
});
