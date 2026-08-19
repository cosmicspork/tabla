/** Wire protocol version. Peers refuse to interoperate across a mismatch. */
export const PROTOCOL_VERSION = 1;

/** Plugin bundled into the core app in phase 1. */
export const CORE_PLUGIN_ID = 'tictactoe';
export const CORE_PLUGIN_VERSION = 1;

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
