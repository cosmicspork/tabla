//! Letras dealt from a shared encrypted deck.
//!
//! The rules of the game are the ones in [`crate::v1`]: same board, same tiles,
//! same words, same tournament-style challenge. What changed is where tiles
//! come from.
//!
//! In v1 each player drew from the tiles *they* had not seen, from a secret of
//! their own, and the two streams were reconciled by an audit when the game
//! ended. It worked, and it cost something real: both players could hold the
//! same physical tile at once, so tile counting was soft and a cheat was only
//! ever *detectable*, never impossible.
//!
//! Here there is one deck. Both players shuffled it, neither can read it, and
//! every tile that moves does so with a proof attached. A player holds *deck
//! positions*; which positions is public, what is in them is not. Playing a
//! tile means opening it, and an opened tile is checkable by both sides — so
//! playing something you were not dealt is not a thing that can happen.
//!
//! ## What these rules do and do not check
//!
//! No cryptography happens in this module. It links none, and a test scans the
//! built artifact to keep it that way. Tile values arrive as facts through the
//! private channel, proven by the host before they get here, exactly as move
//! bytes arrive with their signatures already checked by the log layer.
//!
//! So: this module decides whether a play is geometrically legal, whether the
//! player holds the positions they are spending, what it scores, and who wins.
//! Whether position 41 really holds an E is somebody else's department.

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;

use tabla_dawg::Dawg;
use tabla_plugin_api::{
    GamePlugin, Outcome, PLAYER_CLAIMER, PLAYER_INITIATOR, PlayerId, PluginError,
};

use crate::board::*;
use crate::tiles::*;

/// A SHA-256 digest, used for the opening toss.
pub type Hash = [u8; 32];

/// Bumped with the format of `config`.
pub const CONFIG_VERSION: u8 = 2;

/// Consecutive turns that change nothing before the game is called off.
pub const SCORELESS_LIMIT: u8 = 6;

/// How many positions each player is dealt to start.
pub const OPENING: u16 = RACK as u16;

pub struct Letras;

// -- what this device knows privately ----------------------------------------

/// The private channel: which player this is, and the tiles it can read.
///
/// Assembled by the host from the deal, which proved every value in it. The
/// rules take it as given — see the note at the top of this module.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Private {
    pub player: PlayerId,
    /// `(deck position, tile)` for every position this device can read.
    pub tiles: Vec<(u16, Tile)>,
}

impl Private {
    pub fn encode(&self) -> Vec<u8> {
        postcard::to_allocvec(self).expect("a private blob always encodes")
    }

    pub fn decode(bytes: &[u8]) -> Result<Self, PluginError> {
        postcard::from_bytes(bytes).map_err(|_| PluginError::BadState)
    }
}

// -- moves -------------------------------------------------------------------

/// One entry's worth of play.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Move {
    pub action: Action,
    /// The deal payload this entry carries: key shares, a shuffle, decryption
    /// shares, or several at once.
    ///
    /// Opaque here. These rules check only that one is present when the
    /// protocol calls for it — proving it is the host's job, and it has done so
    /// before this module ever sees the move.
    ///
    /// Always encoded, even when absent: the wire format is not
    /// self-describing, so a field that sometimes vanishes is a field the
    /// reader cannot find again.
    pub deal: Option<Vec<u8>>,
}

/// A tile going down, and the deck position it came out of.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Laid {
    /// Where in the deck this tile was dealt from. Opened by this move.
    pub position: u16,
    pub row: u8,
    pub col: u8,
    /// What the position holds. Checked against the opening the host verified.
    pub tile: Tile,
    /// Required for a blank and forbidden otherwise.
    pub blank_as: Option<u8>,
}

impl Laid {
    fn placement(&self) -> Placement {
        Placement {
            row: self.row,
            col: self.col,
            tile: self.tile,
            blank_as: self.blank_as,
        }
    }
}

