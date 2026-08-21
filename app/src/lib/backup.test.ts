/**
 * The bundle shape, checked against the Rust that has to read it.
 *
 * This file exists because the two halves drifted once. The format is declared
 * in `tabla-core::export` and built here, in TypeScript, from a plain object —
 * so a field renamed on one side type-checks perfectly on the other and fails
 * only when a real backup is written. That failure surfaced ten minutes into an
 * end-to-end run, as a download that never started. It should surface here, in
 * under a second, as a decode error naming the field.
 */
import 'fake-indexeddb/auto';

import { afterEach, beforeAll, describe, expect, it } from 'vitest';

import { toBase64Url } from '@tabla/shared';

import {
  applyBundle,
  exportBackup,
  gameFromJson,
  gameToJson,
  importBackup,
  LAST_BACKUP_AT_KEY,
} from './backup.ts';
import type { BundleJson } from './backup.ts';
import { closeDatabase, resetDatabaseHandle } from './db/schema.ts';
import type { GameRecord } from './db/schema.ts';
import {
  appendEntries,
  getDealSnapshot,
  getMeta,
  listContacts,
  listDevices,
  listGames,
  listInbox,
  loadEntries,
  putDealSnapshot,
  putGame,
  putInboxItem,
  rememberContact,
  setMeta,
} from './db/store.ts';
import { thisDevice } from './devices.ts';
import { forgetIdentity, loadIdentity, myPublicKey } from './identity.ts';
import { displayName, setDisplayName } from './profile.ts';
import { REMOVED_BY, removed } from './removed.svelte.ts';
import { loadCoreFromDisk } from './wasm/node.ts';

// `loadCore` memoises, so priming it from disk is enough for everything below:
// Node's fetch cannot resolve the `file:` URL the generated glue would use.
beforeAll(async () => {
  await loadCoreFromDisk();
});

const b64 = (fill: number, length = 32) => toBase64Url(new Uint8Array(length).fill(fill));

/** A game with every optional field populated, which is the interesting case. */
function pendingGame(): GameRecord {
  return {
    gameId: b64(1, 16),
    blobId: b64(2, 16),
    blobKey: b64(3),
    cancelToken: b64(4, 16),
    expiresAt: 1_780_600_000_000,
    invitedContact: b64(5),
    mailbox: { id: b64(6, 16), messageId: b64(7, 16) },
    pluginId: 'letras',
    pluginVersion: 3,
    role: 'initiator',
    initiatorPubKey: b64(8),
    seed: b64(9),
    dictionary: 'aa'.repeat(32),
    status: 'pending',
    createdAt: 1_780_000_000_000,
    lastActivity: 1_780_000_050_000,
    opponentName: 'Pooja',
  };
}

function finishedGame(): GameRecord {
  return {
    gameId: b64(11, 16),
    blobId: b64(12, 16),
    pluginId: 'tictactoe',
    pluginVersion: 1,
    role: 'claimer',
    initiatorPubKey: b64(13),
    claimerPubKey: b64(14),
    seed: b64(15),
    status: 'finished',
    createdAt: 1_779_000_000_000,
    lastActivity: 1_779_100_000_000,
    opponentName: 'Sam',
    yourTurn: false,
    lastPlay: 'They played',
    outcome: 'You lost',
  };
}

afterEach(async () => {
  closeDatabase();
  resetDatabaseHandle();
  indexedDB.deleteDatabase('tabla');
  forgetIdentity();
  removed.by = undefined;
});

