//! Letras: a word game for two, played a move at a time.
//!
//! The board, the tile set, and the name are original — see [`board`] and
//! [`tiles`] for how the layout and the distribution were arrived at, and
//! `wordlist/PROVENANCE.md` for the word list, which is public domain.
//!
//! Like every game here it is a pure function of its log: no clock, no
//! randomness beyond the seed it is handed, no reaching outside. Hidden state
//! makes that harder than tic tac toe found it, and how it is done is written up
//! in `ARCHITECTURE.md` under the fairness tiers.

pub mod audit;
pub mod board;
pub mod draw;
pub mod game;
pub mod tiles;

pub use game::{Action, Letras, Move, State, config_for};

/// The byte-level plugin the registry and the WASM boundary use.
pub type Plugin = tabla_plugin_api::Adapter<Letras>;

#[cfg(test)]
mod tests;
