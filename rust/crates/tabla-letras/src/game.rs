//! The rules, as a state machine over the log.
//!
//! Every client replays the same entries and must reach the same conclusions
//! about everything public — scores, whose turn it is, how many tiles are left —
//! while reaching *different* conclusions about what is on each rack, because
//! each replays with only its own secret. That is the whole trick, and it is why
//! [`State`] is a **per-player view** rather than a shared position: there is no
//! moment at which the true global state exists anywhere.
//!
//! # The shape of a game
//!
//! ```text
//! 0  initiator  Commit  H(seed), and a commitment to their half of the toss
//! 1  claimer    Commit  H(seed), and their half of the toss in the clear
//! 2  initiator  Toss    opens their half; who plays first falls out of both
//! 3  claimer    plays, or Yield if the toss went the other way
//! 4  …          alternating turns until the bag and a rack are empty
//! n  both       Reveal  seeds and final racks, so every draw can be checked
//! ```
//!
//! Turns alternate strictly, because the log alternates strictly. Passing,
//! exchanging and yielding are therefore all real entries that consume a turn:
//! there is no way to "not move".

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tabla_plugin_api::{
    GamePlugin, Outcome, PLAYER_CLAIMER, PLAYER_INITIATOR, PlayerId, PluginError,
};

use tabla_dawg::Dawg;

use crate::audit::{Verdict, audit};
use crate::board::*;
use crate::draw::*;
use crate::tiles::*;

/// Leading byte of the configuration blob, so its shape can change later.
pub const CONFIG_VERSION: u8 = 1;

/// Consecutive turns that change nothing before the game is called off.
pub const SCORELESS_LIMIT: u8 = 6;

pub struct Letras;

// -- moves -------------------------------------------------------------------

/// One entry's worth of play.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Move {
    /// Fresh randomness from the client, which keys the *opponent's* next
    /// refill. It must come from the system generator and never from anything
    /// derived, or the opponent's draw stops being unpredictable to them.
    pub nonce: Nonce,
    /// Present exactly when this player has drawn since their last entry.
    ///
    /// Not skipped when absent: the wire format is not self-describing, so a
    /// field that sometimes vanishes is a field the reader cannot find again.
    pub rack_commitment: Option<Hash>,
    pub action: Action,
}

/// Externally tagged, because the wire encoding is not self-describing and an
/// internally tagged enum cannot be read back out of it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Action {
    /// Opens the game. `toss` is a commitment to the initiator's half of the
    /// first-player draw, and the claimer's half in the clear — the claimer
    /// moves second here, so theirs is safe to publish.
    Commit {
        seed_hash: Hash,
        toss: Hash,
    },
    /// The initiator opening the commitment made at move 0.
    Toss {
        entropy: Hash,
    },
    /// The claimer's turn, spent because the toss gave the opening to the
    /// initiator. Turn order in the log is fixed, so someone has to spend it.
    Yield,
    Place {
        placements: Vec<Placement>,
    },
    /// Tiles back to the bag. Which ones is masked until the reveal: the count
    /// has to be public, but what a player threw away says a great deal about
    /// what they kept.
    Exchange {
        masked: Vec<u8>,
    },
    Pass,
    /// Disputes the opponent's last play. Legal only as the entry immediately
    /// after it, so the window is exactly one turn wide.
    Challenge,
    /// The turn a challenged player loses. A no-op, but the log alternates
    /// strictly, so a lost turn has to be something rather than nothing.
    Forfeit,
    /// Publishes this player's seed and final rack so every draw they made can
    /// be recomputed and checked.
    Reveal {
        seed: [u8; 32],
        rack: Vec<Tile>,
    },
}

// -- state -------------------------------------------------------------------

/// A public event, in the order it happened. The audit replays these.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum Event {
    Draw {
        player: PlayerId,
        nonce: Nonce,
        count: u8,
    },
    Played {
        player: PlayerId,
        tiles: Vec<Tile>,
    },
    /// A play that was challenged off the board. The opponent saw the tiles and
    /// will never draw them; the player who put them down still holds them.
    Seen {
        player: PlayerId,
        tiles: Vec<Tile>,
    },
    Exchanged {
        player: PlayerId,
        masked: Vec<u8>,
    },
    Commitment {
        player: PlayerId,
        hash: Hash,
    },
}

