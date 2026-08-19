use super::*;

const GAME: [u8; GAME_ID_LEN] = *b"tabla-test-game1";

fn key(seed: u8) -> SigningKey {
    SigningKey::from_bytes(&[seed; 32])
}

/// The two participants used throughout: `a` initiates, `b` claims.
fn pair() -> (SigningKey, SigningKey, Participants) {
    let a = key(1);
    let b = key(2);
    let p = Participants::new(&[a.verifying_key(), b.verifying_key()]);
    (a, b, p)
}

/// Builds a valid chain, alternating authors, starting from genesis.
fn chain(a: &SigningKey, b: &SigningKey, n: u32) -> Vec<Entry> {
    let mut entries = Vec::new();
    let mut prev = GENESIS_PREV_HASH;
    for seq in 0..n {
        let signer = if seq % 2 == 0 { a } else { b };
        let payload = alloc_payload(seq);
        let e = Entry::sign(signer, seq, prev, GAME, payload);
        prev = e.hash();
        entries.push(e);
    }
    entries
}

fn alloc_payload(seq: u32) -> Vec<u8> {
    format!("ciphertext-{seq}").into_bytes()
}

#[test]
fn preimage_has_the_documented_layout() {
    let a = key(1);
    let e = Entry::sign(&a, 7, [0xAB; 32], GAME, b"xyz".to_vec());
    let p = e.preimage();

    assert_eq!(&p[0..12], LOG_DOMAIN);
    assert_eq!(&p[12..16], &7u32.to_le_bytes());
    assert_eq!(&p[16..48], &[0xAB; 32]);
    assert_eq!(&p[48..64], &GAME);
    assert_eq!(&p[64..96], &key_hash(&a.verifying_key().to_bytes()));
    assert_eq!(&p[96..100], &3u32.to_le_bytes());
    assert_eq!(&p[100..103], b"xyz");
    assert_eq!(p.len(), PREIMAGE_HEADER_LEN + 3);
}

#[test]
fn entry_round_trips_through_the_wire_form() {
    let a = key(1);
    let e = Entry::sign(&a, 3, [9; 32], GAME, b"payload".to_vec());
    let bytes = e.encode();

    assert_eq!(bytes.len(), PREIMAGE_HEADER_LEN + 7 + SIG_LEN);
    assert_eq!(Entry::decode(&bytes).unwrap(), e);
}

#[test]
fn empty_payload_is_valid() {
    let a = key(1);
    let e = Entry::sign(&a, 0, GENESIS_PREV_HASH, GAME, Vec::new());
    let bytes = e.encode();
    assert_eq!(bytes.len(), MIN_ENTRY_LEN);
    assert_eq!(Entry::decode(&bytes).unwrap(), e);
    e.verify_signature(&a.verifying_key()).unwrap();
}

#[test]
fn decode_rejects_malformed_bytes() {
    let a = key(1);
    let good = Entry::sign(&a, 0, GENESIS_PREV_HASH, GAME, b"hi".to_vec()).encode();

    assert_eq!(
        Entry::decode(&good[..MIN_ENTRY_LEN - 1]),
        Err(LogError::Truncated)
    );

    // Declared payload length no longer matches the byte count.
    let mut wrong_len = good.clone();
    wrong_len[96..100].copy_from_slice(&99u32.to_le_bytes());
    assert_eq!(Entry::decode(&wrong_len), Err(LogError::LengthMismatch));

    // An absurd length is rejected before any allocation.
    let mut huge = good.clone();
    huge[96..100].copy_from_slice(&u32::MAX.to_le_bytes());
    assert_eq!(Entry::decode(&huge), Err(LogError::PayloadTooLarge));

    let mut bad_domain = good.clone();
    bad_domain[0] = b'X';
    assert_eq!(Entry::decode(&bad_domain), Err(LogError::BadDomain));
}

#[test]
fn valid_chain_verifies_and_reports_its_tip() {
    let (a, b, p) = pair();
    let entries = chain(&a, &b, 5);

    let tip = verify_chain(&entries, &GAME, &p).unwrap().unwrap();
    assert_eq!(tip.seq, 4);
    assert_eq!(tip.hash, entries[4].hash());
}

