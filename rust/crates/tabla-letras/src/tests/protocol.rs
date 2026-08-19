//! The opening, the draws, and playing a game out.

use tabla_plugin_api::{GamePlugin, PLAYER_CLAIMER, PLAYER_INITIATOR, PluginError};

use super::harness::*;
use crate::board::Placement;
use crate::draw::*;
use crate::game::{Action, Expect, Letras, Move};
use crate::tiles::*;

/// The first `count` tiles of a rendered rack, as tile numbers.
fn rack_tiles(rack: &str, count: usize) -> Vec<Tile> {
    rack.bytes()
        .take(count)
        .map(|b| {
            if b == b'?' {
                BLANK
            } else {
                tile_of(b).expect("rack letters")
            }
        })
        .collect()
}

/// Turns a rack string back into placements along a row, for tests that need to
/// play whatever they happened to draw.
fn place_from_rack(rack: &str, row: u8, col: u8, count: usize) -> Vec<Placement> {
    rack.bytes()
        .take(count)
        .enumerate()
        .map(|(i, byte)| Placement {
            row,
            col: col + i as u8,
            tile: if byte == b'?' {
                BLANK
            } else {
                tile_of(byte).expect("rack letters")
            },
            blank_as: (byte == b'?').then_some(tile_of(b'e').unwrap()),
        })
        .collect()
}

// -- the opening -------------------------------------------------------------

#[test]
fn the_opening_deals_both_players_a_rack() {
    let mut table = Table::new();
    table.open();

    let initiator = table.view(PLAYER_INITIATOR);
    let claimer = table.view(PLAYER_CLAIMER);

    assert_eq!(initiator.rack.len(), RACK);
    assert_eq!(claimer.rack.len(), RACK);
    assert_eq!(initiator.bag, TILE_TOTAL - 2 * RACK as u8);
    assert_eq!(initiator.phase, "play");
}

#[test]
fn each_player_sees_their_own_tiles_and_only_a_count_of_the_others() {
    let mut table = Table::new();
    table.open();

    let initiator = table.view(PLAYER_INITIATOR);
    let claimer = table.view(PLAYER_CLAIMER);

    assert_ne!(initiator.rack, claimer.rack);
    assert_eq!(initiator.opponent_tiles as usize, claimer.rack.len());
    assert_eq!(claimer.opponent_tiles as usize, initiator.rack.len());
}

#[test]
fn a_view_never_carries_the_other_players_secrets() {
    // The whole hidden-state claim in one assertion: render the opponent's
    // view as JSON and check that nothing private is in it.
    let mut table = Table::new();
    table.open();

    let mine = table.view(PLAYER_INITIATOR);
    let theirs = serde_json::to_string(&table.view(PLAYER_CLAIMER)).unwrap();

    assert!(
        !theirs.contains(&mine.rack),
        "the opponent's view shows my rack"
    );
    for byte in SEED_I {
        // The seed would appear as a JSON number array; a crude but real check
        // that no part of it is being rendered.
        assert!(!theirs.contains(&format!("{},{},{}", byte, byte, byte)));
    }
}

#[test]
fn the_toss_decides_who_opens_and_the_loser_of_it_yields() {
    let mut table = Table::new();
    table.play_automatic().unwrap();
    table.play_automatic().unwrap();
    table.play_automatic().unwrap();

    let first = table
        .view(PLAYER_INITIATOR)
        .first
        .expect("the toss settled");

    // Move 3 belongs to the claimer whichever way the toss went; if the
    // initiator won it, the claimer has to spend the turn doing nothing.
    let expected = if first == PLAYER_INITIATOR {
        Some(Action::Yield)
    } else {
        None
    };
    assert_eq!(table.view(PLAYER_CLAIMER).auto, expected);
}

#[test]
fn the_toss_cannot_be_opened_with_the_wrong_value() {
    let mut table = Table::new();
    table.play_automatic().unwrap();
    table.play_automatic().unwrap();

    let mv = table.compose(Action::Toss {
        entropy: [0xEE; 32],
    });

    assert!(matches!(
        table.submit(mv),
        Err(PluginError::IllegalMove { .. })
    ));
}