/// The play a challenge would be against: what went down, what it spelled, and
/// what it scored, all of which have to be undone if the challenge succeeds.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LastPlay {
    pub by: PlayerId,
    pub placements: Vec<Placement>,
    pub words: Vec<String>,
    pub score: i32,
}

impl LastPlay {
    pub fn cells(&self) -> Vec<usize> {
        self.placements.iter().map(Placement::cell).collect()
    }
}

/// What a player published at the end.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Revealed {
    pub seed: [u8; 32],
    pub rack: Vec<Tile>,
}

/// One player's whole picture of the game.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct State {
    /// The word list both players agreed to, checked against `assets`.
    dictionary: Hash,
    /// This player's secret. Never leaves the plugin until the reveal.
    seed: [u8; 32],
    /// Which player this device is, learned by matching a commitment.
    me: Option<PlayerId>,
    move_index: u32,

    board: Board,
    scores: [i32; 2],

    /// My tiles. The opponent's are a number and a promise.
    rack: Vec<Tile>,
    opponent_tiles: u8,
    /// Tiles left to draw. Public: both sides compute it identically.
    bag: u8,
    /// Tiles I have not seen — what I draw from. Private, and deliberately not
    /// the same set the opponent draws from.
    unseen: TileCounts,
    draws: u32,
    my_exchanges: u32,

    /// Tiles owed to a player, handed over on the opponent's next entry.
    pending: [u8; 2],
    /// Who owes a rack commitment. Public: drawing is public, contents are not.
    owed: [bool; 2],

    seed_hash: [Option<Hash>; 2],
    toss_commitment: Option<Hash>,
    toss_claimer: Option<Hash>,
    first: Option<PlayerId>,

    published: [Vec<Hash>; 2],
    events: Vec<Event>,

    last_play: Option<LastPlay>,
    scoreless: u8,
    /// The game has run out; only reveals remain.
    ending: bool,
    /// Who played out their rack, if that is how it ended.
    went_out: Option<PlayerId>,
    /// Who owes the no-op turn a lost challenge costs them.
    must_forfeit: Option<PlayerId>,
    reveals: [Option<Revealed>; 2],
    verdict: Option<Verdict>,
    finished: Option<Outcome>,
    final_scores: Option<[i32; 2]>,
}

/// What the game is waiting for.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Expect {
    Commit,
    Toss,
    Yield,
    Play,
    Forfeit,
    Reveal,
    Nothing,
}

impl State {
    /// Whose turn it is. Fixed by the log's alternation, not by the game.
    pub fn to_move(&self) -> PlayerId {
        (self.move_index % 2) as PlayerId
    }

    pub fn expected(&self) -> Expect {
        if self.finished.is_some() {
            return Expect::Nothing;
        }
        if self.must_forfeit == Some(self.to_move()) {
            return Expect::Forfeit;
        }
        match self.move_index {
            0 | 1 => Expect::Commit,
            2 => Expect::Toss,
            3 if self.first == Some(PLAYER_INITIATOR) => Expect::Yield,
            _ if self.ending => Expect::Reveal,
            _ => Expect::Play,
        }
    }

    /// Whether this player may dispute what is on the board right now.
    ///
    /// Only the entry immediately after a play, and only against the other
    /// player: anything else the opponent does closes the window, which is what
    /// makes waiving a challenge implicit rather than a move of its own.
    pub fn can_challenge(&self, player: PlayerId) -> bool {
        self.finished.is_none()
            && self.must_forfeit.is_none()
            && self
                .last_play
                .as_ref()
                .is_some_and(|play| play.by != player)
    }

    /// Puts a challenged play back where it came from.
    ///
    /// The tiles return to the rack they came off, the score goes back, and the
    /// premium squares are freed again by the simple fact that nothing is
    /// sitting on them. The refill that play had earned is cancelled — which is
    /// exactly why refills wait for the opponent's next entry rather than
    /// landing immediately.
    fn retract(&mut self, play: &LastPlay) {
        let tiles: Vec<Tile> = play.placements.iter().map(|p| p.tile).collect();

        for placement in &play.placements {
            self.board[placement.cell()] = None;
        }
        self.scores[play.by as usize] -= play.score;
        self.pending[play.by as usize] = 0;

        if self.me == Some(play.by) {
            self.rack.extend(tiles.iter().copied());
        } else {
            self.opponent_tiles += tiles.len() as u8;
            // Not returned to the unseen pool: they were seen, and they are
            // provably on the opponent's rack rather than back in the bag.
        }

        // The audit needs to know these tiles went down and came back, or it
        // would conclude the player spent tiles they still hold.
        if let Some(event) = self
            .events
            .iter_mut()
            .rev()
            .find(|e| matches!(e, Event::Played { player, .. } if *player == play.by))
        {
            *event = Event::Seen {
                player: play.by,
                tiles,
            };
        }

        // A play that emptied a rack has been taken back, so the game is not
        // over after all.
        if self.went_out == Some(play.by) {
            self.went_out = None;
            self.ending = false;
        }
    }

