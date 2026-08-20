/**
 * Which games this build can play, and what each one needs.
 *
 * Everything that used to be a hard-coded `'tictactoe'` lives here now. A game
 * is a plugin id, a version, a board to render it with, and — for games with
 * hidden state — a note about where its randomness comes from and which
 * reference data it reads.
 *
 * What is *here* is what the app knows how to show: a title, a blurb, a board
 * to render with. What a downloadable game's bytes must be is not here — that
 * is the signed manifest's job, and only the manifest's, so there is exactly
 * one authority on which bytes this build will run.
 */
import { CORE_PLUGIN_ID, CORE_PLUGIN_VERSION, DICTIONARY_EN_V1 } from '@tabla/shared';
import type { Component } from 'svelte';

import type { BoardState } from './game-session.ts';

/** Every board takes the same two props; what a move *is* varies by game. */
export type BoardProps = {
  board: BoardState;
  onplay: (move: unknown) => void;
};

/**
 * Where a game's per-player entropy comes from.
 *
 * `shared` hands both players the same value from the invite, which is all a
 * game with nothing to hide needs. `draw` derives a different secret on each
 * device from its identity key, so that neither player can predict the other's
 * tiles — see `Identity.deriveDrawSeed`. `deal` means the game's hidden state
 * lives in an encrypted deck instead, and what this device knows about it comes
 * from `DealSession` rather than from a seed at all.
 */
export type SeedKind = 'shared' | 'draw' | 'deal';

/**
 * Whether a game's rules ship with the app or are fetched on first use.
 *
 * One game is bundled so that a fresh install, or one with no network, can
 * still play something. The rest are modules of their own: a few hundred
 * kilobytes each, downloaded when somebody actually wants them and removable
 * afterwards.
 */
export type Distribution = 'bundled' | 'downloadable';

export interface GameEntry {
  id: string;
  version: number;
  /** What the game is called, in the UI. */
  title: string;
  /** One line for the picker. */
  blurb: string;
  seed: SeedKind;
  distribution: Distribution;
  /** The hash of the reference data this game reads, if it reads any. */
  dictionary?: string;
  /** Loaded on demand: a board is a page's worth of code we need only if used. */
  board: () => Promise<{ default: Component<BoardProps> }>;
}

const REGISTRY: GameEntry[] = [
  {
    id: CORE_PLUGIN_ID,
    version: CORE_PLUGIN_VERSION,
    title: 'Tic tac toe',
    blurb: 'Three in a row. A quick game, and the one that proves everything works.',
    seed: 'shared',
    distribution: 'bundled',
    board: () => import('./components/Board.svelte'),
  },
  {
    id: 'letras',
    version: 2,
    title: 'Letras',
    blurb: 'Words on a board, a turn at a time. Downloads once, then plays offline.',
    seed: 'deal',
    distribution: 'downloadable',
    dictionary: DICTIONARY_EN_V1.sha256,
    board: () => import('./components/WordBoard.svelte'),
  },
  {
    // Kept so games started under the old rules can be finished, and invites
    // written by an older build can still be joined. Not offered for new games
    // — see `availableGames`.
    id: 'letras',
    version: 1,
    title: 'Letras',
    blurb: 'Words on a board, a turn at a time.',
    seed: 'draw',
    distribution: 'downloadable',
    dictionary: DICTIONARY_EN_V1.sha256,
    board: () => import('./components/WordBoard.svelte'),
  },
];

/**
 * Every game a *new* game can be started with, in picker order.
 *
 * One entry per plugin id: older versions stay in the registry so their games
 * can be opened and their invites joined, but nobody starts a new game under
 * rules that have been replaced.
 */
export function availableGames(): GameEntry[] {
  const seen = new Set<string>();
  return REGISTRY.filter((entry) => {
    if (seen.has(entry.id)) return false;
    seen.add(entry.id);
    return true;
  });
}

/** Every entry this build carries, including superseded versions. */
export function allGames(): GameEntry[] {
  return REGISTRY;
}

/**
 * The entry for one version of a game.
 *
 * A version is a different set of rules, not a setting, so this asks for both.
 * `undefined` means this build cannot play that game at that version — which is
 * exactly what an invite from a newer build looks like.
 */
export function gameEntry(pluginId: string, version: number): GameEntry | undefined {
  return REGISTRY.find((entry) => entry.id === pluginId && entry.version === version);
}

/** The newest version of a game this build has. */
export function latestGame(pluginId: string): GameEntry | undefined {
  return REGISTRY.find((entry) => entry.id === pluginId);
}

/**
 * What to call a game whose plugin this build does not recognise.
 *
 * Reachable: a backup restored from a newer build, or an invite from one.
 */
export function titleOf(pluginId: string): string {
  return latestGame(pluginId)?.title ?? 'Unknown game';
}
