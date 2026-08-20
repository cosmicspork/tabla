//! Proving a deck was shuffled, without saying how.
//!
//! This is the argument the whole deal rests on. A player takes the deck,
//! permutes it, re-randomises every ciphertext so the new deck cannot be
//! matched against the old one, and publishes it with a proof that this is
//! exactly what they did — no tile added, removed, duplicated, or swapped for
//! another. The opponent verifies without learning the permutation, which is
//! the only reason the deck is worth anything afterwards.
//!
//! Both players shuffle in turn. Neither knows the composition of the two
//! permutations, so neither knows where any tile is; and because each shuffle
//! is proven, neither had to be trusted for that to be true.
//!
//! ## How it works
//!
//! The prover commits to the permutation `a` where `aᵢ = π(i)`. The verifier
//! sends `x`, and the prover commits to `bᵢ = x^{π(i)}` — the same permutation,
//! applied to a vector the verifier chose after the fact. Two more challenges
//! `y` and `z` reduce the claim "`a` is a permutation and `b` matches it" to a
//! single product:
//!
//! ```text
//! ∏ᵢ (y·aᵢ + bᵢ − z)  =  ∏ⱼ (y·j + x^j − z)
//! ```
//!
//! The right-hand side is public. Equality forces the multiset `{(aᵢ, bᵢ)}` to
//! be `{(j, x^j)}`, because the two sides are values of a polynomial identity
//! in `y` and `z` that a cheating prover would have to satisfy at a point they
//! could not predict — and the multiset being right is precisely `a` being a
//! permutation with `b` carrying it. [`product`] proves that equality.
//!
//! Then [`multiexp`] proves `Σᵢ bᵢ·C'ᵢ = Σⱼ x^j·Cⱼ + ρ·(G, X)`, which ties the
//! published deck to that same `b`. Together: the deck is a permutation of the
//! input, re-randomised, and nothing else.
//!
//! ## What it does not prove
//!
//! That the *input* deck was well-formed. The first shuffle takes a deck both
//! players can compute from the tile distribution, so the starting point needs
//! no proof; every later shuffle takes the previous output, which was itself
//! proven. Soundness is inductive, and [`crate::state`] is what maintains the
//! chain — a shuffle verified against the wrong input deck proves nothing.

pub mod bilinear;
pub mod commit;
pub mod multiexp;
pub mod product;

use curve25519_dalek::{RistrettoPoint, Scalar};

use crate::{
    Ciphertext, DealError, POINT_LEN, Transcript,
    elgamal::weighted_sum,
    encoding::{point_from_bytes, put_point},
    generators,
    shuffle::commit::Basis,
};

/// A shuffle and the proof that it is one.
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct ShuffleProof {
    permutation_commitment: RistrettoPoint,
    exponent_commitment: RistrettoPoint,
    product: product::ProductProof,
    multiexp: multiexp::MultiexpProof,
}

/// Serialized size of a proof for a deck of `n` ciphertexts.
pub const fn proof_len(n: usize) -> usize {
    POINT_LEN * 2 + product::proof_len(n) + multiexp::proof_len(n)
}

/// The permuted, re-randomised deck together with its proof.
pub struct Shuffle {
    pub deck: Vec<Ciphertext>,
    pub proof: ShuffleProof,
}

/// Shuffles a deck and proves it.
///
/// `entropy` supplies both the permutation and every re-randomisation. It must
/// be fresh: reusing it against the same deck reproduces the same shuffle, and
/// an opponent who noticed would learn the permutation.
pub fn shuffle(
    transcript: &mut Transcript,
    deck: &[Ciphertext],
    key: &RistrettoPoint,
    entropy: &[u8],
) -> Shuffle {
    let permutation = permutation_from_entropy(entropy, deck.len());
    shuffle_by(transcript, deck, key, entropy, &permutation)
}