#[test]
fn empty_log_has_no_tip() {
    let (_, _, p) = pair();
    assert_eq!(verify_chain(&[], &GAME, &p).unwrap(), None);
}

#[test]
fn tampering_with_a_payload_breaks_the_signature() {
    let (a, b, p) = pair();
    let mut entries = chain(&a, &b, 3);
    entries[1].payload[0] ^= 0xFF;

    assert_eq!(
        verify_chain(&entries, &GAME, &p),
        Err(LogError::BadSignature)
    );
}

#[test]
fn tampering_with_a_payload_also_breaks_the_chain_downstream() {
    let (a, b, p) = pair();
    let mut entries = chain(&a, &b, 3);

    // Re-sign the tampered entry so the signature is valid again. The hash it
    // produces no longer matches what entry 2 recorded as its prevHash, so the
    // forgery is still caught.
    entries[1] = Entry::sign(&b, 1, entries[1].header.prev_hash, GAME, b"forged".to_vec());

    assert_eq!(
        verify_chain(&entries, &GAME, &p),
        Err(LogError::ChainBreak { seq: 2 })
    );
}

#[test]
fn reordering_entries_is_rejected() {
    let (a, b, p) = pair();
    let mut entries = chain(&a, &b, 4);
    entries.swap(1, 2);

    assert_eq!(
        verify_chain(&entries, &GAME, &p),
        Err(LogError::SeqGap {
            expected: 1,
            found: 2
        })
    );
}

#[test]
fn dropping_an_entry_is_rejected() {
    let (a, b, p) = pair();
    let mut entries = chain(&a, &b, 4);
    entries.remove(2);

    assert_eq!(
        verify_chain(&entries, &GAME, &p),
        Err(LogError::SeqGap {
            expected: 2,
            found: 3
        })
    );
}

#[test]
fn a_fork_produces_a_different_tip() {
    let (a, b, _) = pair();
    let base = chain(&a, &b, 3);

    let fork = Entry::sign(&b, 3, base[2].hash(), GAME, b"one".to_vec());
    let other = Entry::sign(&b, 3, base[2].hash(), GAME, b"two".to_vec());

    assert_ne!(fork.hash(), other.hash());
}

#[test]
fn an_outsider_cannot_append() {
    let (a, b, p) = pair();
    let mut entries = chain(&a, &b, 2);
    let outsider = key(9);
    entries.push(Entry::sign(
        &outsider,
        2,
        entries[1].hash(),
        GAME,
        b"hi".to_vec(),
    ));

    assert_eq!(
        verify_chain(&entries, &GAME, &p),
        Err(LogError::UnknownAuthor)
    );
}

#[test]
fn an_entry_cannot_claim_an_author_it_did_not_sign_as() {
    let (a, b, p) = pair();
    let mut entry = Entry::sign(&a, 0, GENESIS_PREV_HASH, GAME, b"hi".to_vec());

    // Relabel the entry as authored by b. The signature no longer matches,
    // because the author hash is inside the preimage.
    entry.header.author_key_hash = key_hash(&b.verifying_key().to_bytes());

    assert_eq!(
        verify_chain(&[entry], &GAME, &p),
        Err(LogError::BadSignature)
    );
}

#[test]
fn entries_cannot_be_replayed_into_another_game() {
    let (a, b, p) = pair();
    let entries = chain(&a, &b, 2);
    let other_game = *b"tabla-other-game";

    assert_eq!(
        verify_chain(&entries, &other_game, &p),
        Err(LogError::WrongGame { seq: 0 })
    );
}

#[test]
fn genesis_must_have_a_zero_prev_hash() {
    let (a, _, p) = pair();
    let entry = Entry::sign(&a, 0, [1; 32], GAME, b"hi".to_vec());

    assert_eq!(verify_chain(&[entry], &GAME, &p), Err(LogError::BadGenesis));
}

