//! Two clients, one log.
//!
//! The thing worth testing about a game with hidden state is that two devices
//! replaying the same entries with *different* secrets agree about everything
//! public and disagree about exactly the right private things. So the harness
//! runs both sides for real: every move is validated and applied by both
//! clients, and any divergence in the public picture fails the test on the spot.

use tabla_plugin_api::{BytePlugin, PLAYER_CLAIMER, PLAYER_INITIATOR, PlayerId, PluginError};

use crate::v1::draw::{Hash, Nonce};
use crate::v1::game::{Action, Move, State, View, config_for};
use crate::v1::{Letras as Game, Plugin};
use tabla_plugin_api::GamePlugin;

pub const SEED_I: [u8; 32] = [0x11; 32];
pub const SEED_C: [u8; 32] = [0x22; 32];

/// A word list small enough that a test can say exactly what is and is not a
/// word. Compiled with the real builder, so the reader is exercised too.
pub const DEFAULT_WORDS: [&str; 27] = [
    "at", "ate", "cat", "cats", "cot", "cots", "do", "dog", "dogs", "eat", "eats", "in", "into",
    "it", "no", "not", "on", "one", "so", "sat", "set", "ten", "tin", "to", "toe", "ton", "too",
];

pub fn dictionary() -> Vec<u8> {
    tabla_dawg::build::compile(&DEFAULT_WORDS).expect("test word list compiles")
}

pub fn dictionary_hash(bytes: &[u8]) -> Hash {
    use sha2::{Digest, Sha256};
    Sha256::digest(bytes).into()
}

/// Nonces are the one thing a client must draw from real randomness. Tests use
/// a counter instead, which is fine here and would not be in a browser.
pub fn nonce(n: u8) -> Nonce {
    [n; 24]
}

/// One player's client: its own secret, its own replayed state.
pub struct Client {
    pub state: State,
}

/// Both clients plus the shared log, driven together.
pub struct Table {
    pub initiator: Client,
    pub claimer: Client,
    pub moves: Vec<Move>,
    pub assets: Vec<u8>,
    pub config: Vec<u8>,
    next_nonce: u8,
}

impl Table {
    pub fn new() -> Self {
        Self::with_words(&DEFAULT_WORDS)
    }

    /// A game whose word list is chosen by the test.
    ///
    /// Racks are dealt by the draw protocol and cannot be arranged, so a test
    /// about challenges works the other way round: find out what was dealt, then
    /// build a word list that does or does not contain what can be spelled with
    /// it. The deal does not depend on the word list, so the same tiles come up
    /// either way.
    pub fn with_words(words: &[&str]) -> Self {
        let mut sorted: Vec<&str> = words.to_vec();
        sorted.sort_unstable();
        sorted.dedup();

        let assets = tabla_dawg::build::compile(&sorted).expect("test word list compiles");
        let config = config_for(&dictionary_hash(&assets));

        Self {
            initiator: Client {
                state: Game::setup(&config, &SEED_I, &assets).expect("setup"),
            },
            claimer: Client {
                state: Game::setup(&config, &SEED_C, &assets).expect("setup"),
            },
            moves: Vec::new(),
            assets,
            config,
            next_nonce: 1,
        }
    }

    pub fn to_move(&self) -> PlayerId {
        (self.moves.len() % 2) as PlayerId
    }

    fn client(&self, who: PlayerId) -> &Client {
        if who == PLAYER_INITIATOR {
            &self.initiator
        } else {
            &self.claimer
        }
    }

    /// What the player to move sees.
    pub fn view(&self, who: PlayerId) -> View {
        Game::player_view(&self.client(who).state, who)
    }

    /// Assembles a move the way a client does: fresh nonce, the commitment the
    /// rules say is owed, and the action.
    pub fn compose(&mut self, action: Action) -> Move {
        let who = self.to_move();
        let commitment = self.view(who).rack_commitment;
        self.next_nonce = self.next_nonce.wrapping_add(1);

        Move {
            nonce: nonce(self.next_nonce),
            rack_commitment: commitment,
            action,
        }
    }

    /// Plays one move, checking it against both clients.
    pub fn play(&mut self, action: Action) -> Result<(), PluginError> {
        let mv = self.compose(action);
        self.submit(mv)
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

    pub fn submit(&mut self, mv: Move) -> Result<(), PluginError> {
        let who = self.to_move();

        // The mover validates before signing; the opponent validates on
        // receipt. Both must agree, or one of them would reject a legal move.
        Game::validate_move(&self.client(who).state, &mv, who, &self.assets)?;
        Game::validate_move(&self.client(1 - who).state, &mv, who, &self.assets)?;

        for client in [&mut self.initiator, &mut self.claimer] {
            client.state = Game::apply_move(client.state.clone(), &mv, &self.assets)?;
        }
        self.moves.push(mv);
        self.agree();
        Ok(())
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

        // Each sees their own tiles and only a count of the other's.
        assert_eq!(
            a.rack.len(),
            b.opponent_tiles as usize,
            "rack sizes disagree"
        );
        assert_eq!(
            b.rack.len(),
            a.opponent_tiles as usize,
            "rack sizes disagree"
        );
    }

    /// Plays the first `count` tiles of the mover's rack across the centre row,
    /// and reports what they spelled.
    ///
    /// Racks are dealt, not chosen, so a test that cares about a particular word
    /// has to find out what it was handed and build its word list to suit.
    pub fn play_from_rack(&mut self, count: usize) -> String {
        let who = self.to_move();
        let rack = self.view(who).rack;

        let placements: Vec<crate::board::Placement> = rack
            .bytes()
            .take(count)
            .enumerate()
            .map(|(i, byte)| crate::board::Placement {
                row: 7,
                col: 7 + i as u8,
                tile: if byte == b'?' {
                    crate::tiles::BLANK
                } else {
                    crate::tiles::tile_of(byte).expect("rack letters")
                },
                // A blank has to stand for something; `e` will do.
                blank_as: (byte == b'?').then_some(crate::tiles::tile_of(b'e').unwrap()),
            })
            .collect();

        let word: String = rack
            .chars()
            .take(count)
            .map(|c| if c == '?' { 'e' } else { c })
            .collect();

        self.play(Action::Place { placements })
            .expect("a play from one's own rack is legal");
        word
    }

    /// What the opening rack would spell, without playing anything.
    ///
    /// Used to build a word list before the game that will use it exists.
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

    /// Runs the opening: two commitments, the toss, and a yield if it is owed.
    pub fn open(&mut self) {
        self.play_automatic().expect("initiator commits");
        self.play_automatic().expect("claimer commits");
        self.play_automatic().expect("initiator opens the toss");

        if self.view(PLAYER_CLAIMER).auto == Some(Action::Yield) {
            self.play_automatic().expect("claimer yields");
        }
    }

    /// Replays the whole log through the byte-level adapter, as a client does
    /// when it opens a game it has not been watching.
    pub fn replay_as(&self, seed: &[u8; 32]) -> Result<Vec<u8>, PluginError> {
        let encoded: Vec<Vec<u8>> = self
            .moves
            .iter()
            .map(|mv| postcard::to_allocvec(mv).expect("moves encode"))
            .collect();

        Plugin::new().replay(&self.config, seed, &encoded, &self.assets)
    }
}

impl Default for Table {
    fn default() -> Self {
        Self::new()
    }
}
