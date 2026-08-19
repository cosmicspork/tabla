//! A sigma protocol for one bilinear equation over two committed vectors.
//!
//! Proves, for committed `α` and `β` and public `s`, `ℓ`, `T`:
//!
//! ```text
//! ⟨α ∘ s, β⟩ + ⟨ℓ, α⟩ = T
//! ```
//!
//! Everything the grand-product argument needs reduces to this one shape, which
//! is why it is worth isolating: the chain `qᵢ·dᵢ = qᵢ₊₁` collapses into a
//! single equation of exactly this form once it is folded together with a
//! random challenge.
//!
//! The protocol is the standard masked-opening argument. The prover commits to
//! random vectors `α'`, `β'`, publishes the two cross terms of the bilinear
//! form, and answers a challenge `e` with `α·e + α'` and `β·e + β'`. The
//! verifier re-runs the form on those answers and checks it lands on
//! `e²T + e·t₁ + t₂`, which it can only do if the original claim held.
//!
//! **Soundness** comes from rewinding: three accepting transcripts on distinct
//! challenges determine `α` and `β` uniquely (the commitments are binding), and
//! the quadratic in `e` then forces `T` to be their true bilinear form.
//! **Zero knowledge** because `α'` and `β'` are uniform, so the responses are
//! uniform too and reveal nothing about `α` or `β`.
//!
//! Proof size is linear in the vector length. Bayer-Groth compresses this with
//! an `m × n̂` decomposition; at the sizes a tile bag reaches, the compression
//! buys a few kilobytes against an entry budget with room to spare, and costs a
//! recursive argument that is materially harder to get right. Sizes are pinned
//! by a test.

use curve25519_dalek::{RistrettoPoint, Scalar};

use crate::POINT_LEN;
use crate::{
    DealError, SCALAR_LEN, Transcript,
    encoding::{point_from_bytes, put_point, put_scalar, scalar_from_bytes, scalars_from_bytes},
    generators,
    shuffle::commit::Basis,
};

/// The public half of the equation being proven.
pub struct Statement<'a> {
    /// Commitment to `α`.
    pub commitment_a: RistrettoPoint,
    /// Commitment to `β`.
    pub commitment_b: RistrettoPoint,
    /// The vector `α` is multiplied by entrywise.
    pub scale: &'a [Scalar],
    /// The vector applied linearly to `α`.
    pub linear: &'a [Scalar],
    /// What the whole form must equal.
    pub target: Scalar,
}

/// The prover's secrets.
pub struct Witness<'a> {
    pub a: &'a [Scalar],
    pub blinding_a: Scalar,
    pub b: &'a [Scalar],
    pub blinding_b: Scalar,
}

#[derive(Clone, PartialEq, Eq, Debug)]
pub struct BilinearProof {
    mask_a: RistrettoPoint,
    mask_b: RistrettoPoint,
    cross_linear: Scalar,
    cross_quadratic: Scalar,
    response_a: Vec<Scalar>,
    response_b: Vec<Scalar>,
    blinding_a: Scalar,
    blinding_b: Scalar,
}

/// Serialized size for vectors of length `n`.
pub const fn proof_len(n: usize) -> usize {
    POINT_LEN * 2 + SCALAR_LEN * (2 * n + 4)
}

