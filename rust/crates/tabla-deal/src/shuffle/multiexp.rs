//! Tying a committed vector to an actual re-encryption of the deck.
//!
//! The product argument establishes that the prover holds a genuine
//! permutation. This one establishes that the deck they published is *that*
//! permutation of the deck they were given, re-randomised and nothing else.
//! Without it a prover could commit to a perfectly good permutation and then
//! publish any ciphertexts at all.
//!
//! The relation proven, for output deck `C'`, input deck `C`, joint key `X`,
//! and the committed vector `b` with `bᵢ = x^{π(i)}`:
//!
//! ```text
//! Σᵢ bᵢ·C'ᵢ − ρ·(G, X) = Σⱼ x^j·Cⱼ
//! ```
//!
//! Both sides are ElGamal ciphertexts, added componentwise. The right-hand side
//! is public. The left is a weighted sum of the published deck under weights
//! only the prover knows, offset by the aggregate re-randomisation `ρ`. If the
//! output really is the permuted, re-randomised input then the two sides are
//! equal by construction; if any output ciphertext was substituted, they differ
//! for all but a negligible fraction of the challenge `x`.
//!
//! The argument itself is one more masked opening, in the same shape as
//! [`super::bilinear`]: commit to a random vector, answer a challenge with
//! `b·e + mask`, and let the verifier re-run both the commitment and the
//! ciphertext sum on the answer.

use curve25519_dalek::{RistrettoPoint, Scalar};

use crate::{
    Ciphertext, DealError, POINT_LEN, SCALAR_LEN, Transcript,
    elgamal::weighted_sum,
    encoding::{point_from_bytes, put_point, put_scalar, scalar_from_bytes, scalars_from_bytes},
    generators,
    shuffle::commit::Basis,
};

#[derive(Clone, PartialEq, Eq, Debug)]
pub struct MultiexpProof {
    mask_commitment: RistrettoPoint,
    mask_ciphertext: Ciphertext,
    response: Vec<Scalar>,
    blinding: Scalar,
    randomizer: Scalar,
}

/// Serialized size for a deck of `n` ciphertexts.
pub const fn proof_len(n: usize) -> usize {
    POINT_LEN * 3 + SCALAR_LEN * (n + 2)
}

/// What both sides agree on before the argument starts.
pub struct Statement<'a> {
    /// Commitment to the exponent vector `b`.
    pub commitment: RistrettoPoint,
    /// The deck the prover published.
    pub output: &'a [Ciphertext],
    /// The public weighted sum of the input deck, `Σ x^j·Cⱼ`.
    pub input_combination: Ciphertext,
    /// The joint public key, as the ciphertext `(G, X)` re-randomisation adds.
    pub key: RistrettoPoint,
}

impl MultiexpProof {
    pub fn prove(
        transcript: &mut Transcript,
        basis: &Basis,
        statement: &Statement<'_>,
        exponents: &[Scalar],
        blinding: &Scalar,
        randomizer: &Scalar,
        entropy: &[u8],
    ) -> Self {
        let n = exponents.len();

        let mask: Vec<Scalar> = (0..n)
            .map(|i| generators::scalar_from_entropy(b"multiexp-mask", entropy, i as u32))
            .collect();
        let mask_blinding = generators::scalar_from_entropy(b"multiexp-blinding", entropy, 0);
        let mask_randomizer = generators::scalar_from_entropy(b"multiexp-randomizer", entropy, 0);

        let mask_commitment = basis.commit(&mask, &mask_blinding);
        let mask_ciphertext = offset(
            &weighted_sum(statement.output, &mask),
            &statement.key,
            &mask_randomizer,
        );

        let e = challenge(transcript, statement, &mask_commitment, &mask_ciphertext);

        Self {
            mask_commitment,
            mask_ciphertext,
            response: exponents
                .iter()
                .zip(&mask)
                .map(|(value, mask)| e * value + mask)
                .collect(),
            blinding: e * blinding + mask_blinding,
            randomizer: e * randomizer + mask_randomizer,
        }
    }

    pub fn verify(
        &self,
        transcript: &mut Transcript,
        basis: &Basis,
        statement: &Statement<'_>,
    ) -> Result<(), DealError> {
        if self.response.len() != basis.width() || statement.output.len() != basis.width() {
            return Err(DealError::WrongLength);
        }

        let e = challenge(
            transcript,
            statement,
            &self.mask_commitment,
            &self.mask_ciphertext,
        );

        if basis.commit(&self.response, &self.blinding)
            != statement.commitment * e + self.mask_commitment
        {
            return Err(DealError::BadProof);
        }

        // Σ zᵢ·C'ᵢ − z_ρ·(G, X)  ==  e·(Σ x^j·Cⱼ) + mask
        let left = offset(
            &weighted_sum(statement.output, &self.response),
            &statement.key,
            &self.randomizer,
        );
        let right = Ciphertext {
            c1: statement.input_combination.c1 * e + self.mask_ciphertext.c1,
            c2: statement.input_combination.c2 * e + self.mask_ciphertext.c2,
        };

        if left == right {
            Ok(())
        } else {
            Err(DealError::BadProof)
        }
    }

