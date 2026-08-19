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
import { loadLetras } from '../wasm/letras.ts';
import { loadLetras2 } from '../wasm/letras2.ts';
import { loadPlugin, type PluginModule } from '../wasm/plugin.ts';
import {
  ASSET_MISSING,
  MODULE_MISSING,
  moduleKey,
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
 * Rules the app does not bundle, which this worker can initialize but never
 * obtain.
 *
 * Each entry is a loader for a module whose glue ships with the app, waiting
 * for bytes. The bytes come from the host, which fetched them and checked them
 * against the signed manifest; there is no path from here to a network, and
 * the generated loaders have had their own fetch fallbacks removed, so this
 * worker cannot acquire code even by accident.
 */
const loaders: Record<string, (bytes: Uint8Array) => Promise<PluginModule>> = {
  'letras@1': loadLetras,
  'letras@2': loadLetras2,
};

/** Modules already initialized here, bundled or provided. */
const modules = new Map<string, PluginModule>();

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

/**
 * The module that plays this game.
 *
 * The bundled one answers for the games compiled into the app. Anything else
 * has to have been provided; asking for one that has not been is a request the
 * host can satisfy and retry, which is what `MODULE_MISSING` says.
 */
async function moduleFor(key: string, pluginId: string): Promise<PluginModule> {
  const bundled = await ready;
  if (bundled.available_plugins().includes(pluginId)) return bundled;

  const provided = modules.get(key);
  if (provided) return provided;

  if (key in loaders) throw new Error(MODULE_MISSING);
  throw new Error(`unknown plugin: ${key}`);
}

/** Which module a request is about, if it names a game at all. */
function pluginOf(request: PluginRequest): { id: string; key: string } | undefined {
  if (!('pluginId' in request)) return undefined;
  return {
    id: request.pluginId,
    key: moduleKey(request.pluginId, request.pluginVersion),
  };
}

async function handle(request: PluginRequest): Promise<void> {
  try {
    if (request.op === 'provideModule') {
      const key = moduleKey(request.pluginId, request.pluginVersion);
      const load = loaders[key];
      if (!load) throw new Error(`unknown plugin: ${key}`);

      modules.set(key, await load(request.bytes));
      self.postMessage({
        id: request.id,
        ok: true,
        result: { kind: 'ok' },
      } satisfies PluginResponse);
      return;
    }

    const plugin_ = pluginOf(request);
    const plugin = plugin_ === undefined ? await ready : await moduleFor(plugin_.key, plugin_.id);
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
  plugin: PluginModule,
  request: Exclude<PluginRequest, { op: 'provideModule' }>,
): PluginResponse['result'] {
  switch (request.op) {
    case 'availablePlugins':
      // What this worker can play right now: what the app bundled, plus
      // whatever has been handed to it since.
      return {
        kind: 'strings',
        value: [...plugin.available_plugins(), ...modules.keys()].toSorted(),
      };

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
