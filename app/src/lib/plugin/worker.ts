/**
 * The plugin sandbox.
 *
 * Game rules run here and nowhere else. Before a single line of game code is
 * loaded, this worker deletes its own ability to reach the network. Combined
 * with the plugin WASM being a separate binary that links no cryptography, and
 * with this worker never being handed a key or a database handle, a plugin can
 * compute the consequences of a move and can do nothing else with what it sees.
 *
 * The capability removal is defence in depth, not the primary control — the
 * primary control is that nothing secret is ever sent here.
 */
import { loadPlugin } from '../wasm/plugin.ts';
import {
  ASSET_MISSING,
  type PluginOutcome,
  type PluginRequest,
  type PluginResponse,
} from './protocol.ts';

// Remove the ways out before the plugin module is even fetched.
for (const capability of [
  'fetch',
  'XMLHttpRequest',
  'WebSocket',
  'EventSource',
  'importScripts',
  'indexedDB',
  'caches',
  'navigator',
] as const) {
  try {
    Reflect.deleteProperty(globalThis, capability);
  } catch {
    // Some globals are non-configurable in some engines; the isolation does not
    // depend on this succeeding, so a failure here is not fatal.
  }
}

const ready = loadPlugin();

/**
 * Reference data, keyed by hash, kept so a large word list crosses the boundary
 * once rather than on every render.
 *
 * Holding it here is safe precisely because it is not secret: it is the same
 * public data both players pinned in the invite, and the plugin re-derives its
 * hash rather than trusting that this map holds the right bytes.
 */
const assets = new Map<string, Uint8Array>();

const EMPTY = new Uint8Array();

function assetFor(hash: string | undefined): Uint8Array {
  if (hash === undefined) return EMPTY;

  const bytes = assets.get(hash);
  if (!bytes) throw new Error(ASSET_MISSING);
  return bytes;
}

self.addEventListener('message', (event: MessageEvent<PluginRequest>) => {
  void handle(event.data);
});

async function handle(request: PluginRequest): Promise<void> {
  try {
    const plugin = await ready;
    const result = run(plugin, request);
    self.postMessage({
      id: request.id,
      ok: true,
      result,
    } satisfies PluginResponse);
  } catch (error) {
    self.postMessage({
      id: request.id,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    } satisfies PluginResponse);
  }
}

function run(
  plugin: Awaited<ReturnType<typeof loadPlugin>>,
  request: PluginRequest,
): PluginResponse['result'] {
  switch (request.op) {
    case 'availablePlugins':
      return { kind: 'strings', value: plugin.available_plugins() };

    case 'pluginVersion':
      return { kind: 'number', value: plugin.plugin_version(request.pluginId) };

    case 'encodeMove':
      return {
        kind: 'bytes',
        value: plugin.encodeMove(request.pluginId, request.json),
      };

    case 'provideAsset':
      assets.set(request.hash, request.bytes);
      return { kind: 'ok' };

    case 'view': {
      // The whole position is recomputed from the move list every time. It is
      // cheap, and it means the rendered board can never drift from the log.
      const state = plugin.replay(
        request.pluginId,
        request.config,
        request.seed,
        request.moves,
        assetFor(request.assetHash),
      );
      return {
        kind: 'view',
        value: {
          view: JSON.parse(plugin.player_view(request.pluginId, state, request.player)),
          outcome: parseOutcome(plugin.is_game_over(request.pluginId, state)),
        },
      };
    }

    case 'validate': {
      const asset = assetFor(request.assetHash);
      const state = plugin.replay(
        request.pluginId,
        request.config,
        request.seed,
        request.moves,
        asset,
      );
      plugin.validate_move(request.pluginId, state, request.move, request.player, asset);
      return { kind: 'ok' };
    }
  }
}

function parseOutcome(raw: string | undefined | null): PluginOutcome | null {
  return raw === undefined || raw === null ? null : (JSON.parse(raw) as PluginOutcome);
}
