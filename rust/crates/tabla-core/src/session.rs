//! The semantic layer over a game's log: decrypting entries and checking that
//! each one was written by whoever was entitled to write it.
//!
//! [`crate::log`] proves a log is *structurally* sound — chained, signed, and
//! authored by the two participants. This module proves it is *meaningful*:
//! that the entries decrypt, that the prologue is well-formed, and that moves
//! alternate. Move legality itself belongs to the game plugin, which this layer
//! feeds but does not contain.

use ed25519_dalek::VerifyingKey;
use serde::{Deserialize, Serialize};

use crate::error::CryptoError;
use crate::log::{Entry, Participants};
use crate::{GAME_ID_LEN, KEY_LEN, NONCE_LEN, PUBKEY_LEN};

/// What a decrypted log entry says.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum EntryBody {
    /// Sequence 0, written by the claimer: binds their identity to the game.
    Join { claimer_pub_key: [u8; PUBKEY_LEN] },
    /// The same, with what the claimer would like to be called.
    ///
    /// A separate variant rather than a field on `Join`, because postcard is
    /// not self-describing: adding a field would change how every prologue
    /// already written is read, and those are in games people are still
    /// playing. A new variant leaves them exactly as they were.
    JoinAs {
        claimer_pub_key: [u8; PUBKEY_LEN],
        name: String,
    },
    /// Sequence 1, written by the initiator: the agreed game configuration.
    Setup { config: Vec<u8> },
    /// A move, opaque here and interpreted by the plugin.
    Move(Vec<u8>),
    /// Concedes the game. Legal out of turn, which is why turn order cannot be
    /// checked without decrypting.
    Resign,
}

/// Which participant a log position belongs to.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Role {
    /// Created the invite. Moves first.
    Initiator,
    /// Redeemed the invite link.
    Claimer,
}

impl Role {
    pub fn other(self) -> Self {
        match self {
            Self::Initiator => Self::Claimer,
            Self::Claimer => Self::Initiator,
        }
    }

    /// Player index handed to the game plugin.
    pub fn player_index(self) -> u8 {
        match self {
            Self::Initiator => 0,
            Self::Claimer => 1,
        }
    }
}

/// Everything needed to read and write one game's entries.
#[derive(Clone)]
pub struct Session {
    game_id: [u8; GAME_ID_LEN],
    key: [u8; KEY_LEN],
    participants: Participants,
    /// Index into `participants` of the initiator.
    initiator_index: usize,
}

impl Session {
    /// Binds a derived key to the two participants of a game.
    ///
    /// The initiator is listed first so that role and index never drift apart.
    pub fn new(
        game_id: [u8; GAME_ID_LEN],
        key: [u8; KEY_LEN],
        initiator: VerifyingKey,
        claimer: VerifyingKey,
    ) -> Self {
        Self {
            game_id,
            key,
            participants: Participants::new(&[initiator, claimer]),
            initiator_index: 0,
        }
    }

    pub fn game_id(&self) -> &[u8; GAME_ID_LEN] {
        &self.game_id
    }

    pub fn participants(&self) -> &Participants {
        &self.participants
    }

    /// Associated data binding a payload to its position in this game.
    ///
    /// Defense in depth: the entry signature already covers `gameId` and `seq`,
    /// so a relocated payload would fail signature verification first. This
    /// makes it fail decryption too.
    pub fn aad(&self, seq: u32) -> Vec<u8> {
        let mut aad = Vec::with_capacity(GAME_ID_LEN + 4);
        aad.extend_from_slice(&self.game_id);
        aad.extend_from_slice(&seq.to_le_bytes());
        aad
    }

    /// Encrypts a body for a given position in the log.
    pub fn seal_body(
        &self,
        seq: u32,
        nonce: &[u8; NONCE_LEN],
        body: &EntryBody,
    ) -> Result<Vec<u8>, CryptoError> {
        let plaintext = postcard::to_allocvec(body).map_err(|_| CryptoError::BadEncoding)?;
        crate::seal::seal(&self.key, nonce, &self.aad(seq), &plaintext)
    }

    /// Decrypts the body of an entry at a given position.
    pub fn open_body(&self, seq: u32, payload: &[u8]) -> Result<EntryBody, CryptoError> {
        let plaintext = crate::seal::open(&self.key, &self.aad(seq), payload)?;
        postcard::from_bytes(&plaintext).map_err(|_| CryptoError::BadEncoding)
    }

    /// The role that authored an entry, or `None` if the author is a stranger.
    pub fn role_of(&self, entry: &Entry) -> Option<Role> {
        let idx = self.participants.index_of(&entry.header.author_key_hash)?;
        Some(if idx == self.initiator_index {
            Role::Initiator
        } else {
            Role::Claimer
        })
    }

