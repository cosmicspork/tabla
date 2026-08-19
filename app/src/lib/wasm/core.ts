/**
 * Loads the core WASM module: identity, key agreement, the log, and session
 * decryption. This is the only module that touches keys.
 *
 * In the browser the `.wasm` is resolved and fetched automatically by the
 * generated glue. Other environments (Node under vitest, workerd under
 * `@cloudflare/vitest-pool-workers`) cannot fetch a file URL, so they pass the
 * bytes or a compiled module in themselves — see `node.ts`.
 */
import init, * as core from './pkg/core/tabla_core.js';

export type CoreModule = typeof core;

/** What `init` accepts: raw bytes, a compiled module, or a URL to fetch. */
export type WasmSource = BufferSource | WebAssembly.Module | URL | string;

let ready: Promise<CoreModule> | null = null;

/**
 * Initializes the core module once per context and returns it.
 *
 * Repeat calls return the same promise, so callers never need to coordinate.
 */
export function loadCore(wasm?: WasmSource): Promise<CoreModule> {
  ready ??= init(wasm === undefined ? undefined : { module_or_path: wasm }).then(() => core);
  return ready;
}

/** Whether the core module is already initialized in this context. */
export function coreIsLoaded(): boolean {
  return ready !== null;
}

export type { Identity, Invite, Log, Replay, Session } from './pkg/core/tabla_core.js';
