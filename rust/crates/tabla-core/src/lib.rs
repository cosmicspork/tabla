//! Core protocol primitives for tabla: canonical encoding, the signed hash-chained
//! game log, and all identity/session cryptography.
//!
//! Everything here is deterministic and side-effect free. Randomness is always
//! supplied by the caller so the same code runs unchanged in the browser, in a
//! Web Worker, and under `cargo test`.

pub mod log;

/// Length of a SHA-256 digest, used for entry hashes and public-key hashes.
pub const HASH_LEN: usize = 32;
/// Length of a game identifier.
pub const GAME_ID_LEN: usize = 16;
/// Length of an Ed25519 signature.
pub const SIG_LEN: usize = 64;
/// Length of an Ed25519 or X25519 public key.
pub const PUBKEY_LEN: usize = 32;
