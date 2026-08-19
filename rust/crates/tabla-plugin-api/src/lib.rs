//! The game plugin interface.
//!
//! A plugin is a set of **pure functions over bytes**. It has no network access,
//! no key access, and no storage access — not by convention, but because it is
//! never handed any. Everything a plugin can touch arrives as a function
//! argument, and the only thing it can do is return a value.
//!
//! That is what makes the end-to-end encryption claim real. The core app owns
//! all I/O, all cryptography, and all relay traffic; a plugin can compute the
//! consequences of a move and nothing else. In the browser, plugins additionally
//! run inside a Web Worker whose `fetch`, `XMLHttpRequest`, and `WebSocket` are
//! deleted at startup, so even a compromised plugin has nowhere to send
//! anything.
//!
//! Two layers live here:
//!
//! - [`GamePlugin`], a typed trait that games implement.
//! - [`BytePlugin`], a dyn-safe byte-level view of the same thing, which
//!   [`Adapter`] derives automatically. The registry and the WASM boundary speak
//!   [`BytePlugin`]; game authors never write it by hand.

use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};

/// Which player: 0 is the initiator (who moves first), 1 is the claimer.
pub type PlayerId = u8;

pub const PLAYER_INITIATOR: PlayerId = 0;
pub const PLAYER_CLAIMER: PlayerId = 1;

/// How a finished game ended.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Outcome {
    Winner { player: PlayerId },
    Draw,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum PluginError {
    /// The setup configuration was not understood.
    BadConfig,
    /// Serialized state could not be decoded.
    BadState,
    /// The move could not be decoded.
    BadMove,
    /// A player moved when it was not their turn.
    NotYourTurn,
    /// The move decoded but breaks the game's rules.
    IllegalMove { reason: &'static str },
    /// A move was submitted after the game ended.
    GameOver,
    /// The view could not be rendered as JSON.
    BadView,
}

impl core::fmt::Display for PluginError {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        match self {
            Self::BadConfig => f.write_str("invalid game configuration"),
            Self::BadState => f.write_str("invalid game state"),
            Self::BadMove => f.write_str("move could not be decoded"),
            Self::NotYourTurn => f.write_str("not your turn"),
            Self::IllegalMove { reason } => write!(f, "illegal move: {reason}"),
            Self::GameOver => f.write_str("the game is already over"),
            Self::BadView => f.write_str("could not render player view"),
        }
    }
}

impl core::error::Error for PluginError {}

/// A game's rules, as pure functions.
///
/// Implementations must be **deterministic**: the same inputs must produce the
/// same outputs on every device and every build, because both clients replay the
/// same log independently and any divergence is an unrecoverable desync. That
/// rules out wall-clock time, ambient randomness, and iteration over unordered
/// collections. Any randomness a game needs comes from `seed`.
pub trait GamePlugin {
    /// Stable identifier carried in the invite blob.
    const ID: &'static str;
    /// Bumped whenever rules change in a way that alters validation.
    const VERSION: u32;

    type State: Serialize + DeserializeOwned;
    type Move: Serialize + DeserializeOwned;
    type View: Serialize;

    /// Builds the starting state.
    ///
    /// `seed` is the jointly derived entropy for the game. Tic tac toe ignores
    /// it; games with hidden state use it to shuffle deterministically so that
    /// both clients agree and the shuffle can be audited afterwards.
    fn setup(config: &[u8], seed: &[u8; 32]) -> Result<Self::State, PluginError>;

    /// Checks a move without applying it.
    fn validate_move(
        state: &Self::State,
        mv: &Self::Move,
        player: PlayerId,
    ) -> Result<(), PluginError>;

    /// Applies a move that [`Self::validate_move`] has already accepted.
    fn apply_move(state: Self::State, mv: &Self::Move) -> Result<Self::State, PluginError>;

    /// What one player is entitled to see.
    ///
    /// This exists so a game with hidden state can be rendered without the
    /// renderer ever holding the parts that player may not see.
    fn player_view(state: &Self::State, player: PlayerId) -> Self::View;

    /// `None` while the game is still in progress.
    fn is_game_over(state: &Self::State) -> Option<Outcome>;
}

/// Byte-level, dyn-safe view of a plugin. Produced by [`Adapter`].
///
/// State and moves cross this boundary as postcard; views cross as JSON,
/// because the other side of the view boundary is a UI written in TypeScript.
pub trait BytePlugin {
    fn id(&self) -> &'static str;
    fn version(&self) -> u32;

    fn setup(&self, config: &[u8], seed: &[u8; 32]) -> Result<Vec<u8>, PluginError>;
    fn validate_move(&self, state: &[u8], mv: &[u8], player: PlayerId) -> Result<(), PluginError>;
    fn apply_move(&self, state: &[u8], mv: &[u8]) -> Result<Vec<u8>, PluginError>;
    fn player_view(&self, state: &[u8], player: PlayerId) -> Result<Vec<u8>, PluginError>;
    fn is_game_over(&self, state: &[u8]) -> Result<Option<Outcome>, PluginError>;

