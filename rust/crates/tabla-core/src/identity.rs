//! Long-term installation identity.
//!
//! One Ed25519 keypair per installation, generated on first run and kept in
//! IndexedDB. There are no accounts and no server-side identity: a peer is
//! nothing but a public key you have met before.

use ed25519_dalek::{Signer, SigningKey, VerifyingKey};

use crate::error::CryptoError;
use crate::log::key_hash;
use crate::{HASH_LEN, PUBKEY_LEN, SEED_LEN, SIG_LEN};

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
pub fn parse_public_key(bytes: &[u8; PUBKEY_LEN]) -> Result<VerifyingKey, CryptoError> {
    VerifyingKey::from_bytes(bytes).map_err(|_| CryptoError::BadPublicKey)
}
