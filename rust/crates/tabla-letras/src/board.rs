//! The board: where the premium squares are, what a legal placement looks like,
//! and what one is worth.
//!
//! # An original layout
//!
//! The premium arrangement here was designed for this game. It is not any
//! existing game's board, and the differences are structural rather than
//! cosmetic: the triple-word squares sit two squares in from each corner rather
//! than at the corners or edge midpoints, there is no diagonal chain of
//! double-word squares running out from the centre, and the counts differ (8
//! triple-word, 12 double-word, 16 triple-letter, 20 double-letter, against the
//! familiar 8/17/12/24).
//!
//! It is specified as one eighth of the board and mirrored eight ways, which is
//! how it stays symmetric by construction rather than by proofreading. Tests
//! assert the symmetry and the counts.
//!
//! The design constraints, for anyone changing it: nine-times word scores must
//! be hard to reach (here they need an eleven-letter word), the centre should be
//! open enough that the first play has somewhere to go but not so rich that
//! opening is decisive, and about a quarter of the board should be premium.

use serde::{Deserialize, Serialize};

use crate::tiles::{BLANK, RACK, Tile, value};

pub const SIZE: usize = 15;
pub const CELLS: usize = SIZE * SIZE;
pub const CENTRE: usize = 7 * SIZE + 7;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Premium {
    None,
    /// Where the first word must cross. Doubles that word, and nothing after.
    Start,
    DoubleLetter,
    TripleLetter,
    DoubleWord,
    TripleWord,
}

impl Premium {
    /// How much this square multiplies a letter placed on it.
    pub fn letter_multiplier(self) -> i32 {
        match self {
            Self::DoubleLetter => 2,
            Self::TripleLetter => 3,
            _ => 1,
        }
    }

    /// How much this square multiplies a word played across it.
    pub fn word_multiplier(self) -> i32 {
        match self {
            Self::DoubleWord | Self::Start => 2,
            Self::TripleWord => 3,
            _ => 1,
        }
    }
}

/// One eighth of the board: `(row, col, premium)` for `row <= col <= 7`.
///
/// Everything else is a reflection of these.
const OCTANT: [(usize, usize, Premium); 10] = [
    (0, 2, Premium::TripleWord),
    (0, 5, Premium::DoubleLetter),
    (0, 7, Premium::TripleLetter),
    (1, 3, Premium::DoubleWord),
    (2, 6, Premium::TripleLetter),
    (3, 6, Premium::DoubleLetter),
    (4, 4, Premium::DoubleWord),
    (5, 5, Premium::TripleLetter),
    (7, 4, Premium::DoubleLetter),
    (7, 7, Premium::Start),
];

/// The premium square at one cell.
pub fn premium(cell: usize) -> Premium {
    let (row, col) = (cell / SIZE, cell % SIZE);
    let last = SIZE - 1;

    let mut i = 0;
    while i < OCTANT.len() {
        let (r, c, kind) = OCTANT[i];
        // The eight reflections of (r, c): swap the axes, mirror either or both.
        let orbit = [
            (r, c),
            (r, last - c),
            (last - r, c),
            (last - r, last - c),
            (c, r),
            (c, last - r),
            (last - c, r),
            (last - c, last - r),
        ];
        let mut j = 0;
        while j < orbit.len() {
            if orbit[j] == (row, col) {
                return kind;
            }
            j += 1;
        }
        i += 1;
    }
    Premium::None
}

/// A tile that has been played. Its letter is fixed for the rest of the game.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct Placed {
    /// The letter it reads as, 1 through 26.
    pub letter: u8,
    /// Whether it is a blank. Blanks read as a letter but score nothing.
    pub blank: bool,
}

impl Placed {
    pub fn score(&self) -> i32 {
        if self.blank { 0 } else { value(self.letter) }
    }
}

/// A tile going down this turn.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct Placement {
    pub row: u8,
    pub col: u8,
    /// The tile taken from the rack. `0` is a blank.
    pub tile: Tile,
    /// Required for a blank and forbidden otherwise: what it will read as.
    /// Always encoded, even when absent — see the note on `Move`.
    pub blank_as: Option<u8>,
}