    pub fn to_bytes(&self) -> Vec<u8> {
        let mut out = Vec::with_capacity(proof_len(self.response.len()));
        put_point(&mut out, &self.mask_commitment);
        put_point(&mut out, &self.mask_ciphertext.c1);
        put_point(&mut out, &self.mask_ciphertext.c2);
        for value in &self.response {
            put_scalar(&mut out, value);
        }
        put_scalar(&mut out, &self.blinding);
        put_scalar(&mut out, &self.randomizer);
        out
    }

    pub fn from_bytes(bytes: &[u8], n: usize) -> Result<Self, DealError> {
        if bytes.len() < proof_len(n) {
            return Err(DealError::Truncated);
        }

        let mask_commitment = point_from_bytes(&bytes[..POINT_LEN])?;
        let mask_ciphertext = Ciphertext::from_bytes(&bytes[POINT_LEN..])?;

        let mut at = POINT_LEN * 3;
        let response = scalars_from_bytes(&bytes[at..], n)?;
        at += n * SCALAR_LEN;

        let blinding = scalar_from_bytes(&bytes[at..])?;
        let randomizer = scalar_from_bytes(&bytes[at + SCALAR_LEN..])?;

        Ok(Self {
            mask_commitment,
            mask_ciphertext,
            response,
            blinding,
            randomizer,
        })
    }
}

/// Subtracts `r·(G, X)` — the re-randomisation a shuffle introduced.
fn offset(ciphertext: &Ciphertext, key: &RistrettoPoint, r: &Scalar) -> Ciphertext {
    Ciphertext {
        c1: ciphertext.c1 - RistrettoPoint::mul_base(r),
        c2: ciphertext.c2 - key * r,
    }
}