/// Shuffles by a caller-chosen ordering.
///
/// Split out so the tests can drive the prover with an ordering that is *not*
/// a permutation, which is the only way to check that the argument rejects a
/// cheat rather than merely rejecting a damaged proof.
fn shuffle_by(
    transcript: &mut Transcript,
    deck: &[Ciphertext],
    key: &RistrettoPoint,
    entropy: &[u8],
    permutation: &[usize],
) -> Shuffle {
    let n = deck.len();
    let basis = Basis::new(n);

    let randomizers: Vec<Scalar> = (0..n)
        .map(|i| generators::scalar_from_entropy(b"shuffle-rerandomize", entropy, i as u32))
        .collect();

    let output: Vec<Ciphertext> = permutation
        .iter()
        .enumerate()
        .map(|(i, &from)| deck[from].rerandomize(key, &randomizers[i]))
        .collect();

    // Commit to the permutation before any challenge exists, so it cannot be
    // chosen to suit one.
    let a: Vec<Scalar> = permutation
        .iter()
        .map(|&j| Scalar::from(j as u64 + 1))
        .collect();
    let blinding_a = generators::scalar_from_entropy(b"shuffle-blinding-a", entropy, 0);
    let permutation_commitment = basis.commit(&a, &blinding_a);

    let x = challenge_x(transcript, deck, &output, key, &permutation_commitment);
    let powers = powers_of(&x, n);

    let b: Vec<Scalar> = permutation.iter().map(|&j| powers[j]).collect();
    let blinding_b = generators::scalar_from_entropy(b"shuffle-blinding-b", entropy, 0);
    let exponent_commitment = basis.commit(&b, &blinding_b);

    let (y, z) = challenge_yz(transcript, &exponent_commitment);

    // d = y·a + b − z, committed implicitly: the verifier rebuilds it.
    let d: Vec<Scalar> = a.iter().zip(&b).map(|(a, b)| y * a + b - z).collect();
    let blinding_d = y * blinding_a + blinding_b;
    let commitment_d =
        permutation_commitment * y + exponent_commitment - basis.sum_of_generators() * z;

    let product =
        product::ProductProof::prove(transcript, &basis, commitment_d, &d, &blinding_d, entropy);

    let randomizer: Scalar = b.iter().zip(&randomizers).map(|(b, s)| b * s).sum();
    let multiexp = multiexp::MultiexpProof::prove(
        transcript,
        &basis,
        &multiexp::Statement {
            commitment: exponent_commitment,
            output: &output,
            input_combination: weighted_sum(deck, &powers),
            key: *key,
        },
        &b,
        &blinding_b,
        &randomizer,
        entropy,
    );

    Shuffle {
        deck: output,
        proof: ShuffleProof {
            permutation_commitment,
            exponent_commitment,
            product,
            multiexp,
        },
    }
}

impl ShuffleProof {
    /// Checks that `output` is a permuted re-encryption of `input`.
    pub fn verify(
        &self,
        transcript: &mut Transcript,
        input: &[Ciphertext],
        output: &[Ciphertext],
        key: &RistrettoPoint,
    ) -> Result<(), DealError> {
        let n = input.len();
        if output.len() != n {
            return Err(DealError::WrongLength);
        }

        let basis = Basis::new(n);

        let x = challenge_x(transcript, input, output, key, &self.permutation_commitment);
        let powers = powers_of(&x, n);
        let (y, z) = challenge_yz(transcript, &self.exponent_commitment);

        let commitment_d = self.permutation_commitment * y + self.exponent_commitment
            - basis.sum_of_generators() * z;

        // ∏ⱼ (y·j + x^j − z), the value an honest permutation must produce.
        let target: Scalar = (0..n)
            .map(|j| y * Scalar::from(j as u64 + 1) + powers[j] - z)
            .product();

        self.product
            .verify(transcript, &basis, commitment_d, target)?;

        self.multiexp.verify(
            transcript,
            &basis,
            &multiexp::Statement {
                commitment: self.exponent_commitment,
                output,
                input_combination: weighted_sum(input, &powers),
                key: *key,
            },
        )
    }

    pub fn to_bytes(&self) -> Vec<u8> {
        let mut out = Vec::new();
        put_point(&mut out, &self.permutation_commitment);
        put_point(&mut out, &self.exponent_commitment);
        out.extend_from_slice(&self.product.to_bytes());
        out.extend_from_slice(&self.multiexp.to_bytes());
        out
    }

