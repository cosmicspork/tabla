/**
 * Backup and device migration.
 *
 * The export carries every game log **and the identity keypair**. That is not a
 * convenience: without the private key the logs cannot be verified or decrypted,
 * so an export that omitted it would restore nothing at all.
 *
 * The file is encrypted under a passphrase with Argon2id. Anyone who obtains it
 * gets ciphertext; anyone who obtains it *and* the passphrase gets the identity,
 * which is the same thing as getting the phone.
 */
import { fromBase64Url, toBase64Url } from '@tabla/shared';

import { db } from './db/schema.ts';
import type { GameRecord } from './db/schema.ts';
import { listContacts, listGames, loadEntries } from './db/store.ts';
import { loadIdentity, randomBytes, replaceIdentity } from './identity.ts';
import { markOnboarded } from './profile.ts';

export const BACKUP_EXTENSION = '.tabla';

/** Mirrors the Rust `ExportBundle`, which is what the WASM layer expects. */
interface BundleJson {
  v: number;
  identity_seed: number[];
  contacts: { public_key: number[]; name: string; first_seen: number }[];
  games: {
    game_id: number[];
    plugin_id: string;
    plugin_version: number;
    initiator_pub_key: number[];
    claimer_pub_key: number[];
    blob_id: number[];
    seed: number[];
    entries: number[][];
  }[];
  exported_at: number;
}

const bytes = (base64url: string) => [...fromBase64Url(base64url)];

/**
 * Builds the encrypted backup.
 *
 * Games still waiting for someone to join are skipped: they have no opponent,
 * no key agreement, and nothing to restore.
 */
export async function exportBackup(passphrase: string): Promise<Uint8Array> {
  const { core, identity } = await loadIdentity();

  const games = (await listGames()).filter((game): game is GameRecord & { claimerPubKey: string } =>
    Boolean(game.claimerPubKey),
  );

  const bundle: BundleJson = {
    v: 1,
    identity_seed: [...identity.seed()],
    contacts: (await listContacts()).map((contact) => ({
      public_key: bytes(contact.publicKey),
      name: contact.name,
      first_seen: contact.firstSeen,
    })),
    games: await Promise.all(
      games.map(async (game) => ({
        game_id: bytes(game.gameId),
        plugin_id: game.pluginId,
        plugin_version: game.pluginVersion,
        initiator_pub_key: bytes(game.initiatorPubKey),
        claimer_pub_key: bytes(game.claimerPubKey),
        blob_id: bytes(game.blobId),
        seed: bytes(game.seed),
        entries: (await loadEntries(game.gameId)).map((entry) => [...entry]),
      })),
    ),
    exported_at: Date.now(),
  };

  return core.exportBundle(passphrase, JSON.stringify(bundle), randomBytes(16), randomBytes(24));
}

export interface ImportSummary {
  games: number;
  contacts: number;
  publicKey: string;
}

/**
 * Restores a backup into this profile.
 *
 * **This replaces the identity.** Two devices sharing one identity would both
 * be able to sign as the same player, and their logs would fork the moment both
 * moved — so an import is a migration, not a merge, and it overwrites.
 */
export async function importBackup(passphrase: string, file: Uint8Array): Promise<ImportSummary> {
  const { core } = await loadIdentity();
  const bundle = JSON.parse(core.importBundle(passphrase, file)) as BundleJson;

  const seed = new Uint8Array(bundle.identity_seed);
  const database = await db();

  const tx = database.transaction(['games', 'entries', 'contacts'], 'readwrite');
  const gamesStore = tx.objectStore('games');
  const entriesStore = tx.objectStore('entries');
  const contactsStore = tx.objectStore('contacts');

  const now = Date.now();
  const restoredIdentity = new core.Identity(seed);
  const mine = toBase64Url(restoredIdentity.publicKey());

  for (const game of bundle.games) {
    const gameId = toBase64Url(new Uint8Array(game.game_id));
    const initiator = toBase64Url(new Uint8Array(game.initiator_pub_key));
    const claimer = toBase64Url(new Uint8Array(game.claimer_pub_key));

    await gamesStore.put({
      gameId,
      blobId: toBase64Url(new Uint8Array(game.blob_id)),
      pluginId: game.plugin_id,
      pluginVersion: game.plugin_version,
      // Role follows from which key is ours, not from what the file claims.
      role: initiator === mine ? 'initiator' : 'claimer',
      initiatorPubKey: initiator,
      claimerPubKey: claimer,
      seed: toBase64Url(new Uint8Array(game.seed)),
      status: 'active',
      createdAt: now,
      lastActivity: now,
    } satisfies GameRecord);

    for (const [seq, entry] of game.entries.entries()) {
      await entriesStore.put({ gameId, seq, entry: new Uint8Array(entry) });
    }
  }

  for (const contact of bundle.contacts) {
    const publicKey = toBase64Url(new Uint8Array(contact.public_key));
    await contactsStore.put({
      publicKey,
      name: contact.name,
      firstSeen: contact.first_seen,
      lastPlayed: contact.first_seen,
    });
  }

  await tx.done;
  await replaceIdentity(seed);
  // A device that has just been handed an identity and a history has plainly
  // been introduced; asking it who it is would be absurd.
  await markOnboarded();

  return {
    games: bundle.games.length,
    contacts: bundle.contacts.length,
    publicKey: mine,
  };
}

/** Offers the backup as a download. */
export function downloadBackup(file: Uint8Array, name: string): void {
  const blob = new Blob([file as BlobPart], {
    type: 'application/octet-stream',
  });
  const url = URL.createObjectURL(blob);

  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = name;
  anchor.click();

  URL.revokeObjectURL(url);
}

export function backupFilename(): string {
  const stamp = new Date().toISOString().slice(0, 10);
  return `tabla-backup-${stamp}${BACKUP_EXTENSION}`;
}
