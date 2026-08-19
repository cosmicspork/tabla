//! Dealing hidden tiles between two devices with nothing trusted in between.
//!
//! This is the cryptography behind the tile bag: a deck that both players
//! shuffle without either learning its order, tiles that open to exactly one
//! player at a time, and proofs at every step that nobody added, removed, or
//! swapped anything. It is the standard mental-poker construction — threshold
//! ElGamal over ristretto255 with a Bayer-Groth argument of correct shuffle —
//! and it replaces the private draw streams the word game used before, which
//! could only make cheating *visible afterwards* rather than impossible.
//!
//! Two rules hold throughout, both inherited from `tabla-core`:
//!
//! **No randomness is generated here.** Every permutation and every blinding
//! factor is expanded from entropy the caller supplies. That keeps proving
//! reproducible under `cargo test`, needs no RNG shim in wasm, and makes the
//! frozen test vectors possible.
//!
//! **Nothing here is a secret the protocol depends on hiding from its owner.**
//! A player's own decryption share is theirs; the protocol assumes both players
//! run modified clients and derives its guarantees from the proofs, not from
//! anyone's discretion.
//!
//! ## Where this crate may be linked
//!
//! Into the core wasm module, which already holds keys — never into a plugin
//! module. Game rules receive tile values as facts the host has already
//! verified, exactly as they already receive move bytes whose signatures the
//! log layer checked. A test scans the built plugin artifact for `curve25519`
//! and fails if this crate ever reaches it.

pub mod elgamal;
pub mod encoding;
pub mod error;
pub mod generators;
pub mod proofs;
pub mod transcript;

pub use elgamal::{Ciphertext, KeyShare, PublicShare};
pub use error::DealError;
pub use transcript::Transcript;

/// Length of a compressed ristretto255 point.
pub const POINT_LEN: usize = 32;
/// Length of a canonically encoded scalar.
pub const SCALAR_LEN: usize = 32;
/// Length of an ElGamal ciphertext: two points.
pub const CIPHERTEXT_LEN: usize = POINT_LEN * 2;
/// Length of the entropy a caller supplies for one proving operation.
pub const ENTROPY_LEN: usize = 32;
