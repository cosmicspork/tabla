//! Encrypted backup and device migration.
//!
//! The export carries every game log **and the identity keypair**. Without the
//! keypair the logs are unverifiable and undecryptable, so an export that
//! omitted it would restore nothing — the private key is not an optional extra
//! here, it is the thing that makes the rest meaningful.
//!
//! Format:
//!
//! ```text
//! "TABLAEXPORT1" | u32 m_cost | u32 t_cost | u8 p_cost | [16] salt |
//!     XChaCha20-Poly1305(nonce || ciphertext)
//! ```
//!
//! The Argon2id parameters are stored in the file so that a future build which
//! raises them can still open an old export.

use serde::{Deserialize, Serialize};

use crate::error::CryptoError;
use crate::identity::Identity;
use crate::{GAME_ID_LEN, KEY_LEN, NONCE_LEN, PUBKEY_LEN, SEED_LEN};

pub const EXPORT_MAGIC: &[u8] = b"TABLAEXPORT1";
pub const EXPORT_SALT_LEN: usize = 16;
pub const EXPORT_AAD: &[u8] = b"tabla-export/v1";

/// Argon2id cost parameters. Defaults follow OWASP's second recommended option
/// (19 MiB, 2 passes), which a phone can do in well under a second.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct KdfParams {
    pub m_cost: u32,
    pub t_cost: u32,
    pub p_cost: u8,
}

impl Default for KdfParams {
    fn default() -> Self {
        Self {
            m_cost: 19 * 1024,
            t_cost: 2,
            p_cost: 1,
        }
    }
}

/// A contact: someone we have completed a handshake with at least once.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Contact {
    pub public_key: [u8; PUBKEY_LEN],
    /// Local nickname. Never sent anywhere.
    pub name: String,
    pub first_seen: u64,
}

/// One game's full history, as stored locally.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct GameExport {
    pub game_id: [u8; GAME_ID_LEN],
    pub plugin_id: String,
    pub plugin_version: u32,
    pub initiator_pub_key: [u8; PUBKEY_LEN],
    pub claimer_pub_key: [u8; PUBKEY_LEN],
    pub blob_id: [u8; 16],
    /// Encoded log entries, in order.
    pub entries: Vec<Vec<u8>>,
}

/// Everything an installation needs to be reconstructed elsewhere.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ExportBundle {
    pub v: u16,
    pub identity_seed: [u8; SEED_LEN],
    pub contacts: Vec<Contact>,
    pub games: Vec<GameExport>,
    pub exported_at: u64,
}

pub const EXPORT_VERSION: u16 = 1;

impl ExportBundle {
    pub fn identity(&self) -> Identity {
        Identity::from_seed(&self.identity_seed)
    }
}

/// Derives the file key from a passphrase.
fn derive_key(
    passphrase: &[u8],
    salt: &[u8; EXPORT_SALT_LEN],
    params: KdfParams,
) -> Result<[u8; KEY_LEN], CryptoError> {
    let argon_params = argon2::Params::new(
        params.m_cost,
        params.t_cost,
        params.p_cost as u32,
        Some(KEY_LEN),
    )
    .map_err(|_| CryptoError::BadKdfParams)?;

    let argon = argon2::Argon2::new(
        argon2::Algorithm::Argon2id,
        argon2::Version::V0x13,
        argon_params,
    );

    let mut key = [0u8; KEY_LEN];
    argon
        .hash_password_into(passphrase, salt, &mut key)
        .map_err(|_| CryptoError::BadKdfParams)?;
    Ok(key)
}

/// Writes an encrypted export file.
///
/// Salt and nonce are supplied by the caller, as everywhere else in this crate.
pub fn export(
    passphrase: &[u8],
    bundle: &ExportBundle,
    salt: &[u8; EXPORT_SALT_LEN],
    nonce: &[u8; NONCE_LEN],
    params: KdfParams,
) -> Result<Vec<u8>, CryptoError> {
    let key = derive_key(passphrase, salt, params)?;
    let plaintext = postcard::to_allocvec(bundle).map_err(|_| CryptoError::BadEncoding)?;
    let sealed = crate::seal::seal(&key, nonce, EXPORT_AAD, &plaintext)?;

    let mut out = Vec::with_capacity(header_len() + sealed.len());
    out.extend_from_slice(EXPORT_MAGIC);
    out.extend_from_slice(&params.m_cost.to_le_bytes());
    out.extend_from_slice(&params.t_cost.to_le_bytes());
    out.push(params.p_cost);
    out.extend_from_slice(salt);
    out.extend_from_slice(&sealed);
    Ok(out)
}

const fn header_len() -> usize {
    EXPORT_MAGIC.len() + 4 + 4 + 1 + EXPORT_SALT_LEN
}

/// Reads an encrypted export file.
pub fn import(passphrase: &[u8], bytes: &[u8]) -> Result<ExportBundle, CryptoError> {
    if bytes.len() < header_len() {
        return Err(CryptoError::Truncated);
    }
    if &bytes[..EXPORT_MAGIC.len()] != EXPORT_MAGIC {
        return Err(CryptoError::BadFormat);
    }

    let mut off = EXPORT_MAGIC.len();
    let m_cost = u32::from_le_bytes(bytes[off..off + 4].try_into().unwrap());
    off += 4;
    let t_cost = u32::from_le_bytes(bytes[off..off + 4].try_into().unwrap());
    off += 4;
    let p_cost = bytes[off];
    off += 1;

    let mut salt = [0u8; EXPORT_SALT_LEN];
    salt.copy_from_slice(&bytes[off..off + EXPORT_SALT_LEN]);
    off += EXPORT_SALT_LEN;

    let key = derive_key(
        passphrase,
        &salt,
        KdfParams {
            m_cost,
            t_cost,
            p_cost,
        },
    )?;
    let plaintext = crate::seal::open(&key, EXPORT_AAD, &bytes[off..])?;

    let bundle: ExportBundle =
        postcard::from_bytes(&plaintext).map_err(|_| CryptoError::BadEncoding)?;
    if bundle.v != EXPORT_VERSION {
        return Err(CryptoError::UnsupportedVersion(bundle.v));
    }
    Ok(bundle)
}