    /// The rack commitment this player's next entry has to carry.
    fn owed_commitment(&self) -> Option<Hash> {
        let me = self.me?;
        self.owed[me as usize].then(|| {
            rack_commitment(
                &self.seed,
                self.published[me as usize].len() as u32,
                &self.rack,
            )
        })
    }

    /// Hands a player the tiles they are owed, keyed by this entry's nonce.
    fn refill(&mut self, player: PlayerId, nonce: &Nonce) {
        let owed = self.pending[player as usize].min(self.bag);
        self.pending[player as usize] = 0;
        if owed == 0 {
            return;
        }

        self.bag -= owed;
        if self.me == Some(player) {
            let tiles = draw(&self.seed, nonce, self.draws, owed, &mut self.unseen);
            self.draws += tiles.len() as u32;
            self.rack.extend(tiles);
        } else {
            self.opponent_tiles += owed;
        }

        self.owed[player as usize] = true;
        self.events.push(Event::Draw {
            player,
            nonce: *nonce,
            count: owed,
        });
    }

    /// Notes tiles this player will never draw, because they have seen them.
    ///
    /// Lenient about tiles that are not there: the opponent may legitimately
    /// have played a tile this player had already drawn a copy of, which is the
    /// ghost the module documentation warns about.
    fn forget(&mut self, tiles: &[Tile]) {
        for &tile in tiles {
            if let Some(slot) = self.unseen.get_mut(tile as usize)
                && *slot > 0
            {
                *slot -= 1;
            }
        }
    }

    fn take_from_rack(&mut self, tiles: &[Tile]) -> Result<(), PluginError> {
        for &tile in tiles {
            let at = self
                .rack
                .iter()
                .position(|&t| t == tile)
                .ok_or(PluginError::IllegalMove {
                    reason: "you do not hold that tile",
                })?;
            self.rack.swap_remove(at);
        }
        Ok(())
    }

    /// Whether the game has just run out.
    fn check_ending(&mut self, player: PlayerId) {
        if self.ending {
            return;
        }
        if self.scoreless >= SCORELESS_LIMIT {
            self.ending = true;
            return;
        }
        if self.bag == 0 {
            let empty = if self.me == Some(player) {
                self.rack.is_empty()
            } else {
                self.opponent_tiles == 0
            };
            if empty {
                self.ending = true;
                self.went_out = Some(player);
            }
        }
    }

    /// Settles the game once both players have opened their racks.
    ///
    /// The audit comes first and outranks the score: a player who cannot show
    /// that their tiles were the ones they drew has lost, however far ahead
    /// they were.
    fn settle(&mut self) {
        let (Some(a), Some(b)) = (&self.reveals[0], &self.reveals[1]) else {
            return;
        };

        let committed = [
            self.seed_hash[0].unwrap_or_default(),
            self.seed_hash[1].unwrap_or_default(),
        ];
        let verdict = audit(&self.events, &[a.clone(), b.clone()], &committed);
        self.verdict = Some(verdict);

        match (verdict.passed(0), verdict.passed(1)) {
            (true, true) => {}
            (false, true) => {
                self.finished = Some(Outcome::Winner {
                    player: PLAYER_CLAIMER,
                });
                return;
            }
            (true, false) => {
                self.finished = Some(Outcome::Winner {
                    player: PLAYER_INITIATOR,
                });
                return;
            }
            // Nobody can claim a game neither of them played straight.
            (false, false) => {
                self.finished = Some(Outcome::Draw);
                return;
            }
        }

        let held = [rack_value(&a.rack), rack_value(&b.rack)];
        let mut final_scores = self.scores;

        match self.went_out {
            // Going out takes what the other player is left holding.
            Some(player) => {
                let other = 1 - player as usize;
                final_scores[player as usize] += held[other];
                final_scores[other] -= held[other];
            }
            // Nobody went out, so both pay for what they are stuck with.
            None => {
                final_scores[0] -= held[0];
                final_scores[1] -= held[1];
            }
        }

        self.final_scores = Some(final_scores);
        self.finished = Some(match final_scores[0].cmp(&final_scores[1]) {
            core::cmp::Ordering::Greater => Outcome::Winner {
                player: PLAYER_INITIATOR,
            },
            core::cmp::Ordering::Less => Outcome::Winner {
                player: PLAYER_CLAIMER,
            },
            core::cmp::Ordering::Equal => Outcome::Draw,
        });
    }
}

