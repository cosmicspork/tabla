//! Board, placement and scoring.

use crate::board::*;
use crate::tiles::*;

/// Builds a placement from a letter, so tests read as words rather than numbers.
fn at(row: u8, col: u8, letter: u8) -> Placement {
    Placement {
        row,
        col,
        tile: tile_of(letter).expect("test letters are lowercase"),
        blank_as: None,
    }
}

/// A blank playing as `letter`.
fn blank_at(row: u8, col: u8, letter: u8) -> Placement {
    Placement {
        row,
        col,
        tile: BLANK,
        blank_as: Some(tile_of(letter).expect("test letters are lowercase")),
    }
}

/// Lays a word across a row, left to right, as placements.
fn across(row: u8, col: u8, word: &str) -> Vec<Placement> {
    word.bytes()
        .enumerate()
        .map(|(i, b)| at(row, col + i as u8, b))
        .collect()
}

/// Lays a word down a column.
fn down(row: u8, col: u8, word: &str) -> Vec<Placement> {
    word.bytes()
        .enumerate()
        .map(|(i, b)| at(row + i as u8, col, b))
        .collect()
}

/// A board with `word` already played across row 7 from the centre.
fn opened(word: &str) -> Board {
    let placements = across(7, 7, word);
    with_placements(&empty_board(), &placements)
}

fn texts(words: &[Word]) -> Vec<String> {
    words
        .iter()
        .map(|w| String::from_utf8(w.text()).unwrap())
        .collect()
}

// -- the layout --------------------------------------------------------------

#[test]
fn the_board_is_symmetric_eight_ways() {
    // The layout is written as one octant and mirrored, so this checks the
    // mirroring rather than the design: a lopsided board would favour whoever
    // opened towards the rich side.
    let last = SIZE - 1;

    for row in 0..SIZE {
        for col in 0..SIZE {
            let expected = premium(row * SIZE + col);
            for (r, c) in [
                (col, row),
                (last - row, col),
                (row, last - col),
                (last - row, last - col),
                (col, last - row),
                (last - col, row),
                (last - col, last - row),
            ] {
                assert_eq!(
                    premium(r * SIZE + c),
                    expected,
                    "at ({row},{col}) vs ({r},{c})"
                );
            }
        }
    }
}

#[test]
fn the_premium_squares_are_the_ones_the_design_calls_for() {
    let mut counts = [0usize; 6];
    for cell in 0..CELLS {
        counts[match premium(cell) {
            Premium::None => 0,
            Premium::Start => 1,
            Premium::DoubleLetter => 2,
            Premium::TripleLetter => 3,
            Premium::DoubleWord => 4,
            Premium::TripleWord => 5,
        }] += 1;
    }

    assert_eq!(counts[5], 8, "triple word");
    assert_eq!(counts[4], 12, "double word");
    assert_eq!(counts[3], 16, "triple letter");
    assert_eq!(counts[2], 20, "double letter");
    assert_eq!(counts[1], 1, "start");
    assert_eq!(counts.iter().sum::<usize>(), CELLS);

    // A quarter of the board, near enough. Denser and scores run away.
    assert_eq!(CELLS - counts[0], 57);
}

#[test]
fn the_centre_is_the_start_square_and_doubles_the_first_word() {
    assert_eq!(premium(CENTRE), Premium::Start);
    assert_eq!(premium(CENTRE).word_multiplier(), 2);
    assert_eq!(premium(CENTRE).letter_multiplier(), 1);
}

#[test]
fn the_corners_are_plain_and_the_triples_sit_inside_them() {
    // Not a cosmetic detail: corner triple-words are the single most
    // recognisable feature of the board this game is deliberately not.
    assert_eq!(premium(0), Premium::None);
    assert_eq!(premium(SIZE - 1), Premium::None);
    assert_eq!(premium(CELLS - 1), Premium::None);

    assert_eq!(premium(2), Premium::TripleWord);
    assert_eq!(premium(2 * SIZE), Premium::TripleWord);
}

