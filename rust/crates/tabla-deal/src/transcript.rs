//! The Fiat-Shamir transcript every proof in this crate is bound to.
//!
//! Interactive proofs need a verifier who picks challenges the prover could not
//! anticipate. Fiat-Shamir replaces that verifier with a hash of everything
//! said so far, which is sound exactly as long as the hash covers *everything*
//! — the statement, every prior message, and the context the proof is being
//! made in. Most real breaks of this transform are omissions here rather than
//! flaws in the proof itself, so this module is deliberately dull and strict.
//!
//! Three properties it guarantees:
//!
//! **Unambiguous absorption.** Every item is written with its label and its
//! length, so no two different sequences of writes can produce the same byte
//! stream. Without this, `absorb("ab", "c")` and `absorb("a", "bc")` would be
//! indistinguishable and a prover could shift bytes between fields.
//!
//! **Context binding.** A transcript is opened with the protocol tag, the game
//! id, and the log position the proof will occupy. A proof lifted from another
//! game, or replayed at a different sequence number, fails against a transcript
//! that names where it actually is.
//!
//! **Chained challenges.** Each challenge is folded back into the running state
//! before the next one is drawn, so challenges within one proof are distinct
//! and each depends on every message that preceded it.
//!
//! Written by hand on SHA-512 rather than pulled in from a transcript library:
//! the repository already derives everything else from domain-tagged hashing,
//! and sixty lines that can be read in one sitting are worth more here than a
//! dependency whose framing rules would have to be taken on trust.

use curve25519_dalek::{RistrettoPoint, Scalar};
use sha2::{Digest, Sha512};

/// Separates this crate's hashing from every other use of SHA-512 in tabla.
const PROTOCOL_DOMAIN: &[u8] = b"tabla-deal/v1";

/// A running hash of everything the prover and verifier have agreed on.
#[derive(Clone)]
pub struct Transcript {
    state: Sha512,
}

impl Transcript {
    /// Opens a transcript for one proof at one place in one game.
    ///
    /// `label` names the proof kind (`b"shuffle"`, `b"dleq"`, …), and the game
    /// id and sequence pin it to a position in a specific log. Both are what
    /// stop a valid proof from being replayed somewhere it was not made for.
    pub fn new(label: &[u8], game_id: &[u8], seq: u32) -> Self {
        let mut transcript = Self {
            state: Sha512::new(),
        };
        transcript.write(PROTOCOL_DOMAIN);
        transcript.write(label);
        transcript.write(game_id);
        transcript.write(&seq.to_le_bytes());
        transcript
    }

    /// Absorbs a labelled byte string.
    pub fn absorb(&mut self, label: &[u8], bytes: &[u8]) {
        self.write(label);
        self.write(bytes);
    }

    /// Absorbs a labelled point in its canonical compressed form.
    pub fn absorb_point(&mut self, label: &[u8], point: &RistrettoPoint) {
        self.absorb(label, point.compress().as_bytes());
    }

    /// Absorbs a labelled sequence of points, length-prefixed as one item.
    pub fn absorb_points(&mut self, label: &[u8], points: &[RistrettoPoint]) {
        self.write(label);
        self.write(&(points.len() as u32).to_le_bytes());
        for point in points {
            // Individually length-prefixing fixed-width items would be noise;
            // the count above already makes the sequence unambiguous.
            self.state.update(point.compress().as_bytes());
        }
    }

    /// Absorbs a labelled scalar.
    pub fn absorb_scalar(&mut self, label: &[u8], scalar: &Scalar) {
        self.absorb(label, scalar.as_bytes());
    }

    /// Absorbs a labelled unsigned integer.
    pub fn absorb_u32(&mut self, label: &[u8], value: u32) {
        self.absorb(label, &value.to_le_bytes());
    }

    /// Draws the next challenge and folds it back into the running state.
    ///
    /// Folding back is what makes a second challenge differ from the first even
    /// when nothing was absorbed in between — a prover who could replay one
    /// challenge in place of another would be choosing their own randomness.
    pub fn challenge(&mut self, label: &[u8]) -> Scalar {
        self.write(label);

        let mut fork = self.state.clone();
        fork.update(b"challenge");
        let digest: [u8; 64] = fork.finalize().into();

        self.write(&digest);
        Scalar::from_bytes_mod_order_wide(&digest)
    }

