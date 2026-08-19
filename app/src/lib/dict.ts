/**
 * Fetching the word list a game plays against.
 *
 * Half a megabyte, so it is not part of the app shell and not downloaded until
 * somebody actually starts a word game. After the first fetch the service
 * worker's runtime cache keeps it, so a game stays playable offline from then
 * on — but the first one does need a connection, and the UI says so rather than
 * failing mysteriously.
 *
 * Every path here ends in the same check: the bytes hash to what the invite
 * pinned, or they are not used. That matters more than it looks. The app is
 * served with a single-page fallback, so a mistyped path returns `index.html`
 * with a 200 and a cheerful `Content-Type`; without the hash this would show up
 * as a baffling parse error somewhere deep in the rules. And a client playing
 * against a different word list would disagree with its opponent about whether
 * a challenged word is real, which is unrecoverable mid-game.
 */
import { DICTIONARY_EN_V1 } from '@tabla/shared';

/** A word list the app knows how to fetch, keyed by the hash games pin. */
export interface Dictionary {
  id: string;
  path: string;
  sha256: string;
}

const KNOWN: Dictionary[] = [DICTIONARY_EN_V1];

/** Fetched bytes, kept for the life of the page. */
const loaded = new Map<string, Uint8Array>();
/** In-flight fetches, so a burst of renders makes one request. */
const pending = new Map<string, Promise<Uint8Array>>();

export class DictionaryError extends Error {
  constructor(
    message: string,
    readonly kind: 'unknown' | 'offline' | 'corrupt',
  ) {
    super(message);
  }
}

/** The dictionary a game's pinned hash refers to, if this build has one. */
export function dictionaryFor(sha256: string): Dictionary | undefined {
  return KNOWN.find((entry) => entry.sha256 === sha256);
}

/**
 * The bytes for a pinned hash, fetching them once if needed.
 *
 * This is the function handed to the plugin sandbox as its asset source: the
 * sandbox cannot fetch anything itself, so the main thread does it and passes
 * the result in.
 */
export async function dictionaryBytes(sha256: string): Promise<Uint8Array> {
  const already = loaded.get(sha256);
  if (already) return already;

  const inFlight = pending.get(sha256);
  if (inFlight) return inFlight;

  const entry = dictionaryFor(sha256);
  if (!entry) {
    throw new DictionaryError(
      'This game uses a word list this version of tabla does not have.',
      'unknown',
    );
  }

  const fetching = fetchAndVerify(entry).finally(() => pending.delete(sha256));
  pending.set(sha256, fetching);
  return fetching;
}

async function fetchAndVerify(entry: Dictionary): Promise<Uint8Array> {
  let bytes: Uint8Array;

  try {
    const response = await fetch(entry.path);
    if (!response.ok) {
      throw new DictionaryError(`the word list returned ${response.status}`, 'offline');
    }
    bytes = new Uint8Array(await response.arrayBuffer());
  } catch (error) {
    if (error instanceof DictionaryError) throw error;
    throw new DictionaryError(
      'The word list could not be downloaded. Once it has been, this game works offline.',
      'offline',
    );
  }

  const actual = await sha256Hex(bytes);
  if (actual !== entry.sha256) {
    throw new DictionaryError(
      'The word list that came back is not the one this game agreed to.',
      'corrupt',
    );
  }

  loaded.set(entry.sha256, bytes);
  return bytes;
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  // A fresh copy: `digest` wants a plain ArrayBuffer, and a view into a larger
  // one would hash the wrong bytes.
  const copy = new Uint8Array(bytes);
  const digest = await crypto.subtle.digest('SHA-256', copy.buffer as ArrayBuffer);

  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Test seam: forgets anything already fetched. */
export function forgetDictionaries(): void {
  loaded.clear();
  pending.clear();
}
