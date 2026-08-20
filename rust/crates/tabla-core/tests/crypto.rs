//! Behavioural tests for identity, key agreement, sealing, sessions, invites,
//! and the export format.

use tabla_core::error::CryptoError;
use tabla_core::export::{Contact, ExportBundle, GameExport, KdfParams, export, import};
use tabla_core::identity::{Identity, parse_public_key};
use tabla_core::invite::{InviteConfig, sign_claim, verify_claim};
use tabla_core::kex::{agree_game_key, kex_salt, shared_secret};
use tabla_core::log::{Entry, GENESIS_PREV_HASH, verify_chain};
use tabla_core::seal::{open, seal};
use tabla_core::session::{EntryBody, Role, Session, SessionError};
use tabla_core::{GAME_ID_LEN, NONCE_LEN};

const GAME: [u8; GAME_ID_LEN] = *b"tabla-crypto-g01";
const BLOB: [u8; 16] = *b"tabla-blob-id-01";

fn initiator() -> Identity {
    Identity::from_seed(&[0xA1; 32])
}

fn claimer() -> Identity {
    Identity::from_seed(&[0xC1; 32])
}

fn nonce(n: u8) -> [u8; NONCE_LEN] {
    [n; NONCE_LEN]
}

// -- identity ---------------------------------------------------------------

#[test]
fn identity_round_trips_through_its_seed() {
    let seed = [7u8; 32];
    let id = Identity::from_seed(&seed);

    assert_eq!(id.seed(), seed);
    assert_eq!(
        Identity::from_seed(&id.seed()).public_key(),
        id.public_key()
    );
}

#[test]
fn identity_debug_never_prints_the_seed() {
    let id = Identity::from_seed(&[0x5A; 32]);
    let rendered = format!("{id:?}");

    assert!(
        !rendered.contains("5a5a5a5a5a5a"),
        "debug output leaked key material: {rendered}"
    );
    assert!(rendered.contains("Identity"));
}

#[test]
fn a_public_key_that_is_not_on_the_curve_is_rejected() {
    // y = 2 has no corresponding x on the curve, so this does not decompress.
    let mut bad = [0u8; 32];
    bad[0] = 2;

    assert_eq!(parse_public_key(&bad), Err(CryptoError::BadPublicKey));
}

// -- key agreement ----------------------------------------------------------

#[test]
fn both_participants_derive_the_same_game_key() {
    let (a, b) = (initiator(), claimer());

    let key_a = agree_game_key(&a, &b.verifying_key(), &BLOB, &GAME);
    let key_b = agree_game_key(&b, &a.verifying_key(), &BLOB, &GAME);

    assert_eq!(key_a, key_b);
}

#[test]
fn the_salt_does_not_depend_on_who_initiated() {
    let (a, b) = (initiator().public_key(), claimer().public_key());

    assert_eq!(kex_salt(&BLOB, &a, &b), kex_salt(&BLOB, &b, &a));
}

#[test]
fn each_game_gets_a_distinct_key() {
    let (a, b) = (initiator(), claimer());
    let other_game = *b"tabla-crypto-g02";

    let k1 = agree_game_key(&a, &b.verifying_key(), &BLOB, &GAME);
    let k2 = agree_game_key(&a, &b.verifying_key(), &BLOB, &other_game);

    assert_ne!(k1, k2);
}

#[test]
fn each_invite_gets_a_distinct_key() {
    let (a, b) = (initiator(), claimer());
    let other_blob = *b"tabla-blob-id-02";

    let k1 = agree_game_key(&a, &b.verifying_key(), &BLOB, &GAME);
    let k2 = agree_game_key(&a, &b.verifying_key(), &other_blob, &GAME);

    assert_ne!(k1, k2);
}

#[test]
fn a_third_party_derives_a_different_key() {
    let (a, b) = (initiator(), claimer());
    let eve = Identity::from_seed(&[0xEE; 32]);

    let real = agree_game_key(&a, &b.verifying_key(), &BLOB, &GAME);
    let evil = agree_game_key(&eve, &a.verifying_key(), &BLOB, &GAME);

    assert_ne!(real, evil);
}

