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
import { listContacts, listDevices, listGames, loadEntries } from './db/store.ts';
import { loadIdentity, randomBytes, replaceIdentity } from './identity.ts';
import { displayName, markOnboarded, setDisplayName } from './profile.ts';

export const BACKUP_EXTENSION = '.tabla';

/**
 * The bundle format this build writes. Mirrors `EXPORT_VERSION` in
 * `tabla-core::export`, which is what refuses a file it does not understand.
 */
const EXPORT_VERSION = 3;

/** Mirrors the Rust `GameExport`. Optional fields are `null`, never absent. */
export interface GameJson {
  game_id: number[];
  plugin_id: string;
  plugin_version: number;
  initiator_pub_key: number[];
  claimer_pub_key: number[] | null;
  blob_id: number[];
  seed: number[];
  entries: number[][];
  status: string;
  created_at: number;
  last_activity: number;
  blob_key: number[] | null;
  cancel_token: string | null;
  expires_at: number | null;
  dictionary: number[] | null;
  invited_contact: number[] | null;
  mailbox: { id: string; message_id: string } | null;
  opponent_name: string | null;
  your_turn: boolean | null;
  last_play: string | null;
  outcome: string | null;
}

/** Mirrors the Rust `ExportBundle`, which is what the WASM layer expects. */
export interface BundleJson {
  v: number;
  identity_seed: number[];
  contacts: { public_key: number[]; name: string; first_seen: number }[];
  games: GameJson[];
  exported_at: number;
  /** What this player asks to be called. Restored with the identity it names. */
  name: string;
  /** The other devices this identity plays from; see `lib/devices.ts`. */
  devices: { id: number[]; name: string; linked_at: number }[];
}

const bytes = (base64url: string) => [...fromBase64Url(base64url)];
const maybeBytes = (base64url?: string) => (base64url ? bytes(base64url) : null);
const hexBytes = (hex?: string) =>
  hex ? [...(hex.match(/../g) ?? [])].map((pair) => parseInt(pair, 16)) : null;

/** One game, in the shape the bundle wants. */
export async function gameToJson(game: GameRecord): Promise<GameJson> {
  return {
    game_id: bytes(game.gameId),
    plugin_id: game.pluginId,
    plugin_version: game.pluginVersion,
    initiator_pub_key: bytes(game.initiatorPubKey),
    claimer_pub_key: maybeBytes(game.claimerPubKey),
    blob_id: bytes(game.blobId),
    seed: bytes(game.seed),
    entries: (await loadEntries(game.gameId)).map((entry) => [...entry]),
    status: game.status,
    created_at: game.createdAt,
    last_activity: game.lastActivity,
    blob_key: maybeBytes(game.blobKey),
    cancel_token: game.cancelToken ?? null,
    expires_at: game.expiresAt ?? null,
    dictionary: hexBytes(game.dictionary),
    invited_contact: maybeBytes(game.invitedContact),
    mailbox: game.mailbox ? { id: game.mailbox.id, message_id: game.mailbox.messageId } : null,
    opponent_name: game.opponentName ?? null,
    your_turn: game.yourTurn ?? null,
    last_play: game.lastPlay ?? null,
    outcome: game.outcome ?? null,
  };
}

/**
 * Builds the encrypted backup.
 *
 * Every game goes in, including ones still waiting for someone to join: they
 * carry their own half of the link and the token that withdraws it, so a
 * restored device can go on waiting for the same person.
 */