#[test]
fn a_nine_times_word_needs_a_very_long_word() {
    // Two triple-words on one line, and how many tiles it takes to span them.
    // Making this cheap would turn one lucky rack into the whole game.
    let mut shortest = usize::MAX;
    for i in 0..SIZE {
        for line in [
            (0..SIZE).map(|j| i * SIZE + j).collect::<Vec<_>>(),
            (0..SIZE).map(|j| j * SIZE + i).collect::<Vec<_>>(),
        ] {
            let triples: Vec<usize> = (0..SIZE)
                .filter(|&j| premium(line[j]) == Premium::TripleWord)
                .collect();
            for a in 0..triples.len() {
                for b in a + 1..triples.len() {
                    shortest = shortest.min(triples[b] - triples[a] + 1);
                }
            }
        }
    }
    assert_eq!(shortest, 11);
}

// -- the tile set ------------------------------------------------------------

#[test]
fn the_tile_set_is_what_the_word_list_derives() {
    // The distribution is derived from ENABLE's letter frequencies by
    // largest-remainder apportionment; this re-runs that derivation so the
    // constants cannot drift from the rule that produced them. If this fails,
    // either the word list changed or someone hand-edited the table.
    let text = std::fs::read_to_string(
        std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .ancestors()
            .nth(3)
            .unwrap()
            .join("wordlist/enable.txt"),
    )
    .expect("vendored word list");

    let mut raw = [0u64; 26];
    for byte in text.bytes() {
        if let Some(tile) = tile_of(byte) {
            raw[tile as usize - 1] += 1;
        }
    }

    let total: u64 = raw.iter().sum();
    let mut counts = [0u32; 26];
    let mut remainders: Vec<(u8, f64)> = Vec::new();
    for (i, &n) in raw.iter().enumerate() {
        let share = (n as f64 / total as f64) * 100.0;
        counts[i] = share.floor() as u32;
        remainders.push((i as u8, share - share.floor()));
    }

    // Largest remainder first, alphabetical on a tie, so nothing depends on
    // iteration order.
    remainders.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap().then(a.0.cmp(&b.0)));
    let mut assigned: u32 = counts.iter().sum();
    let mut i = 0;
    while assigned < 100 {
        counts[remainders[i % 26].0 as usize] += 1;
        assigned += 1;
        i += 1;
    }

    // Every letter gets at least one tile, paid for by the commonest.
    for i in 0..26 {
        if counts[i] == 0 {
            counts[i] = 1;
            let richest = (0..26)
                .max_by_key(|&j| (counts[j], std::cmp::Reverse(j)))
                .unwrap();
            counts[richest] -= 1;
        }
    }

    let bag = distribution();
    for i in 0..26 {
        assert_eq!(
            bag[i + 1] as u32,
            counts[i],
            "{} should have {} tiles",
            (b'a' + i as u8) as char,
            counts[i]
        );
    }
}

// -- placement ---------------------------------------------------------------

#[test]
fn the_first_word_must_cross_the_centre() {
    let board = empty_board();

    assert_eq!(validate_placement(&board, &across(7, 7, "cat")), Ok(()));
    assert_eq!(validate_placement(&board, &across(7, 5, "cat")), Ok(()));
    assert_eq!(
        validate_placement(&board, &across(0, 0, "cat")),
        Err(Illegal::NotThroughCentre)
    );
    // One tile on the centre is not a word.
    assert_eq!(
        validate_placement(&board, &across(7, 7, "c")),
        Err(Illegal::NotThroughCentre)
    );
}

#[test]
fn later_words_must_touch_what_is_already_there() {
    let board = opened("cat");

    // Hooks onto the `t`.
    assert_eq!(validate_placement(&board, &down(8, 9, "ea")), Ok(()));
    // Floating in space.
    assert_eq!(
        validate_placement(&board, &across(0, 0, "dog")),
        Err(Illegal::Disconnected)
    );
    // Diagonal contact is not contact.
    assert_eq!(
        validate_placement(&board, &across(8, 10, "at")),
        Err(Illegal::Disconnected)
    );
}

