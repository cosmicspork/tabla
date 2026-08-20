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

/** Opens a socket, says hello, and waits for the relay to answer. */
async function connect(gameId: string, keyHash: string): Promise<Client> {
  const client = await raw(gameId);
  client.socket.send(
    JSON.stringify({ t: 'hello', v: PROTOCOL_VERSION, keyHash, tipSeq: -1, tipHash: null }),
  );

  await waitFor(() => client.received.some((m) => m.t === 'state'), 'the room state');
  await drain(client);
  return client;
}

/** A socket that has not said who it is. */
async function raw(gameId: string): Promise<Client> {
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
  return client;
}

/** Polls until `ready` holds, rather than sleeping for a guessed interval. */
async function waitFor(ready: () => boolean, what = 'condition'): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!ready()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/**
 * Waits until this socket has received everything already queued for it.
 *
 * A `req` for a sequence beyond the end comes back as an empty `entries`, and
 * delivery on one socket is in order, so anything the relay sent before the
 * reply has landed by the time the reply does. That is what makes asserting a
 * message *did not* arrive meaningful, and what a fixed sleep only pretends to
 * do — it passed here every time and failed on a slower machine.
 */
async function drain(client: Client): Promise<void> {
  const marker = client.received.length;
  client.socket.send(JSON.stringify({ t: 'req', fromSeq: 1_000_000 }));
  await waitFor(
    () => client.received.slice(marker).some((m) => m.t === 'entries' && m.entries.length === 0),
    'the relay to answer',
  );
}

const holds = (client: Client) => client.received.filter((m) => m.t === 'hold');
/** Real fan-out only: the empty replies `drain` provokes are not deliveries. */
const entries = (client: Client) =>
  client.received.filter((m) => m.t === 'entries' && m.entries.length > 0);
const errors = (client: Client) => client.received.filter((m) => m.t === 'err');

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
    await waitFor(() => holds(laptop).length === 1, 'the laptop to hear about the hold');

    expect(holds(laptop)[0]).toMatchObject({ body: HELD });

    // Which of someone's devices is thinking is not the opponent's business,
    // and it is not echoed to the device that took it.
    await drain(opponent);
    await drain(phone);
    expect(holds(opponent)).toHaveLength(0);
    expect(holds(phone)).toHaveLength(0);

    phone.socket.close(1000);
    laptop.socket.close(1000);
    opponent.socket.close(1000);
  });

  it('is opaque to the relay', async () => {
    // The body is sealed under the game key, which the relay has never held.
    // All it can do is pass the bytes along and time them out.
    const { gameId } = room('hold-opaque-001');
    const phone = await connect(gameId, ALICE);
    const laptop = await connect(gameId, ALICE);

    phone.socket.send(JSON.stringify({ t: 'hold', body: HELD, ttlMs: 120_000 }));
    await waitFor(() => holds(laptop).length === 1, 'the hold to be forwarded');

    const forwarded = holds(laptop)[0];
    expect(forwarded).toMatchObject({ body: HELD });

    phone.socket.close(1000);
    laptop.socket.close(1000);
  });

  it('greets a device that opens a game already being played elsewhere', async () => {
    const { gameId } = room('hold-onhello-01');
    const phone = await connect(gameId, ALICE);
    phone.socket.send(JSON.stringify({ t: 'hold', body: HELD, ttlMs: 120_000 }));
    await drain(phone);

    // The laptop was not connected when the hold was taken. It still needs to
    // know before it draws a board the person cannot use.
    const laptop = await connect(gameId, ALICE);
    expect(holds(laptop)).toHaveLength(1);
    expect(holds(laptop)[0]).toMatchObject({ body: HELD });

    phone.socket.close(1000);
    laptop.socket.close(1000);
  });

  it('is not offered to a device that opens the game after it lapsed', async () => {
    const { gameId } = room('hold-lapsed-001');
    const phone = await connect(gameId, ALICE);
    phone.socket.send(JSON.stringify({ t: 'hold', body: HELD, ttlMs: 1 }));
    await drain(phone);

    // `connect` drains, so anything hello would have sent has arrived.
    const laptop = await connect(gameId, ALICE);
    expect(holds(laptop)).toHaveLength(0);

    phone.socket.close(1000);
    laptop.socket.close(1000);
  });

  it('is withdrawn when the device gives it up', async () => {
    const { gameId } = room('hold-release-01');
    const phone = await connect(gameId, ALICE);
    const laptop = await connect(gameId, ALICE);

    phone.socket.send(JSON.stringify({ t: 'hold', body: HELD, ttlMs: 120_000 }));
    phone.socket.send(JSON.stringify({ t: 'release' }));
    await waitFor(() => holds(laptop).length === 2, 'the hold and its withdrawal');

    expect(holds(laptop)[1]).toMatchObject({ body: null });

    phone.socket.close(1000);
    laptop.socket.close(1000);
  });

  it('is ended by the move it was claiming', async () => {
    const { gameId, bytes } = room('hold-bymove-001');
    const phone = await connect(gameId, ALICE);
    const laptop = await connect(gameId, ALICE);

    phone.socket.send(JSON.stringify({ t: 'hold', body: HELD, ttlMs: 120_000 }));

    const chain = await makeChain(bytes, 1);
    phone.socket.send(
      JSON.stringify({
        t: 'append',
        entries: [{ seq: 0, entry: toBase64Url(chain[0]) }],
      }),
    );
    await waitFor(() => holds(laptop).length === 2, 'the hold to be cleared by the move');

    expect(holds(laptop).at(-1)).toMatchObject({ body: null });

    phone.socket.close(1000);
    laptop.socket.close(1000);
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
    await waitFor(() => seen.some((m) => m.t === 'err'), 'a refusal');

    socket.close(1000);
  });

  it('refuses to be held for longer than the ceiling', async () => {
    const { gameId } = room('hold-toolong-01');
    const phone = await connect(gameId, ALICE);

    phone.socket.send(JSON.stringify({ t: 'hold', body: HELD, ttlMs: 24 * 60 * 60 * 1000 }));
    await waitFor(() => errors(phone).length === 1, 'a refusal');
    phone.socket.close(1000);
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
    await waitFor(
      () => entries(laptop).length === 1 && entries(opponent).length === 1,
      'both other sockets to receive the move',
    );

    // The device that wrote it already has it, and gets an ack instead.
    await drain(phone);
    expect(entries(phone)).toHaveLength(0);
    expect(phone.received.filter((m) => m.t === 'appended')).toHaveLength(1);

    phone.socket.close(1000);
    laptop.socket.close(1000);
    opponent.socket.close(1000);
  });

  it('does not make one person look like company to themselves', async () => {
    // Presence counts other participants, not other sockets, so a second device
    // must not read as an opponent having arrived.
    const { gameId } = room('hold-presence-1');
    const phone = await connect(gameId, ALICE);
    const laptop = await connect(gameId, ALICE);

    await drain(phone);
    const latest = phone.received.filter((m) => m.t === 'presence').at(-1);
    expect(latest).toMatchObject({ others: 0 });

    phone.socket.close(1000);
    laptop.socket.close(1000);
  });
});
