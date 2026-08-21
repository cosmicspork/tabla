/**
 * Handing this installation to another of your own devices.
 *
 * Six words do two jobs at once. Joined by spaces they are the passphrase the
 * bundle is encrypted under — the same Argon2id-backed format a backup file
 * uses, so a link is a backup that travels through the relay instead of through
 * a file. Hashed, their first sixteen bytes name the place it is left. That is
 * what keeps the relay incurious: it never chooses the id, so it cannot
 * enumerate what it holds, and it never sees the words, so it cannot open it.
 *
 * Six words from a list of 2048 is 66 bits. Against a blob that exists for ten
 * minutes and is deleted the moment it is collected, by a relay that could rate
 * limit if it ever needed to, that is not a number anybody is getting through —
 * and it is short enough to read across a room, which a URL is not.
 */
import { LINK_TTL_MS, LINK_MAX_BYTES, fromBase64Url, toBase64Url } from '@tabla/shared';

import { applyBundle, gameToJson } from './backup.ts';
import type { BundleJson, GameJson } from './backup.ts';
import { listContacts, listDevices, listGames } from './db/store.ts';
import { announce, thisDevice } from './devices.ts';
import { loadIdentity, randomBytes } from './identity.ts';
import { LINK_WORDS } from './link-words.ts';
import { displayName } from './profile.ts';
import {
  cancelLink as relayCancelLink,
  createLink,
  linkStatus,
  takeLink as relayTakeLink,
} from './relay.ts';

/** How many words a link is spoken in. Six of 2048 carry 66 bits. */
export const LINK_WORD_COUNT = 6;

/** Domain separation, so the id cannot be confused with any other digest. */
const LINK_ID_DOMAIN = 'tabla-link-id/v1';

export interface Offer {
  words: string[];
  linkId: string;
  expiresAt: number;
  cancelToken: string;
  /** Set when the bundle had to be trimmed to fit; the UI says so. */
  omittedGames: number;
}

/** Six words drawn uniformly. 2048 divides 2^16, so no rejection is needed. */
export function newLinkWords(): string[] {
  const draws = new Uint16Array(LINK_WORD_COUNT);
  crypto.getRandomValues(draws);
  return [...draws].map((draw) => LINK_WORDS[draw % LINK_WORDS.length]);
}

/** Whitespace and case are not part of the words. */
export function parseLinkWords(input: string): string[] | null {
  const words = input
    .trim()
    .toLowerCase()
    .split(/[\s-]+/)
    .filter(Boolean);

  if (words.length !== LINK_WORD_COUNT) return null;
  if (words.some((word) => !LINK_WORDS.includes(word))) return null;
  return words;
}

/** Which of the words typed so far are not in the list, for a live hint. */
export function unknownWords(input: string): string[] {
  return input
    .trim()
    .toLowerCase()
    .split(/[\s-]+/)
    .filter(Boolean)
    .filter((word) => !LINK_WORDS.includes(word));
}

export function passphraseOf(words: string[]): string {
  return words.join(' ');
}

/** Where the bundle for these words is left. */
export async function linkIdOf(words: string[]): Promise<string> {
  const material = new TextEncoder().encode(`${LINK_ID_DOMAIN}${passphraseOf(words)}`);
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', material));
  return toBase64Url(digest.slice(0, 16));
}

/**
 * Builds the bundle and leaves it for the other device.
 *
 * Everything this installation knows goes in, but the logs of finished games do
 * not: they are the bulk of a long history and the least urgent thing to have,
 * since a finished game is a result rather than a position. The game is still
 * listed with its outcome, and its log comes back from the room if the relay
 * still has it. If even that does not fit, the oldest unfinished games give up
 * their logs too, and the UI says how many.
 */
export async function offerLink(): Promise<Offer> {
  const { core, identity } = await loadIdentity();
  await thisDevice();

  const words = newLinkWords();
  const linkId = await linkIdOf(words);

  const games = await listGames();
  const carried = await Promise.all(games.map(gameToJson));
  const omittedGames = trimToFit(
    carried,
    games.map((game) => game.status),
  );

  const bundle: BundleJson = {
    v: 3,
    identity_seed: [...identity.seed()],
    name: await displayName(),
    contacts: (await listContacts()).map((contact) => ({
      public_key: [...fromBase64Url(contact.publicKey)],
      name: contact.name,
      first_seen: contact.firstSeen,
    })),
    games: carried,
    exported_at: Date.now(),
    devices: (await listDevices()).map((device) => ({
      id: [...fromBase64Url(device.id)],
      name: device.name,
      linked_at: device.linkedAt,
    })),
  };

  const sealed = core.exportBundle(
    passphraseOf(words),
    JSON.stringify(bundle),
    randomBytes(16),
    randomBytes(24),
  );

  const { expiresAt, cancelToken } = await createLink(linkId, toBase64Url(sealed));
  return { words, linkId, expiresAt, cancelToken, omittedGames };
}

