use super::*;
use tabla_plugin_api::{BytePlugin, PLAYER_CLAIMER, PLAYER_INITIATOR};

const SEED: [u8; 32] = [0; 32];

fn start() -> State {
    TicTacToe::setup(&[], &SEED).unwrap()
}

fn mv(cell: u8) -> Move {
    Move { cell }
}

/// Plays a sequence of cells, alternating players from the initiator.
fn play(cells: &[u8]) -> State {
    let mut state = start();
    for (i, &cell) in cells.iter().enumerate() {
        let player = if i % 2 == 0 {
            PLAYER_INITIATOR
        } else {
            PLAYER_CLAIMER
        };
        TicTacToe::validate_move(&state, &mv(cell), player).unwrap();
        state = TicTacToe::apply_move(state, &mv(cell)).unwrap();
    }
    state
}

#[test]
fn a_new_board_is_empty_and_the_initiator_opens() {
    let state = start();

    assert!(state.board.iter().all(Option::is_none));
    assert_eq!(state.to_move, PLAYER_INITIATOR);
    assert_eq!(TicTacToe::is_game_over(&state), None);
}

#[test]
fn setup_ignores_config_and_seed_identically() {
    // A game with no hidden state must not behave differently for different
    // entropy, or replays would diverge.
    let a = TicTacToe::setup(b"anything", &[0xAA; 32]).unwrap();
    let b = TicTacToe::setup(&[], &[0x55; 32]).unwrap();

    assert_eq!(a, b);
}

#[test]
fn turns_alternate() {
    let state = play(&[0]);
    assert_eq!(state.to_move, PLAYER_CLAIMER);

    let state = play(&[0, 4]);
    assert_eq!(state.to_move, PLAYER_INITIATOR);
}

#[test]
fn moving_out_of_turn_is_rejected() {
    let state = start();

    assert_eq!(
        TicTacToe::validate_move(&state, &mv(0), PLAYER_CLAIMER),
        Err(PluginError::NotYourTurn)
    );
}

#[test]
fn a_taken_cell_cannot_be_played_again() {
    let state = play(&[4]);

    assert_eq!(
        TicTacToe::validate_move(&state, &mv(4), PLAYER_CLAIMER),
        Err(PluginError::IllegalMove {
            reason: "cell is already taken"
        })
    );
}

#[test]
fn a_cell_off_the_board_is_rejected() {
    let state = start();

    assert_eq!(
        TicTacToe::validate_move(&state, &mv(9), PLAYER_INITIATOR),
        Err(PluginError::IllegalMove {
            reason: "cell is off the board"
        })
    );
    assert_eq!(
        TicTacToe::validate_move(&state, &mv(255), PLAYER_INITIATOR),
        Err(PluginError::IllegalMove {
            reason: "cell is off the board"
        })
    );
}

#[test]
fn the_initiator_can_win_on_a_row() {
    // Initiator takes the top row.
    let state = play(&[0, 3, 1, 4, 2]);

    assert_eq!(
        TicTacToe::is_game_over(&state),
        Some(Outcome::Winner {
            player: PLAYER_INITIATOR
        })
    );
    assert_eq!(TicTacToe::winning_line(&state).unwrap().0, [0, 1, 2]);
}

#[test]
fn the_claimer_can_win_on_a_column() {
    // Claimer takes the middle column.
    let state = play(&[0, 1, 2, 4, 3, 7]);

    assert_eq!(
        TicTacToe::is_game_over(&state),
        Some(Outcome::Winner {
            player: PLAYER_CLAIMER
        })
    );
    assert_eq!(TicTacToe::winning_line(&state).unwrap().0, [1, 4, 7]);
}

#[test]
fn a_diagonal_wins() {
    let state = play(&[0, 1, 4, 2, 8]);

    assert_eq!(
        TicTacToe::is_game_over(&state),
        Some(Outcome::Winner {
            player: PLAYER_INITIATOR
        })
    );
    assert_eq!(TicTacToe::winning_line(&state).unwrap().0, [0, 4, 8]);
}

#[test]
fn a_full_board_with_no_line_is_a_draw() {
    // X O X
    // X O O
    // O X X
    let state = play(&[0, 1, 2, 4, 3, 6, 7, 5, 8]);

    assert_eq!(state.move_count, 9);
    assert_eq!(TicTacToe::is_game_over(&state), Some(Outcome::Draw));
}

#[test]
fn no_move_is_accepted_after_the_game_ends() {
    let state = play(&[0, 3, 1, 4, 2]);

    assert_eq!(
        TicTacToe::validate_move(&state, &mv(5), PLAYER_CLAIMER),
        Err(PluginError::GameOver)
    );
}

#[test]
fn a_win_ends_the_game_before_the_board_fills() {
    let state = play(&[0, 3, 1, 4, 2]);

    assert_eq!(state.move_count, 5);
    assert!(TicTacToe::is_game_over(&state).is_some());
}

// -- views ------------------------------------------------------------------