#[test]
fn the_raw_shared_secret_is_symmetric() {
    let (a, b) = (initiator(), claimer());

    assert_eq!(
        shared_secret(&a, &b.verifying_key()),
        shared_secret(&b, &a.verifying_key())
    );
}

// -- sealing ----------------------------------------------------------------

#[test]
fn sealed_data_round_trips() {
    let key = [3u8; 32];
    let sealed = seal(&key, &nonce(1), b"aad", b"secret").unwrap();

    assert_eq!(&sealed[..NONCE_LEN], &nonce(1));
    assert_eq!(open(&key, b"aad", &sealed).unwrap(), b"secret");
}

#[test]
fn opening_with_the_wrong_key_fails() {
    let sealed = seal(&[3u8; 32], &nonce(1), b"aad", b"secret").unwrap();
    assert_eq!(open(&[4u8; 32], b"aad", &sealed), Err(CryptoError::Decrypt));
}

#[test]
fn opening_with_the_wrong_aad_fails() {
    let key = [3u8; 32];
    let sealed = seal(&key, &nonce(1), b"aad", b"secret").unwrap();
    assert_eq!(open(&key, b"different", &sealed), Err(CryptoError::Decrypt));
}

#[test]
fn tampered_ciphertext_fails() {
    let key = [3u8; 32];
    let mut sealed = seal(&key, &nonce(1), b"aad", b"secret").unwrap();
    let last = sealed.len() - 1;
    sealed[last] ^= 0xFF;

    assert_eq!(open(&key, b"aad", &sealed), Err(CryptoError::Decrypt));
}

#[test]
fn truncated_ciphertext_is_rejected_cleanly() {
    assert_eq!(
        open(&[3u8; 32], b"aad", b"short"),
        Err(CryptoError::Truncated)
    );
}

// -- sessions ---------------------------------------------------------------

fn session_for(a: &Identity, b: &Identity) -> Session {
    let key = agree_game_key(a, &b.verifying_key(), &BLOB, &GAME);
    Session::new(GAME, key, a.verifying_key(), b.verifying_key())
}

/// Builds a valid game: join, setup, then alternating moves from the initiator.
fn play(a: &Identity, b: &Identity, moves: &[&[u8]]) -> (Session, Vec<Entry>) {
    let s = session_for(a, b);
    let mut entries = Vec::new();
    let mut prev = GENESIS_PREV_HASH;

    let append = |body: &EntryBody, seq: u32, who: &Identity, prev: &mut [u8; 32]| {
        let payload = s.seal_body(seq, &nonce(seq as u8), body).unwrap();
        let e = Entry::sign(who.signing_key(), seq, *prev, GAME, payload);
        *prev = e.hash();
        e
    };

    entries.push(append(
        &EntryBody::Join {
            claimer_pub_key: b.public_key(),
        },
        0,
        b,
        &mut prev,
    ));
    entries.push(append(
        &EntryBody::Setup {
            config: b"cfg".to_vec(),
        },
        1,
        a,
        &mut prev,
    ));

    for (i, mv) in moves.iter().enumerate() {
        let seq = 2 + i as u32;
        let who = if seq.is_multiple_of(2) { a } else { b };
        entries.push(append(&EntryBody::Move(mv.to_vec()), seq, who, &mut prev));
    }

    (session_for(a, b), entries)
}

#[test]
fn a_body_round_trips_at_its_own_position() {
    let s = session_for(&initiator(), &claimer());
    let body = EntryBody::Move(b"e4".to_vec());

    let sealed = s.seal_body(5, &nonce(5), &body).unwrap();
    assert_eq!(s.open_body(5, &sealed).unwrap(), body);
}

#[test]
fn a_body_cannot_be_moved_to_another_position() {
    let s = session_for(&initiator(), &claimer());
    let sealed = s.seal_body(5, &nonce(5), &EntryBody::Resign).unwrap();

    // The AAD binds the payload to sequence 5.
    assert_eq!(s.open_body(6, &sealed), Err(CryptoError::Decrypt));
}

#[test]
fn the_opponent_can_read_what_we_sealed() {
    let (a, b) = (initiator(), claimer());
    let ours = session_for(&a, &b);
    let theirs = Session::new(
        GAME,
        agree_game_key(&b, &a.verifying_key(), &BLOB, &GAME),
        a.verifying_key(),
        b.verifying_key(),
    );

    let sealed = ours
        .seal_body(3, &nonce(3), &EntryBody::Move(b"x".to_vec()))
        .unwrap();
    assert_eq!(
        theirs.open_body(3, &sealed).unwrap(),
        EntryBody::Move(b"x".to_vec())
    );
}

