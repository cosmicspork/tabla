//! Disputes, and the reckoning at the end.
//!
//! Racks are dealt by the draw protocol and cannot be arranged, so the tests
//! here work the other way round from the obvious one: they find out what was
//! dealt, then build a word list that does or does not contain what those tiles
//! spell. The deal does not depend on the word list, so the same tiles come up
//! either way.
//!
//! The audit is tested against event logs written by hand rather than by playing
//! a crooked game. That is not a shortcut — a crooked game needs a *modified
//! client*, which is precisely the thing that cannot be built out of the honest
//! rules in this crate. The audit is a pure function of the public log, so
//! handing it a log a cheat would have produced is the real test.

use tabla_plugin_api::{GamePlugin, Outcome, PLAYER_CLAIMER, PLAYER_INITIATOR, PluginError};

use super::harness::*;
use crate::audit::{Finding, audit};
use crate::board::{Placement, SIZE};
use crate::draw::*;
use crate::game::{Action, Event, Letras, Move, Revealed};
use crate::tiles::*;

/// A game whose word list contains whatever the opening rack can spell.
fn game_where_the_opening_is_a_word() -> (Table, String) {
    let word = Table::opening_word(3);
    let mut table = Table::with_words(&[&word, "elsewhere"]);
    table.open();
    (table, word)
}

/// A game whose word list contains everything except what the opening spells.
fn game_where_the_opening_is_not_a_word() -> (Table, String) {
    let word = Table::opening_word(3);
    let mut table = Table::with_words(&["elsewhere", "other"]);
    table.open();
    assert_ne!(word, "other");
    (table, word)
}

// -- challenging -------------------------------------------------------------

#[test]
fn a_word_that_is_not_a_word_comes_back_off_the_board() {
    let (mut table, _) = game_where_the_opening_is_not_a_word();

    let placer = table.to_move();
    table.play_from_rack(3);

    let scored = table.view(placer).scores[placer as usize];
    assert!(scored > 0, "the play scored, for now");

    table.play(Action::Challenge).unwrap();

    let after = table.view(placer);
    assert_eq!(after.scores[placer as usize], 0, "the score went back");
    assert!(
        after.board.chars().all(|c| c == '.'),
        "the tiles came off the board"
    );
    assert_eq!(after.phase, "forfeit", "and a turn is owed");
}

#[test]
fn a_successful_challenge_costs_the_placer_a_turn_and_the_challenger_none() {
    let (mut table, _) = game_where_the_opening_is_not_a_word();

    let placer = table.to_move();
    table.play_from_rack(3);
    let challenger = table.to_move();

    table.play(Action::Challenge).unwrap();

    // The placer's next entry is the turn they lost.
    assert_eq!(table.to_move(), placer);
    assert_eq!(table.view(placer).auto, Some(Action::Forfeit));
    table.play_automatic().unwrap();

    // And the challenger comes straight back round to play.
    assert_eq!(table.to_move(), challenger);
    assert_eq!(table.view(challenger).phase, "play");
}

#[test]
fn a_word_that_is_real_costs_the_challenger_their_turn() {
    let (mut table, word) = game_where_the_opening_is_a_word();

    let placer = table.to_move();
    table.play_from_rack(3);
    let scored = table.view(placer).scores[placer as usize];

    table.play(Action::Challenge).unwrap();

    let after = table.view(placer);
    assert_eq!(after.scores[placer as usize], scored, "the play stands");
    assert!(after.board.contains(&word), "the tiles stayed down");
    assert_eq!(after.phase, "play");
    // The placer, not the challenger, is next: the challenge cost a turn.
    assert_eq!(table.to_move(), placer);
}

#[test]
fn a_failed_challenge_still_lets_the_refill_through() {
    let (mut table, _) = game_where_the_opening_is_a_word();

    let placer = table.to_move();
    let before = table.view(placer).bag;
    table.play_from_rack(3);

    table.play(Action::Challenge).unwrap();

    assert_eq!(table.view(placer).bag, before - 3, "the play was paid for");
    assert_eq!(table.view(placer).rack.len(), RACK);
}

#[test]
fn a_successful_challenge_cancels_the_refill() {
    // The reason refills wait for the opponent's next entry: a play that is
    // taken back must not have drawn anything.
    let (mut table, _) = game_where_the_opening_is_not_a_word();

    let placer = table.to_move();
    let before = table.view(placer).bag;
    table.play_from_rack(3);

    table.play(Action::Challenge).unwrap();

    assert_eq!(table.view(placer).bag, before, "nothing was drawn");
    assert_eq!(table.view(placer).rack.len(), RACK, "and nothing was lost");
}

