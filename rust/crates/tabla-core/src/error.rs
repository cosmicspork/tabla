use core::fmt;

use crate::log::LogError;

/// Failures from the cryptographic and encoding layers.
///
/// Deliberately coarse: a caller must not be able to distinguish "wrong key"
/// from "corrupt ciphertext" from "bad padding", because that distinction is
/// exactly what padding-oracle style attacks feed on. Decryption failures all
/// surface as [`CryptoError::Decrypt`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CryptoError {
    /// Authenticated decryption failed: wrong key, wrong AAD, or tampering.
    Decrypt,
    /// Input was too short to contain the fields it must contain.
    Truncated,
    /// A fixed header or magic string did not match.
    BadFormat,
    /// Version field named a format this build does not implement.
    UnsupportedVersion(u16),
    /// A public key was not a valid curve point.
    BadPublicKey,
    /// A signature did not verify.
    BadSignature,
    /// Structured payload could not be decoded after decryption.
    BadEncoding,
    /// Key derivation parameters were out of range.
    BadKdfParams,
    /// A log-level failure surfaced through a crypto entry point.
    Log(LogError),
}

impl fmt::Display for CryptoError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Decrypt => f.write_str("decryption failed"),
            Self::Truncated => f.write_str("input is truncated"),
            Self::BadFormat => f.write_str("input has an unrecognized format"),
            Self::UnsupportedVersion(v) => write!(f, "unsupported format version {v}"),
            Self::BadPublicKey => f.write_str("invalid public key"),
            Self::BadSignature => f.write_str("signature did not verify"),
            Self::BadEncoding => f.write_str("could not decode payload"),
            Self::BadKdfParams => f.write_str("invalid key derivation parameters"),
            Self::Log(e) => write!(f, "{e}"),
        }
    }
}

impl core::error::Error for CryptoError {}

impl From<LogError> for CryptoError {
    fn from(e: LogError) -> Self {
        Self::Log(e)
    }
}
