//! Playing the same games from more than one device.
//!
//! Every device of one person holds the same identity seed. That is not a
//! shortcut: the game key, the draw seed, and the deal's per-game secret are
//! all derived from it, so a device without the seed could not open a single
//! game it was told about. Delegating a per-device signing key would therefore
//! buy nothing an opponent could enforce — a device that has been removed still
//! holds the seed, and could sign a fresh delegation for itself — while costing
//! a log format change and telling the relay which key hashes belong together.
//! So devices are invisible outside this crate: to an opponent and to the relay
//! there is one player, exactly as before.
//!
//! What devices need instead is a way to tell *each other* things — that a game
//! was started, that a contact got a name, that a device was removed. Each has
//! its own mailbox, addressed by a capability only someone holding the seed can
//! compute:
//!
//! ```text
//! mailboxId  = HKDF(ikm = seed, salt = "tabla-device-mailbox/v1",     info = deviceId)[0..16]
//! mailboxKey = HKDF(ikm = seed, salt = "tabla-device-mailbox-msg/v1", info = mailboxId)
//! body       = XChaCha20-Poly1305(mailboxKey, nonce, aad = "tabla-device/v1" || mailboxId, notice)
//! ```
//!
//! One mailbox **per device** rather than one per person, because a shared box
//! would have every device reading its own writes and racing the others to
//! consume them — the same race [`crate::mailbox`] avoids by being
//! per-direction. A sender posts a copy to each of the others.
//!
//! **What the relay learns.** That an opaque id exists, is written to, and is
//! polled — one more of exactly what a pair mailbox already looks like, and no
//! way to tell a person's second device from a second contact.
//!
//! **Removal is cooperative.** A removed device is *told* it was removed and
//! stops; nothing here can take the seed back off it. That is the honest
//! position, and the app says so where it offers the button.

use hkdf::Hkdf;
use serde::{Deserialize, Serialize};
use sha2::Sha256;

use crate::error::CryptoError;
use crate::export::{Contact, GameExport};
use crate::mailbox::MAILBOX_ID_LEN;
use crate::{GAME_ID_LEN, KEY_LEN, NONCE_LEN, SEED_LEN};

/// Length of a device identifier. Random, local, and never seen by anyone but
/// this person's own devices.
pub const DEVICE_ID_LEN: usize = 16;

/// HKDF salt for a device mailbox identifier.
pub const DEVICE_MAILBOX_ID_DOMAIN: &[u8] = b"tabla-device-mailbox/v1";
/// HKDF salt for a device mailbox message key.
pub const DEVICE_MAILBOX_MSG_DOMAIN: &[u8] = b"tabla-device-mailbox-msg/v1";
/// Associated data prefix, completed by the mailbox id.
pub const DEVICE_AAD: &[u8] = b"tabla-device/v1";
/// Current notice format version.
pub const DEVICE_NOTICE_VERSION: u16 = 1;

/// Associated data prefix for a hold token, completed by the game id.
pub const HOLD_AAD: &[u8] = b"tabla-hold/v1";
/// Current hold token version.
pub const HOLD_VERSION: u16 = 1;

/// Where notices *for* `device_id` are left.
///
/// Derived from the seed rather than from a pair secret, because both ends are
/// the same person: there is no second party to agree with.
pub fn device_mailbox_id(
    seed: &[u8; SEED_LEN],
    device_id: &[u8; DEVICE_ID_LEN],
) -> [u8; MAILBOX_ID_LEN] {
    let hk = Hkdf::<Sha256>::new(Some(DEVICE_MAILBOX_ID_DOMAIN), seed);
    let mut okm = [0u8; MAILBOX_ID_LEN];
    hk.expand(device_id, &mut okm)
        .expect("16 bytes is a valid HKDF-SHA256 output length");
    okm
}

/// The key protecting notices in one device's mailbox.
pub fn device_mailbox_key(seed: &[u8; SEED_LEN], id: &[u8; MAILBOX_ID_LEN]) -> [u8; KEY_LEN] {
    let hk = Hkdf::<Sha256>::new(Some(DEVICE_MAILBOX_MSG_DOMAIN), seed);
    let mut okm = [0u8; KEY_LEN];
    hk.expand(id, &mut okm)
        .expect("32 bytes is a valid HKDF-SHA256 output length");
    okm
}

/// One device of this person's.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Device {
    pub id: [u8; DEVICE_ID_LEN],
    /// What the person calls it. Chosen by whoever linked it, never inferred
    /// from a user agent, and never sent to anyone else.
    pub name: String,
    pub linked_at: u64,
}

/// What one device tells the others.
///
/// Variant order is the wire format — postcard writes the index and nothing
/// else — so new kinds are appended and existing ones never reordered. A device
/// running an older build rejects an unknown notice rather than misreading a
/// known one, because the version is checked before the body is decoded.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum NoticeBody {
    /// A game this device knows about, in whatever state it is in.
    GameKnown(Box<GameExport>),
    /// A game that no longer exists — an invitation withdrawn, usually.
    GameGone {
        game_id: [u8; GAME_ID_LEN],
    },
    /// Someone we have played, and what we call them.
    ContactKnown(Contact),
    DeviceAdded(Device),
    DeviceRemoved {
        id: [u8; DEVICE_ID_LEN],
    },
    DeviceRenamed {
        id: [u8; DEVICE_ID_LEN],
        name: String,
    },
    /// The display name changed, so every device introduces itself the same.
    NameChanged(String),
}

