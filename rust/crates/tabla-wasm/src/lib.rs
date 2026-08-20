//! The core WASM module: identity, key agreement, the hash-chained log, and
//! session decryption.
//!
//! This is the only place keys exist. It links no game rules — the position on
//! the board is computed by `tabla-plugin-wasm` in a separate worker that is
//! handed decrypted moves and nothing else.
//!
//! Randomness always comes from the caller. TypeScript supplies bytes from
//! `crypto.getRandomValues`, which keeps this module deterministic and means the
//! wasm build carries no RNG shim.

pub mod deal;

use tabla_core::error::CryptoError;
use tabla_core::export::{ExportBundle, KdfParams};
use tabla_core::identity::parse_public_key;
use tabla_core::invite::{self, InviteConfig};
use tabla_core::kex;
use tabla_core::log::{self, Entry, Participants, Tombstone};
use tabla_core::manifest;
use tabla_core::session::{EntryBody, Role, SessionError};
use tabla_core::{BLOB_ID_LEN, GAME_ID_LEN, KEY_LEN, NONCE_LEN, PUBKEY_LEN, SEED_LEN, SIG_LEN};
use wasm_bindgen::prelude::*;

// -- conversions ------------------------------------------------------------

fn fixed<const N: usize>(bytes: &[u8], what: &str) -> Result<[u8; N], JsError> {
    bytes
        .try_into()
        .map_err(|_| JsError::new(&format!("{what} must be {N} bytes, got {}", bytes.len())))
}

fn crypto_err(e: CryptoError) -> JsError {
    JsError::new(&e.to_string())
}

fn session_err(e: SessionError) -> JsError {
    JsError::new(&e.to_string())
}

fn log_err(e: log::LogError) -> JsError {
    JsError::new(&e.to_string())
}

/// Protocol version this build speaks.
#[wasm_bindgen]
pub fn protocol_version() -> u32 {
    1
}

// -- identity ---------------------------------------------------------------

/// An installation's long-term keypair.
#[wasm_bindgen]
pub struct Identity {
    inner: tabla_core::Identity,
}

#[wasm_bindgen]
impl Identity {
    /// Builds an identity from 32 caller-supplied random bytes.
    #[wasm_bindgen(constructor)]
    pub fn new(seed: &[u8]) -> Result<Identity, JsError> {
        Ok(Identity {
            inner: tabla_core::Identity::from_seed(&fixed::<SEED_LEN>(seed, "seed")?),
        })
    }

    #[wasm_bindgen(js_name = publicKey)]
    pub fn public_key(&self) -> Vec<u8> {
        self.inner.public_key().to_vec()
    }

    #[wasm_bindgen(js_name = keyHash)]
    pub fn key_hash(&self) -> Vec<u8> {
        self.inner.key_hash().to_vec()
    }

    /// The private seed, for the encrypted export. Never send this anywhere.
    pub fn seed(&self) -> Vec<u8> {
        self.inner.seed().to_vec()
    }

    pub fn sign(&self, message: &[u8]) -> Vec<u8> {
        self.inner.sign(message).to_vec()
    }

    /// Signs the proof that we are the one redeeming an invite.
    #[wasm_bindgen(js_name = signClaim)]
    pub fn sign_claim(&self, blob_id: &[u8]) -> Result<Vec<u8>, JsError> {
        let blob_id = fixed::<BLOB_ID_LEN>(blob_id, "blobId")?;
        Ok(invite::sign_claim(&self.inner, &blob_id).to_vec())
    }

    /// This device's private entropy for one game's hidden draws.
    ///
    /// Derived rather than stored, so a restored backup rebuilds a half-played
    /// rack from the log alone. Handed to the game plugin as its seed; published
    /// by the plugin when the game ends so the opponent can audit every draw,
    /// which it can do without learning anything about the identity key.
    #[wasm_bindgen(js_name = deriveDrawSeed)]
    pub fn derive_draw_seed(&self, game_id: &[u8]) -> Result<Vec<u8>, JsError> {
        let game_id = fixed::<GAME_ID_LEN>(game_id, "gameId")?;
        Ok(self.inner.draw_seed(&game_id).to_vec())
    }

