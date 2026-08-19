/**
 * The installation's identity.
 *
 * Generated once, on first run, and kept in IndexedDB. There is no account and
 * no server-side identity: to a peer, you are a public key they have met.
 */
import { toBase64Url } from '@tabla/shared';

import { getMeta, setMeta } from './db/store.ts';
import { loadCore, type CoreModule, type Identity } from './wasm/core.ts';

const SEED_KEY = 'identitySeed';

let cached: { core: CoreModule; identity: Identity } | null = null;

/** Cryptographically random bytes. The Rust core never generates its own. */
export function randomBytes(length: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(length));
}

/**
 * Loads the identity, creating one on first run.
 *
 * The seed is stored as raw bytes rather than a non-extractable `CryptoKey`,
 * because backup and device migration have to be able to export it — a key that
 * cannot leave the device would strand every game on it. See ARCHITECTURE.md.
 */
export async function loadIdentity(): Promise<{ core: CoreModule; identity: Identity }> {
  if (cached) return cached;

  const core = await loadCore();

  let seed = await getMeta<Uint8Array>(SEED_KEY);
  if (!seed || seed.length !== 32) {
    seed = randomBytes(32);
    await setMeta(SEED_KEY, seed);
  }

  cached = { core, identity: new core.Identity(seed) };
  return cached;
}

/** Replaces the identity, as an import from a backup does. */
export async function replaceIdentity(seed: Uint8Array): Promise<void> {
  await setMeta(SEED_KEY, seed);
  cached = null;
}

export async function myPublicKey(): Promise<string> {
  const { identity } = await loadIdentity();
  return toBase64Url(identity.publicKey());
}

/**
 * A short, readable form of a public key, for confirming out of band that you
 * are playing the person you think you are.
 */
export function fingerprint(publicKeyBase64Url: string): string {
  return (publicKeyBase64Url.match(/.{1,4}/g) ?? []).slice(0, 4).join(' ');
}

/** Test seam. */
export function forgetIdentity(): void {
  cached = null;
}
