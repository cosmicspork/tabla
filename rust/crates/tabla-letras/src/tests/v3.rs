//! Two clients, one log, one deck — version 3.
//!
//! The harness stands in for the deal rather than running it. A fixed bag is
//! laid out in a fixed order, and each client is handed the values of the
//! positions it holds, which is exactly what the real deal produces once its
//! proofs check out. Substituting it here is the point: these tests are about
//! the *rules*, and the rules link no cryptography at all.
//!
//! The two run together in the same way the real ones do — build the private
//! facts from the public racks, replay the whole log, and refuse to let the two
//! devices disagree about anything either of them can see.
//!
//! The other half, where these rules run against the real deck with real
//! proofs, is `tabla-deal/tests/letras_v3.rs`. The dependency points that way
//! round on purpose: nothing under the plugin may reach the curve code.

use tabla_plugin_api::{
    BytePlugin, GamePlugin, PLAYER_CLAIMER, PLAYER_INITIATOR, PlayerId, PluginError,
};

use crate::tiles::{BLANK, TILE_TOTAL, Tile, distribution, tile_of};
use crate::v3::Plugin;
use crate::v3::game::{Action, Laid, Letras as Game, Move, Private, State, View, config_for};

/// A word list small enough that a test can say exactly what is and is not a
/// word. Compiled with the real builder, so the reader is exercised too.
pub const DEFAULT_WORDS: [&str; 27] = [
    "at", "ate", "cat", "cats", "cot", "cots", "do", "dog", "dogs", "eat", "eats", "in", "into",
    "it", "no", "not", "on", "one", "so", "sat", "set", "ten", "tin", "to", "toe", "ton", "too",
];

fn dictionary_hash(bytes: &[u8]) -> [u8; 32] {
    use sha2::{Digest, Sha256};
    Sha256::digest(bytes).into()
}

/// The deck, standing in for a shuffle nobody can read.
///
/// Deterministic and public to the test, which is what lets a test say "play
/// the word CAT" — the real deal is unpredictable by construction, so a test
/// that needed a particular rack could not exist against it.
fn deck() -> Vec<Tile> {
    let counts = distribution();
    let mut bag: Vec<Tile> = Vec::with_capacity(TILE_TOTAL as usize);
    for (kind, &count) in counts.iter().enumerate() {
        for _ in 0..count {
            bag.push(kind as Tile);
        }
    }

    // A fixed interleave, so the opening racks are a mixture rather than eight
    // copies of the same letter.
    let mut shuffled = Vec::with_capacity(bag.len());
    let stride = 17;
    let mut at = 0usize;
    let mut taken = vec![false; bag.len()];
    for _ in 0..bag.len() {
        while taken[at] {
            at = (at + 1) % bag.len();
        }
        taken[at] = true;
        shuffled.push(bag[at]);
        at = (at + stride) % bag.len();
    }
    shuffled
}

/// Both clients plus the shared log, driven together.
pub struct Table {
    pub moves: Vec<Move>,
    pub assets: Vec<u8>,
    pub config: Vec<u8>,
    deck: Vec<Tile>,
}

impl Table {
    pub fn new() -> Self {
        Self::with_words(&DEFAULT_WORDS)
    }

    pub fn with_words(words: &[&str]) -> Self {
        let mut sorted: Vec<&str> = words.to_vec();
        sorted.sort_unstable();
        sorted.dedup();

        let assets = tabla_dawg::build::compile(&sorted).expect("test word list compiles");
        let config = config_for(&dictionary_hash(&assets));

        Self {
            moves: Vec::new(),
            assets,
            config,
            deck: deck(),
        }
    }

    pub fn to_move(&self) -> PlayerId {
        (self.moves.len() % 2) as PlayerId
    }

    /// One client's state, rebuilt from the log exactly as the app rebuilds it.
    pub fn state(&self, who: PlayerId) -> State {
        let private = self.private_for(who);
        let mut state =
            Game::setup(&self.config, &private.encode(), &self.assets).expect("setup succeeds");

        for (index, mv) in self.moves.iter().enumerate() {
            let mover = (index % 2) as PlayerId;
            Game::validate_move(&state, mv, mover, &self.assets).expect("a replayed move is legal");
            state = Game::apply_move(state, mv, &self.assets).expect("a replayed move applies");
        }
        state
    }

