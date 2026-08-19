/**
 * Loads the word game's rules module from bytes.
 *
 * Unlike the bundled module, this one is not part of the app: it is fetched,
 * checked against the signed manifest, and only then handed here. The generated
 * loader's own fetch fallback has been replaced with a throw (see `just
 * plugins`), so there is no path by which these bytes arrive unverified — which
 * matters because this runs inside the sandbox, where nothing is allowed to
 * reach the network in the first place.
 */
import init, * as letras from './letras-pkg/tabla_letras.js';

import type { WasmSource } from './core.ts';
import type { PluginModule } from './plugin.ts';

let ready: Promise<PluginModule> | null = null;

export function loadLetras(wasm: WasmSource): Promise<PluginModule> {
  ready ??= init({ module_or_path: wasm }).then(() => letras as PluginModule);
  return ready;
}

/** Test seam: drops the memoized module so another set of bytes can be tried. */
export function forgetLetras(): void {
  ready = null;
}
