/**
 * Wire protocol version. Peers refuse to interoperate across a mismatch.
 *
 * v2 added the `presence` frame. There is no compatibility shim for v1: the
 * relay has never been deployed, so no client exists that speaks it.
 */
export const PROTOCOL_VERSION = 2;

/** The game bundled into the app, so a fresh install can play without a network. */
export const CORE_PLUGIN_ID = 'tictactoe';
export const CORE_PLUGIN_VERSION = 1;

/**
 * The key every plugin manifest in this build must be signed with.
 *
 * Pinning it here is what makes the manifest worth signing: an artifact hash
 * cannot change without someone holding the matching private key, which lives
 * outside the repository and is never available to CI.
 *
 * Rotating it means re-signing the manifest and shipping this constant in the
 * same release — an old build keeps trusting the old key, which is correct,
 * since it is also still running the artifacts that key signed.
 */
export const MANIFEST_SIGNING_PUBKEY =
  'dcf8f0b6b9eb93d8cc1f742268a00d4cd860bccb24a8eaf92c66d158b23174e4';

/**
 * The word list the word game plays against.
 *
 * The hash is written into every Letras invite, so both players prove they hold
 * the same dictionary before a game starts — a client with a different list
 * would disagree about whether a played word is real, and there is no
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
/** Most entries one WebSocket append frame may carry. */
export const MAX_APPEND_ENTRIES = 256;

/**
 * How many unread invitations one mailbox will hold.
 *
 * A contact could fill yours; nothing stops them, because the whole point is
 * that they may write to it. The cost is bounded here, and the answer is to
 * remove the contact — after which this device stops polling that mailbox and
 * whatever is in it expires unseen.
 */
export const MAILBOX_MAX_PENDING = 16;

/** Invites expire after this long with no claim. */
export const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * How long a device link stays open.
 *
 * Short on purpose. The blob is a whole installation under a passphrase two
 * people in a room can say out loud, so the window in which it exists at all is
 * the main thing keeping it small — and it is deleted the moment the other
 * device takes it, which is usually seconds.
 */
export const LINK_TTL_MS = 10 * 60 * 1000;

/**
 * The largest link bundle the relay will hold, before base64url.
 *
 * A Durable Object's SQLite values stop at 2 MB, so this leaves room for the
 * encoding. A device with more history than this links without the logs of its
 * oldest finished games; they are still listed, and still fetchable from their
 * rooms if the relay has them.
 */
export const LINK_MAX_BYTES = 1024 * 1024;

/**
 * The longest a device may claim the next move for.
 *
 * Only a ceiling: a device asks for two minutes and renews while a move is
 * being built. This stops one from asking for a week and locking your other
 * devices out of a game.
 */
export const HOLD_MAX_MS = 3 * 60 * 1000;
/** A single turn reminder is sent after this much inactivity. */
export const TURN_REMINDER_MS = 24 * 60 * 60 * 1000;
/** Ciphertext is evicted after this much inactivity, leaving only a tombstone. */
export const RETENTION_MS = 90 * 24 * 60 * 60 * 1000;