/// Reads the configuration written into the log when the game was set up.
fn parse_config(config: &[u8]) -> Result<Hash, PluginError> {
    match config {
        [CONFIG_VERSION, rest @ ..] if rest.len() == 32 => {
            Ok(rest.try_into().expect("checked length"))
        }
        _ => Err(PluginError::BadConfig),
    }
}

/// Builds the configuration blob for a new game.
pub fn config_for(dictionary: &Hash) -> Vec<u8> {
    let mut out = Vec::with_capacity(33);
    out.push(CONFIG_VERSION);
    out.extend_from_slice(dictionary);
    out
}

// -- the plugin --------------------------------------------------------------

impl GamePlugin for Letras {
    const ID: &'static str = "letras";
    const VERSION: u32 = 1;

    type State = State;
    type Move = Move;
    type View = View;

    fn setup(config: &[u8], seed: &[u8; 32], assets: &[u8]) -> Result<State, PluginError> {
        let dictionary = parse_config(config)?;

        // The word list is what the two players agreed to when the invite was
        // made. Checking it here rather than trusting the host is the point:
        // two clients reading different lists would disagree about whether a
        // challenged word is real, and there is no recovering from that.
        let actual: Hash = Sha256::digest(assets).into();
        if actual != dictionary {
            return Err(PluginError::BadAssets);
        }

        Ok(State {
            dictionary,
            seed: *seed,
            me: None,
            move_index: 0,
            board: empty_board(),
            scores: [0; 2],
            rack: Vec::new(),
            opponent_tiles: 0,
            bag: TILE_TOTAL,
            unseen: distribution(),
            draws: 0,
            my_exchanges: 0,
            // The initiator's opening rack is dealt on the claimer's first
            // entry, which is the earliest nonce that postdates the initiator's
            // commitment. The claimer's is dealt one entry later, for the same
            // reason from the other side.
            pending: [RACK as u8, 0],
            owed: [false; 2],
            seed_hash: [None, None],
            toss_commitment: None,
            toss_claimer: None,
            first: None,
            published: [Vec::new(), Vec::new()],
            events: Vec::new(),
            last_play: None,
            scoreless: 0,
            ending: false,
            went_out: None,
            must_forfeit: None,
            reveals: [None, None],
            verdict: None,
            finished: None,
            final_scores: None,
        })
    }

