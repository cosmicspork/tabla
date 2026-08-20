/**
 * Downloading, verifying, and keeping the files a downloadable game needs.
 *
 * Two kinds of file arrive this way: the rules module itself, and the bulk
 * reference data it reads. Both follow the same path — look in memory, then in
 * the database, and only then fetch — and both end at the same check: the bytes
 * hash to what the signed manifest pinned, or they are thrown away.
 *
 * That check is not a formality. The app is served with a single-page fallback,
 * so a mistyped path comes back as `index.html` with a cheerful 200; and the
 * whole point of a downloadable module is that its bytes were not built here.
 *
 * Files are kept in the database rather than a cache. A cache is wiped whenever
 * a new version of the app activates, which would mean re-downloading a game on
 * every release, and a cache cannot promise a player that removing a game
 * actually gave them the space back. A miss — an eviction on a device short of
 * room, a player who removed the game and came back — is just a fetch again.
 */
import { blobsForPlugin, deleteBlobs, getBlob, putBlob } from '../db/store.ts';
import {
  verifiedManifest,
  ManifestError,
  type ManifestBlob,
  type ManifestPlugin,
} from './manifest.ts';

export class InstallError extends Error {
  constructor(
    message: string,
    readonly kind: 'unknown' | 'offline' | 'corrupt' | 'tampered',
  ) {
    super(message);
  }
}

/** Bytes already in hand, for the life of the page. */
const memory = new Map<string, Uint8Array>();
/** In-flight fetches, so a burst of renders makes one request. */
const pending = new Map<string, Promise<Uint8Array>>();

/**
 * How a downloaded file is tagged with the game version it belongs to.
 *
 * Two versions of one game are separate downloads with separate modules, and
 * they may share reference data — the word list is the same bytes under both.
 * Keying by id alone would make removing one take the other's data with it.
 */
export function pluginKey(pluginId: string, version: number): string {
  return `${pluginId}@${version}`;
}

/** What one downloadable game costs and how much of it this device holds. */
export interface InstalledState {
  pluginId: string;
  version: number;
  /** True once every file the manifest lists is present. */
  installed: boolean;
  storedBytes: number;
  totalBytes: number;
}

/**
 * The rules module for a plugin, downloading it if this device lacks it.
 *
 * This is what the sandbox is given when it reports a module missing: it cannot
 * fetch anything itself, so the main thread fetches, checks, and passes bytes
 * in.
 */
export async function pluginBytes(pluginId: string, version: number): Promise<Uint8Array> {
  const entry = await entryFor(pluginId, version);
  return bytesFor(entry.module, pluginKey(pluginId, version), 'module');
}

/**
 * Reference data by the hash a game pinned, downloading it if needed.
 *
 * Games name their word list by hash rather than by plugin, because the pin in
 * the invite is a hash — two games could agree on the same list, and a game
 * agreed to one list for its whole life even if the app later ships another.
 */
export async function assetBytes(sha256: string): Promise<Uint8Array> {
  const manifest = await verifiedManifest();

  for (const plugin of manifest.plugins) {
    const asset = plugin.assets.find((candidate) => candidate.sha256 === sha256);
    if (asset) return bytesFor(asset, pluginKey(plugin.id, plugin.version), 'asset');
  }

  throw new InstallError('This game uses data this version of tabla does not have.', 'unknown');
}

/** Fetches everything a game needs, so play does not stop halfway. */
export async function installPlugin(pluginId: string, version: number): Promise<void> {
  const entry = await entryFor(pluginId, version);
  const key = pluginKey(pluginId, version);

  await bytesFor(entry.module, key, 'module');
  for (const asset of entry.assets) await bytesFor(asset, key, 'asset');
}

export async function installedState(pluginId: string, version: number): Promise<InstalledState> {
  const entry = await entryFor(pluginId, version);
  const files = [entry.module, ...entry.assets];

  // By hash, not by which version fetched it. Two versions of a game share
  // their word list, and whichever downloaded it first owns the row — but the
  // bytes are there for both, which is the only question being asked here.
  const present = await Promise.all(files.map((file) => getBlob(file.sha256)));
  const stored = files.filter((_, index) => present[index] !== undefined);

  return {
    pluginId,
    version,
    installed: stored.length === files.length,
    storedBytes: stored.reduce((total, file) => total + file.bytes, 0),
    totalBytes: files.reduce((total, file) => total + file.bytes, 0),
  };
}

/**
 * How much of this device a game is using, across every version of it.
 *
 * Counted by distinct file, not by summing the per-version states: two
 * versions of one game share a word list, and adding their sizes together
 * would report half a megabyte that does not exist and promise space that
 * removing the game could not give back.
 */