#[test]
fn tiles_must_go_in_one_line_with_no_gaps() {
    let board = opened("cat");

    assert_eq!(
        validate_placement(&board, &[at(8, 7, b'o'), at(9, 8, b'x')]),
        Err(Illegal::NotInLine)
    );
    assert_eq!(
        validate_placement(&board, &[at(8, 7, b'o'), at(8, 10, b'x')]),
        Err(Illegal::Gap)
    );
}

#[test]
fn a_gap_the_board_already_fills_is_not_a_gap() {
    // `c a t` sits at 7,7..9. Playing either side of it in the same row is one
    // continuous word, not two fragments.
    let board = opened("cat");

    assert_eq!(
        validate_placement(&board, &[at(7, 6, b's'), at(7, 10, b's')]),
        Ok(())
    );
}

#[test]
fn a_square_can_only_be_played_once() {
    let board = opened("cat");

    assert_eq!(
        validate_placement(&board, &[at(7, 7, b'x')]),
        Err(Illegal::Occupied)
    );
    assert_eq!(
        validate_placement(&board, &[at(8, 7, b'x'), at(8, 7, b'y')]),
        Err(Illegal::Occupied)
    );
}

#[test]
fn tiles_must_land_on_the_board() {
    let board = empty_board();

    assert_eq!(
        validate_placement(&board, &[at(7, 15, b'x'), at(7, 7, b'y')]),
        Err(Illegal::OffBoard)
    );
    assert_eq!(
        validate_placement(&board, &[at(200, 7, b'x')]),
        Err(Illegal::OffBoard)
    );
}

#[test]
fn a_play_is_between_one_and_seven_tiles() {
    let board = opened("cat");

    assert_eq!(validate_placement(&board, &[]), Err(Illegal::WrongCount));
    assert_eq!(
        validate_placement(&board, &across(8, 0, "abcdefgh")),
        Err(Illegal::WrongCount)
    );
}

#[test]
fn a_blank_needs_a_letter_and_a_letter_cannot_claim_to_be_one() {
    let board = empty_board();

    assert_eq!(
        validate_placement(&board, &[blank_at(7, 7, b'c'), at(7, 8, b'a')]),
        Ok(())
    );

    let no_letter = Placement {
        row: 7,
        col: 7,
        tile: BLANK,
        blank_as: None,
    };
    assert_eq!(
        validate_placement(&board, &[no_letter, at(7, 8, b'a')]),
        Err(Illegal::BadBlank)
    );

    let pretending = Placement {
        row: 7,
        col: 7,
        tile: tile_of(b'c').unwrap(),
        blank_as: Some(tile_of(b'x').unwrap()),
    };
    assert_eq!(
        validate_placement(&board, &[pretending, at(7, 8, b'a')]),
        Err(Illegal::BadBlank)
    );
}

// -- the words a play makes --------------------------------------------------

#[test]
fn a_play_makes_the_word_along_its_line() {
    let words = words_formed(&empty_board(), &across(7, 7, "cat"));

    assert_eq!(texts(&words), ["cat"]);
}

#[test]
fn a_play_reads_through_tiles_already_on_the_board() {
    // `cat` across row 7 from the centre. Playing above and below the `a`
    // reads the whole column, existing tile included.
    let board = opened("cat");
    let words = words_formed(&board, &[at(6, 8, b's'), at(8, 8, b'o')]);

    assert_eq!(texts(&words), ["sao"]);
}

#[test]
fn a_play_also_makes_every_cross_word_it_joins() {
    // `cat` across row 7; now `to` across row 8 under the `a` and the `t`.
    // That is the word played, plus a cross word under each tile.
    let board = opened("cat");
    let words = words_formed(&board, &[at(8, 8, b't'), at(8, 9, b'o')]);

    assert_eq!(texts(&words), ["to", "at", "to"]);
}

#[test]
fn extending_a_word_reads_the_whole_thing() {
    let board = opened("cat");
    let words = words_formed(&board, &[at(7, 10, b's')]);

    assert_eq!(texts(&words), ["cats"]);
}