    fn validate_move(
        state: &State,
        mv: &Move,
        player: PlayerId,
        _assets: &[u8],
    ) -> Result<(), PluginError> {
        if state.finished.is_some() {
            return Err(PluginError::GameOver);
        }
        if player != state.to_move() {
            return Err(PluginError::NotYourTurn);
        }

        // Drawing is public, so both players know when a commitment is owed
        // even though only one of them can check what it says.
        if mv.rack_commitment.is_some() != state.owed[player as usize] {
            return Err(PluginError::IllegalMove {
                reason: "a rack commitment is owed after drawing, and only then",
            });
        }
        if state.me == Some(player) && mv.rack_commitment != state.owed_commitment() {
            return Err(PluginError::IllegalMove {
                reason: "that is not a commitment to the rack you are holding",
            });
        }

        let wrong_move = Err(PluginError::IllegalMove {
            reason: "that is not what the game is waiting for",
        });

        // A challenge cuts across whatever else the game was waiting for: the
        // window is open for exactly one entry, including the entry that would
        // otherwise have started the reveals.
        if let Action::Challenge = mv.action {
            return if state.can_challenge(player) {
                Ok(())
            } else {
                Err(PluginError::IllegalMove {
                    reason: "there is nothing to challenge",
                })
            };
        }

        match (state.expected(), &mv.action) {
            (Expect::Commit, Action::Commit { .. }) => Ok(()),

            (Expect::Toss, Action::Toss { entropy }) => {
                if state.toss_commitment != Some(digest_of(entropy)) {
                    return Err(PluginError::IllegalMove {
                        reason: "that does not open the commitment made at the start",
                    });
                }
                Ok(())
            }

            (Expect::Yield, Action::Yield) => Ok(()),

            (Expect::Forfeit, Action::Forfeit) => Ok(()),

            (Expect::Play, Action::Place { placements }) => {
                validate_placement(&state.board, placements).map_err(|why| {
                    PluginError::IllegalMove {
                        reason: why.reason(),
                    }
                })?;

                // Whether the opponent really holds what they claim is not
                // knowable here; it is checked at the reveal.
                if state.me == Some(player) {
                    let tiles: Vec<Tile> = placements.iter().map(|p| p.tile).collect();
                    let mut held = [0u8; KINDS];
                    for &tile in &state.rack {
                        held[tile as usize] += 1;
                    }
                    if !contains_all(&held, &tiles) {
                        return Err(PluginError::IllegalMove {
                            reason: "you do not hold those tiles",
                        });
                    }
                }
                Ok(())
            }

            (Expect::Play, Action::Pass) => Ok(()),

            (Expect::Play, Action::Exchange { masked }) => {
                if masked.is_empty() || masked.len() > RACK {
                    return Err(PluginError::IllegalMove {
                        reason: "exchange between one and seven tiles",
                    });
                }
                // Exchanging with a nearly empty bag would be a way to stall.
                if (state.bag as usize) < RACK {
                    return Err(PluginError::IllegalMove {
                        reason: "too few tiles left to exchange",
                    });
                }
                if state.me == Some(player) && masked.len() > state.rack.len() {
                    return Err(PluginError::IllegalMove {
                        reason: "you do not hold that many tiles",
                    });
                }
                Ok(())
            }

            (Expect::Reveal, Action::Reveal { seed, .. }) => {
                if state.seed_hash[player as usize] != Some(seed_commitment(seed)) {
                    return Err(PluginError::IllegalMove {
                        reason: "that is not the seed committed at the start",
                    });
                }
                Ok(())
            }

            (Expect::Nothing, _) => Err(PluginError::GameOver),
            _ => wrong_move,
        }
    }

