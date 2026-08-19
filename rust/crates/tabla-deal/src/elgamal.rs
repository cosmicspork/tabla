//! Threshold ElGamal for two players, neither of whom can decrypt alone.
//!
//! Each player holds a secret share `x_P` and publishes `X_P = x_P·G`. The deck
//! is encrypted under the sum `X = X_I + X_C`, so opening a ciphertext needs a
//! contribution from both — which is the entire mechanism by which a tile can
//! be hidden from someone who is holding the device it will be dealt to.
//!
//! A ciphertext is `(c1, c2) = (r·G, M + r·X)`. Its two useful operations:
//!
//! **Re-randomisation.** Adding `s·G` to `c1` and `s·X` to `c2` produces a
//! ciphertext of the same plaintext that cannot be linked to the original
//! without the key. This is what makes a shuffle a shuffle rather than a
//! visible reordering.
//!
//! **Partial decryption.** A player publishes `d = x_P·c1`. Subtracting both
//! players' shares from `c2` leaves `M`. A share is useless on its own and
//! reveals nothing about `x_P` beyond what `X_P` already does — but the
//! recipient must be sure it was computed with the *right* `x_P`, which is what
//! the DLEQ proof accompanying every share is for.

use curve25519_dalek::{RistrettoPoint, Scalar, traits::Identity};
use zeroize::Zeroize;

use crate::{
    CIPHERTEXT_LEN, DealError, POINT_LEN, Transcript,
    encoding::{point_from_bytes, scalar_from_bytes},
    proofs::{EqualityProof, KnowledgeProof},
};

/// One player's secret contribution to the joint key.
///
/// Derived per game from the identity seed, never stored and never sent. It is
/// zeroed on drop out of habit rather than necessity: it can be recomputed at
/// will, so losing it is harmless and leaking it is not.
#[derive(Clone)]
pub struct KeyShare {
    secret: Scalar,
}

impl Drop for KeyShare {
    fn drop(&mut self) {
        self.secret.zeroize();
    }
}

impl KeyShare {
    /// Reduces 64 bytes of key material into a share.
    ///
    /// Wide reduction rather than a 32-byte scalar so the result is uniform;
    /// the caller supplies HKDF output derived from their identity.
    pub fn from_wide_bytes(bytes: &[u8; 64]) -> Self {
        Self {
            secret: Scalar::from_bytes_mod_order_wide(bytes),
        }
    }

    /// The public half, which the other player needs.
    pub fn public(&self) -> PublicShare {
        PublicShare(RistrettoPoint::mul_base(&self.secret))
    }

    /// This player's decryption contribution for one ciphertext.
    ///
    /// Useless on its own — see [`Ciphertext::open`] — and never published
    /// without the proof that comes with it.
    pub fn decryption_share(&self, ciphertext: &Ciphertext) -> RistrettoPoint {
        ciphertext.c1 * self.secret
    }

    /// Proof that this share's public half is one we can actually open.
    ///
    /// Published alongside the share itself. Without it a player could name a
    /// public key chosen so that the *sum* of the two lands wherever they like,
    /// and control a deck both players believe is jointly keyed.
    pub fn prove_knowledge(&self, transcript: &mut Transcript, entropy: &[u8]) -> KnowledgeProof {
        KnowledgeProof::prove(transcript, &self.secret, entropy)
    }

    /// A decryption share together with the proof that it is the right one.
    ///
    /// The only way a share leaves this type. A bare share is unverifiable, and
    /// a wrong one opens a tile to nonsense that would otherwise look exactly
    /// like an honest mistake, so the two always travel together.
    pub fn proven_share(
        &self,
        transcript: &mut Transcript,
        ciphertext: &Ciphertext,
        entropy: &[u8],
        index: u32,
    ) -> (RistrettoPoint, EqualityProof) {
        let share = self.decryption_share(ciphertext);
        let proof = EqualityProof::prove(transcript, &self.secret, &ciphertext.c1, entropy, index);
        (share, proof)
    }
}

/// A player's public key share.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct PublicShare(pub RistrettoPoint);

impl PublicShare {
    pub fn to_bytes(self) -> [u8; POINT_LEN] {
        self.0.compress().to_bytes()
    }

    pub fn from_bytes(bytes: &[u8]) -> Result<Self, DealError> {
        Ok(Self(point_from_bytes(bytes)?))
    }

    /// The joint key both players encrypt to.
    pub fn joint(a: &Self, b: &Self) -> RistrettoPoint {
        a.0 + b.0
    }
}

