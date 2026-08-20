//! The two small proofs the deal needs, both Schnorr-shaped.
//!
//! **Proof of knowledge** accompanies a published key share. Without it a
//! player could set `X_C = Y − X_I` for a `Y` of their choosing and control the
//! joint key outright — a rogue-key attack, and the reason a bare public key is
//! never enough in a protocol that adds keys together.
//!
//! **Discrete-logarithm equality** accompanies every decryption share. It says
//! `d = x·c1` for the same `x` in the published `X = x·G`, without revealing
//! `x`. A share is otherwise unfalsifiable in the wrong direction: nothing
//! about `d` alone says it was honestly computed, and a wrong share makes a
//! tile open to garbage — which, without this proof, would be indistinguishable
//! from an opponent who simply had bad luck.
//!
//! Both are the textbook sigma protocols made non-interactive against the
//! shared [`Transcript`], never against a fresh one: a proof is valid only at
//! the log position it was made for.

use curve25519_dalek::{RistrettoPoint, Scalar};

use crate::{
    DealError, POINT_LEN, SCALAR_LEN, Transcript,
    encoding::{point_from_bytes, put_point, put_scalar, scalar_from_bytes},
    generators,
};

/// Proof that the prover knows `x` with `X = x·G`.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct KnowledgeProof {
    commitment: RistrettoPoint,
    response: Scalar,
}

/// Serialized length of a [`KnowledgeProof`].
pub const KNOWLEDGE_PROOF_LEN: usize = POINT_LEN + SCALAR_LEN;

impl KnowledgeProof {
    pub fn prove(transcript: &mut Transcript, secret: &Scalar, entropy: &[u8]) -> Self {
        let public = RistrettoPoint::mul_base(secret);
        let k = generators::scalar_from_entropy(b"pok", entropy, 0);
        let commitment = RistrettoPoint::mul_base(&k);

        transcript.absorb_point(b"pok-public", &public);
        transcript.absorb_point(b"pok-commitment", &commitment);
        let challenge = transcript.challenge(b"pok-challenge");

        Self {
            commitment,
            response: k + challenge * secret,
        }
    }

    pub fn verify(
        &self,
        transcript: &mut Transcript,
        public: &RistrettoPoint,
    ) -> Result<(), DealError> {
        transcript.absorb_point(b"pok-public", public);
        transcript.absorb_point(b"pok-commitment", &self.commitment);
        let challenge = transcript.challenge(b"pok-challenge");

        // s·G == R + e·X
        if RistrettoPoint::mul_base(&self.response) == self.commitment + public * challenge {
            Ok(())
        } else {
            Err(DealError::BadProof)
        }
    }

    pub fn to_bytes(self) -> [u8; KNOWLEDGE_PROOF_LEN] {
        let mut out = Vec::with_capacity(KNOWLEDGE_PROOF_LEN);
        put_point(&mut out, &self.commitment);
        put_scalar(&mut out, &self.response);
        out.try_into().expect("fixed width")
    }

    pub fn from_bytes(bytes: &[u8]) -> Result<Self, DealError> {
        if bytes.len() < KNOWLEDGE_PROOF_LEN {
            return Err(DealError::Truncated);
        }
        Ok(Self {
            commitment: point_from_bytes(&bytes[..POINT_LEN])?,
            response: scalar_from_bytes(&bytes[POINT_LEN..KNOWLEDGE_PROOF_LEN])?,
        })
    }
}

/// Proof that `d = x·base` for the same `x` as in `public = x·G`.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct EqualityProof {
    challenge: Scalar,
    response: Scalar,
}

/// Serialized length of an [`EqualityProof`].
pub const EQUALITY_PROOF_LEN: usize = SCALAR_LEN * 2;

impl EqualityProof {
    /// `base` is the ciphertext's `c1`; `image` is the decryption share.
    pub fn prove(
        transcript: &mut Transcript,
        secret: &Scalar,
        base: &RistrettoPoint,
        entropy: &[u8],
        index: u32,
    ) -> Self {
        let public = RistrettoPoint::mul_base(secret);
        let image = base * secret;
        let k = generators::scalar_from_entropy(b"dleq", entropy, index);

        let challenge = Self::challenge(
            transcript,
            &public,
            base,
            &image,
            &RistrettoPoint::mul_base(&k),
            &(base * k),
        );

        Self {
            challenge,
            response: k + challenge * secret,
        }
    }

