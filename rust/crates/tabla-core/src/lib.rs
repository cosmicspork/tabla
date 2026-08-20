//! Core protocol primitives for tabla: canonical encoding, the signed
//! hash-chained game log, and all identity and session cryptography.
//!
//! Everything here is deterministic and side-effect free. **No randomness is
//! generated inside this crate** — every seed, nonce, and salt is supplied by
//! the caller. That keeps the same code running unchanged in the browser, in a
//! Web Worker, and under `cargo test`, makes every test reproducible, and means
//! the wasm build needs no JavaScript RNG shim.
//!
//! The relay never links against this crate. It cannot: it holds no keys and
//! verifies nothing.

pub mod error;
pub mod export;
pub mod identity;
pub mod invite;
pub mod kex;
pub mod log;
pub mod mailbox;
pub mod manifest;
pub mod seal;
pub mod session;

pub use error::CryptoError;
pub use identity::Identity;
pub use session::{EntryBody, Role, Session};

/// Length of a SHA-256 digest, used for entry hashes and public-key hashes.
pub const HASH_LEN: usize = 32;
/// Length of a game identifier.
pub const GAME_ID_LEN: usize = 16;
/// Length of an invite blob identifier.
pub const BLOB_ID_LEN: usize = 16;
/// Length of an Ed25519 signature.
pub const SIG_LEN: usize = 64;
/// Length of an Ed25519 or X25519 public key.
pub const PUBKEY_LEN: usize = 32;
/// Length of an identity seed (an Ed25519 private key).
pub const SEED_LEN: usize = 32;
/// Length of a symmetric key.
pub const KEY_LEN: usize = 32;
/// Length of an XChaCha20-Poly1305 nonce.
pub const NONCE_LEN: usize = 24;
