/**
 * Creating and joining games: the invite protocol as the app performs it.
 */
import {
  BLOB_ID_LEN,
  CORE_PLUGIN_ID,
  CORE_PLUGIN_VERSION,
  GAME_ID_LEN,
  fromBase64Url,
  toBase64Url,
} from '@tabla/shared';

import { getGame, putGame, rememberContact, updateGame } from './db/store.ts';
import type { GameRecord } from './db/schema.ts';
import { loadIdentity, randomBytes } from './identity.ts';
import { requestPersistentStorage } from './lifecycle.ts';
import { claimInvite, createInvite, inviteStatus } from './relay.ts';

export interface CreatedInvite {
  game: GameRecord;
  /** The share link. Its fragment carries the key and never reaches a server. */
  link: string;
}

/**
 * Creates a game and the single-use link that invites someone into it.
 *
 * The blob key is random and lives only in the URL fragment: the relay stores a
 * blob it cannot read, and link-preview crawlers that fetch a pasted URL learn
 * nothing, because fragments are never transmitted.
 */
export async function createGame(origin: string): Promise<CreatedInvite> {
  const { core, identity } = await loadIdentity();

  const gameId = randomBytes(GAME_ID_LEN);
  const blobKey = randomBytes(32);
  const seed = randomBytes(32);
  const now = Date.now();

  const blob = core.sealInvite(
    blobKey,
    randomBytes(24),
    gameId,
    CORE_PLUGIN_ID,
    CORE_PLUGIN_VERSION,
    undefined,
    identity.publicKey(),
    seed,
    BigInt(now),
  );

  const { blobId } = await createInvite(toBase64Url(blob));

  const game: GameRecord = {
    gameId: toBase64Url(gameId),
    blobId,
    blobKey: toBase64Url(blobKey),
    pluginId: CORE_PLUGIN_ID,
    pluginVersion: CORE_PLUGIN_VERSION,
    role: 'initiator',
    initiatorPubKey: toBase64Url(identity.publicKey()),
    seed: toBase64Url(seed),
    status: 'pending',
    createdAt: now,
    lastActivity: now,
  };

  await putGame(game);

  // Now that there is something worth keeping, ask the browser not to evict it.
  // Losing this database loses the games and the identity key with them.
  await requestPersistentStorage();

  return { game, link: `${origin}/j#${blobId}.${toBase64Url(blobKey)}` };
}

/** Splits the `#<blobId>.<key>` fragment of a share link. */
export function parseInviteFragment(fragment: string): { blobId: string; key: Uint8Array } | null {
  const cleaned = fragment.startsWith('#') ? fragment.slice(1) : fragment;
  const [blobId, key] = cleaned.split('.');

  if (!blobId || !key) return null;
  try {
    const bytes = fromBase64Url(key);
    if (bytes.length !== 32 || fromBase64Url(blobId).length !== BLOB_ID_LEN) return null;
    return { blobId, key: bytes };
  } catch {
    return null;
  }
}

export type JoinResult =
  | { ok: true; game: GameRecord }
  | {
      ok: false;
      reason: 'taken' | 'expired' | 'missing' | 'incompatible' | 'malformed';
    };

/**
 * Redeems an invite link.
 *
 * The claim happens before the blob can be read, because the blob is what the
 * single-use token protects. That means an invite from an incompatible build is
 * consumed in the act of discovering it is incompatible — an unavoidable
 * consequence of not telling the relay what game is being played.
 */
export async function joinGame(fragment: string): Promise<JoinResult> {
  const parsed = parseInviteFragment(fragment);
  if (!parsed) return { ok: false, reason: 'malformed' };

  const { core, identity } = await loadIdentity();
  const { blobId, key } = parsed;

  let blob: string;
  try {
    blob = await claimInvite(
      blobId,
      toBase64Url(identity.publicKey()),
      toBase64Url(identity.signClaim(fromBase64Url(blobId))),
    );
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code === 'already_claimed') return { ok: false, reason: 'taken' };
    if (code === 'expired') return { ok: false, reason: 'expired' };
    return { ok: false, reason: 'missing' };
  }

  const invite = core.openInvite(key, fromBase64Url(blob));
  const now = Date.now();

  const game: GameRecord = {
    gameId: toBase64Url(invite.gameId),
    blobId,
    pluginId: invite.pluginId,
    pluginVersion: invite.pluginVersion,
    role: 'claimer',
    initiatorPubKey: toBase64Url(invite.initiatorPublicKey),
    claimerPubKey: toBase64Url(identity.publicKey()),
    seed: toBase64Url(invite.seed),
    status: 'active',
    createdAt: now,
    lastActivity: now,
  };

  if (!invite.isCompatible(CORE_PLUGIN_ID, CORE_PLUGIN_VERSION, undefined)) {
    await putGame({ ...game, status: 'incompatible' });
    return { ok: false, reason: 'incompatible' };
  }

  await putGame(game);
  await rememberContact(game.initiatorPubKey, 'Opponent', now);
  await requestPersistentStorage();

  return { ok: true, game };
}

/**
 * Checks whether a pending invite has been redeemed, and binds the claimer.
 *
 * The claimer's signature is verified **here**, on the initiator's device. The
 * relay stored it without checking; it is not trusted to say who anyone is.
 */
export async function refreshPendingGame(gameId: string): Promise<GameRecord | undefined> {
  const game = await getGame(gameId);
  if (!game || game.status !== 'pending') return game;

  const status = await inviteStatus(game.blobId);
  if (!status.claimed || !status.claimerPubKey || !status.sig) return game;

  const { core } = await loadIdentity();
  core.verifyClaim(
    fromBase64Url(status.claimerPubKey),
    fromBase64Url(game.blobId),
    fromBase64Url(status.sig),
  );

  const now = Date.now();
  await rememberContact(status.claimerPubKey, 'Opponent', now);

  // The blob key is dropped once the invite is spent: the link is no longer
  // usable, so keeping the key would be storing a secret for no reason.
  return updateGame(gameId, {
    claimerPubKey: status.claimerPubKey,
    status: 'active',
    blobKey: undefined,
    lastActivity: now,
  });
}
