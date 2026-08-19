//! Frozen key-derivation and invite-format vectors.
//!
//! A change that alters any of these values makes every existing game
//! undecryptable and every stored invite unopenable. Like `golden_log.rs`,
//! these are regression protection — a failure here is a bug report, not a
//! prompt to regenerate.

use tabla_core::identity::Identity;
use tabla_core::invite::InviteConfig;
use tabla_core::kex::{agree_game_key, kex_salt, shared_secret};

const GAME: [u8; 16] = *b"tabla-golden-g01";
const BLOB: [u8; 16] = *b"tabla-golden-b01";

fn alice() -> Identity {
    Identity::from_seed(&[0x11; 32])
}

fn bob() -> Identity {
    Identity::from_seed(&[0x22; 32])
}

#[test]
fn identity_public_keys_are_byte_stable() {
    assert_eq!(hex::encode(alice().public_key()), A_PUB);
    assert_eq!(hex::encode(bob().public_key()), B_PUB);
}

#[test]
fn the_ecdh_shared_secret_is_byte_stable() {
    assert_eq!(
        hex::encode(shared_secret(&alice(), &bob().verifying_key())),
        SHARED
    );
}

#[test]
fn the_kex_salt_is_byte_stable() {
    assert_eq!(
        hex::encode(kex_salt(&BLOB, &alice().public_key(), &bob().public_key())),
        SALT
    );
}

#[test]
fn the_derived_game_key_is_byte_stable() {
    assert_eq!(
        hex::encode(agree_game_key(
            &alice(),
            &bob().verifying_key(),
            &BLOB,
            &GAME
        )),
        GAME_KEY
    );
}

#[test]
fn both_sides_still_reach_the_frozen_key() {
    // The property that actually matters: the value above is what *both*
    // participants compute, not just the one that generated the vector.
    let from_bob = agree_game_key(&bob(), &alice().verifying_key(), &BLOB, &GAME);
    assert_eq!(hex::encode(from_bob), GAME_KEY);
}

#[test]
fn a_frozen_invite_blob_still_opens() {
    let blob = hex::decode(INVITE_BLOB).unwrap();
    let cfg = InviteConfig::open(&[0x44; 32], &blob).unwrap();

    assert_eq!(cfg.game_id, GAME);
    assert_eq!(cfg.plugin_id, "tictactoe");
    assert_eq!(cfg.plugin_version, 1);
    assert_eq!(cfg.initiator_pub_key, alice().public_key());
    assert_eq!(cfg.created_at, 1_780_000_000);
}

const A_PUB: &str = "d04ab232742bb4ab3a1368bd4615e4e6d0224ab71a016baf8520a332c9778737";
const B_PUB: &str = "a09aa5f47a6759802ff955f8dc2d2a14a5c99d23be97f864127ff9383455a4f0";
const SHARED: &str = "e4f89e666efa723bce776c3df12d9313a2416965d9acc2279388230b8a136262";
const SALT: &str = "725e6b7a0eb2ff3e724ea0f07a41e7526986c5ac46894df4407d51c87b9b380a";
const GAME_KEY: &str = "d025583f6bcabb5464fbd2ea9d3a96292b64e97606452b70f7cdd30130eb1c78";

/// Sealed with key `0x44…44` and nonce `0x55…55`; the nonce is the 24-byte
/// prefix.
const INVITE_BLOB: &str = concat!(
    "555555555555555555555555555555555555555555555555",
    "0c0ccbbc200af50a52cb5ffe1f676c37ce1668fcd4a0abaaa7af73468dbe46b2",
    "dd3fe3e13f53345304cb7ef98fbb839d220182540b7dbe2fa3b253e32ad242df",
    "9658ada85b900a08219dfe4e3bda18f31976a85c08267191325d5795dc2970b2",
    "c9deae821ace3bbdc4626707b152921f83ce",
);
