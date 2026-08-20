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
//!
//! The sealed plaintext is `postcard{ v, identity_seed, contacts, games,
//! exported_at, name, devices }`. A backup is the one thing here expected to be
//! old, so version 1 files — which have no `name` — and version 2 files — which
//! have no devices and carry less of each game — are still opened.
//!
//! The same format carries a device link, which is a backup that travels
//! through the relay under a passphrase both devices already know instead of
//! through a file. That is why version 3 records a game so much more fully than
//! a backup ever needed to: a restored backup could afford to look like a fresh
//! install that happens to know some history, but a device linked beside a
//! phone still in use has to arrive holding the same pending invitations, the
//! same finished games, and the same idea of whose turn it is.

use serde::{Deserialize, Serialize};

use crate::device::Device;
use crate::error::CryptoError;
use crate::identity::Identity;
use crate::{BLOB_ID_LEN, GAME_ID_LEN, HASH_LEN, KEY_LEN, NONCE_LEN, PUBKEY_LEN, SEED_LEN};

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

/// Where an invitation sent through a contact's mailbox is waiting.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct MailboxRef {
    pub id: String,
    pub message_id: String,
}

/// One game's full history and everything the list needs to describe it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct GameExport {
    pub game_id: [u8; GAME_ID_LEN],
    pub plugin_id: String,
    pub plugin_version: u32,
    pub initiator_pub_key: [u8; PUBKEY_LEN],
    /// Absent until someone has claimed the invitation. Version 2 could not say
    /// that, so an export simply left out every game still waiting for a player
    /// — acceptable for a backup, wrong for a link.
    pub claimer_pub_key: Option<[u8; PUBKEY_LEN]>,
    pub blob_id: [u8; BLOB_ID_LEN],
    /// The entropy the invite carried, needed to reconstruct the starting
    /// position. Tic tac toe ignores it, but a game with hidden state cannot be
    /// replayed without it, so it belongs in the backup.
    pub seed: [u8; 32],
    /// Encoded log entries, in order.
    pub entries: Vec<Vec<u8>>,

    // Added in version 3. All of it is local bookkeeping that used to be
    // reconstructed or defaulted on import, which was fine when an import meant
    // a device with nothing else to contradict it.
    /// `pending`, `active`, `finished`, `expired`, or `incompatible`, spelled
    /// as the app spells it. A string rather than a number because the two
    /// sides would otherwise need a mapping table each, and a mapping table is
    /// a thing that drifts.
    pub status: String,
    pub created_at: u64,
    pub last_activity: u64,
    /// Still-unclaimed invitations only: the second half of the link, which the
    /// relay never sees, and the token that withdraws it.
    pub blob_key: Option<[u8; KEY_LEN]>,
    pub cancel_token: Option<String>,
    pub expires_at: Option<u64>,
    pub dictionary: Option<[u8; HASH_LEN]>,
    pub invited_contact: Option<[u8; PUBKEY_LEN]>,
    pub mailbox: Option<MailboxRef>,
    pub opponent_name: Option<String>,
    pub your_turn: Option<bool>,
    pub last_play: Option<String>,
    pub outcome: Option<String>,
}

/// Everything an installation needs to be reconstructed elsewhere.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ExportBundle {
    pub v: u16,
    pub identity_seed: [u8; SEED_LEN],
    pub contacts: Vec<Contact>,
    pub games: Vec<GameExport>,
    pub exported_at: u64,
    /// What this player asks to be called, added in version 2.
    ///
    /// It travels with the identity because it belongs to it: the name is what
    /// the people you play write next to your key, and a device that restored
    /// everything except its own name would go on introducing itself to new
    /// opponents as nobody. Everything else this installation knows about
    /// itself — its theme, whether it wanted notifications — is a preference
    /// belonging to the device rather than to the person, and stays behind.
    pub name: String,
    /// The other devices this person plays from, added in version 3, so a newly
    /// linked one knows who else to tell about a game it starts.
    pub devices: Vec<Device>,
}

/// The game shape versions 1 and 2 wrote, kept exactly as it was.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
struct GameExportV2 {
    game_id: [u8; GAME_ID_LEN],
    plugin_id: String,
    plugin_version: u32,
    initiator_pub_key: [u8; PUBKEY_LEN],
    claimer_pub_key: [u8; PUBKEY_LEN],
    blob_id: [u8; BLOB_ID_LEN],
    seed: [u8; 32],
    entries: Vec<Vec<u8>>,
}

/// Version 2 of the bundle, kept exactly as it was.
///
/// Postcard is not self-describing, so every field added above changes how an
/// earlier export would be read. Backups are the one thing here that is
/// expected to be *old* — the point of one is that it still opens after a lost
/// phone — so the old shapes stay and files are decoded by the version they
/// announce.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
struct ExportBundleV2 {
    v: u16,
    identity_seed: [u8; SEED_LEN],
    contacts: Vec<Contact>,
    games: Vec<GameExportV2>,
    exported_at: u64,
    name: String,
}