/// An ElGamal ciphertext under the joint key.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct Ciphertext {
    pub c1: RistrettoPoint,
    pub c2: RistrettoPoint,
}

impl Ciphertext {
    /// Encrypts a plaintext point with randomness `r`.
    pub fn encrypt(joint_key: &RistrettoPoint, message: &RistrettoPoint, r: &Scalar) -> Self {
        Self {
            c1: RistrettoPoint::mul_base(r),
            c2: message + joint_key * r,
        }
    }

    /// A ciphertext everyone can compute: no randomness, plaintext in the open.
    ///
    /// The starting deck is built this way. It costs no bytes on the wire and
    /// nothing is hidden yet — the first shuffle is what hides it.
    pub fn trivial(message: &RistrettoPoint) -> Self {
        Self {
            c1: RistrettoPoint::identity(),
            c2: *message,
        }
    }

    /// A fresh ciphertext of the same plaintext, unlinkable to this one.
    pub fn rerandomize(&self, joint_key: &RistrettoPoint, s: &Scalar) -> Self {
        Self {
            c1: self.c1 + RistrettoPoint::mul_base(s),
            c2: self.c2 + joint_key * s,
        }
    }

    /// Recovers the plaintext from both players' decryption shares.
    pub fn open(&self, shares: [&RistrettoPoint; 2]) -> RistrettoPoint {
        self.c2 - shares[0] - shares[1]
    }

    pub fn to_bytes(self) -> [u8; CIPHERTEXT_LEN] {
        let mut out = [0u8; CIPHERTEXT_LEN];
        out[..POINT_LEN].copy_from_slice(self.c1.compress().as_bytes());
        out[POINT_LEN..].copy_from_slice(self.c2.compress().as_bytes());
        out
    }

    pub fn from_bytes(bytes: &[u8]) -> Result<Self, DealError> {
        if bytes.len() < CIPHERTEXT_LEN {
            return Err(DealError::Truncated);
        }
        Ok(Self {
            c1: point_from_bytes(&bytes[..POINT_LEN])?,
            c2: point_from_bytes(&bytes[POINT_LEN..CIPHERTEXT_LEN])?,
        })
    }
}

/// Multiplies a ciphertext by a scalar, componentwise.
///
/// Needed by the multi-exponentiation argument: a weighted product of
/// ciphertexts is itself a ciphertext of the weighted product of plaintexts.
pub fn scale(ciphertext: &Ciphertext, k: &Scalar) -> Ciphertext {
    Ciphertext {
        c1: ciphertext.c1 * k,
        c2: ciphertext.c2 * k,
    }
}

/// Componentwise sum of ciphertexts.
pub fn sum(ciphertexts: &[Ciphertext]) -> Ciphertext {
    ciphertexts.iter().fold(
        Ciphertext {
            c1: RistrettoPoint::identity(),
            c2: RistrettoPoint::identity(),
        },
        |acc, c| Ciphertext {
            c1: acc.c1 + c.c1,
            c2: acc.c2 + c.c2,
        },
    )
}

/// The weighted product `∏ cᵢ^{kᵢ}`, written additively.
pub fn weighted_sum(ciphertexts: &[Ciphertext], weights: &[Scalar]) -> Ciphertext {
    let terms: Vec<Ciphertext> = ciphertexts
        .iter()
        .zip(weights)
        .map(|(c, k)| scale(c, k))
        .collect();
    sum(&terms)
}

