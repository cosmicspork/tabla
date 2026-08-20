/**
 * Local storage. Everything the app knows lives here and nowhere else.
 *
 * The relay holds ciphertext; this database holds the keys that make sense of
 * it. Losing it without an export loses the games, which is why the export
 * flow carries the identity seed alongside the logs.
 */
import { openDB, type DBSchema, type IDBPDatabase } from 'idb';

export const DB_NAME = 'tabla';
export const DB_VERSION = 3;

/** Which side of the invite we were on. Decides who moves first. */
export type Role = 'initiator' | 'claimer';

export type GameStatus =
  /** Invite created, nobody has redeemed the link yet. */
  | 'pending'
  /** Both identities bound; play in progress. */
  | 'active'
  /** Someone won, drew, or resigned. */
  | 'finished'
  /** The invite was never redeemed, and the relay has since dropped it. */
  | 'expired'
  /** Claimed by a peer whose build cannot play this game. */
  | 'incompatible';

export interface GameRecord {
  /** base64url, 16 bytes. Also names the relay's room. */
  gameId: string;
  /** base64url, 16 bytes. Part of the key derivation salt. */
  blobId: string;
  /**
   * The invite blob key, base64url. Kept only while the invite is pending so
   * the share link can be shown again; cleared once the game is claimed.
   */
  blobKey?: string;
  /**
   * When the relay will drop an unredeemed invite, from the relay's own clock.
   *
   * Kept so the list can say how long is left without asking, and so an invite
   * that has gone can be told apart from one nobody has opened yet.
   */
  expiresAt?: number;
  /**
   * Bearer token that authorises withdrawing this invite.
   *
   * Kept for as long as the invite is unclaimed, and dropped with the blob key
   * the moment it is spent — it authorises nothing after that, so keeping it
   * would be storing a secret for no reason.
   */
  cancelToken?: string;
  /**
   * The contact this invite was addressed to, when it was made from the list.
   *
   * Kept so the claim can be checked against it: the link is a bearer token, so
   * intending to invite one person is no guarantee about who opens it.
   */
  invitedContact?: string;
  pluginId: string;
  pluginVersion: number;
  role: Role;
  /** base64url public keys. The claimer's is unknown until the invite is taken. */
  initiatorPubKey: string;
  claimerPubKey?: string;
  /**
   * Entropy handed to the plugin's setup.
   *
   * For most games this is the value the invite carried, identical on both
   * devices. A game with hidden state instead derives its own from the identity
   * key, so the two players hold different secrets — which is what stops either
   * of them working out the other's tiles. See `registry.ts`.
   */
  seed: string;
  /** Hex hash of the word list this game agreed to, for games that read one. */
  dictionary?: string;
  status: GameStatus;
  createdAt: number;
  lastActivity: number;
  /** Cached for the game list, so it renders without decrypting everything. */
  opponentName?: string;
  /**
   * Whose move it is, as of the last time this game was open.
   *
   * The list is sorted by it, and working it out properly means replaying a log
   * through the rules — far too much to do for every row on every render. It is
   * written when the board renders, and recomputed from the log's shape when a
   * game has not been opened since this field existed.
   */
  yourTurn?: boolean;
  /** One line of what happened last: "They played ZEBRA for 48". */
  lastPlay?: string;
  outcome?: string;
}

export interface EntryRecord {
  gameId: string;
  seq: number;
  /** The encoded entry: canonical preimage followed by its signature. */
  entry: Uint8Array;
}

/**
 * A verified file this device has downloaded: a plugin module, or the reference
 * data one reads.
 *
 * Keyed by hash, because that is what the manifest pins and what a lookup
 * actually asks for. Kept here rather than in a cache because these have to
 * survive an app update — the service worker drops its caches on every new
 * version — and because a player who removes a game should get the space back,
 * which a shared cache cannot promise.
 */
export interface BlobRecord {
  /** Hex SHA-256 of `bytes`, checked before this row was ever written. */
  sha256: string;
  /**
   * Which manifest entry brought it in, as `id@version`.
   *
   * Versioned because two versions of one game are separate downloads that may
   * share reference data — the word list is the same bytes under both — and
   * removing one must not take the other's data with it.
   */
  pluginId: string;
  kind: 'module' | 'asset';
  bytes: Uint8Array;
  storedAt: number;
}

export interface ContactRecord {
  /** base64url Ed25519 public key. The only identifier a peer has. */
  publicKey: string;
  name: string;
  firstSeen: number;
  lastPlayed: number;
}

/**
 * A verified deal, written down so reopening a game need not re-verify its log.
 *
 * Only meaningful against the log it was taken from, which is why the tip it
 * belongs to is stored beside it. A mismatch is not an error — it just costs a
 * re-verify, which is the correct price for a log that has changed underneath.
 */
export interface DealRecord {
  gameId: string;
  /** The highest sequence this snapshot accounts for. */
  tipSeq: number;
  /** base64url hash of the log at that sequence. */
  tipHash: string;
  snapshot: Uint8Array;
}

interface TablaDB extends DBSchema {
  meta: {
    key: string;
    value: unknown;
  };
  games: {
    key: string;
    value: GameRecord;
    indexes: { byLastActivity: number };
  };
  entries: {
    key: [string, number];
    value: EntryRecord;
    indexes: { byGame: string };
  };
  contacts: {
    key: string;
    value: ContactRecord;
  };
  blobs: {
    key: string;
    value: BlobRecord;
    indexes: { byPlugin: string };
  };
  deals: {
    key: string;
    value: DealRecord;
  };
}

export type TablaDatabase = IDBPDatabase<TablaDB>;

let handle: Promise<TablaDatabase> | null = null;

export function db(): Promise<TablaDatabase> {
  handle ??= openDB<TablaDB>(DB_NAME, DB_VERSION, {
    // Every store is created only if it is missing, so this one callback
    // upgrades a database at any earlier version as well as building a new one.
    // Stores hold what a player cannot get back — games and the identity key —
    // so an upgrade must never be a rebuild.
    upgrade(database) {
      if (!database.objectStoreNames.contains('meta')) {
        database.createObjectStore('meta');
      }

      if (!database.objectStoreNames.contains('games')) {
        const games = database.createObjectStore('games', { keyPath: 'gameId' });
        games.createIndex('byLastActivity', 'lastActivity');
      }

      if (!database.objectStoreNames.contains('entries')) {
        const entries = database.createObjectStore('entries', {
          keyPath: ['gameId', 'seq'],
        });
        entries.createIndex('byGame', 'gameId');
      }

      if (!database.objectStoreNames.contains('contacts')) {
        database.createObjectStore('contacts', { keyPath: 'publicKey' });
      }

      if (!database.objectStoreNames.contains('blobs')) {
        const blobs = database.createObjectStore('blobs', { keyPath: 'sha256' });
        blobs.createIndex('byPlugin', 'pluginId');
      }

      if (!database.objectStoreNames.contains('deals')) {
        database.createObjectStore('deals', { keyPath: 'gameId' });
      }
    },
  });

  return handle;
}

/** Test seam: drops the cached connection so a fresh profile can be opened. */
export function resetDatabaseHandle(): void {
  handle = null;
}

/**
 * Test seam: closes the connection as well as dropping it.
 *
 * Deleting a database blocks for as long as anything still holds it open, so a
 * test that wants a clean profile has to close first or wait forever.
 */
export async function closeDatabase(): Promise<void> {
  const open = handle;
  handle = null;
  if (open) (await open).close();
}