    /// What this device would know: the values of the positions it holds.
    ///
    /// Built from the *public* racks, which is why it can be worked out without
    /// already knowing them — the deal publishes who holds what, and hides only
    /// what is in it.
    fn private_for(&self, who: PlayerId) -> Private {
        let blind = Private {
            player: who,
            tiles: Vec::new(),
        };

        // Replay knowing nothing to learn the shape, then fill in the values.
        let mut state =
            Game::setup(&self.config, &blind.encode(), &self.assets).expect("setup succeeds");
        for (index, mv) in self.moves.iter().enumerate() {
            let mover = (index % 2) as PlayerId;
            if Game::validate_move(&state, mv, mover, &self.assets).is_err() {
                break;
            }
            match Game::apply_move(state.clone(), mv, &self.assets) {
                Ok(next) => state = next,
                Err(_) => break,
            }
        }

        Private {
            player: who,
            tiles: state
                .rack(who)
                .iter()
                .map(|&position| (position, self.deck[position as usize]))
                .collect(),
        }
    }

    pub fn view(&self, who: PlayerId) -> View {
        Game::player_view(&self.state(who), who)
    }

    /// Plays one move, checking it against both clients.
    pub fn play(&mut self, action: Action) -> Result<(), PluginError> {
        let who = self.to_move();
        let mv = Move {
            action,
            // The deal payload is the host's business. These tests replace it
            // with a marker, because the rules only ever check that one is
            // there when the protocol calls for it.
            deal: Some(vec![0xde, 0xa1]),
        };

        // The mover validates before signing; the opponent validates on
        // receipt. Both must agree, or one would reject a legal move.
        Game::validate_move(&self.state(who), &mv, who, &self.assets)?;
        Game::validate_move(&self.state(1 - who), &mv, who, &self.assets)?;

        self.moves.push(mv);
        self.agree();
        Ok(())
    }

    /// Plays whatever the rules say the client should submit on its own.
    pub fn play_automatic(&mut self) -> Result<(), PluginError> {
        let who = self.to_move();
        let action = self
            .view(who)
            .auto
            .expect("the rules asked for an automatic move");
        self.play(action)
    }

    /// Fails if the two clients have drifted apart on anything public.
    pub fn agree(&self) {
        let a = self.view(PLAYER_INITIATOR);
        let b = self.view(PLAYER_CLAIMER);

        assert_eq!(a.board, b.board, "boards diverged");
        assert_eq!(a.scores, b.scores, "scores diverged");
        assert_eq!(a.bag, b.bag, "bag counts diverged");
        assert_eq!(a.phase, b.phase, "phases diverged");
        assert_eq!(a.outcome, b.outcome, "outcomes diverged");
        assert_eq!(a.final_scores, b.final_scores, "final scores diverged");
        assert_eq!(a.first, b.first, "first player diverged");
        assert_eq!(a.scoreless, b.scoreless, "scoreless counts diverged");

        // Which positions each player holds is public here, unlike v1 where
        // only the count was. That is what makes tile counting exact.
        assert_eq!(
            a.rack_positions.len(),
            b.opponent_tiles as usize,
            "rack sizes disagree"
        );
        assert_eq!(
            b.rack_positions.len(),
            a.opponent_tiles as usize,
            "rack sizes disagree"
        );
    }

    /// Runs the opening: keys, shuffles, the deal, and a yield if it is owed.
    pub fn open(&mut self) {
        self.play_automatic().expect("initiator publishes its key");
        self.play_automatic().expect("claimer publishes its key");
        self.play_automatic().expect("initiator shuffles and deals");
        self.play_automatic().expect("claimer deals");

        if self.view(PLAYER_INITIATOR).auto == Some(Action::Yield) {
            self.play_automatic().expect("initiator yields");
        }
    }