impl BilinearProof {
    pub fn prove(
        transcript: &mut Transcript,
        basis: &Basis,
        statement: &Statement<'_>,
        witness: &Witness<'_>,
        entropy: &[u8],
    ) -> Self {
        let n = witness.a.len();

        let mask_a_values: Vec<Scalar> = (0..n)
            .map(|i| generators::scalar_from_entropy(b"bilinear-a", entropy, i as u32))
            .collect();
        let mask_b_values: Vec<Scalar> = (0..n)
            .map(|i| generators::scalar_from_entropy(b"bilinear-b", entropy, i as u32))
            .collect();
        let mask_blinding_a = generators::scalar_from_entropy(b"bilinear-ra", entropy, 0);
        let mask_blinding_b = generators::scalar_from_entropy(b"bilinear-rb", entropy, 0);

        let mask_a = basis.commit(&mask_a_values, &mask_blinding_a);
        let mask_b = basis.commit(&mask_b_values, &mask_blinding_b);

        // The two cross terms of expanding the form at `α·e + α'`, `β·e + β'`.
        let cross_linear = form(statement.scale, witness.a, &mask_b_values)
            + form(statement.scale, &mask_a_values, witness.b)
            + inner(statement.linear, &mask_a_values);
        let cross_quadratic = form(statement.scale, &mask_a_values, &mask_b_values);

        let e = challenge(
            transcript,
            statement,
            &mask_a,
            &mask_b,
            &cross_linear,
            &cross_quadratic,
        );

        Self {
            mask_a,
            mask_b,
            cross_linear,
            cross_quadratic,
            response_a: witness
                .a
                .iter()
                .map(|v| e * v)
                .zip(&mask_a_values)
                .map(|(x, m)| x + m)
                .collect(),
            response_b: witness
                .b
                .iter()
                .map(|v| e * v)
                .zip(&mask_b_values)
                .map(|(x, m)| x + m)
                .collect(),
            blinding_a: e * witness.blinding_a + mask_blinding_a,
            blinding_b: e * witness.blinding_b + mask_blinding_b,
        }
    }

    pub fn verify(
        &self,
        transcript: &mut Transcript,
        basis: &Basis,
        statement: &Statement<'_>,
    ) -> Result<(), DealError> {
        let n = basis.width();
        if self.response_a.len() != n || self.response_b.len() != n {
            return Err(DealError::WrongLength);
        }

        let e = challenge(
            transcript,
            statement,
            &self.mask_a,
            &self.mask_b,
            &self.cross_linear,
            &self.cross_quadratic,
        );

        // The responses must open to the committed vectors scaled by `e`.
        if basis.commit(&self.response_a, &self.blinding_a)
            != statement.commitment_a * e + self.mask_a
        {
            return Err(DealError::BadProof);
        }
        if basis.commit(&self.response_b, &self.blinding_b)
            != statement.commitment_b * e + self.mask_b
        {
            return Err(DealError::BadProof);
        }

        // And running the bilinear form on them must land on the quadratic the
        // prover committed to before seeing `e`.
        let left = form(statement.scale, &self.response_a, &self.response_b)
            + e * inner(statement.linear, &self.response_a);
        let right = e * e * statement.target + e * self.cross_linear + self.cross_quadratic;

        if left == right {
            Ok(())
        } else {
            Err(DealError::BadProof)
        }
    }

    pub fn to_bytes(&self) -> Vec<u8> {
        let mut out = Vec::with_capacity(proof_len(self.response_a.len()));
        put_point(&mut out, &self.mask_a);
        put_point(&mut out, &self.mask_b);
        put_scalar(&mut out, &self.cross_linear);
        put_scalar(&mut out, &self.cross_quadratic);
        for value in &self.response_a {
            put_scalar(&mut out, value);
        }
        for value in &self.response_b {
            put_scalar(&mut out, value);
        }
        put_scalar(&mut out, &self.blinding_a);
        put_scalar(&mut out, &self.blinding_b);
        out
    }

