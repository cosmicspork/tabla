//! The game-rules WASM module.
//!
//! This is a separate binary from `tabla-wasm` on purpose. It holds no keys,
//! links nothing that could use one, and has no way to reach storage or the
//! network — the isolation is a property of what was compiled in, not of a rule
//! someone has to remember to follow. It is loaded into a Web Worker whose
//! networking globals are deleted at startup, and it receives only state, move
//! and reference bytes.
//!
//! A game with hidden state does hash: commitments and the tile draw are
//! SHA-256 over public values, and the whole point of them is that the opponent
//! can check the result afterwards. That is not a capability, and the invariant
//! this module protects is the one that matters — no key material, and nothing
//! keyed. A test scans the built artifact for the symbols that would say
//! otherwise.
//!
//! One build of this crate is bundled into the app; others are built with a
//! single game selected and downloaded on demand, their hashes pinned in a
//! signed manifest. Which games a binary carries is a cargo feature, so a
//! module shipped for one game holds no code for any other. What a plugin is
//! permitted to do is the same either way — being fetched changes where the
//! bytes came from, not what they may touch.

use tabla_plugin_api::{BytePlugin, GamePlugin, Outcome, PlayerId, PluginError};
use wasm_bindgen::prelude::*;

/// Every plugin compiled into this module.
///
/// Which games those are is a build-time choice — see this crate's cargo
/// features. A module built for one game carries no code for any other, so
/// "this build cannot play that" is a fact about the binary rather than a
/// check someone could skip.
fn lookup(plugin_id: &str) -> Result<&'static dyn BytePlugin, JsError> {
    #[cfg(feature = "tictactoe")]
    {
        const TICTACTOE: tabla_tictactoe::Plugin = tabla_tictactoe::Plugin::new();
        if plugin_id == tabla_tictactoe::TicTacToe::ID {
            return Ok(&TICTACTOE);
        }
    }

    #[cfg(feature = "letras")]
    {
        const LETRAS: tabla_letras::Plugin = tabla_letras::Plugin::new();
        if plugin_id == tabla_letras::Letras::ID {
            return Ok(&LETRAS);
        }
    }

    Err(JsError::new(&format!("unknown plugin: {plugin_id}")))
}

fn seed32(seed: &[u8]) -> Result<[u8; 32], JsError> {
    seed.try_into()
        .map_err(|_| JsError::new("seed must be 32 bytes"))
}

fn plugin_err(e: PluginError) -> JsError {
    JsError::new(&e.to_string())
}

/// Plugin identifiers this module can play.
#[wasm_bindgen]
pub fn available_plugins() -> Vec<String> {
    [
        #[cfg(feature = "letras")]
        tabla_letras::Letras::ID,
        #[cfg(feature = "tictactoe")]
        tabla_tictactoe::TicTacToe::ID,
    ]
    .iter()
    .map(|id| id.to_string())
    .collect()
}

/// The rules version for a plugin. Clients refuse to start or resume a game
/// whose invite names a different one.
#[wasm_bindgen]
pub fn plugin_version(plugin_id: &str) -> Result<u32, JsError> {
    Ok(lookup(plugin_id)?.version())
}

/// `assets` is the bulk reference data a game needs — a word list, say. It is
/// passed in because a plugin cannot fetch anything itself, and the game checks
/// it against the hash its configuration pins rather than trusting the host.
#[wasm_bindgen]
pub fn setup(
    plugin_id: &str,
    config: &[u8],
    seed: &[u8],
    assets: &[u8],
) -> Result<Vec<u8>, JsError> {
    lookup(plugin_id)?
        .setup(config, &seed32(seed)?, assets)
        .map_err(plugin_err)
}

#[wasm_bindgen]
pub fn validate_move(
    plugin_id: &str,
    state: &[u8],
    mv: &[u8],
    player: PlayerId,
    assets: &[u8],
) -> Result<(), JsError> {
    lookup(plugin_id)?
        .validate_move(state, mv, player, assets)
        .map_err(plugin_err)
}

#[wasm_bindgen]
pub fn apply_move(
    plugin_id: &str,
    state: &[u8],
    mv: &[u8],
    assets: &[u8],
) -> Result<Vec<u8>, JsError> {
    lookup(plugin_id)?
        .apply_move(state, mv, assets)
        .map_err(plugin_err)
}

/// Renders what one player is entitled to see, as JSON.
#[wasm_bindgen]
pub fn player_view(plugin_id: &str, state: &[u8], player: PlayerId) -> Result<String, JsError> {
    let json = lookup(plugin_id)?
        .player_view(state, player)
        .map_err(plugin_err)?;
    String::from_utf8(json).map_err(|_| JsError::new("view was not valid UTF-8"))
}

/// `null` while the game is in progress, otherwise the outcome as JSON.
#[wasm_bindgen]
pub fn is_game_over(plugin_id: &str, state: &[u8]) -> Result<Option<String>, JsError> {
    let outcome = lookup(plugin_id)?.is_game_over(state).map_err(plugin_err)?;
    Ok(outcome.map(render_outcome))
}

fn render_outcome(outcome: Outcome) -> String {
    match outcome {
        Outcome::Winner { player } => format!(r#"{{"kind":"winner","player":{player}}}"#),
        Outcome::Draw => r#"{"kind":"draw"}"#.to_string(),
    }
}

/// Encodes a move described as JSON (`{"cell":4}`) into its wire form.
///
/// The UI never serializes moves itself: those bytes are signed into the log,
/// so an encoding mismatch between the UI and the rules would be unrecoverable
/// rather than merely wrong.
#[wasm_bindgen(js_name = encodeMove)]
pub fn encode_move(plugin_id: &str, json: &str) -> Result<Vec<u8>, JsError> {
    lookup(plugin_id)?.encode_move(json).map_err(plugin_err)
}

/// Renders an encoded move back as JSON.
#[wasm_bindgen(js_name = decodeMove)]
pub fn decode_move(plugin_id: &str, bytes: &[u8]) -> Result<String, JsError> {
    lookup(plugin_id)?.decode_move(bytes).map_err(plugin_err)
}

/// Replays a game from its configuration and the moves taken from the log.
///
/// Every move is validated in sequence, so a log that replays without error is
/// a log whose every move was legal under these rules.
#[wasm_bindgen]
pub fn replay(
    plugin_id: &str,
    config: &[u8],
    seed: &[u8],
    moves: Vec<js_sys::Uint8Array>,
    assets: &[u8],
) -> Result<Vec<u8>, JsError> {
    let moves: Vec<Vec<u8>> = moves.iter().map(|m| m.to_vec()).collect();
    lookup(plugin_id)?
        .replay(config, &seed32(seed)?, &moves, assets)
        .map_err(plugin_err)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The list and the build agree, whichever games this build was given.
    ///
    /// Only the happy path is exercised here: rejecting an absent game means
    /// constructing a `JsError`, which is a browser type. That half is checked
    /// against the real artifact in `app/src/lib/plugin/artifact.test.ts`.
    #[test]
    fn lists_the_games_compiled_in() {
        let ids = available_plugins();

        assert_eq!(
            ids.iter().any(|id| id == "tictactoe"),
            cfg!(feature = "tictactoe")
        );
        assert_eq!(
            ids.iter().any(|id| id == "letras"),
            cfg!(feature = "letras")
        );

        #[cfg(feature = "tictactoe")]
        assert!(lookup("tictactoe").is_ok());

        #[cfg(feature = "letras")]
        assert!(lookup("letras").is_ok());
    }
}
