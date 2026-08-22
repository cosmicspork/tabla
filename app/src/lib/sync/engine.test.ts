/**
 * What the engine does when this person's own two devices collide.
 *
 * The relay never chooses between two continuations — it keeps the first and
 * refuses the second — so a move written on a phone while a laptop was writing
 * one is not a fork to be resolved but a draft to be taken back. That is the
 * only path in the client that makes a log shorter, and the only one that has
 * to be sure it is undoing *our* entries and not somebody's history.
 */
import { beforeAll, describe, expect, it } from 'vitest';

import { HEARTBEAT_REQUEST, PROTOCOL_VERSION, entryHash, toBase64Url } from '@tabla/shared';
import type { ClientMessage, ServerMessage } from '@tabla/shared';

import { loadCoreFromDisk } from '../wasm/node.ts';
import type { CoreModule } from '../wasm/core.ts';
import { SyncEngine } from './engine.ts';
import type { SocketLike } from './engine.ts';

let core: CoreModule;

const ALICE = new Uint8Array(32).fill(0x11);
const BOB = new Uint8Array(32).fill(0x22);
const GAME_ID = new TextEncoder().encode('tabla-engine-g01');
const BLOB_ID = new TextEncoder().encode('tabla-engine-b01');

beforeAll(async () => {
  core = await loadCoreFromDisk();
});

/** A socket the test drives from both ends. */
class FakeSocket implements SocketLike {
  readonly sent: ClientMessage[] = [];
  /** The exact frames, for the one message whose bytes have to match. */
  readonly frames: string[] = [];
  private listeners: ((event: { data: unknown }) => void)[] = [];

  send(data: string): void {
    this.frames.push(data);
    this.sent.push(JSON.parse(data) as ClientMessage);
  }

  close(): void {}

  addEventListener(type: string, listener: (event: never) => void): void {
    if (type === 'message') this.listeners.push(listener as (event: { data: unknown }) => void);
  }

  /** Delivers a message as the relay would. */
  deliver(message: ServerMessage): void {
    for (const listener of this.listeners) listener({ data: JSON.stringify(message) });
  }

  of<T extends ClientMessage['t']>(t: T): Extract<ClientMessage, { t: T }>[] {
    return this.sent.filter((m): m is Extract<ClientMessage, { t: T }> => m.t === t);
  }
}

const nonce = (n: number) => new Uint8Array(24).fill(n);

/** A game with its prologue written, plus the pieces to write more. */
async function game(totalEntries = 2) {
  const alice = new core.Identity(ALICE);
  const bob = new core.Identity(BOB);
  const key = alice.agreeGameKey(bob.publicKey(), BLOB_ID, GAME_ID);

  const session = new core.Session(GAME_ID, key, alice.publicKey(), bob.publicKey());
  const log = new core.Log(GAME_ID, alice.publicKey(), bob.publicKey());

  log.appendSigned(bob, session.sealJoin(nonce(0), bob.publicKey(), 'Pooja'));
  log.appendSigned(alice, session.sealSetup(nonce(1), new Uint8Array()));
  for (let seq = 2; seq < totalEntries; seq += 1) {
    const author = seq % 2 === 0 ? alice : bob;
    log.appendSigned(author, session.sealMove(seq, nonce(seq), new Uint8Array([seq & 0xff])));
  }

  const socket = new FakeSocket();
  const events: {
    holds: (string | null)[];
    rolled: { from: number; count: number }[];
    errors: string[];
  } = { holds: [], rolled: [], errors: [] };

  const engine = new SyncEngine({
    core,
    gameId: toBase64Url(GAME_ID),
    keyHash: alice.keyHash(),
    log,
    transport: async () => socket,
    onHold: (body) => events.holds.push(body === null ? null : toBase64Url(body)),
    onRolledBack: (from, count) => events.rolled.push({ from, count }),
    onError: (code) => events.errors.push(code),
  });

  await engine.connect();
  return { alice, bob, session, log, socket, engine, events };
}

/** Tells the engine the relay holds the prologue and nothing more. */
function relayHas(socket: FakeSocket, log: { tipHash: Uint8Array | undefined }, tipSeq: number) {
  socket.deliver({
    t: 'state',
    tipSeq,
    tipHash: log.tipHash ? toBase64Url(log.tipHash) : null,
  });
}

describe('claiming the turn', () => {
  it('sends the sealed token and a lifetime', async () => {
    const { engine, socket, session } = await game();
    const token = session.sealHold(nonce(5), new Uint8Array(16).fill(4));

    engine.hold(token, 120_000);

    expect(socket.of('hold')).toHaveLength(1);
    expect(socket.of('hold')[0]).toMatchObject({ body: toBase64Url(token), ttlMs: 120_000 });
  });

  it('gives it back', async () => {
    const { engine, socket } = await game();
    engine.release();
    expect(socket.of('release')).toHaveLength(1);
  });

  it('reports a claim from another device, and its withdrawal', async () => {
    const { socket, session, events } = await game();
    const token = session.sealHold(nonce(5), new Uint8Array(16).fill(4));

    socket.deliver({ t: 'hold', body: toBase64Url(token), until: Date.now() + 1000 });
    socket.deliver({ t: 'hold', body: null, until: 0 });

    expect(events.holds).toEqual([toBase64Url(token), null]);
  });
});

