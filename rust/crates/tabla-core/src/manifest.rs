//! Signatures over the list of plugin modules a build is willing to run.
//!
//! A downloadable plugin is fetched over the network and then executed, which
//! is the one place in tabla where bytes from outside become code. The manifest
//! is what makes that safe to do: it names every module and reference file by
//! hash, and it is signed, so a client can refuse anything it did not expect
//! without having to trust the server that served it.
//!
//! What this does and does not buy is worth being plain about. The manifest and
//! its signature ship inside the app bundle, so an attacker who can rewrite the
//! bundle can rewrite all three and the signature proves nothing about *that*.
//! Its value is in the two places it is real: an artifact hash cannot change in
//! the repository without someone holding the signing key re-signing it, and
//! the day a manifest is served from anywhere other than the bundle, the
//! verification is already in place and load-bearing.
//!
//! The verification lives here, in the core module, and never in the plugin
//! module — that binary links no keyed cryptography at all, which is exactly
//! the property the manifest exists to protect.

use ed25519_dalek::{Signature, Verifier, VerifyingKey};

use crate::{SIG_LEN, error::CryptoError};

/// Domain tag for the manifest signature.
///
/// Separated from every other signature this protocol makes, so a signature
/// taken from one context is not a valid signature in another.
pub const MANIFEST_DOMAIN: &[u8] = b"tabla-manifest/v1";

/// The bytes a publisher signs: the domain tag, then the manifest verbatim.
///
/// Verbatim matters. The signature covers the file as it is stored, not a
/// re-serialization of what was parsed out of it, so there is no canonical form
/// to agree on and no parser to disagree through. Parsing happens after the
/// signature checks out, never before.
pub fn manifest_message(payload: &[u8]) -> Vec<u8> {
    let mut msg = Vec::with_capacity(MANIFEST_DOMAIN.len() + payload.len());
    msg.extend_from_slice(MANIFEST_DOMAIN);
    msg.extend_from_slice(payload);
    msg
}

/// Verifies a manifest against the publisher key pinned in the build.
pub fn verify(
    publisher: &VerifyingKey,
    payload: &[u8],
    sig: &[u8; SIG_LEN],
) -> Result<(), CryptoError> {
    publisher
        .verify(&manifest_message(payload), &Signature::from_bytes(sig))
        .map_err(|_| CryptoError::BadSignature)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::identity::{Identity, parse_public_key};

    const PAYLOAD: &[u8] = br#"{"version":1,"plugins":[]}"#;

    fn publisher() -> Identity {
        Identity::from_seed(&[0x33; 32])
    }

    fn signed(payload: &[u8]) -> [u8; SIG_LEN] {
        publisher().sign(&manifest_message(payload))
    }

    fn key(identity: &Identity) -> VerifyingKey {
        parse_public_key(&identity.public_key()).expect("an identity's own key parses")
    }

    #[test]
    fn accepts_what_the_publisher_signed() {
        assert!(verify(&key(&publisher()), PAYLOAD, &signed(PAYLOAD)).is_ok());
    }

    #[test]
    fn refuses_a_payload_that_changed_after_signing() {
        let sig = signed(PAYLOAD);
        let tampered = br#"{"version":1,"plugins":[ ]}"#;

        assert!(verify(&key(&publisher()), tampered, &sig).is_err());
    }

    #[test]
    fn refuses_a_signature_from_another_key() {
        let impostor = Identity::from_seed(&[0x44; 32]);
        let sig = impostor.sign(&manifest_message(PAYLOAD));

        assert!(verify(&key(&publisher()), PAYLOAD, &sig).is_err());
    }

    #[test]
    fn refuses_a_signature_over_the_payload_without_the_domain_tag() {
        // Without domain separation a signature made for one purpose could be
        // presented as a manifest. This is the assertion that keeps the tag
        // from being dropped as redundant.
        let sig = publisher().sign(PAYLOAD);

        assert!(verify(&key(&publisher()), PAYLOAD, &sig).is_err());
    }
}
