/**
 * The committed manifest, its signature, and the artifacts it describes.
 *
 * Three things have to agree or a player gets a game that will not load: the
 * manifest's hashes, the bytes actually committed under `app/static`, and the
 * constants the app pins elsewhere. Nothing here signs anything — this suite is
 * what CI runs, and CI has no key.
 */
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { beforeEach, describe, expect, it } from 'vitest';

import { DICTIONARY_EN_V1, MANIFEST_SIGNING_PUBKEY } from '@tabla/shared';

import { loadCoreFromDisk } from '../wasm/node.ts';
import { forgetManifest, manifestEntry, verifiedManifest } from './manifest.ts';
import payload from './manifest.json?raw';
import signature from './manifest.sig?raw';

const core = await loadCoreFromDisk();

const DOMAIN = 'tabla-manifest/v1';

function fromHex(hex: string): Uint8Array {
  return new Uint8Array((hex.match(/../g) ?? []).map((pair) => parseInt(pair, 16)));
}

function bytes(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

async function committed(path: string): Promise<Uint8Array> {
  return new Uint8Array(
    await readFile(fileURLToPath(new URL(`../../../static${path}`, import.meta.url))),
  );
}

beforeEach(forgetManifest);

describe('the committed manifest', () => {
  it('is signed by the key this build pins', async () => {
    await expect(verifiedManifest()).resolves.toMatchObject({ version: 1 });
  });

  it('describes the artifacts that are actually committed', async () => {
    const manifest = await verifiedManifest();

    for (const plugin of manifest.plugins) {
      for (const blob of [plugin.module, ...plugin.assets]) {
        const actual = await committed(blob.path);

        expect(actual.byteLength, `${blob.path} size`).toBe(blob.bytes);
        expect(createHash('sha256').update(actual).digest('hex'), `${blob.path} hash`).toBe(
          blob.sha256,
        );
      }
    }
  });

  it('agrees with the dictionary hash games pin in their invites', async () => {
    // Two independent pins of the same file: the invite carries one so both
    // players prove they hold the same word list, and the manifest carries the
    // other so the download can be checked. They have to name the same bytes.
    const letras = await manifestEntry('letras');
    const dictionary = letras?.assets.find((asset) => asset.id === DICTIONARY_EN_V1.id);

    expect(dictionary?.sha256).toBe(DICTIONARY_EN_V1.sha256);
    expect(dictionary?.path).toBe(DICTIONARY_EN_V1.path);
  });
});

describe('manifest verification', () => {
  it('refuses a manifest whose bytes changed after signing', () => {
    // Whitespace only: the signature covers the file verbatim, so even a change
    // that parses to the same object is a different manifest.
    expect(() =>
      core.verifyManifest(
        fromHex(MANIFEST_SIGNING_PUBKEY),
        bytes(`${payload} `),
        fromHex(signature.trim()),
      ),
    ).toThrow();
  });

  it('refuses a signature made by another key', () => {
    const impostor = new core.Identity(new Uint8Array(32).fill(0x55));
    const forged = impostor.sign(new Uint8Array([...bytes(DOMAIN), ...bytes(payload)]));

    expect(() =>
      core.verifyManifest(fromHex(MANIFEST_SIGNING_PUBKEY), bytes(payload), forged),
    ).toThrow();
    // ...and would have been accepted had the build pinned that key, which is
    // what makes the pin the load-bearing part rather than the signature.
    expect(() => core.verifyManifest(impostor.publicKey(), bytes(payload), forged)).not.toThrow();
  });

  it('refuses a signature over the payload without the domain tag', () => {
    const publisher = new core.Identity(new Uint8Array(32).fill(0x66));
    const undomained = publisher.sign(bytes(payload));

    expect(() => core.verifyManifest(publisher.publicKey(), bytes(payload), undomained)).toThrow();
  });

  it('refuses a truncated signature', () => {
    expect(() =>
      core.verifyManifest(
        fromHex(MANIFEST_SIGNING_PUBKEY),
        bytes(payload),
        fromHex(signature.trim()).slice(0, 63),
      ),
    ).toThrow(/64 bytes/);
  });

  it('matches the frozen vector the Rust side asserts', async () => {
    // Same seed, same payload, same signature as
    // `a_frozen_manifest_signature_still_verifies` in golden_crypto.rs. If the
    // two languages ever disagree about what is signed, this is where it shows.
    const publisher = new core.Identity(new Uint8Array(32).fill(0x33));
    const frozen = '{"version":1,"plugins":[]}';
    const sig = publisher.sign(new Uint8Array([...bytes(DOMAIN), ...bytes(frozen)]));

    expect([...sig].map((b) => b.toString(16).padStart(2, '0')).join('')).toBe(
      '532947e6d074027a298f761ef1da5ec42c4fa2db227f2f257046908c7a1e3e82' +
        '384cacd7418125a4dabdbba0ba3e60ead0a2deac416411063a930ed68c5c500c',
    );
    expect(() => core.verifyManifest(publisher.publicKey(), bytes(frozen), sig)).not.toThrow();
  });
});