#[test]
fn a_full_game_replays_cleanly() {
    let (a, b) = (initiator(), claimer());
    let (s, entries) = play(&a, &b, &[b"m0", b"m1", b"m2"]);

    // Structural verification first, exactly as a client does.
    verify_chain(&entries, &GAME, s.participants())
        .unwrap()
        .unwrap();

    let replayed = s.replay(&entries).unwrap();
    assert_eq!(
        replayed.moves,
        vec![b"m0".to_vec(), b"m1".to_vec(), b"m2".to_vec()]
    );
    assert_eq!(replayed.config.as_deref(), Some(&b"cfg"[..]));
    assert_eq!(replayed.resigned_by, None);
}

#[test]
fn the_initiator_moves_first() {
    assert_eq!(Session::expected_author(0), Role::Claimer);
    assert_eq!(Session::expected_author(1), Role::Initiator);
    assert_eq!(Session::expected_author(2), Role::Initiator);
    assert_eq!(Session::expected_author(3), Role::Claimer);
    assert_eq!(Session::expected_author(4), Role::Initiator);
}

#[test]
fn moving_out_of_turn_is_rejected() {
    let (a, b) = (initiator(), claimer());
    let s = session_for(&a, &b);
    let (_, mut entries) = play(&a, &b, &[b"m0"]);

    // The initiator tries to move twice in a row.
    let payload = s
        .seal_body(3, &nonce(3), &EntryBody::Move(b"again".to_vec()))
        .unwrap();
    entries.push(Entry::sign(
        a.signing_key(),
        3,
        entries[2].hash(),
        GAME,
        payload,
    ));

    assert_eq!(s.replay(&entries), Err(SessionError::OutOfTurn { seq: 3 }));
}

#[test]
fn resigning_out_of_turn_is_allowed() {
    let (a, b) = (initiator(), claimer());
    let s = session_for(&a, &b);
    let (_, mut entries) = play(&a, &b, &[b"m0"]);

    // Sequence 3 belongs to the claimer, and the claimer resigns there — but the
    // point is that a resignation is accepted whoever's turn it is.
    let payload = s.seal_body(3, &nonce(3), &EntryBody::Resign).unwrap();
    entries.push(Entry::sign(
        b.signing_key(),
        3,
        entries[2].hash(),
        GAME,
        payload,
    ));

    let replayed = s.replay(&entries).unwrap();
    assert_eq!(replayed.resigned_by, Some(Role::Claimer));
}

#[test]
fn the_initiator_may_resign_on_the_opponents_turn() {
    let (a, b) = (initiator(), claimer());
    let s = session_for(&a, &b);
    let (_, mut entries) = play(&a, &b, &[b"m0"]);

    let payload = s.seal_body(3, &nonce(3), &EntryBody::Resign).unwrap();
    entries.push(Entry::sign(
        a.signing_key(),
        3,
        entries[2].hash(),
        GAME,
        payload,
    ));

    assert_eq!(
        s.replay(&entries).unwrap().resigned_by,
        Some(Role::Initiator)
    );
}

#[test]
fn nothing_may_follow_a_resignation() {
    let (a, b) = (initiator(), claimer());
    let s = session_for(&a, &b);
    let (_, mut entries) = play(&a, &b, &[b"m0"]);

    let resign = s.seal_body(3, &nonce(3), &EntryBody::Resign).unwrap();
    entries.push(Entry::sign(
        b.signing_key(),
        3,
        entries[2].hash(),
        GAME,
        resign,
    ));

    let after = s
        .seal_body(4, &nonce(4), &EntryBody::Move(b"no".to_vec()))
        .unwrap();
    entries.push(Entry::sign(
        a.signing_key(),
        4,
        entries[3].hash(),
        GAME,
        after,
    ));

    assert_eq!(
        s.replay(&entries),
        Err(SessionError::PlayAfterResign { seq: 4 })
    );
}

