//! Key agreement between the two participants in a game.
//!
//! Both sides already hold a long-term Ed25519 identity key, and the invite
//! carries the initiator's public key while the claim carries the claimer's, so
//! an X25519 ECDH over those identity keys gives a shared secret with no extra
//! round trip.
//!
//! **On reusing identity keys for ECDH.** Using one keypair for both signing and
//! key agreement is not the textbook recommendation (see eprint 2021/509); a
//! dedicated ephemeral key exchange would be cleaner in isolation. This protocol
//! deliberately does it anyway: an invite is a single-use bearer link that must
//! work when the recipient opens it three days later on a device that has never
//! spoken to the initiator, and adding a live pre-key round trip would break the
//! asynchrony the whole product is built around. The conversion used here
//! (`to_scalar_bytes` paired with `to_montgomery`) is the standard,
//! library-blessed one, and every derived key is domain-separated by HKDF so
//! material for one purpose can never be mistaken for another.

use ed25519_dalek::VerifyingKey;
use hkdf::Hkdf;
use sha2::{Digest, Sha256};
use x25519_dalek::{PublicKey as XPublicKey, StaticSecret};

use crate::identity::Identity;
use crate::{BLOB_ID_LEN, GAME_ID_LEN, HASH_LEN, KEY_LEN, PUBKEY_LEN};

/// Domain tag for the HKDF salt.
pub const SALT_DOMAIN: &[u8] = b"tabla-salt/v1";
/// Info prefix for per-game message keys.
pub const MSG_INFO_PREFIX: &[u8] = b"tabla/v1/msg/";

/// Raw X25519 shared secret between our identity key and a peer's.
///
/// `to_scalar_bytes` returns exactly the value that is a valid `StaticSecret`
/// for the X25519 public key produced by `to_montgomery`, so both sides compute
/// the same point.
pub fn shared_secret(mine: &Identity, peer: &VerifyingKey) -> [u8; KEY_LEN] {
    let secret = StaticSecret::from(mine.signing_key().to_scalar_bytes());
    let peer_public = XPublicKey::from(peer.to_montgomery().to_bytes());
    secret.diffie_hellman(&peer_public).to_bytes()
}

/// Salt binding the derivation to this specific invite and this specific pair.
///
/// The two public keys are sorted so that both sides compute an identical salt
/// regardless of who initiated the game.
pub fn kex_salt(
    blob_id: &[u8; BLOB_ID_LEN],
    a: &[u8; PUBKEY_LEN],
    b: &[u8; PUBKEY_LEN],
) -> [u8; HASH_LEN] {
    let (lo, hi) = if a <= b { (a, b) } else { (b, a) };

    let mut h = Sha256::new();
    h.update(SALT_DOMAIN);
    h.update(blob_id);
    h.update(lo);
    h.update(hi);
    h.finalize().into()
}

/// Derives the symmetric key that protects one game's log entries.
pub fn derive_game_key(
    ikm: &[u8; KEY_LEN],
    salt: &[u8; HASH_LEN],
    game_id: &[u8; GAME_ID_LEN],
) -> [u8; KEY_LEN] {
    let mut info = Vec::with_capacity(MSG_INFO_PREFIX.len() + GAME_ID_LEN);
    info.extend_from_slice(MSG_INFO_PREFIX);
    info.extend_from_slice(game_id);

    let hk = Hkdf::<Sha256>::new(Some(salt), ikm);
    let mut okm = [0u8; KEY_LEN];
    hk.expand(&info, &mut okm)
        .expect("32 bytes is a valid HKDF-SHA256 output length");
    okm
}

/// The whole agreement in one step: ECDH, salt, then expand.
///
/// Both participants call this with their own identity and the other's public
/// key and arrive at the same key.
pub fn agree_game_key(
    mine: &Identity,
    peer: &VerifyingKey,
    blob_id: &[u8; BLOB_ID_LEN],
    game_id: &[u8; GAME_ID_LEN],
) -> [u8; KEY_LEN] {
    let ikm = shared_secret(mine, peer);
    let salt = kex_salt(blob_id, &mine.public_key(), &peer.to_bytes());
    derive_game_key(&ikm, &salt, game_id)
}