/// Version 1 of the bundle: the same again, before names.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
struct ExportBundleV1 {
    v: u16,
    identity_seed: [u8; SEED_LEN],
    contacts: Vec<Contact>,
    games: Vec<GameExportV2>,
    exported_at: u64,
}

impl From<GameExportV2> for GameExport {
    fn from(old: GameExportV2) -> Self {
        Self {
            game_id: old.game_id,
            plugin_id: old.plugin_id,
            plugin_version: old.plugin_version,
            initiator_pub_key: old.initiator_pub_key,
            claimer_pub_key: Some(old.claimer_pub_key),
            blob_id: old.blob_id,
            seed: old.seed,
            entries: old.entries,
            // Only claimed games were ever written, so every one of them was
            // playable when the file was made. Whether it has since finished is
            // in the log, which the app reads on first open.
            status: "active".into(),
            created_at: 0,
            last_activity: 0,
            blob_key: None,
            cancel_token: None,
            expires_at: None,
            dictionary: None,
            invited_contact: None,
            mailbox: None,
            opponent_name: None,
            your_turn: None,
            last_play: None,
            outcome: None,
        }
    }
}

impl From<ExportBundleV2> for ExportBundle {
    fn from(old: ExportBundleV2) -> Self {
        Self {
            v: old.v,
            identity_seed: old.identity_seed,
            contacts: old.contacts,
            games: old.games.into_iter().map(Into::into).collect(),
            exported_at: old.exported_at,
            name: old.name,
            // Written by a build where an identity lived on one device. The
            // device restoring this is about to become the first one recorded.
            devices: Vec::new(),
        }
    }
}

impl From<ExportBundleV1> for ExportBundle {
    fn from(old: ExportBundleV1) -> Self {
        ExportBundleV2 {
            v: old.v,
            identity_seed: old.identity_seed,
            contacts: old.contacts,
            games: old.games,
            exported_at: old.exported_at,
            // Taken before names existed. Empty rather than invented: the
            // device can be told what to call itself, and guessing would be
            // worse than asking.
            name: String::new(),
        }
        .into()
    }
}

pub const EXPORT_VERSION: u16 = 3;

