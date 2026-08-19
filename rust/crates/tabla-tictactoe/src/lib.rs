//! Tic tac toe: the game that proves the pipe.
//!
//! It has no hidden state and needs no randomness, which makes it the right
//! first game — every interesting problem in the system (the log, the handshake,
//! sync, eviction, push) is exercised without the game itself getting in the
//! way. The commit-reveal machinery that hidden state requires arrives with the
//! word game in phase 2.

use serde::{Deserialize, Serialize};
use tabla_plugin_api::{GamePlugin, Outcome, PlayerId, PluginError};

#[cfg(test)]
mod tests;

pub const BOARD_SIZE: usize = 9;

/// The eight lines that win.
const LINES: [[usize; 3]; 8] = [
    [0, 1, 2],
    [3, 4, 5],
    [6, 7, 8],
    [0, 3, 6],
    [1, 4, 7],
    [2, 5, 8],
    [0, 4, 8],
    [2, 4, 6],
];

/// Board cells hold the id of the player who claimed them.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct State {
    pub board: [Option<PlayerId>; BOARD_SIZE],
    /// Whose turn it is. The initiator opens.
    pub to_move: PlayerId,
    pub move_count: u8,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct Move {
    /// Cell index, 0 through 8, reading left to right and top to bottom.
    pub cell: u8,
}

/// What the UI renders. Tic tac toe hides nothing, so both players see the same
/// thing — but the shape is still per-player, because the interface is.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct View {
    pub board: [Option<PlayerId>; BOARD_SIZE],
    pub to_move: PlayerId,
    pub you: PlayerId,
    pub your_turn: bool,
    pub outcome: Option<Outcome>,
    /// The three cells that won, for highlighting.
    pub winning_line: Option<[usize; 3]>,
    pub legal_moves: Vec<u8>,
}

pub struct TicTacToe;

impl TicTacToe {
    fn winning_line(state: &State) -> Option<([usize; 3], PlayerId)> {
        LINES.iter().find_map(|line| {
            let [a, b, c] = *line;
            match (state.board[a], state.board[b], state.board[c]) {
                (Some(x), Some(y), Some(z)) if x == y && y == z => Some((*line, x)),
                _ => None,
            }
        })
    }
}

impl GamePlugin for TicTacToe {
    const ID: &'static str = "tictactoe";
    const VERSION: u32 = 1;

    type State = State;
    type Move = Move;
    type View = View;

    /// Tic tac toe takes no configuration and needs no entropy.
    ///
    /// Both are still part of the signature, because the interface has to serve
    /// games that need them, and a game that ignores them must not be able to
    /// tell that it was handed different ones.
    fn setup(_config: &[u8], _seed: &[u8; 32]) -> Result<State, PluginError> {
        Ok(State {
            board: [None; BOARD_SIZE],
            to_move: tabla_plugin_api::PLAYER_INITIATOR,
            move_count: 0,
        })
    }

    fn validate_move(state: &State, mv: &Move, player: PlayerId) -> Result<(), PluginError> {
        if Self::is_game_over(state).is_some() {
            return Err(PluginError::GameOver);
        }
        if player != state.to_move {
            return Err(PluginError::NotYourTurn);
        }
        let cell = mv.cell as usize;
        if cell >= BOARD_SIZE {
            return Err(PluginError::IllegalMove {
                reason: "cell is off the board",
            });
        }
        if state.board[cell].is_some() {
            return Err(PluginError::IllegalMove {
                reason: "cell is already taken",
            });
        }
        Ok(())
    }

    fn apply_move(mut state: State, mv: &Move) -> Result<State, PluginError> {
        let cell = mv.cell as usize;
        if cell >= BOARD_SIZE {
            return Err(PluginError::IllegalMove {
                reason: "cell is off the board",
            });
        }
        state.board[cell] = Some(state.to_move);
        state.to_move = 1 - state.to_move;
        state.move_count += 1;
        Ok(state)
    }

    fn player_view(state: &State, player: PlayerId) -> View {
        let outcome = Self::is_game_over(state);
        View {
            board: state.board,
            to_move: state.to_move,
            you: player,
            your_turn: outcome.is_none() && state.to_move == player,
            outcome,
            winning_line: Self::winning_line(state).map(|(line, _)| line),
            legal_moves: if outcome.is_some() {
                Vec::new()
            } else {
                (0..BOARD_SIZE as u8)
                    .filter(|&c| state.board[c as usize].is_none())
                    .collect()
            },
        }
    }

    fn is_game_over(state: &State) -> Option<Outcome> {
        if let Some((_, player)) = Self::winning_line(state) {
            return Some(Outcome::Winner { player });
        }
        if state.move_count as usize == BOARD_SIZE {
            return Some(Outcome::Draw);
        }
        None
    }
}

/// The byte-level plugin the registry and the WASM boundary use.
pub type Plugin = tabla_plugin_api::Adapter<TicTacToe>;
