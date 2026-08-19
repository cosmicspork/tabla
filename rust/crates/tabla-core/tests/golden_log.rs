//! Frozen wire-format vectors.
//!
//! These bytes are the log format. If a change to encoding, hashing, or signing
//! makes this file fail, that change breaks every log already on disk and every
//! peer already running — the vectors are not to be regenerated to make the
//! build green.

use ed25519_dalek::SigningKey;
use tabla_core::log::{Entry, GENESIS_PREV_HASH, Tombstone, key_hash};

const GAME: [u8; 16] = *b"tabla-golden-01\0";

fn alice() -> SigningKey {
    SigningKey::from_bytes(&[0x11; 32])
}

fn bob() -> SigningKey {
    SigningKey::from_bytes(&[0x22; 32])
}

#[test]
fn genesis_entry_is_byte_stable() {
    let e = Entry::sign(&alice(), 0, GENESIS_PREV_HASH, GAME, b"hello".to_vec());

    assert_eq!(hex::encode(e.preimage()), GENESIS_PREIMAGE);
    assert_eq!(hex::encode(e.hash()), GENESIS_HASH);
    assert_eq!(hex::encode(e.sig), GENESIS_SIG);
    assert_eq!(hex::encode(e.encode()), GENESIS_WIRE);
}

#[test]
fn second_entry_chains_stably() {
    let first = Entry::sign(&alice(), 0, GENESIS_PREV_HASH, GAME, b"hello".to_vec());
    let second = Entry::sign(&bob(), 1, first.hash(), GAME, b"world".to_vec());

    assert_eq!(hex::encode(second.preimage()), SECOND_PREIMAGE);
    assert_eq!(hex::encode(second.hash()), SECOND_HASH);
    assert_eq!(hex::encode(second.sig), SECOND_SIG);
}

#[test]
fn key_hashes_are_byte_stable() {
    assert_eq!(
        hex::encode(key_hash(&alice().verifying_key().to_bytes())),
        ALICE_KEY_HASH
    );
    assert_eq!(
        hex::encode(key_hash(&bob().verifying_key().to_bytes())),
        BOB_KEY_HASH
    );
}

#[test]
fn tombstone_encoding_is_byte_stable() {
    let first = Entry::sign(&alice(), 0, GENESIS_PREV_HASH, GAME, b"hello".to_vec());
    let second = Entry::sign(&bob(), 1, first.hash(), GAME, b"world".to_vec());

    let t = Tombstone {
        game_id: GAME,
        tip_hash: second.hash(),
        participant_key_hashes: vec![
            key_hash(&alice().verifying_key().to_bytes()),
            key_hash(&bob().verifying_key().to_bytes()),
        ],
        timestamp: 1_780_000_000,
    };

    assert_eq!(hex::encode(t.encode()), TOMBSTONE_WIRE);
}

#[test]
fn frozen_wire_bytes_still_decode_and_verify() {
    // The strongest form of the check: parse the committed bytes with today's
    // code and confirm the signature made years earlier still verifies.
    let bytes = hex::decode(GENESIS_WIRE).unwrap();
    let e = Entry::decode(&bytes).unwrap();

    assert_eq!(e.header.seq, 0);
    assert_eq!(e.header.game_id, GAME);
    assert_eq!(e.payload, b"hello");
    e.verify_signature(&alice().verifying_key()).unwrap();
}

// Verified by hand against the layout in ARCHITECTURE.md when frozen:
// "tabla-log/v1" | 00000000 (seq 0) | 32 zero bytes (genesis prevHash) |
// "tabla-golden-01\0" | alice key hash | 05000000 (len) | "hello".
const ALICE_KEY_HASH: &str = "10ba682c8ad13513971e8b56881aab8bd702bb807796eca81932c735a94d6e6d";
const BOB_KEY_HASH: &str = "1325b850c2871916eae203f0efc3c8987f64e5e3cdb27679e6d1fa97808357e6";

const GENESIS_PREIMAGE: &str = concat!(
    "7461626c612d6c6f672f7631",
    "00000000",
    "0000000000000000000000000000000000000000000000000000000000000000",
    "7461626c612d676f6c64656e2d303100",
    "10ba682c8ad13513971e8b56881aab8bd702bb807796eca81932c735a94d6e6d",
    "05000000",
    "68656c6c6f",
);
const GENESIS_HASH: &str = "0d30583b8582ec86de5804610b55edcc254504b57232126abfcf1bee641f60c1";
const GENESIS_SIG: &str = concat!(
    "5ed6a9957edbf2260988975ab9bb0982c82341973e3b4e8d8a9edc154286de8c",
    "8bf9868dc90f4b3d2bd7ffdc9b65fc70fd2d6ffcd53d611be360f209ffb83c02",
);
const GENESIS_WIRE: &str = concat!(
    "7461626c612d6c6f672f7631",
    "00000000",
    "0000000000000000000000000000000000000000000000000000000000000000",
    "7461626c612d676f6c64656e2d303100",
    "10ba682c8ad13513971e8b56881aab8bd702bb807796eca81932c735a94d6e6d",
    "05000000",
    "68656c6c6f",
    "5ed6a9957edbf2260988975ab9bb0982c82341973e3b4e8d8a9edc154286de8c",
    "8bf9868dc90f4b3d2bd7ffdc9b65fc70fd2d6ffcd53d611be360f209ffb83c02",
);

const SECOND_PREIMAGE: &str = concat!(
    "7461626c612d6c6f672f7631",
    "01000000",
    "0d30583b8582ec86de5804610b55edcc254504b57232126abfcf1bee641f60c1",
    "7461626c612d676f6c64656e2d303100",
    "1325b850c2871916eae203f0efc3c8987f64e5e3cdb27679e6d1fa97808357e6",
    "05000000",
    "776f726c64",
);
const SECOND_HASH: &str = "baded652422965be1a43fcd567a963347507496597723919bafa5e66c4cac447";
const SECOND_SIG: &str = concat!(
    "0f0300388a11dc57450aa0ff84252c4b361bac41b0ddb30213b7c1056f3f3e3d",
    "c12fc0dcd18645271fdee6e06fb286deb1de0e617865ada35661670fbe675c08",
);

const TOMBSTONE_WIRE: &str = concat!(
    "7461626c612d746f6d622f7631",
    "7461626c612d676f6c64656e2d303100",
    "baded652422965be1a43fcd567a963347507496597723919bafa5e66c4cac447",
    "02",
    "10ba682c8ad13513971e8b56881aab8bd702bb807796eca81932c735a94d6e6d",
    "1325b850c2871916eae203f0efc3c8987f64e5e3cdb27679e6d1fa97808357e6",
    "00a5186a00000000",
);