    fn apply_move(mut state: State, mv: &Move, assets: &[u8]) -> Result<State, PluginError> {
        let player = state.to_move();
        let opponent = 1 - player;

        // A challenge is settled before anything else, because a successful one
        // cancels the refill the disputed play had earned. That is the reason
        // refills wait for this entry instead of landing when the play is made.
        let upheld = match mv.action {
            Action::Challenge => {
                let play = state.last_play.clone().ok_or(PluginError::BadState)?;
                let good = every_word_is_real(&play, assets)?;
                if !good {
                    state.retract(&play);
                    state.must_forfeit = Some(play.by);
                }
                Some(good)
            }
            _ => None,
        };

        // Whatever the opponent is owed is dealt against this entry's nonce —
        // unless the play that earned it has just been taken back.
        state.refill(opponent, &mv.nonce);

        if let Some(hash) = mv.rack_commitment {
            state.published[player as usize].push(hash);
            state.events.push(Event::Commitment { player, hash });
            state.owed[player as usize] = false;
        }

        match &mv.action {
            Action::Commit { seed_hash, toss } => {
                state.seed_hash[player as usize] = Some(*seed_hash);
                if *seed_hash == seed_commitment(&state.seed) {
                    state.me = Some(player);
                }

                if player == PLAYER_INITIATOR {
                    state.toss_commitment = Some(*toss);
                } else {
                    state.toss_claimer = Some(*toss);
                    // The claimer has now committed, so their opening rack can
                    // be dealt against the initiator's next nonce.
                    state.pending[PLAYER_CLAIMER as usize] = RACK as u8;

                    if state.me.is_none() {
                        return Err(PluginError::IllegalMove {
                            reason: "this game was not dealt to this device",
                        });
                    }
                }
            }

            Action::Toss { entropy } => {
                let claimer = state.toss_claimer.ok_or(PluginError::BadState)?;
                state.first = Some(first_player(entropy, &claimer));
            }

            Action::Yield => {}

            Action::Place { placements } => {
                let tiles: Vec<Tile> = placements.iter().map(|p| p.tile).collect();
                let words = words_formed(&state.board, placements);
                let score = score_play(&state.board, placements);

                state.board = with_placements(&state.board, placements);
                state.scores[player as usize] += score;

                if state.me == Some(player) {
                    state.take_from_rack(&tiles)?;
                } else {
                    state.opponent_tiles = state.opponent_tiles.saturating_sub(tiles.len() as u8);
                    state.forget(&tiles);
                }

                state.last_play = Some(LastPlay {
                    by: player,
                    placements: placements.clone(),
                    words: words
                        .iter()
                        .map(|w| String::from_utf8_lossy(&w.text()).into_owned())
                        .collect(),
                    score,
                });

                state.pending[player as usize] = tiles.len() as u8;
                state.events.push(Event::Played { player, tiles });
                state.scoreless = 0;
            }

            Action::Exchange { masked } => {
                let count = masked.len() as u8;

                if state.me == Some(player) {
                    let tiles = mask_tiles(&state.seed, state.my_exchanges, masked);
                    if tiles.iter().any(|&t| t as usize >= KINDS) {
                        return Err(PluginError::IllegalMove {
                            reason: "those are not tiles",
                        });
                    }
                    state.take_from_rack(&tiles)?;
                    // Back into my own pool: I may well draw them again.
                    for tile in tiles {
                        state.unseen[tile as usize] += 1;
                    }
                    state.my_exchanges += 1;
                } else {
                    state.opponent_tiles = state.opponent_tiles.saturating_sub(count);
                }

                // The tiles went back, so the bag is no smaller than it was.
                state.bag += count;
                state.pending[player as usize] = count;
                state.events.push(Event::Exchanged {
                    player,
                    masked: masked.clone(),
                });
                state.scoreless += 1;
                state.last_play = None;
            }

            Action::Pass => {
                state.scoreless += 1;
                state.last_play = None;
            }

            Action::Challenge => {
                // Right or wrong, the challenge cost this turn and closed the
                // window: a play cannot be disputed twice.
                state.scoreless += 1;
                state.last_play = None;
                debug_assert!(upheld.is_some(), "a challenge was adjudicated above");
            }

            Action::Forfeit => {
                state.must_forfeit = None;
                state.scoreless += 1;
                state.last_play = None;
            }

            Action::Reveal { seed, rack } => {
                if state.me != Some(player) {
                    state.forget(rack);
                }
                state.reveals[player as usize] = Some(Revealed {
                    seed: *seed,
                    rack: rack.clone(),
                });
                state.settle();
            }
        }

        state.check_ending(player);
        state.move_index += 1;
        Ok(state)
    }

    fn player_view(state: &State, player: PlayerId) -> View {
        let me = state.me.unwrap_or(player);

        View {
            board: render_board(&state.board),
            premiums: render_premiums(),
            rack: render_rack(&state.rack),
            values: tile_values(),
            scores: state.scores,
            final_scores: state.final_scores,
            you: me,
            your_turn: state.finished.is_none() && state.to_move() == me,
            bag: state.bag,
            opponent_tiles: state.opponent_tiles,
            phase: match state.expected() {
                Expect::Commit => "commit",
                Expect::Toss => "toss",
                Expect::Yield => "yield",
                Expect::Play => "play",
                Expect::Forfeit => "forfeit",
                Expect::Reveal => "reveal",
                Expect::Nothing => "over",
            },
            first: state.first,
            outcome: state.finished,
            scoreless: state.scoreless,
            last_play: state.last_play.as_ref().map(|play| LastPlayView {
                by: play.by,
                words: play.words.clone(),
                cells: play.cells(),
                score: play.score,
            }),
            can_challenge: state.can_challenge(me),
            audit: state.verdict.map(|verdict| AuditView {
                ok: [verdict.passed(0), verdict.passed(1)],
                notes: verdict
                    .findings
                    .map(|finding| finding.map(|f| f.describe().to_string())),
            }),
            rack_commitment: state.owed_commitment(),
            auto: automatic(state, me),
        }
    }

    fn is_game_over(state: &State) -> Option<Outcome> {
        state.finished
    }
}

/// Whether every word a play made is in the word list.
///
/// This is the only place the dictionary is consulted, and it happens only when
/// someone asks. A play is legal the moment it is geometrically sound; whether
/// it is *English* is a question the opponent has to raise, and pays for if they
/// raise it wrongly. Checking it automatically would make bluffing impossible
/// and turn the word list into a rule rather than a referee.
fn every_word_is_real(play: &LastPlay, assets: &[u8]) -> Result<bool, PluginError> {
    let dictionary = Dawg::parse(assets).map_err(|_| PluginError::BadAssets)?;

    Ok(play
        .words
        .iter()
        .all(|word| dictionary.contains(word.as_bytes())))
}