    /// Plays the first `count` tiles of the mover's rack across the centre row.
    pub fn play_from_rack(&mut self, count: usize) -> String {
        self.try_play_from_rack(count)
            .expect("a play from one's own rack is legal")
    }

    /// The same, but handing back the refusal.
    ///
    /// Needed now that a play can be refused for what it spells rather than
    /// only for where it was put: that is the normal path, not an error path.
    pub fn try_play_from_rack(&mut self, count: usize) -> Result<String, PluginError> {
        let who = self.to_move();
        let view = self.view(who);

        let placements: Vec<Laid> = view
            .rack
            .bytes()
            .zip(&view.rack_positions)
            .take(count)
            .enumerate()
            .map(|(i, (byte, &position))| Laid {
                position,
                row: 7,
                col: 7 + i as u8,
                tile: if byte == b'?' {
                    BLANK
                } else {
                    tile_of(byte).expect("rack letters")
                },
                blank_as: (byte == b'?').then_some(tile_of(b'e').unwrap()),
            })
            .collect();

        let word: String = view
            .rack
            .chars()
            .take(count)
            .map(|c| if c == '?' { 'e' } else { c })
            .collect();

        self.play(Action::Place { placements })?;
        Ok(word)
    }

    /// What the opening rack would spell, without playing anything.
    pub fn opening_word(count: usize) -> String {
        let mut scratch = Table::new();
        scratch.open();
        let who = scratch.to_move();

        scratch
            .view(who)
            .rack
            .chars()
            .take(count)
            .map(|c| if c == '?' { 'e' } else { c })
            .collect()
    }

    /// Replays the log through the byte-level adapter, as a client does when it
    /// opens a game it has not been watching.
    pub fn replay_as(&self, who: PlayerId) -> Result<Vec<u8>, PluginError> {
        let encoded: Vec<Vec<u8>> = self
            .moves
            .iter()
            .map(|mv| postcard::to_allocvec(mv).expect("moves encode"))
            .collect();

        Plugin::new().replay(
            &self.config,
            &self.private_for(who).encode(),
            &encoded,
            &self.assets,
        )
    }
}

impl Default for Table {
    fn default() -> Self {
        Self::new()
    }
}

// -- the opening --------------------------------------------------------------

#[test]
fn the_opening_deals_both_players_a_rack() {
    let mut table = Table::new();
    table.open();

    let initiator = table.view(PLAYER_INITIATOR);
    let claimer = table.view(PLAYER_CLAIMER);

    assert_eq!(initiator.rack.chars().count(), 7);
    assert_eq!(claimer.rack.chars().count(), 7);
    assert_eq!(initiator.bag, u16::from(TILE_TOTAL) - 14);
    assert_eq!(initiator.phase, "play");
}

#[test]
fn each_player_sees_their_own_tiles_and_none_of_the_others() {
    let mut table = Table::new();
    table.open();

    let initiator = table.view(PLAYER_INITIATOR);
    let claimer = table.view(PLAYER_CLAIMER);

    // The positions are public; the letters in them are not.
    assert_eq!(initiator.rack_positions.len(), 7);
    assert_eq!(claimer.rack_positions.len(), 7);
    assert!(
        initiator
            .rack_positions
            .iter()
            .all(|p| !claimer.rack_positions.contains(p)),
        "the two racks must not overlap"
    );
    assert_ne!(initiator.rack, claimer.rack);
}

#[test]
fn no_position_is_ever_dealt_twice() {
    // The property the deal buys and v1 could not: one real deck, so a tile
    // exists in exactly one place.
    let mut table = Table::new();
    table.open();

    for _ in 0..6 {
        if table.view(table.to_move()).auto.is_some() {
            table.play_automatic().expect("protocol move");
            continue;
        }
        table.play(Action::Pass).expect("a pass is always legal");
    }

    let initiator = table.view(PLAYER_INITIATOR);
    let claimer = table.view(PLAYER_CLAIMER);

    let mut all: Vec<u16> = initiator
        .rack_positions
        .iter()
        .chain(&claimer.rack_positions)
        .copied()
        .collect();
    let before = all.len();
    all.sort_unstable();
    all.dedup();
    assert_eq!(all.len(), before, "a position was held by both players");
}

