//! The signed, hash-chained, append-only game log.
//!
//! This module is the *structural* layer: encoding, hashing, signatures, chain
//! linkage, and authorship. It deliberately knows nothing about game rules or
//! payload contents — payloads are opaque ciphertext here. Turn order and move
//! legality are semantic properties that require the per-game key, and live in
//! [`crate::session`].
//!
//! The split matters: a client can verify a log's structure with nothing but
//! the two participants' public keys, which is exactly what it has when
//! restoring a game from an evicted relay.

use core::fmt;

use ed25519_dalek::{Signature, Signer, SigningKey, Verifier, VerifyingKey};
use sha2::{Digest, Sha256};

use crate::{GAME_ID_LEN, HASH_LEN, PUBKEY_LEN, SIG_LEN};

#[cfg(test)]
mod tests;

/// Domain separation tag prefixed to every signed log-entry preimage.
pub const LOG_DOMAIN: &[u8] = b"tabla-log/v1";

/// Fixed-size prefix of a preimage: domain, seq, prevHash, gameId,
/// authorKeyHash, and the payload length.
pub const PREIMAGE_HEADER_LEN: usize = LOG_DOMAIN.len() + 4 + HASH_LEN + GAME_ID_LEN + HASH_LEN + 4;

/// Smallest possible encoded entry: an empty payload plus a signature.
pub const MIN_ENTRY_LEN: usize = PREIMAGE_HEADER_LEN + SIG_LEN;

/// Guards against absurd allocations when decoding untrusted bytes. The relay
/// enforces a much tighter per-entry cap; this is only a sanity bound.
pub const MAX_PAYLOAD_LEN: usize = 1024 * 1024;

/// The all-zero hash used as `prevHash` at sequence 0.
pub const GENESIS_PREV_HASH: [u8; HASH_LEN] = [0u8; HASH_LEN];

/// SHA-256 of a 32-byte Ed25519 public key. This is the only identifier the
/// relay ever sees for a participant.
pub fn key_hash(public_key: &[u8; PUBKEY_LEN]) -> [u8; HASH_LEN] {
    let mut h = Sha256::new();
    h.update(public_key);
    h.finalize().into()
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LogError {
    /// Encoded entry was shorter than the fixed header plus signature.
    Truncated,
    /// The declared payload length does not match the bytes supplied.
    LengthMismatch,
    /// Payload length exceeds [`MAX_PAYLOAD_LEN`].
    PayloadTooLarge,
    /// Preimage did not begin with [`LOG_DOMAIN`].
    BadDomain,
    /// Signature did not verify under the author's key.
    BadSignature,
    /// The author's key hash is not one of the game's participants.
    UnknownAuthor,
    /// Sequence numbers are not contiguous from zero.
    SeqGap { expected: u32, found: u32 },
    /// `prevHash` does not match the previous entry's hash.
    ChainBreak { seq: u32 },
    /// Entry belongs to a different game.
    WrongGame { seq: u32 },
    /// `prevHash` at sequence 0 was not all zero.
    BadGenesis,
    /// The restored log does not contain the tombstoned tip, so accepting it
    /// would roll the game back to an earlier state.
    TombstoneNotFound,
    /// The tombstone refers to a different game than the log.
    TombstoneWrongGame,
}

impl fmt::Display for LogError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Truncated => f.write_str("entry is truncated"),
            Self::LengthMismatch => {
                f.write_str("declared payload length does not match entry size")
            }
            Self::PayloadTooLarge => f.write_str("payload exceeds maximum length"),
            Self::BadDomain => f.write_str("entry has wrong domain tag"),
            Self::BadSignature => f.write_str("entry signature did not verify"),
            Self::UnknownAuthor => f.write_str("entry author is not a participant in this game"),
            Self::SeqGap { expected, found } => {
                write!(f, "sequence gap: expected {expected}, found {found}")
            }
            Self::ChainBreak { seq } => write!(f, "hash chain broken at sequence {seq}"),
            Self::WrongGame { seq } => write!(f, "entry at sequence {seq} belongs to another game"),
            Self::BadGenesis => f.write_str("sequence 0 must have an all-zero prevHash"),
            Self::TombstoneNotFound => {
                f.write_str("log does not contain the tombstoned tip (rollback refused)")
            }
            Self::TombstoneWrongGame => f.write_str("tombstone belongs to another game"),
        }
    }
}

impl core::error::Error for LogError {}

