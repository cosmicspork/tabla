//! Inviting someone you have already played, without a link to send.
//!
//! After one finished handshake each side holds the other's identity key, so
//! both can compute the same X25519 secret with no round trip — the same
//! property invites rely on. That secret is enough to agree on a place to leave
//! a message, and on the key that protects it, without either of them telling
//! the relay anything.
//!
//! ```text
//! pair       = X25519(mine, peer)
//! mailboxId  = HKDF(ikm = pair, salt = "tabla-mailbox/v1",     info = "to" || recipient)[0..16]
//! mailboxKey = HKDF(ikm = pair, salt = "tabla-mailbox-msg/v1", info = mailboxId)
//! body       = XChaCha20-Poly1305(mailboxKey, nonce, aad = "tabla-mailbox/v1" || mailboxId, msg)
//! ```
//!
//! **What this buys.** The id is a 128-bit capability nobody can derive without
//! the pair secret, so only the two of them can write to that mailbox or find
//! it — spam is impossible by construction rather than by policy, and the relay
//! never learns a public key or a name. It is per-direction, so a recipient
//! polls only its own inbox and never has to filter its own writes back out.
//!
//! **What it does not buy.** The relay sees an opaque id being written to and
//! polled, and can correlate that with an invite created moments earlier from
//! the same address. That is not new — the game room it leads to shows both
//! participants' key hashes anyway — and it is written down in ARCHITECTURE
//! rather than papered over.
//!
//! **Why the relay verifies nothing.** A signature would have to be checked
//! against a key derived from the same pair secret, which admits exactly the
//! principals the id already admits — buying no access control, while making
//! the relay verify signatures for the first time and store a key per mailbox.
//! Storage is bounded by a cap instead.

use hkdf::Hkdf;
use serde::{Deserialize, Serialize};
use sha2::Sha256;

use crate::error::CryptoError;
use crate::{BLOB_ID_LEN, KEY_LEN, NONCE_LEN, PUBKEY_LEN};

/// Length of a mailbox identifier. Same as a blob id, and for the same reason:
/// 128 bits is not guessable.
pub const MAILBOX_ID_LEN: usize = 16;

/// HKDF salt for the identifier.
pub const MAILBOX_ID_DOMAIN: &[u8] = b"tabla-mailbox/v1";
/// HKDF salt for the message key.
pub const MAILBOX_MSG_DOMAIN: &[u8] = b"tabla-mailbox-msg/v1";
/// Associated data prefix, completed by the mailbox id.
pub const MAILBOX_AAD: &[u8] = b"tabla-mailbox/v1";
/// Current message format version.
pub const MAILBOX_VERSION: u16 = 1;

/// Where messages *to* `recipient` are left, between this pair.
///
/// Per direction: `info` names the recipient, so A→B and B→A are different
/// mailboxes. Both parties compute both, one to write to and one to read.
pub fn mailbox_id(pair: &[u8; KEY_LEN], recipient: &[u8; PUBKEY_LEN]) -> [u8; MAILBOX_ID_LEN] {
    let mut info = Vec::with_capacity(2 + PUBKEY_LEN);
    info.extend_from_slice(b"to");
    info.extend_from_slice(recipient);

    let hk = Hkdf::<Sha256>::new(Some(MAILBOX_ID_DOMAIN), pair);
    let mut okm = [0u8; MAILBOX_ID_LEN];
    hk.expand(&info, &mut okm)
        .expect("16 bytes is a valid HKDF-SHA256 output length");
    okm
}

/// The key protecting messages in one mailbox.
///
/// Bound to the id so that the key for one direction cannot decrypt the other,
/// even though both derive from the same pair secret.
pub fn mailbox_key(pair: &[u8; KEY_LEN], id: &[u8; MAILBOX_ID_LEN]) -> [u8; KEY_LEN] {
    let hk = Hkdf::<Sha256>::new(Some(MAILBOX_MSG_DOMAIN), pair);
    let mut okm = [0u8; KEY_LEN];
    hk.expand(id, &mut okm)
        .expect("32 bytes is a valid HKDF-SHA256 output length");
    okm
}

/// What one player leaves for another: an invite, by reference.
///
/// The invite blob itself stays where every invite goes, on `/api/invite`, so
/// the single-use claim and everything built on it are untouched. This carries
/// the two halves of the link — which is all the link ever was — plus enough
/// to describe the game, so the recipient can decline without claiming it.
/// Claiming is consuming.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct MailboxInvite {
    pub v: u16,
    pub blob_id: [u8; BLOB_ID_LEN],
    pub blob_key: [u8; KEY_LEN],
    pub plugin_id: String,
    pub plugin_version: u32,
    pub created_at: u64,
}

impl MailboxInvite {
    pub fn seal(
        &self,
        key: &[u8; KEY_LEN],
        nonce: &[u8; NONCE_LEN],
        id: &[u8; MAILBOX_ID_LEN],
    ) -> Result<Vec<u8>, CryptoError> {
        let plaintext = postcard::to_allocvec(self).map_err(|_| CryptoError::BadEncoding)?;
        crate::seal::seal(key, nonce, &aad(id), &plaintext)
    }

    pub fn open(
        key: &[u8; KEY_LEN],
        id: &[u8; MAILBOX_ID_LEN],
        sealed: &[u8],
    ) -> Result<Self, CryptoError> {
        let plaintext = crate::seal::open(key, &aad(id), sealed)?;
        let message: Self =
            postcard::from_bytes(&plaintext).map_err(|_| CryptoError::BadEncoding)?;

        if message.v != MAILBOX_VERSION {
            return Err(CryptoError::UnsupportedVersion(message.v));
        }
        Ok(message)
    }
}

/// Binds a message to the mailbox it was left in.
///
/// Without this, a relay could move a message from one mailbox to another and
/// it would still open — pointless but untidy, and cheap to rule out.
fn aad(id: &[u8; MAILBOX_ID_LEN]) -> Vec<u8> {
    let mut out = Vec::with_capacity(MAILBOX_AAD.len() + MAILBOX_ID_LEN);
    out.extend_from_slice(MAILBOX_AAD);
    out.extend_from_slice(id);
    out
}