/// Externally tagged, because the wire encoding is not self-describing.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum Action {
    /// Publishes this player's half of the deck key, and their half of the
    /// opening toss — committed by the initiator, in the clear for the claimer,
    /// who moves second and so cannot use it to choose.
    ///
    /// The claimer's entry carries the first shuffle alongside it.
    Key {
        toss: Hash,
    },
    /// Shuffles the deck, opens the initiator's toss, and deals the claimer's
    /// opening rack.
    ///
    /// The second of the two shuffles: the claimer's rode on their [`Action::Key`].
    /// Both are needed — one shuffler would know the whole deck.
    Shuffle {
        entropy: Option<Hash>,
    },
    /// The claimer's ceremony turn: deals the initiator's opening rack.
    Deal,
    /// The turn spent because the toss gave the opening to the other player.
    Yield,
    Place {
        placements: Vec<Laid>,
    },
    /// Positions back to the bag. Unlike v1 there is nothing to mask: which
    /// positions were returned is public, and what was in them is not, because
    /// they go back into a deck the opponent cannot read either.
    Exchange {
        returned: Vec<u16>,
    },
    Pass,
    /// Disputes the opponent's last play. Legal only as the entry immediately
    /// after it, so the window is exactly one turn wide.
    Challenge,
    /// The turn a challenged player loses.
    Forfeit,
    /// Opens this player's remaining rack so the closing adjustment is public.
    ///
    /// Carries the values as well as the positions, for the same reason a play
    /// does: the opponent cannot read them until they are said out loud, and
    /// the deal payload alongside is what makes saying them believable.
    OpenRack {
        tiles: Vec<(u16, Tile)>,
    },
}

/// The play a challenge would be against.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LastPlay {
    pub by: PlayerId,
    pub placements: Vec<Laid>,
    pub words: Vec<String>,
    pub score: i32,
}

impl LastPlay {
    pub fn cells(&self) -> Vec<usize> {
        self.placements
            .iter()
            .map(|laid| laid.placement().cell())
            .collect()
    }
}

// -- state -------------------------------------------------------------------

/// One player's whole picture of the game.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct State {
    /// The word list both players agreed to, checked against `assets`.
    dictionary: Hash,
    /// Which player this device is.
    me: PlayerId,
    move_index: u32,

    board: Board,
    scores: [i32; 2],

    /// Deck positions each player holds. Public: dealing happens in the log.
    racks: [Vec<u16>; 2],
    /// What this device can read. Positions only it was dealt, plus everything
    /// that has been opened to everyone.
    known: BTreeMap<u16, Tile>,
    /// Next position off the top of the deck.
    pointer: u16,
    deck: u16,

    /// Positions owed to a player, handed over on the opponent's next entry.
    pending: [u16; 2],

    toss: [Option<Hash>; 2],
    first: Option<PlayerId>,

    last_play: Option<LastPlay>,
    scoreless: u8,
    /// The bag has run out and someone has gone out; only the openings remain.
    ending: bool,
    went_out: Option<PlayerId>,
    must_forfeit: Option<PlayerId>,
    opened: [bool; 2],
    finished: Option<Outcome>,
    final_scores: Option<[i32; 2]>,
}

