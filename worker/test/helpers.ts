import { env } from 'cloudflare:test';

import {
  ENTRY_DOMAIN,
  ENTRY_GAME_ID_OFFSET,
  ENTRY_HEADER_LEN,
  ENTRY_PREV_HASH_OFFSET,
  ENTRY_SEQ_OFFSET,
  GAME_ID_LEN,
  HASH_LEN,
  SIG_LEN,
  entryHash,
  toBase64Url,
} from '@tabla/shared';

import worker from '../src/index.ts';

/** Sends a request through the Worker's own router, as a browser would. */
export async function call(path: string, init?: RequestInit): Promise<Response> {
  const request = new Request(`https://tabla.test${path}`, init);
  return worker.fetch(request, env as never);
}

export async function postJson(path: string, body: unknown): Promise<Response> {
  return call(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

export function randomBase64Url(byteLength: number): string {
  return toBase64Url(crypto.getRandomValues(new Uint8Array(byteLength)));
}

/** A plausible-looking public key and signature. The relay never checks either. */
export function fakeClaim() {
  return { claimerPubKey: randomBase64Url(32), sig: randomBase64Url(64) };
}

export function mailboxStub(mailboxId: string) {
  return env.MAILBOXES.get(env.MAILBOXES.idFromName(mailboxId));
}

export function linkStub(linkId: string) {
  return env.LINKS.get(env.LINKS.idFromName(linkId));
}

export function roomStub(gameId: string) {
  return env.GAME_ROOMS.get(env.GAME_ROOMS.idFromName(gameId));
}

/**
 * Builds a correctly framed log entry.
 *
 * The signature and author hash are filler: the relay never checks either, and
 * a test that supplied real ones would be testing the client, not the relay.
 * The framing — domain, sequence, previous hash, payload length — is real,
 * because that is the only part the relay reads.
 *
 * `app/src/lib/wasm/framing.test.ts` asserts these offsets still match what the
 * Rust core produces, so this helper cannot drift from the real format.
 */
export function makeEntry(options: {
  seq: number;
  prevHash: Uint8Array;
  gameId: Uint8Array;
  payload?: Uint8Array;
  authorHash?: Uint8Array;
}): Uint8Array {
  const payload = options.payload ?? new Uint8Array(8).fill(0xab);
  const entry = new Uint8Array(ENTRY_HEADER_LEN + payload.length + SIG_LEN);
  const view = new DataView(entry.buffer);

  entry.set(new TextEncoder().encode(ENTRY_DOMAIN), 0);
  view.setUint32(ENTRY_SEQ_OFFSET, options.seq, true);
  entry.set(options.prevHash, ENTRY_PREV_HASH_OFFSET);
  entry.set(options.gameId, ENTRY_GAME_ID_OFFSET);
  entry.set(options.authorHash ?? new Uint8Array(HASH_LEN).fill(0x01), 64);
  view.setUint32(96, payload.length, true);
  entry.set(payload, ENTRY_HEADER_LEN);
  entry.set(new Uint8Array(SIG_LEN).fill(0xee), ENTRY_HEADER_LEN + payload.length);

  return entry;
}

/** Builds a valid chain of `count` entries starting from genesis. */
export async function makeChain(gameId: Uint8Array, count: number): Promise<Uint8Array[]> {
  const entries: Uint8Array[] = [];
  let prevHash: Uint8Array = new Uint8Array(HASH_LEN);

  for (let seq = 0; seq < count; seq++) {
    const entry = makeEntry({
      seq,
      prevHash,
      gameId,
      payload: new TextEncoder().encode(`ciphertext-${seq}`),
    });
    entries.push(entry);
    prevHash = await entryHash(entry);
  }

  return entries;
}

export function gameIdBytes(label: string): Uint8Array {
  const bytes = new Uint8Array(GAME_ID_LEN);
  bytes.set(new TextEncoder().encode(label).subarray(0, GAME_ID_LEN));
  return bytes;
}

export function inviteStub(blobId: string) {
  return env.INVITES.get(env.INVITES.idFromName(blobId));
}
