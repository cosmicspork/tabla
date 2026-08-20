/**
 * What one person's devices tell each other through the room.
 *
 * Two things changed here when a person could have more than one device. A move
 * now reaches every other socket rather than only the opponent's, because your
 * laptop needs the move your phone just made as much as they do. And a device
 * that starts building a move can say so, so the other one does not let you
 * build it twice.
 *
 * The relay is still incurious about both: the hold body is sealed under the
 * game key, and it goes only to sockets holding the same participant hash.
 */
import { SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

import { HASH_LEN, PROTOCOL_VERSION, toBase64Url } from '@tabla/shared';
import type { ServerMessage } from '@tabla/shared';

import { gameIdBytes, makeChain } from './helpers.ts';

const ALICE = toBase64Url(new Uint8Array(HASH_LEN).fill(0xa1));
const BOB = toBase64Url(new Uint8Array(HASH_LEN).fill(0xb2));

/** A socket that keeps everything the relay said to it. */
interface Client {
  socket: WebSocket;
  received: ServerMessage[];
}

async function connect(gameId: string, keyHash: string): Promise<Client> {
  const response = await SELF.fetch(`https://tabla.test/ws/game/${gameId}`, {
    headers: { Upgrade: 'websocket' },
  });

  const socket = response.webSocket;
  if (!socket) throw new Error(`expected a websocket, got ${response.status}`);
  socket.accept();

  const client: Client = { socket, received: [] };
  socket.addEventListener('message', (event) => {
    client.received.push(JSON.parse(String(event.data)) as ServerMessage);
  });

  socket.send(JSON.stringify({ t: 'hello', v: PROTOCOL_VERSION, keyHash, tipSeq: -1, tipHash: null }));
  await settle();
  return client;
}

/** Lets queued socket work run. There is no ordering guarantee to await. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 50));

const holds = (client: Client) => client.received.filter((m) => m.t === 'hold');
const entries = (client: Client) => client.received.filter((m) => m.t === 'entries');

function room(label: string) {
  const bytes = gameIdBytes(label);
  return { gameId: toBase64Url(bytes), bytes };
}

const HELD = toBase64Url(new Uint8Array(60).fill(7));

describe('a claim on the turn', () => {
  it('reaches this player’s other device and nobody else', async () => {
    const { gameId } = room('hold-basic-0001');
    const phone = await connect(gameId, ALICE);
    const laptop = await connect(gameId, ALICE);
    const opponent = await connect(gameId, BOB);

    phone.socket.send(JSON.stringify({ t: 'hold', body: HELD, ttlMs: 120_000 }));
    await settle();

    expect(holds(laptop)).toHaveLength(1);
    expect(holds(laptop)[0]).toMatchObject({ body: HELD });
    // Which of someone's devices is thinking is not the opponent's business.
    expect(holds(opponent)).toHaveLength(0);
    // Nor is it echoed to the device that took it.
    expect(holds(phone)).toHaveLength(0);

    phone.socket.close();
    laptop.socket.close();
    opponent.socket.close();
  });

  it('is opaque to the relay', async () => {
    // The body is sealed under the game key, which the relay has never held.
    // All it can do is pass the bytes along and time them out.
    const { gameId } = room('hold-opaque-001');
    const phone = await connect(gameId, ALICE);
    const laptop = await connect(gameId, ALICE);

    phone.socket.send(JSON.stringify({ t: 'hold', body: HELD, ttlMs: 120_000 }));
    await settle();

    const forwarded = holds(laptop)[0];
    expect(forwarded).toMatchObject({ body: HELD });

    phone.socket.close();
    laptop.socket.close();
  });

  it('greets a device that opens a game already being played elsewhere', async () => {
    const { gameId } = room('hold-onhello-01');
    const phone = await connect(gameId, ALICE);
    phone.socket.send(JSON.stringify({ t: 'hold', body: HELD, ttlMs: 120_000 }));
    await settle();

    // The laptop was not connected when the hold was taken. It still needs to
    // know before it draws a board the person cannot use.
    const laptop = await connect(gameId, ALICE);
    expect(holds(laptop)).toHaveLength(1);
    expect(holds(laptop)[0]).toMatchObject({ body: HELD });

    phone.socket.close();
    laptop.socket.close();
  });

  it('is not offered to a device that opens the game after it lapsed', async () => {
    const { gameId } = room('hold-lapsed-001');
    const phone = await connect(gameId, ALICE);
    phone.socket.send(JSON.stringify({ t: 'hold', body: HELD, ttlMs: 1 }));
    await settle();

    const laptop = await connect(gameId, ALICE);
    expect(holds(laptop)).toHaveLength(0);

    phone.socket.close();
    laptop.socket.close();
  });

  it('is withdrawn when the device gives it up', async () => {
    const { gameId } = room('hold-release-01');
    const phone = await connect(gameId, ALICE);
    const laptop = await connect(gameId, ALICE);

    phone.socket.send(JSON.stringify({ t: 'hold', body: HELD, ttlMs: 120_000 }));
    await settle();
    phone.socket.send(JSON.stringify({ t: 'release' }));
    await settle();

    expect(holds(laptop)).toHaveLength(2);
    expect(holds(laptop)[1]).toMatchObject({ body: null });

    phone.socket.close();
    laptop.socket.close();
  });

  it('is ended by the move it was claiming', async () => {
    const { gameId, bytes } = room('hold-bymove-001');
    const phone = await connect(gameId, ALICE);
    const laptop = await connect(gameId, ALICE);

    phone.socket.send(JSON.stringify({ t: 'hold', body: HELD, ttlMs: 120_000 }));
    await settle();

    const chain = await makeChain(bytes, 1);
    phone.socket.send(
      JSON.stringify({
        t: 'append',
        entries: [{ seq: 0, entry: toBase64Url(chain[0]) }],
      }),
    );
    await settle();

    expect(holds(laptop).at(-1)).toMatchObject({ body: null });

    phone.socket.close();
    laptop.socket.close();
  });

  it('is refused before the socket has said who it is', async () => {
    const { gameId } = room('hold-nohello-01');
    const response = await SELF.fetch(`https://tabla.test/ws/game/${gameId}`, {
      headers: { Upgrade: 'websocket' },
    });
    const socket = response.webSocket!;
    socket.accept();

    const seen: ServerMessage[] = [];
    socket.addEventListener('message', (event) => {
      seen.push(JSON.parse(String(event.data)) as ServerMessage);
    });

    socket.send(JSON.stringify({ t: 'hold', body: HELD, ttlMs: 120_000 }));
    await settle();

    expect(seen.filter((m) => m.t === 'err')).toHaveLength(1);
    socket.close();
  });

  it('refuses to be held for longer than the ceiling', async () => {
    const { gameId } = room('hold-toolong-01');
    const phone = await connect(gameId, ALICE);

    phone.socket.send(JSON.stringify({ t: 'hold', body: HELD, ttlMs: 24 * 60 * 60 * 1000 }));
    await settle();

    expect(phone.received.filter((m) => m.t === 'err')).toHaveLength(1);
    phone.socket.close();
  });
});

describe('a move', () => {
  it('reaches this player’s own other device as well as the opponent', async () => {
    // It used to be withheld from your own sockets, on the reasoning that they
    // had written it themselves. With two devices that is no longer true.
    const { gameId, bytes } = room('hold-fanout-001');
    const phone = await connect(gameId, ALICE);
    const laptop = await connect(gameId, ALICE);
    const opponent = await connect(gameId, BOB);

    const chain = await makeChain(bytes, 1);
    phone.socket.send(
      JSON.stringify({ t: 'append', entries: [{ seq: 0, entry: toBase64Url(chain[0]) }] }),
    );
    await settle();

    expect(entries(laptop)).toHaveLength(1);
    expect(entries(opponent)).toHaveLength(1);
    // The device that wrote it already has it, and gets an ack instead.
    expect(entries(phone)).toHaveLength(0);
    expect(phone.received.filter((m) => m.t === 'appended')).toHaveLength(1);

    phone.socket.close();
    laptop.socket.close();
    opponent.socket.close();
  });

  it('does not make one person look like company to themselves', async () => {
    // Presence counts other participants, not other sockets, so a second device
    // must not read as an opponent having arrived.
    const { gameId } = room('hold-presence-1');
    const phone = await connect(gameId, ALICE);
    const laptop = await connect(gameId, ALICE);

    const latest = phone.received.filter((m) => m.t === 'presence').at(-1);
    expect(latest).toMatchObject({ others: 0 });

    phone.socket.close();
    laptop.socket.close();
  });
});
