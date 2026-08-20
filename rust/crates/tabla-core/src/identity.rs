//! Long-term installation identity.
//!
//! One Ed25519 keypair per installation, generated on first run and kept in
//! IndexedDB. There are no accounts and no server-side identity: a peer is
//! nothing but a public key you have met before.

use ed25519_dalek::{Signer, SigningKey, VerifyingKey};
use hkdf::Hkdf;
use sha2::Sha256;

use crate::error::CryptoError;
use crate::log::key_hash;
use crate::{GAME_ID_LEN, HASH_LEN, PUBKEY_LEN, SEED_LEN, SIG_LEN};

/// Domain tag separating draw entropy from every other use of the identity key.
pub const DRAW_SEED_DOMAIN: &[u8] = b"tabla/draw-seed/v1";

/// Domain tag for a game's share of the key the deck is encrypted under.
pub const DEAL_SECRET_DOMAIN: &[u8] = b"tabla/deal-share/v1";

/// Length of the key material a deal share is reduced from.
pub const DEAL_SECRET_LEN: usize = 64;

/// An installation's identity keypair.
///
/// The seed is held in memory as raw bytes because the export format has to be
/// able to write it out — a device migration that cannot carry the identity key
/// would leave every exported log unverifiable. See ARCHITECTURE.md for why
/// that outweighs the protection a non-extractable key would give.
#[derive(Clone)]
pub struct Identity {
    signing: SigningKey,
}

impl Identity {
    /// Builds an identity from 32 random bytes supplied by the caller.
    ///
    /// The caller provides the entropy (`crypto.getRandomValues` in the browser,
    /// a fixture in tests) so that nothing in this crate needs an RNG.
    pub fn from_seed(seed: &[u8; SEED_LEN]) -> Self {
        Self {
            signing: SigningKey::from_bytes(seed),
        }
    }

    /// The seed, for export. Handle as key material.
    pub fn seed(&self) -> [u8; SEED_LEN] {
        self.signing.to_bytes()
    }

    pub fn public_key(&self) -> [u8; PUBKEY_LEN] {
        self.signing.verifying_key().to_bytes()
    }

    /// SHA-256 of the public key: the only participant identifier the relay sees.
    pub fn key_hash(&self) -> [u8; HASH_LEN] {
        key_hash(&self.public_key())
    }

    pub fn signing_key(&self) -> &SigningKey {
        &self.signing
    }

    pub fn verifying_key(&self) -> VerifyingKey {
        self.signing.verifying_key()
    }

    pub fn sign(&self, message: &[u8]) -> [u8; SIG_LEN] {
        self.signing.sign(message).to_bytes()
    }

    /// This device's private entropy for one game's hidden draws.
    ///
    /// A game with hidden state — a tile bag — needs a secret that fixes what
    /// this player will draw before they can see anything that might tempt them
    /// to choose. It is **derived rather than stored**: a backup already carries
    /// the identity seed, so a restored device recomputes exactly the same value
    /// and can rebuild a half-played rack from the log alone. There is no second
    /// secret to remember to export.
    ///
    /// This value is published at the end of the game so the opponent can audit
    /// every draw, which is why it is an HKDF extraction rather than the seed
    /// itself: revealing it says nothing about the identity key, and the domain
    /// tag means it can never be mistaken for a key agreed for something else.
    pub fn draw_seed(&self, game_id: &[u8; GAME_ID_LEN]) -> [u8; SEED_LEN] {
        let hk = Hkdf::<Sha256>::new(Some(DRAW_SEED_DOMAIN), &self.seed());
        let mut okm = [0u8; SEED_LEN];
        hk.expand(game_id, &mut okm)
            .expect("32 bytes is a valid HKDF-SHA256 output length");
        okm
    }

    /// This device's half of the key one game's deck is encrypted under.
    ///
    /// Derived for the same reason [`Identity::draw_seed`] is: a restored
    /// backup must be able to read a rack it was dealt before the backup was
    /// taken, and a secret that only existed in IndexedDB could not survive
    /// that. Nothing extra to export, nothing extra to lose.
    ///
    /// Unlike the draw seed, this one is **never published**. Revealing it
    /// would hand the opponent every tile still in the bag. Its public half is
    /// what goes in the log, with a proof of knowledge attached.
    ///
    /// Sixty-four bytes because the caller reduces them into a scalar, and a
    /// wide reduction is what makes that uniform.
    pub fn deal_secret(&self, game_id: &[u8; GAME_ID_LEN]) -> [u8; DEAL_SECRET_LEN] {
        let hk = Hkdf::<Sha256>::new(Some(DEAL_SECRET_DOMAIN), &self.seed());
        let mut okm = [0u8; DEAL_SECRET_LEN];
        hk.expand(game_id, &mut okm)
            .expect("64 bytes is a valid HKDF-SHA256 output length");
        okm
    }
}

impl core::fmt::Debug for Identity {
    /// Renders only the public half, so an identity cannot leak its seed into a
    /// log line or a panic message.
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        let pk = self.public_key();
        f.debug_struct("Identity")
            .field(
                "public_key",
                &format_args!("{:02x}{:02x}{:02x}{:02x}…", pk[0], pk[1], pk[2], pk[3]),
            )
            .finish_non_exhaustive()
    }
}

/// Parses a peer's 32-byte Ed25519 public key.
/// The longest display name anything here will carry.
///
/// Nothing is padded, so a sealed blob's length grows with the name — a very
/// long one would be visible to the relay as a larger blob. Thirty-two
/// characters is more than a name needs and little enough to say nothing.
pub const MAX_NAME_LEN: usize = 32;

/// Trims a display name to something that can be carried.
///
/// Applied where a name enters rather than where it is read, so a name that is
/// too long is shortened once instead of being refused at the far end of a link
/// somebody has already sent.
pub fn clean_name(name: &str) -> String {
    name.trim().chars().take(MAX_NAME_LEN).collect()
}

pub fn parse_public_key(bytes: &[u8; PUBKEY_LEN]) -> Result<VerifyingKey, CryptoError> {
    VerifyingKey::from_bytes(bytes).map_err(|_| CryptoError::BadPublicKey)
}