    /// Replays a whole game from its configuration and move list.
    ///
    /// This is how a client turns a decrypted log into a current position: every
    /// move is validated in sequence, so a log that replays cleanly is a log
    /// whose every move was legal.
    fn replay(
        &self,
        config: &[u8],
        seed: &[u8; 32],
        moves: &[Vec<u8>],
    ) -> Result<Vec<u8>, PluginError>;

    /// Turns a move described as JSON into its canonical wire encoding.
    ///
    /// The UI describes moves in its own terms (`{"cell":4}`) and the plugin
    /// owns how they are serialized. Without this the UI would have to hand-roll
    /// the encoding, which would silently break the moment a game changed its
    /// move type — and those bytes are signed into the log, so a mismatch is
    /// unrecoverable rather than merely wrong.
    fn encode_move(&self, json: &str) -> Result<Vec<u8>, PluginError>;

    /// Renders an encoded move back as JSON, for display and debugging.
    fn decode_move(&self, bytes: &[u8]) -> Result<String, PluginError>;
}

/// Bridges a typed [`GamePlugin`] to the byte-level [`BytePlugin`].
pub struct Adapter<P: GamePlugin>(core::marker::PhantomData<P>);

impl<P: GamePlugin> Adapter<P> {
    pub const fn new() -> Self {
        Self(core::marker::PhantomData)
    }
}

impl<P: GamePlugin> Default for Adapter<P> {
    fn default() -> Self {
        Self::new()
    }
}

fn decode<T: DeserializeOwned>(bytes: &[u8], err: PluginError) -> Result<T, PluginError> {
    postcard::from_bytes(bytes).map_err(|_| err)
}

fn encode<T: Serialize>(value: &T, err: PluginError) -> Result<Vec<u8>, PluginError> {
    postcard::to_allocvec(value).map_err(|_| err)
}

impl<P: GamePlugin> BytePlugin for Adapter<P> {
    fn id(&self) -> &'static str {
        P::ID
    }

    fn version(&self) -> u32 {
        P::VERSION
    }

    fn setup(&self, config: &[u8], seed: &[u8; 32]) -> Result<Vec<u8>, PluginError> {
        encode(&P::setup(config, seed)?, PluginError::BadState)
    }

    fn validate_move(&self, state: &[u8], mv: &[u8], player: PlayerId) -> Result<(), PluginError> {
        let state: P::State = decode(state, PluginError::BadState)?;
        let mv: P::Move = decode(mv, PluginError::BadMove)?;
        P::validate_move(&state, &mv, player)
    }

    fn apply_move(&self, state: &[u8], mv: &[u8]) -> Result<Vec<u8>, PluginError> {
        let state: P::State = decode(state, PluginError::BadState)?;
        let mv: P::Move = decode(mv, PluginError::BadMove)?;
        encode(&P::apply_move(state, &mv)?, PluginError::BadState)
    }

    fn player_view(&self, state: &[u8], player: PlayerId) -> Result<Vec<u8>, PluginError> {
        let state: P::State = decode(state, PluginError::BadState)?;
        serde_json::to_vec(&P::player_view(&state, player)).map_err(|_| PluginError::BadView)
    }

    fn is_game_over(&self, state: &[u8]) -> Result<Option<Outcome>, PluginError> {
        let state: P::State = decode(state, PluginError::BadState)?;
        Ok(P::is_game_over(&state))
    }

    fn replay(
        &self,
        config: &[u8],
        seed: &[u8; 32],
        moves: &[Vec<u8>],
    ) -> Result<Vec<u8>, PluginError> {
        let mut state = P::setup(config, seed)?;

        for (i, raw) in moves.iter().enumerate() {
            if P::is_game_over(&state).is_some() {
                return Err(PluginError::GameOver);
            }
            let mv: P::Move = decode(raw, PluginError::BadMove)?;

            // Move i is made by whoever's turn it is: the initiator plays the
            // even-numbered moves. This mirrors the log's turn discipline, and
            // the two checks are deliberately independent.
            let player = if i % 2 == 0 {
                PLAYER_INITIATOR
            } else {
                PLAYER_CLAIMER
            };

            P::validate_move(&state, &mv, player)?;
            state = P::apply_move(state, &mv)?;
        }

        encode(&state, PluginError::BadState)
    }

    fn encode_move(&self, json: &str) -> Result<Vec<u8>, PluginError> {
        let mv: P::Move = serde_json::from_str(json).map_err(|_| PluginError::BadMove)?;
        encode(&mv, PluginError::BadMove)
    }

    fn decode_move(&self, bytes: &[u8]) -> Result<String, PluginError> {
        let mv: P::Move = decode(bytes, PluginError::BadMove)?;
        serde_json::to_string(&mv).map_err(|_| PluginError::BadMove)
    }
}
