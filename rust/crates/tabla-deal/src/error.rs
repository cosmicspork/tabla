use core::fmt;

/// Failures from the deal layer.
///
/// Every variant means the same thing operationally — refuse the entry and do
/// not advance — but they are separated because a client that hits one has a
/// bug or an opponent running modified software, and which is which matters
/// when reading a report.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DealError {
    /// A point or scalar was not a canonical encoding.
    BadEncoding,
    /// Input was too short to contain the fields it must contain.
    Truncated,
    /// A proof did not verify against the statement it accompanies.
    BadProof,
    /// A ciphertext vector was not the length the statement requires.
    WrongLength,
    /// An opened ciphertext did not decode to any tile in the distribution.
    NotATile,
    /// A payload named a deck position outside the deck.
    OutOfRange,
}

impl fmt::Display for DealError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::BadEncoding => f.write_str("not a canonical encoding"),
            Self::Truncated => f.write_str("input is truncated"),
            Self::BadProof => f.write_str("proof did not verify"),
            Self::WrongLength => f.write_str("wrong number of ciphertexts"),
            Self::NotATile => f.write_str("opened value is not a tile"),
            Self::OutOfRange => f.write_str("deck position out of range"),
        }
    }
}

impl core::error::Error for DealError {}