/// The fixed-size, signed part of an entry that positions it in exactly one
/// place in exactly one game's history.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct EntryHeader {
    pub seq: u32,
    pub prev_hash: [u8; HASH_LEN],
    pub game_id: [u8; GAME_ID_LEN],
    pub author_key_hash: [u8; HASH_LEN],
}

/// A single append-only log entry.
///
/// The payload is ciphertext. Nothing in this module can or should decrypt it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Entry {
    pub header: EntryHeader,
    pub payload: Vec<u8>,
    pub sig: [u8; SIG_LEN],
}

/// Builds the canonical byte string that is hashed and signed.
///
/// Fixed field order, little-endian integers, explicit length prefix on the one
/// variable-length field. There is no canonicalization to get wrong and no
/// serialization library in the trusted path.
pub fn encode_preimage(header: &EntryHeader, payload: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(PREIMAGE_HEADER_LEN + payload.len());
    out.extend_from_slice(LOG_DOMAIN);
    out.extend_from_slice(&header.seq.to_le_bytes());
    out.extend_from_slice(&header.prev_hash);
    out.extend_from_slice(&header.game_id);
    out.extend_from_slice(&header.author_key_hash);
    out.extend_from_slice(&(payload.len() as u32).to_le_bytes());
    out.extend_from_slice(payload);
    out
}

/// SHA-256 over the canonical preimage. This is what the next entry chains to.
pub fn hash_preimage(preimage: &[u8]) -> [u8; HASH_LEN] {
    let mut h = Sha256::new();
    h.update(preimage);
    h.finalize().into()
}

impl Entry {
    /// Signs a new entry with the author's identity key.
    ///
    /// The author's key hash is derived from the signing key rather than passed
    /// in, so an entry cannot be created that claims a different author.
    pub fn sign(
        signing_key: &SigningKey,
        seq: u32,
        prev_hash: [u8; HASH_LEN],
        game_id: [u8; GAME_ID_LEN],
        payload: Vec<u8>,
    ) -> Self {
        let header = EntryHeader {
            seq,
            prev_hash,
            game_id,
            author_key_hash: key_hash(&signing_key.verifying_key().to_bytes()),
        };
        let preimage = encode_preimage(&header, &payload);
        let sig = signing_key.sign(&preimage).to_bytes();
        Self {
            header,
            payload,
            sig,
        }
    }

    /// The canonical preimage: everything the signature covers.
    pub fn preimage(&self) -> Vec<u8> {
        encode_preimage(&self.header, &self.payload)
    }

    /// This entry's hash, which the following entry carries as `prevHash`.
    pub fn hash(&self) -> [u8; HASH_LEN] {
        hash_preimage(&self.preimage())
    }

    /// Wire and storage form: canonical preimage followed by the signature.
    ///
    /// A signature cannot cover itself, so "signed over the full entry" means
    /// over the preimage. Since the preimage binds seq, prevHash, and gameId,
    /// an entry still cannot be replayed at another position or in another game.
    pub fn encode(&self) -> Vec<u8> {
        let mut out = self.preimage();
        out.extend_from_slice(&self.sig);
        out
    }

    /// Parses an entry from its wire form. Performs no cryptographic checks.
    pub fn decode(bytes: &[u8]) -> Result<Self, LogError> {
        if bytes.len() < MIN_ENTRY_LEN {
            return Err(LogError::Truncated);
        }
        let mut c = Cursor::new(bytes);

        if c.take(LOG_DOMAIN.len())? != LOG_DOMAIN {
            return Err(LogError::BadDomain);
        }
        let seq = u32::from_le_bytes(c.take_array::<4>()?);
        let prev_hash = c.take_array::<HASH_LEN>()?;
        let game_id = c.take_array::<GAME_ID_LEN>()?;
        let author_key_hash = c.take_array::<HASH_LEN>()?;
        let payload_len = u32::from_le_bytes(c.take_array::<4>()?) as usize;

        if payload_len > MAX_PAYLOAD_LEN {
            return Err(LogError::PayloadTooLarge);
        }
        if bytes.len() != PREIMAGE_HEADER_LEN + payload_len + SIG_LEN {
            return Err(LogError::LengthMismatch);
        }

        let payload = c.take(payload_len)?.to_vec();
        let sig = c.take_array::<SIG_LEN>()?;

        Ok(Self {
            header: EntryHeader {
                seq,
                prev_hash,
                game_id,
                author_key_hash,
            },
            payload,
            sig,
        })
    }

