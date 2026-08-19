/* @ts-self-types="./tabla_letras2.d.ts" */

/**
 * @param {string} plugin_id
 * @param {Uint8Array} state
 * @param {Uint8Array} mv
 * @param {Uint8Array} assets
 * @returns {Uint8Array}
 */
export function apply_move(plugin_id, state, mv, assets) {
  const ptr0 = passStringToWasm0(plugin_id, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
  const len0 = WASM_VECTOR_LEN;
  const ptr1 = passArray8ToWasm0(state, wasm.__wbindgen_malloc);
  const len1 = WASM_VECTOR_LEN;
  const ptr2 = passArray8ToWasm0(mv, wasm.__wbindgen_malloc);
  const len2 = WASM_VECTOR_LEN;
  const ptr3 = passArray8ToWasm0(assets, wasm.__wbindgen_malloc);
  const len3 = WASM_VECTOR_LEN;
  const ret = wasm.apply_move(ptr0, len0, ptr1, len1, ptr2, len2, ptr3, len3);
  if (ret[3]) {
    throw takeFromExternrefTable0(ret[2]);
  }
  var v5 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
  wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
  return v5;
}

/**
 * Plugin identifiers this module can play.
 * @returns {string[]}
 */
export function available_plugins() {
  const ret = wasm.available_plugins();
  var v1 = getArrayJsValueFromWasm0(ret[0], ret[1]);
  wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
  return v1;
}

/**
 * Renders an encoded move back as JSON.
 * @param {string} plugin_id
 * @param {Uint8Array} bytes
 * @returns {string}
 */
export function decodeMove(plugin_id, bytes) {
  let deferred4_0;
  let deferred4_1;
  try {
    const ptr0 = passStringToWasm0(plugin_id, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passArray8ToWasm0(bytes, wasm.__wbindgen_malloc);
    const len1 = WASM_VECTOR_LEN;
    const ret = wasm.decodeMove(ptr0, len0, ptr1, len1);
    var ptr3 = ret[0];
    var len3 = ret[1];
    if (ret[3]) {
      ptr3 = 0;
      len3 = 0;
      throw takeFromExternrefTable0(ret[2]);
    }
    deferred4_0 = ptr3;
    deferred4_1 = len3;
    return getStringFromWasm0(ptr3, len3);
  } finally {
    wasm.__wbindgen_free(deferred4_0, deferred4_1, 1);
  }
}

/**
 * Encodes a move described as JSON (`{"cell":4}`) into its wire form.
 *
 * The UI never serializes moves itself: those bytes are signed into the log,
 * so an encoding mismatch between the UI and the rules would be unrecoverable
 * rather than merely wrong.
 * @param {string} plugin_id
 * @param {string} json
 * @returns {Uint8Array}
 */
export function encodeMove(plugin_id, json) {
  const ptr0 = passStringToWasm0(plugin_id, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
  const len0 = WASM_VECTOR_LEN;
  const ptr1 = passStringToWasm0(json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
  const len1 = WASM_VECTOR_LEN;
  const ret = wasm.encodeMove(ptr0, len0, ptr1, len1);
  if (ret[3]) {
    throw takeFromExternrefTable0(ret[2]);
  }
  var v3 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
  wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
  return v3;
}

/**
 * `null` while the game is in progress, otherwise the outcome as JSON.
 * @param {string} plugin_id
 * @param {Uint8Array} state
 * @returns {string | undefined}
 */
export function is_game_over(plugin_id, state) {
  const ptr0 = passStringToWasm0(plugin_id, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
  const len0 = WASM_VECTOR_LEN;
  const ptr1 = passArray8ToWasm0(state, wasm.__wbindgen_malloc);
  const len1 = WASM_VECTOR_LEN;
  const ret = wasm.is_game_over(ptr0, len0, ptr1, len1);
  if (ret[3]) {
    throw takeFromExternrefTable0(ret[2]);
  }
  let v3;
  if (ret[0] !== 0) {
    v3 = getStringFromWasm0(ret[0], ret[1]);
    wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
  }
  return v3;
}

/**
 * Renders what one player is entitled to see, as JSON.
 * @param {string} plugin_id
 * @param {Uint8Array} state
 * @param {number} player
 * @returns {string}
 */
export function player_view(plugin_id, state, player) {
  let deferred4_0;
  let deferred4_1;
  try {
    const ptr0 = passStringToWasm0(plugin_id, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passArray8ToWasm0(state, wasm.__wbindgen_malloc);
    const len1 = WASM_VECTOR_LEN;
    const ret = wasm.player_view(ptr0, len0, ptr1, len1, player);
    var ptr3 = ret[0];
    var len3 = ret[1];
    if (ret[3]) {
      ptr3 = 0;
      len3 = 0;
      throw takeFromExternrefTable0(ret[2]);
    }
    deferred4_0 = ptr3;
    deferred4_1 = len3;
    return getStringFromWasm0(ptr3, len3);
  } finally {
    wasm.__wbindgen_free(deferred4_0, deferred4_1, 1);
  }
}

/**
 * The rules version for a plugin. Clients refuse to start or resume a game
 * whose invite names a different one.
 * @param {string} plugin_id
 * @returns {number}
 */
export function plugin_version(plugin_id) {
  const ptr0 = passStringToWasm0(plugin_id, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
  const len0 = WASM_VECTOR_LEN;
  const ret = wasm.plugin_version(ptr0, len0);
  if (ret[2]) {
    throw takeFromExternrefTable0(ret[1]);
  }
  return ret[0] >>> 0;
}

/**
 * Replays a game from its configuration and the moves taken from the log.
 *
 * Every move is validated in sequence, so a log that replays without error is
 * a log whose every move was legal under these rules.
 * @param {string} plugin_id
 * @param {Uint8Array} config
 * @param {Uint8Array} _private
 * @param {Uint8Array[]} moves
 * @param {Uint8Array} assets
 * @returns {Uint8Array}
 */
export function replay(plugin_id, config, _private, moves, assets) {
  const ptr0 = passStringToWasm0(plugin_id, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
  const len0 = WASM_VECTOR_LEN;
  const ptr1 = passArray8ToWasm0(config, wasm.__wbindgen_malloc);
  const len1 = WASM_VECTOR_LEN;
  const ptr2 = passArray8ToWasm0(_private, wasm.__wbindgen_malloc);
  const len2 = WASM_VECTOR_LEN;
  const ptr3 = passArrayJsValueToWasm0(moves, wasm.__wbindgen_malloc);
  const len3 = WASM_VECTOR_LEN;
  const ptr4 = passArray8ToWasm0(assets, wasm.__wbindgen_malloc);
  const len4 = WASM_VECTOR_LEN;
  const ret = wasm.replay(ptr0, len0, ptr1, len1, ptr2, len2, ptr3, len3, ptr4, len4);
  if (ret[3]) {
    throw takeFromExternrefTable0(ret[2]);
  }
  var v6 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
  wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
  return v6;
}

/**
 * `assets` is the bulk reference data a game needs — a word list, say. It is
 * passed in because a plugin cannot fetch anything itself, and the game checks
 * it against the hash its configuration pins rather than trusting the host.
 *
 * `private` is what this device knows that the log does not say out loud:
 * entropy for a game that derives its own draws, or the tile values a deal has
 * opened to this player. Its shape is the game's business — a plugin that is
 * handed the wrong shape says so.
 * @param {string} plugin_id
 * @param {Uint8Array} config
 * @param {Uint8Array} _private
 * @param {Uint8Array} assets
 * @returns {Uint8Array}
 */
export function setup(plugin_id, config, _private, assets) {
  const ptr0 = passStringToWasm0(plugin_id, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
  const len0 = WASM_VECTOR_LEN;
  const ptr1 = passArray8ToWasm0(config, wasm.__wbindgen_malloc);
  const len1 = WASM_VECTOR_LEN;
  const ptr2 = passArray8ToWasm0(_private, wasm.__wbindgen_malloc);
  const len2 = WASM_VECTOR_LEN;
  const ptr3 = passArray8ToWasm0(assets, wasm.__wbindgen_malloc);
  const len3 = WASM_VECTOR_LEN;
  const ret = wasm.setup(ptr0, len0, ptr1, len1, ptr2, len2, ptr3, len3);
  if (ret[3]) {
    throw takeFromExternrefTable0(ret[2]);
  }
  var v5 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
  wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
  return v5;
}

/**
 * @param {string} plugin_id
 * @param {Uint8Array} state
 * @param {Uint8Array} mv
 * @param {number} player
 * @param {Uint8Array} assets
 */
export function validate_move(plugin_id, state, mv, player, assets) {
  const ptr0 = passStringToWasm0(plugin_id, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
  const len0 = WASM_VECTOR_LEN;
  const ptr1 = passArray8ToWasm0(state, wasm.__wbindgen_malloc);
  const len1 = WASM_VECTOR_LEN;
  const ptr2 = passArray8ToWasm0(mv, wasm.__wbindgen_malloc);
  const len2 = WASM_VECTOR_LEN;
  const ptr3 = passArray8ToWasm0(assets, wasm.__wbindgen_malloc);
  const len3 = WASM_VECTOR_LEN;
  const ret = wasm.validate_move(ptr0, len0, ptr1, len1, ptr2, len2, player, ptr3, len3);
  if (ret[1]) {
    throw takeFromExternrefTable0(ret[0]);
  }
}
function __wbg_get_imports() {
  const import0 = {
    __proto__: null,
    __wbg_Error_408e67f47ca7b58b: function (arg0, arg1) {
      const ret = Error(getStringFromWasm0(arg0, arg1));
      return ret;
    },
    __wbg___wbindgen_throw_bb96b2010945f0bc: function (arg0, arg1) {
      throw new Error(getStringFromWasm0(arg0, arg1));
    },
    __wbg_length_36bd29c6848c2144: function (arg0) {
      const ret = arg0.length;
      return ret;
    },
    __wbg_prototypesetcall_de8e0d9553586985: function (arg0, arg1, arg2) {
      Uint8Array.prototype.set.call(getArrayU8FromWasm0(arg0, arg1), arg2);
    },
    __wbindgen_cast_0000000000000001: function (arg0, arg1) {
      // Cast intrinsic for `Ref(String) -> Externref`.
      const ret = getStringFromWasm0(arg0, arg1);
      return ret;
    },
    __wbindgen_init_externref_table: function () {
      const table = wasm.__wbindgen_externrefs;
      const offset = table.grow(4);
      table.set(0, undefined);
      table.set(offset + 0, undefined);
      table.set(offset + 1, null);
      table.set(offset + 2, true);
      table.set(offset + 3, false);
    },
  };
  return {
    __proto__: null,
    './tabla_letras2_bg.js': import0,
  };
}

function addToExternrefTable0(obj) {
  const idx = wasm.__externref_table_alloc();
  wasm.__wbindgen_externrefs.set(idx, obj);
  return idx;
}

function getArrayJsValueFromWasm0(ptr, len) {
  ptr = ptr >>> 0;
  const mem = getDataViewMemory0();
  const result = [];
  for (let i = ptr; i < ptr + 4 * len; i += 4) {
    result.push(wasm.__wbindgen_externrefs.get(mem.getUint32(i, true)));
  }
  wasm.__externref_drop_slice(ptr, len);
  return result;
}

function getArrayU8FromWasm0(ptr, len) {
  ptr = ptr >>> 0;
  return getUint8ArrayMemory0().subarray(ptr / 1, ptr / 1 + len);
}

let cachedDataViewMemory0 = null;
function getDataViewMemory0() {
  if (
    cachedDataViewMemory0 === null ||
    cachedDataViewMemory0.buffer.detached === true ||
    (cachedDataViewMemory0.buffer.detached === undefined &&
      cachedDataViewMemory0.buffer !== wasm.memory.buffer)
  ) {
    cachedDataViewMemory0 = new DataView(wasm.memory.buffer);
  }
  return cachedDataViewMemory0;
}

function getStringFromWasm0(ptr, len) {
  return decodeText(ptr >>> 0, len);
}

let cachedUint8ArrayMemory0 = null;
function getUint8ArrayMemory0() {
  if (cachedUint8ArrayMemory0 === null || cachedUint8ArrayMemory0.byteLength === 0) {
    cachedUint8ArrayMemory0 = new Uint8Array(wasm.memory.buffer);
  }
  return cachedUint8ArrayMemory0;
}

function passArray8ToWasm0(arg, malloc) {
  const ptr = malloc(arg.length * 1, 1) >>> 0;
  getUint8ArrayMemory0().set(arg, ptr / 1);
  WASM_VECTOR_LEN = arg.length;
  return ptr;
}

function passArrayJsValueToWasm0(array, malloc) {
  const ptr = malloc(array.length * 4, 4) >>> 0;
  for (let i = 0; i < array.length; i++) {
    const add = addToExternrefTable0(array[i]);
    getDataViewMemory0().setUint32(ptr + 4 * i, add, true);
  }
  WASM_VECTOR_LEN = array.length;
  return ptr;
}

function passStringToWasm0(arg, malloc, realloc) {
  if (realloc === undefined) {
    const buf = cachedTextEncoder.encode(arg);
    const ptr = malloc(buf.length, 1) >>> 0;
    getUint8ArrayMemory0()
      .subarray(ptr, ptr + buf.length)
      .set(buf);
    WASM_VECTOR_LEN = buf.length;
    return ptr;
  }

  let len = arg.length;
  let ptr = malloc(len, 1) >>> 0;

  const mem = getUint8ArrayMemory0();

  let offset = 0;

  for (; offset < len; offset++) {
    const code = arg.charCodeAt(offset);
    if (code > 0x7f) break;
    mem[ptr + offset] = code;
  }
  if (offset !== len) {
    if (offset !== 0) {
      arg = arg.slice(offset);
    }
    ptr = realloc(ptr, len, (len = offset + arg.length * 3), 1) >>> 0;
    const view = getUint8ArrayMemory0().subarray(ptr + offset, ptr + len);
    const ret = cachedTextEncoder.encodeInto(arg, view);

    offset += ret.written;
    ptr = realloc(ptr, len, offset, 1) >>> 0;
  }

  WASM_VECTOR_LEN = offset;
  return ptr;
}

function takeFromExternrefTable0(idx) {
  const value = wasm.__wbindgen_externrefs.get(idx);
  wasm.__externref_table_dealloc(idx);
  return value;
}

let cachedTextDecoder = new TextDecoder('utf-8', { ignoreBOM: true, fatal: true });
cachedTextDecoder.decode();
const MAX_SAFARI_DECODE_BYTES = 2146435072;
let numBytesDecoded = 0;
function decodeText(ptr, len) {
  numBytesDecoded += len;
  if (numBytesDecoded >= MAX_SAFARI_DECODE_BYTES) {
    cachedTextDecoder = new TextDecoder('utf-8', { ignoreBOM: true, fatal: true });
    cachedTextDecoder.decode();
    numBytesDecoded = len;
  }
  return cachedTextDecoder.decode(getUint8ArrayMemory0().subarray(ptr, ptr + len));
}

const cachedTextEncoder = new TextEncoder();

if (!('encodeInto' in cachedTextEncoder)) {
  cachedTextEncoder.encodeInto = function (arg, view) {
    const buf = cachedTextEncoder.encode(arg);
    view.set(buf);
    return {
      read: arg.length,
      written: buf.length,
    };
  };
}

let WASM_VECTOR_LEN = 0;

let wasmModule, wasmInstance, wasm;
function __wbg_finalize_init(instance, module) {
  wasmInstance = instance;
  wasm = instance.exports;
  wasmModule = module;
  cachedDataViewMemory0 = null;
  cachedUint8ArrayMemory0 = null;
  wasm.__wbindgen_start();
  return wasm;
}

async function __wbg_load(module, imports) {
  if (typeof Response === 'function' && module instanceof Response) {
    if (!module.ok) {
      throw new Error(
        `failed to fetch Wasm: ${module.status} ${module.statusText} fetching '${module.url}'`,
      );
    }

    if (typeof WebAssembly.instantiateStreaming === 'function') {
      try {
        return await WebAssembly.instantiateStreaming(module, imports);
      } catch (e) {
        const validResponse = expectedResponseType(module.type);

        if (validResponse && module.headers.get('Content-Type') !== 'application/wasm') {
          console.warn(
            '`WebAssembly.instantiateStreaming` failed because your server does not serve Wasm with `application/wasm` MIME type. Falling back to `WebAssembly.instantiate` which is slower. Original error:\n',
            e,
          );
        } else {
          throw e;
        }
      }
    }

    const bytes = await module.arrayBuffer();
    return await WebAssembly.instantiate(bytes, imports);
  } else {
    const instance = await WebAssembly.instantiate(module, imports);

    if (instance instanceof WebAssembly.Instance) {
      return { instance, module };
    } else {
      return instance;
    }
  }

  function expectedResponseType(type) {
    switch (type) {
      case 'basic':
      case 'cors':
      case 'default':
        return true;
    }
    return false;
  }
}

function initSync(module) {
  if (wasm !== undefined) return wasm;

  if (module !== undefined) {
    if (Object.getPrototypeOf(module) === Object.prototype) {
      ({ module } = module);
    } else {
      console.warn('using deprecated parameters for `initSync()`; pass a single object instead');
    }
  }

  const imports = __wbg_get_imports();
  if (!(module instanceof WebAssembly.Module)) {
    module = new WebAssembly.Module(module);
  }
  const instance = new WebAssembly.Instance(module, imports);
  return __wbg_finalize_init(instance, module);
}

async function __wbg_init(module_or_path) {
  if (wasm !== undefined) return wasm;

  if (module_or_path !== undefined) {
    if (Object.getPrototypeOf(module_or_path) === Object.prototype) {
      ({ module_or_path } = module_or_path);
    } else {
      console.warn(
        'using deprecated parameters for the initialization function; pass a single object instead',
      );
    }
  }

  if (module_or_path === undefined) {
    throw new Error('letras module bytes must be provided by the host');
  }
  const imports = __wbg_get_imports();

  if (
    typeof module_or_path === 'string' ||
    (typeof Request === 'function' && module_or_path instanceof Request) ||
    (typeof URL === 'function' && module_or_path instanceof URL)
  ) {
    module_or_path = fetch(module_or_path);
  }

  const { instance, module } = await __wbg_load(await module_or_path, imports);

  return __wbg_finalize_init(instance, module);
}

export { initSync, __wbg_init as default };
