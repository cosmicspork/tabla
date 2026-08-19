//! A compact, static word list.
//!
//! A word game has to answer one question — is this a word? — against roughly
//! 170,000 of them, on a phone, from a file the browser has to download. A
//! deterministic acyclic word graph is the classic answer: it collapses every
//! shared prefix *and* every shared suffix, so `zyzzyva` and `aardvark` end in
//! the same `s` edge, and the whole list fits in well under a megabyte with no
//! decompression step and no parsing at load time.
//!
//! Two halves live here, deliberately separated by a feature flag:
//!
//! - The **reader**, which is what ships. It borrows a byte slice and does
//!   integer arithmetic on it. It allocates nothing, links nothing, and is the
//!   only part compiled into the plugin module.
//! - The **builder** (`--features build`), a host-side tool that turns a sorted
//!   word list into that byte slice.
//!
//! # Untrusted input
//!
//! The bytes arrive from the network, and the plugin that reads them is the
//! thing standing between a corrupt file and a wrong answer about whether a
//! word is real. So the reader never panics and never loops forever on
//! malformed input: every index is bounds-checked against the header's own
//! count, and every sibling scan is bounded by the end of the slice rather than
//! trusting a terminator to arrive. A file that fails [`Dawg::parse`] is
//! rejected; one that passes but is internally nonsense yields `false`, never a
//! crash.
//!
//! Whether these are the *right* bytes is a separate question, answered a level
//! up: the game checks their hash against the one pinned in the invite.

#![cfg_attr(not(feature = "build"), no_std)]

#[cfg(feature = "build")]
pub mod build;

/// `TDWG`, so a truncated download fails immediately rather than subtly.
pub const MAGIC: [u8; 4] = *b"TDWG";

/// Bumped if the unit encoding changes. The reader refuses anything else.
pub const FORMAT_VERSION: u16 = 1;

/// Bytes before the first unit.
pub const HEADER_LEN: usize = 24;

/// Letters are `a`..=`z`, packed into five bits.
pub const ALPHABET: u8 = 26;

// Unit layout, little-endian u32:
//
//   bits 0..5    letter, 0 = 'a'
//   bit  5       this letter completes a word
//   bit  6       last edge of this node
//   bits 7..32   index of the child node's first unit; 0 means no children
//
// Unit 0 is never a real edge, which is what lets 0 mean "no children".
const LETTER_MASK: u32 = 0x1f;
const END_OF_WORD: u32 = 1 << 5;
const LAST_SIBLING: u32 = 1 << 6;
const CHILD_SHIFT: u32 = 7;

/// The largest unit index the 25-bit child field can address.
pub const MAX_UNITS: u32 = (1 << (32 - CHILD_SHIFT)) - 1;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DawgError {
    /// Not a word list, or truncated before the header.
    BadMagic,
    /// A word list, but written by a different version of this format.
    BadVersion { found: u16 },
    /// The header describes more units than the file contains.
    Truncated,
    /// The root index points outside the file.
    BadRoot,
}

impl core::fmt::Display for DawgError {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        match self {
            Self::BadMagic => f.write_str("not a tabla word list"),
            Self::BadVersion { found } => write!(f, "word list format version {found} is not v1"),
            Self::Truncated => f.write_str("word list is truncated"),
            Self::BadRoot => f.write_str("word list has an invalid root"),
        }
    }
}

impl core::error::Error for DawgError {}

/// A word list, read in place from bytes someone else owns.
#[derive(Debug, Clone, Copy)]
pub struct Dawg<'a> {
    units: &'a [u8],
    unit_count: u32,
    root: u32,
    word_count: u32,
}