    /// This device's half of the key one game's deck is encrypted under.
    ///
    /// Never published, never stored — see [`tabla_core::identity::Identity`].
    /// Held only long enough to build a [`DealSession`].
    #[wasm_bindgen(js_name = deriveDealSecret)]
    pub fn derive_deal_secret(&self, game_id: &[u8]) -> Result<Vec<u8>, JsError> {
        let game_id = fixed::<GAME_ID_LEN>(game_id, "gameId")?;
        Ok(self.inner.deal_secret(&game_id).to_vec())
    }

    /// Derives the symmetric key protecting one game's entries.
    #[wasm_bindgen(js_name = agreeGameKey)]
    pub fn agree_game_key(
        &self,
        peer_public_key: &[u8],
        blob_id: &[u8],
        game_id: &[u8],
    ) -> Result<Vec<u8>, JsError> {
        let peer = parse_public_key(&fixed::<PUBKEY_LEN>(peer_public_key, "peer public key")?)
            .map_err(crypto_err)?;
        let blob_id = fixed::<BLOB_ID_LEN>(blob_id, "blobId")?;
        let game_id = fixed::<GAME_ID_LEN>(game_id, "gameId")?;

        Ok(kex::agree_game_key(&self.inner, &peer, &blob_id, &game_id).to_vec())
    }
}

/// SHA-256 of a public key: how the relay refers to a participant.
#[wasm_bindgen(js_name = keyHashOf)]
pub fn key_hash_of(public_key: &[u8]) -> Result<Vec<u8>, JsError> {
    Ok(log::key_hash(&fixed::<PUBKEY_LEN>(public_key, "public key")?).to_vec())
}

/// Verifies that whoever claimed an invite holds the key they presented.
///
/// The initiator calls this. The relay never does — it is not trusted to
/// authenticate anyone.
#[wasm_bindgen(js_name = verifyClaim)]
pub fn verify_claim(
    claimer_public_key: &[u8],
    blob_id: &[u8],
    signature: &[u8],
) -> Result<(), JsError> {
    let key = parse_public_key(&fixed::<PUBKEY_LEN>(claimer_public_key, "public key")?)
        .map_err(crypto_err)?;
    let blob_id = fixed::<BLOB_ID_LEN>(blob_id, "blobId")?;
    let sig = fixed::<SIG_LEN>(signature, "signature")?;

    invite::verify_claim(&key, &blob_id, &sig).map_err(crypto_err)
}

/// Verifies the plugin manifest against the publisher key pinned in this build.
///
/// The app calls this before it will fetch, store, or run a downloadable
/// module. It lives in this module rather than the plugin one because the
/// plugin module deliberately links no keyed cryptography — the thing the
/// manifest exists to keep true.
#[wasm_bindgen(js_name = verifyManifest)]
pub fn verify_manifest(
    publisher_public_key: &[u8],
    payload: &[u8],
    signature: &[u8],
) -> Result<(), JsError> {
    let key = parse_public_key(&fixed::<PUBKEY_LEN>(
        publisher_public_key,
        "publisher public key",
    )?)
    .map_err(crypto_err)?;
    let sig = fixed::<SIG_LEN>(signature, "signature")?;

    manifest::verify(&key, payload, &sig).map_err(crypto_err)
}

// -- invites ----------------------------------------------------------------

/// A decrypted invite. Fields are copied out rather than exposed by reference so
/// the JS side cannot mutate what the Rust side validated.
#[wasm_bindgen]
pub struct Invite {
    inner: InviteConfig,
}