/// Reads a scalar written by the caller, rejecting non-canonical encodings.
pub fn parse_scalar(bytes: &[u8]) -> Result<Scalar, DealError> {
    scalar_from_bytes(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::generators;

    fn shares() -> (KeyShare, KeyShare) {
        (
            KeyShare::from_wide_bytes(&[0x11; 64]),
            KeyShare::from_wide_bytes(&[0x22; 64]),
        )
    }

    fn joint(a: &KeyShare, b: &KeyShare) -> RistrettoPoint {
        PublicShare::joint(&a.public(), &b.public())
    }

    #[test]
    fn both_shares_together_recover_the_plaintext() {
        let (alice, bob) = shares();
        let key = joint(&alice, &bob);
        let message = generators::tile_point(5);

        let ciphertext = Ciphertext::encrypt(&key, &message, &Scalar::from(99u64));
        let opened = ciphertext.open([
            &alice.decryption_share(&ciphertext),
            &bob.decryption_share(&ciphertext),
        ]);

        assert_eq!(opened, message);
    }

    #[test]
    fn one_share_alone_recovers_nothing() {
        // The property the whole deal rests on: a player holding a ciphertext
        // and their own key learns nothing without the opponent.
        let (alice, bob) = shares();
        let key = joint(&alice, &bob);
        let message = generators::tile_point(5);

        let ciphertext = Ciphertext::encrypt(&key, &message, &Scalar::from(99u64));
        let half = ciphertext.c2 - alice.decryption_share(&ciphertext);

        assert_ne!(half, message);
        assert_eq!(generators::tile_of(&half, 27), None);
    }

    #[test]
    fn a_trivial_ciphertext_opens_to_its_plaintext() {
        let (alice, bob) = shares();
        let message = generators::tile_point(3);

        let ciphertext = Ciphertext::trivial(&message);
        let opened = ciphertext.open([
            &alice.decryption_share(&ciphertext),
            &bob.decryption_share(&ciphertext),
        ]);

        assert_eq!(opened, message);
    }

    #[test]
    fn rerandomizing_changes_the_ciphertext_but_not_the_tile() {
        let (alice, bob) = shares();
        let key = joint(&alice, &bob);
        let message = generators::tile_point(7);

        let original = Ciphertext::trivial(&message);
        let fresh = original.rerandomize(&key, &Scalar::from(1234u64));

        assert_ne!(original, fresh);
        let opened = fresh.open([
            &alice.decryption_share(&fresh),
            &bob.decryption_share(&fresh),
        ]);
        assert_eq!(opened, message);
    }

    #[test]
    fn two_copies_of_one_tile_are_indistinguishable_once_rerandomized() {
        // Both blanks, and every repeated letter, encrypt to the same point.
        // After re-randomisation the ciphertexts differ, so the deck does not
        // announce which positions hold equal tiles.
        let (alice, bob) = shares();
        let key = joint(&alice, &bob);
        let blank = generators::tile_point(0);

        let first = Ciphertext::trivial(&blank).rerandomize(&key, &Scalar::from(11u64));
        let second = Ciphertext::trivial(&blank).rerandomize(&key, &Scalar::from(22u64));

        assert_ne!(first, second);
        assert_eq!(
            first.open([
                &alice.decryption_share(&first),
                &bob.decryption_share(&first)
            ]),
            second.open([
                &alice.decryption_share(&second),
                &bob.decryption_share(&second)
            ]),
        );
    }

    #[test]
    fn a_share_computed_with_the_wrong_key_does_not_open() {
        let (alice, bob) = shares();
        let key = joint(&alice, &bob);
        let impostor = KeyShare::from_wide_bytes(&[0x33; 64]);
        let message = generators::tile_point(9);

        let ciphertext = Ciphertext::encrypt(&key, &message, &Scalar::from(5u64));
        let opened = ciphertext.open([
            &alice.decryption_share(&ciphertext),
            &impostor.decryption_share(&ciphertext),
        ]);

        assert_ne!(opened, message);
    }

    #[test]
    fn ciphertexts_survive_a_round_trip_through_bytes() {
        let (alice, bob) = shares();
        let key = joint(&alice, &bob);
        let ciphertext = Ciphertext::encrypt(&key, &generators::tile_point(2), &Scalar::from(8u64));

        let bytes = ciphertext.to_bytes();
        assert_eq!(Ciphertext::from_bytes(&bytes).unwrap(), ciphertext);
    }

    #[test]
    fn a_truncated_ciphertext_is_refused() {
        assert_eq!(
            Ciphertext::from_bytes(&[0u8; CIPHERTEXT_LEN - 1]),
            Err(DealError::Truncated)
        );
    }

    #[test]
    fn public_shares_survive_a_round_trip() {
        let (alice, _) = shares();
        let share = alice.public();

        assert_eq!(PublicShare::from_bytes(&share.to_bytes()).unwrap(), share);
    }

    #[test]
    fn a_weighted_sum_is_a_ciphertext_of_the_weighted_plaintexts() {
        // What the multi-exponentiation argument leans on.
        let (alice, bob) = shares();
        let key = joint(&alice, &bob);
        let m0 = generators::tile_point(1);
        let m1 = generators::tile_point(2);

        let c0 = Ciphertext::encrypt(&key, &m0, &Scalar::from(3u64));
        let c1 = Ciphertext::encrypt(&key, &m1, &Scalar::from(4u64));
        let weights = [Scalar::from(5u64), Scalar::from(6u64)];

        let combined = weighted_sum(&[c0, c1], &weights);
        let opened = combined.open([
            &alice.decryption_share(&combined),
            &bob.decryption_share(&combined),
        ]);

        assert_eq!(opened, m0 * weights[0] + m1 * weights[1]);
    }
}