/// The last version that carried no devices, and only claimed games.
const EXPORT_VERSION_ONE_DEVICE: u16 = 2;
/// The last version that carried no name.
const EXPORT_VERSION_UNNAMED: u16 = 1;

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

    // The version is read first and the rest decoded to match, because postcard
    // cannot tell one shape from another by looking: decoding a version 1 file
    // as a version 2 struct does not fail cleanly, it reads whatever follows
    // the last field it recognises.
    let (version, _) =
        postcard::take_from_bytes::<u16>(&plaintext).map_err(|_| CryptoError::BadEncoding)?;

    let bundle: ExportBundle = match version {
        EXPORT_VERSION => postcard::from_bytes(&plaintext).map_err(|_| CryptoError::BadEncoding)?,
        EXPORT_VERSION_ONE_DEVICE => postcard::from_bytes::<ExportBundleV2>(&plaintext)
            .map_err(|_| CryptoError::BadEncoding)?
            .into(),
        EXPORT_VERSION_UNNAMED => postcard::from_bytes::<ExportBundleV1>(&plaintext)
            .map_err(|_| CryptoError::BadEncoding)?
            .into(),
        other => return Err(CryptoError::UnsupportedVersion(other)),
    };

    Ok(bundle)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The exact shapes versions 1 and 2 had, so a file written by one of those
    /// builds can be constructed here without that build being present.
    #[derive(Serialize)]
    struct V1 {
        v: u16,
        identity_seed: [u8; SEED_LEN],
        contacts: Vec<Contact>,
        games: Vec<GameExportV2>,
        exported_at: u64,
    }

    #[derive(Serialize)]
    struct V2 {
        v: u16,
        identity_seed: [u8; SEED_LEN],
        contacts: Vec<Contact>,
        games: Vec<GameExportV2>,
        exported_at: u64,
        name: String,
    }

    fn old_game() -> GameExportV2 {
        GameExportV2 {
            game_id: [1u8; GAME_ID_LEN],
            plugin_id: "letras".into(),
            plugin_version: 3,
            initiator_pub_key: [2u8; PUBKEY_LEN],
            claimer_pub_key: [3u8; PUBKEY_LEN],
            blob_id: [4u8; BLOB_ID_LEN],
            seed: [5u8; 32],
            entries: vec![vec![6u8; 8]],
        }
    }

    fn cheap() -> KdfParams {
        // Argon2id at real cost, several times, is most of a test run.
        KdfParams {
            m_cost: 8,
            t_cost: 1,
            p_cost: 1,
        }
    }

    /// Writes a file the way `export` does, around a plaintext of our choosing.
    fn file_containing(plaintext: &[u8]) -> Vec<u8> {
        let params = cheap();
        let salt = [7u8; EXPORT_SALT_LEN];
        let key = derive_key(b"pw", &salt, params).unwrap();
        let sealed = crate::seal::seal(&key, &[3u8; NONCE_LEN], EXPORT_AAD, plaintext).unwrap();

        let mut out = Vec::new();
        out.extend_from_slice(EXPORT_MAGIC);
        out.extend_from_slice(&params.m_cost.to_le_bytes());
        out.extend_from_slice(&params.t_cost.to_le_bytes());
        out.push(params.p_cost);
        out.extend_from_slice(&salt);
        out.extend_from_slice(&sealed);
        out
    }

    #[test]
    fn a_backup_taken_before_names_still_opens() {
        // The one file in this project that is *expected* to be old: the point
        // of a backup is that it opens after the phone that wrote it is gone.
        // A format change that broke last month's export would break it at
        // exactly the moment somebody needed it.
        let old = V1 {
            v: 1,
            identity_seed: [5u8; SEED_LEN],
            contacts: Vec::new(),
            games: vec![old_game()],
            exported_at: 1_780_000_100,
        };

        let restored = import(
            b"pw",
            &file_containing(&postcard::to_allocvec(&old).unwrap()),
        )
        .unwrap();

        assert_eq!(restored.identity_seed, [5u8; SEED_LEN]);
        // Nobody was called anything then. Empty rather than invented.
        assert_eq!(restored.name, "");
        assert_eq!(restored.devices, Vec::new());

        // The game survives the two format changes it never knew about.
        let game = &restored.games[0];
        assert_eq!(game.claimer_pub_key, Some([3u8; PUBKEY_LEN]));
        assert_eq!(game.entries, vec![vec![6u8; 8]]);
        assert_eq!(game.status, "active");
    }

    #[test]
    fn a_backup_taken_before_devices_still_opens() {
        let old = V2 {
            v: 2,
            identity_seed: [5u8; SEED_LEN],
            contacts: Vec::new(),
            games: vec![old_game()],
            exported_at: 1_780_000_100,
            name: "Josh".into(),
        };

        let restored = import(
            b"pw",
            &file_containing(&postcard::to_allocvec(&old).unwrap()),
        )
        .unwrap();

        assert_eq!(restored.name, "Josh");
        assert_eq!(restored.devices, Vec::new());
        assert_eq!(restored.games[0].status, "active");
    }

    #[test]
    fn a_link_carries_an_invitation_nobody_has_claimed() {
        // The case version 2 could not express, and the reason for version 3: a
        // device linked beside a phone has to arrive holding the invitations
        // that phone is still waiting on, key and cancel token and all.
        let pending = GameExport {
            game_id: [1u8; GAME_ID_LEN],
            plugin_id: "letras".into(),
            plugin_version: 3,
            initiator_pub_key: [2u8; PUBKEY_LEN],
            claimer_pub_key: None,
            blob_id: [4u8; BLOB_ID_LEN],
            seed: [5u8; 32],
            entries: Vec::new(),
            status: "pending".into(),
            created_at: 1_780_000_000,
            last_activity: 1_780_000_000,
            blob_key: Some([7u8; KEY_LEN]),
            cancel_token: Some("tok".into()),
            expires_at: Some(1_780_600_000),
            dictionary: Some([8u8; HASH_LEN]),
            invited_contact: Some([9u8; PUBKEY_LEN]),
            mailbox: Some(MailboxRef {
                id: "mb".into(),
                message_id: "msg".into(),
            }),
            opponent_name: Some("Pooja".into()),
            your_turn: None,
            last_play: None,
            outcome: None,
        };

        let bundle = ExportBundle {
            v: EXPORT_VERSION,
            identity_seed: [5u8; SEED_LEN],
            contacts: Vec::new(),
            games: vec![pending.clone()],
            exported_at: 1_780_000_100,
            name: "Josh".into(),
            devices: vec![crate::device::Device {
                id: [1u8; crate::device::DEVICE_ID_LEN],
                name: "Laptop".into(),
                linked_at: 1_780_000_000,
            }],
        };

        let file = export(
            b"pw",
            &bundle,
            &[7u8; EXPORT_SALT_LEN],
            &[3u8; NONCE_LEN],
            cheap(),
        )
        .unwrap();

        assert_eq!(import(b"pw", &file).unwrap(), bundle);
    }

    #[test]
    fn a_file_from_a_version_that_does_not_exist_yet_is_refused() {
        let ahead = V1 {
            v: 99,
            identity_seed: [5u8; SEED_LEN],
            contacts: Vec::new(),
            games: Vec::new(),
            exported_at: 0,
        };

        assert!(matches!(
            import(
                b"pw",
                &file_containing(&postcard::to_allocvec(&ahead).unwrap())
            ),
            Err(CryptoError::UnsupportedVersion(99))
        ));
    }
}
