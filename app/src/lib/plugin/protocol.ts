/**
 * Messages across the plugin sandbox boundary.
 *
 * Note what is absent: there is no message carrying a key, a subscription, a
 * game id, or anything that identifies a player. The worker sees a move list
 * and a player index, which is exactly what it needs to compute a position and
 * nothing more.
 *
 * Bulk reference data — a word list, say — is sent once with `provideAsset` and
 * referenced by hash afterwards, rather than being copied into every request.
 * The plugin re-checks that hash against its own configuration, so the caching
 * here is only an optimisation and never a trust boundary.
 *
 * Rules for a game the app does not bundle arrive the same way, with
 * `provideModule`. The sandbox cannot fetch, so the main thread does it, checks
 * the bytes against the signed manifest, and passes them in; the worker takes
 * what it is given and has no way to ask for anything else.
 */

export interface PluginOutcome {
  kind: 'winner' | 'draw';
  player?: number;
}

export interface PluginView {
  view: Record<string, unknown>;
  outcome: PluginOutcome | null;
}

export type PluginRequest = { id: number } & (
  | { op: 'availablePlugins' }
  | { op: 'pluginVersion'; pluginId: string; pluginVersion: number }
  | { op: 'encodeMove'; pluginId: string; pluginVersion: number; json: string }
  | { op: 'provideAsset'; hash: string; bytes: Uint8Array }
  | { op: 'provideModule'; pluginId: string; pluginVersion: number; bytes: Uint8Array }
  | {
      op: 'view';
      pluginId: string;
      pluginVersion: number;
      config: Uint8Array;
      /**
       * What this device knows that the log does not say: entropy for a game
       * that derives its own draws, or the tile values a deal has opened to it.
       */
      seed: Uint8Array;
      moves: Uint8Array[];
      player: number;
      /** Hex hash of previously provided reference data this game needs. */
      assetHash?: string;
    }
  | {
      op: 'validate';
      pluginId: string;
      pluginVersion: number;
      config: Uint8Array;
      seed: Uint8Array;
      moves: Uint8Array[];
      move: Uint8Array;
      player: number;
      assetHash?: string;
    }
);

/**
 * How a loaded module is keyed inside the sandbox.
 *
 * A version of a game is a different set of rules, so two versions are two
 * modules and both may be loaded at once — one game in progress under the old
 * rules, another started under the new.
 */
export function moduleKey(pluginId: string, pluginVersion: number): string {
  return `${pluginId}@${pluginVersion}`;
}

/**
 * Thrown across the boundary when a request names reference data the worker has
 * not been given. The host catches it, supplies the bytes, and retries once.
 */
export const ASSET_MISSING = 'asset-missing';

/**
 * Thrown when a request names a game whose rules this worker has not been
 * given. The host catches it, fetches and verifies the module, and retries.
 *
 * Distinct from "unknown plugin", which is what a game no build of this app can
 * play gets — that one is not worth retrying.
 */
export const MODULE_MISSING = 'module-missing';

export type PluginResult =
  | { kind: 'ok' }
  | { kind: 'number'; value: number }
  | { kind: 'strings'; value: string[] }
  | { kind: 'bytes'; value: Uint8Array }
  | { kind: 'view'; value: PluginView };

export interface PluginResponse {
  id: number;
  ok: boolean;
  result?: PluginResult;
  error?: string;
}