export async function exportBackup(passphrase: string): Promise<Uint8Array> {
  const { core, identity } = await loadIdentity();

  const bundle: BundleJson = {
    v: EXPORT_VERSION,
    identity_seed: [...identity.seed()],
    name: await displayName(),
    contacts: (await listContacts()).map((contact) => ({
      public_key: bytes(contact.publicKey),
      name: contact.name,
      first_seen: contact.firstSeen,
    })),
    games: await Promise.all((await listGames()).map(gameToJson)),
    exported_at: Date.now(),
    devices: (await listDevices()).map((device) => ({
      id: [...fromBase64Url(device.id)],
      name: device.name,
      linked_at: device.linkedAt,
    })),
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
  const summary = await applyBundle(JSON.parse(core.importBundle(passphrase, file)) as BundleJson);

  // Imported here rather than at the top, because devices needs this module to
  // read a game and the pair would otherwise import each other.
  const { announce, thisDevice } = await import('./devices.ts');
  const me = await thisDevice();
  await announce({
    DeviceAdded: { id: [...fromBase64Url(me.id)], name: me.name, linked_at: me.linkedAt },
  });

  return summary;
}

/**
 * Writes a decrypted bundle into this profile and adopts its identity.
 *
 * Shared by restoring a backup and taking a device link, which differ only in
 * how the bundle arrived. Either way this device ends up as one of that
 * identity's devices rather than as its only one — which is the change from
 * when a restore was a migration and there was nothing else left to contradict.
 */
export async function applyBundle(bundle: BundleJson): Promise<ImportSummary> {
  const { core } = await loadIdentity();
  const seed = new Uint8Array(bundle.identity_seed);
  const database = await db();

  const tx = database.transaction(['games', 'entries', 'contacts', 'devices'], 'readwrite');
  const gamesStore = tx.objectStore('games');
  const entriesStore = tx.objectStore('entries');
  const contactsStore = tx.objectStore('contacts');
  const devicesStore = tx.objectStore('devices');

  const now = Date.now();
  const restoredIdentity = new core.Identity(seed);
  const mine = toBase64Url(restoredIdentity.publicKey());

  for (const game of bundle.games) {
    const gameId = toBase64Url(new Uint8Array(game.game_id));
    const initiator = toBase64Url(new Uint8Array(game.initiator_pub_key));

    await gamesStore.put(gameFromJson(game, gameId, initiator === mine, now));

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

  for (const device of bundle.devices) {
    await devicesStore.put({
      id: toBase64Url(new Uint8Array(device.id)),
      name: device.name,
      linkedAt: device.linked_at,
    });
  }

  await tx.done;
  await replaceIdentity(seed);

  // The name belongs to the identity, not to the phone it was on: a device that
  // restored everything except what it is called would go on introducing itself
  // to new opponents as nobody, and nothing would ever say so — the people it
  // had already played cached the name on their side. Empty from a backup taken
  // before names existed, which leaves the field to be filled in rather than
  // overwriting something with nothing.
  if (bundle.name) await setDisplayName(bundle.name);

  // A device that has just been handed an identity and a history has plainly
  // been introduced; asking it who it is would be absurd.
  await markOnboarded();

  return {
    games: bundle.games.length,
    contacts: bundle.contacts.length,
    publicKey: mine,
  };
}

/** Turns one bundle entry back into the record the app keeps. */
export function gameFromJson(
  game: GameJson,
  gameId: string,
  mine: boolean,
  now: number,
): GameRecord {
  const b64 = (value: number[] | null) =>
    value === null ? undefined : toBase64Url(new Uint8Array(value));

  return {
    gameId,
    blobId: toBase64Url(new Uint8Array(game.blob_id)),
    pluginId: game.plugin_id,
    pluginVersion: game.plugin_version,
    // Role follows from which key is ours, not from what the file claims.
    role: mine ? 'initiator' : 'claimer',
    initiatorPubKey: toBase64Url(new Uint8Array(game.initiator_pub_key)),
    claimerPubKey: b64(game.claimer_pub_key),
    seed: toBase64Url(new Uint8Array(game.seed)),
    status: isStatus(game.status) ? game.status : 'active',
    // Versions before 3 carried no timestamps, and wrote zero rather than
    // guessing. Now is the honest answer for those, and it keeps the list from
    // sorting a restored game to the bottom of history.
    createdAt: game.created_at || now,
    lastActivity: game.last_activity || now,
    blobKey: b64(game.blob_key),
    cancelToken: game.cancel_token ?? undefined,
    expiresAt: game.expires_at ?? undefined,
    dictionary: game.dictionary
      ? game.dictionary.map((byte) => byte.toString(16).padStart(2, '0')).join('')
      : undefined,
    invitedContact: b64(game.invited_contact),
    mailbox: game.mailbox ? { id: game.mailbox.id, messageId: game.mailbox.message_id } : undefined,
    opponentName: game.opponent_name ?? undefined,
    yourTurn: game.your_turn ?? undefined,
    lastPlay: game.last_play ?? undefined,
    outcome: game.outcome ?? undefined,
  };
}

const STATUSES = ['pending', 'active', 'finished', 'expired', 'incompatible'] as const;

function isStatus(value: string): value is GameRecord['status'] {
  return (STATUSES as readonly string[]).includes(value);
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
