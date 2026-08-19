/**
 * Local storage. Everything the app knows lives here and nowhere else.
 *
 * The relay holds ciphertext; this database holds the keys that make sense of
 * it. Losing it without an export loses the games, which is why the export
 * flow carries the identity seed alongside the logs.
 */
import { openDB, type DBSchema, type IDBPDatabase } from 'idb';

export const DB_NAME = 'tabla';
export const DB_VERSION = 1;

/** Which side of the invite we were on. Decides who moves first. */
export type Role = 'initiator' | 'claimer';

export type GameStatus =
  /** Invite created, nobody has redeemed the link yet. */
  | 'pending'
  /** Both identities bound; play in progress. */
  | 'active'
  /** Someone won, drew, or resigned. */
  | 'finished'
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
  outcome?: string;
}

export interface EntryRecord {
  gameId: string;
  seq: number;
  /** The encoded entry: canonical preimage followed by its signature. */
  entry: Uint8Array;
}

export interface ContactRecord {
  /** base64url Ed25519 public key. The only identifier a peer has. */
  publicKey: string;
  name: string;
  firstSeen: number;
  lastPlayed: number;
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
}

export type TablaDatabase = IDBPDatabase<TablaDB>;

let handle: Promise<TablaDatabase> | null = null;

export function db(): Promise<TablaDatabase> {
  handle ??= openDB<TablaDB>(DB_NAME, DB_VERSION, {
    upgrade(database) {
      database.createObjectStore('meta');

      const games = database.createObjectStore('games', { keyPath: 'gameId' });
      games.createIndex('byLastActivity', 'lastActivity');

      const entries = database.createObjectStore('entries', {
        keyPath: ['gameId', 'seq'],
      });
      entries.createIndex('byGame', 'gameId');

      database.createObjectStore('contacts', { keyPath: 'publicKey' });
    },
  });

  return handle;
}

/** Test seam: drops the cached connection so a fresh profile can be opened. */
export function resetDatabaseHandle(): void {
  handle = null;
}