#[test]
fn a_device_that_was_not_dealt_this_game_cannot_replay_it() {
    // Someone else's log: neither commitment is to a seed this device holds.
    let mut table = Table::new();
    table.open();

    assert!(matches!(
        table.replay_as(&[0x99; 32]),
        Err(PluginError::IllegalMove { .. })
    ));
    // Both real players can.
    assert!(table.replay_as(&SEED_I).is_ok());
    assert!(table.replay_as(&SEED_C).is_ok());
}

#[test]
fn moves_out_of_turn_are_refused() {
    let mut table = Table::new();
    table.open();

    let mv = table.compose(Action::Pass);
    let wrong = 1 - table.to_move();

    assert_eq!(
        Letras::validate_move(&table.initiator.state, &mv, wrong, &table.assets),
        Err(PluginError::NotYourTurn)
    );
}

#[test]
fn the_game_only_accepts_what_it_is_waiting_for() {
    let mut table = Table::new();

    // A play before anyone has committed.
    let mv = table.compose(Action::Pass);
    assert!(matches!(
        table.submit(mv),
        Err(PluginError::IllegalMove { .. })
    ));

    table.open();

    // A second commitment once the game is under way.
    let mv = table.compose(Action::Commit {
        seed_hash: seed_commitment(&SEED_I),
        toss: [0; 32],
    });
    assert!(matches!(
        table.submit(mv),
        Err(PluginError::IllegalMove { .. })
    ));
}

// -- drawing -----------------------------------------------------------------

#[test]
fn a_rack_is_refilled_after_a_play() {
    let mut table = Table::new();
    table.open();

    let mover = table.to_move();
    let rack = table.view(mover).rack.clone();
    let placements = place_from_rack(&rack, 7, 7, 3);

    table.play(Action::Place { placements }).unwrap();

    // The tiles are gone but the refill has not landed: it rides on the
    // opponent's next entry, which is also the challenge window closing.
    assert_eq!(table.view(mover).rack.len(), RACK - 3);

    table.play(Action::Pass).unwrap();
    assert_eq!(table.view(mover).rack.len(), RACK);
    assert_eq!(table.view(mover).bag, TILE_TOTAL - 2 * RACK as u8 - 3);
}

#[test]
fn a_commitment_is_owed_after_drawing_and_only_then() {
    let mut table = Table::new();
    table.open();

    // The opening draws are already committed: they rode out on the toss and
    // on whatever the claimer did with move three. Nothing is owed now.
    let mover = table.to_move();
    assert!(table.view(mover).rack_commitment.is_none());

    // Play, and the refill that follows puts a commitment back on the slate.
    let rack = table.view(mover).rack.clone();
    table
        .play(Action::Place {
            placements: place_from_rack(&rack, 7, 7, 2),
        })
        .unwrap();
    table.play(Action::Pass).unwrap();

    assert_eq!(table.to_move(), mover);
    assert!(table.view(mover).rack_commitment.is_some());

    // And passing draws nothing, so the next entry owes nothing again.
    table.play(Action::Pass).unwrap();
    table.play(Action::Pass).unwrap();
    assert!(table.view(mover).rack_commitment.is_none());
}

#[test]
fn a_wrong_rack_commitment_is_refused_by_the_player_making_it() {
    let mut table = Table::new();
    table.open();

    let mut mv = table.compose(Action::Pass);
    mv.rack_commitment = Some([0xAB; 32]);

    assert!(matches!(
        table.submit(mv),
        Err(PluginError::IllegalMove { .. })
    ));
}

#[test]
fn a_missing_rack_commitment_is_refused_by_either_player() {
    // The opponent cannot check what a commitment says, but can see that one
    // is owed — drawing is public even though the tiles are not.
    let mut table = Table::new();
    table.open();

    let mover = table.to_move();
    let rack = table.view(mover).rack.clone();
    table
        .play(Action::Place {
            placements: place_from_rack(&rack, 7, 7, 2),
        })
        .unwrap();
    table.play(Action::Pass).unwrap();

    let mut mv = table.compose(Action::Pass);
    assert!(mv.rack_commitment.is_some(), "one is owed at this point");
    mv.rack_commitment = None;
    assert!(matches!(
        Letras::validate_move(&table.claimer.state, &mv, mover, &table.assets),
        Err(PluginError::IllegalMove { .. })
    ));
    assert!(matches!(
        Letras::validate_move(&table.initiator.state, &mv, mover, &table.assets),
        Err(PluginError::IllegalMove { .. })
    ));
}