#[test]
fn a_join_naming_the_wrong_key_is_rejected() {
    let (a, b) = (initiator(), claimer());
    let s = session_for(&a, &b);
    let eve = Identity::from_seed(&[0xEE; 32]);

    let payload = s
        .seal_body(
            0,
            &nonce(0),
            &EntryBody::Join {
                claimer_pub_key: eve.public_key(),
            },
        )
        .unwrap();
    let entry = Entry::sign(b.signing_key(), 0, GENESIS_PREV_HASH, GAME, payload);

    assert_eq!(s.replay(&[entry]), Err(SessionError::JoinKeyMismatch));
}

#[test]
fn a_prologue_in_the_wrong_order_is_rejected() {
    let (a, b) = (initiator(), claimer());
    let s = session_for(&a, &b);

    // Setup at sequence 0, where a Join belongs.
    let payload = s
        .seal_body(0, &nonce(0), &EntryBody::Setup { config: vec![] })
        .unwrap();
    let entry = Entry::sign(a.signing_key(), 0, GENESIS_PREV_HASH, GAME, payload);

    assert_eq!(
        s.replay(&[entry]),
        Err(SessionError::MalformedPrologue { seq: 0 })
    );
}

#[test]
fn an_undecryptable_entry_is_reported_not_ignored() {
    let (a, b) = (initiator(), claimer());
    let (s, mut entries) = play(&a, &b, &[b"m0"]);

    entries[2].payload[NONCE_LEN + 1] ^= 0xFF;
    // Re-sign so the structural layer passes and the failure is genuinely the
    // semantic one we are testing.
    entries[2] = Entry::sign(
        a.signing_key(),
        2,
        entries[1].hash(),
        GAME,
        entries[2].payload.clone(),
    );

    assert_eq!(
        s.replay(&entries),
        Err(SessionError::Undecryptable { seq: 2 })
    );
}

#[test]
fn a_claimer_may_introduce_itself_by_name() {
    let (a, b) = (&initiator(), &claimer());
    let s = session_for(a, b);
    let mut entries = Vec::new();
    let mut prev = GENESIS_PREV_HASH;

    let mut append = |body: &EntryBody, seq: u32, who: &Identity, prev: &mut [u8; 32]| {
        let payload = s.seal_body(seq, &nonce(seq as u8), body).unwrap();
        let e = Entry::sign(who.signing_key(), seq, *prev, GAME, payload);
        *prev = e.hash();
        entries.push(e);
    };

    append(
        &EntryBody::JoinAs {
            claimer_pub_key: b.public_key(),
            name: "Pooja".into(),
        },
        0,
        b,
        &mut prev,
    );
    append(
        &EntryBody::Setup {
            config: b"cfg".to_vec(),
        },
        1,
        a,
        &mut prev,
    );

    let replayed = s.replay(&entries).unwrap();
    // The initiator learns it from the log, never from the relay.
    assert_eq!(replayed.claimer_name.as_deref(), Some("Pooja"));
}

#[test]
fn a_named_join_still_has_to_be_the_key_the_game_is_bound_to() {
    // A name is a label, and labels prove nothing: the same check applies.
    let (a, b) = (&initiator(), &claimer());
    let s = session_for(a, b);
    let stranger = Identity::from_seed(&[0x5A; 32]);

    let payload = s
        .seal_body(
            0,
            &nonce(0),
            &EntryBody::JoinAs {
                claimer_pub_key: stranger.public_key(),
                name: "Pooja".into(),
            },
        )
        .unwrap();
    let entry = Entry::sign(b.signing_key(), 0, GENESIS_PREV_HASH, GAME, payload);

    assert_eq!(s.replay(&[entry]), Err(SessionError::JoinKeyMismatch));
    let _ = a;
}

#[test]
fn a_game_begun_before_names_replays_unchanged() {
    // Every game in progress has an unnamed Join at sequence 0. Reading those
    // is not optional, which is why the name is a new variant rather than a
    // field on the old one.
    let (a, b) = (&initiator(), &claimer());
    let (session, entries) = play(a, b, &[b"one", b"two"]);

    let replayed = session.replay(&entries).unwrap();
    assert_eq!(replayed.moves.len(), 2);
    assert_eq!(replayed.claimer_name, None);
}

