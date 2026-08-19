//! Where the tiles come from.
//!
//! # The problem
//!
//! Two clients, no server that can be trusted with anything, and a bag of tiles
//! neither player may see. Whatever draws a tile has to satisfy three things at
//! once: the drawing player must be able to compute their own tile, the opponent
//! must not be able to compute it, and afterwards anyone must be able to check
//! that no one cheated.
//!
//! A jointly shuffled bag cannot do this. If both players can derive the shuffle
//! they can both read the whole bag, including each other's racks; if neither
//! can, neither can draw. Opening part of a shared shuffle without opening the
//! rest is mental poker, which needs a live opponent for every draw and so
//! belongs to the real-time tier, not to a game played over three days.
//!
//! # What happens instead
//!
//! Each player has their own private draw stream. Player P's *i*th tile is
//! chosen by
//!
//! ```text
//! SHA-256(s_P ‖ nonce ‖ i)
//! ```
//!
//! where `s_P` is P's secret for this game and `nonce` is fresh randomness from
//! the **opponent's** most recent log entry. P commits to `H(s_P)` before any
//! nonce they will draw against exists, so P cannot search for a seed that deals
//! well; the opponent picks nonces without knowing `s_P`, so they cannot steer
//! the draw either. The result is fixed before either player can want it to be
//! anything in particular.
//!
//! At the end of the game both players publish `s_P` and every draw can be
//! recomputed and checked against the rack commitments published along the way.
//! Cheating is not prevented; it is made visible afterwards, which is the right
//! bar for a game between people who know each other.
//!
//! # The cost, stated plainly
//!
//! P draws from the tiles *P has not seen*, which includes whatever is sitting
//! on the opponent's rack. So both players can hold the same physical tile at
//! once — two of a one-tile letter can appear on the board over a game. Tile
//! counting is softened as a result. This is the honest price of asynchronous
//! hidden state, and the alternative is the real-time tier.

use sha2::{Digest, Sha256};

use crate::tiles::{Tile, TileCounts};

/// Domain tags, so no hash computed for one purpose can be replayed as another.
const DRAW: &[u8] = b"letras/draw/v1";
const SALT: &[u8] = b"letras/salt/v1";
const MASK: &[u8] = b"letras/mask/v1";
const FIRST: &[u8] = b"letras/first/v1";
const RACK_COMMIT: &[u8] = b"letras/rack/v1";

pub type Hash = [u8; 32];
pub type Nonce = [u8; 24];

fn digest(parts: &[&[u8]]) -> Hash {
    let mut h = Sha256::new();
    for part in parts {
        h.update(part);
    }
    h.finalize().into()
}

/// `H(seed)`, published at the start and checked when the seed is revealed.
pub fn seed_commitment(seed: &[u8; 32]) -> Hash {
    digest(&[b"letras/seed/v1", seed])
}

/// This player's contribution to the toss for who plays first.
pub fn first_entropy(seed: &[u8; 32]) -> Hash {
    digest(&[FIRST, seed])
}

/// Who opens, from both contributions. Neither side can steer it: the initiator
/// commits to theirs before seeing the claimer's.
pub fn first_player(initiator: &Hash, claimer: &Hash) -> u8 {
    digest(&[FIRST, initiator, claimer])[0] & 1
}

/// The salt hiding the *i*th rack commitment.
///
/// Derived rather than random so that a restored backup can reproduce it, and
/// so the reveal at the end of the game need only carry the seed.
pub fn salt(seed: &[u8; 32], index: u32) -> Hash {
    digest(&[SALT, seed, &index.to_le_bytes()])
}

/// A promise about what is on a rack, which the audit checks afterwards.
///
/// The rack is sorted first so that the same tiles always commit to the same
/// value however they happen to be ordered in memory.
pub fn rack_commitment(seed: &[u8; 32], index: u32, rack: &[Tile]) -> Hash {
    let mut sorted = rack.to_vec();
    sorted.sort_unstable();
    digest(&[RACK_COMMIT, &salt(seed, index), &sorted])
}

