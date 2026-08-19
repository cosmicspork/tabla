//! Proving that a committed vector multiplies out to a known value.
//!
//! Given `Com(d)` and a public `t`, this proves `∏ dᵢ = t` without revealing
//! `d`. It is the piece that forces a claimed permutation to be a permutation:
//! the shuffle argument arranges matters so that a prover who is *not*
//! permuting has to make a product come out right that will not.
//!
//! The chain is committed rather than proven step by step. The prover publishes
//! `Com(q)` for the running products shifted by one,
//!
//! ```text
//! q₁ = 1,  qᵢ₊₁ = d₁·d₂·…·dᵢ
//! ```
//!
//! so that the whole claim becomes `N` small equations `qᵢ·dᵢ = qᵢ₊₁`, with
//! `q_{N+1}` being the public target `t`. A verifier challenge `w` folds all of
//! them into one — an equation false in any single position survives the fold
//! only with probability `N/|scalar field|` — and a second challenge `w'` folds
//! in `q₁ = 1`, which is what stops a prover from starting the chain wherever
//! it suits them.
//!
//! What is left is exactly one bilinear equation in `q` and `d`, which
//! [`super::bilinear`] proves.

use curve25519_dalek::{RistrettoPoint, Scalar};

use crate::{
    DealError, POINT_LEN, Transcript,
    encoding::{point_from_bytes, put_point},
    generators,
    shuffle::{
        bilinear::{self, BilinearProof, Statement, Witness},
        commit::Basis,
    },
};

#[derive(Clone, PartialEq, Eq, Debug)]
pub struct ProductProof {
    running: RistrettoPoint,
    inner: BilinearProof,
}

/// Serialized size for a vector of length `n`.
pub const fn proof_len(n: usize) -> usize {
    POINT_LEN + bilinear::proof_len(n)
}

impl ProductProof {
    /// `values` is `d`; `blinding` opens the commitment the verifier will build.
    pub fn prove(
        transcript: &mut Transcript,
        basis: &Basis,
        commitment: RistrettoPoint,
        values: &[Scalar],
        blinding: &Scalar,
        entropy: &[u8],
    ) -> Self {
        let n = values.len();

        // q₁ = 1, and each later entry is the product of everything before it.
        let mut running = Vec::with_capacity(n);
        let mut accumulator = Scalar::ONE;
        for value in values.iter().take(n) {
            running.push(accumulator);
            accumulator *= value;
        }
        let target = accumulator;

        let running_blinding = generators::scalar_from_entropy(b"product-blinding", entropy, 0);
        let running_commitment = basis.commit(&running, &running_blinding);

        let (scale, linear, folded) = fold(
            transcript,
            basis,
            &commitment,
            &running_commitment,
            target,
            n,
        );

        let inner = BilinearProof::prove(
            transcript,
            basis,
            &Statement {
                commitment_a: running_commitment,
                commitment_b: commitment,
                scale: &scale,
                linear: &linear,
                target: folded,
            },
            &Witness {
                a: &running,
                blinding_a: running_blinding,
                b: values,
                blinding_b: *blinding,
            },
            entropy,
        );

        Self {
            running: running_commitment,
            inner,
        }
    }

    pub fn verify(
        &self,
        transcript: &mut Transcript,
        basis: &Basis,
        commitment: RistrettoPoint,
        target: Scalar,
    ) -> Result<(), DealError> {
        let n = basis.width();
        let (scale, linear, folded) =
            fold(transcript, basis, &commitment, &self.running, target, n);

        self.inner.verify(
            transcript,
            basis,
            &Statement {
                commitment_a: self.running,
                commitment_b: commitment,
                scale: &scale,
                linear: &linear,
                target: folded,
            },
        )
    }

    pub fn to_bytes(&self) -> Vec<u8> {
        let mut out = Vec::new();
        put_point(&mut out, &self.running);
        out.extend_from_slice(&self.inner.to_bytes());
        out
    }

    pub fn from_bytes(bytes: &[u8], n: usize) -> Result<Self, DealError> {
        if bytes.len() < proof_len(n) {
            return Err(DealError::Truncated);
        }
        Ok(Self {
            running: point_from_bytes(&bytes[..POINT_LEN])?,
            inner: BilinearProof::from_bytes(&bytes[POINT_LEN..], n)?,
        })
    }
}

