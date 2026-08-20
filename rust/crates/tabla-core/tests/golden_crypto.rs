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
fn draw_seeds_are_byte_stable_and_private_to_each_player() {
    // A game with hidden state derives its draws from this value, so a change
    // here would make a restored device disagree with its own half-played rack.
    assert_eq!(hex::encode(alice().draw_seed(&GAME)), A_DRAW);
    assert_eq!(hex::encode(bob().draw_seed(&GAME)), B_DRAW);

    // Different players, and different games for one player, must never share
    // draw entropy: the whole point is that neither side can predict the other.
    assert_ne!(alice().draw_seed(&GAME), bob().draw_seed(&GAME));
    assert_ne!(alice().draw_seed(&GAME), alice().draw_seed(&BLOB));

    // And it must not be the identity seed under another name: this value is
    // published when the game ends.
    assert_ne!(alice().draw_seed(&GAME), alice().seed());
}

#[test]
fn deal_secrets_are_byte_stable_and_private_to_each_player() {
    // The deck is encrypted under the sum of both players' public halves. If
    // this derivation moved, a restored device would compute a different half,
    // and every tile it had been dealt would open to nonsense.
    assert_eq!(hex::encode(alice().deal_secret(&GAME)), A_DEAL);
    assert_eq!(hex::encode(bob().deal_secret(&GAME)), B_DEAL);

    assert_ne!(alice().deal_secret(&GAME), bob().deal_secret(&GAME));
    assert_ne!(alice().deal_secret(&GAME), alice().deal_secret(&BLOB));

    // Distinct from the draw seed even for the same game and player. That one
    // is published at the end of a game; this one never is, and a derivation
    // that produced both from one tag would leak the deck.
    assert_ne!(
        alice().deal_secret(&GAME)[..32],
        alice().draw_seed(&GAME)[..]
    );
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

const A_DRAW: &str = "603b9525971b7038aa85f1b7ef2f3f417663c25acb08ff8b328f75dac726e549";
const B_DRAW: &str = "89c3e94c7f40fd1bb1c05223dab174817ff8f41785746eecabadf9c149ef2cf6";
const A_DEAL: &str = concat!(
    "2860080d4063cda4739ef79b5ca8d6c29cd011809bd4efaa25da0c717d2304c0",
    "210ba2d033c91daa12521958c60c5781579145675718a0ce3282389397f4692f",
);
const B_DEAL: &str = concat!(
    "613c915e265dbd4bfd20b0b0cfa85a814fb7559d5a3337e5be774ea55e0d5a74",
    "89594877a57de29a39950c80928d4ab978b4039d828ee617a6237c902fda32de",
);

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

// -- manifest ---------------------------------------------------------------

/// The manifest signature, frozen so both languages agree on the same bytes.
///
/// The TypeScript half of this vector lives in
/// `app/src/lib/plugin/manifest.test.ts`. A build whose two halves disagree
/// would verify signatures in Rust that the app rejects, or worse.
#[test]
fn a_frozen_manifest_signature_still_verifies() {
    use tabla_core::identity::parse_public_key;
    use tabla_core::manifest::{manifest_message, verify};

    let publisher = Identity::from_seed(&[0x33; 32]);
    let payload = br#"{"version":1,"plugins":[]}"#;
    let sig = publisher.sign(&manifest_message(payload));

    assert_eq!(hex::encode(sig), MANIFEST_SIG);

    let key = parse_public_key(&publisher.public_key()).expect("the publisher key parses");
    assert_eq!(hex::encode(publisher.public_key()), PUBLISHER_PUB);
    assert!(verify(&key, payload, &sig).is_ok());
}

const PUBLISHER_PUB: &str = "17cb79fb2b4120f2b1ec65e4198d6e08b28e813feb01e4a400839b85e18080ce";
const MANIFEST_SIG: &str = "532947e6d074027a298f761ef1da5ec42c4fa2db227f2f257046908c7a1e3e82384cacd7418125a4dabdbba0ba3e60ead0a2deac416411063a930ed68c5c500c";
