/**
 * What to call yourself.
 *
 * A label, not an identity: nothing checks it, two people may pick the same
 * one, and whoever receives it can change it on their own device. The public
 * key is who you are; this is what gets written next to it, so that a list of
 * games can say "Letras with Pooja" instead of repeating the game's name four
 * times.
 *
 * It is sent inside the sealed invite and inside the signed log, never to the
 * relay — see ARCHITECTURE, "The one invariant".
 */
import { getMeta, setMeta } from './db/store.ts';

const DISPLAY_NAME = 'displayName';

/**
 * What a contact is called before anyone says otherwise.
 *
 * A real placeholder rather than an empty string, because it is shown: the
 * initiator meets a claimer's key before it can possibly know their name, and
 * a blank row would read as a bug. Recognising it is what lets a name that
 * arrives later take its place — see `GameSession.learnOpponentName`.
 */
export const PLACEHOLDER_NAME = 'Opponent';

/** Matches the limit the invite format enforces, so nothing is silently cut. */
export const MAX_NAME_LENGTH = 32;

export async function displayName(): Promise<string> {
  return (await getMeta<string>(DISPLAY_NAME)) ?? '';
}

export async function setDisplayName(name: string): Promise<void> {
  await setMeta(DISPLAY_NAME, cleanName(name));
}

/** Trimmed and bounded, the same way the Rust side does it. */
export function cleanName(name: string): string {
  return [...name.trim()].slice(0, MAX_NAME_LENGTH).join('');
}

/**
 * Whether this device has been through first run.
 *
 * Deliberately a separate fact from having a name: a person may decline to
 * give one, and asking again every launch would be its own kind of rude.
 */
export async function hasOnboarded(): Promise<boolean> {
  return (await getMeta<boolean>('onboarded')) ?? false;
}

export async function markOnboarded(): Promise<void> {
  await setMeta('onboarded', true);
}