/// Keystream hiding which tiles were thrown back in an exchange.
///
/// The count is public — it has to be, the bag changes by it — but which tiles
/// they were says a great deal about what a player is holding, and there is no
/// reason for the opponent to have it before the reveal.
pub fn exchange_mask(seed: &[u8; 32], index: u32, len: usize) -> Vec<u8> {
    let mut out = Vec::with_capacity(len);
    let mut block = 0u32;
    while out.len() < len {
        let bytes = digest(&[MASK, seed, &index.to_le_bytes(), &block.to_le_bytes()]);
        out.extend_from_slice(&bytes[..(len - out.len()).min(32)]);
        block += 1;
    }
    out
}

/// Masks or unmasks discarded tiles; the operation is its own inverse.
pub fn mask_tiles(seed: &[u8; 32], index: u32, tiles: &[u8]) -> Vec<u8> {
    exchange_mask(seed, index, tiles.len())
        .iter()
        .zip(tiles)
        .map(|(k, t)| k ^ t)
        .collect()
}

/// Draws one tile from `pool`, or `None` if it is empty.
///
/// The choice is uniform over the tiles remaining, by a multiply-shift
/// reduction of the first eight bytes of the hash — the bias is under 2⁻⁵⁷,
/// which is a good deal smaller than the chance of the two players disagreeing
/// about anything else.
pub fn draw_one(seed: &[u8; 32], nonce: &Nonce, index: u32, pool: &mut TileCounts) -> Option<Tile> {
    let total: u32 = pool.iter().map(|&c| c as u32).sum();
    if total == 0 {
        return None;
    }

    let key = digest(&[DRAW, seed, nonce, &index.to_le_bytes()]);
    let x = u64::from_le_bytes(key[..8].try_into().expect("eight bytes"));
    let mut pick = ((x as u128 * total as u128) >> 64) as u32;

    for (kind, slot) in pool.iter_mut().enumerate() {
        let count = *slot as u32;
        if pick < count {
            *slot -= 1;
            return Some(kind as Tile);
        }
        pick -= count;
    }

    // Unreachable: `pick` is below the total the loop walks through.
    None
}

