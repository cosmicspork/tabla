//! Frozen bytes for the deal.
//!
//! These are wire formats. Both players run the same code today, but a change
//! that alters any byte below would make two builds of this app unable to
//! finish a game together — one would reject the other's proofs and the game
//! would be unrecoverable, mid-play, with no way back. That is what these
//! vectors exist to prevent.
//!
//! If one of these fails, the question is never "what is the new value". It is
//! whether the format was meant to change, and if it was, whether the change
//! needs a new plugin version so that games already under way keep playing
//! under the rules they started with.
//!
//! The same vectors are asserted from TypeScript against the wasm build, so the
//! two languages cannot drift apart either.

use tabla_deal::{
    Ciphertext, KeyShare, PublicShare, Transcript, generators, shuffle, state::DealState,
};

const GAME: [u8; 16] = [0x5a; 16];
const KINDS: u8 = 27;

fn key(index: u8) -> KeyShare {
    KeyShare::from_wide_bytes(&[0x10 + index; 64])
}

#[test]
fn the_generators_are_the_ones_everything_was_proven_against() {
    // If these move, every proof in every game in flight becomes unverifiable.
    assert_eq!(
        hex::encode(generators::h().compress().as_bytes()),
        "ce4c123f310129ab5123b3824f111e676a53fb6e0f1b5f0edc38f5768faeba01"
    );
    assert_eq!(
        hex::encode(generators::tile_point(0).compress().as_bytes()),
        "660365c38b5946e07df9264a6bcad37ea7aaab137793d7ff3eeb7e1aa78dea53"
    );
}

#[test]
fn a_public_key_share_is_stable() {
    assert_eq!(
        hex::encode(key(0).public().to_bytes()),
        "d86a173b388c5eef3c05ed9b4c6a71eed54dff557b49e85d3136c077dac6474e"
    );
}

#[test]
fn a_key_share_proof_is_stable() {
    let mut transcript = Transcript::new(b"deal", &GAME, 2);
    let proof = key(0).prove_knowledge(&mut transcript, &[0x77; 32]);

    assert_eq!(
        hex::encode(proof.to_bytes()),
        "1ae6338e7746d95e5bcd381478f8e549330e334c87fe33cb239589efadaea94c\
         8af6ae2d69b39866681f16ca215847b4bc49405f4fc4099cfa43da2563b6f406"
    );
}

#[test]
fn a_decryption_share_and_its_proof_are_stable() {
    let alice = key(0);
    let bob = key(1);
    let joint = PublicShare::joint(&alice.public(), &bob.public());
    let ciphertext = Ciphertext::trivial(&generators::tile_point(5)).rerandomize(
        &joint,
        &tabla_deal::elgamal::parse_scalar(&[
            3, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
            0, 0, 0,
        ])
        .unwrap(),
    );

    let mut transcript = Transcript::new(b"deal", &GAME, 4);
    let (share, proof) = alice.proven_share(&mut transcript, &ciphertext, &[0x88; 32], 0);

    assert_eq!(
        hex::encode(share.compress().as_bytes()),
        "225cd032148e8f7b6c4b631434d6a031e9d6f9bfef0a73a485c33e5c5f47f953"
    );
    assert_eq!(
        hex::encode(proof.to_bytes()),
        "5af26fdc92487bf644bcfb5132473d3e0af53b6dca4f1286ba97cc0c1d921b03\
         3315d7fcdb1c6a8186c8086d6ef293f3df7dc5ecc57da80b6cbd12ab80687d05"
    );
}

#[test]
fn a_shuffle_of_four_tiles_is_stable() {
    let alice = key(0);
    let bob = key(1);
    let joint = PublicShare::joint(&alice.public(), &bob.public());
    let deck: Vec<Ciphertext> = [1u8, 2, 3, 4]
        .iter()
        .map(|&kind| Ciphertext::trivial(&generators::tile_point(kind)))
        .collect();

    let mut transcript = Transcript::new(b"deal", &GAME, 3);
    let shuffled = shuffle::shuffle(&mut transcript, &deck, &joint, &[0x4d; 32]);

    let mut bytes = Vec::new();
    for ciphertext in &shuffled.deck {
        bytes.extend_from_slice(&ciphertext.to_bytes());
    }
    bytes.extend_from_slice(&shuffled.proof.to_bytes());

    assert_eq!(
        hex::encode(sha256(&bytes)),
        "c27cbd3b1dd9cb8915e33a0138a0b5dcd3971895203a4517e2953f7ab9cf809a"
    );
}

#[test]
fn a_whole_opening_ceremony_is_stable() {
    // The end-to-end anchor: if any part of the deal changes shape, this moves.
    let bag = [1u8, 2, 3, 4, 5, 6];
    let mut initiator = DealState::new(GAME, 0, key(0), &bag, KINDS);
    let mut claimer = DealState::new(GAME, 1, key(1), &bag, KINDS);

    let mut digest = Vec::new();

    let payload = initiator.build(2).key(&[0x01; 32]).finish();
    digest.extend_from_slice(&payload);
    initiator.apply(0, 2, &payload).unwrap();
    claimer.apply(0, 2, &payload).unwrap();

    let payload = claimer
        .build(3)
        .key(&[0x02; 32])
        .shuffle(&[0x03; 32])
        .finish();
    digest.extend_from_slice(&payload);
    initiator.apply(1, 3, &payload).unwrap();
    claimer.apply(1, 3, &payload).unwrap();

    let payload = initiator
        .build(4)
        .shuffle(&[0x04; 32])
        .deal(2, &[0x05; 32])
        .finish();
    digest.extend_from_slice(&payload);
    initiator.apply(0, 4, &payload).unwrap();
    claimer.apply(0, 4, &payload).unwrap();

    let payload = claimer.build(5).deal(2, &[0x06; 32]).finish();
    digest.extend_from_slice(&payload);
    initiator.apply(1, 5, &payload).unwrap();
    claimer.apply(1, 5, &payload).unwrap();

    assert_eq!(
        hex::encode(sha256(&digest)),
        "5114418875a4395c8d5857ca4e43bd8ac565738943359bfb4716524532d48123"
    );

    // And the deal it produced, which is what the bytes are for.
    assert_eq!(claimer.held(), vec![0, 1]);
    assert_eq!(initiator.held(), vec![2, 3]);
    let dealt: Vec<u8> = claimer
        .held()
        .iter()
        .filter_map(|&p| claimer.tile(p))
        .collect();
    assert_eq!(dealt, vec![2, 6]);
}

fn sha256(bytes: &[u8]) -> [u8; 32] {
    use sha2::{Digest, Sha256};
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    hasher.finalize().into()
}
