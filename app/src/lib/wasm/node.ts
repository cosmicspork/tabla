/**
 * Node-only helpers for loading the WASM modules from disk.
 *
 * Node's `fetch` does not accept `file:` URLs, so the generated glue cannot
 * resolve the `.wasm` on its own outside a browser. Tests read the bytes and
 * hand them in.
 *
 * Application code must never import this module — it would drag `node:fs` into
 * the browser bundle. It exists for the test suites.
 */
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { loadCore, type CoreModule } from './core.ts';
import { loadLetras } from './letras.ts';
import { loadPlugin, type PluginModule } from './plugin.ts';

function resolve(relative: string): string {
  return fileURLToPath(new URL(relative, import.meta.url));
}

export function coreWasmPath(): string {
  return resolve('./pkg/core/tabla_core_bg.wasm');
}

export function pluginWasmPath(): string {
  return resolve('./pkg/plugin/tabla_plugin_bg.wasm');
}

/**
 * The committed downloadable module, read from where the app serves it.
 *
 * This is the artifact a browser fetches and hash-checks, so a test that reads
 * it is testing the bytes players actually receive rather than a fresh build of
 * the same source.
 */
export function letrasWasmPath(): string {
  return resolve('../../../static/plugins/letras-v1.wasm');
}

export async function readCoreWasm(): Promise<Uint8Array> {
  return new Uint8Array(await readFile(coreWasmPath()));
}

export async function readPluginWasm(): Promise<Uint8Array> {
  return new Uint8Array(await readFile(pluginWasmPath()));
}

export async function loadCoreFromDisk(): Promise<CoreModule> {
  return loadCore(await readCoreWasm());
}

export async function readLetrasWasm(): Promise<Uint8Array> {
  return new Uint8Array(await readFile(letrasWasmPath()));
}

export async function loadPluginFromDisk(): Promise<PluginModule> {
  return loadPlugin(await readPluginWasm());
}

export async function loadLetrasFromDisk(): Promise<PluginModule> {
  return loadLetras(await readLetrasWasm());
}