    pub fn verify(
        &self,
        transcript: &mut Transcript,
        public: &RistrettoPoint,
        base: &RistrettoPoint,
        image: &RistrettoPoint,
    ) -> Result<(), DealError> {
        // Recompute both commitments from the response and the challenge; if
        // the prover knew the secret they cancel back to what was committed.
        let commitment_g = RistrettoPoint::mul_base(&self.response) - public * self.challenge;
        let commitment_base = base * self.response - image * self.challenge;

        let expected = Self::challenge(
            transcript,
            public,
            base,
            image,
            &commitment_g,
            &commitment_base,
        );

        if expected == self.challenge {
            Ok(())
        } else {
            Err(DealError::BadProof)
        }
    }

    fn challenge(
        transcript: &mut Transcript,
        public: &RistrettoPoint,
        base: &RistrettoPoint,
        image: &RistrettoPoint,
        commitment_g: &RistrettoPoint,
        commitment_base: &RistrettoPoint,
    ) -> Scalar {
        transcript.absorb_point(b"dleq-public", public);
        transcript.absorb_point(b"dleq-base", base);
        transcript.absorb_point(b"dleq-image", image);
        transcript.absorb_point(b"dleq-commit-g", commitment_g);
        transcript.absorb_point(b"dleq-commit-base", commitment_base);
        transcript.challenge(b"dleq-challenge")
    }

    pub fn to_bytes(self) -> [u8; EQUALITY_PROOF_LEN] {
        let mut out = Vec::with_capacity(EQUALITY_PROOF_LEN);
        put_scalar(&mut out, &self.challenge);
        put_scalar(&mut out, &self.response);
        out.try_into().expect("fixed width")
    }

