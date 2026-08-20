//! The public points everything else is measured against.
//!
//! Pedersen commitments bind only because nobody knows the discrete logarithm
//! relating one generator to another: a prover who knew `x` with `h = x·g`
//! could open a commitment to any value they liked, and every soundness claim
//! in this crate would collapse. So none of these points is chosen. Each is the
//! image of a fixed string under hash-to-group, which nobody can steer, and
//! recomputing them from the strings below is the whole audit.
//!
//! `RistrettoPoint::from_uniform_bytes` is used rather than the crate's own
//! `hash_from_bytes` so the hashing is visible here: SHA-512 of a
//! domain-tagged label, mapped into the group by Elligator.

use curve25519_dalek::{RistrettoPoint, Scalar, constants::RISTRETTO_BASEPOINT_POINT};
use sha2::{Digest, Sha512};

/// Domain tag for every generator derived in this module.
const GENERATOR_DOMAIN: &[u8] = b"tabla-deal/generator/v1";
/// Domain tag for the tile plaintext points.
const TILE_DOMAIN: &[u8] = b"tabla-deal/tile/v1";

/// The group generator. Public keys are `x·G`.
pub fn g() -> RistrettoPoint {
    RISTRETTO_BASEPOINT_POINT
}

/// The blinding generator for Pedersen commitments.
///
/// Nobody knows `log_G(H)`, which is what makes a commitment binding.
pub fn h() -> RistrettoPoint {
    derive(b"pedersen-blinding")
}

/// The message generators for a Pedersen vector commitment of width `n`.
///
/// Independent of each other and of `H` for the same reason, and derived by
/// index so both sides compute the same list without exchanging it.
pub fn commitment_generators(n: usize) -> Vec<RistrettoPoint> {
    (0..n)
        .map(|i| {
            let mut label = b"pedersen-message-".to_vec();
            label.extend_from_slice(&(i as u32).to_le_bytes());
            derive(&label)
        })
        .collect()
}

/// The plaintext point standing for a tile of kind `k`.
///
/// Every copy of the same letter — and both blanks — encrypts the *same* point.
/// That leaks nothing: re-randomised ElGamal ciphertexts of equal plaintexts
/// are indistinguishable without the key, and the shuffle argument is zero
/// knowledge, so neither the deck nor its proofs reveal which positions hold
/// equal tiles. Only opening does, which is the point of opening.
pub fn tile_point(kind: u8) -> RistrettoPoint {
    let mut hasher = Sha512::new();
    hasher.update(TILE_DOMAIN);
    hasher.update([kind]);
    let digest: [u8; 64] = hasher.finalize().into();
    RistrettoPoint::from_uniform_bytes(&digest)
}

/// Maps an opened plaintext point back to a tile kind.
///
/// A linear scan over the 27 possible kinds. There is no arithmetic shortcut —
/// that is exactly the discrete logarithm — and 27 comparisons are nothing.
pub fn tile_of(point: &RistrettoPoint, kinds: u8) -> Option<u8> {
    (0..kinds).find(|&kind| tile_point(kind) == *point)
}

/// Expands caller-supplied entropy into a scalar, domain-separated by `label`.
///
/// The one place randomness enters this crate, and it enters as an argument.
pub fn scalar_from_entropy(label: &[u8], entropy: &[u8], index: u32) -> Scalar {
    let mut hasher = Sha512::new();
    hasher.update(b"tabla-deal/rng/v1");
    hasher.update((label.len() as u64).to_le_bytes());
    hasher.update(label);
    hasher.update(index.to_le_bytes());
    hasher.update(entropy);
    let digest: [u8; 64] = hasher.finalize().into();
    Scalar::from_bytes_mod_order_wide(&digest)
}

fn derive(label: &[u8]) -> RistrettoPoint {
    let mut hasher = Sha512::new();
    hasher.update(GENERATOR_DOMAIN);
    hasher.update((label.len() as u64).to_le_bytes());
    hasher.update(label);
    let digest: [u8; 64] = hasher.finalize().into();
    RistrettoPoint::from_uniform_bytes(&digest)
}

#[cfg(test)]
mod tests {
    use super::*;

    const KINDS: u8 = 27;

    #[test]
    fn generators_are_stable() {
        assert_eq!(h(), h());
        assert_eq!(commitment_generators(4), commitment_generators(4));
    }

    #[test]
    fn generators_are_distinct_from_each_other_and_the_base() {
        let mut all = vec![g(), h()];
        all.extend(commitment_generators(8));

        for (i, x) in all.iter().enumerate() {
            for y in &all[i + 1..] {
                assert_ne!(x, y);
            }
        }
    }

    #[test]
    fn a_wider_commitment_extends_the_same_list() {
        // Generators are derived by index, so widening a commitment must not
        // renumber the ones already in use.
        let narrow = commitment_generators(4);
        let wide = commitment_generators(9);

        assert_eq!(narrow[..], wide[..4]);
    }

    #[test]
    fn every_tile_kind_has_its_own_point() {
        let points: Vec<_> = (0..KINDS).map(tile_point).collect();

        for (i, x) in points.iter().enumerate() {
            for y in &points[i + 1..] {
                assert_ne!(x, y);
            }
        }
    }

    #[test]
    fn tile_points_decode_back_to_their_kind() {
        for kind in 0..KINDS {
            assert_eq!(tile_of(&tile_point(kind), KINDS), Some(kind));
        }
    }

    #[test]
    fn a_point_that_is_not_a_tile_decodes_to_nothing() {
        assert_eq!(tile_of(&g(), KINDS), None);
        assert_eq!(tile_of(&tile_point(KINDS), KINDS), None);
    }

    #[test]
    fn entropy_expands_differently_per_label_and_index() {
        let entropy = [0x11; 32];
        let a = scalar_from_entropy(b"perm", &entropy, 0);
        let b = scalar_from_entropy(b"blind", &entropy, 0);
        let c = scalar_from_entropy(b"perm", &entropy, 1);
        let d = scalar_from_entropy(b"perm", &[0x22; 32], 0);

        assert_ne!(a, b);
        assert_ne!(a, c);
        assert_ne!(a, d);
        assert_eq!(a, scalar_from_entropy(b"perm", &entropy, 0));
    }
}