fn digest_of(bytes: &[u8]) -> Hash {
    let mut h = Sha256::new();
    h.update(b"letras/first/v1");
    h.update(bytes);
    h.finalize().into()
}

/// The move the client should submit without troubling the player.
///
/// Commitments, the toss, and the reveal are protocol, not play: the plugin
/// works out what has to be said and the client signs it. Keeping this here
/// rather than in the UI means the UI never has to know how any of it works.
fn automatic(state: &State, me: PlayerId) -> Option<Action> {
    if state.to_move() != me {
        return None;
    }

    match state.expected() {
        Expect::Commit => Some(Action::Commit {
            seed_hash: seed_commitment(&state.seed),
            toss: if me == PLAYER_INITIATOR {
                digest_of(&first_entropy(&state.seed))
            } else {
                first_entropy(&state.seed)
            },
        }),
        Expect::Toss => Some(Action::Toss {
            entropy: first_entropy(&state.seed),
        }),
        Expect::Yield => Some(Action::Yield),
        Expect::Forfeit => Some(Action::Forfeit),
        Expect::Reveal => Some(Action::Reveal {
            seed: state.seed,
            rack: state.rack.clone(),
        }),
        _ => None,
    }
}

// -- the view ----------------------------------------------------------------

/// What one player is entitled to see.
///
/// The board, the rack and the premium layout are strings of one character per
/// square, which keeps a fifteen-by-fifteen board from becoming a wall of JSON
/// on every render — and means the UI cannot disagree with the rules about
/// where the premium squares are, because it is not told twice.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct View {
    /// 225 characters: `.` empty, `a`-`z` a tile, `A`-`Z` a blank read as that
    /// letter.
    pub board: String,
    /// 225 characters: `.` plain, `S` start, `d`/`t` letter, `D`/`T` word.
    pub premiums: String,
    /// This player's tiles, `?` for a blank.
    pub rack: String,
    /// What each letter scores, `a` first.
    pub values: Vec<i32>,
    pub scores: [i32; 2],
    /// Only once the game is settled, and after the end-of-game adjustments.
    pub final_scores: Option<[i32; 2]>,
    pub you: PlayerId,
    pub your_turn: bool,
    pub bag: u8,
    pub opponent_tiles: u8,
    pub phase: &'static str,
    pub first: Option<PlayerId>,
    pub outcome: Option<Outcome>,
    pub scoreless: u8,
    pub last_play: Option<LastPlayView>,
    /// Whether this player may dispute what the opponent just played.
    pub can_challenge: bool,
    /// Present once both seeds are open and every draw has been rechecked.
    pub audit: Option<AuditView>,
    /// The commitment this player's next entry must carry, to be passed back
    /// verbatim.
    pub rack_commitment: Option<Hash>,
    /// A move the client should make on its own.
    pub auto: Option<Action>,
}

/// The last play, as the UI needs it: what it spelled, where, and for how much.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LastPlayView {
    pub by: PlayerId,
    pub words: Vec<String>,
    pub cells: Vec<usize>,
    pub score: i32,
}

/// What the end-of-game check concluded about each player.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AuditView {
    pub ok: [bool; 2],
    pub notes: [Option<String>; 2],
}

fn render_board(board: &[Option<Placed>]) -> String {
    board
        .iter()
        .map(|square| match square {
            None => '.',
            Some(placed) if placed.blank => (letter_of(placed.letter) as char).to_ascii_uppercase(),
            Some(placed) => letter_of(placed.letter) as char,
        })
        .collect()
}

fn render_premiums() -> String {
    (0..CELLS)
        .map(|cell| match premium(cell) {
            Premium::None => '.',
            Premium::Start => 'S',
            Premium::DoubleLetter => 'd',
            Premium::TripleLetter => 't',
            Premium::DoubleWord => 'D',
            Premium::TripleWord => 'T',
        })
        .collect()
}

fn render_rack(rack: &[Tile]) -> String {
    rack.iter().map(|&tile| letter_of(tile) as char).collect()
}

fn tile_values() -> Vec<i32> {
    (1..=26).map(value).collect()
}
