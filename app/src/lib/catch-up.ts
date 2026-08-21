/**
 * Filling in a newly linked device.
 *
 * The bundle brings the identity, the contacts and every game's record, but a
 * game is its log, and the logs are the bulk of a long history — the link
 * leaves out the ones for finished games, and drops more if it has to. So the
 * first thing a linked device does is open each game it can and let the sync
 * engine fetch what it is missing.
 *
 * One at a time. Each game opens a socket, replays a log and, for a game with a
 * deal, verifies a pile of proofs; a device that started all of them at once on
 * the strength of having just been set up would spend its first minute
 * unresponsive.
 */
import { listGames } from './db/store.ts';
import type { GameRecord } from './db/schema.ts';
import { GameSession } from './game-session.ts';

export interface Progress {
  done: number;
  total: number;
}

/** Games worth fetching: claimed, unfinished, and not already complete here. */
export async function needsCatchUp(): Promise<GameRecord[]> {
  return (await listGames()).filter(
    (game) => game.claimerPubKey !== undefined && game.status === 'active',
  );
}

/**
 * Syncs each game in turn, reporting as it goes.
 *
 * A game that will not sync is skipped rather than retried: the usual reason is
 * that the relay evicted it, and the record with its outcome is still here. It
 * will try again the next time anybody opens it.
 */
export async function catchUp(onProgress?: (progress: Progress) => void): Promise<Progress> {
  const games = await needsCatchUp();
  const total = games.length;
  let done = 0;

  onProgress?.({ done, total });

  for (const game of games) {
    try {
      await sync(game);
    } catch {
      // Skipped, not retried. See above.
    }
    done += 1;
    onProgress?.({ done, total });
  }

  return { done, total };
}

/** Opens one game just long enough for the relay to hand over what we lack. */
async function sync(game: GameRecord): Promise<void> {
  const session = await GameSession.open(game);

  try {
    await new Promise<void>((resolve) => {
      const settled = { done: false };
      const finish = () => {
        if (settled.done) return;
        settled.done = true;
        clearTimeout(timer);
        unsubscribe();
        resolve();
      };

      // A game whose room is gone would otherwise hold the queue open until
      // the socket gave up on its own.
      const timer = setTimeout(finish, 15_000);
      const unsubscribe = session.subscribe((board) => {
        if (
          board.status === 'synced' ||
          board.status === 'refused' ||
          board.status === 'diverged'
        ) {
          finish();
        }
      });

      void session.connect();
    });
  } finally {
    session.disconnect();
  }
}
