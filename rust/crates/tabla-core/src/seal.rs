//! Authenticated encryption.
//!
//! XChaCha20-Poly1305 throughout. Its 24-byte nonces are large enough to
//! generate randomly for every message without tracking a counter — which
//! matters here because two devices independently append to the same log while
//! offline, and any scheme requiring them to agree on a counter would eventually
//! reuse one.
//!
//! Nonces are supplied by the caller and prepended to the ciphertext.

use chacha20poly1305::aead::{Aead, KeyInit, Payload};
use chacha20poly1305::{XChaCha20Poly1305, XNonce};

use crate::error::CryptoError;
use crate::{KEY_LEN, NONCE_LEN};

/// Overhead added to a plaintext: the prepended nonce plus the Poly1305 tag.
pub const SEAL_OVERHEAD: usize = NONCE_LEN + 16;

/// Encrypts `plaintext`, returning `nonce || ciphertext || tag`.
///
/// The caller must supply a nonce that has never been used with this key.
pub fn seal(
    key: &[u8; KEY_LEN],
    nonce: &[u8; NONCE_LEN],
    aad: &[u8],
    plaintext: &[u8],
) -> Result<Vec<u8>, CryptoError> {
    let cipher = XChaCha20Poly1305::new_from_slice(key).map_err(|_| CryptoError::BadKdfParams)?;
    let ct = cipher
        .encrypt(
            &XNonce::from(*nonce),
            Payload {
                msg: plaintext,
                aad,
            },
        )
        .map_err(|_| CryptoError::Decrypt)?;

    let mut out = Vec::with_capacity(NONCE_LEN + ct.len());
    out.extend_from_slice(nonce);
    out.extend_from_slice(&ct);
    Ok(out)
}

/// Decrypts output of [`seal`]. Every failure mode returns [`CryptoError::Decrypt`].
pub fn open(key: &[u8; KEY_LEN], aad: &[u8], sealed: &[u8]) -> Result<Vec<u8>, CryptoError> {
    if sealed.len() < SEAL_OVERHEAD {
        return Err(CryptoError::Truncated);
    }
    let (nonce, ct) = sealed.split_at(NONCE_LEN);
    let nonce = XNonce::try_from(nonce).map_err(|_| CryptoError::Truncated)?;

    let cipher = XChaCha20Poly1305::new_from_slice(key).map_err(|_| CryptoError::BadKdfParams)?;
    cipher
        .decrypt(&nonce, Payload { msg: ct, aad })
        .map_err(|_| CryptoError::Decrypt)
}