#[test]
fn tiles_a_player_does_not_hold_cannot_be_played() {
    let mut table = Table::new();
    table.open();

    let mover = table.to_move();
    let rack = table.view(mover).rack.clone();

    // A letter that is certainly not on the rack.
    let missing = (b'a'..=b'z')
        .find(|b| !rack.as_bytes().contains(b))
        .expect("some letter is missing from seven tiles");

    let placements = vec![
        Placement {
            row: 7,
            col: 7,
            tile: tile_of(missing).unwrap(),
            blank_as: None,
        },
        Placement {
            row: 7,
            col: 8,
            tile: tile_of(rack.as_bytes()[0]).unwrap(),
            blank_as: None,
        },
    ];

    let mv = table.compose(Action::Place { placements });
    assert!(matches!(
        table.submit(mv),
        Err(PluginError::IllegalMove { .. })
    ));
}

// -- exchanging --------------------------------------------------------------

#[test]
fn exchanging_swaps_tiles_without_shrinking_the_bag() {
    let mut table = Table::new();
    table.open();

    let mover = table.to_move();
    let before = table.view(mover);
    let discards = rack_tiles(&before.rack, 3);
    let masked = mask_tiles(
        if mover == PLAYER_INITIATOR {
            &SEED_I
        } else {
            &SEED_C
        },
        0,
        &discards,
    );

    table.play(Action::Exchange { masked }).unwrap();
    assert_eq!(
        table.view(mover).scoreless,
        1,
        "an exchange changes nothing"
    );

    table.play(Action::Pass).unwrap();

    let after = table.view(mover);
    assert_eq!(after.rack.len(), RACK, "the rack is full again");
    assert_eq!(after.bag, before.bag, "the tiles went back in");
}

#[test]
fn an_exchange_hides_which_tiles_went_back() {
    let mut table = Table::new();
    table.open();

    let mover = table.to_move();
    let rack = table.view(mover).rack.clone();
    let discards = rack_tiles(&rack, 2);
    let seed = if mover == PLAYER_INITIATOR {
        SEED_I
    } else {
        SEED_C
    };
    let masked = mask_tiles(&seed, 0, &discards);

    assert_ne!(masked, discards, "the discards went out in the clear");

    table
        .play(Action::Exchange {
            masked: masked.clone(),
        })
        .unwrap();

    // The opponent sees the count and nothing else.
    let seen = table.view(1 - mover);
    assert_eq!(seen.opponent_tiles as usize, RACK - 2);
}

#[test]
fn exchanging_needs_enough_tiles_left_to_be_worth_it() {
    let mut table = Table::new();
    table.open();

    // Drain the bag by playing it out, then try to exchange.
    let mut guard = 0;
    while table.view(table.to_move()).bag as usize >= RACK && guard < 40 {
        let mover = table.to_move();
        let rack = table.view(mover).rack.clone();
        let row = 7 + (guard as u8 % 2);
        let _ = table.play(Action::Place {
            placements: place_from_rack(&rack, row, 4, 1),
        });
        guard += 1;
        if table.view(table.to_move()).phase != "play" {
            break;
        }
        let _ = table.play(Action::Pass);
        guard += 1;
    }

    if (table.view(table.to_move()).bag as usize) < RACK {
        let mover = table.to_move();
        let seed = if mover == PLAYER_INITIATOR {
            SEED_I
        } else {
            SEED_C
        };
        let mv = table.compose(Action::Exchange {
            masked: mask_tiles(&seed, 0, &[1]),
        });
        assert!(matches!(
            table.submit(mv),
            Err(PluginError::IllegalMove { .. })
        ));
    }
}

// -- ending ------------------------------------------------------------------

#[test]
fn six_scoreless_turns_end_the_game() {
    let mut table = Table::new();
    table.open();

    for _ in 0..6 {
        table.play(Action::Pass).unwrap();
    }

    assert_eq!(table.view(PLAYER_INITIATOR).phase, "reveal");

    // Both open their racks, and the scores settle.
    table.play_automatic().unwrap();
    table.play_automatic().unwrap();

    let view = table.view(PLAYER_INITIATOR);
    assert_eq!(view.phase, "over");
    assert!(view.outcome.is_some());
    assert!(view.final_scores.is_some());
}