#[test]
fn the_toss_decides_who_opens_and_the_other_yields() {
    let mut table = Table::new();
    table.open();

    let view = table.view(PLAYER_INITIATOR);
    let first = view.first.expect("the toss is settled by now");

    // Whoever the toss chose is the one holding the move.
    assert_eq!(table.to_move(), first);
    assert_eq!(view.phase, "play");
}

// -- playing ------------------------------------------------------------------

#[test]
fn a_play_scores_and_refills_on_the_opponents_next_entry() {
    let word = Table::opening_word(3);
    let mut table = Table::with_words(&[word.as_str()]);
    table.open();

    let mover = table.to_move();
    table.play_from_rack(3);

    // The tiles are spent, and nothing has replaced them yet: a refill waits
    // for the opponent's entry, which is what makes the deal work without both
    // players being online.
    assert_eq!(table.view(mover).rack.chars().count(), 4);
    assert!(table.view(mover).scores[mover as usize] > 0);
    assert_eq!(table.view(1 - mover).owed, 3);

    table.play(Action::Pass).expect("the opponent passes");

    assert_eq!(table.view(mover).rack.chars().count(), 7);
    assert_eq!(table.view(mover).owed, 0);
}

#[test]
fn a_player_cannot_play_a_tile_they_do_not_hold() {
    let word = Table::opening_word(2);
    let mut table = Table::with_words(&[word.as_str()]);
    table.open();

    let who = table.to_move();
    let theirs = table.view(1 - who).rack_positions[0];

    let result = table.play(Action::Place {
        placements: vec![Laid {
            position: theirs,
            row: 7,
            col: 7,
            tile: tile_of(b'a').unwrap(),
            blank_as: None,
        }],
    });

    assert!(matches!(result, Err(PluginError::IllegalMove { .. })));
}

#[test]
fn a_player_cannot_claim_a_position_holds_something_it_does_not() {
    // The claim is checkable by anyone who can read the position, and after
    // the opening that is both of them.
    let word = Table::opening_word(2);
    let mut table = Table::with_words(&[word.as_str()]);
    table.open();

    let who = table.to_move();
    let view = table.view(who);
    let position = view.rack_positions[0];
    let real = tile_of(view.rack.as_bytes()[0]).unwrap_or(BLANK);
    let lie = if real == tile_of(b'z').unwrap() {
        tile_of(b'a').unwrap()
    } else {
        tile_of(b'z').unwrap()
    };

    let result = table.play(Action::Place {
        placements: vec![Laid {
            position,
            row: 7,
            col: 7,
            tile: lie,
            blank_as: None,
        }],
    });

    assert!(matches!(result, Err(PluginError::IllegalMove { .. })));
}

#[test]
fn the_same_tile_cannot_be_played_twice_in_one_move() {
    let word = Table::opening_word(2);
    let mut table = Table::with_words(&[word.as_str()]);
    table.open();

    let who = table.to_move();
    let view = table.view(who);
    let position = view.rack_positions[0];
    let tile = tile_of(view.rack.as_bytes()[0]).unwrap_or(BLANK);

    let laid = |col: u8| Laid {
        position,
        row: 7,
        col,
        tile,
        blank_as: (tile == BLANK).then_some(tile_of(b'e').unwrap()),
    };

    let result = table.play(Action::Place {
        placements: vec![laid(7), laid(8)],
    });

    assert!(matches!(result, Err(PluginError::IllegalMove { .. })));
}

// -- words --------------------------------------------------------------------