#[test]
fn a_single_tile_making_only_a_cross_word_makes_exactly_one_word() {
    let board = opened("cat");
    // Below the `c`, forming `co` downwards and nothing across.
    let words = words_formed(&board, &[at(8, 7, b'o')]);

    assert_eq!(texts(&words), ["co"]);
}

// -- scoring -----------------------------------------------------------------

#[test]
fn the_first_word_is_doubled_by_the_start_square() {
    // c=3, a=1, t=2 → 6, doubled by the centre.
    assert_eq!(score_play(&empty_board(), &across(7, 7, "cat")), 12);
}

#[test]
fn a_letter_premium_applies_only_to_the_tile_that_lands_on_it() {
    // (7,10) is a double letter. `cat` + `s` there: c3 a1 t2 s(1*2) = 8, and
    // the centre is spent, so no word multiplier.
    let board = opened("cat");
    assert_eq!(premium(7 * SIZE + 10), Premium::DoubleLetter);
    assert_eq!(score_play(&board, &[at(7, 10, b's')]), 8);
}

#[test]
fn a_spent_premium_is_not_spent_twice() {
    // Building through the centre again scores it plain.
    let board = opened("cat");
    let with_cross = score_play(&board, &[at(6, 7, b's'), at(8, 7, b'o')]);

    // s(1) c(3) o(2) = 6, with no multiplier: the centre was used on move one.
    assert_eq!(with_cross, 6);
}

#[test]
fn a_play_scores_every_word_it_makes() {
    // `cat` across row 7, then `to` across row 8 under the `a` and `t`.
    // Three words: `to` along the play, and `at` and `to` downwards.
    // None of (8,8), (8,9) is a premium square, so it is plain arithmetic:
    // t2+o2 = 4, a1+t2 = 3, t2+o2 = 4.
    let board = opened("cat");

    assert_eq!(premium(8 * SIZE + 8), Premium::None);
    assert_eq!(premium(8 * SIZE + 9), Premium::None);
    assert_eq!(score_play(&board, &[at(8, 8, b't'), at(8, 9, b'o')]), 11);
}

#[test]
fn a_blank_scores_nothing_but_still_multiplies_the_word() {
    let with_letter = score_play(&empty_board(), &across(7, 7, "cat"));
    let with_blank = score_play(
        &empty_board(),
        &[blank_at(7, 7, b'c'), at(7, 8, b'a'), at(7, 9, b't')],
    );

    // The `c` is worth 3; doubled by the centre that is 6 of the 12.
    assert_eq!(with_letter, 12);
    assert_eq!(with_blank, 6);
}

#[test]
fn playing_a_whole_rack_earns_the_bonus() {
    let seven = score_play(&empty_board(), &across(7, 4, "cattier"));
    let six = score_play(&empty_board(), &across(7, 5, "cattie"));

    assert!(
        seven > six + BINGO_BONUS - 20,
        "the bonus should be in there"
    );
    assert_eq!(seven, score_play(&empty_board(), &across(7, 4, "cattier")));
    // Six tiles earns nothing extra.
    assert_eq!(six, score_play(&empty_board(), &across(7, 5, "cattie")));
}

#[test]
fn word_multipliers_compound() {
    // (4,4) is a double word and (1,3) is another; a word covering both would
    // be quadrupled. Check the single case here: a word reaching (4,4).
    assert_eq!(premium(4 * SIZE + 4), Premium::DoubleWord);

    let mut board = empty_board();
    // Something to hook onto at (4,5).
    board[4 * SIZE + 5] = Some(Placed {
        letter: tile_of(b'o').unwrap(),
        blank: false,
    });

    let plain = score_play(&board, &[at(3, 5, b'c')]);
    let doubled = score_play(&board, &[at(4, 4, b'c')]);

    assert_eq!(plain, 5); // c3 + o2, no premium at (3,5)
    assert_eq!(doubled, 10); // (3 + 2) * 2
}
