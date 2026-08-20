/**
 * Loads version 2 of the word game's rules from bytes.
 *
 * A sibling of `letras.ts` rather than a parameter of it: the two versions are
 * separate wasm modules with separate generated glue, and a device may well
 * have both loaded — one game in progress under the old rules while a new one
 * starts under these.
 *
 * As with version 1, the generated loader's own fetch fallback has been
 * replaced with a throw (see `just plugins`), so there is no path by which
 * these bytes arrive unverified. That matters because this runs inside the
 * sandbox, where nothing may reach the network at all.
 */
import init, * as letras from './letras2-pkg/tabla_letras2.js';

import type { WasmSource } from './core.ts';
import type { PluginModule } from './plugin.ts';

let ready: Promise<PluginModule> | null = null;

export function loadLetras2(wasm: WasmSource): Promise<PluginModule> {
  ready ??= init({ module_or_path: wasm }).then(() => letras as PluginModule);
  return ready;
}

/** Test seam: drops the memoized module so another set of bytes can be tried. */
export function forgetLetras2(): void {
  ready = null;
}