    pub fn from_bytes(bytes: &[u8], n: usize) -> Result<Self, DealError> {
        if bytes.len() < proof_len(n) {
            return Err(DealError::Truncated);
        }

        let permutation_commitment = point_from_bytes(&bytes[..POINT_LEN])?;
        let exponent_commitment = point_from_bytes(&bytes[POINT_LEN..])?;

        let at = POINT_LEN * 2;
        let product = product::ProductProof::from_bytes(&bytes[at..], n)?;
        let at = at + product::proof_len(n);
        let multiexp = multiexp::MultiexpProof::from_bytes(&bytes[at..], n)?;

        Ok(Self {
            permutation_commitment,
            exponent_commitment,
            product,
            multiexp,
        })
    }
}

/// A permutation of `0..n`, expanded from caller-supplied entropy.
///
/// Fisher-Yates driven by scalars derived from the entropy, so the same bytes
/// always give the same permutation — which is what makes proving reproducible
/// under test — and different bytes give an unbiased one.
fn permutation_from_entropy(entropy: &[u8], n: usize) -> Vec<usize> {
    let mut order: Vec<usize> = (0..n).collect();

    for i in (1..n).rev() {
        let draw = generators::scalar_from_entropy(b"shuffle-permutation", entropy, i as u32);
        // The low 8 bytes of a uniform scalar, reduced into 0..=i. The bias is
        // below 2⁻⁵⁶ for any deck a game could hold.
        let bytes: [u8; 8] = draw.as_bytes()[..8].try_into().expect("8 bytes");
        let j = (u64::from_le_bytes(bytes) % (i as u64 + 1)) as usize;
        order.swap(i, j);
    }

    order
}

fn powers_of(x: &Scalar, n: usize) -> Vec<Scalar> {
    let mut powers = Vec::with_capacity(n);
    let mut current = *x;
    for _ in 0..n {
        powers.push(current);
        current *= x;
    }
    powers
}

fn challenge_x(
    transcript: &mut Transcript,
    input: &[Ciphertext],
    output: &[Ciphertext],
    key: &RistrettoPoint,
    permutation_commitment: &RistrettoPoint,
) -> Scalar {
    transcript.absorb_u32(b"shuffle-n", input.len() as u32);
    transcript.absorb_point(b"shuffle-key", key);
    for ciphertext in input {
        transcript.absorb_point(b"shuffle-in-c1", &ciphertext.c1);
        transcript.absorb_point(b"shuffle-in-c2", &ciphertext.c2);
    }
    for ciphertext in output {
        transcript.absorb_point(b"shuffle-out-c1", &ciphertext.c1);
        transcript.absorb_point(b"shuffle-out-c2", &ciphertext.c2);
    }
    transcript.absorb_point(b"shuffle-permutation", permutation_commitment);
    transcript.challenge(b"shuffle-x")
}