describe('the backup bundle', () => {
  it('survives a round trip through the format Rust reads', async () => {
    await loadIdentity();
    await setDisplayName('Josh');
    await putGame(pendingGame());
    await putGame(finishedGame());
    await appendEntries(
      finishedGame().gameId,
      [{ seq: 0, entry: new Uint8Array(200).fill(9) }],
      Date.now(),
    );
    await rememberContact(b64(14), 'Sam', 1_779_000_000_000);

    // Through the real Argon2id and the real postcard, because the point is
    // that the Rust side accepts what this side writes.
    const summary = await importBackup('correct horse', await exportBackup('correct horse'));

    expect(summary.games).toBe(2);
    expect(summary.contacts).toBe(1);
  });

  it('replaces identity-bound data instead of merging it with this device', async () => {
    const imported = await gameToJson(finishedGame());
    imported.entries = [[9]];
    const importedContact = b64(20);
    const importedDevice = b64(21, 16);
    const bundle: BundleJson = {
      v: 3,
      identity_seed: [...new Uint8Array(32).fill(42)],
      name: '',
      contacts: [
        {
          public_key: [...new Uint8Array(32).fill(20)],
          name: 'New contact',
          first_seen: 200,
        },
      ],
      games: [imported],
      exported_at: 300,
      devices: [{ id: [...new Uint8Array(16).fill(21)], name: 'New phone', linked_at: 250 }],
    };

    await putGame(pendingGame());
    await putGame(finishedGame());
    await appendEntries(
      finishedGame().gameId,
      [
        { seq: 0, entry: new Uint8Array([1]) },
        { seq: 1, entry: new Uint8Array([2]) },
      ],
      Date.now(),
    );
    await rememberContact(b64(22), 'Old contact', 100);
    const currentDevice = await thisDevice('Old phone');
    await putDealSnapshot({
      gameId: pendingGame().gameId,
      tipSeq: 0,
      tipHash: b64(24),
      snapshot: new Uint8Array([3]),
    });
    await putInboxItem({
      messageId: b64(25, 16),
      mailboxId: b64(26, 16),
      fromPubKey: b64(27),
      blobId: b64(28, 16),
      blobKey: b64(29),
      pluginId: 'tictactoe',
      pluginVersion: 1,
      createdAt: 100,
      receivedAt: 100,
    });
    await setDisplayName('Old identity');
    await setMeta(REMOVED_BY, b64(30, 16));
    await setMeta(LAST_BACKUP_AT_KEY, 100);
    removed.by = b64(30, 16);

    const summary = await applyBundle(bundle);

    expect((await listGames()).map((game) => game.gameId)).toEqual([finishedGame().gameId]);
    expect(await loadEntries(finishedGame().gameId)).toEqual([new Uint8Array([9])]);
    expect((await listContacts()).map((contact) => contact.publicKey)).toEqual([importedContact]);
    expect((await listDevices()).map((device) => device.id)).toEqual([importedDevice]);
    expect(await getDealSnapshot(pendingGame().gameId)).toBeUndefined();
    expect(await listInbox()).toEqual([]);
    expect(await displayName()).toBe('');
    expect(await getMeta(REMOVED_BY)).toBeUndefined();
    expect(await getMeta(LAST_BACKUP_AT_KEY)).toBeUndefined();
    expect(removed.by).toBeUndefined();
    expect(await myPublicKey()).toBe(summary.publicKey);
    expect(await thisDevice()).toMatchObject({ id: currentDevice.id, name: currentDevice.name });
  });

  it('keeps the previous profile when a replacement bundle is invalid', async () => {
    await loadIdentity();
    const previousKey = await myPublicKey();
    await setDisplayName('Old identity');
    await putGame(pendingGame());

    const invalid: BundleJson = {
      v: 3,
      identity_seed: [],
      name: 'Replacement',
      contacts: [],
      games: [],
      exported_at: 300,
      devices: [],
    };

    await expect(applyBundle(invalid)).rejects.toThrow();

    expect((await listGames()).map((game) => game.gameId)).toEqual([pendingGame().gameId]);
    expect(await displayName()).toBe('Old identity');
    expect(await myPublicKey()).toBe(previousKey);
  });

  it('carries an invitation nobody has claimed', async () => {
    // Version 2 skipped these entirely: no opponent meant nothing to restore.
    // A linked device has to arrive still waiting for the same person, which
    // means carrying the half of the link the relay never saw.
    const game = pendingGame();
    const restored = gameFromJson(await gameToJson(game), game.gameId, true, Date.now());

    expect(restored).toEqual(game);
  });

  it('keeps a finished game finished, and remembers how it ended', async () => {
    const game = finishedGame();
    const restored = gameFromJson(await gameToJson(game), game.gameId, false, Date.now());

    expect(restored).toEqual(game);
  });

  it('dates a game an older backup could not date', async () => {
    // Versions 1 and 2 wrote no timestamps, and the Rust conversion fills in
    // zero rather than inventing one. Zero would sort a restored game below
    // every game ever played, so the restoring device supplies the answer.
    const now = 1_781_000_000_000;
    const old = { ...(await gameToJson(finishedGame())), created_at: 0, last_activity: 0 };

    const restored = gameFromJson(old, 'g', false, now);
    expect(restored.createdAt).toBe(now);
    expect(restored.lastActivity).toBe(now);
  });

  it('refuses a status it does not recognise rather than storing it', async () => {
    const odd = { ...(await gameToJson(finishedGame())), status: 'abandoned' };
    expect(gameFromJson(odd, 'g', false, Date.now()).status).toBe('active');
  });

  it('declares the version the core expects', async () => {
    const { core } = await loadIdentity();
    const file = await exportBackup('pw');

    const bundle = JSON.parse(core.importBundle('pw', file)) as BundleJson;
    expect(bundle.v).toBe(3);
    expect(bundle.devices).toEqual([]);
  });
});
