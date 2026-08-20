/** Reads and writes over the local database. */
import { db } from './schema.ts';
import type {
  BlobRecord,
  ContactRecord,
  DealRecord,
  EntryRecord,
  GameRecord,
  InboxRecord,
} from './schema.ts';

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

/**
 * Forgets a game entirely: the record, its log, and its deal.
 *
 * All three in one transaction, because a log without its game record is
 * unreachable and a deal snapshot without its log is a snapshot of nothing.
 */
export async function deleteGame(gameId: string): Promise<void> {
  const database = await db();
  const tx = database.transaction(['games', 'entries', 'deals'], 'readwrite');
  await tx.objectStore('games').delete(gameId);
  await tx.objectStore('deals').delete(gameId);

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
/**
 * How many entries a game's log holds, without reading any of them.
 *
 * The list needs the log's *length* to work out whose turn it is; it has no
 * business decrypting the entries themselves, and they are the large part.
 */
export async function countEntries(gameId: string): Promise<number> {
  return (await db()).countFromIndex('entries', 'byGame', gameId);
}

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

/**
 * The last verified deal for a game, if this device has one.
 *
 * Not authoritative: the log is. This only saves re-verifying proofs that were
 * already accepted, and the caller throws it away if the tip it names is not
 * the tip it is holding.
 */
export async function getDealSnapshot(gameId: string): Promise<DealRecord | undefined> {
  return (await db()).get('deals', gameId);
}

export async function putDealSnapshot(record: DealRecord): Promise<void> {
  await (await db()).put('deals', record);
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

export async function getContact(publicKey: string): Promise<ContactRecord | undefined> {
  return (await db()).get('contacts', publicKey);
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

// -- inbox ------------------------------------------------------------------

/** Keyed by the relay's message id, so a redelivery replaces rather than doubles. */
export async function putInboxItem(item: InboxRecord): Promise<void> {
  await (await db()).put('inbox', item);
}

export async function listInbox(): Promise<InboxRecord[]> {
  const all = await (await db()).getAll('inbox');
  return all.sort((a, b) => b.createdAt - a.createdAt);
}

export async function deleteInboxItem(messageId: string): Promise<void> {
  await (await db()).delete('inbox', messageId);
}