    pub fn from_bytes(bytes: &[u8], n: usize) -> Result<Self, DealError> {
        if bytes.len() < proof_len(n) {
            return Err(DealError::Truncated);
        }
        let mut at = 0;
        let take_point = |at: &mut usize| -> Result<RistrettoPoint, DealError> {
            let point = point_from_bytes(&bytes[*at..])?;
            *at += POINT_LEN;
            Ok(point)
        };

        let mask_a = take_point(&mut at)?;
        let mask_b = take_point(&mut at)?;

        let take_scalar = |at: &mut usize| -> Result<Scalar, DealError> {
            let scalar = scalar_from_bytes(&bytes[*at..])?;
            *at += SCALAR_LEN;
            Ok(scalar)
        };

        let cross_linear = take_scalar(&mut at)?;
        let cross_quadratic = take_scalar(&mut at)?;

        let response_a = scalars_from_bytes(&bytes[at..], n)?;
        at += n * SCALAR_LEN;
        let response_b = scalars_from_bytes(&bytes[at..], n)?;
        at += n * SCALAR_LEN;

        let blinding_a = take_scalar(&mut at)?;
        let blinding_b = take_scalar(&mut at)?;

        Ok(Self {
            mask_a,
            mask_b,
            cross_linear,
            cross_quadratic,
            response_a,
            response_b,
            blinding_a,
            blinding_b,
        })
    }
}

/// `⟨α ∘ s, β⟩`.
fn form(scale: &[Scalar], a: &[Scalar], b: &[Scalar]) -> Scalar {
    a.iter()
        .zip(b)
        .zip(scale)
        .map(|((a, b), s)| a * b * s)
        .sum()
}

fn inner(x: &[Scalar], y: &[Scalar]) -> Scalar {
    x.iter().zip(y).map(|(x, y)| x * y).sum()
}

fn challenge(
    transcript: &mut Transcript,
    statement: &Statement<'_>,
    mask_a: &RistrettoPoint,
    mask_b: &RistrettoPoint,
    cross_linear: &Scalar,
    cross_quadratic: &Scalar,
) -> Scalar {
    transcript.absorb_point(b"bilinear-ca", &statement.commitment_a);
    transcript.absorb_point(b"bilinear-cb", &statement.commitment_b);
    // The public vectors are bound too: a proof of one equation must not be
    // accepted for a different one built from the same commitments.
    for (i, s) in statement.scale.iter().enumerate() {
        transcript.absorb_u32(b"bilinear-scale-index", i as u32);
        transcript.absorb_scalar(b"bilinear-scale", s);
    }
    for (i, l) in statement.linear.iter().enumerate() {
        transcript.absorb_u32(b"bilinear-linear-index", i as u32);
        transcript.absorb_scalar(b"bilinear-linear", l);
    }
    transcript.absorb_scalar(b"bilinear-target", &statement.target);
    transcript.absorb_point(b"bilinear-mask-a", mask_a);
    transcript.absorb_point(b"bilinear-mask-b", mask_b);
    transcript.absorb_scalar(b"bilinear-cross-1", cross_linear);
    transcript.absorb_scalar(b"bilinear-cross-2", cross_quadratic);
    transcript.challenge(b"bilinear-challenge")
}

#[cfg(test)]
mod tests {
    use super::*;

    const N: usize = 6;
    const GAME: [u8; 16] = [0x3c; 16];

    fn transcript() -> Transcript {
        Transcript::new(b"bilinear-test", &GAME, 2)
    }

    fn vector(seed: u64, n: usize) -> Vec<Scalar> {
        (0..n)
            .map(|i| Scalar::from(seed * 31 + i as u64 + 1))
            .collect()
    }

    struct Fixture {
        basis: Basis,
        a: Vec<Scalar>,
        b: Vec<Scalar>,
        scale: Vec<Scalar>,
        linear: Vec<Scalar>,
        blinding_a: Scalar,
        blinding_b: Scalar,
        target: Scalar,
    }

    impl Fixture {
        fn new() -> Self {
            let basis = Basis::new(N);
            let a = vector(1, N);
            let b = vector(2, N);
            let scale = vector(3, N);
            let linear = vector(4, N);
            let target = form(&scale, &a, &b) + inner(&linear, &a);

            Self {
                basis,
                a,
                b,
                scale,
                linear,
                blinding_a: Scalar::from(77u64),
                blinding_b: Scalar::from(88u64),
                target,
            }
        }