    /// Verifies the signature against a specific public key.
    pub fn verify_signature(&self, author: &VerifyingKey) -> Result<(), LogError> {
        let sig = Signature::from_bytes(&self.sig);
        author
            .verify(&self.preimage(), &sig)
            .map_err(|_| LogError::BadSignature)
    }
}

/// The two identity keys bound to a game, with their hashes precomputed.
///
/// Entries name their author by key hash; verification needs the key itself.
#[derive(Debug, Clone)]
pub struct Participants {
    keys: Vec<VerifyingKey>,
    hashes: Vec<[u8; HASH_LEN]>,
}

impl Participants {
    pub fn new(keys: &[VerifyingKey]) -> Self {
        let hashes = keys.iter().map(|k| key_hash(&k.to_bytes())).collect();
        Self {
            keys: keys.to_vec(),
            hashes,
        }
    }

    /// Resolves an entry's author hash to the key that must have signed it.
    pub fn lookup(&self, hash: &[u8; HASH_LEN]) -> Option<&VerifyingKey> {
        self.hashes
            .iter()
            .position(|h| h == hash)
            .map(|i| &self.keys[i])
    }

    /// Index of a participant, used to decide whose turn a position implies.
    pub fn index_of(&self, hash: &[u8; HASH_LEN]) -> Option<usize> {
        self.hashes.iter().position(|h| h == hash)
    }

    pub fn key_hashes(&self) -> &[[u8; HASH_LEN]] {
        &self.hashes
    }

    pub fn len(&self) -> usize {
        self.keys.len()
    }

    pub fn is_empty(&self) -> bool {
        self.keys.is_empty()
    }
}

/// Where a verified log currently ends.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ChainTip {
    pub seq: u32,
    pub hash: [u8; HASH_LEN],
}

/// Verifies a whole log: contiguity, chaining, authorship, and signatures.
///
/// Returns the tip, or `None` for an empty log. Any error is fatal to the log
/// being checked — a client that gets one keeps its own copy and refuses to
/// advance, because there is no safe way to partially accept a forged history.
pub fn verify_chain(
    entries: &[Entry],
    game_id: &[u8; GAME_ID_LEN],
    participants: &Participants,
) -> Result<Option<ChainTip>, LogError> {
    let mut prev: Option<ChainTip> = None;

    for (i, entry) in entries.iter().enumerate() {
        let expected_seq = i as u32;
        if entry.header.seq != expected_seq {
            return Err(LogError::SeqGap {
                expected: expected_seq,
                found: entry.header.seq,
            });
        }
        if &entry.header.game_id != game_id {
            return Err(LogError::WrongGame {
                seq: entry.header.seq,
            });
        }

        match prev {
            None => {
                if entry.header.prev_hash != GENESIS_PREV_HASH {
                    return Err(LogError::BadGenesis);
                }
            }
            Some(tip) => {
                if entry.header.prev_hash != tip.hash {
                    return Err(LogError::ChainBreak {
                        seq: entry.header.seq,
                    });
                }
            }
        }

        let author = participants
            .lookup(&entry.header.author_key_hash)
            .ok_or(LogError::UnknownAuthor)?;
        entry.verify_signature(author)?;

        prev = Some(ChainTip {
            seq: entry.header.seq,
            hash: entry.hash(),
        });
    }

    Ok(prev)
}

/// Verifies that `suffix` continues a log whose tip is `tip`, without
/// re-verifying the prefix the caller already trusts.
pub fn verify_suffix(
    tip: Option<ChainTip>,
    suffix: &[Entry],
    game_id: &[u8; GAME_ID_LEN],
    participants: &Participants,
) -> Result<Option<ChainTip>, LogError> {
    let mut prev = tip;

    for entry in suffix {
        let expected_seq = prev.map_or(0, |t| t.seq + 1);
        if entry.header.seq != expected_seq {
            return Err(LogError::SeqGap {
                expected: expected_seq,
                found: entry.header.seq,
            });
        }
        if &entry.header.game_id != game_id {
            return Err(LogError::WrongGame {
                seq: entry.header.seq,
            });
        }

        let expected_prev = prev.map_or(GENESIS_PREV_HASH, |t| t.hash);
        if entry.header.prev_hash != expected_prev {
            return if prev.is_none() {
                Err(LogError::BadGenesis)
            } else {
                Err(LogError::ChainBreak {
                    seq: entry.header.seq,
                })
            };
        }

        let author = participants
            .lookup(&entry.header.author_key_hash)
            .ok_or(LogError::UnknownAuthor)?;
        entry.verify_signature(author)?;

        prev = Some(ChainTip {
            seq: entry.header.seq,
            hash: entry.hash(),
        });
    }

    Ok(prev)
}