/// Turns the `N` chain equations plus `q₁ = 1` into one bilinear equation.
///
/// The equation proven is
///
/// ```text
/// ⟨q ∘ w⃗, d⟩ + ⟨w'·e₁ − m, q⟩ = wᴺ·t + w'
/// ```
///
/// where `w⃗ = (w, w², …, wᴺ)` weights the chain steps and `m` carries each
/// `qᵢ₊₁` back to the left-hand side one position down.
fn fold(
    transcript: &mut Transcript,
    basis: &Basis,
    commitment: &RistrettoPoint,
    running: &RistrettoPoint,
    target: Scalar,
    n: usize,
) -> (Vec<Scalar>, Vec<Scalar>, Scalar) {
    transcript.absorb_u32(b"product-n", n as u32);
    transcript.absorb_point(b"product-commitment", commitment);
    transcript.absorb_point(b"product-running", running);
    transcript.absorb_scalar(b"product-target", &target);
    let w = transcript.challenge(b"product-fold");
    let w_one = transcript.challenge(b"product-first");

    debug_assert_eq!(basis.width(), n);

    // wᵢ = w^i, the weight on the i-th chain equation.
    let mut weights = Vec::with_capacity(n);
    let mut power = w;
    for _ in 0..n {
        weights.push(power);
        power *= w;
    }

    // The qᵢ₊₁ terms, shifted down one position; the last one is public.
    let mut linear = vec![Scalar::ZERO; n];
    for i in 1..n {
        linear[i] = -weights[i - 1];
    }
    linear[0] += w_one;

    let folded = weights[n - 1] * target + w_one;

    (weights, linear, folded)
}

#[cfg(test)]
mod tests {
    use super::*;

    const N: usize = 6;
    const GAME: [u8; 16] = [0x91; 16];

    fn transcript() -> Transcript {
        Transcript::new(b"product-test", &GAME, 7)
    }

    fn values() -> Vec<Scalar> {
        (0..N).map(|i| Scalar::from(i as u64 + 2)).collect()
    }

    fn product(values: &[Scalar]) -> Scalar {
        values.iter().product()
    }

    struct Fixture {
        basis: Basis,
        values: Vec<Scalar>,
        blinding: Scalar,
    }

    impl Fixture {
        fn new() -> Self {
            Self {
                basis: Basis::new(N),
                values: values(),
                blinding: Scalar::from(4242u64),
            }
        }

        fn commitment(&self) -> RistrettoPoint {
            self.basis.commit(&self.values, &self.blinding)
        }

        fn proof(&self) -> ProductProof {
            ProductProof::prove(
                &mut transcript(),
                &self.basis,
                self.commitment(),
                &self.values,
                &self.blinding,
                &[0xa1; 32],
            )
        }
    }

    #[test]
    fn the_true_product_verifies() {
        let f = Fixture::new();

        assert!(
            f.proof()
                .verify(
                    &mut transcript(),
                    &f.basis,
                    f.commitment(),
                    product(&f.values)
                )
                .is_ok()
        );
    }

    #[test]
    fn any_other_product_is_refused() {
        let f = Fixture::new();
        let proof = f.proof();

        for wrong in [
            product(&f.values) + Scalar::ONE,
            product(&f.values) - Scalar::ONE,
            Scalar::ZERO,
            product(&f.values) * Scalar::from(2u64),
        ] {
            assert_eq!(
                proof.verify(&mut transcript(), &f.basis, f.commitment(), wrong),
                Err(DealError::BadProof)
            );
        }
    }

    #[test]
    fn a_product_proof_does_not_transfer_to_another_vector() {
        // Same product, different values: the proof is tied to the commitment,
        // not just to the number that comes out of it.
        let f = Fixture::new();
        let mut swapped = f.values.clone();
        swapped.swap(0, 1);
        let other = f.basis.commit(&swapped, &f.blinding);

        assert_eq!(
            f.proof()
                .verify(&mut transcript(), &f.basis, other, product(&f.values)),
            Err(DealError::BadProof)
        );
    }

    #[test]
    fn a_vector_containing_zero_multiplies_to_zero() {
        // Worth pinning: a zero entry annihilates the chain, and the argument
        // has to stay sound rather than degenerate there.
        let basis = Basis::new(N);
        let mut values = values();
        values[3] = Scalar::ZERO;
        let blinding = Scalar::from(7u64);
        let commitment = basis.commit(&values, &blinding);

        let proof = ProductProof::prove(
            &mut transcript(),
            &basis,
            commitment,
            &values,
            &blinding,
            &[0xa1; 32],
        );

        assert!(
            proof
                .verify(&mut transcript(), &basis, commitment, Scalar::ZERO)
                .is_ok()
        );
        assert_eq!(
            proof.verify(&mut transcript(), &basis, commitment, Scalar::ONE),
            Err(DealError::BadProof)
        );
    }

    #[test]
    fn a_forged_chain_commitment_is_refused() {
        // The attack this rules out: starting the running product somewhere
        // other than 1, which would let any target be reached.
        let f = Fixture::new();
        let mut proof = f.proof();
        proof.running = f.basis.commit(&values(), &Scalar::from(5u64));

        assert_eq!(
            proof.verify(
                &mut transcript(),
                &f.basis,
                f.commitment(),
                product(&f.values)
            ),
            Err(DealError::BadProof)
        );
    }

    #[test]
    fn proofs_survive_a_round_trip_and_have_the_size_claimed() {
        let f = Fixture::new();
        let proof = f.proof();
        let bytes = proof.to_bytes();

        assert_eq!(bytes.len(), proof_len(N));
        assert_eq!(ProductProof::from_bytes(&bytes, N).unwrap(), proof);
    }
}