    pub fn from_bytes(bytes: &[u8]) -> Result<Self, DealError> {
        if bytes.len() < EQUALITY_PROOF_LEN {
            return Err(DealError::Truncated);
        }
        Ok(Self {
            challenge: scalar_from_bytes(&bytes[..SCALAR_LEN])?,
            response: scalar_from_bytes(&bytes[SCALAR_LEN..EQUALITY_PROOF_LEN])?,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::elgamal::{Ciphertext, KeyShare, PublicShare};

    const GAME: [u8; 16] = [0x5a; 16];

    fn transcript() -> Transcript {
        Transcript::new(b"test", &GAME, 4)
    }

    fn secret() -> Scalar {
        Scalar::from_bytes_mod_order_wide(&[0x11; 64])
    }

    // -- proof of knowledge ---------------------------------------------------

    #[test]
    fn a_key_share_proof_verifies() {
        let x = secret();
        let proof = KnowledgeProof::prove(&mut transcript(), &x, &[0x77; 32]);

        assert!(
            proof
                .verify(&mut transcript(), &RistrettoPoint::mul_base(&x))
                .is_ok()
        );
    }

    #[test]
    fn a_key_share_proof_fails_against_another_key() {
        // The rogue-key case: claiming a public key you cannot open.
        let proof = KnowledgeProof::prove(&mut transcript(), &secret(), &[0x77; 32]);
        let impostor = RistrettoPoint::mul_base(&Scalar::from(999u64));

        assert_eq!(
            proof.verify(&mut transcript(), &impostor),
            Err(DealError::BadProof)
        );
    }

    #[test]
    fn a_key_share_proof_does_not_travel_to_another_game() {
        let x = secret();
        let proof = KnowledgeProof::prove(&mut transcript(), &x, &[0x77; 32]);
        let mut elsewhere = Transcript::new(b"test", &[0x01; 16], 4);

        assert_eq!(
            proof.verify(&mut elsewhere, &RistrettoPoint::mul_base(&x)),
            Err(DealError::BadProof)
        );
    }

    #[test]
    fn a_key_share_proof_does_not_travel_to_another_log_position() {
        let x = secret();
        let proof = KnowledgeProof::prove(&mut transcript(), &x, &[0x77; 32]);
        let mut later = Transcript::new(b"test", &GAME, 5);

        assert_eq!(
            proof.verify(&mut later, &RistrettoPoint::mul_base(&x)),
            Err(DealError::BadProof)
        );
    }

    #[test]
    fn a_tampered_key_share_proof_is_refused() {
        let x = secret();
        let proof = KnowledgeProof::prove(&mut transcript(), &x, &[0x77; 32]);
        let mangled = KnowledgeProof {
            response: proof.response + Scalar::ONE,
            ..proof
        };

        assert_eq!(
            mangled.verify(&mut transcript(), &RistrettoPoint::mul_base(&x)),
            Err(DealError::BadProof)
        );
    }

    #[test]
    fn key_share_proofs_survive_a_round_trip() {
        let proof = KnowledgeProof::prove(&mut transcript(), &secret(), &[0x77; 32]);

        assert_eq!(
            KnowledgeProof::from_bytes(&proof.to_bytes()).unwrap(),
            proof
        );
        assert_eq!(
            KnowledgeProof::from_bytes(&[0u8; KNOWLEDGE_PROOF_LEN - 1]),
            Err(DealError::Truncated)
        );
    }

    // -- discrete-logarithm equality -----------------------------------------

    fn ciphertext() -> (KeyShare, KeyShare, Ciphertext) {
        let alice = KeyShare::from_wide_bytes(&[0x11; 64]);
        let bob = KeyShare::from_wide_bytes(&[0x22; 64]);
        let key = PublicShare::joint(&alice.public(), &bob.public());
        let message = generators::tile_point(6);
        let ciphertext = Ciphertext::encrypt(&key, &message, &Scalar::from(31u64));
        (alice, bob, ciphertext)
    }

    #[test]
    fn a_decryption_share_proof_verifies() {
        let (alice, _, ciphertext) = ciphertext();
        let (share, proof) = alice.proven_share(&mut transcript(), &ciphertext, &[0x88; 32], 0);

        assert!(
            proof
                .verify(&mut transcript(), &alice.public().0, &ciphertext.c1, &share)
                .is_ok()
        );
    }

    #[test]
    fn a_share_from_the_wrong_key_is_caught() {
        // Without this the tile would simply open to nonsense, and a cheat
        // would be indistinguishable from bad luck.
        let (alice, _, ciphertext) = ciphertext();
        let impostor = KeyShare::from_wide_bytes(&[0x33; 64]);
        let (wrong_share, proof) =
            impostor.proven_share(&mut transcript(), &ciphertext, &[0x88; 32], 0);

        assert_eq!(
            proof.verify(
                &mut transcript(),
                &alice.public().0,
                &ciphertext.c1,
                &wrong_share
            ),
            Err(DealError::BadProof)
        );
    }

    #[test]
    fn a_substituted_share_is_caught() {
        let (alice, bob, ciphertext) = ciphertext();
        let (_, proof) = alice.proven_share(&mut transcript(), &ciphertext, &[0x88; 32], 0);

        assert_eq!(
            proof.verify(
                &mut transcript(),
                &alice.public().0,
                &ciphertext.c1,
                &bob.decryption_share(&ciphertext)
            ),
            Err(DealError::BadProof)
        );
    }

    #[test]
    fn a_share_proof_does_not_transfer_to_another_ciphertext() {
        // Positions are dealt one at a time; a proof for one must not stand in
        // for another.
        let (alice, _, first) = ciphertext();
        let key = PublicShare::joint(&alice.public(), &alice.public());
        let second = Ciphertext::encrypt(&key, &generators::tile_point(1), &Scalar::from(77u64));

        let (_, proof) = alice.proven_share(&mut transcript(), &first, &[0x88; 32], 0);

        assert_eq!(
            proof.verify(
                &mut transcript(),
                &alice.public().0,
                &second.c1,
                &alice.decryption_share(&second)
            ),
            Err(DealError::BadProof)
        );
    }

    #[test]
    fn a_share_proof_does_not_travel_to_another_game() {
        let (alice, _, ciphertext) = ciphertext();
        let (share, proof) = alice.proven_share(&mut transcript(), &ciphertext, &[0x88; 32], 0);
        let mut elsewhere = Transcript::new(b"test", &[0x01; 16], 4);

        assert_eq!(
            proof.verify(&mut elsewhere, &alice.public().0, &ciphertext.c1, &share),
            Err(DealError::BadProof)
        );
    }

    #[test]
    fn share_proofs_survive_a_round_trip() {
        let (alice, _, ciphertext) = ciphertext();
        let (_, proof) = alice.proven_share(&mut transcript(), &ciphertext, &[0x88; 32], 0);

        assert_eq!(EqualityProof::from_bytes(&proof.to_bytes()).unwrap(), proof);
        assert_eq!(
            EqualityProof::from_bytes(&[0u8; EQUALITY_PROOF_LEN - 1]),
            Err(DealError::Truncated)
        );
    }

    #[test]
    fn proofs_for_different_positions_use_different_randomness() {
        // Reusing the nonce k across two proofs with the same secret leaks the
        // secret outright, so the index has to reach the expansion.
        let (alice, _, ciphertext) = ciphertext();

        let (_, first) = alice.proven_share(&mut transcript(), &ciphertext, &[0x88; 32], 0);
        let (_, second) = alice.proven_share(&mut transcript(), &ciphertext, &[0x88; 32], 1);

        assert_ne!(first, second);
    }
}
