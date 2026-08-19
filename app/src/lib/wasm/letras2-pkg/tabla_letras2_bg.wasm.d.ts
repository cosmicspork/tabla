/* tslint:disable */
/* eslint-disable */
export const memory: WebAssembly.Memory;
export const apply_move: (
  a: number,
  b: number,
  c: number,
  d: number,
  e: number,
  f: number,
  g: number,
  h: number,
) => [number, number, number, number];
export const available_plugins: () => [number, number];
export const decodeMove: (
  a: number,
  b: number,
  c: number,
  d: number,
) => [number, number, number, number];
export const encodeMove: (
  a: number,
  b: number,
  c: number,
  d: number,
) => [number, number, number, number];
export const is_game_over: (
  a: number,
  b: number,
  c: number,
  d: number,
) => [number, number, number, number];
export const player_view: (
  a: number,
  b: number,
  c: number,
  d: number,
  e: number,
) => [number, number, number, number];
export const plugin_version: (a: number, b: number) => [number, number, number];
export const replay: (
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
export const setup: (
  a: number,
  b: number,
  c: number,
  d: number,
  e: number,
  f: number,
  g: number,
  h: number,
) => [number, number, number, number];
export const validate_move: (
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
export const __wbindgen_externrefs: WebAssembly.Table;
export const __wbindgen_malloc: (a: number, b: number) => number;
export const __wbindgen_realloc: (a: number, b: number, c: number, d: number) => number;
export const __externref_table_dealloc: (a: number) => void;
export const __wbindgen_free: (a: number, b: number, c: number) => void;
export const __externref_drop_slice: (a: number, b: number) => void;
export const __externref_table_alloc: () => number;
export const __wbindgen_start: () => void;