#[test]
fn the_window_is_one_entry_wide() {
    let (mut table, _) = game_where_the_opening_is_not_a_word();
    table.play_from_rack(3);

    // Waiving by doing something else closes it for good.
    table.play(Action::Pass).unwrap();
    let mv = table.compose(Action::Challenge);
    assert!(matches!(
        table.submit(mv),
        Err(PluginError::IllegalMove { .. })
    ));
}

#[test]
fn a_player_cannot_challenge_their_own_play() {
    let (mut table, _) = game_where_the_opening_is_not_a_word();

    let placer = table.to_move();
    table.play_from_rack(3);
    // The opponent waives; the placer is on turn again with their own play
    // still the most recent one.
    table.play(Action::Pass).unwrap();
    assert_eq!(table.to_move(), placer);

    let mv = table.compose(Action::Challenge);
    assert!(matches!(
        table.submit(mv),
        Err(PluginError::IllegalMove { .. })
    ));
}

#[test]
fn there_is_nothing_to_challenge_before_anyone_has_played() {
    let mut table = Table::new();
    table.open();

    let mv = table.compose(Action::Challenge);
    assert!(matches!(
        table.submit(mv),
        Err(PluginError::IllegalMove { .. })
    ));
}

#[test]
fn a_forfeit_is_the_only_thing_the_challenged_player_may_do() {
    let (mut table, _) = game_where_the_opening_is_not_a_word();
    table.play_from_rack(3);
    table.play(Action::Challenge).unwrap();

    let mv = table.compose(Action::Pass);
    assert!(matches!(
        table.submit(mv),
        Err(PluginError::IllegalMove { .. })
    ));
}

#[test]
fn every_word_a_play_makes_is_open_to_challenge_not_only_the_long_one() {
    // The opening is a real word; the second play extends downwards and makes
    // cross words that are not. A challenge must weigh all of them.
    let (mut table, word) = game_where_the_opening_is_a_word();
    table.play_from_rack(3);
    table.play(Action::Pass).unwrap();

    // One tile under the middle letter of the opening, forming a two-letter
    // cross word that is certainly not in a list of two words.
    let mover = table.to_move();
    let byte = table.view(mover).rack.bytes().next().unwrap();
    let placements = vec![Placement {
        row: 8,
        col: 8,
        tile: if byte == b'?' {
            BLANK
        } else {
            tile_of(byte).unwrap()
        },
        blank_as: (byte == b'?').then_some(tile_of(b'z').unwrap()),
    }];

    table.play(Action::Place { placements }).unwrap();
    table.play(Action::Challenge).unwrap();

    // The cross word was not in the list, so the tile came off.
    assert_eq!(table.view(mover).phase, "forfeit");
    assert!(
        table.view(mover).board.contains(&word),
        "the first play stands"
    );
}

#[test]
fn the_word_list_is_what_decides_a_challenge() {
    // The same play, judged against a list that has the word and one that does
    // not. Two clients holding different lists would disagree about a whole
    // game, which is why the hash is pinned in the invite and checked at setup.
    let (mut table, word) = game_where_the_opening_is_a_word();
    table.play_from_rack(3);

    let challenge = table.compose(Action::Challenge);
    let state = table.initiator.state.clone();

    let kept = Letras::apply_move(state.clone(), &challenge, &table.assets).unwrap();
    assert!(
        Letras::player_view(&kept, PLAYER_INITIATOR)
            .board
            .contains(&word)
    );

    let narrow = tabla_dawg::build::compile(&["zzzz"]).unwrap();
    let taken = Letras::apply_move(state, &challenge, &narrow).unwrap();
    assert!(
        !Letras::player_view(&taken, PLAYER_INITIATOR)
            .board
            .contains(&word)
    );
}

#[test]
fn a_challenge_cannot_be_adjudicated_without_the_word_list() {
    let (mut table, _) = game_where_the_opening_is_a_word();
    table.play_from_rack(3);

    let mv = table.compose(Action::Challenge);
    assert_eq!(
        Letras::apply_move(table.initiator.state.clone(), &mv, &[]),
        Err(PluginError::BadAssets)
    );
}

#[test]
fn a_retracted_play_puts_the_tiles_back_on_the_rack_they_came_from() {
    let (mut table, _) = game_where_the_opening_is_not_a_word();

    let placer = table.to_move();
    let before = table.view(placer).rack.clone();
    table.play_from_rack(3);
    assert_eq!(table.view(placer).rack.len(), RACK - 3);

    table.play(Action::Challenge).unwrap();

    let after = table.view(placer).rack.clone();
    assert_eq!(after.len(), RACK);

    let sorted = |s: &str| {
        let mut v: Vec<char> = s.chars().collect();
        v.sort_unstable();
        v
    };
    assert_eq!(sorted(&after), sorted(&before), "the same tiles came back");
}

