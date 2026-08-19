/**
 * Which games this build can play, and what each one needs.
 *
 * Everything that used to be a hard-coded `'tictactoe'` lives here now. A game
 * is a plugin id, a version, a board to render it with, and — for games with
 * hidden state — a note about where its randomness comes from and which
 * reference data it reads.
 *
 * Both games are compiled into the plugin module today. Phase 3 turns this into
 * a manifest of things that can be fetched and hash-checked; the shape is
 * deliberately the shape that will need, so that change is about *where* an
 * entry comes from rather than what an entry is.
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
 * tiles — see `Identity.deriveDrawSeed`.
 */
export type SeedKind = 'shared' | 'draw';

export interface GameEntry {
  id: string;
  version: number;
  /** What the game is called, in the UI. */
  title: string;
  /** One line for the picker. */
  blurb: string;
  seed: SeedKind;
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
    board: () => import('./components/Board.svelte'),
  },
  {
    id: 'letras',
    version: 1,
    title: 'Letras',
    blurb: 'Words on a board, a turn at a time. Bring a dictionary; the first load needs one.',
    seed: 'draw',
    dictionary: DICTIONARY_EN_V1.sha256,
    board: () => import('./components/WordBoard.svelte'),
  },
];

/** Every game this build offers, in the order the picker shows them. */
export function availableGames(): GameEntry[] {
  return REGISTRY;
}

/** The entry for a plugin id, or `undefined` if this build does not have it. */
export function gameEntry(pluginId: string): GameEntry | undefined {
  return REGISTRY.find((entry) => entry.id === pluginId);
}

/**
 * What to call a game whose plugin this build does not recognise.
 *
 * Reachable: a backup restored from a newer build, or an invite from one.
 */
export function titleOf(pluginId: string): string {
  return gameEntry(pluginId)?.title ?? 'Unknown game';
}
