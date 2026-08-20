//! Checking, after the fact, that nobody cheated.
//!
//! During a game neither player can verify the other's tiles: that is the whole
//! point of hidden state. What they can do is make promises — a hash of the rack
//! after every draw — and open them at the end. Once both seeds are published,
//! every draw either player made can be recomputed from scratch and checked
//! against those promises, and every tile they claimed to play can be checked
//! against the rack they must have been holding at the time.
//!
//! This runs on **both** devices and must reach the same verdict on each, so it
//! is a pure function of things both devices have: the public event log, the two
//! published seeds, and the commitments that went out along the way. It reads
//! nothing from either client's own state, which is also what makes it testable
//! against a log built by hand.
//!
//! A player who fails the audit loses, whatever the score said.

use serde::{Deserialize, Serialize};

use crate::tiles::{KINDS, Tile, TileCounts, contains_all, distribution};
use crate::v1::draw::{Hash, draw, mask_tiles, rack_commitment, seed_commitment};
use crate::v1::game::{Event, Revealed};
use tabla_plugin_api::PlayerId;

/// What went wrong, if anything did.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum Finding {
    /// The published seed is not the one committed at the start.
    WrongSeed,
    /// A tile was played that the recomputed rack never held.
    TilesNotHeld,
    /// A rack commitment does not describe the rack the draws produced.
    BrokenPromise,
    /// The rack shown at the end is not the one that should have been left.
    WrongFinalRack,
    /// An exchange unmasked to something that is not a tile.
    NotTiles,
}

impl Finding {
    pub fn describe(self) -> &'static str {
        match self {
            Self::WrongSeed => "published a different seed from the one committed",
            Self::TilesNotHeld => "played tiles that were never drawn",
            Self::BrokenPromise => "a rack commitment does not match the tiles drawn",
            Self::WrongFinalRack => "ended holding tiles that do not add up",
            Self::NotTiles => "exchanged something that is not a tile",
        }
    }
}

/// The result for both players.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct Verdict {
    pub findings: [Option<Finding>; 2],
}

impl Verdict {
    pub fn passed(&self, player: PlayerId) -> bool {
        self.findings[player as usize].is_none()
    }
}

/// Replays both players' draws and checks every promise either of them made.
pub fn audit(events: &[Event], reveals: &[Revealed; 2], committed: &[Hash; 2]) -> Verdict {
    Verdict {
        findings: [
            check(0, events, &reveals[0], &committed[0]),
            check(1, events, &reveals[1], &committed[1]),
        ],
    }
}

/// Rebuilds one player's whole game and compares it with what they said.
fn check(
    player: PlayerId,
    events: &[Event],
    revealed: &Revealed,
    committed: &Hash,
) -> Option<Finding> {
    if seed_commitment(&revealed.seed) != *committed {
        return Some(Finding::WrongSeed);
    }

    let seed = revealed.seed;
    let mut pool: TileCounts = distribution();
    let mut rack: Vec<Tile> = Vec::new();
    let mut draws = 0u32;
    let mut promises = 0u32;
    let mut exchanges = 0u32;

    for event in events {
        match event {
            // This player's own draw: recompute it and see what they got.
            Event::Draw {
                player: who,
                nonce,
                count,
            } if *who == player => {
                let tiles = draw(&seed, nonce, draws, *count, &mut pool);
                draws += tiles.len() as u32;
                rack.extend(tiles);
            }

            // A tile the opponent put down is a tile this player has seen, and
            // so will never draw. Lenient about tiles already drawn: both
            // players can hold the same one, which the draw protocol allows.
            Event::Played { player: who, tiles } | Event::Seen { player: who, tiles }
                if *who != player =>
            {
                forget(&mut pool, tiles);
            }

            // This player's own play: they must have been holding it.
            Event::Played { tiles, .. } => {
                if !take(&mut rack, tiles) {
                    return Some(Finding::TilesNotHeld);
                }
            }

            // A play of theirs that was challenged off the board. They held the
            // tiles, and got them back.
            Event::Seen { tiles, .. } => {
                if !holds(&rack, tiles) {
                    return Some(Finding::TilesNotHeld);
                }
            }

            Event::Exchanged {
                player: who,
                masked,
            } if *who == player => {
                let tiles = mask_tiles(&seed, exchanges, masked);
                exchanges += 1;

                if tiles.iter().any(|&t| t as usize >= KINDS) {
                    return Some(Finding::NotTiles);
                }
                if !take(&mut rack, &tiles) {
                    return Some(Finding::TilesNotHeld);
                }
                // Back into their own pool, where they might draw them again.
                for tile in tiles {
                    pool[tile as usize] += 1;
                }
            }

            Event::Commitment { player: who, hash } if *who == player => {
                if *hash != rack_commitment(&seed, promises, &rack) {
                    return Some(Finding::BrokenPromise);
                }
                promises += 1;
            }

            // Everything else belongs to the other player.
            _ => {}
        }
    }

    if !same_tiles(&rack, &revealed.rack) {
        return Some(Finding::WrongFinalRack);
    }
    None
}

fn holds(rack: &[Tile], tiles: &[Tile]) -> bool {
    let mut counts = [0u8; KINDS];
    for &tile in rack {
        if (tile as usize) < KINDS {
            counts[tile as usize] += 1;
        }
    }
    contains_all(&counts, tiles)
}

/// Removes `tiles` from `rack`, or reports that they were not all there.
fn take(rack: &mut Vec<Tile>, tiles: &[Tile]) -> bool {
    if !holds(rack, tiles) {
        return false;
    }
    for &tile in tiles {
        if let Some(at) = rack.iter().position(|&t| t == tile) {
            rack.swap_remove(at);
        }
    }
    true
}

fn forget(pool: &mut TileCounts, tiles: &[Tile]) {
    for &tile in tiles {
        if let Some(slot) = pool.get_mut(tile as usize)
            && *slot > 0
        {
            *slot -= 1;
        }
    }
}

fn same_tiles(a: &[Tile], b: &[Tile]) -> bool {
    let mut left = a.to_vec();
    let mut right = b.to_vec();
    left.sort_unstable();
    right.sort_unstable();
    left == right
}
