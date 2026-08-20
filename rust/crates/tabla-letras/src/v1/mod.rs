//! Letras as it was first built: private draw streams with an end-of-game audit.
//!
//! Kept whole and unchanged so games started under these rules can be finished
//! under them. The tile bag here is not a bag at all — each player draws from
//! the tiles *they* have not seen, using a secret derived from their identity,
//! and both secrets are published at the end so every draw can be recomputed
//! and checked. Cheating is made visible afterwards rather than impossible.
//!
//! [`super::v2`] replaces that with a real shared deck neither player can read,
//! which is what the deal protocol buys. The cost these rules paid — the same
//! tile briefly existing twice, and tile counting being softened as a result —
//! is gone there. See ARCHITECTURE.md under the fairness tiers.
//!
//! Nothing in this module should change. Its compiled artifact is committed and
//! pinned by hash, and a rebuild that altered a byte would strand every game
//! still being played under it.

pub mod audit;
pub mod draw;
pub mod game;

pub use game::{Action, Letras, Move, State, config_for};

/// The byte-level plugin for version 1.
pub type Plugin = tabla_plugin_api::Adapter<Letras>;
