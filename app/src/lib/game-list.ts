/**
 * Turning the stored games into the list a person actually reads.
 *
 * The old list was one flat run in activity order, labelled by which side of
 * the invite you had been on — which is the least useful thing known about a
 * game in progress. What a person opening this app wants is the answer to "is
 * anything waiting for me", so that is what it is sorted by.
 *
 * Nothing here decrypts anything. Every field it reads was written to the game
 * record when the board last rendered; see `GameSession.persistAndNotify`.
 */
import { countEntries } from './db/store.ts';
import type { GameRecord } from './db/schema.ts';
import { loadIdentity } from './identity.ts';
import { titleOf } from './registry.ts';

export type GroupKey = 'yours' | 'theirs' | 'invites' | 'attention' | 'finished';

export interface ListedGame {
  game: GameRecord;
  /** What the row is called: the game, and who it is against once we know. */
  title: string;
  /** The one line under it. */
  detail: string;
  /** Relative time, right-aligned. */
  when: string;
  /** Present only while it can still be called off. */
  cancellable: boolean;
}

export interface Group {
  key: GroupKey;
  title: string;
  games: ListedGame[];
}

const GROUP_TITLES: Record<GroupKey, string> = {
  yours: 'Your move',
  theirs: 'Waiting on them',
  invites: 'Invites out',
  attention: 'Needs attention',
  finished: 'Finished',
};

/** The order they appear in, which is the order they need you. */
const GROUP_ORDER: GroupKey[] = ['yours', 'theirs', 'invites', 'attention', 'finished'];

/**
 * Whose turn it is, for a game whose board has not been open since the app
 * learned to write that down.
 *
 * The log alternates by a fixed rule — the claimer writes sequence 0, the
 * initiator 1, and strictly alternately after that — so the next author is a
 * function of the log's length alone. No keys, no replay, no rules: just a
 * count and a parity. It can read wrong for a moment during the openings of a
 * game that deals tiles, where the clients exchange several entries
 * unattended, and that is a fair price for not replaying every log to draw a
 * list.
 */
async function inferYourTurn(game: GameRecord): Promise<boolean | undefined> {
  if (game.status !== 'active') return undefined;

  try {
    const { core } = await loadIdentity();
    const next = await countEntries(game.gameId);
    return core.Session.expectedAuthor(next) === (game.role === 'initiator' ? 0 : 1);
  } catch {
    // A game we cannot read the shape of is not worth a broken list.
    return undefined;
  }
}

function groupOf(game: GameRecord, yourTurn: boolean | undefined): GroupKey {
  if (game.status === 'finished') return 'finished';
  if (game.status === 'pending') return 'invites';
  if (game.status === 'incompatible' || game.status === 'expired') return 'attention';
  return yourTurn ? 'yours' : 'theirs';
}

function detailOf(game: GameRecord, yourTurn: boolean | undefined): string {
  switch (game.status) {
    case 'pending':
      return expiryOf(game) ?? 'Nobody has opened the link yet';
    case 'expired':
      return 'Nobody took this invite';
    case 'incompatible':
      return 'Update tabla to play this one';
    case 'finished':
      return game.outcome ?? 'Finished';
    default:
      // What just happened beats whose turn it is: it says the same thing and
      // more. Games that do not report a last move fall back to the turn.
      return game.lastPlay ?? (yourTurn ? 'Your turn' : 'Waiting for them');
  }
}

function expiryOf(game: GameRecord): string | undefined {
  if (game.expiresAt === undefined) return undefined;

  const days = Math.ceil((game.expiresAt - Date.now()) / 86_400_000);
  if (days <= 0) return 'Expires today';
  return `Expires in ${days} day${days === 1 ? '' : 's'}`;
}

/**
 * How long ago, in the least precise form that is still useful.
 *
 * A correspondence game is measured in days, so "3d" is the answer to how long
 * it has been sitting there; the clock only matters in the first hour.
 */
export function relativeTime(at: number, now = Date.now()): string {
  const seconds = Math.max(0, Math.round((now - at) / 1000));
  if (seconds < 60) return 'now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h`;

  const days = Math.floor(seconds / 86_400);
  if (days < 7) return `${days}d`;
  return `${Math.floor(days / 7)}w`;
}

/** A row's name: the game, and who it is against once anyone has told us. */
export function titleFor(game: GameRecord): string {
  const name = game.opponentName;
  return name ? `${titleOf(game.pluginId)} with ${name}` : titleOf(game.pluginId);
}

/** Builds the grouped list, in the order the groups should be shown. */
export async function groupGames(games: GameRecord[]): Promise<Group[]> {
  const rows = await Promise.all(
    games.map(async (game) => {
      const yourTurn = game.yourTurn ?? (await inferYourTurn(game));
      return {
        key: groupOf(game, yourTurn),
        row: {
          game,
          title: titleFor(game),
          detail: detailOf(game, yourTurn),
          when: relativeTime(game.lastActivity),
          cancellable: game.status === 'pending' || game.status === 'expired',
        } satisfies ListedGame,
      };
    }),
  );

  return GROUP_ORDER.map((key) => ({
    key,
    title: GROUP_TITLES[key],
    games: rows.filter((row) => row.key === key).map((row) => row.row),
  })).filter((group) => group.games.length > 0);
}