impl<'a> Dawg<'a> {
    /// Validates the header and borrows the rest. Does not read the graph.
    pub fn parse(bytes: &'a [u8]) -> Result<Self, DawgError> {
        if bytes.len() < HEADER_LEN || bytes[0..4] != MAGIC {
            return Err(DawgError::BadMagic);
        }

        let version = u16::from_le_bytes([bytes[4], bytes[5]]);
        if version != FORMAT_VERSION {
            return Err(DawgError::BadVersion { found: version });
        }

        let unit_count = read_u32(bytes, 8);
        let root = read_u32(bytes, 12);
        let word_count = read_u32(bytes, 16);

        let units = bytes
            .get(HEADER_LEN..)
            .ok_or(DawgError::Truncated)?
            .get(
                ..(unit_count as usize)
                    .checked_mul(4)
                    .ok_or(DawgError::Truncated)?,
            )
            .ok_or(DawgError::Truncated)?;

        // The root is a node, so it may legitimately be 0 only if the list is
        // empty — an empty node has no units and nothing to point at.
        if root >= unit_count && !(root == 0 && unit_count == 0) {
            return Err(DawgError::BadRoot);
        }

        Ok(Self {
            units,
            unit_count,
            root,
            word_count,
        })
    }

    /// How many words were compiled in. Informational; not used for lookup.
    pub fn word_count(&self) -> u32 {
        self.word_count
    }

    /// Whether `word` is in the list.
    ///
    /// `word` must be lowercase ASCII letters; anything else is not a word in
    /// this list and returns `false` rather than being coerced, because a game
    /// that quietly accepted `Ok!` would be a game whose two clients disagree
    /// about what they accepted.
    pub fn contains(&self, word: &[u8]) -> bool {
        if word.is_empty() || self.unit_count == 0 {
            return false;
        }

        let mut node = self.root;

        for (i, &byte) in word.iter().enumerate() {
            let Some(letter) = letter_index(byte) else {
                return false;
            };
            let Some(unit) = self.find_edge(node, letter) else {
                return false;
            };

            if i + 1 == word.len() {
                return unit & END_OF_WORD != 0;
            }

            node = unit >> CHILD_SHIFT;
            if node == 0 {
                return false;
            }
        }

        false
    }

    /// Scans one node's sibling run for an edge labelled `letter`.
    ///
    /// Edges are written in alphabetical order, so the scan stops early once it
    /// passes the letter it wants — and it stops unconditionally at the
    /// last-sibling flag or the end of the slice, so a file whose flags have
    /// been corrupted cannot make this run away.
    fn find_edge(&self, node: u32, letter: u8) -> Option<u32> {
        let mut index = node;

        while index < self.unit_count {
            let unit = self.unit(index);
            let found = (unit & LETTER_MASK) as u8;

            if found == letter {
                return Some(unit);
            }
            if found > letter || unit & LAST_SIBLING != 0 {
                return None;
            }
            index += 1;
        }

        None
    }

    fn unit(&self, index: u32) -> u32 {
        let at = index as usize * 4;
        u32::from_le_bytes([
            self.units[at],
            self.units[at + 1],
            self.units[at + 2],
            self.units[at + 3],
        ])
    }
}

fn read_u32(bytes: &[u8], at: usize) -> u32 {
    u32::from_le_bytes([bytes[at], bytes[at + 1], bytes[at + 2], bytes[at + 3]])
}

/// `b'a'` becomes 0; anything outside `a`..=`z` is not a letter.
pub fn letter_index(byte: u8) -> Option<u8> {
    byte.is_ascii_lowercase().then(|| byte - b'a')
}

/// Packs one edge into its wire form.
///
/// Public so the builder and the tests describe units the same way the reader
/// interprets them, rather than each having its own copy of the layout.
pub fn pack_unit(letter: u8, end_of_word: bool, last_sibling: bool, child: u32) -> u32 {
    (letter as u32 & LETTER_MASK)
        | if end_of_word { END_OF_WORD } else { 0 }
        | if last_sibling { LAST_SIBLING } else { 0 }
        | (child << CHILD_SHIFT)
}

#[cfg(test)]
mod tests;