fn challenge(
    transcript: &mut Transcript,
    statement: &Statement<'_>,
    mask_commitment: &RistrettoPoint,
    mask_ciphertext: &Ciphertext,
) -> Scalar {
    transcript.absorb_point(b"multiexp-commitment", &statement.commitment);
    transcript.absorb_point(b"multiexp-key", &statement.key);
    transcript.absorb_u32(b"multiexp-n", statement.output.len() as u32);
    for ciphertext in statement.output {
        transcript.absorb_point(b"multiexp-out-c1", &ciphertext.c1);
        transcript.absorb_point(b"multiexp-out-c2", &ciphertext.c2);
    }
    transcript.absorb_point(b"multiexp-in-c1", &statement.input_combination.c1);
    transcript.absorb_point(b"multiexp-in-c2", &statement.input_combination.c2);
    transcript.absorb_point(b"multiexp-mask-commitment", mask_commitment);
    transcript.absorb_point(b"multiexp-mask-c1", &mask_ciphertext.c1);
    transcript.absorb_point(b"multiexp-mask-c2", &mask_ciphertext.c2);
    transcript.challenge(b"multiexp-challenge")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::elgamal::{KeyShare, PublicShare};

    const N: usize = 5;
    const GAME: [u8; 16] = [0x6d; 16];

    fn transcript() -> Transcript {
        Transcript::new(b"multiexp-test", &GAME, 3)
    }

    /// A shuffled deck and everything needed to prove it was shuffled.
    struct Fixture {
        basis: Basis,
        key: RistrettoPoint,
        input: Vec<Ciphertext>,
        output: Vec<Ciphertext>,
        exponents: Vec<Scalar>,
        blinding: Scalar,
        randomizer: Scalar,
        input_combination: Ciphertext,
    }

    impl Fixture {
        /// Shuffles by the reversal permutation, which is enough structure to
        /// catch an argument that ignores order.
        fn new() -> Self {
            let alice = KeyShare::from_wide_bytes(&[0x11; 64]);
            let bob = KeyShare::from_wide_bytes(&[0x22; 64]);
            let key = PublicShare::joint(&alice.public(), &bob.public());

            let input: Vec<Ciphertext> = (0..N)
                .map(|i| Ciphertext::trivial(&generators::tile_point(i as u8 + 1)))
                .collect();

            let permutation: Vec<usize> = (0..N).rev().collect();
            let randomizers: Vec<Scalar> = (0..N).map(|i| Scalar::from(i as u64 * 7 + 3)).collect();

            let output: Vec<Ciphertext> = permutation
                .iter()
                .enumerate()
                .map(|(i, &from)| input[from].rerandomize(&key, &randomizers[i]))
                .collect();

            // x is the challenge the shuffle argument would have drawn; here it
            // is fixed, because this test is about the multi-exponentiation.
            let x = Scalar::from(1337u64);
            let powers: Vec<Scalar> = (0..N)
                .map(|j| {
                    let mut p = x;
                    for _ in 0..j {
                        p *= x;
                    }
                    p
                })
                .collect();

            let exponents: Vec<Scalar> = permutation.iter().map(|&from| powers[from]).collect();
            let randomizer: Scalar = exponents.iter().zip(&randomizers).map(|(b, s)| b * s).sum();

            Self {
                basis: Basis::new(N),
                key,
                input_combination: weighted_sum(&input, &powers),
                input,
                output,
                exponents,
                blinding: Scalar::from(999u64),
                randomizer,
            }
        }

        fn statement(&self) -> Statement<'_> {
            Statement {
                commitment: self.basis.commit(&self.exponents, &self.blinding),
                output: &self.output,
                input_combination: self.input_combination,
                key: self.key,
            }
        }

        fn proof(&self) -> MultiexpProof {
            MultiexpProof::prove(
                &mut transcript(),
                &self.basis,
                &self.statement(),
                &self.exponents,
                &self.blinding,
                &self.randomizer,
                &[0xc3; 32],
            )
        }
    }

    #[test]
    fn an_honest_shuffle_verifies() {
        let f = Fixture::new();

        assert!(
            f.proof()
                .verify(&mut transcript(), &f.basis, &f.statement())
                .is_ok()
        );
    }

    #[test]
    fn a_substituted_output_ciphertext_is_caught() {
        // The attack this exists to stop: prove a real permutation, then
        // publish a deck that is not it.
        let f = Fixture::new();
        let proof = f.proof();

        let mut statement = f.statement();
        let mut tampered = f.output.clone();
        tampered[2] = Ciphertext::trivial(&generators::tile_point(26));
        statement.output = &tampered;

        assert_eq!(
            proof.verify(&mut transcript(), &f.basis, &statement),
            Err(DealError::BadProof)
        );
    }

    #[test]
    fn reordering_the_output_is_caught() {
        let f = Fixture::new();
        let proof = f.proof();

        let mut statement = f.statement();
        let mut swapped = f.output.clone();
        swapped.swap(0, 1);
        statement.output = &swapped;

        assert_eq!(
            proof.verify(&mut transcript(), &f.basis, &statement),
            Err(DealError::BadProof)
        );
    }

    #[test]
    fn a_different_input_deck_is_caught() {
        // A prover must not be able to shuffle one deck and claim it came from
        // another.
        let f = Fixture::new();
        let proof = f.proof();

        let mut statement = f.statement();
        statement.input_combination = weighted_sum(
            &f.input,
            &(0..N)
                .map(|i| Scalar::from(i as u64 + 1))
                .collect::<Vec<_>>(),
        );

        assert_eq!(
            proof.verify(&mut transcript(), &f.basis, &statement),
            Err(DealError::BadProof)
        );
    }

    #[test]
    fn a_mismatched_exponent_commitment_is_caught() {
        let f = Fixture::new();
        let proof = f.proof();

        let mut statement = f.statement();
        statement.commitment = f.basis.commit(&[Scalar::ONE; N], &f.blinding);

        assert_eq!(
            proof.verify(&mut transcript(), &f.basis, &statement),
            Err(DealError::BadProof)
        );
    }

    #[test]
    fn a_tampered_response_is_caught() {
        let f = Fixture::new();
        let mut proof = f.proof();
        proof.response[1] += Scalar::ONE;

        assert_eq!(
            proof.verify(&mut transcript(), &f.basis, &f.statement()),
            Err(DealError::BadProof)
        );
    }

    #[test]
    fn a_forged_randomizer_is_caught() {
        let f = Fixture::new();
        let mut proof = f.proof();
        proof.randomizer += Scalar::ONE;

        assert_eq!(
            proof.verify(&mut transcript(), &f.basis, &f.statement()),
            Err(DealError::BadProof)
        );
    }

    #[test]
    fn every_single_byte_of_the_proof_matters() {
        let f = Fixture::new();
        let bytes = f.proof().to_bytes();

        for i in (0..bytes.len()).step_by(5) {
            let mut mangled = bytes.clone();
            mangled[i] ^= 0x01;

            let refused = match MultiexpProof::from_bytes(&mangled, N) {
                Err(_) => true,
                Ok(proof) => proof
                    .verify(&mut transcript(), &f.basis, &f.statement())
                    .is_err(),
            };

            assert!(refused, "flipping a bit in byte {i} was not noticed");
        }
    }

    #[test]
    fn proofs_survive_a_round_trip_and_have_the_size_claimed() {
        let f = Fixture::new();
        let proof = f.proof();
        let bytes = proof.to_bytes();

        assert_eq!(bytes.len(), proof_len(N));
        assert_eq!(MultiexpProof::from_bytes(&bytes, N).unwrap(), proof);
    }
}