#[wasm_bindgen]
impl Invite {
    #[wasm_bindgen(getter, js_name = gameId)]
    pub fn game_id(&self) -> Vec<u8> {
        self.inner.game_id.to_vec()
    }

    #[wasm_bindgen(getter, js_name = pluginId)]
    pub fn plugin_id(&self) -> String {
        self.inner.plugin_id.clone()
    }

    #[wasm_bindgen(getter, js_name = pluginVersion)]
    pub fn plugin_version(&self) -> u32 {
        self.inner.plugin_version
    }

    #[wasm_bindgen(getter, js_name = dictionaryHash)]
    pub fn dictionary_hash(&self) -> Option<Vec<u8>> {
        self.inner.dictionary_hash.map(|h| h.to_vec())
    }

    #[wasm_bindgen(getter, js_name = initiatorPublicKey)]
    pub fn initiator_public_key(&self) -> Vec<u8> {
        self.inner.initiator_pub_key.to_vec()
    }

    #[wasm_bindgen(getter)]
    pub fn seed(&self) -> Vec<u8> {
        self.inner.seed.to_vec()
    }

    #[wasm_bindgen(getter, js_name = createdAt)]
    pub fn created_at(&self) -> u64 {
        self.inner.created_at
    }

    /// Whether this build can play the game described.
    ///
    /// A mismatch must be refused before the first move: two clients validating
    /// differently cannot be reconciled once entries exist.
    #[wasm_bindgen(js_name = isCompatible)]
    pub fn is_compatible(
        &self,
        plugin_id: &str,
        plugin_version: u32,
        dictionary_hash: Option<Vec<u8>>,
    ) -> bool {
        let hash = match dictionary_hash {
            Some(h) => match <[u8; 32]>::try_from(h.as_slice()) {
                Ok(h) => Some(h),
                Err(_) => return false,
            },
            None => None,
        };
        self.inner
            .is_compatible(plugin_id, plugin_version, hash.as_ref())
    }
}

/// Seals an invite configuration under a random key that lives only in the
/// share link's fragment.
#[wasm_bindgen(js_name = sealInvite)]
#[allow(clippy::too_many_arguments)]
pub fn seal_invite(
    key: &[u8],
    nonce: &[u8],
    game_id: &[u8],
    plugin_id: &str,
    plugin_version: u32,
    dictionary_hash: Option<Vec<u8>>,
    initiator_public_key: &[u8],
    seed: &[u8],
    created_at: u64,
) -> Result<Vec<u8>, JsError> {
    let config = InviteConfig {
        v: invite::INVITE_VERSION,
        game_id: fixed::<GAME_ID_LEN>(game_id, "gameId")?,
        plugin_id: plugin_id.to_string(),
        plugin_version,
        dictionary_hash: match dictionary_hash {
            Some(h) => Some(fixed::<32>(&h, "dictionaryHash")?),
            None => None,
        },
        initiator_pub_key: fixed::<PUBKEY_LEN>(initiator_public_key, "public key")?,
        seed: fixed::<32>(seed, "seed")?,
        created_at,
    };

    config
        .seal(
            &fixed::<KEY_LEN>(key, "key")?,
            &fixed::<NONCE_LEN>(nonce, "nonce")?,
        )
        .map_err(crypto_err)
}

/// Opens an invite blob with the key taken from the link fragment.
#[wasm_bindgen(js_name = openInvite)]
pub fn open_invite(key: &[u8], blob: &[u8]) -> Result<Invite, JsError> {
    let inner = InviteConfig::open(&fixed::<KEY_LEN>(key, "key")?, blob).map_err(crypto_err)?;
    Ok(Invite { inner })
}

// -- sessions ---------------------------------------------------------------

/// A game's key bound to its two participants.
#[wasm_bindgen]
pub struct Session {
    inner: tabla_core::Session,
}

