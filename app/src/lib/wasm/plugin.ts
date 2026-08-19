/**
 * Loads the game-rules WASM module.
 *
 * This module links no cryptography and is handed no keys. It is meant to be
 * initialized inside the plugin Web Worker (see `$lib/plugin/host.ts`), which
 * deletes its own networking globals before loading anything.
 */
import init, * as plugin from './pkg/plugin/tabla_plugin.js';

import type { WasmSource } from './core.ts';

export type PluginModule = typeof plugin;

let ready: Promise<PluginModule> | null = null;

export function loadPlugin(wasm?: WasmSource): Promise<PluginModule> {
  ready ??= init(wasm === undefined ? undefined : { module_or_path: wasm }).then(() => plugin);
  return ready;
}