#[test]
fn a_word_that_is_not_in_the_list_is_refused_before_it_is_played() {
    // A word list that contains nothing the opening rack can spell.
    let mut table = Table::with_words(&["zzzz"]);
    table.open();

    let mover = table.to_move();
    let before = table.view(mover).rack_positions.clone();

    let refused = table.try_play_from_rack(3);
    assert!(
        matches!(refused, Err(PluginError::NotAWord { .. })),
        "expected a refusal naming the word, got {refused:?}"
    );

    // Nothing happened: no score, no board, no tiles spent. The move was never
    // written, so there is nothing to take back.
    let after = table.view(mover);
    assert_eq!(after.scores[mover as usize], 0);
    assert_eq!(after.rack_positions, before);
    assert!(after.board.chars().all(|c| c == '.'));
    assert_eq!(table.to_move(), mover);
}

#[test]
fn the_refusal_says_which_word_was_the_problem() {
    let mut table = Table::with_words(&["zzzz"]);
    table.open();

    let word = Table::opening_word(3);
    let Err(PluginError::NotAWord { word: named }) = table.try_play_from_rack(3) else {
        panic!("expected a refusal naming the word");
    };

    // A play can make several words; saying "that is not a word" would leave a
    // player to work out which one.
    assert_eq!(named, word.to_uppercase());
}

#[test]
fn a_real_word_is_taken_and_scores() {
    let word = Table::opening_word(3);
    let mut table = Table::with_words(&[word.as_str()]);
    table.open();

    let mover = table.to_move();
    table.play_from_rack(3);

    assert!(table.view(mover).scores[mover as usize] > 0);
    assert_eq!(table.view(mover).rack_positions.len(), 4);
}

#[test]
fn the_opponent_reaches_the_same_verdict_when_they_replay_it() {
    // The whole basis for checking words here: both devices hold the identical
    // list, pinned by hash, so the mover's answer and the opponent's cannot
    // differ. A play that one accepted and the other rejected would be a fork.
    let word = Table::opening_word(3);
    let mut table = Table::with_words(&[word.as_str()]);
    table.open();

    let mover = table.to_move();
    table.play_from_rack(3);

    table.replay_as(1 - mover).expect("the opponent replays it");
    table.agree();
}

// -- exchanges ----------------------------------------------------------------

#[test]
fn an_exchange_returns_positions_and_draws_replacements() {
    let mut table = Table::new();
    table.open();

    let who = table.to_move();
    let before = table.view(who).rack_positions.clone();
    let returned = vec![before[0], before[1]];

    table
        .play(Action::Exchange {
            returned: returned.clone(),
        })
        .expect("an exchange from one's own rack is legal");

    assert_eq!(table.view(who).rack_positions.len(), 5);
    table.play(Action::Pass).expect("the opponent passes");

    let after = table.view(who).rack_positions;
    assert_eq!(after.len(), 7);
    // The returned positions are gone for good; the replacements are new.
    assert!(returned.iter().all(|p| !after.contains(p)));
}

#[test]
fn a_player_cannot_exchange_a_tile_they_do_not_hold() {
    let mut table = Table::new();
    table.open();

    let who = table.to_move();
    let theirs = table.view(1 - who).rack_positions[0];

    let result = table.play(Action::Exchange {
        returned: vec![theirs],
    });

    assert!(matches!(result, Err(PluginError::IllegalMove { .. })));
}

// -- replay -------------------------------------------------------------------

#[test]
fn a_log_replays_to_the_same_position_on_a_device_that_was_not_watching() {
    let word = Table::opening_word(3);
    let mut table = Table::with_words(&[word.as_str()]);
    table.open();
    table.play_from_rack(3);
    table.play(Action::Pass).expect("the opponent passes");

    for who in [PLAYER_INITIATOR, PLAYER_CLAIMER] {
        let replayed = table.replay_as(who).expect("the log replays");
        let expected = postcard::to_allocvec(&table.state(who)).expect("state encodes");
        assert_eq!(
            replayed, expected,
            "player {who} replayed to a different state"
        );
    }
}

#[test]
fn a_move_out_of_turn_is_refused() {
    let mut table = Table::new();
    table.open();

    let who = table.to_move();
    let state = table.state(who);
    let mv = Move {
        action: Action::Pass,
        deal: None,
    };

    assert!(matches!(
        Game::validate_move(&state, &mv, 1 - who, &table.assets),
        Err(PluginError::NotYourTurn)
    ));
}