/// Draws up to `count` tiles, continuing the stream from `from_index`.
pub fn draw(
    seed: &[u8; 32],
    nonce: &Nonce,
    from_index: u32,
    count: u8,
    pool: &mut TileCounts,
) -> Vec<Tile> {
    let mut drawn = Vec::with_capacity(count as usize);
    for i in 0..count as u32 {
        match draw_one(seed, nonce, from_index + i, pool) {
            Some(tile) => drawn.push(tile),
            None => break,
        }
    }
    drawn
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tiles::{KINDS, distribution};

    const SEED_A: [u8; 32] = [0x11; 32];
    const SEED_B: [u8; 32] = [0x22; 32];
    const NONCE: Nonce = [0x33; 24];

    #[test]
    fn a_draw_is_fixed_by_its_inputs() {
        let mut pool = distribution();
        let first = draw(&SEED_A, &NONCE, 0, 7, &mut pool);

        let mut again = distribution();
        assert_eq!(draw(&SEED_A, &NONCE, 0, 7, &mut again), first);
    }

    #[test]
    fn different_players_draw_differently() {
        let mut a = distribution();
        let mut b = distribution();

        assert_ne!(
            draw(&SEED_A, &NONCE, 0, 7, &mut a),
            draw(&SEED_B, &NONCE, 0, 7, &mut b)
        );
    }

    #[test]
    fn a_different_nonce_deals_a_different_hand() {
        // This is what stops either side steering the other's draw: the
        // opponent supplies the nonce but cannot predict what it produces.
        let mut a = distribution();
        let mut b = distribution();

        assert_ne!(
            draw(&SEED_A, &NONCE, 0, 7, &mut a),
            draw(&SEED_A, &[0x44; 24], 0, 7, &mut b)
        );
    }

    #[test]
    fn drawing_takes_tiles_out_of_the_pool() {
        let mut pool = distribution();
        let drawn = draw(&SEED_A, &NONCE, 0, 7, &mut pool);

        assert_eq!(drawn.len(), 7);
        assert_eq!(pool.iter().map(|&c| c as u32).sum::<u32>(), 102 - 7);
    }

    #[test]
    fn an_empty_pool_yields_nothing_rather_than_looping() {
        let mut pool = [0u8; KINDS];
        assert_eq!(draw_one(&SEED_A, &NONCE, 0, &mut pool), None);
        assert!(draw(&SEED_A, &NONCE, 0, 7, &mut pool).is_empty());
    }

    #[test]
    fn a_short_pool_deals_what_is_left() {
        let mut pool = [0u8; KINDS];
        pool[1] = 2;

        assert_eq!(draw(&SEED_A, &NONCE, 0, 7, &mut pool), vec![1, 1]);
    }

    #[test]
    fn the_whole_bag_can_be_drawn_and_comes_out_as_the_bag() {
        let mut pool = distribution();
        let all = draw(&SEED_A, &NONCE, 0, 255, &mut pool);

        let mut counted = [0u8; KINDS];
        for tile in &all {
            counted[*tile as usize] += 1;
        }

        assert_eq!(all.len(), 102);
        assert_eq!(counted, distribution());
        assert!(pool.iter().all(|&c| c == 0));
    }

    #[test]
    fn draws_are_spread_across_the_alphabet() {
        // Not a uniformity proof, just a guard against a reduction bug that
        // parks everything on one letter.
        let mut seen = [0u32; KINDS];
        for n in 0..200u8 {
            let mut pool = distribution();
            for tile in draw(&SEED_A, &[n; 24], 0, 7, &mut pool) {
                seen[tile as usize] += 1;
            }
        }

        assert!(seen.iter().filter(|&&c| c > 0).count() > 20);
        assert!(seen[1] > 0 && seen[5] > 0);
    }

    #[test]
    fn the_toss_depends_on_both_players_and_neither_alone() {
        let a = first_entropy(&SEED_A);
        let b = first_entropy(&SEED_B);

        // Same inputs, same answer, and always one of the two players.
        assert_eq!(first_player(&a, &b), first_player(&a, &b));
        assert!(first_player(&a, &b) < 2);

        // Neither half decides it alone: change one and the answer can move.
        let flipped: Vec<u8> = (0u8..32)
            .map(|n| first_player(&a, &first_entropy(&[n; 32])))
            .collect();
        assert!(flipped.contains(&0) && flipped.contains(&1));
    }

    #[test]
    fn a_rack_commits_the_same_however_it_is_ordered() {
        let one = rack_commitment(&SEED_A, 0, &[3, 1, 2]);
        let other = rack_commitment(&SEED_A, 0, &[1, 2, 3]);

        assert_eq!(one, other);
        // But not across players, indices, or contents.
        assert_ne!(one, rack_commitment(&SEED_B, 0, &[1, 2, 3]));
        assert_ne!(one, rack_commitment(&SEED_A, 1, &[1, 2, 3]));
        assert_ne!(one, rack_commitment(&SEED_A, 0, &[1, 2, 4]));
    }

    #[test]
    fn masking_hides_discards_and_undoes_itself() {
        let tiles = [1u8, 17, 0, 26];
        let masked = mask_tiles(&SEED_A, 0, &tiles);

        assert_ne!(masked, tiles);
        assert_eq!(mask_tiles(&SEED_A, 0, &masked), tiles);
        // Without the seed it is noise.
        assert_ne!(mask_tiles(&SEED_B, 0, &masked), tiles);
    }

    #[test]
    fn the_keystream_is_long_enough_for_a_whole_rack() {
        assert_eq!(exchange_mask(&SEED_A, 0, 7).len(), 7);
        assert_eq!(exchange_mask(&SEED_A, 0, 40).len(), 40);
    }

    #[test]
    fn every_derived_value_is_domain_separated() {
        // The same seed feeds five different derivations; none may collide.
        let values = [
            seed_commitment(&SEED_A),
            first_entropy(&SEED_A),
            salt(&SEED_A, 0),
            rack_commitment(&SEED_A, 0, &[]),
            {
                let mut pool = distribution();
                let mut out = [0u8; 32];
                out[0] = draw_one(&SEED_A, &NONCE, 0, &mut pool).unwrap();
                out
            },
        ];

        for i in 0..values.len() {
            for j in i + 1..values.len() {
                assert_ne!(values[i], values[j], "{i} and {j} collide");
            }
        }
    }
}
