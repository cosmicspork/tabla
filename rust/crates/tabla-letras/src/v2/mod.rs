//! Letras dealt from a shared encrypted deck. The current rules.
//!
//! See [`game`] for how the deal changes the game, and `ARCHITECTURE.md` under
//! the fairness tiers for why it replaced [`crate::v1`]'s private draw streams.

pub mod game;

pub use game::{Action, Laid, Letras, Move, Private, State, View, config_for};

/// The byte-level plugin for version 2.
pub type Plugin = tabla_plugin_api::Adapter<Letras>;