/**
 * Drops logs until the bundle will fit, finished games first.
 *
 * Returns how many games lost theirs, so the person is told rather than left to
 * discover a game that will not open until it syncs.
 */
function trimToFit(games: GameJson[], statuses: string[]): number {
  let dropped = 0;

  const order = games
    .map((game, at) => ({ at, finished: statuses[at] === 'finished', when: game.last_activity }))
    // Finished first, then oldest: the least likely to be wanted right now.
    .sort((a, b) => Number(b.finished) - Number(a.finished) || a.when - b.when);

  for (const { at } of order) {
    if (measure(games) <= LINK_MAX_BYTES) break;
    if (games[at].entries.length === 0) continue;
    games[at] = { ...games[at], entries: [] };
    dropped += 1;
  }

  return dropped;
}

/** Roughly what the sealed bundle will weigh. Postcard is smaller than JSON. */
function measure(games: GameJson[]): number {
  return games.reduce(
    (total, game) => total + game.entries.reduce((n, entry) => n + entry.length, 0) + 256,
    0,
  );
}

export type LinkState = 'waiting' | 'taken' | 'gone';

/** What the offering device polls, to know when to stop showing the words. */
export async function watchLink(linkId: string): Promise<LinkState> {
  try {
    const status = await linkStatus(linkId);
    return status.taken ? 'taken' : 'waiting';
  } catch {
    // A link the relay does not have is one that expired or was withdrawn.
    return 'gone';
  }
}

export async function withdrawLink(linkId: string, cancelToken: string): Promise<void> {
  await relayCancelLink(linkId, cancelToken).catch(() => {});
}

export interface Linked {
  /** What this identity asks to be called, so the device can confirm it. */
  name: string;
  games: number;
  contacts: number;
}

export type TakeFailure = 'unknown-words' | 'not-found' | 'taken' | 'expired' | 'unreadable';

export class LinkError extends Error {
  constructor(readonly reason: TakeFailure) {
    super(reason);
    this.name = 'LinkError';
  }
}

/**
 * Collects the bundle and becomes the device it describes.
 *
 * There is no step between taking and adopting, deliberately. Collecting is
 * what consumes the link, so a confirmation offered afterwards would be a
 * choice between going on and being left with nothing — and the person just
 * read six words off their own screen, which is the confirmation.
 */
export async function takeLink(input: string, deviceName: string): Promise<Linked> {
  const words = parseLinkWords(input);
  if (!words) throw new LinkError('unknown-words');

  const linkId = await linkIdOf(words);

  let sealed: Uint8Array;
  try {
    sealed = fromBase64Url(await relayTakeLink(linkId));
  } catch (error) {
    throw new LinkError(reasonFor(error));
  }

  const { core } = await loadIdentity();

  let bundle: BundleJson;
  try {
    bundle = JSON.parse(core.importBundle(passphraseOf(words), sealed)) as BundleJson;
  } catch {
    // The words opened the mailbox but not the box, which should be impossible:
    // they are the same words. A corrupt upload is the only story left.
    throw new LinkError('unreadable');
  }

  const summary = await applyBundle(bundle);

  // Named after adopting, so the record lands in the store the bundle brought
  // rather than being overwritten by it.
  const me = await thisDevice(deviceName);
  await announce({
    DeviceAdded: { id: [...fromBase64Url(me.id)], name: me.name, linked_at: me.linkedAt },
  });

  return { name: bundle.name, games: summary.games, contacts: summary.contacts };
}

function reasonFor(error: unknown): TakeFailure {
  const status = (error as { status?: number }).status;
  if (status === 409) return 'taken';
  if (status === 410) return 'expired';
  return 'not-found';
}

/** How long a link has left, for the countdown beside the words. */
export function timeLeft(expiresAt: number, now = Date.now()): string {
  const left = Math.max(0, expiresAt - now);
  const minutes = Math.floor(left / 60_000);
  const seconds = Math.floor((left % 60_000) / 1000);
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

export { LINK_TTL_MS };
