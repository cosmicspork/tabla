/**
 * The word list a game plays against.
 *
 * Half a megabyte, so it is not part of the app shell and is not downloaded
 * until somebody actually starts a word game. Fetching, hash-checking, and
 * keeping it is the same job as fetching a plugin module, and is done by the
 * same code — see `plugin/install.ts`. What lives here is the part specific to
 * dictionaries: which hash a game pinned, and what to tell a player when the
 * one they need cannot be had.
 *
 * The pin is not a formality. A client playing against a different word list
 * would disagree with its opponent about whether a played word is real,
 * and there is no recovering from that once a game is under way.
 */
import { assetBytes, InstallError } from './plugin/install.ts';

export class DictionaryError extends Error {
  constructor(
    message: string,
    readonly kind: 'unknown' | 'offline' | 'corrupt',
  ) {
    super(message);
  }
}

/**
 * The bytes for a pinned hash, fetching them once if needed.
 *
 * This is the function handed to the plugin sandbox as its asset source: the
 * sandbox cannot fetch anything itself, so the main thread does it and passes
 * the result in.
 */
export async function dictionaryBytes(sha256: string): Promise<Uint8Array> {
  try {
    return await assetBytes(sha256);
  } catch (error) {
    throw asDictionaryError(error);
  }
}

function asDictionaryError(error: unknown): unknown {
  if (!(error instanceof InstallError)) return error;

  switch (error.kind) {
    case 'unknown':
      return new DictionaryError(
        'This game uses a word list this version of tabla does not have.',
        'unknown',
      );
    case 'offline':
      return new DictionaryError(
        'The word list could not be downloaded. Once it has been, this game works offline.',
        'offline',
      );
    default:
      // A corrupt download and a manifest this build will not trust are the
      // same thing to a player: the bytes on offer are not the agreed ones.
      return new DictionaryError(
        'The word list that came back is not the one this game agreed to.',
        'corrupt',
      );
  }
}
