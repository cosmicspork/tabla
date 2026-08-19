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
  | { op: 'pluginVersion'; pluginId: string }
  | { op: 'encodeMove'; pluginId: string; json: string }
  | { op: 'provideAsset'; hash: string; bytes: Uint8Array }
  | {
      op: 'view';
      pluginId: string;
      config: Uint8Array;
      seed: Uint8Array;
      moves: Uint8Array[];
      player: number;
      /** Hex hash of previously provided reference data this game needs. */
      assetHash?: string;
    }
  | {
      op: 'validate';
      pluginId: string;
      config: Uint8Array;
      seed: Uint8Array;
      moves: Uint8Array[];
      move: Uint8Array;
      player: number;
      assetHash?: string;
    }
);

/**
 * Thrown across the boundary when a request names reference data the worker has
 * not been given. The host catches it, supplies the bytes, and retries once.
 */
export const ASSET_MISSING = 'asset-missing';

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