#[test]
fn nobody_going_out_means_both_pay_for_what_they_are_holding() {
    let mut table = Table::new();
    table.open();
    for _ in 0..6 {
        table.play(Action::Pass).unwrap();
    }
    table.play_automatic().unwrap();
    table.play_automatic().unwrap();

    let view = table.view(PLAYER_INITIATOR);
    let final_scores = view.final_scores.unwrap();

    // Nobody scored anything, and both still hold seven tiles.
    assert_eq!(view.scores, [0, 0]);
    assert!(final_scores[0] < 0 && final_scores[1] < 0);
}

#[test]
fn a_reveal_must_open_the_commitment_made_at_the_start() {
    let mut table = Table::new();
    table.open();
    for _ in 0..6 {
        table.play(Action::Pass).unwrap();
    }

    let mv = table.compose(Action::Reveal {
        seed: [0x77; 32],
        rack: Vec::new(),
    });
    assert!(matches!(
        table.submit(mv),
        Err(PluginError::IllegalMove { .. })
    ));
}

#[test]
fn no_move_is_accepted_once_the_game_is_over() {
    let mut table = Table::new();
    table.open();
    for _ in 0..6 {
        table.play(Action::Pass).unwrap();
    }
    table.play_automatic().unwrap();
    table.play_automatic().unwrap();

    let mv = table.compose(Action::Pass);
    assert_eq!(table.submit(mv), Err(PluginError::GameOver));
}

// -- replay ------------------------------------------------------------------

#[test]
fn a_log_replays_to_the_same_position_it_was_built_from() {
    let mut table = Table::new();
    table.open();

    let mover = table.to_move();
    let rack = table.view(mover).rack.clone();
    table
        .play(Action::Place {
            placements: place_from_rack(&rack, 7, 7, 3),
        })
        .unwrap();
    table.play(Action::Pass).unwrap();

    for (seed, client) in [(SEED_I, &table.initiator), (SEED_C, &table.claimer)] {
        let replayed = table.replay_as(&seed).expect("replay");
        let expected = postcard::to_allocvec(&client.state).expect("state encodes");
        assert_eq!(replayed, expected, "replay landed somewhere else");
    }
}

#[test]
fn a_move_survives_both_encodings_it_has_to_cross() {
    // Moves go out as postcard on the wire, and come in from the UI as JSON.
    // A mismatch between the two would be signed into the log and unrecoverable.
    let action = Action::Place {
        placements: vec![Placement {
            row: 7,
            col: 7,
            tile: 3,
            blank_as: None,
        }],
    };
    let mv = Move {
        nonce: nonce(9),
        rack_commitment: Some([0x5A; 32]),
        action,
    };

    let bytes = postcard::to_allocvec(&mv).unwrap();
    assert_eq!(postcard::from_bytes::<Move>(&bytes).unwrap(), mv);

    let json = serde_json::to_string(&mv).unwrap();
    assert_eq!(serde_json::from_str::<Move>(&json).unwrap(), mv);
}

#[test]
fn the_automatic_moves_the_view_offers_are_the_ones_the_rules_accept() {
    // The UI submits these without asking anyone, so an action the rules would
    // reject would strand the game.
    let mut table = Table::new();

    while let Some(auto) = table.view(table.to_move()).auto {
        table
            .play(auto)
            .expect("the rules accept what they asked for");
    }
    assert_eq!(table.initiator.state.expected(), Expect::Play);
}

// -- setup -------------------------------------------------------------------

#[test]
fn the_game_refuses_to_start_against_the_wrong_word_list() {
    let assets = dictionary();
    let config = crate::game::config_for(&dictionary_hash(&assets));

    assert!(Letras::setup(&config, &SEED_I, &assets).is_ok());
    assert_eq!(
        Letras::setup(&config, &SEED_I, b"a different word list"),
        Err(PluginError::BadAssets)
    );
    assert_eq!(
        Letras::setup(&config, &SEED_I, &[]),
        Err(PluginError::BadAssets)
    );
}

#[test]
fn a_configuration_from_another_version_is_refused() {
    let assets = dictionary();

    assert_eq!(
        Letras::setup(&[], &SEED_I, &assets),
        Err(PluginError::BadConfig)
    );
    assert_eq!(
        Letras::setup(&[9; 33], &SEED_I, &assets),
        Err(PluginError::BadConfig)
    );
}
