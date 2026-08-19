/**
 * The only part of a log entry the relay is permitted to understand.
 *
 * The relay reads an entry's **framing** — its sequence number and the hash of
 * the entry before it — and computes an entry's hash. It never touches the
 * payload, which is ciphertext, and it holds no key with which it could.
 *
 * This much is needed for two jobs, and no more:
 *
 * 1. Rejecting an append that does not continue the log the relay already
 *    holds, so a buggy or racing client cannot corrupt the shared copy.
 * 2. Writing an accurate tombstone when a game is evicted. The relay computes
 *    the tip hash itself rather than believing a client, because a client that
 *    supplied a hash for a history that never existed could permanently block
 *    its opponent from restoring the game.
 *
 * These offsets mirror `rust/crates/tabla-core/src/log.rs`. A test in the app
 * suite asserts they still agree with what the Rust core produces, so drift
 * fails loudly rather than silently corrupting stored games.
 */
import { HASH_LEN, SIG_LEN } from './constants.js';

/** ASCII domain tag every entry starts with. */
export const ENTRY_DOMAIN = 'tabla-log/v1';
const DOMAIN_LEN = ENTRY_DOMAIN.length; // 12

export const ENTRY_SEQ_OFFSET = DOMAIN_LEN; // 12
export const ENTRY_PREV_HASH_OFFSET = ENTRY_SEQ_OFFSET + 4; // 16
export const ENTRY_GAME_ID_OFFSET = ENTRY_PREV_HASH_OFFSET + HASH_LEN; // 48
/** Fixed part of an entry, before the variable-length payload. */
export const ENTRY_HEADER_LEN = 100;
export const MIN_ENTRY_LEN = ENTRY_HEADER_LEN + SIG_LEN;

export class FramingError extends Error {}

function check(entry: Uint8Array): void {
  if (entry.length < MIN_ENTRY_LEN) {
    throw new FramingError(`entry is ${entry.length} bytes, minimum is ${MIN_ENTRY_LEN}`);
  }
}

/** Sequence number, little-endian, as written by the Rust core. */
export function entrySeq(entry: Uint8Array): number {
  check(entry);
  return new DataView(entry.buffer, entry.byteOffset).getUint32(ENTRY_SEQ_OFFSET, true);
}

/** The hash this entry claims its predecessor had. */
export function entryPrevHash(entry: Uint8Array): Uint8Array {
  check(entry);
  return entry.slice(ENTRY_PREV_HASH_OFFSET, ENTRY_PREV_HASH_OFFSET + HASH_LEN);
}

/**
 * An entry's hash: SHA-256 over everything except the trailing signature.
 *
 * A signature cannot cover itself, so the signed preimage is the entry minus
 * its last 64 bytes — which is exactly what the chain hashes.
 */
export async function entryHash(entry: Uint8Array): Promise<Uint8Array> {
  check(entry);
  // Copied rather than sub-viewed so the buffer is definitely an ArrayBuffer,
  // which is what `crypto.subtle` accepts.
  const preimage = new Uint8Array(entry.subarray(0, entry.length - SIG_LEN));
  return new Uint8Array(await crypto.subtle.digest('SHA-256', preimage));
}

/** The all-zero hash that sequence 0 carries. */
export function isGenesisPrevHash(prevHash: Uint8Array): boolean {
  return prevHash.length === HASH_LEN && prevHash.every((b) => b === 0);
}
