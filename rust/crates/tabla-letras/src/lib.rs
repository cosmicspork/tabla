//! Letras: a word game for two, played a move at a time.
//!
//! The board, the tile set, and the name are original — see [`board`] and
//! [`tiles`] for how the layout and the distribution were arrived at, and
//! `wordlist/PROVENANCE.md` for the word list, which is public domain.
//!
//! Like every game here it is a pure function of its log: no clock, no
//! randomness beyond what it is handed, no reaching outside.
//!
//! # Two versions
//!
//! The board, the tiles, and every rule about words are shared. What differs is
//! how tiles are dealt, and that difference is deep enough to be a separate set
//! of rules rather than a flag:
//!
//! - [`v1`] deals from private draw streams and audits them when the game ends.
//!   Cheating is detectable afterwards. Games started this way finish this way.
//! - [`v2`] deals from a shared encrypted deck that neither player can read,
//!   with the host proving every step. Cheating is impossible rather than
//!   visible, and tile counting is exact.
//!
//! Both ship as their own module, pinned by hash in the signed manifest, so a
//! game in progress never changes rules underneath the people playing it.

pub mod board;
pub mod tiles;
pub mod v1;
pub mod v2;
pub mod v3;

/// The current rules. New games use these.
pub use v3::{Action, Letras, Move, State, config_for};

/// The byte-level plugin the registry and the WASM boundary use.
pub type Plugin = tabla_plugin_api::Adapter<Letras>;

#[cfg(test)]
mod tests;
