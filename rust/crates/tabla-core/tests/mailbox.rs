//! The pair mailbox: agreeing on a place to leave an invite, without telling
//! the relay who either of you is.

use tabla_core::CryptoError;
use tabla_core::identity::Identity;
use tabla_core::kex::shared_secret;
use tabla_core::mailbox::{MAILBOX_VERSION, MailboxInvite, mailbox_id, mailbox_key};

fn ada() -> Identity {
    Identity::from_seed(&[0x11; 32])
}

fn pooja() -> Identity {
    Identity::from_seed(&[0x22; 32])
}

fn sam() -> Identity {
    Identity::from_seed(&[0x33; 32])
}

fn invite() -> MailboxInvite {
    MailboxInvite {
        v: MAILBOX_VERSION,
        blob_id: [7u8; 16],
        blob_key: [8u8; 32],
        plugin_id: "letras".into(),
        plugin_version: 2,
        created_at: 1_790_000_000,
    }
}

#[test]
fn both_sides_compute_the_same_mailbox() {
    let (a, b) = (ada(), pooja());

    // Neither of them told the other anything: the address falls out of keys
    // they already had from the game they have already played.
    let from_ada = mailbox_id(&shared_secret(&a, &b.verifying_key()), &b.public_key());
    let from_pooja = mailbox_id(&shared_secret(&b, &a.verifying_key()), &b.public_key());

    assert_eq!(from_ada, from_pooja);
}

#[test]
fn each_direction_has_its_own_mailbox() {
    let (a, b) = (ada(), pooja());
    let pair = shared_secret(&a, &b.verifying_key());

    // So a recipient polls only its own inbox, and never reads back what it
    // wrote itself.
    assert_ne!(
        mailbox_id(&pair, &a.public_key()),
        mailbox_id(&pair, &b.public_key())
    );
}

#[test]
fn a_stranger_cannot_find_the_mailbox() {
    let (a, b, c) = (ada(), pooja(), sam());

    // Sam holds Pooja's public key — everyone who has played her does — but
    // the address needs the secret only Ada and Pooja can compute.
    let theirs = mailbox_id(&shared_secret(&a, &b.verifying_key()), &b.public_key());
    let sams = mailbox_id(&shared_secret(&c, &b.verifying_key()), &b.public_key());

    assert_ne!(theirs, sams);
}

#[test]
fn a_message_round_trips_between_the_pair() {
    let (a, b) = (ada(), pooja());

    let pair = shared_secret(&a, &b.verifying_key());
    let id = mailbox_id(&pair, &b.public_key());
    let key = mailbox_key(&pair, &id);

    let sealed = invite().seal(&key, &[1u8; 24], &id).unwrap();

    // Pooja derives the same key from her side of the same secret.
    let hers = shared_secret(&b, &a.verifying_key());
    let opened = MailboxInvite::open(&mailbox_key(&hers, &id), &id, &sealed).unwrap();

    assert_eq!(opened, invite());
}

#[test]
fn a_message_will_not_open_in_a_different_mailbox() {
    let (a, b) = (ada(), pooja());
    let pair = shared_secret(&a, &b.verifying_key());

    let id = mailbox_id(&pair, &b.public_key());
    let other = mailbox_id(&pair, &a.public_key());
    let sealed = invite()
        .seal(&mailbox_key(&pair, &id), &[1u8; 24], &id)
        .unwrap();

    // The id is the associated data, so moving a message is not a thing a
    // relay can quietly do.
    assert_eq!(
        MailboxInvite::open(&mailbox_key(&pair, &id), &other, &sealed),
        Err(CryptoError::Decrypt)
    );
}

#[test]
fn a_third_party_cannot_read_it() {
    let (a, b, c) = (ada(), pooja(), sam());
    let pair = shared_secret(&a, &b.verifying_key());
    let id = mailbox_id(&pair, &b.public_key());
    let sealed = invite()
        .seal(&mailbox_key(&pair, &id), &[1u8; 24], &id)
        .unwrap();

    // Even handed the id — which is what the relay has — Sam gets nothing.
    let sams = shared_secret(&c, &b.verifying_key());
    assert_eq!(
        MailboxInvite::open(&mailbox_key(&sams, &id), &id, &sealed),
        Err(CryptoError::Decrypt)
    );
}

#[test]
fn a_message_from_a_future_format_is_refused() {
    let (a, b) = (ada(), pooja());
    let pair = shared_secret(&a, &b.verifying_key());
    let id = mailbox_id(&pair, &b.public_key());
    let key = mailbox_key(&pair, &id);

    let ahead = MailboxInvite {
        v: MAILBOX_VERSION + 1,
        ..invite()
    };
    let sealed = ahead.seal(&key, &[1u8; 24], &id).unwrap();

    assert!(matches!(
        MailboxInvite::open(&key, &id, &sealed),
        Err(CryptoError::UnsupportedVersion(_))
    ));
}