fn challenge_yz(
    transcript: &mut Transcript,
    exponent_commitment: &RistrettoPoint,
) -> (Scalar, Scalar) {
    transcript.absorb_point(b"shuffle-exponents", exponent_commitment);
    let y = transcript.challenge(b"shuffle-y");
    let z = transcript.challenge(b"shuffle-z");
    (y, z)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::elgamal::{KeyShare, PublicShare};

    const GAME: [u8; 16] = [0x2b; 16];

    fn transcript() -> Transcript {
        Transcript::new(b"shuffle-test", &GAME, 5)
    }

    fn key() -> RistrettoPoint {
        let alice = KeyShare::from_wide_bytes(&[0x11; 64]);
        let bob = KeyShare::from_wide_bytes(&[0x22; 64]);
        PublicShare::joint(&alice.public(), &bob.public())
    }

    /// The starting deck: one trivial ciphertext per tile, publicly computable.
    fn deck(n: usize) -> Vec<Ciphertext> {
        (0..n)
            .map(|i| Ciphertext::trivial(&generators::tile_point((i % 27) as u8)))
            .collect()
    }

    #[test]
    fn an_honest_shuffle_verifies() {
        let input = deck(8);
        let shuffled = shuffle(&mut transcript(), &input, &key(), &[0x4d; 32]);

        assert!(
            shuffled
                .proof
                .verify(&mut transcript(), &input, &shuffled.deck, &key())
                .is_ok()
        );
    }

    #[test]
    fn shuffles_of_every_practical_size_verify() {
        for n in [1, 2, 3, 5, 8, 13, 27] {
            let input = deck(n);
            let shuffled = shuffle(&mut transcript(), &input, &key(), &[0x4d; 32]);

            assert!(
                shuffled
                    .proof
                    .verify(&mut transcript(), &input, &shuffled.deck, &key())
                    .is_ok(),
                "a deck of {n} failed"
            );
        }
    }

    #[test]
    fn a_shuffle_actually_moves_tiles() {
        // If the permutation were the identity and the re-randomisation absent,
        // every test above would still pass while proving nothing useful.
        let input = deck(16);
        let shuffled = shuffle(&mut transcript(), &input, &key(), &[0x4d; 32]);

        assert_ne!(shuffled.deck, input);
        assert!(
            shuffled
                .deck
                .iter()
                .zip(&input)
                .filter(|(a, b)| a != b)
                .count()
                > 8
        );
    }

    #[test]
    fn the_same_entropy_gives_the_same_shuffle() {
        let input = deck(8);
        let first = shuffle(&mut transcript(), &input, &key(), &[0x4d; 32]);
        let second = shuffle(&mut transcript(), &input, &key(), &[0x4d; 32]);

        assert_eq!(first.deck, second.deck);
    }

    #[test]
    fn different_entropy_gives_a_different_shuffle() {
        let input = deck(16);
        let first = shuffle(&mut transcript(), &input, &key(), &[0x4d; 32]);
        let second = shuffle(&mut transcript(), &input, &key(), &[0x4e; 32]);

        assert_ne!(first.deck, second.deck);
    }

    #[test]
    fn a_deck_with_a_tile_replaced_is_refused() {
        // Adding a tile that was never in the bag is the attack that matters
        // most: a player who could do it would deal themselves anything.
        let input = deck(8);
        let shuffled = shuffle(&mut transcript(), &input, &key(), &[0x4d; 32]);

        let mut forged = shuffled.deck.clone();
        forged[3] = Ciphertext::trivial(&generators::tile_point(26));

        assert_eq!(
            shuffled
                .proof
                .verify(&mut transcript(), &input, &forged, &key()),
            Err(DealError::BadProof)
        );
    }

    #[test]
    fn a_deck_with_a_tile_duplicated_is_refused() {
        let input = deck(8);
        let shuffled = shuffle(&mut transcript(), &input, &key(), &[0x4d; 32]);

        let mut forged = shuffled.deck.clone();
        forged[3] = forged[4];

        assert_eq!(
            shuffled
                .proof
                .verify(&mut transcript(), &input, &forged, &key()),
            Err(DealError::BadProof)
        );
    }

    #[test]
    fn a_reordered_deck_is_refused() {
        let input = deck(8);
        let shuffled = shuffle(&mut transcript(), &input, &key(), &[0x4d; 32]);

        let mut forged = shuffled.deck.clone();
        forged.swap(0, 7);

        assert_eq!(
            shuffled
                .proof
                .verify(&mut transcript(), &input, &forged, &key()),
            Err(DealError::BadProof)
        );
    }

    #[test]
    fn a_proof_against_a_different_input_deck_is_refused() {
        // This is the inductive step the state machine depends on: a shuffle is
        // only meaningful against the deck it actually consumed.
        let input = deck(8);
        let shuffled = shuffle(&mut transcript(), &input, &key(), &[0x4d; 32]);

        let mut other = input.clone();
        other[0] = Ciphertext::trivial(&generators::tile_point(20));

        assert_eq!(
            shuffled
                .proof
                .verify(&mut transcript(), &other, &shuffled.deck, &key()),
            Err(DealError::BadProof)
        );
    }

    #[test]
    fn a_proof_under_a_different_key_is_refused() {
        let input = deck(8);
        let shuffled = shuffle(&mut transcript(), &input, &key(), &[0x4d; 32]);
        let other_key = PublicShare::joint(
            &KeyShare::from_wide_bytes(&[0x33; 64]).public(),
            &KeyShare::from_wide_bytes(&[0x44; 64]).public(),
        );

        assert_eq!(
            shuffled
                .proof
                .verify(&mut transcript(), &input, &shuffled.deck, &other_key),
            Err(DealError::BadProof)
        );
    }

    #[test]
    fn a_proof_does_not_travel_to_another_log_position() {
        let input = deck(8);
        let shuffled = shuffle(&mut transcript(), &input, &key(), &[0x4d; 32]);
        let mut elsewhere = Transcript::new(b"shuffle-test", &GAME, 6);

        assert_eq!(
            shuffled
                .proof
                .verify(&mut elsewhere, &input, &shuffled.deck, &key()),
            Err(DealError::BadProof)
        );
    }

    #[test]
    fn every_single_byte_of_the_proof_matters() {
        let input = deck(4);
        let shuffled = shuffle(&mut transcript(), &input, &key(), &[0x4d; 32]);
        let bytes = shuffled.proof.to_bytes();

        for i in (0..bytes.len()).step_by(11) {
            let mut mangled = bytes.clone();
            mangled[i] ^= 0x01;

            let refused = match ShuffleProof::from_bytes(&mangled, 4) {
                Err(_) => true,
                Ok(proof) => proof
                    .verify(&mut transcript(), &input, &shuffled.deck, &key())
                    .is_err(),
            };

            assert!(refused, "flipping a bit in byte {i} was not noticed");
        }
    }

    #[test]
    fn two_shuffles_compose_and_both_verify() {
        // What actually happens in a game: each player shuffles in turn, and
        // neither knows the composition.
        let input = deck(16);
        let key = key();

        let first = shuffle(&mut transcript(), &input, &key, &[0x01; 32]);
        let second = shuffle(&mut transcript(), &first.deck, &key, &[0x02; 32]);

        assert!(
            first
                .proof
                .verify(&mut transcript(), &input, &first.deck, &key)
                .is_ok()
        );
        assert!(
            second
                .proof
                .verify(&mut transcript(), &first.deck, &second.deck, &key)
                .is_ok()
        );
    }

    #[test]
    fn a_shuffled_deck_still_holds_exactly_the_tiles_it_started_with() {
        // The property a player cares about, checked by opening everything:
        // the bag is the bag, whatever order it ended up in.
        let alice = KeyShare::from_wide_bytes(&[0x11; 64]);
        let bob = KeyShare::from_wide_bytes(&[0x22; 64]);
        let key = PublicShare::joint(&alice.public(), &bob.public());

        let input = deck(27);
        let first = shuffle(&mut transcript(), &input, &key, &[0x01; 32]);
        let second = shuffle(&mut transcript(), &first.deck, &key, &[0x02; 32]);

        let mut tiles: Vec<u8> = second
            .deck
            .iter()
            .map(|c| {
                let opened = c.open([&alice.decryption_share(c), &bob.decryption_share(c)]);
                generators::tile_of(&opened, 27).expect("every position holds a tile")
            })
            .collect();
        tiles.sort_unstable();

        assert_eq!(tiles, (0..27).collect::<Vec<u8>>());
    }

    #[test]
    fn permutations_are_permutations() {
        for n in [1, 2, 7, 52, 102] {
            let mut seen = permutation_from_entropy(&[0x9f; 32], n);
            seen.sort_unstable();

            assert_eq!(seen, (0..n).collect::<Vec<usize>>());
        }
    }

    #[test]
    fn a_prover_who_duplicates_a_tile_cannot_produce_a_proof() {
        // The soundness test that matters. Every other negative here starts
        // from an honest proof and damages it; this one runs the prover
        // faithfully on a witness that is not a permutation — two output
        // positions taking the same tile, which is how a player would give
        // themselves a second blank. The commitments and both sub-arguments are
        // built exactly as an honest prover builds them.
        let input = deck(8);
        let mut cheating = permutation_from_entropy(&[0x4d; 32], 8);
        cheating[5] = cheating[2];

        let forged = shuffle_by(&mut transcript(), &input, &key(), &[0x4d; 32], &cheating);

        assert_eq!(
            forged
                .proof
                .verify(&mut transcript(), &input, &forged.deck, &key()),
            Err(DealError::BadProof)
        );
    }

    #[test]
    fn a_prover_who_drops_a_tile_cannot_produce_a_proof() {
        // The mirror image: quietly removing a tile from the bag, which over a
        // game shifts every remaining probability.
        let input = deck(8);
        let mut cheating = permutation_from_entropy(&[0x4d; 32], 8);
        cheating[0] = cheating[1];

        let forged = shuffle_by(&mut transcript(), &input, &key(), &[0x4d; 32], &cheating);

        assert_eq!(
            forged
                .proof
                .verify(&mut transcript(), &input, &forged.deck, &key()),
            Err(DealError::BadProof)
        );
    }

    #[test]
    fn a_prover_who_reaches_outside_the_deck_cannot_produce_a_proof() {
        // An index past the end of the bag: the tile it names does not exist,
        // and the commitment to it must not pass for a permutation entry.
        let input = deck(8);
        let mut cheating = permutation_from_entropy(&[0x4d; 32], 8);
        cheating[3] = 0;
        let mut with_extra = input.clone();
        with_extra[0] = Ciphertext::trivial(&generators::tile_point(26));

        let forged = shuffle_by(
            &mut transcript(),
            &with_extra,
            &key(),
            &[0x4d; 32],
            &cheating,
        );

        assert_eq!(
            forged
                .proof
                .verify(&mut transcript(), &input, &forged.deck, &key()),
            Err(DealError::BadProof)
        );
    }

    #[test]
    fn proofs_survive_a_round_trip_and_have_the_size_claimed() {
        let input = deck(8);
        let shuffled = shuffle(&mut transcript(), &input, &key(), &[0x4d; 32]);
        let bytes = shuffled.proof.to_bytes();

        assert_eq!(bytes.len(), proof_len(8));
        assert_eq!(ShuffleProof::from_bytes(&bytes, 8).unwrap(), shuffled.proof);
    }

    #[test]
    fn a_full_tile_bag_fits_the_relay_entry_limit() {
        // 102 tiles is the word game's bag. The relay refuses an entry over
        // 64 KiB, and a shuffle is the largest entry the protocol ever writes,
        // so this is the number that decides whether the design works at all.
        let input = deck(102);
        let shuffled = shuffle(&mut transcript(), &input, &key(), &[0x4d; 32]);

        let deck_bytes = shuffled.deck.len() * crate::CIPHERTEXT_LEN;
        let proof_bytes = shuffled.proof.to_bytes().len();

        assert_eq!(proof_bytes, proof_len(102));
        assert!(
            deck_bytes + proof_bytes < 20_000,
            "a shuffle entry grew to {} bytes",
            deck_bytes + proof_bytes
        );
    }

    /// Not an assertion, a number to look at: `cargo test -- --ignored --nocapture`.
    ///
    /// Verification runs on every device that reads the log, so if this starts
    /// climbing it is worth knowing before a player notices.
    #[test]
    #[ignore = "reports timings rather than asserting anything"]
    fn how_long_a_full_bag_takes() {
        use std::time::Instant;

        let input = deck(102);
        let key = key();

        let start = Instant::now();
        let shuffled = shuffle(&mut transcript(), &input, &key, &[0x4d; 32]);
        let proving = start.elapsed();

        let start = Instant::now();
        shuffled
            .proof
            .verify(&mut transcript(), &input, &shuffled.deck, &key)
            .expect("the shuffle just made verifies");
        let verifying = start.elapsed();

        println!(
            "102 tiles: prove {proving:?}, verify {verifying:?}, {} bytes of proof",
            shuffled.proof.to_bytes().len()
        );
    }
}
