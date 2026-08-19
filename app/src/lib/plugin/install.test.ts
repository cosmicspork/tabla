/**
 * Downloading a game, keeping it, and giving the space back.
 *
 * The interesting cases are all failures: a download that comes back wrong, a
 * device that lost the file, a manifest this build will not trust. Each has to
 * end somewhere a player can act on, and none may end with unverified bytes in
 * the database.
 */
import 'fake-indexeddb/auto';

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { blobsForPlugin } from '../db/store.ts';
import { closeDatabase } from '../db/schema.ts';
import {
  forgetInstalled,
  installPlugin,
  installedState,
  pluginBytes,
  removePlugin,
  assetBytes,
  InstallError,
} from './install.ts';
import { forgetManifest, verifiedManifest } from './manifest.ts';
import { loadCoreFromDisk } from '../wasm/node.ts';

await loadCoreFromDisk();

const manifest = await verifiedManifest();
const letras = manifest.plugins.find((plugin) => plugin.id === 'letras')!;

/** The real committed files, so the hashes under test are the real ones. */
const files = new Map<string, Uint8Array>();
for (const file of [letras.module, ...letras.assets]) {
  files.set(
    file.path,
    new Uint8Array(
      await readFile(fileURLToPath(new URL(`../../../static${file.path}`, import.meta.url))),
    ),
  );
}

let served: (path: string) => Response;
let requests: string[] = [];

function serveTheRealFiles(path: string): Response {
  const bytes = files.get(path);
  if (!bytes) return new Response('not found', { status: 404 });

  return new Response(bytes.buffer as ArrayBuffer, { status: 200 });
}

beforeEach(async () => {
  requests = [];
  served = serveTheRealFiles;

  vi.stubGlobal('fetch', (input: string) => {
    requests.push(String(input));
    return Promise.resolve(served(String(input)));
  });

  // A fresh database per test, so "already downloaded" is never accidental.
  await wipeDatabase();
  forgetInstalled();
  forgetManifest();
});

/** Closes the connection first: a delete blocks while anything holds it open. */
async function wipeDatabase(): Promise<void> {
  await closeDatabase();

  await new Promise<void>((resolve, reject) => {
    const request = indexedDB.deleteDatabase('tabla');
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error('the database is still open somewhere'));
  });
}

afterEach(() => vi.unstubAllGlobals());

describe('downloading a game', () => {
  it('fetches the module once and keeps it', async () => {
    const bytes = await pluginBytes('letras');

    expect(createHash('sha256').update(bytes).digest('hex')).toBe(letras.module.sha256);
    expect(requests).toEqual([letras.module.path]);

    // A second page, with nothing in memory: the stored copy answers instead.
    forgetInstalled();
    expect((await pluginBytes('letras')).byteLength).toBe(letras.module.bytes);
    expect(requests).toEqual([letras.module.path]);
  });

  it('makes one request when several callers ask at once', async () => {
    await Promise.all([pluginBytes('letras'), pluginBytes('letras'), pluginBytes('letras')]);

    expect(requests).toEqual([letras.module.path]);
  });

  it('finds reference data by the hash a game pinned', async () => {
    const dictionary = letras.assets[0];
    const bytes = await assetBytes(dictionary.sha256);

    expect(createHash('sha256').update(bytes).digest('hex')).toBe(dictionary.sha256);
  });

  it('refuses a hash this build does not know', async () => {
    await expect(assetBytes('00'.repeat(32))).rejects.toMatchObject({ kind: 'unknown' });
    expect(requests).toEqual([]);
  });

  it('refuses a game this build does not offer', async () => {
    await expect(pluginBytes('chess')).rejects.toMatchObject({ kind: 'unknown' });
    expect(requests).toEqual([]);
  });
});

describe('a download that is not what was promised', () => {
  it('refuses bytes that hash to something else, and stores nothing', async () => {
    served = () => new Response(new Uint8Array([1, 2, 3]).buffer, { status: 200 });

    await expect(pluginBytes('letras')).rejects.toMatchObject({ kind: 'corrupt' });
    expect(await blobsForPlugin('letras')).toEqual([]);
  });

  it('refuses the single-page fallback, which answers 200 for anything', async () => {
    // The relay serves the app with a not-found fallback, so a path that does
    // not exist comes back as the app itself with a cheerful status. Without
    // the hash check this would surface as a baffling failure inside the
    // sandbox instead of an honest one here.
    served = () => new Response('<!doctype html><title>tabla</title>', { status: 200 });

    await expect(pluginBytes('letras')).rejects.toMatchObject({ kind: 'corrupt' });
  });

  it('reports a network failure as something waiting will fix', async () => {
    served = () => {
      throw new TypeError('Failed to fetch');
    };

    await expect(pluginBytes('letras')).rejects.toMatchObject({ kind: 'offline' });
  });

  it('reports a missing file the same way', async () => {
    served = () => new Response('gone', { status: 404 });

    await expect(pluginBytes('letras')).rejects.toMatchObject({ kind: 'offline' });
  });
});

describe('a manifest this build will not trust', () => {
  it('refuses to fetch anything at all', async () => {
    vi.resetModules();
    vi.doMock('./manifest.ts', async () => {
      const real = await vi.importActual<typeof import('./manifest.ts')>('./manifest.ts');
      return {
        ...real,
        verifiedManifest: () => Promise.reject(new real.ManifestError('signature refused')),
      };
    });

    const install = await import('./install.ts');
    await expect(install.pluginBytes('letras')).rejects.toMatchObject({ kind: 'tampered' });

    // The point of verifying first: an unsigned manifest cannot even name a
    // URL to go and ask for.
    expect(requests).toEqual([]);
    vi.doUnmock('./manifest.ts');
  });
});

describe('what a device is holding', () => {
  it('reports nothing before, and everything after', async () => {
    const before = await installedState('letras');
    expect(before).toMatchObject({ installed: false, storedBytes: 0 });
    expect(before.totalBytes).toBe(
      letras.module.bytes + letras.assets.reduce((sum, asset) => sum + asset.bytes, 0),
    );

    await installPlugin('letras');

    const after = await installedState('letras');
    expect(after.installed).toBe(true);
    expect(after.storedBytes).toBe(after.totalBytes);
  });

  it('gives the space back when a game is removed, and can fetch it again', async () => {
    await installPlugin('letras');
    await removePlugin('letras');

    expect(await blobsForPlugin('letras')).toEqual([]);
    expect(await installedState('letras')).toMatchObject({ installed: false, storedBytes: 0 });

    // Removal is not a decision a player has to be sure about.
    requests = [];
    forgetInstalled();
    await installPlugin('letras');

    expect(requests).toHaveLength(1 + letras.assets.length);
    expect(await installedState('letras')).toMatchObject({ installed: true });
  });

  it('re-downloads a file the device dropped, which is what eviction looks like', async () => {
    await installPlugin('letras');

    // iOS may evict storage for an app nobody has opened in a week. To this
    // code that is indistinguishable from never having downloaded it.
    await wipeDatabase();
    forgetInstalled();
    requests = [];

    expect((await pluginBytes('letras')).byteLength).toBe(letras.module.bytes);
    expect(requests).toEqual([letras.module.path]);
  });
});

describe('InstallError', () => {
  it('is thrown, not returned, so a caller cannot ignore it', async () => {
    served = () => new Response('gone', { status: 404 });
    await expect(pluginBytes('letras')).rejects.toBeInstanceOf(InstallError);
  });
});