// -- the audit ---------------------------------------------------------------

#[test]
fn an_honest_game_passes_the_audit() {
    let (mut table, _) = game_where_the_opening_is_a_word();
    table.play_from_rack(3);

    for _ in 0..6 {
        table.play(Action::Pass).unwrap();
    }
    table.play_automatic().unwrap();
    table.play_automatic().unwrap();

    let view = table.view(PLAYER_INITIATOR);
    let checked = view.audit.expect("the audit ran");

    assert_eq!(checked.ok, [true, true], "{:?}", checked.notes);
    assert!(view.outcome.is_some());
    assert!(view.final_scores.is_some());
}

#[test]
fn both_clients_reach_the_same_verdict() {
    // A verdict the two sides disagreed about would be worth nothing.
    let (mut table, _) = game_where_the_opening_is_a_word();
    table.play_from_rack(3);
    for _ in 0..6 {
        table.play(Action::Pass).unwrap();
    }
    table.play_automatic().unwrap();
    table.play_automatic().unwrap();

    assert_eq!(
        table.view(PLAYER_INITIATOR).audit,
        table.view(PLAYER_CLAIMER).audit
    );
    assert_eq!(
        table.view(PLAYER_INITIATOR).outcome,
        table.view(PLAYER_CLAIMER).outcome
    );
}

/// The log a modified client would have written: a draw, a promise, and a play.
fn honest_log(seed: &[u8; 32], player: u8, count: u8) -> (Vec<Event>, Vec<Tile>) {
    let n = nonce(7);
    let mut pool = distribution();
    let rack = draw(seed, &n, 0, count, &mut pool);

    (
        vec![
            Event::Draw {
                player,
                nonce: n,
                count,
            },
            Event::Commitment {
                player,
                hash: rack_commitment(seed, 0, &rack),
            },
        ],
        rack,
    )
}

fn verdict_for(events: &[Event], reveals: [Revealed; 2]) -> crate::audit::Verdict {
    audit(
        events,
        &reveals,
        &[seed_commitment(&SEED_I), seed_commitment(&SEED_C)],
    )
}

#[test]
fn playing_tiles_that_were_never_drawn_is_caught() {
    let (mut events, rack) = honest_log(&SEED_I, PLAYER_INITIATOR, 7);

    // A tile nobody dealt them: whichever kind is not on the rack.
    let stolen = (1..=26u8)
        .find(|t| !rack.contains(t))
        .expect("seven tiles cannot cover the alphabet");
    events.push(Event::Played {
        player: PLAYER_INITIATOR,
        tiles: vec![stolen],
    });

    let verdict = verdict_for(
        &events,
        [
            Revealed {
                seed: SEED_I,
                rack: rack.clone(),
            },
            Revealed {
                seed: SEED_C,
                rack: Vec::new(),
            },
        ],
    );

    assert_eq!(
        verdict.findings[PLAYER_INITIATOR as usize],
        Some(Finding::TilesNotHeld)
    );
    assert!(verdict.passed(PLAYER_CLAIMER));
}

#[test]
fn a_seed_that_does_not_open_the_commitment_is_caught() {
    let verdict = verdict_for(
        &[],
        [
            Revealed {
                seed: SEED_I,
                rack: Vec::new(),
            },
            Revealed {
                seed: [0x99; 32],
                rack: Vec::new(),
            },
        ],
    );

    assert!(verdict.passed(PLAYER_INITIATOR));
    assert_eq!(
        verdict.findings[PLAYER_CLAIMER as usize],
        Some(Finding::WrongSeed)
    );
}

#[test]
fn a_rack_commitment_that_does_not_match_the_draw_is_caught() {
    let (events, rack) = honest_log(&SEED_I, PLAYER_INITIATOR, 7);

    // Same draw, a promise about something else.
    let mut tampered = events.clone();
    tampered[1] = Event::Commitment {
        player: PLAYER_INITIATOR,
        hash: [0xAB; 32],
    };

    let reveals = || {
        [
            Revealed {
                seed: SEED_I,
                rack: rack.clone(),
            },
            Revealed {
                seed: SEED_C,
                rack: Vec::new(),
            },
        ]
    };

    assert!(verdict_for(&events, reveals()).passed(PLAYER_INITIATOR));
    assert_eq!(
        verdict_for(&tampered, reveals()).findings[PLAYER_INITIATOR as usize],
        Some(Finding::BrokenPromise)
    );
}