// -- invites ----------------------------------------------------------------

fn config_for(a: &Identity) -> InviteConfig {
    InviteConfig {
        v: tabla_core::invite::INVITE_VERSION,
        game_id: GAME,
        plugin_id: "tictactoe".into(),
        plugin_version: 1,
        dictionary_hash: None,
        initiator_pub_key: a.public_key(),
        seed: [9u8; 32],
        created_at: 1_780_000_000,
        name: "Ada".into(),
    }
}

/// The exact shape version 1 had, so a blob written by that build can be
/// constructed here without that build being present.
#[derive(serde::Serialize)]
struct InviteConfigV1Fixture {
    v: u16,
    game_id: [u8; 16],
    plugin_id: String,
    plugin_version: u32,
    dictionary_hash: Option<[u8; 32]>,
    initiator_pub_key: [u8; 32],
    seed: [u8; 32],
    created_at: u64,
}

#[test]
fn an_invite_from_before_names_still_opens() {
    // Seven days of invites are in the wild at any moment. A field added to the
    // format must not turn one of them into a dead link.
    let a = initiator();
    let old = InviteConfigV1Fixture {
        v: 1,
        game_id: GAME,
        plugin_id: "tictactoe".into(),
        plugin_version: 1,
        dictionary_hash: None,
        initiator_pub_key: a.public_key(),
        seed: [9u8; 32],
        created_at: 1_780_000_000,
    };

    let key = [0x2B; 32];
    let plaintext = postcard::to_allocvec(&old).unwrap();
    let blob = tabla_core::seal::seal(&key, &nonce(1), tabla_core::invite::INVITE_AAD, &plaintext)
        .unwrap();

    let opened = InviteConfig::open(&key, &blob).unwrap();
    assert_eq!(opened.plugin_id, "tictactoe");
    assert_eq!(opened.initiator_pub_key, a.public_key());
    // Nobody was called anything then, and pretending otherwise would be worse
    // than an empty name.
    assert_eq!(opened.name, "");
}

#[test]
fn a_name_longer_than_the_limit_is_cut_rather_than_refused() {
    // Refused would mean a link that fails at the far end, for the person who
    // did not choose the name.
    let cleaned = InviteConfig::clean_name(&"a".repeat(200));
    assert_eq!(cleaned.len(), tabla_core::invite::MAX_NAME_LEN);
    assert_eq!(InviteConfig::clean_name("  Ada  "), "Ada");
}

#[test]
fn an_invite_round_trips_under_its_fragment_key() {
    let cfg = config_for(&initiator());
    let key = [0x2B; 32];

    let blob = cfg.seal(&key, &nonce(1)).unwrap();
    assert_eq!(InviteConfig::open(&key, &blob).unwrap(), cfg);
}

#[test]
fn an_invite_is_opaque_without_the_fragment_key() {
    let blob = config_for(&initiator())
        .seal(&[0x2B; 32], &nonce(1))
        .unwrap();

    // This is what the relay holds. It cannot read it.
    assert_eq!(
        InviteConfig::open(&[0x2C; 32], &blob),
        Err(CryptoError::Decrypt)
    );
}

#[test]
fn a_mismatched_plugin_version_is_refused() {
    let cfg = config_for(&initiator());

    assert!(cfg.is_compatible("tictactoe", 1, None));
    assert!(!cfg.is_compatible("tictactoe", 2, None));
    assert!(!cfg.is_compatible("wordgame", 1, None));
    assert!(!cfg.is_compatible("tictactoe", 1, Some(&[1u8; 32])));
}

#[test]
fn a_claim_signature_verifies_for_its_own_invite() {
    let b = claimer();
    let sig = sign_claim(&b, &BLOB);

    verify_claim(&b.verifying_key(), &BLOB, &sig).unwrap();
}

#[test]
fn a_claim_signature_does_not_transfer_to_another_invite() {
    let b = claimer();
    let sig = sign_claim(&b, &BLOB);
    let other = *b"tabla-blob-id-99";

    assert_eq!(
        verify_claim(&b.verifying_key(), &other, &sig),
        Err(CryptoError::BadSignature)
    );
}

