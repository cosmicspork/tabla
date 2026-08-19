/**
 * Messages across the plugin sandbox boundary.
 *
 * Note what is absent: there is no message carrying a key, a subscription, a
 * game id, or anything that identifies a player. The worker sees a move list
 * and a player index, which is exactly what it needs to compute a position and
 * nothing more.
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
  | {
      op: 'view';
      pluginId: string;
      config: Uint8Array;
      seed: Uint8Array;
      moves: Uint8Array[];
      player: number;
    }
  | {
      op: 'validate';
      pluginId: string;
      config: Uint8Array;
      seed: Uint8Array;
      moves: Uint8Array[];
      move: Uint8Array;
      player: number;
    }
);

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