#[test]
fn a_final_rack_that_does_not_add_up_is_caught() {
    let (events, rack) = honest_log(&SEED_C, PLAYER_CLAIMER, 3);

    let verdict = verdict_for(
        &events,
        [
            Revealed {
                seed: SEED_I,
                rack: Vec::new(),
            },
            // Three tiles were drawn; two are shown.
            Revealed {
                seed: SEED_C,
                rack: rack[..2].to_vec(),
            },
        ],
    );

    assert_eq!(
        verdict.findings[PLAYER_CLAIMER as usize],
        Some(Finding::WrongFinalRack)
    );
}

#[test]
fn a_challenged_play_is_not_counted_as_tiles_spent() {
    // A play that came back off the board leaves the tiles on the rack, and the
    // audit has to agree — otherwise being challenged would frame you.
    let (mut events, rack) = honest_log(&SEED_I, PLAYER_INITIATOR, 7);
    events.push(Event::Seen {
        player: PLAYER_INITIATOR,
        tiles: rack[..2].to_vec(),
    });

    let verdict = verdict_for(
        &events,
        [
            Revealed {
                seed: SEED_I,
                rack: rack.clone(),
            },
            Revealed {
                seed: SEED_C,
                rack: Vec::new(),
            },
        ],
    );

    assert!(
        verdict.passed(PLAYER_INITIATOR),
        "the tiles were never spent"
    );
}

#[test]
fn a_failed_audit_loses_the_game_whatever_the_score_was() {
    let mut table = Table::new();
    table.open();

    // Both play honestly, then one of them lies about the rack they hold.
    for _ in 0..6 {
        table.play(Action::Pass).unwrap();
    }

    let liar = table.to_move();
    let mut mv = table.compose(table.view(liar).auto.expect("a reveal is due"));
    if let Action::Reveal { seed, .. } = mv.action {
        mv.action = Action::Reveal {
            seed,
            rack: vec![tile_of(b'q').unwrap(); RACK],
        };
    }
    table.submit(mv).unwrap();
    table.play_automatic().unwrap();

    let view = table.view(PLAYER_INITIATOR);
    let checked = view.audit.expect("the audit ran");

    assert!(
        !checked.ok[liar as usize],
        "the lie should have been caught"
    );
    assert_eq!(
        view.outcome,
        Some(Outcome::Winner { player: 1 - liar }),
        "the honest player wins whatever the score said"
    );
}

// -- accounting --------------------------------------------------------------

#[test]
fn the_public_tile_counts_always_add_up() {
    let mut table = Table::new();
    table.open();

    let a = table.view(PLAYER_INITIATOR);
    let b = table.view(PLAYER_CLAIMER);

    assert_eq!(
        a.bag as usize + a.rack.len() + b.rack.len(),
        TILE_TOTAL as usize
    );
    assert_eq!(a.bag, b.bag);
}

#[test]
fn a_challenged_game_replays_from_the_log_alone() {
    let (mut table, _) = game_where_the_opening_is_not_a_word();
    table.play_from_rack(3);
    table.play(Action::Challenge).unwrap();
    table.play_automatic().unwrap();
    table.play(Action::Pass).unwrap();

    for (seed, client) in [(SEED_I, &table.initiator), (SEED_C, &table.claimer)] {
        let replayed = table.replay_as(&seed).expect("replay");
        let expected = postcard::to_allocvec(&client.state).expect("state encodes");
        assert_eq!(replayed, expected);
    }
}

#[test]
fn a_reveal_entry_is_small_enough_for_the_relay_to_carry() {
    // The relay refuses entries over 64 KiB. A reveal is the largest thing this
    // game ever writes, so it is the one worth checking.
    let reveal = Move {
        nonce: nonce(1),
        rack_commitment: Some([0x11; 32]),
        action: Action::Reveal {
            seed: SEED_I,
            rack: vec![1; RACK],
        },
    };
    assert!(postcard::to_allocvec(&reveal).unwrap().len() < 1024);

    // And the biggest ordinary move, a seven-tile play.
    let full = Move {
        nonce: nonce(1),
        rack_commitment: Some([0x11; 32]),
        action: Action::Place {
            placements: (0..RACK as u8)
                .map(|i| Placement {
                    row: 7,
                    col: i,
                    tile: 1,
                    blank_as: None,
                })
                .collect(),
        },
    };
    assert!(postcard::to_allocvec(&full).unwrap().len() < 256);
    assert_eq!(SIZE, 15);
}