#[test]
fn the_view_tells_each_player_whether_it_is_their_turn() {
    let state = play(&[4]);

    assert!(!TicTacToe::player_view(&state, PLAYER_INITIATOR).your_turn);
    assert!(TicTacToe::player_view(&state, PLAYER_CLAIMER).your_turn);
}

#[test]
fn the_view_lists_only_empty_cells_as_legal() {
    let state = play(&[0, 4]);
    let view = TicTacToe::player_view(&state, PLAYER_INITIATOR);

    assert_eq!(view.legal_moves, vec![1, 2, 3, 5, 6, 7, 8]);
}

#[test]
fn a_finished_game_offers_no_legal_moves() {
    let state = play(&[0, 3, 1, 4, 2]);
    let view = TicTacToe::player_view(&state, PLAYER_CLAIMER);

    assert!(view.legal_moves.is_empty());
    assert!(!view.your_turn);
    assert_eq!(view.winning_line, Some([0, 1, 2]));
}

#[test]
fn both_players_see_the_same_board() {
    // Tic tac toe has no hidden state; this test exists so that a future game
    // which *does* hide state has an obvious place to diverge from.
    let state = play(&[0, 4, 1]);

    let a = TicTacToe::player_view(&state, PLAYER_INITIATOR);
    let b = TicTacToe::player_view(&state, PLAYER_CLAIMER);

    assert_eq!(a.board, b.board);
}

// -- the byte-level adapter -------------------------------------------------

#[test]
fn the_adapter_round_trips_state_through_bytes() {
    let plugin = Plugin::new();

    let state = plugin.setup(&[], &SEED).unwrap();
    let mv = postcard::to_allocvec(&Move { cell: 4 }).unwrap();

    plugin.validate_move(&state, &mv, PLAYER_INITIATOR).unwrap();
    let next = plugin.apply_move(&state, &mv).unwrap();

    assert_ne!(state, next);
    assert_eq!(plugin.is_game_over(&next).unwrap(), None);
}

#[test]
fn the_adapter_reports_its_identity() {
    let plugin = Plugin::new();

    assert_eq!(plugin.id(), "tictactoe");
    assert_eq!(plugin.version(), 1);
}

#[test]
fn the_adapter_renders_views_as_json() {
    let plugin = Plugin::new();
    let state = plugin.setup(&[], &SEED).unwrap();

    let json = plugin.player_view(&state, PLAYER_INITIATOR).unwrap();
    let text = String::from_utf8(json).unwrap();

    assert!(
        text.contains("\"yourTurn\":true"),
        "unexpected view: {text}"
    );
    assert!(
        text.contains("\"legalMoves\":[0,1,2,3,4,5,6,7,8]"),
        "unexpected view: {text}"
    );
}

#[test]
fn replaying_a_move_list_reaches_the_same_position() {
    let plugin = Plugin::new();
    let cells = [0u8, 3, 1, 4, 2];
    let moves: Vec<Vec<u8>> = cells
        .iter()
        .map(|&c| postcard::to_allocvec(&Move { cell: c }).unwrap())
        .collect();

    let replayed = plugin.replay(&[], &SEED, &moves).unwrap();
    let expected = postcard::to_allocvec(&play(&cells)).unwrap();

    assert_eq!(replayed, expected);
    assert_eq!(
        plugin.is_game_over(&replayed).unwrap(),
        Some(Outcome::Winner {
            player: PLAYER_INITIATOR
        })
    );
}

#[test]
fn replay_rejects_an_illegal_move_in_the_middle() {
    let plugin = Plugin::new();
    // Second move repeats the first player's cell.
    let moves: Vec<Vec<u8>> = [0u8, 0]
        .iter()
        .map(|&c| postcard::to_allocvec(&Move { cell: c }).unwrap())
        .collect();

    assert_eq!(
        plugin.replay(&[], &SEED, &moves),
        Err(PluginError::IllegalMove {
            reason: "cell is already taken"
        })
    );
}

#[test]
fn replay_refuses_to_continue_past_the_end() {
    let plugin = Plugin::new();
    // A win on the fifth move, then a sixth that should not exist.
    let moves: Vec<Vec<u8>> = [0u8, 3, 1, 4, 2, 5]
        .iter()
        .map(|&c| postcard::to_allocvec(&Move { cell: c }).unwrap())
        .collect();

    assert_eq!(
        plugin.replay(&[], &SEED, &moves),
        Err(PluginError::GameOver)
    );
}

#[test]
fn replay_is_deterministic() {
    let plugin = Plugin::new();
    let moves: Vec<Vec<u8>> = [4u8, 0, 8]
        .iter()
        .map(|&c| postcard::to_allocvec(&Move { cell: c }).unwrap())
        .collect();

    // Different entropy, same result: the two clients cannot desync.
    let a = plugin.replay(&[], &[0x11; 32], &moves).unwrap();
    let b = plugin.replay(&[], &[0xEE; 32], &moves).unwrap();

    assert_eq!(a, b);
}

#[test]
fn garbage_state_is_rejected_rather_than_misread() {
    let plugin = Plugin::new();

    assert_eq!(
        plugin.is_game_over(b"not a state at all"),
        Err(PluginError::BadState)
    );
}