#[wasm_bindgen]
impl Session {
    #[wasm_bindgen(constructor)]
    pub fn new(
        game_id: &[u8],
        key: &[u8],
        initiator_public_key: &[u8],
        claimer_public_key: &[u8],
    ) -> Result<Session, JsError> {
        let initiator =
            parse_public_key(&fixed::<PUBKEY_LEN>(initiator_public_key, "initiator key")?)
                .map_err(crypto_err)?;
        let claimer = parse_public_key(&fixed::<PUBKEY_LEN>(claimer_public_key, "claimer key")?)
            .map_err(crypto_err)?;

        Ok(Session {
            inner: tabla_core::Session::new(
                fixed::<GAME_ID_LEN>(game_id, "gameId")?,
                fixed::<KEY_LEN>(key, "key")?,
                initiator,
                claimer,
            ),
        })
    }

    fn seal(&self, seq: u32, nonce: &[u8], body: &EntryBody) -> Result<Vec<u8>, JsError> {
        self.inner
            .seal_body(seq, &fixed::<NONCE_LEN>(nonce, "nonce")?, body)
            .map_err(crypto_err)
    }

    /// Sequence 0: the claimer binds their identity to the game.
    #[wasm_bindgen(js_name = sealJoin)]
    pub fn seal_join(&self, nonce: &[u8], claimer_public_key: &[u8]) -> Result<Vec<u8>, JsError> {
        let body = EntryBody::Join {
            claimer_pub_key: fixed::<PUBKEY_LEN>(claimer_public_key, "claimer key")?,
        };
        self.seal(0, nonce, &body)
    }

    /// Sequence 1: the initiator records the agreed configuration.
    #[wasm_bindgen(js_name = sealSetup)]
    pub fn seal_setup(&self, nonce: &[u8], config: &[u8]) -> Result<Vec<u8>, JsError> {
        self.seal(
            1,
            nonce,
            &EntryBody::Setup {
                config: config.to_vec(),
            },
        )
    }

    #[wasm_bindgen(js_name = sealMove)]
    pub fn seal_move(&self, seq: u32, nonce: &[u8], mv: &[u8]) -> Result<Vec<u8>, JsError> {
        self.seal(seq, nonce, &EntryBody::Move(mv.to_vec()))
    }

    #[wasm_bindgen(js_name = sealResign)]
    pub fn seal_resign(&self, seq: u32, nonce: &[u8]) -> Result<Vec<u8>, JsError> {
        self.seal(seq, nonce, &EntryBody::Resign)
    }

    /// Which role must author the entry at a given position.
    #[wasm_bindgen(js_name = expectedAuthor)]
    pub fn expected_author(seq: u32) -> u8 {
        tabla_core::Session::expected_author(seq).player_index()
    }
}

// -- the log ----------------------------------------------------------------

/// A verified, in-order game log.
///
/// Entries are verified as they are appended, so an instance of this type is
/// always a log that passed every structural check. There is no way to construct
/// one holding an entry that failed.
#[wasm_bindgen]
pub struct Log {
    game_id: [u8; GAME_ID_LEN],
    participants: Participants,
    entries: Vec<Entry>,
}

#[wasm_bindgen]
impl Log {
    #[wasm_bindgen(constructor)]
    pub fn new(
        game_id: &[u8],
        initiator_public_key: &[u8],
        claimer_public_key: &[u8],
    ) -> Result<Log, JsError> {
        let initiator =
            parse_public_key(&fixed::<PUBKEY_LEN>(initiator_public_key, "initiator key")?)
                .map_err(crypto_err)?;
        let claimer = parse_public_key(&fixed::<PUBKEY_LEN>(claimer_public_key, "claimer key")?)
            .map_err(crypto_err)?;

        Ok(Log {
            game_id: fixed::<GAME_ID_LEN>(game_id, "gameId")?,
            participants: Participants::new(&[initiator, claimer]),
            entries: Vec::new(),
        })
    }

    /// Number of entries held.
    #[wasm_bindgen(getter)]
    pub fn length(&self) -> u32 {
        self.entries.len() as u32
    }