    /// Draws `n` challenges at once, for arguments that need a vector of them.
    pub fn challenges(&mut self, label: &[u8], n: usize) -> Vec<Scalar> {
        (0..n)
            .map(|i| {
                let mut t = self.clone();
                t.absorb_u32(b"index", i as u32);
                t.challenge(label)
            })
            .collect()
    }

    /// Writes one length-prefixed item into the running state.
    fn write(&mut self, bytes: &[u8]) {
        self.state.update((bytes.len() as u64).to_le_bytes());
        self.state.update(bytes);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn point(n: u8) -> RistrettoPoint {
        RistrettoPoint::mul_base(&Scalar::from(u64::from(n) + 1))
    }

    #[test]
    fn the_same_conversation_gives_the_same_challenge() {
        let mut a = Transcript::new(b"test", &[7; 16], 3);
        let mut b = Transcript::new(b"test", &[7; 16], 3);

        a.absorb_point(b"x", &point(1));
        b.absorb_point(b"x", &point(1));

        assert_eq!(a.challenge(b"c"), b.challenge(b"c"));
    }

    #[test]
    fn a_different_game_gives_a_different_challenge() {
        // This is what stops a proof made in one game from being replayed in
        // another: the verifier there computes a challenge the proof does not
        // answer.
        let mut a = Transcript::new(b"test", &[7; 16], 3);
        let mut b = Transcript::new(b"test", &[8; 16], 3);

        assert_ne!(a.challenge(b"c"), b.challenge(b"c"));
    }

    #[test]
    fn a_different_log_position_gives_a_different_challenge() {
        let mut a = Transcript::new(b"test", &[7; 16], 3);
        let mut b = Transcript::new(b"test", &[7; 16], 4);

        assert_ne!(a.challenge(b"c"), b.challenge(b"c"));
    }

    #[test]
    fn absorbed_values_change_the_challenge() {
        let mut a = Transcript::new(b"test", &[7; 16], 0);
        let mut b = Transcript::new(b"test", &[7; 16], 0);

        a.absorb_point(b"x", &point(1));
        b.absorb_point(b"x", &point(2));

        assert_ne!(a.challenge(b"c"), b.challenge(b"c"));
    }

    #[test]
    fn field_boundaries_cannot_be_shifted() {
        // Without length prefixes these two transcripts would hash identically,
        // and a prover could move bytes from one field into the next.
        let mut a = Transcript::new(b"test", &[7; 16], 0);
        let mut b = Transcript::new(b"test", &[7; 16], 0);

        a.absorb(b"f", b"ab");
        a.absorb(b"g", b"c");
        b.absorb(b"f", b"a");
        b.absorb(b"g", b"bc");

        assert_ne!(a.challenge(b"c"), b.challenge(b"c"));
    }

    #[test]
    fn successive_challenges_differ() {
        let mut t = Transcript::new(b"test", &[7; 16], 0);

        let first = t.challenge(b"c");
        let second = t.challenge(b"c");

        assert_ne!(first, second);
    }

    #[test]
    fn a_vector_of_challenges_has_no_repeats() {
        let mut t = Transcript::new(b"test", &[7; 16], 0);
        let challenges = t.challenges(b"c", 8);

        for (i, x) in challenges.iter().enumerate() {
            for y in &challenges[i + 1..] {
                assert_ne!(x, y);
            }
        }
    }

    #[test]
    fn a_sequence_of_points_is_bound_in_order() {
        let mut a = Transcript::new(b"test", &[7; 16], 0);
        let mut b = Transcript::new(b"test", &[7; 16], 0);

        a.absorb_points(b"v", &[point(1), point(2)]);
        b.absorb_points(b"v", &[point(2), point(1)]);

        assert_ne!(a.challenge(b"c"), b.challenge(b"c"));
    }
}