/// A notice, sealed for exactly one device.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DeviceNotice {
    pub v: u16,
    /// Which device sent it, so the recipient can attribute and answer.
    pub from: [u8; DEVICE_ID_LEN],
    pub sent_at: u64,
    pub body: NoticeBody,
}

impl DeviceNotice {
    pub fn seal(
        &self,
        key: &[u8; KEY_LEN],
        nonce: &[u8; NONCE_LEN],
        id: &[u8; MAILBOX_ID_LEN],
    ) -> Result<Vec<u8>, CryptoError> {
        let plaintext = postcard::to_allocvec(self).map_err(|_| CryptoError::BadEncoding)?;
        crate::seal::seal(key, nonce, &notice_aad(id), &plaintext)
    }

    pub fn open(
        key: &[u8; KEY_LEN],
        id: &[u8; MAILBOX_ID_LEN],
        sealed: &[u8],
    ) -> Result<Self, CryptoError> {
        let plaintext = crate::seal::open(key, &notice_aad(id), sealed)?;

        // Version first, and the body only if it is one we know. Postcard is
        // not self-describing, so a notice from a later build decoded as this
        // shape would not fail cleanly — it would read whatever followed.
        let (version, _) =
            postcard::take_from_bytes::<u16>(&plaintext).map_err(|_| CryptoError::BadEncoding)?;
        if version != DEVICE_NOTICE_VERSION {
            return Err(CryptoError::UnsupportedVersion(version));
        }

        postcard::from_bytes(&plaintext).map_err(|_| CryptoError::BadEncoding)
    }
}

/// Binds a notice to the mailbox it was left in.
fn notice_aad(id: &[u8; MAILBOX_ID_LEN]) -> Vec<u8> {
    let mut out = Vec::with_capacity(DEVICE_AAD.len() + MAILBOX_ID_LEN);
    out.extend_from_slice(DEVICE_AAD);
    out.extend_from_slice(id);
    out
}

/// A claim on the next move, passed between this person's own devices.
///
/// It never enters the log. Two of your devices answering the same turn is not
/// something an opponent needs protecting from — the relay refuses the second
/// continuation either way — it is something *you* need telling about, before
/// you have built a word twice. So the token is relay state with an expiry,
/// sealed under the game key: the relay routes it and cannot read it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct HoldToken {
    pub v: u16,
    pub device_id: [u8; DEVICE_ID_LEN],
}

/// Binds a hold to the game it was taken in.
pub(crate) fn hold_aad(game_id: &[u8; GAME_ID_LEN]) -> Vec<u8> {
    let mut out = Vec::with_capacity(HOLD_AAD.len() + GAME_ID_LEN);
    out.extend_from_slice(HOLD_AAD);
    out.extend_from_slice(game_id);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    const SEED: [u8; SEED_LEN] = [9u8; SEED_LEN];
    const PHONE: [u8; DEVICE_ID_LEN] = [1u8; DEVICE_ID_LEN];
    const LAPTOP: [u8; DEVICE_ID_LEN] = [2u8; DEVICE_ID_LEN];

    fn notice(from: [u8; DEVICE_ID_LEN]) -> DeviceNotice {
        DeviceNotice {
            v: DEVICE_NOTICE_VERSION,
            from,
            sent_at: 1_780_000_000,
            body: NoticeBody::NameChanged("Josh".into()),
        }
    }

    #[test]
    fn every_device_gets_its_own_mailbox() {
        assert_ne!(
            device_mailbox_id(&SEED, &PHONE),
            device_mailbox_id(&SEED, &LAPTOP)
        );
    }

    #[test]
    fn a_different_identity_addresses_a_different_mailbox() {
        // The id is a capability: without the seed there is nothing to derive
        // it from, so nobody can find — let alone write to — someone else's.
        assert_ne!(
            device_mailbox_id(&SEED, &PHONE),
            device_mailbox_id(&[8u8; SEED_LEN], &PHONE)
        );
    }

    #[test]
    fn a_notice_travels_to_the_device_it_was_addressed_to() {
        let id = device_mailbox_id(&SEED, &LAPTOP);
        let key = device_mailbox_key(&SEED, &id);

        let sealed = notice(PHONE).seal(&key, &[4u8; NONCE_LEN], &id).unwrap();
        let opened = DeviceNotice::open(&key, &id, &sealed).unwrap();

        assert_eq!(opened, notice(PHONE));
    }

    #[test]
    fn a_notice_moved_to_another_mailbox_does_not_open() {
        let laptop = device_mailbox_id(&SEED, &LAPTOP);
        let phone = device_mailbox_id(&SEED, &PHONE);
        let sealed = notice(PHONE)
            .seal(
                &device_mailbox_key(&SEED, &laptop),
                &[4u8; NONCE_LEN],
                &laptop,
            )
            .unwrap();

        // Same person, same seed, wrong box: the id is in the associated data.
        assert!(matches!(
            DeviceNotice::open(&device_mailbox_key(&SEED, &phone), &phone, &sealed),
            Err(CryptoError::Decrypt)
        ));
    }

    #[test]
    fn a_notice_from_a_version_that_does_not_exist_yet_is_refused() {
        let id = device_mailbox_id(&SEED, &LAPTOP);
        let key = device_mailbox_key(&SEED, &id);

        let mut ahead = notice(PHONE);
        ahead.v = 99;
        let sealed = ahead.seal(&key, &[4u8; NONCE_LEN], &id).unwrap();

        assert!(matches!(
            DeviceNotice::open(&key, &id, &sealed),
            Err(CryptoError::UnsupportedVersion(99))
        ));
    }
}
