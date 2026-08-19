/** Wire protocol version. Peers refuse to interoperate across a mismatch. */
export const PROTOCOL_VERSION = 1;

/** Plugin bundled into the core app in phase 1. */
export const CORE_PLUGIN_ID = 'tictactoe';
export const CORE_PLUGIN_VERSION = 1;

/**
 * The word list the word game plays against.
 *
 * The hash is written into every Letras invite, so both players prove they hold
 * the same dictionary before a game starts — a client with a different list
 * would disagree about whether a challenged word is real, and there is no
 * recovering from that once a game is under way.
 *
 * Pinned in `rust/crates/tabla-dawg/tests/golden_dictionary.rs` too, where a
 * test rebuilds it from `wordlist/enable.txt` and asserts the bytes are
 * identical. A new list ships as a new id, never as an overwrite.
 */
export const DICTIONARY_EN_V1 = {
  id: 'en-v1',
  path: '/dict/en-v1.dawg',
  sha256: '492410d02d6c346bba503cae0483202554d1d36f8e8c5a3d21faa956398a2346',
  words: 172_823,
} as const;

/** Byte lengths shared with the Rust core (see rust/crates/tabla-core/src/lib.rs). */
export const HASH_LEN = 32;
export const GAME_ID_LEN = 16;
export const SIG_LEN = 64;
export const PUBKEY_LEN = 32;
export const BLOB_ID_LEN = 16;

/** Relay limits. Entries larger than this are rejected by the room DO. */
export const MAX_ENTRY_BYTES = 64 * 1024;

/** Invites expire after this long with no claim. */
export const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** A single turn reminder is sent after this much inactivity. */
export const TURN_REMINDER_MS = 24 * 60 * 60 * 1000;
/** Ciphertext is evicted after this much inactivity, leaving only a tombstone. */
export const RETENTION_MS = 90 * 24 * 60 * 60 * 1000;
