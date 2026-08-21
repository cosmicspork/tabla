/**
 * Creating and joining games: the invite protocol as the app performs it.
 */
import {
  BLOB_ID_LEN,
  CORE_PLUGIN_ID,
  GAME_ID_LEN,
  fromBase64Url,
  toBase64Url,
} from '@tabla/shared';

import { deleteGame, getGame, putGame, rememberContact, updateGame } from './db/store.ts';
import type { GameRecord } from './db/schema.ts';
import { announceContact, announceGame, announceGameGone } from './devices.ts';
import { loadIdentity, randomBytes } from './identity.ts';
import { displayName, markOnboarded, PLACEHOLDER_NAME } from './profile.ts';
import { requestPersistentStorage } from './lifecycle.ts';
import { gameEntry, latestGame } from './registry.ts';
import { cancelInvite, claimInvite, createInvite, inviteStatus, RelayError } from './relay.ts';

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
 *
 * The invite names the game, its rules version, and — for a game that reads a
 * word list — which word list. All three have to match on the other side or the
 * two clients would be playing subtly different games; the check is in
 * `isCompatible`, and it is why the claimer can refuse before playing a move.
 */
export async function createGame(
  origin: string,
  pluginId: string = CORE_PLUGIN_ID,
  version?: number,
  /**
   * Who this invite is meant for, when it was made from the contact list.
   *
   * An intention rather than a fact: the link is a bearer token, and whoever
   * opens it first becomes the opponent whatever was intended. It is recorded
   * so the game can be named straight away, and checked against the key that
   * actually claims it — see `refreshPendingGame`.
   */
  invitee?: { publicKey: string; name: string },
): Promise<CreatedInvite> {
  // New games take the newest rules this build has. A version can be named
  // explicitly, which is how a test pins itself to rules that have since been
  // replaced.
  const entry = version === undefined ? latestGame(pluginId) : gameEntry(pluginId, version);
  if (!entry) throw new Error(`unknown game: ${pluginId}`);

  const { core, identity } = await loadIdentity();

  const gameId = randomBytes(GAME_ID_LEN);
  const blobKey = randomBytes(32);
  const dictionary = entry.dictionary ? fromHex(entry.dictionary) : undefined;
  const now = Date.now();

  // A game with hidden state derives its own entropy per device, so that
  // neither player can work out the other's tiles. The invite's seed is only
  // for games where both sides may hold the same value.
  const seed = entry.seed === 'draw' ? identity.deriveDrawSeed(gameId) : randomBytes(32);

  const blob = core.sealInvite(
    blobKey,
    randomBytes(24),
    gameId,
    entry.id,
    entry.version,
    dictionary,
    identity.publicKey(),
    entry.seed === 'draw' ? randomBytes(32) : seed,
    BigInt(now),
    // Sealed with everything else, so the relay holding this blob learns no
    // more from it than it did before there were names.
    await displayName(),
  );

  const { blobId, expiresAt, cancelToken } = await createInvite(toBase64Url(blob));

  const game: GameRecord = {
    gameId: toBase64Url(gameId),
    blobId,
    blobKey: toBase64Url(blobKey),
    expiresAt,
    cancelToken,
    pluginId: entry.id,
    pluginVersion: entry.version,
    dictionary: entry.dictionary,
    role: 'initiator',
    initiatorPubKey: toBase64Url(identity.publicKey()),
    seed: toBase64Url(seed),
    status: 'pending',
    createdAt: now,
    lastActivity: now,
    invitedContact: invitee?.publicKey,
    opponentName: invitee?.name,
  };

  await putGame(game);
  // Told rather than left to be discovered: a game started on a phone should
  // be on the laptop before anyone has moved.
  await announceGame(game);

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
export async function joinGame(
  fragment: string,
  /**
   * Who this invitation was expected to be from, when it did not arrive as a
   * link.
   *
   * An invitation found in a pair mailbox could only have been left by the one
   * person who can write to it — but the blob it points at is a public bearer
   * token, so checking the key inside it closes the gap between "only they
   * could have left this" and "this is a game with them".
   */
  expectFrom?: string,
): Promise<JoinResult> {
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

  if (expectFrom && toBase64Url(invite.initiatorPublicKey) !== expectFrom) {
    return { ok: false, reason: 'malformed' };
  }
  // The invite names its version, and only that version will do — different
  // rules on the two devices is the one failure there is no recovering from.
  const entry = gameEntry(invite.pluginId, invite.pluginVersion);

  const dictionaryHash = invite.dictionaryHash;
  const game: GameRecord = {
    gameId: toBase64Url(invite.gameId),
    blobId,
    pluginId: invite.pluginId,
    pluginVersion: invite.pluginVersion,
    dictionary: dictionaryHash ? toHex(dictionaryHash) : undefined,
    role: 'claimer',
    initiatorPubKey: toBase64Url(invite.initiatorPublicKey),
    claimerPubKey: toBase64Url(identity.publicKey()),
    seed:
      entry?.seed === 'draw'
        ? toBase64Url(identity.deriveDrawSeed(invite.gameId))
        : toBase64Url(invite.seed),
    status: 'active',
    createdAt: now,
    lastActivity: now,
    // Cached on the record so the list can say who a game is against without
    // opening a contact for every row it draws.
    opponentName: invite.name || undefined,
  };

  const compatible =
    entry !== undefined &&
    invite.isCompatible(
      entry.id,
      entry.version,
      entry.dictionary ? fromHex(entry.dictionary) : undefined,
    );

  if (!compatible) {
    await putGame({ ...game, status: 'incompatible' });
    return { ok: false, reason: 'incompatible' };
  }

  await putGame(game);
  // Arriving on a link is an introduction of sorts: this device now has an
  // identity and a game, and standing in front of the board to ask its owner's
  // name would be asking at the worst possible moment. Profile is there for
  // whenever they want one.
  await markOnboarded();
  // The name travelled inside the blob, so this is the first moment anyone
  // could have known it. A name already saved for this key wins — a local
  // rename is a decision, and a later handshake is not an argument against it.
  await rememberContact(game.initiatorPubKey, invite.name || PLACEHOLDER_NAME, now);
  await announceGame(game);
  await announceContact(game.initiatorPubKey, invite.name || PLACEHOLDER_NAME, now);
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

  // An invite the relay has dropped is gone for good: the seven-day alarm has
  // fired, and nobody can redeem the link any more. Saying so is better than
  // leaving the row waiting forever for a claim that cannot arrive.
  let status;
  try {
    status = await inviteStatus(game.blobId);
  } catch (error) {
    if (error instanceof RelayError && error.status === 404) {
      return updateGame(gameId, { status: 'expired', blobKey: undefined });
    }
    throw error;
  }

  if (!status.claimed || !status.claimerPubKey || !status.sig) return game;

  const { core } = await loadIdentity();
  core.verifyClaim(
    fromBase64Url(status.claimerPubKey),
    fromBase64Url(game.blobId),
    fromBase64Url(status.sig),
  );

  const now = Date.now();

  // Whoever opened the link is the opponent, whoever it was addressed to. If
  // those differ, the name this game was given on creation is simply wrong, and
  // dropping it lets the right one arrive from the log's `Join` entry.
  const asIntended =
    game.invitedContact === undefined || game.invitedContact === status.claimerPubKey;
  // Named for now only by the fact that they exist: what they would like to be
  // called is in the log's `Join` entry, which is not readable until the game is
  // opened. `learnOpponentName` replaces this the moment it is.
  await rememberContact(status.claimerPubKey, PLACEHOLDER_NAME, now);

  // The blob key is dropped once the invite is spent: the link is no longer
  // usable, so keeping the key would be storing a secret for no reason.
  const claimed = await updateGame(gameId, {
    claimerPubKey: status.claimerPubKey,
    status: 'active',
    blobKey: undefined,
    cancelToken: undefined,
    lastActivity: now,
    opponentName: asIntended ? game.opponentName : undefined,
  });

  // Whichever device happened to be polling learned this; the others cannot,
  // because the invite is spent and its status is now a 404 to them.
  if (claimed) {
    await announceGame(claimed);
    await announceContact(status.claimerPubKey, PLACEHOLDER_NAME, now);
  }

  return claimed;
}

/**
 * Calls off an invite nobody took.
 *
 * The relay is told first, so the link stops working for whoever has it — a
 * local delete alone would leave a live invite out there, and someone redeeming
 * it later would land in a game the other side had already forgotten.
 *
 * A relay that has already dropped the blob, or never had it, is not a failure:
 * the link is dead either way, which is what was being asked for.
 */
export async function cancelPendingGame(gameId: string): Promise<void> {
  const game = await getGame(gameId);
  if (!game) return;
  if (game.status === 'active' || game.status === 'finished') {
    throw new Error('That game has already started. Resign it instead.');
  }

  // Take it back out of the recipient's mailbox first, so an invitation to a
  // game that no longer exists does not sit there for a week. Best effort: the
  // link dying is what actually matters, and that is the relay's copy below.
  if (game.mailbox) {
    const { retractInvitation } = await import('./mailbox.ts');
    await retractInvitation(gameId).catch(() => {});
  }

  if (game.cancelToken) {
    try {
      await cancelInvite(game.blobId, game.cancelToken);
    } catch (error) {
      // Already claimed is the one refusal worth passing on: the game exists,
      // and the person on the other end is waiting for a move.
      if (error instanceof RelayError && error.status === 409) {
        throw new Error('Someone has just joined this game. Open it to play or resign.');
      }
      if (!(error instanceof RelayError) || error.status !== 404) throw error;
    }
  }

  await deleteGame(gameId);
  await announceGameGone(gameId);
}

function fromHex(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i += 1) {
    bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

function toHex(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}
