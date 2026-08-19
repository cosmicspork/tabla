//! Fixed-width serialization for everything that crosses the wire.
//!
//! Hand-rolled rather than derived, matching the log's preimage encoding: these
//! bytes are hashed into transcripts and signed into entries, so the format has
//! to be exactly one thing forever, and a serialization library's version
//! upgrade must not be able to change it quietly.
//!
//! Every read is canonical. A ristretto point has exactly one valid encoding
//! and a scalar must be fully reduced; anything else is refused rather than
//! normalised, because two clients that normalise differently would disagree
//! about a hash and diverge mid-game.

use curve25519_dalek::{RistrettoPoint, Scalar, ristretto::CompressedRistretto};

use crate::{DealError, POINT_LEN, SCALAR_LEN};

/// Reads a compressed ristretto point, rejecting anything not on the curve.
pub fn point_from_bytes(bytes: &[u8]) -> Result<RistrettoPoint, DealError> {
    let slice: [u8; POINT_LEN] = bytes
        .get(..POINT_LEN)
        .ok_or(DealError::Truncated)?
        .try_into()
        .map_err(|_| DealError::Truncated)?;

    CompressedRistretto(slice)
        .decompress()
        .ok_or(DealError::BadEncoding)
}

/// Reads a scalar, rejecting any encoding that is not fully reduced.
///
/// Non-canonical scalars are refused rather than reduced: a prover who could
/// offer two encodings of one value would have two proofs where the protocol
/// expects one, and the malleability tends to matter somewhere eventually.
pub fn scalar_from_bytes(bytes: &[u8]) -> Result<Scalar, DealError> {
    let slice: [u8; SCALAR_LEN] = bytes
        .get(..SCALAR_LEN)
        .ok_or(DealError::Truncated)?
        .try_into()
        .map_err(|_| DealError::Truncated)?;

    Option::from(Scalar::from_canonical_bytes(slice)).ok_or(DealError::BadEncoding)
}

/// Appends a point in its canonical form.
pub fn put_point(out: &mut Vec<u8>, point: &RistrettoPoint) {
    out.extend_from_slice(point.compress().as_bytes());
}

/// Appends a scalar.
pub fn put_scalar(out: &mut Vec<u8>, scalar: &Scalar) {
    out.extend_from_slice(scalar.as_bytes());
}

/// Reads a run of points written back to back.
pub fn points_from_bytes(bytes: &[u8], n: usize) -> Result<Vec<RistrettoPoint>, DealError> {
    if bytes.len() < n * POINT_LEN {
        return Err(DealError::Truncated);
    }
    (0..n)
        .map(|i| point_from_bytes(&bytes[i * POINT_LEN..]))
        .collect()
}

/// Reads a run of scalars written back to back.
pub fn scalars_from_bytes(bytes: &[u8], n: usize) -> Result<Vec<Scalar>, DealError> {
    if bytes.len() < n * SCALAR_LEN {
        return Err(DealError::Truncated);
    }
    (0..n)
        .map(|i| scalar_from_bytes(&bytes[i * SCALAR_LEN..]))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::generators;

    #[test]
    fn points_survive_a_round_trip() {
        let point = generators::tile_point(4);
        let mut bytes = Vec::new();
        put_point(&mut bytes, &point);

        assert_eq!(point_from_bytes(&bytes).unwrap(), point);
    }

    #[test]
    fn scalars_survive_a_round_trip() {
        let scalar = Scalar::from(123_456u64);
        let mut bytes = Vec::new();
        put_scalar(&mut bytes, &scalar);

        assert_eq!(scalar_from_bytes(&bytes).unwrap(), scalar);
    }

    #[test]
    fn a_point_that_is_not_on_the_curve_is_refused() {
        assert_eq!(
            point_from_bytes(&[0xff; POINT_LEN]),
            Err(DealError::BadEncoding)
        );
    }

    #[test]
    fn an_unreduced_scalar_is_refused() {
        // The order of the group is well below 2^255, so an all-ones encoding
        // is a value no honest prover produces.
        assert_eq!(
            scalar_from_bytes(&[0xff; SCALAR_LEN]),
            Err(DealError::BadEncoding)
        );
    }

    #[test]
    fn short_input_is_truncated_not_misread() {
        assert_eq!(point_from_bytes(&[0u8; 31]), Err(DealError::Truncated));
        assert_eq!(scalar_from_bytes(&[0u8; 31]), Err(DealError::Truncated));
        assert_eq!(points_from_bytes(&[0u8; 63], 2), Err(DealError::Truncated));
        assert_eq!(scalars_from_bytes(&[0u8; 63], 2), Err(DealError::Truncated));
    }

    #[test]
    fn runs_of_values_read_back_in_order() {
        let points = [generators::tile_point(1), generators::tile_point(2)];
        let mut bytes = Vec::new();
        for point in &points {
            put_point(&mut bytes, point);
        }

        assert_eq!(points_from_bytes(&bytes, 2).unwrap(), points);
    }
}