/// The permanent record left when a game's ciphertext is evicted for inactivity.
///
/// This is what makes eviction safe. Without it, an empty room is
/// indistinguishable from a room whose history was truncated, and a client could
/// be talked into accepting a shorter log than the one that existed — silently
/// erasing the last few moves.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Tombstone {
    pub game_id: [u8; GAME_ID_LEN],
    pub tip_hash: [u8; HASH_LEN],
    pub participant_key_hashes: Vec<[u8; HASH_LEN]>,
    pub timestamp: u64,
}

/// Domain tag for the tombstone encoding.
pub const TOMBSTONE_DOMAIN: &[u8] = b"tabla-tomb/v1";

impl Tombstone {
    pub fn encode(&self) -> Vec<u8> {
        let mut out = Vec::with_capacity(
            TOMBSTONE_DOMAIN.len()
                + GAME_ID_LEN
                + HASH_LEN
                + 1
                + self.participant_key_hashes.len() * HASH_LEN
                + 8,
        );
        out.extend_from_slice(TOMBSTONE_DOMAIN);
        out.extend_from_slice(&self.game_id);
        out.extend_from_slice(&self.tip_hash);
        out.push(self.participant_key_hashes.len() as u8);
        for h in &self.participant_key_hashes {
            out.extend_from_slice(h);
        }
        out.extend_from_slice(&self.timestamp.to_le_bytes());
        out
    }

    pub fn decode(bytes: &[u8]) -> Result<Self, LogError> {
        let mut c = Cursor::new(bytes);
        if c.take(TOMBSTONE_DOMAIN.len())? != TOMBSTONE_DOMAIN {
            return Err(LogError::BadDomain);
        }
        let game_id = c.take_array::<GAME_ID_LEN>()?;
        let tip_hash = c.take_array::<HASH_LEN>()?;
        let count = c.take(1)?[0] as usize;
        let mut participant_key_hashes = Vec::with_capacity(count);
        for _ in 0..count {
            participant_key_hashes.push(c.take_array::<HASH_LEN>()?);
        }
        let timestamp = u64::from_le_bytes(c.take_array::<8>()?);

        if c.remaining() != 0 {
            return Err(LogError::LengthMismatch);
        }
        Ok(Self {
            game_id,
            tip_hash,
            participant_key_hashes,
            timestamp,
        })
    }

    /// Checks that a log offered as a restoration of this game actually extends
    /// the state the tombstone recorded.
    ///
    /// Because entries are hash-chained, finding the tombstoned tip hash
    /// anywhere in the log proves every entry up to that point is byte-identical
    /// to the evicted history, and that the log is at least that long. A log
    /// that does not contain it is either a different history or a rollback, and
    /// is refused either way.
    pub fn check_extends(&self, entries: &[Entry]) -> Result<(), LogError> {
        if let Some(first) = entries.first()
            && first.header.game_id != self.game_id
        {
            return Err(LogError::TombstoneWrongGame);
        }
        if entries.iter().any(|e| e.hash() == self.tip_hash) {
            Ok(())
        } else {
            Err(LogError::TombstoneNotFound)
        }
    }
}

/// Minimal forward-only reader over a byte slice.
struct Cursor<'a> {
    bytes: &'a [u8],
    pos: usize,
}

impl<'a> Cursor<'a> {
    fn new(bytes: &'a [u8]) -> Self {
        Self { bytes, pos: 0 }
    }

    fn take(&mut self, n: usize) -> Result<&'a [u8], LogError> {
        let end = self.pos.checked_add(n).ok_or(LogError::Truncated)?;
        let slice = self.bytes.get(self.pos..end).ok_or(LogError::Truncated)?;
        self.pos = end;
        Ok(slice)
    }

    fn take_array<const N: usize>(&mut self) -> Result<[u8; N], LogError> {
        let slice = self.take(N)?;
        let mut out = [0u8; N];
        out.copy_from_slice(slice);
        Ok(out)
    }

    fn remaining(&self) -> usize {
        self.bytes.len() - self.pos
    }
}