#[test]
fn a_claim_cannot_be_presented_under_someone_elses_key() {
    let sig = sign_claim(&claimer(), &BLOB);
    let eve = Identity::from_seed(&[0xEE; 32]);

    assert_eq!(
        verify_claim(&eve.verifying_key(), &BLOB, &sig),
        Err(CryptoError::BadSignature)
    );
}

// -- export -----------------------------------------------------------------

/// Deliberately weak parameters so the suite stays fast. Production uses
/// `KdfParams::default()`.
fn test_kdf() -> KdfParams {
    KdfParams {
        m_cost: 8,
        t_cost: 1,
        p_cost: 1,
    }
}

fn bundle() -> ExportBundle {
    let (a, b) = (initiator(), claimer());
    let (_, entries) = play(&a, &b, &[b"m0", b"m1"]);

    ExportBundle {
        v: 1,
        identity_seed: a.seed(),
        contacts: vec![Contact {
            public_key: b.public_key(),
            name: "opponent".into(),
            first_seen: 1_780_000_000,
        }],
        games: vec![GameExport {
            game_id: GAME,
            plugin_id: "tictactoe".into(),
            plugin_version: 1,
            initiator_pub_key: a.public_key(),
            claimer_pub_key: b.public_key(),
            blob_id: BLOB,
            seed: [9u8; 32],
            entries: entries.iter().map(|e| e.encode()).collect(),
        }],
        exported_at: 1_780_000_100,
    }
}

#[test]
fn an_export_round_trips() {
    let original = bundle();
    let file = export(
        b"correct horse",
        &original,
        &[1u8; 16],
        &nonce(2),
        test_kdf(),
    )
    .unwrap();

    assert_eq!(import(b"correct horse", &file).unwrap(), original);
}

#[test]
fn an_export_carries_the_identity_key() {
    // Without this the logs restore into a profile that cannot verify or
    // decrypt any of them, which is the same as restoring nothing.
    let original = bundle();
    let file = export(b"pw", &original, &[1u8; 16], &nonce(2), test_kdf()).unwrap();

    let restored = import(b"pw", &file).unwrap();
    assert_eq!(restored.identity().public_key(), initiator().public_key());
}

#[test]
fn a_restored_export_still_verifies_its_logs() {
    let file = export(b"pw", &bundle(), &[1u8; 16], &nonce(2), test_kdf()).unwrap();
    let restored = import(b"pw", &file).unwrap();

    let game = &restored.games[0];
    let entries: Vec<Entry> = game
        .entries
        .iter()
        .map(|e| Entry::decode(e).unwrap())
        .collect();

    let a = parse_public_key(&game.initiator_pub_key).unwrap();
    let b = parse_public_key(&game.claimer_pub_key).unwrap();
    let key = agree_game_key(&restored.identity(), &b, &game.blob_id, &game.game_id);
    let session = Session::new(game.game_id, key, a, b);

    verify_chain(&entries, &game.game_id, session.participants())
        .unwrap()
        .unwrap();
    assert_eq!(session.replay(&entries).unwrap().moves.len(), 2);
}

#[test]
fn the_wrong_passphrase_does_not_open_an_export() {
    let file = export(b"right", &bundle(), &[1u8; 16], &nonce(2), test_kdf()).unwrap();
    assert_eq!(import(b"wrong", &file), Err(CryptoError::Decrypt));
}

#[test]
fn export_parameters_travel_with_the_file() {
    // A file written with unusual parameters must still open on a build whose
    // defaults have since changed.
    let params = KdfParams {
        m_cost: 16,
        t_cost: 2,
        p_cost: 1,
    };
    let file = export(b"pw", &bundle(), &[2u8; 16], &nonce(3), params).unwrap();

    assert!(import(b"pw", &file).is_ok());
}

#[test]
fn a_file_that_is_not_an_export_is_rejected() {
    assert_eq!(
        import(b"pw", b"this is not a tabla export file at all, really"),
        Err(CryptoError::BadFormat)
    );
    assert_eq!(import(b"pw", b"short"), Err(CryptoError::Truncated));
}

#[test]
fn default_kdf_parameters_are_not_accidentally_weak() {
    let p = KdfParams::default();
    assert!(
        p.m_cost >= 19 * 1024,
        "memory cost regressed to {}",
        p.m_cost
    );
    assert!(p.t_cost >= 2);
}