impl Placement {
    pub fn cell(&self) -> usize {
        self.row as usize * SIZE + self.col as usize
    }

    /// What this tile will look like once it is down.
    pub fn placed(&self) -> Option<Placed> {
        match (self.tile, self.blank_as) {
            (BLANK, Some(letter @ 1..=26)) => Some(Placed {
                letter,
                blank: true,
            }),
            (letter @ 1..=26, None) => Some(Placed {
                letter,
                blank: false,
            }),
            _ => None,
        }
    }
}

/// Fifteen by fifteen, in reading order.
///
/// A `Vec` rather than an array because it lives inside the serialized game
/// state, and 225 is well past the array sizes serde derives for.
pub type Board = Vec<Option<Placed>>;

pub fn empty_board() -> Board {
    vec![None; CELLS]
}

/// Why a placement was refused.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Illegal {
    /// No tiles, or more than a rack's worth.
    WrongCount,
    /// Off the board.
    OffBoard,
    /// Two tiles on one square, or a square that already has one.
    Occupied,
    /// Not all in one row or one column.
    NotInLine,
    /// A gap the existing tiles do not fill.
    Gap,
    /// Floating free of everything already played.
    Disconnected,
    /// The first word has to cross the centre, and be a word.
    NotThroughCentre,
    /// A blank with no letter, or a letter tile pretending to be one.
    BadBlank,
}

impl Illegal {
    /// A short reason, for the error the player sees.
    pub fn reason(self) -> &'static str {
        match self {
            Self::WrongCount => "play between one and seven tiles",
            Self::OffBoard => "that is off the board",
            Self::Occupied => "that square is taken",
            Self::NotInLine => "tiles must go in one row or one column",
            Self::Gap => "leaves a gap",
            Self::Disconnected => "must touch a tile already played",
            Self::NotThroughCentre => "the first word crosses the centre square",
            Self::BadBlank => "a blank needs a letter",
        }
    }
}

/// A word made this turn: the cells it covers and the letters it spells.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Word {
    pub cells: Vec<usize>,
    pub letters: Vec<u8>,
}

impl Word {
    /// The word as lowercase ASCII, for a dictionary lookup.
    pub fn text(&self) -> Vec<u8> {
        self.letters.iter().map(|&l| b'a' + l - 1).collect()
    }
}

/// Checks a placement against the board without changing anything.
///
/// Deliberately says nothing about whether the words formed are real words.
/// That is the opponent's business, raised as a challenge, and checking it here
/// would quietly turn the game into one where invalid words are impossible
/// rather than punishable.
pub fn validate_placement(
    board: &[Option<Placed>],
    placements: &[Placement],
) -> Result<(), Illegal> {
    if placements.is_empty() || placements.len() > RACK {
        return Err(Illegal::WrongCount);
    }

    let mut cells = Vec::with_capacity(placements.len());
    for placement in placements {
        if placement.row as usize >= SIZE || placement.col as usize >= SIZE {
            return Err(Illegal::OffBoard);
        }
        if placement.placed().is_none() {
            return Err(Illegal::BadBlank);
        }

        let cell = placement.cell();
        if board[cell].is_some() || cells.contains(&cell) {
            return Err(Illegal::Occupied);
        }
        cells.push(cell);
    }

    let rows: Vec<usize> = placements.iter().map(|p| p.row as usize).collect();
    let cols: Vec<usize> = placements.iter().map(|p| p.col as usize).collect();
    let same_row = rows.iter().all(|r| *r == rows[0]);
    let same_col = cols.iter().all(|c| *c == cols[0]);

    if !same_row && !same_col {
        return Err(Illegal::NotInLine);
    }

    // A single tile is in a line either way; which one matters only for the
    // gap check, and a single tile cannot leave one.
    let along_row = same_row && (placements.len() == 1 || !same_col);

    cells.sort_unstable();
    if placements.len() > 1 {
        let step = if along_row { 1 } else { SIZE };
        let mut at = cells[0];
        for &cell in &cells[1..] {
            at += step;
            while at < cell {
                if board[at].is_none() {
                    return Err(Illegal::Gap);
                }
                at += step;
            }
        }
    }

    let first_play = board.iter().all(Option::is_none);
    if first_play {
        if !cells.contains(&CENTRE) {
            return Err(Illegal::NotThroughCentre);
        }
        // One tile on the centre spells nothing.
        if placements.len() < 2 {
            return Err(Illegal::NotThroughCentre);
        }
        return Ok(());
    }

    if !cells.iter().any(|&cell| touches_a_tile(board, cell)) {
        return Err(Illegal::Disconnected);
    }

    Ok(())
}

