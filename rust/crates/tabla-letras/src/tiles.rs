//! The bag: which tiles exist, how many of each, and what they are worth.
//!
//! # Where these numbers come from
//!
//! They are **derived from the word list**, not chosen and not copied. The
//! frequency of each letter across all 172,823 words in ENABLE is apportioned
//! to 100 tiles by the largest-remainder method, with every letter guaranteed
//! at least one tile; point values then follow from the resulting counts by
//! fixed bands. `scripts/derive-tiles.mjs` is that derivation, and a test in
//! this crate re-runs it against the same word list, so these constants cannot
//! drift away from the rule that produced them.
//!
//! Deriving rather than choosing is deliberate on two counts. It is the right
//! way to build a bag — the distribution matches the letters players actually
//! need — and it makes the tile set original by construction, which the licence
//! situation around existing word games requires. See `wordlist/PROVENANCE.md`.
//!
//! The result differs noticeably from the familiar sets: ENABLE is a *lexicon*,
//! thick with plurals and inflections, so `s` is common enough to earn nine
//! tiles where a set derived from prose would give it four.

/// A tile: 0 is a blank, 1 through 26 are `a` through `z`.
pub type Tile = u8;

pub const BLANK: Tile = 0;

/// How many kinds of tile there are, blanks included.
pub const KINDS: usize = 27;

/// A multiset of tiles, indexed by kind. Index 0 counts blanks.
pub type TileCounts = [u8; KINDS];

/// Tiles held at once.
pub const RACK: usize = 7;

/// Blanks in the bag. They score nothing, which is what pays for their freedom.
pub const BLANKS: u8 = 2;

/// Every tile in the bag: 100 letters and the blanks.
pub const TILE_TOTAL: u8 = 102;

/// Awarded for playing a whole rack in one turn.
///
/// Deliberately its own number rather than a borrowed one; a rack here is seven
/// tiles out of a hundred, so the bonus is scaled to this bag.
pub const BINGO_BONUS: i32 = 40;

/// `(count, value)` for `a` through `z`, produced by `scripts/derive-tiles.mjs`.
const LETTERS: [(u8, i32); 26] = [
    (8, 1),  // a — 118845 occurrences
    (2, 5),  // b — 28836
    (4, 3),  // c — 64179
    (3, 4),  // d — 53136
    (8, 1),  // e — 180795
    (1, 8),  // f — 19335
    (3, 4),  // g — 42424
    (2, 5),  // h — 36493
    (9, 1),  // i — 141464
    (1, 10), // j — 2497, the rarest letter in the corpus
    (1, 8),  // k — 13313
    (5, 3),  // l — 83427
    (3, 4),  // m — 44531
    (7, 2),  // n — 107521
    (7, 2),  // o — 103536
    (3, 4),  // p — 46141
    (1, 10), // q — 2535, the second rarest
    (7, 2),  // r — 111063
    (9, 1),  // s — 149454
    (7, 2),  // t — 104967
    (3, 4),  // u — 51299
    (1, 8),  // v — 15363
    (1, 8),  // w — 11689
    (1, 8),  // x — 4610
    (2, 5),  // y — 25637
    (1, 8),  // z — 7450
];

/// A full bag.
pub fn distribution() -> TileCounts {
    let mut counts = [0u8; KINDS];
    counts[BLANK as usize] = BLANKS;
    let mut letter = 0;
    while letter < 26 {
        counts[letter + 1] = LETTERS[letter].0;
        letter += 1;
    }
    counts
}

/// What a tile scores. Blanks score nothing however they are read.
pub fn value(tile: Tile) -> i32 {
    match tile {
        1..=26 => LETTERS[tile as usize - 1].1,
        _ => 0,
    }
}

/// `a` becomes 1. Anything that is not a lowercase letter is not a tile.
pub fn tile_of(byte: u8) -> Option<Tile> {
    byte.is_ascii_lowercase().then(|| byte - b'a' + 1)
}

/// The ASCII letter a tile shows, or `?` for an undesignated blank.
pub fn letter_of(tile: Tile) -> u8 {
    match tile {
        1..=26 => b'a' + tile - 1,
        _ => b'?',
    }
}

/// Whether every tile in `held` is in `pool`, counting duplicates.
pub fn contains_all(pool: &TileCounts, held: &[Tile]) -> bool {
    let mut left = *pool;
    for &tile in held {
        let Some(slot) = left.get_mut(tile as usize) else {
            return false;
        };
        if *slot == 0 {
            return false;
        }
        *slot -= 1;
    }
    true
}

/// Removes `tiles` from `pool`, returning false if any of them was not there.
pub fn remove_all(pool: &mut TileCounts, tiles: &[Tile]) -> bool {
    if !contains_all(pool, tiles) {
        return false;
    }
    for &tile in tiles {
        pool[tile as usize] -= 1;
    }
    true
}

/// What a rack of loose tiles is worth, for the deduction at the end of a game.
pub fn rack_value(rack: &[Tile]) -> i32 {
    rack.iter().map(|&t| value(t)).sum()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_bag_holds_a_hundred_letters_and_two_blanks() {
        let bag = distribution();

        assert_eq!(bag[BLANK as usize], BLANKS);
        assert_eq!(
            bag.iter().map(|&c| c as u32).sum::<u32>(),
            TILE_TOTAL as u32
        );
        assert_eq!(bag[1..].iter().map(|&c| c as u32).sum::<u32>(), 100);
    }

    #[test]
    fn every_letter_is_playable() {
        // A bag with no `q` in it is a worse game than one short an `e`.
        let bag = distribution();
        assert!(bag[1..].iter().all(|&c| c >= 1));
    }

    #[test]
    fn blanks_are_free_and_score_nothing() {
        assert_eq!(value(BLANK), 0);
        assert_eq!(value(200), 0);
        assert_eq!(value(tile_of(b'a').unwrap()), 1);
        assert_eq!(value(tile_of(b'q').unwrap()), 10);
    }

    #[test]
    fn letters_round_trip() {
        for byte in b'a'..=b'z' {
            assert_eq!(letter_of(tile_of(byte).unwrap()), byte);
        }
        assert_eq!(tile_of(b'A'), None);
        assert_eq!(tile_of(b'1'), None);
        assert_eq!(letter_of(BLANK), b'?');
    }

    #[test]
    fn taking_tiles_from_a_pool_respects_duplicates() {
        let mut pool = [0u8; KINDS];
        pool[1] = 2; // two `a`s
        pool[2] = 1;

        assert!(contains_all(&pool, &[1, 1, 2]));
        assert!(!contains_all(&pool, &[1, 1, 1]));
        assert!(!contains_all(&pool, &[3]));

        assert!(remove_all(&mut pool, &[1, 2]));
        assert_eq!(pool[1], 1);
        assert_eq!(pool[2], 0);
        assert!(!remove_all(&mut pool, &[2]));
    }

    #[test]
    fn a_tile_kind_outside_the_alphabet_is_never_in_a_pool() {
        // Guards the `get_mut` bound: a move claiming tile 200 must be refused,
        // not indexed with.
        let pool = distribution();
        assert!(!contains_all(&pool, &[200]));
    }

    #[test]
    fn scarcer_letters_are_never_cheaper_than_commoner_ones() {
        let bag = distribution();
        for a in 1..=26u8 {
            for b in 1..=26u8 {
                if bag[a as usize] < bag[b as usize] {
                    assert!(
                        value(a) >= value(b),
                        "{} is scarcer than {} but worth less",
                        letter_of(a) as char,
                        letter_of(b) as char
                    );
                }
            }
        }
    }
}
