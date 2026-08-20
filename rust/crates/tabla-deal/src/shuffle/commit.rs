//! Pedersen vector commitments.
//!
//! `Com(v; r) = r·H + Σ vᵢ·Gᵢ`. Hiding because `r` is uniform, and binding
//! because opening one commitment two ways would yield a discrete-logarithm
//! relation among generators nobody chose — see [`crate::generators`], where
//! that independence is established and tested.
//!
//! Linear in both arguments, which is what lets a verifier build the
//! commitment to a derived vector — `y·a + b − z·1`, say — out of commitments
//! it was already given, without the prover sending anything more.

use curve25519_dalek::{RistrettoPoint, Scalar, traits::VartimeMultiscalarMul};

use crate::generators;

/// The generators for commitments of width `n`, computed once per proof.
pub struct Basis {
    pub blinding: RistrettoPoint,
    pub message: Vec<RistrettoPoint>,
}

impl Basis {
    pub fn new(n: usize) -> Self {
        Self {
            blinding: generators::h(),
            message: generators::commitment_generators(n),
        }
    }

    pub fn width(&self) -> usize {
        self.message.len()
    }

    /// `Com(values; blinding)`.
    pub fn commit(&self, values: &[Scalar], blinding: &Scalar) -> RistrettoPoint {
        debug_assert_eq!(values.len(), self.message.len());

        let scalars = core::iter::once(*blinding).chain(values.iter().copied());
        let points = core::iter::once(self.blinding).chain(self.message.iter().copied());
        RistrettoPoint::vartime_multiscalar_mul(scalars, points)
    }

    /// `Σ Gᵢ`, the commitment to the all-ones vector with no blinding.
    ///
    /// Used to subtract a constant from every entry of a committed vector.
    pub fn sum_of_generators(&self) -> RistrettoPoint {
        self.message.iter().sum()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn values(n: usize) -> Vec<Scalar> {
        (0..n).map(|i| Scalar::from(i as u64 + 1)).collect()
    }

    #[test]
    fn a_commitment_is_reproducible() {
        let basis = Basis::new(4);
        let r = Scalar::from(9u64);

        assert_eq!(basis.commit(&values(4), &r), basis.commit(&values(4), &r));
    }

    #[test]
    fn changing_a_value_changes_the_commitment() {
        let basis = Basis::new(4);
        let r = Scalar::from(9u64);
        let mut other = values(4);
        other[2] += Scalar::ONE;

        assert_ne!(basis.commit(&values(4), &r), basis.commit(&other, &r));
    }

    #[test]
    fn changing_the_blinding_changes_the_commitment() {
        let basis = Basis::new(4);

        assert_ne!(
            basis.commit(&values(4), &Scalar::from(9u64)),
            basis.commit(&values(4), &Scalar::from(10u64)),
        );
    }

    #[test]
    fn reordering_values_changes_the_commitment() {
        // Position matters: each entry has its own generator, which is what
        // makes a commitment to a permutation mean anything.
        let basis = Basis::new(4);
        let r = Scalar::from(9u64);
        let mut swapped = values(4);
        swapped.swap(0, 3);

        assert_ne!(basis.commit(&values(4), &r), basis.commit(&swapped, &r));
    }

    #[test]
    fn commitments_add_the_way_the_verifier_needs() {
        // The verifier never receives a commitment to `y·a + b − z·1`; it
        // builds one from the commitments to `a` and `b`. This is that
        // arithmetic, and it has to hold exactly.
        let basis = Basis::new(4);
        let a = values(4);
        let b: Vec<Scalar> = values(4).iter().map(|v| v * Scalar::from(7u64)).collect();
        let (ra, rb) = (Scalar::from(3u64), Scalar::from(5u64));
        let y = Scalar::from(11u64);
        let z = Scalar::from(13u64);

        let d: Vec<Scalar> = a.iter().zip(&b).map(|(a, b)| y * a + b - z).collect();
        let rd = y * ra + rb;

        let derived =
            basis.commit(&a, &ra) * y + basis.commit(&b, &rb) - basis.sum_of_generators() * z;

        assert_eq!(basis.commit(&d, &rd), derived);
    }
}
