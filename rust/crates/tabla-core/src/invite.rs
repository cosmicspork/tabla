//! Invitations: the sealed config blob and the single-use claim.
//!
//! The share link is `https://<host>/j#<blobId>.<key>`. The key sits in the URL
//! fragment, which browsers never transmit, so the relay stores a blob it cannot
//! read and link-preview crawlers that fetch pasted URLs learn nothing. The blob
//! key is 32 random bytes and is derived from nothing — there is no key
//! agreement yet at the point the link is created.

use ed25519_dalek::{Signature, Verifier, VerifyingKey};
use serde::{Deserialize, Serialize};

use crate::error::CryptoError;
use crate::identity::Identity;
use crate::{BLOB_ID_LEN, GAME_ID_LEN, HASH_LEN, KEY_LEN, NONCE_LEN, PUBKEY_LEN, SIG_LEN};

/// Current invite format version.
///
/// Version 2 added the initiator's display name. Version 1 blobs are still
/// opened: an invite lives for seven days, and a link someone is holding when
/// this ships should not stop working because of a field it does not carry.
pub const INVITE_VERSION: u16 = 2;

/// The last version that had no name in it.
const INVITE_VERSION_UNNAMED: u16 = 1;

pub use crate::identity::MAX_NAME_LEN;

/// Associated data for the sealed blob.
pub const INVITE_AAD: &[u8] = b"tabla-invite/v1";

/// What the initiator seals into the invite blob.
///
/// The plugin identifiers are here so a claimer whose build differs can refuse
/// before a single move is made. Two clients validating moves differently is
/// unrecoverable once a game is under way, so the mismatch has to be caught at
/// the start.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct InviteConfig {
    pub v: u16,
    pub game_id: [u8; GAME_ID_LEN],
    pub plugin_id: String,
    pub plugin_version: u32,
    pub dictionary_hash: Option<[u8; HASH_LEN]>,
    pub initiator_pub_key: [u8; PUBKEY_LEN],
    /// Entropy the initiator contributes to game setup.
    pub seed: [u8; 32],
    pub created_at: u64,
    /// What the initiator would like to be called, and nothing more.
    ///
    /// Not an identifier: nobody checks it, two people may pick the same one,
    /// and the recipient can rename them locally the moment they arrive. The
    /// public key is who someone is; this is what to write next to it. It
    /// travels sealed, so the relay never sees it — the whole point of putting
    /// it here rather than in the claim.
    pub name: String,
}

/// Version 1 of the same struct, kept exactly as it was.
///
/// Postcard is not self-describing: a field added to `InviteConfig` changes how
/// every earlier blob would be read. So the old shape stays, frozen, and blobs
/// are decoded by the version they announce.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
struct InviteConfigV1 {
    v: u16,
    game_id: [u8; GAME_ID_LEN],
    plugin_id: String,
    plugin_version: u32,
    dictionary_hash: Option<[u8; HASH_LEN]>,
    initiator_pub_key: [u8; PUBKEY_LEN],
    seed: [u8; 32],
    created_at: u64,
}

impl From<InviteConfigV1> for InviteConfig {
    fn from(old: InviteConfigV1) -> Self {
        Self {
            v: old.v,
            game_id: old.game_id,
            plugin_id: old.plugin_id,
            plugin_version: old.plugin_version,
            dictionary_hash: old.dictionary_hash,
            initiator_pub_key: old.initiator_pub_key,
            seed: old.seed,
            created_at: old.created_at,
            // Whoever made this link was using a build that had no names.
            name: String::new(),
        }
    }
}

impl InviteConfig {
    /// Seals the config under a freshly generated random key.
    pub fn seal(
        &self,
        key: &[u8; KEY_LEN],
        nonce: &[u8; NONCE_LEN],
    ) -> Result<Vec<u8>, CryptoError> {
        let plaintext = postcard::to_allocvec(self).map_err(|_| CryptoError::BadEncoding)?;
        crate::seal::seal(key, nonce, INVITE_AAD, &plaintext)
    }

    /// Opens a blob using the key carried in the link fragment.
    ///
    /// The version is read first and the rest decoded according to it, because
    /// postcard cannot tell one shape from another by looking: decoding a v1
    /// blob as a v2 struct does not fail cleanly, it reads whatever follows the
    /// last field it recognises.
    pub fn open(key: &[u8; KEY_LEN], blob: &[u8]) -> Result<Self, CryptoError> {
        let plaintext = crate::seal::open(key, INVITE_AAD, blob)?;

        let (version, _) =
            postcard::take_from_bytes::<u16>(&plaintext).map_err(|_| CryptoError::BadEncoding)?;

        let config: Self = match version {
            INVITE_VERSION => {
                postcard::from_bytes(&plaintext).map_err(|_| CryptoError::BadEncoding)?
            }
            INVITE_VERSION_UNNAMED => postcard::from_bytes::<InviteConfigV1>(&plaintext)
                .map_err(|_| CryptoError::BadEncoding)?
                .into(),
            other => return Err(CryptoError::UnsupportedVersion(other)),
        };

        Ok(config)
    }

    /// Trims a display name to something an invite will carry.
    pub fn clean_name(name: &str) -> String {
        crate::identity::clean_name(name)
    }

    /// Whether this build can play the game the invite describes.
    ///
    /// Refusing here is the point: a version mismatch discovered mid-game cannot
    /// be repaired, because the two clients would have already written entries
    /// they each consider valid and the other does not.
    pub fn is_compatible(
        &self,
        plugin_id: &str,
        plugin_version: u32,
        dictionary_hash: Option<&[u8; HASH_LEN]>,
    ) -> bool {
        self.plugin_id == plugin_id
            && self.plugin_version == plugin_version
            && self.dictionary_hash.as_ref() == dictionary_hash
    }
}

/// Domain tag for the claim signature.
pub const CLAIM_DOMAIN: &[u8] = b"tabla-claim/v1";

/// The message a claimer signs to prove it holds the identity it presents.
pub fn claim_message(blob_id: &[u8; BLOB_ID_LEN]) -> Vec<u8> {
    let mut msg = Vec::with_capacity(CLAIM_DOMAIN.len() + BLOB_ID_LEN);
    msg.extend_from_slice(CLAIM_DOMAIN);
    msg.extend_from_slice(blob_id);
    msg
}

pub fn sign_claim(identity: &Identity, blob_id: &[u8; BLOB_ID_LEN]) -> [u8; SIG_LEN] {
    identity.sign(&claim_message(blob_id))
}

/// Verifies a claim signature.
///
/// The **initiator** calls this, never the relay. The relay stores the claimer's
/// key and signature without checking either; it is not trusted to authenticate
/// anyone, and a relay that lied here would simply be caught by this function.
pub fn verify_claim(
    claimer_pub_key: &VerifyingKey,
    blob_id: &[u8; BLOB_ID_LEN],
    sig: &[u8; SIG_LEN],
) -> Result<(), CryptoError> {
    claimer_pub_key
        .verify(&claim_message(blob_id), &Signature::from_bytes(sig))
        .map_err(|_| CryptoError::BadSignature)
}