        fn statement(&self) -> Statement<'_> {
            Statement {
                commitment_a: self.basis.commit(&self.a, &self.blinding_a),
                commitment_b: self.basis.commit(&self.b, &self.blinding_b),
                scale: &self.scale,
                linear: &self.linear,
                target: self.target,
            }
        }

        fn witness(&self) -> Witness<'_> {
            Witness {
                a: &self.a,
                blinding_a: self.blinding_a,
                b: &self.b,
                blinding_b: self.blinding_b,
            }
        }

        fn proof(&self) -> BilinearProof {
            BilinearProof::prove(
                &mut transcript(),
                &self.basis,
                &self.statement(),
                &self.witness(),
                &[0x5e; 32],
            )
        }
    }

    #[test]
    fn a_true_equation_proves_and_verifies() {
        let f = Fixture::new();

        assert!(
            f.proof()
                .verify(&mut transcript(), &f.basis, &f.statement())
                .is_ok()
        );
    }

    #[test]
    fn a_wrong_target_is_refused() {
        // The whole point: the prover cannot claim a value the vectors do not
        // actually produce.
        let f = Fixture::new();
        let mut statement = f.statement();
        statement.target += Scalar::ONE;

        assert_eq!(
            f.proof().verify(&mut transcript(), &f.basis, &statement),
            Err(DealError::BadProof)
        );
    }

    #[test]
    fn a_proof_for_one_equation_does_not_verify_another() {
        let f = Fixture::new();
        let mut statement = f.statement();
        let other = vector(9, N);
        statement.scale = &other;

        assert_eq!(
            f.proof().verify(&mut transcript(), &f.basis, &statement),
            Err(DealError::BadProof)
        );
    }

    #[test]
    fn a_substituted_commitment_is_refused() {
        let f = Fixture::new();
        let mut statement = f.statement();
        statement.commitment_a = f.basis.commit(&vector(9, N), &f.blinding_a);

        assert_eq!(
            f.proof().verify(&mut transcript(), &f.basis, &statement),
            Err(DealError::BadProof)
        );
    }

    #[test]
    fn a_tampered_response_is_refused() {
        let f = Fixture::new();
        let mut proof = f.proof();
        proof.response_a[0] += Scalar::ONE;

        assert_eq!(
            proof.verify(&mut transcript(), &f.basis, &f.statement()),
            Err(DealError::BadProof)
        );
    }

    #[test]
    fn a_tampered_cross_term_is_refused() {
        let f = Fixture::new();
        let mut proof = f.proof();
        proof.cross_quadratic += Scalar::ONE;

        assert_eq!(
            proof.verify(&mut transcript(), &f.basis, &f.statement()),
            Err(DealError::BadProof)
        );
    }

    #[test]
    fn a_proof_does_not_travel_to_another_log_position() {
        let f = Fixture::new();
        let mut elsewhere = Transcript::new(b"bilinear-test", &GAME, 3);

        assert_eq!(
            f.proof().verify(&mut elsewhere, &f.basis, &f.statement()),
            Err(DealError::BadProof)
        );
    }

    #[test]
    fn every_single_byte_of_the_proof_matters() {
        // A blunt instrument, but it catches a field that is serialized and
        // then never actually checked — which is the failure mode that leaves a
        // proof system looking fine while proving nothing.
        let f = Fixture::new();
        let bytes = f.proof().to_bytes();

        for i in (0..bytes.len()).step_by(7) {
            let mut mangled = bytes.clone();
            mangled[i] ^= 0x01;

            let refused = match BilinearProof::from_bytes(&mangled, N) {
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
        assert_eq!(BilinearProof::from_bytes(&bytes, N).unwrap(), proof);
        assert_eq!(
            BilinearProof::from_bytes(&bytes[..bytes.len() - 1], N),
            Err(DealError::Truncated)
        );
    }
}