export async function storedBytesForGame(pluginId: string, versions: number[]): Promise<number> {
  const entries = await Promise.all(
    versions.map((version) => entryFor(pluginId, version).catch(() => null)),
  );

  const files = new Map<string, number>();
  for (const entry of entries) {
    if (!entry) continue;
    for (const file of [entry.module, ...entry.assets]) files.set(file.sha256, file.bytes);
  }

  const hashes = [...files.keys()];
  const present = await Promise.all(hashes.map((hash) => getBlob(hash)));

  return hashes.reduce(
    (total, hash, index) => total + (present[index] === undefined ? 0 : (files.get(hash) ?? 0)),
    0,
  );
}

/**
 * Frees everything downloaded for a game.
 *
 * Safe at any time: a game that needs it again downloads it again. Files
 * another installed game also needs are left alone — nothing shares one today,
 * but writing it this way means the first shared word list is not a bug.
 */
export async function removePlugin(pluginId: string, version: number): Promise<void> {
  const manifest = await verifiedManifest();
  const key = pluginKey(pluginId, version);
  const mine = await blobsForPlugin(key);

  const shared = new Set<string>();
  for (const plugin of manifest.plugins) {
    const other = pluginKey(plugin.id, plugin.version);
    if (other === key) continue;
    if ((await blobsForPlugin(other)).length === 0) continue;
    for (const file of [plugin.module, ...plugin.assets]) shared.add(file.sha256);
  }

  const removing = mine.filter((row) => !shared.has(row.sha256));
  await deleteBlobs(removing.map((row) => row.sha256));
  for (const row of removing) memory.delete(row.sha256);

  // Older versions of this app cached these over the network. Nothing depends
  // on the sweep working, but a player who asked for the space should get it.
  await evictFromCaches(
    manifest.plugins.filter((plugin) => plugin.id === pluginId && plugin.version === version),
  );
}

async function entryFor(pluginId: string, version: number): Promise<ManifestPlugin> {
  let manifest;

  try {
    manifest = await verifiedManifest();
  } catch (error) {
    if (error instanceof ManifestError) {
      throw new InstallError(error.message, 'tampered');
    }
    throw error;
  }

  const entry = manifest.plugins.find(
    (plugin) => plugin.id === pluginId && plugin.version === version,
  );
  if (!entry) {
    throw new InstallError(`This version of tabla does not offer ${pluginId}.`, 'unknown');
  }

  return entry;
}

async function bytesFor(
  file: ManifestBlob,
  owner: string,
  kind: 'module' | 'asset',
): Promise<Uint8Array> {
  const already = memory.get(file.sha256);
  if (already) return already;

  const inFlight = pending.get(file.sha256);
  if (inFlight) return inFlight;

  const work = obtain(file, owner, kind).finally(() => pending.delete(file.sha256));
  pending.set(file.sha256, work);
  return work;
}

async function obtain(
  file: ManifestBlob,
  owner: string,
  kind: 'module' | 'asset',
): Promise<Uint8Array> {
  const stored = await getBlob(file.sha256);
  if (stored) {
    memory.set(file.sha256, stored.bytes);
    return stored.bytes;
  }

  const bytes = await download(file);

  if ((await sha256Hex(bytes)) !== file.sha256) {
    throw new InstallError(
      'What came back is not what this version of tabla expected. Try again later.',
      'corrupt',
    );
  }

  await putBlob({ sha256: file.sha256, pluginId: owner, kind, bytes, storedAt: Date.now() });
  memory.set(file.sha256, bytes);
  return bytes;
}

async function download(file: ManifestBlob): Promise<Uint8Array> {
  try {
    const response = await fetch(file.path);
    if (!response.ok) {
      throw new InstallError(`${file.path} returned ${response.status}`, 'offline');
    }
    return new Uint8Array(await response.arrayBuffer());
  } catch (error) {
    if (error instanceof InstallError) throw error;
    throw new InstallError(
      'This game needs a one-time download and could not reach the network. It works offline once it has been downloaded.',
      'offline',
    );
  }
}

async function evictFromCaches(plugins: ManifestPlugin[]): Promise<void> {
  if (typeof caches === 'undefined') return;

  try {
    const names = await caches.keys();
    for (const name of names) {
      const cache = await caches.open(name);
      for (const plugin of plugins) {
        for (const file of [plugin.module, ...plugin.assets]) await cache.delete(file.path);
      }
    }
  } catch {
    // Best effort: the database is where these live, and it has been cleared.
  }
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  // A fresh copy: `digest` wants a plain ArrayBuffer, and a view into a larger
  // one would hash the wrong bytes.
  const copy = new Uint8Array(bytes);
  const digest = await crypto.subtle.digest('SHA-256', copy.buffer as ArrayBuffer);

  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Test seam: forgets what this page has in hand, not what is stored. */
export function forgetInstalled(): void {
  memory.clear();
  pending.clear();
}
