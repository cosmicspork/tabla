/* tslint:disable */
/* eslint-disable */

export function apply_move(
  plugin_id: string,
  state: Uint8Array,
  mv: Uint8Array,
  assets: Uint8Array,
): Uint8Array;

/**
 * Plugin identifiers this module can play.
 */
export function available_plugins(): string[];

/**
 * The deck a game with hidden state is dealt from, in canonical order.
 *
 * Empty for a game that has none. This is public information — the same list
 * on both devices, which is exactly why establishing the deck costs no log
 * entries — and it lives with the rules because the rules are what define it.
 * The host needs it to set up the deal, which happens on the other side of
 * this boundary, where the keys are.
 */
export function deck(plugin_id: string): Uint8Array;

/**
 * Renders an encoded move back as JSON.
 */
export function decodeMove(plugin_id: string, bytes: Uint8Array): string;

/**
 * Encodes a move described as JSON (`{"cell":4}`) into its wire form.
 *
 * The UI never serializes moves itself: those bytes are signed into the log,
 * so an encoding mismatch between the UI and the rules would be unrecoverable
 * rather than merely wrong.
 */
export function encodeMove(plugin_id: string, json: string): Uint8Array;

/**
 * `null` while the game is in progress, otherwise the outcome as JSON.
 */
export function is_game_over(plugin_id: string, state: Uint8Array): string | undefined;

/**
 * Renders what one player is entitled to see, as JSON.
 */
export function player_view(plugin_id: string, state: Uint8Array, player: number): string;

/**
 * The rules version for a plugin. Clients refuse to start or resume a game
 * whose invite names a different one.
 */
export function plugin_version(plugin_id: string): number;

/**
 * Replays a game from its configuration and the moves taken from the log.
 *
 * Every move is validated in sequence, so a log that replays without error is
 * a log whose every move was legal under these rules.
 */
export function replay(
  plugin_id: string,
  config: Uint8Array,
  _private: Uint8Array,
  moves: Uint8Array[],
  assets: Uint8Array,
): Uint8Array;

/**
 * `assets` is the bulk reference data a game needs — a word list, say. It is
 * passed in because a plugin cannot fetch anything itself, and the game checks
 * it against the hash its configuration pins rather than trusting the host.
 *
 * `private` is what this device knows that the log does not say out loud:
 * entropy for a game that derives its own draws, or the tile values a deal has
 * opened to this player. Its shape is the game's business — a plugin that is
 * handed the wrong shape says so.
 */
export function setup(
  plugin_id: string,
  config: Uint8Array,
  _private: Uint8Array,
  assets: Uint8Array,
): Uint8Array;

export function validate_move(
  plugin_id: string,
  state: Uint8Array,
  mv: Uint8Array,
  player: number,
  assets: Uint8Array,
): void;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
  readonly memory: WebAssembly.Memory;
  readonly apply_move: (
    a: number,
    b: number,
    c: number,
    d: number,
    e: number,
    f: number,
    g: number,
    h: number,
  ) => [number, number, number, number];
  readonly available_plugins: () => [number, number];
  readonly deck: (a: number, b: number) => [number, number, number, number];
  readonly decodeMove: (
    a: number,
    b: number,
    c: number,
    d: number,
  ) => [number, number, number, number];
  readonly encodeMove: (
    a: number,
    b: number,
    c: number,
    d: number,
  ) => [number, number, number, number];
  readonly is_game_over: (
    a: number,
    b: number,
    c: number,
    d: number,
  ) => [number, number, number, number];
  readonly player_view: (
    a: number,
    b: number,
    c: number,
    d: number,
    e: number,
  ) => [number, number, number, number];
  readonly plugin_version: (a: number, b: number) => [number, number, number];
  readonly replay: (
    a: number,
    b: number,
    c: number,
    d: number,
    e: number,
    f: number,
    g: number,
    h: number,
    i: number,
    j: number,
  ) => [number, number, number, number];
  readonly setup: (
    a: number,
    b: number,
    c: number,
    d: number,
    e: number,
    f: number,
    g: number,
    h: number,
  ) => [number, number, number, number];
  readonly validate_move: (
    a: number,
    b: number,
    c: number,
    d: number,
    e: number,
    f: number,
    g: number,
    h: number,
    i: number,
  ) => [number, number];
  readonly __wbindgen_externrefs: WebAssembly.Table;
  readonly __wbindgen_malloc: (a: number, b: number) => number;
  readonly __wbindgen_realloc: (a: number, b: number, c: number, d: number) => number;
  readonly __externref_table_dealloc: (a: number) => void;
  readonly __wbindgen_free: (a: number, b: number, c: number) => void;
  readonly __externref_drop_slice: (a: number, b: number) => void;
  readonly __externref_table_alloc: () => number;
  readonly __wbindgen_start: () => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
 * Instantiates the given `module`, which can either be bytes or
 * a precompiled `WebAssembly.Module`.
 *
 * @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
 *
 * @returns {InitOutput}
 */
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
 * If `module_or_path` is {RequestInfo} or {URL}, makes a request and
 * for everything else, calls `WebAssembly.instantiate` directly.
 *
 * @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
 *
 * @returns {Promise<InitOutput>}
 */
export default function __wbg_init(
  module_or_path?:
    { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>,
): Promise<InitOutput>;
