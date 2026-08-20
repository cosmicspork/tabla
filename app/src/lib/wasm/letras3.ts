/**
 * Loads version 3 of the word game's rules from bytes.
 *
 * A sibling of the others rather than a parameter of them: each version is a
 * separate wasm module with its own generated glue, and a device may well have
 * several loaded at once — a game in progress under older rules while a new one
 * starts under these.
 *
 * As with the earlier versions, the generated loader's own fetch fallback has been
 * replaced with a throw (see `just plugins`), so there is no path by which
 * these bytes arrive unverified. That matters because this runs inside the
 * sandbox, where nothing may reach the network at all.
 */
import init, * as letras from './letras3-pkg/tabla_letras3.js';

import type { WasmSource } from './core.ts';
import type { PluginModule } from './plugin.ts';

let ready: Promise<PluginModule> | null = null;

export function loadLetras3(wasm: WasmSource): Promise<PluginModule> {
  ready ??= init({ module_or_path: wasm }).then(() => letras as PluginModule);
  return ready;
}

/** Test seam: drops the memoized module so another set of bytes can be tried. */
export function forgetLetras3(): void {
  ready = null;
}