    /// Which role is entitled to write the entry at `seq`, given the moves so
    /// far.
    ///
    /// The prologue is fixed: the claimer writes `Join` at 0, the initiator
    /// writes `Setup` at 1. From sequence 2 the initiator moves first and the
    /// two alternate.
    pub fn expected_author(seq: u32) -> Role {
        match seq {
            0 => Role::Claimer,
            1 => Role::Initiator,
            n if n % 2 == 0 => Role::Initiator,
            _ => Role::Claimer,
        }
    }
}

/// A log that has been decrypted and checked for turn order.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReplayedLog {
    pub bodies: Vec<EntryBody>,
    /// Moves in order, ready to feed to the plugin.
    pub moves: Vec<Vec<u8>>,
    /// Set once either participant resigns.
    pub resigned_by: Option<Role>,
    /// The configuration from the `Setup` entry, if the log has reached it.
    pub config: Option<Vec<u8>>,
    /// What the claimer asked to be called, if their build sends a name.
    ///
    /// The initiator learns it here rather than from the relay, which never
    /// sees it. Absent for every game begun before names existed, and for a
    /// claimer who has not set one.
    pub claimer_name: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SessionError {
    /// Sequence 0 was not a `Join`, or sequence 1 was not a `Setup`.
    MalformedPrologue { seq: u32 },
    /// An entry was written by the participant whose turn it was not.
    OutOfTurn { seq: u32 },
    /// The `Join` entry named a key other than the one bound to the game.
    JoinKeyMismatch,
    /// A move followed a resignation.
    PlayAfterResign { seq: u32 },
    /// An entry's author is not a participant.
    UnknownAuthor { seq: u32 },
    /// An entry did not decrypt.
    Undecryptable { seq: u32 },
}

impl core::fmt::Display for SessionError {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        match self {
            Self::MalformedPrologue { seq } => write!(f, "malformed prologue at sequence {seq}"),
            Self::OutOfTurn { seq } => write!(f, "entry at sequence {seq} was written out of turn"),
            Self::JoinKeyMismatch => f.write_str("join entry names an unexpected key"),
            Self::PlayAfterResign { seq } => {
                write!(f, "entry at sequence {seq} follows a resignation")
            }
            Self::UnknownAuthor { seq } => {
                write!(f, "entry at sequence {seq} has an unknown author")
            }
            Self::Undecryptable { seq } => write!(f, "entry at sequence {seq} did not decrypt"),
        }
    }
}

impl core::error::Error for SessionError {}

impl Session {
    /// Decrypts a structurally verified log and checks turn discipline.
    ///
    /// Call this only on a log that [`crate::log::verify_chain`] has already
    /// accepted: this function trusts chaining and signatures and checks the
    /// things that need the key.
    pub fn replay(&self, entries: &[Entry]) -> Result<ReplayedLog, SessionError> {
        let mut out = ReplayedLog {
            bodies: Vec::with_capacity(entries.len()),
            moves: Vec::new(),
            resigned_by: None,
            config: None,
            claimer_name: None,
        };

        for entry in entries {
            let seq = entry.header.seq;
            let role = self
                .role_of(entry)
                .ok_or(SessionError::UnknownAuthor { seq })?;
            let body = self
                .open_body(seq, &entry.payload)
                .map_err(|_| SessionError::Undecryptable { seq })?;

            if out.resigned_by.is_some() {
                return Err(SessionError::PlayAfterResign { seq });
            }

            match (&body, seq) {
                (
                    EntryBody::Join { claimer_pub_key }
                    | EntryBody::JoinAs {
                        claimer_pub_key, ..
                    },
                    0,
                ) => {
                    if role != Role::Claimer {
                        return Err(SessionError::OutOfTurn { seq });
                    }
                    let bound = self.participants.key_hashes()[1];
                    if crate::log::key_hash(claimer_pub_key) != bound {
                        return Err(SessionError::JoinKeyMismatch);
                    }
                    if let EntryBody::JoinAs { name, .. } = &body {
                        out.claimer_name = Some(name.clone());
                    }
                }
                (EntryBody::Setup { config }, 1) => {
                    if role != Role::Initiator {
                        return Err(SessionError::OutOfTurn { seq });
                    }
                    out.config = Some(config.clone());
                }
                // A resignation is legal at any point from either player, which
                // is exactly why turn order cannot be decided structurally.
                (EntryBody::Resign, _) if seq >= 2 => {
                    out.resigned_by = Some(role);
                }
                (EntryBody::Move(mv), _) if seq >= 2 => {
                    if role != Self::expected_author(seq) {
                        return Err(SessionError::OutOfTurn { seq });
                    }
                    out.moves.push(mv.clone());
                }
                _ => return Err(SessionError::MalformedPrologue { seq }),
            }

            out.bodies.push(body);
        }

        Ok(out)
    }
}