/// What the game is waiting for.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Expect {
    Key,
    Shuffle,
    Deal,
    Yield,
    Play,
    Forfeit,
    Open,
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
            0 | 1 => Expect::Key,
            2 => Expect::Shuffle,
            3 => Expect::Deal,
            4 if self.first == Some(PLAYER_CLAIMER) => Expect::Yield,
            _ if self.ending => Expect::Open,
            _ => Expect::Play,
        }
    }

    /// How many positions this player owes the opponent in their next entry.
    ///
    /// The refill rule, and the reason none of this needs both players online:
    /// a tile spent now is replaced out of the opponent's next entry, which was
    /// going to exist anyway. Nothing is handed over before the play that earns
    /// it is already public.
    pub fn owed(&self, player: PlayerId) -> u16 {
        let them = 1 - player as usize;
        self.pending[them].min(self.deck.saturating_sub(self.pointer))
    }

    /// Positions this player must open now the game is ending.
    ///
    /// Empty until it is, and empty once they have: a rack is opened exactly
    /// once, at the end, for the closing adjustment. Playing a tile opens that
    /// tile, which is a different thing and belongs to the move that spends it.
    pub fn to_open(&self, player: PlayerId) -> Vec<u16> {
        if !self.ending || self.opened[player as usize] {
            return Vec::new();
        }
        self.racks[player as usize].clone()
    }

    /// Tiles still undealt.
    pub fn bag(&self) -> u16 {
        self.deck.saturating_sub(self.pointer)
    }

    pub fn rack(&self, player: PlayerId) -> &[u16] {
        &self.racks[player as usize]
    }

    /// This player's tiles, in the order they were dealt.
    fn my_tiles(&self) -> Vec<Tile> {
        self.racks[self.me as usize]
            .iter()
            .filter_map(|position| self.known.get(position).copied())
            .collect()
    }

    /// Whether this player may dispute what the opponent just played.
    pub fn can_challenge(&self, player: PlayerId) -> bool {
        self.finished.is_none()
            && self.to_move() == player
            && self
                .last_play
                .as_ref()
                .is_some_and(|play| play.by != player)
    }

    fn holds(&self, player: PlayerId, position: u16) -> bool {
        self.racks[player as usize].contains(&position)
    }

    fn take(&mut self, player: PlayerId, positions: &[u16]) {
        self.racks[player as usize].retain(|held| !positions.contains(held));
    }

    /// Ends the game if the bag is empty and someone has played out.
    fn check_ending(&mut self, player: PlayerId) {
        if self.racks[player as usize].is_empty() && self.bag() == 0 {
            self.ending = true;
            self.went_out = Some(player);
        }
        if self.scoreless >= SCORELESS_LIMIT {
            self.ending = true;
        }
    }

    /// Applies the closing adjustment once both racks are open.
    fn settle(&mut self) {
        if !self.opened.iter().all(|&done| done) {
            return;
        }

        let mut scores = self.scores;
        let mut left = [0i32; 2];
        for (player, remaining) in left.iter_mut().enumerate() {
            let tiles: Vec<Tile> = self.racks[player]
                .iter()
                .filter_map(|position| self.known.get(position).copied())
                .collect();
            *remaining = rack_value(&tiles);
        }

        // Whoever went out takes what the other is still holding; if nobody
        // did, each loses their own.
        match self.went_out {
            Some(winner) => {
                let loser = 1 - winner as usize;
                scores[winner as usize] += left[loser];
                scores[loser] -= left[loser];
            }
            None => {
                scores[0] -= left[0];
                scores[1] -= left[1];
            }
        }

        self.final_scores = Some(scores);
        self.finished = Some(match scores[0].cmp(&scores[1]) {
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

/// The configuration written into the log at sequence 1.
pub fn config_for(dictionary: &Hash) -> Vec<u8> {
    let mut config = Vec::with_capacity(1 + dictionary.len());
    config.push(CONFIG_VERSION);
    config.extend_from_slice(dictionary);
    config
}

fn parse_config(config: &[u8]) -> Result<Hash, PluginError> {
    if config.len() != 1 + 32 || config[0] != CONFIG_VERSION {
        return Err(PluginError::BadConfig);
    }
    config[1..].try_into().map_err(|_| PluginError::BadConfig)
}

impl GamePlugin for Letras {
    const ID: &'static str = "letras";
    const VERSION: u32 = 2;

    type State = State;
    type Move = Move;
    type View = View;

    fn setup(config: &[u8], private: &[u8], assets: &[u8]) -> Result<State, PluginError> {
        let dictionary = parse_config(config)?;

        // The word list is what the two players agreed to when the invite was
        // made. Checking it here rather than trusting the host is the point:
        // two clients reading different lists would disagree about whether a
        // challenged word is real, and there is no recovering from that.
        let actual: Hash = Sha256::digest(assets).into();
        if actual != dictionary {
            return Err(PluginError::BadAssets);
        }

        let private = Private::decode(private)?;
        if private.player > PLAYER_CLAIMER {
            return Err(PluginError::BadState);
        }

        Ok(State {
            dictionary,
            me: private.player,
            move_index: 0,
            board: empty_board(),
            scores: [0; 2],
            racks: [Vec::new(), Vec::new()],
            known: private.tiles.into_iter().collect(),
            pointer: 0,
            deck: u16::from(TILE_TOTAL),
            pending: [0, 0],
            toss: [None, None],
            first: None,
            last_play: None,
            scoreless: 0,
            ending: false,
            went_out: None,
            must_forfeit: None,
            opened: [false; 2],
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

        // A challenge cuts across whatever else the game was waiting for: the
        // window is open for exactly one entry.
        if let Action::Challenge = mv.action {
            return if state.can_challenge(player) {
                Ok(())
            } else {
                Err(PluginError::IllegalMove {
                    reason: "there is nothing to challenge",
                })
            };
        }

        let wrong_move = Err(PluginError::IllegalMove {
            reason: "that is not what the game is waiting for",
        });

        match (state.expected(), &mv.action) {
            (Expect::Key, Action::Key { .. }) => Ok(()),

            (Expect::Shuffle, Action::Shuffle { entropy }) => {
                let opened = entropy.ok_or(PluginError::IllegalMove {
                    reason: "the opening toss has to be opened here",
                })?;
                if state.toss[PLAYER_INITIATOR as usize] != Some(commitment(&opened)) {
                    return Err(PluginError::IllegalMove {
                        reason: "that does not open the commitment made at the start",
                    });
                }
                Ok(())
            }

            (Expect::Deal, Action::Deal) => Ok(()),
            (Expect::Yield, Action::Yield) => Ok(()),
            (Expect::Forfeit, Action::Forfeit) => Ok(()),

            (Expect::Open, Action::OpenRack { tiles }) => {
                // Exactly the rack, no more and no less: a player who could
                // leave a tile out would drop the penalty it carries.
                let mut named: Vec<u16> = tiles.iter().map(|(position, _)| *position).collect();
                named.sort_unstable();
                named.dedup();
                if named != state.racks[player as usize] {
                    return Err(PluginError::IllegalMove {
                        reason: "open the whole rack and nothing else",
                    });
                }
                for (position, tile) in tiles {
                    if let Some(&actual) = state.known.get(position)
                        && actual != *tile
                    {
                        return Err(PluginError::IllegalMove {
                            reason: "that is not the tile in that position",
                        });
                    }
                }
                Ok(())
            }

            (Expect::Play, Action::Place { placements }) => {
                let laid: Vec<Placement> = placements.iter().map(Laid::placement).collect();
                validate_placement(&state.board, &laid).map_err(|why| {
                    PluginError::IllegalMove {
                        reason: why.reason(),
                    }
                })?;

                // Spending a position twice in one play would be playing a tile
                // that is not there.
                let mut positions: Vec<u16> = placements.iter().map(|p| p.position).collect();
                positions.sort_unstable();
                positions.dedup();
                if positions.len() != placements.len() {
                    return Err(PluginError::IllegalMove {
                        reason: "the same tile cannot be played twice",
                    });
                }

                // Which positions a player holds is public, so both devices
                // check this and reach the same answer.
                for laid in placements {
                    if !state.holds(player, laid.position) {
                        return Err(PluginError::IllegalMove {
                            reason: "you are not holding that tile",
                        });
                    }
                    // And what is in them is checkable by whoever can read
                    // them, which after the opening is everybody.
                    if let Some(&actual) = state.known.get(&laid.position)
                        && actual != laid.tile
                    {
                        return Err(PluginError::IllegalMove {
                            reason: "that is not the tile in that position",
                        });
                    }
                }
                Ok(())
            }

            (Expect::Play, Action::Pass) => Ok(()),

            (Expect::Play, Action::Exchange { returned }) => {
                if returned.is_empty() || returned.len() > RACK {
                    return Err(PluginError::IllegalMove {
                        reason: "exchange between one and seven tiles",
                    });
                }
                // Exchanging with a nearly empty bag would be a way to stall.
                if state.bag() < OPENING {
                    return Err(PluginError::IllegalMove {
                        reason: "too few tiles left to exchange",
                    });
                }
                let mut unique = returned.clone();
                unique.sort_unstable();
                unique.dedup();
                if unique.len() != returned.len() {
                    return Err(PluginError::IllegalMove {
                        reason: "the same tile cannot be exchanged twice",
                    });
                }
                for position in returned {
                    if !state.holds(player, *position) {
                        return Err(PluginError::IllegalMove {
                            reason: "you are not holding that tile",
                        });
                    }
                }
                Ok(())
            }

            (Expect::Nothing, _) => Err(PluginError::GameOver),
            _ => wrong_move,
        }
    }

    fn apply_move(mut state: State, mv: &Move, assets: &[u8]) -> Result<State, PluginError> {
        let player = state.to_move();
        let them = 1 - player as usize;

        // Every entry hands over whatever the opponent is owed, whichever
        // action it carries — except a successful challenge, which cancels the
        // refill along with the play that earned it.
        let mut refill = true;

        match &mv.action {
            Action::Key { toss } => {
                state.toss[player as usize] = Some(*toss);
                // The claimer's entry is also where they shuffle, so from here
                // the deck is half made and their opening rack is owed. Setting
                // it now rather than when it is dealt is what lets the client
                // build the entry that deals it: `owed` has to be answerable
                // before the move it belongs to is applied.
                if player == PLAYER_CLAIMER {
                    state.pending[PLAYER_CLAIMER as usize] = OPENING;
                }
            }

            Action::Shuffle { entropy } => {
                // Both halves are now public; who opens is fixed by them.
                let opened = entropy.ok_or(PluginError::BadMove)?;
                let claimer = state.toss[PLAYER_CLAIMER as usize].ok_or(PluginError::BadMove)?;
                state.first = Some(first_player(&opened, &claimer));
                // The deck is finished shuffling, so the initiator's rack is
                // owed too — dealt out of the claimer's next entry.
                state.pending[PLAYER_INITIATOR as usize] = OPENING;
            }

            Action::Deal => {}

            Action::Yield | Action::Forfeit => {
                state.must_forfeit = None;
            }

            Action::Pass => {
                state.scoreless += 1;
                state.last_play = None;
            }

            Action::Place { placements } => {
                let laid: Vec<Placement> = placements.iter().map(Laid::placement).collect();
                let words = words_formed(&state.board, &laid);
                let score = score_play(&state.board, &laid);

                state.board = with_placements(&state.board, &laid);
                state.scores[player as usize] += score;
                state.scoreless = 0;

                let positions: Vec<u16> = placements.iter().map(|p| p.position).collect();
                state.take(player, &positions);
                // What was played is now open to both sides.
                for laid in placements {
                    state.known.insert(laid.position, laid.tile);
                }
                state.pending[player as usize] += positions.len() as u16;

                state.last_play = Some(LastPlay {
                    by: player,
                    placements: placements.clone(),
                    words: words
                        .iter()
                        .map(|w| String::from_utf8_lossy(&w.text()).into_owned())
                        .collect(),
                    score,
                });
            }

            Action::Exchange { returned } => {
                state.take(player, returned);
                state.pending[player as usize] += returned.len() as u16;
                state.scoreless += 1;
                state.last_play = None;
            }

            Action::Challenge => {
                let play = state.last_play.clone().ok_or(PluginError::BadMove)?;

                if every_word_is_real(&play, assets)? {
                    // The challenge failed, and cost the challenger the turn
                    // they spent making it. Nothing further is owed: the
                    // challenge *was* the forfeit.
                } else {
                    // The play comes off the board, with its score, its tiles,
                    // and the refill it had earned.
                    let opponent = play.by;
                    for laid in &play.placements {
                        state.board[laid.placement().cell()] = None;
                        state.racks[opponent as usize].push(laid.position);
                    }
                    state.racks[opponent as usize].sort_unstable();
                    state.scores[opponent as usize] -= play.score;
                    state.pending[opponent as usize] = state.pending[opponent as usize]
                        .saturating_sub(play.placements.len() as u16);
                    state.must_forfeit = Some(opponent);
                    refill = false;
                }

                state.last_play = None;
                state.scoreless += 1;
            }

            Action::OpenRack { tiles } => {
                for (position, tile) in tiles {
                    state.known.insert(*position, *tile);
                }
                state.opened[player as usize] = true;
            }
        }

        if refill {
            let owed = state.owed(player);
            if owed > 0 {
                let dealt: Vec<u16> = (0..owed).map(|i| state.pointer + i).collect();
                state.racks[them].extend_from_slice(&dealt);
                state.racks[them].sort_unstable();
                state.pointer += owed;
                state.pending[them] = state.pending[them].saturating_sub(owed);
            }
        }

        if !matches!(mv.action, Action::Challenge) {
            state.check_ending(player);
        }
        state.settle();
        state.move_index += 1;
        Ok(state)
    }

    fn player_view(state: &State, _player: PlayerId) -> View {
        let me = state.me;

        View {
            board: render_board(&state.board),
            premiums: render_premiums(),
            rack: render_rack(&state.my_tiles()),
            rack_positions: state.racks[me as usize].clone(),
            values: tile_values(),
            scores: state.scores,
            final_scores: state.final_scores,
            you: me,
            your_turn: state.finished.is_none() && state.to_move() == me,
            bag: state.bag(),
            opponent_tiles: state.racks[1 - me as usize].len() as u16,
            phase: match state.expected() {
                Expect::Key => "key",
                Expect::Shuffle => "shuffle",
                Expect::Deal => "deal",
                Expect::Yield => "yield",
                Expect::Play => "play",
                Expect::Forfeit => "forfeit",
                Expect::Open => "open",
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
            owed: state.owed(me),
            to_open: state.to_open(me),
            auto: automatic(state, me),
        }
    }

    fn is_game_over(state: &State) -> Option<Outcome> {
        state.finished
    }
}

/// Whether every word a play made is in the word list.
///
/// The only place the dictionary is consulted, and only when someone asks. A
/// play is legal the moment it is geometrically sound; whether it is *English*
/// is a question the opponent has to raise, and pays for if they raise it
/// wrongly.
fn every_word_is_real(play: &LastPlay, assets: &[u8]) -> Result<bool, PluginError> {
    let dictionary = Dawg::parse(assets).map_err(|_| PluginError::BadAssets)?;

    Ok(play
        .words
        .iter()
        .all(|word| dictionary.contains(word.as_bytes())))
}

fn commitment(entropy: &Hash) -> Hash {
    let mut h = Sha256::new();
    h.update(b"letras/toss/v2");
    h.update(entropy);
    h.finalize().into()
}

/// Who opens, from both halves of the toss.
///
/// The initiator commits to their half before the claimer names theirs, and
/// opens it afterwards, so neither can steer the result.
fn first_player(initiator: &Hash, claimer: &Hash) -> PlayerId {
    let mut h = Sha256::new();
    h.update(b"letras/first/v2");
    h.update(initiator);
    h.update(claimer);
    let digest: Hash = h.finalize().into();

    if digest[0] & 1 == 0 {
        PLAYER_INITIATOR
    } else {
        PLAYER_CLAIMER
    }
}

/// The move the client should submit without troubling the player.
///
/// Key shares, shuffles, dealing and the closing openings are protocol rather
/// than play: the rules work out what has to be said and the client signs it.
/// The client still has to attach the matching deal payload — see `owed` and
/// `toOpen` in the view.
fn automatic(state: &State, me: PlayerId) -> Option<Action> {
    if state.to_move() != me || state.finished.is_some() {
        return None;
    }

    match state.expected() {
        Expect::Key => Some(Action::Key {
            // The initiator commits; the claimer, who cannot use it to choose,
            // publishes in the clear.
            toss: if me == PLAYER_INITIATOR {
                commitment(&toss_half(state, me))
            } else {
                toss_half(state, me)
            },
        }),
        Expect::Shuffle => Some(Action::Shuffle {
            entropy: Some(toss_half(state, me)),
        }),
        Expect::Deal => Some(Action::Deal),
        Expect::Yield => Some(Action::Yield),
        Expect::Forfeit => Some(Action::Forfeit),
        Expect::Open => Some(Action::OpenRack {
            tiles: state
                .to_open(me)
                .into_iter()
                .filter_map(|position| state.known.get(&position).map(|&tile| (position, tile)))
                .collect(),
        }),
        _ => None,
    }
}

/// This player's half of the toss.
///
/// Derived from what this device already holds rather than asked for: the
/// dictionary hash pins the game, and the player index separates the two
/// halves. Nothing here needs to be unpredictable to an outside observer — only
/// to the opponent before they commit, which the ordering already guarantees.
fn toss_half(state: &State, me: PlayerId) -> Hash {
    let mut h = Sha256::new();
    h.update(b"letras/toss-half/v2");
    h.update(state.dictionary);
    h.update([me]);
    for (position, tile) in &state.known {
        h.update(position.to_le_bytes());
        h.update([*tile]);
    }
    h.finalize().into()
}

// -- the view ----------------------------------------------------------------

/// What one player is entitled to see.
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
    /// The deck positions those tiles came from, in the same order.
    ///
    /// The UI names a tile by its position when playing it, because that is
    /// what the deal understands and what the opening will refer to.
    pub rack_positions: Vec<u16>,
    /// What each letter scores, `a` first.
    pub values: Vec<i32>,
    pub scores: [i32; 2],
    /// Only once the game is settled, and after the closing adjustment.
    pub final_scores: Option<[i32; 2]>,
    pub you: PlayerId,
    pub your_turn: bool,
    /// Tiles still undealt. Exact, unlike v1, because there is one real deck.
    pub bag: u16,
    pub opponent_tiles: u16,
    pub phase: &'static str,
    pub first: Option<PlayerId>,
    pub outcome: Option<Outcome>,
    pub scoreless: u8,
    pub last_play: Option<LastPlayView>,
    /// Whether this player may dispute what the opponent just played.
    pub can_challenge: bool,
    /// How many tiles this player's next entry must deal to the opponent.
    ///
    /// The client turns this into a deal payload. The rules cannot build one —
    /// they hold no key — but they are the only thing that knows the count.
    pub owed: u16,
    /// Positions this player must open now the game is ending.
    pub to_open: Vec<u16>,
    /// A move the client should make on its own.
    pub auto: Option<Action>,
}

/// The last play, as the UI needs it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LastPlayView {
    pub by: PlayerId,
    pub words: Vec<String>,
    pub cells: Vec<usize>,
    pub score: i32,
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
    rack.iter()
        .map(|&tile| {
            if tile == BLANK {
                '?'
            } else {
                letter_of(tile) as char
            }
        })
        .collect()
}

fn tile_values() -> Vec<i32> {
    (1..=26).map(value).collect()
}