    /// Sequence number of the last entry, or -1 for an empty log.
    ///
    /// -1 is also what the relay reports when it holds nothing, so the two agree
    /// on how to describe "no history here".
    #[wasm_bindgen(getter, js_name = tipSeq)]
    pub fn tip_seq(&self) -> i64 {
        self.entries.last().map_or(-1, |e| e.header.seq as i64)
    }

    #[wasm_bindgen(getter, js_name = tipHash)]
    pub fn tip_hash(&self) -> Option<Vec<u8>> {
        self.entries.last().map(|e| e.hash().to_vec())
    }

    /// Appends one encoded entry, verifying it against the current tip.
    ///
    /// Rejects anything that breaks contiguity, chaining, authorship, or the
    /// signature. A rejected entry leaves the log untouched.
    pub fn append(&mut self, encoded: &[u8]) -> Result<(), JsError> {
        let entry = Entry::decode(encoded).map_err(log_err)?;
        let tip = self.entries.last().map(|e| log::ChainTip {
            seq: e.header.seq,
            hash: e.hash(),
        });

        log::verify_suffix(
            tip,
            std::slice::from_ref(&entry),
            &self.game_id,
            &self.participants,
        )
        .map_err(log_err)?;

        self.entries.push(entry);
        Ok(())
    }

    /// Signs and appends a new entry authored by us.
    #[wasm_bindgen(js_name = appendSigned)]
    pub fn append_signed(
        &mut self,
        identity: &Identity,
        payload: &[u8],
    ) -> Result<Vec<u8>, JsError> {
        let seq = self.entries.len() as u32;
        let prev = self
            .entries
            .last()
            .map_or(log::GENESIS_PREV_HASH, |e| e.hash());

        let entry = Entry::sign(
            identity.inner.signing_key(),
            seq,
            prev,
            self.game_id,
            payload.to_vec(),
        );
        let encoded = entry.encode();

        // Verify what we just built, so a bug here fails loudly rather than
        // producing a log the opponent will reject.
        let tip = self.entries.last().map(|e| log::ChainTip {
            seq: e.header.seq,
            hash: e.hash(),
        });
        log::verify_suffix(
            tip,
            std::slice::from_ref(&entry),
            &self.game_id,
            &self.participants,
        )
        .map_err(log_err)?;

        self.entries.push(entry);
        Ok(encoded)
    }

    /// The encoded entry at a position.
    pub fn entry(&self, seq: u32) -> Option<Vec<u8>> {
        self.entries.get(seq as usize).map(|e| e.encode())
    }

    /// Every entry from `from_seq` onward, for answering a peer that is behind.
    pub fn suffix(&self, from_seq: u32) -> js_sys::Array {
        let out = js_sys::Array::new();
        for entry in self.entries.iter().skip(from_seq as usize) {
            out.push(&js_sys::Uint8Array::from(&entry.encode()[..]).into());
        }
        out
    }

    /// Decrypts the log and checks turn discipline.
    pub fn replay(&self, session: &Session) -> Result<Replay, JsError> {
        let replayed = session.inner.replay(&self.entries).map_err(session_err)?;

        Ok(Replay {
            moves: replayed.moves,
            config: replayed.config,
            resigned_by: replayed.resigned_by.map(|r| r.player_index()),
        })
    }

    /// Checks a tombstone against this log before accepting it as a restoration.
    ///
    /// Refuses any log that does not contain the tombstoned tip, which is what
    /// stops an empty relay from talking a client into a shorter history.
    #[wasm_bindgen(js_name = checkTombstone)]
    pub fn check_tombstone(&self, tombstone: &[u8]) -> Result<(), JsError> {
        Tombstone::decode(tombstone)
            .map_err(log_err)?
            .check_extends(&self.entries)
            .map_err(log_err)
    }
}

