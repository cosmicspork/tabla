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

import { exportBackup, gameFromJson, gameToJson, importBackup } from './backup.ts';
import type { BundleJson } from './backup.ts';
import { closeDatabase, resetDatabaseHandle } from './db/schema.ts';
import type { GameRecord } from './db/schema.ts';
import { appendEntries, putGame, rememberContact } from './db/store.ts';
import { forgetIdentity, loadIdentity } from './identity.ts';
import { setDisplayName } from './profile.ts';
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