describe('losing a race with your own other device', () => {
  it('takes back the entries the relay never accepted', async () => {
    const { alice, session, log, socket, engine, events } = await game();
    relayHas(socket, log, 1);

    // A move written here while the other device was writing one there.
    engine.appendLocal(alice, session.sealMove(2, nonce(2), new Uint8Array([1])));
    expect(Number(log.tipSeq)).toBe(2);

    socket.deliver({ t: 'err', code: 'chain_mismatch', detail: 'entry 2 differs' });

    // Ours was a draft. The relay's copy is the history.
    expect(Number(log.tipSeq)).toBe(1);
    expect(events.rolled).toEqual([{ from: 2, count: 1 }]);
  });

  it('asks for what actually happened at those positions', async () => {
    const { alice, session, log, socket, engine } = await game();
    relayHas(socket, log, 1);
    engine.appendLocal(alice, session.sealMove(2, nonce(2), new Uint8Array([1])));

    socket.deliver({ t: 'err', code: 'chain_mismatch', detail: 'entry 2 differs' });

    expect(socket.of('req').at(-1)).toMatchObject({ fromSeq: 2 });
    // Syncing rather than refused: this is recoverable, and recovering.
    expect(engine.status).toBe('syncing');
  });

  it('applies the move that won, onto the tip it just restored', async () => {
    const { alice, bob, session, log, socket, engine } = await game();
    relayHas(socket, log, 1);
    engine.appendLocal(alice, session.sealMove(2, nonce(2), new Uint8Array([1])));

    // What the other device wrote, built against the same prologue: the first
    // two entries, and then a different move at sequence 2.
    const theirs = new core.Log(GAME_ID, alice.publicKey(), bob.publicKey());
    for (const entry of [...log.suffix(0)].slice(0, 2)) theirs.append(entry);
    const winner = theirs.appendSigned(alice, session.sealMove(2, nonce(9), new Uint8Array([2])));

    socket.deliver({ t: 'err', code: 'chain_mismatch', detail: 'entry 2 differs' });
    socket.deliver({ t: 'entries', fromSeq: 2, entries: [{ seq: 2, entry: toBase64Url(winner) }] });

    expect(Number(log.tipSeq)).toBe(2);
    expect(log.replay(session).moveCount).toBe(1);
  });

  it('refuses rather than rolls back when the disagreement is about history', async () => {
    // Nothing of ours is unacknowledged, so the relay is contradicting entries
    // both of us already agreed on. That is not a race, and quietly discarding
    // moves to resolve it would be exactly the wrong instinct.
    const { log, socket, engine } = await game();
    relayHas(socket, log, 1);

    socket.deliver({ t: 'err', code: 'chain_mismatch', detail: 'entry 1 differs' });

    expect(Number(log.tipSeq)).toBe(1);
    expect(engine.status).toBe('refused');
  });

  it('leaves any other refusal alone', async () => {
    const { alice, session, log, socket, engine } = await game();
    relayHas(socket, log, 1);
    engine.appendLocal(alice, session.sealMove(2, nonce(2), new Uint8Array([1])));

    socket.deliver({ t: 'err', code: 'entry_too_large', detail: 'too big' });

    expect(Number(log.tipSeq)).toBe(2);
    expect(engine.status).toBe('refused');
  });
});

describe('saying hello', () => {
  it('names this device’s participant hash and where its log ends', async () => {
    const { socket, log } = await game();
    const hello = socket.of('hello')[0];

    expect(hello).toMatchObject({ v: PROTOCOL_VERSION, tipSeq: Number(log.tipSeq) });
  });
});

describe('uploading a long local history', () => {
  it('sends schema-sized batches until the relay has every entry', async () => {
    const { engine, log, socket } = await game(600);
    const expectedSizes = [256, 256, 88];

    expect(() => engine.flush()).not.toThrow();

    for (const [index, size] of expectedSizes.entries()) {
      const batch = socket.of('append')[index];
      expect(batch.entries).toHaveLength(size);

      const last = batch.entries.at(-1)!;
      const stored = log.entry(last.seq);
      expect(stored).toBeDefined();
      socket.deliver({
        t: 'appended',
        tipSeq: last.seq,
        tipHash: toBase64Url(await entryHash(stored!)),
      });
    }

    const sent = socket.of('append').flatMap((batch) => batch.entries);
    expect(sent.map((entry) => entry.seq)).toEqual(Array.from({ length: 600 }, (_, seq) => seq));
    expect(engine.pendingCount).toBe(0);
    expect(engine.status).toBe('synced');
  });
});

/**
 * Saying that someone is actually looking.
 *
 * The relay cannot otherwise tell an attentive player from a socket whose
 * device was frozen with the page open, and it used to assume the second was
 * the first — which is a turn nobody was ever told about.
 */
describe('the heartbeat', () => {
  it('sends the exact frame the relay auto-responds to', async () => {
    const { engine, socket } = await game();

    engine.heartbeat();

    // Byte-for-byte: a Durable Object's auto-response matches the request
    // string literally, so this must not depend on how a schema orders keys.
    expect(socket.frames).toContain(HEARTBEAT_REQUEST);
  });

  it('takes the answer in its stride', async () => {
    const { socket, events } = await game();

    socket.deliver({ t: 'pong' });

    // The answer carries nothing; arriving at all was the point. What must not
    // happen is the engine reporting a frame it does not understand.
    expect(events.errors).toHaveLength(0);
  });
});