/// The result of decrypting a log.
#[wasm_bindgen]
pub struct Replay {
    moves: Vec<Vec<u8>>,
    config: Option<Vec<u8>>,
    resigned_by: Option<u8>,
}

#[wasm_bindgen]
impl Replay {
    /// Moves in order, ready to hand to the plugin worker.
    #[wasm_bindgen(getter)]
    pub fn moves(&self) -> js_sys::Array {
        let out = js_sys::Array::new();
        for mv in &self.moves {
            out.push(&js_sys::Uint8Array::from(&mv[..]).into());
        }
        out
    }

    #[wasm_bindgen(getter, js_name = moveCount)]
    pub fn move_count(&self) -> u32 {
        self.moves.len() as u32
    }

    #[wasm_bindgen(getter)]
    pub fn config(&self) -> Option<Vec<u8>> {
        self.config.clone()
    }

    /// Player index of whoever resigned, or `undefined` if nobody did.
    #[wasm_bindgen(getter, js_name = resignedBy)]
    pub fn resigned_by(&self) -> Option<u8> {
        self.resigned_by
    }

    /// Whose turn it is next, given how many moves have been played.
    #[wasm_bindgen(getter, js_name = nextToMove)]
    pub fn next_to_move(&self) -> u8 {
        if self.moves.len().is_multiple_of(2) {
            Role::Initiator.player_index()
        } else {
            Role::Claimer.player_index()
        }
    }
}

/// Builds the permanent record left when a game's ciphertext is evicted.
#[wasm_bindgen(js_name = encodeTombstone)]
pub fn encode_tombstone(
    game_id: &[u8],
    tip_hash: &[u8],
    participant_key_hashes: Vec<js_sys::Uint8Array>,
    timestamp: u64,
) -> Result<Vec<u8>, JsError> {
    let mut hashes = Vec::with_capacity(participant_key_hashes.len());
    for h in &participant_key_hashes {
        hashes.push(fixed::<32>(&h.to_vec(), "participant key hash")?);
    }

    Ok(Tombstone {
        game_id: fixed::<GAME_ID_LEN>(game_id, "gameId")?,
        tip_hash: fixed::<32>(tip_hash, "tipHash")?,
        participant_key_hashes: hashes,
        timestamp,
    }
    .encode())
}

// -- export -----------------------------------------------------------------

/// Encrypts a backup of every log plus the identity key.
///
/// The identity key is not optional: logs restored without it cannot be
/// verified or decrypted, so an export that left it out would restore nothing.
#[wasm_bindgen(js_name = exportBundle)]
pub fn export_bundle(
    passphrase: &str,
    bundle_json: &str,
    salt: &[u8],
    nonce: &[u8],
) -> Result<Vec<u8>, JsError> {
    let bundle: ExportBundle = serde_json_from_str(bundle_json)?;

    tabla_core::export::export(
        passphrase.as_bytes(),
        &bundle,
        &fixed::<16>(salt, "salt")?,
        &fixed::<NONCE_LEN>(nonce, "nonce")?,
        KdfParams::default(),
    )
    .map_err(crypto_err)
}

/// Decrypts a backup produced by [`export_bundle`].
#[wasm_bindgen(js_name = importBundle)]
pub fn import_bundle(passphrase: &str, bytes: &[u8]) -> Result<String, JsError> {
    let bundle = tabla_core::export::import(passphrase.as_bytes(), bytes).map_err(crypto_err)?;
    serde_json_to_string(&bundle)
}

fn serde_json_from_str<T: serde::de::DeserializeOwned>(s: &str) -> Result<T, JsError> {
    serde_json::from_str(s).map_err(|e| JsError::new(&format!("could not decode bundle: {e}")))
}

fn serde_json_to_string<T: serde::Serialize>(value: &T) -> Result<String, JsError> {
    serde_json::to_string(value).map_err(|e| JsError::new(&format!("could not encode bundle: {e}")))
}