fn touches_a_tile(board: &[Option<Placed>], cell: usize) -> bool {
    let (row, col) = (cell / SIZE, cell % SIZE);

    (row > 0 && board[cell - SIZE].is_some())
        || (row + 1 < SIZE && board[cell + SIZE].is_some())
        || (col > 0 && board[cell - 1].is_some())
        || (col + 1 < SIZE && board[cell + 1].is_some())
}

/// The board as it will be once these tiles are down.
pub fn with_placements(board: &[Option<Placed>], placements: &[Placement]) -> Board {
    let mut next = board.to_vec();
    for placement in placements {
        if let Some(placed) = placement.placed() {
            next[placement.cell()] = Some(placed);
        }
    }
    next
}

/// Every word this play makes: the one along the line played, plus each cross
/// word a placed tile joins.
///
/// Runs of one letter are not words and are left out, so a play that only
/// extends downwards produces exactly the one word it made.
pub fn words_formed(board: &[Option<Placed>], placements: &[Placement]) -> Vec<Word> {
    let after = with_placements(board, placements);
    let mut cells: Vec<usize> = placements.iter().map(Placement::cell).collect();
    cells.sort_unstable();

    let along_row = cells.len() == 1 || cells[1] - cells[0] < SIZE;
    let (main_step, cross_step) = if along_row { (1, SIZE) } else { (SIZE, 1) };

    let mut words = Vec::new();
    if let Some(word) = run_through(&after, cells[0], main_step) {
        words.push(word);
    }
    for &cell in &cells {
        if let Some(word) = run_through(&after, cell, cross_step) {
            words.push(word);
        }
    }
    words
}

/// The maximal unbroken run of tiles through `cell` in one direction.
fn run_through(board: &[Option<Placed>], cell: usize, step: usize) -> Option<Word> {
    let (row, col) = (cell / SIZE, cell % SIZE);
    let (before, after) = if step == 1 {
        (col, SIZE - 1 - col)
    } else {
        (row, SIZE - 1 - row)
    };

    let mut start = cell;
    for _ in 0..before {
        let next = start - step;
        if board[next].is_none() {
            break;
        }
        start = next;
    }

    let mut end = cell;
    for _ in 0..after {
        let next = end + step;
        if board[next].is_none() {
            break;
        }
        end = next;
    }

    if end == start {
        return None;
    }

    let mut word = Word {
        cells: Vec::new(),
        letters: Vec::new(),
    };
    let mut at = start;
    loop {
        let placed = board[at]?;
        word.cells.push(at);
        word.letters.push(placed.letter);
        if at == end {
            break;
        }
        at += step;
    }
    Some(word)
}

/// What a play scores.
///
/// Premium squares count only for the tiles placed this turn: a square is spent
/// the moment something lands on it, which is why building across an old triple
/// is worth so much less than reaching a new one.
pub fn score_play(board: &[Option<Placed>], placements: &[Placement]) -> i32 {
    let after = with_placements(board, placements);
    let fresh: Vec<usize> = placements.iter().map(Placement::cell).collect();

    let mut total = 0;
    for word in words_formed(board, placements) {
        let mut sum = 0;
        let mut multiplier = 1;

        for &cell in &word.cells {
            let Some(placed) = after[cell] else { continue };
            if fresh.contains(&cell) {
                let square = premium(cell);
                sum += placed.score() * square.letter_multiplier();
                multiplier *= square.word_multiplier();
            } else {
                sum += placed.score();
            }
        }
        total += sum * multiplier;
    }

    if placements.len() == RACK {
        total += crate::tiles::BINGO_BONUS;
    }
    total
}