#[test]
fn suffix_verification_extends_a_trusted_tip() {
    let (a, b, p) = pair();
    let entries = chain(&a, &b, 6);
    let (prefix, suffix) = entries.split_at(3);

    let tip = verify_chain(prefix, &GAME, &p).unwrap();
    let new_tip = verify_suffix(tip, suffix, &GAME, &p).unwrap().unwrap();

    assert_eq!(new_tip.seq, 5);
    assert_eq!(new_tip.hash, entries[5].hash());
}

#[test]
fn suffix_verification_rejects_a_gap() {
    let (a, b, p) = pair();
    let entries = chain(&a, &b, 6);
    let tip = verify_chain(&entries[..3], &GAME, &p).unwrap();

    assert_eq!(
        verify_suffix(tip, &entries[4..], &GAME, &p),
        Err(LogError::SeqGap {
            expected: 3,
            found: 4
        })
    );
}

#[test]
fn suffix_verification_rejects_a_different_history() {
    let (a, b, p) = pair();
    let ours = chain(&a, &b, 4);
    let theirs = chain(&b, &a, 4);
    let tip = verify_chain(&ours[..3], &GAME, &p).unwrap();

    assert_eq!(
        verify_suffix(tip, &theirs[3..], &GAME, &p),
        Err(LogError::ChainBreak { seq: 3 })
    );
}

// -- tombstones -------------------------------------------------------------

fn tombstone_for(entries: &[Entry], p: &Participants) -> Tombstone {
    Tombstone {
        game_id: GAME,
        tip_hash: entries.last().unwrap().hash(),
        participant_key_hashes: p.key_hashes().to_vec(),
        timestamp: 1_780_000_000,
    }
}

#[test]
fn tombstone_round_trips() {
    let (a, b, p) = pair();
    let entries = chain(&a, &b, 3);
    let t = tombstone_for(&entries, &p);

    let bytes = t.encode();
    assert_eq!(Tombstone::decode(&bytes).unwrap(), t);
    // Small enough to keep forever.
    assert!(bytes.len() < 200, "tombstone was {} bytes", bytes.len());
}

#[test]
fn tombstone_decode_rejects_trailing_bytes() {
    let (a, b, p) = pair();
    let t = tombstone_for(&chain(&a, &b, 2), &p);
    let mut bytes = t.encode();
    bytes.push(0);

    assert_eq!(Tombstone::decode(&bytes), Err(LogError::LengthMismatch));
}

#[test]
fn tombstone_accepts_the_exact_evicted_history() {
    let (a, b, p) = pair();
    let entries = chain(&a, &b, 4);
    tombstone_for(&entries, &p).check_extends(&entries).unwrap();
}

#[test]
fn tombstone_accepts_a_longer_history() {
    let (a, b, p) = pair();
    let full = chain(&a, &b, 6);
    // Evicted when the game was 4 entries long; the client kept playing offline.
    let t = tombstone_for(&full[..4], &p);

    t.check_extends(&full).unwrap();
}

#[test]
fn tombstone_refuses_a_rollback() {
    let (a, b, p) = pair();
    let full = chain(&a, &b, 6);
    let t = tombstone_for(&full, &p);

    // A truncated log would silently erase the last two moves.
    assert_eq!(
        t.check_extends(&full[..4]),
        Err(LogError::TombstoneNotFound)
    );
}

#[test]
fn tombstone_refuses_a_divergent_history() {
    let (a, b, p) = pair();
    let ours = chain(&a, &b, 5);
    let theirs = chain(&b, &a, 5);
    let t = tombstone_for(&ours, &p);

    assert_eq!(t.check_extends(&theirs), Err(LogError::TombstoneNotFound));
}

#[test]
fn tombstone_refuses_another_game() {
    let (a, b, p) = pair();
    let entries = chain(&a, &b, 3);
    let mut t = tombstone_for(&entries, &p);
    t.game_id = *b"tabla-other-game";

    assert_eq!(t.check_extends(&entries), Err(LogError::TombstoneWrongGame));
}
