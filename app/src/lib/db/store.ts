/** Reads and writes over the local database. */
import { db } from './schema.ts';
import type { BlobRecord, ContactRecord, EntryRecord, GameRecord } from './schema.ts';

// -- meta -------------------------------------------------------------------

export async function getMeta<T>(key: string): Promise<T | undefined> {
  return (await db()).get('meta', key) as Promise<T | undefined>;
}

export async function setMeta(key: string, value: unknown): Promise<void> {
  await (await db()).put('meta', value, key);
}

// -- games ------------------------------------------------------------------

export async function putGame(game: GameRecord): Promise<void> {
  await (await db()).put('games', game);
}

export async function getGame(gameId: string): Promise<GameRecord | undefined> {
  return (await db()).get('games', gameId);
}

/** Most recently active first, which is the order the game list wants. */
export async function listGames(): Promise<GameRecord[]> {
  const all = await (await db()).getAllFromIndex('games', 'byLastActivity');
  return all.reverse();
}

export async function updateGame(
  gameId: string,
  patch: Partial<GameRecord>,
): Promise<GameRecord | undefined> {
  const database = await db();
  const existing = await database.get('games', gameId);
  if (!existing) return undefined;

  const updated = { ...existing, ...patch };
  await database.put('games', updated);
  return updated;
}

export async function deleteGame(gameId: string): Promise<void> {
  const database = await db();
  const tx = database.transaction(['games', 'entries'], 'readwrite');
  await tx.objectStore('games').delete(gameId);

  const entries = tx.objectStore('entries').index('byGame');
  for await (const cursor of entries.iterate(gameId)) await cursor.delete();

  await tx.done;
}

// -- entries ----------------------------------------------------------------

/**
 * Persists entries and stamps the game's activity time.
 *
 * Written in one transaction so a log and its game record cannot disagree about
 * how far the game has got.
 */
export async function appendEntries(
  gameId: string,
  entries: { seq: number; entry: Uint8Array }[],
  now: number,
): Promise<void> {
  if (entries.length === 0) return;

  const database = await db();
  const tx = database.transaction(['entries', 'games'], 'readwrite');
  const store = tx.objectStore('entries');

  for (const { seq, entry } of entries) {
    await store.put({ gameId, seq, entry } satisfies EntryRecord);
  }

  const games = tx.objectStore('games');
  const game = await games.get(gameId);
  if (game) await games.put({ ...game, lastActivity: now });

  await tx.done;
}

/** Every stored entry for a game, in sequence order. */
export async function loadEntries(gameId: string): Promise<Uint8Array[]> {
  const rows = await (await db()).getAllFromIndex('entries', 'byGame', gameId);
  return rows.toSorted((a, b) => a.seq - b.seq).map((row) => row.entry);
}

// -- blobs ------------------------------------------------------------------

/** A downloaded file by hash, or nothing if this device does not hold it. */
export async function getBlob(sha256: string): Promise<BlobRecord | undefined> {
  return (await db()).get('blobs', sha256);
}

export async function putBlob(record: BlobRecord): Promise<void> {
  await (await db()).put('blobs', record);
}

/** Everything downloaded on behalf of one plugin. */
export async function blobsForPlugin(pluginId: string): Promise<BlobRecord[]> {
  return (await db()).getAllFromIndex('blobs', 'byPlugin', pluginId);
}

export async function deleteBlobs(hashes: string[]): Promise<void> {
  if (hashes.length === 0) return;

  const database = await db();
  const tx = database.transaction('blobs', 'readwrite');
  for (const hash of hashes) await tx.store.delete(hash);
  await tx.done;
}

// -- contacts ---------------------------------------------------------------

/**
 * Remembers a peer after a completed handshake.
 *
 * This is what turns invite links into a bootstrap rather than the ongoing
 * flow: the second game with the same person starts from a contact picker.
 */
export async function rememberContact(publicKey: string, name: string, now: number): Promise<void> {
  const database = await db();
  const existing = await database.get('contacts', publicKey);

  await database.put('contacts', {
    publicKey,
    name: existing?.name ?? name,
    firstSeen: existing?.firstSeen ?? now,
    lastPlayed: now,
  } satisfies ContactRecord);
}

export async function listContacts(): Promise<ContactRecord[]> {
  const all = await (await db()).getAll('contacts');
  return all.toSorted((a, b) => b.lastPlayed - a.lastPlayed);
}

export async function renameContact(publicKey: string, name: string): Promise<void> {
  const database = await db();
  const existing = await database.get('contacts', publicKey);
  if (existing) await database.put('contacts', { ...existing, name });
}
