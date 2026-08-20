//! The shipped dictionary, pinned.
//!
//! `app/static/dict/en-v1.dawg` is a committed build artifact whose hash is
//! written into the invite of every word game, so both players can prove they
//! are playing the same rules. That makes it exactly like the frozen wire
//! vectors in `tabla-core`: a failure here is a bug report, not a prompt to
//! regenerate the fixture.
//!
//! If this test fails, either `wordlist/enable.txt` changed or the compiler in
//! `tabla-dawg` changed. Both are real events, and both need a new dictionary
//! id and a new pinned hash rather than a quiet overwrite — games already in
//! progress are still playing against the old one.

use std::path::{Path, PathBuf};

use tabla_dawg::{Dawg, build::compile};

/// SHA-256 of `app/static/dict/en-v1.dawg`. Also pinned in
/// `shared/src/constants.ts`, where the app checks it before handing the bytes
/// to the sandbox.
const DICT_SHA256: &str = "492410d02d6c346bba503cae0483202554d1d36f8e8c5a3d21faa956398a2346";

/// SHA-256 of `wordlist/enable.txt`, recorded in `wordlist/PROVENANCE.md`.
const WORDLIST_SHA256: &str = "3f16130220645692ed49c7134e24a18504c2ca55b3c012f7290e3e77c63b1a89";

const WORDS: u32 = 172_823;

fn repo_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .ancestors()
        .nth(3)
        .expect("crates/tabla-dawg is three levels below the repository root")
        .to_path_buf()
}

fn wordlist() -> String {
    std::fs::read_to_string(repo_root().join("wordlist/enable.txt")).expect("vendored word list")
}

fn artifact() -> Vec<u8> {
    std::fs::read(repo_root().join("app/static/dict/en-v1.dawg")).expect("committed dictionary")
}

/// SHA-256 without a dependency: this crate deliberately has none.
fn sha256_hex(bytes: &[u8]) -> String {
    let digest = sha256(bytes);
    digest.iter().map(|b| format!("{b:02x}")).collect()
}

#[test]
fn the_vendored_word_list_is_the_one_the_provenance_note_describes() {
    let text = wordlist();
    let words: Vec<&str> = text.lines().collect();

    assert_eq!(sha256_hex(text.as_bytes()), WORDLIST_SHA256);
    assert_eq!(words.len(), WORDS as usize);

    // The list is the rules, so it has to be exactly what the reader expects:
    // lowercase, sorted, no repeats, nothing shorter than a two-letter word.
    assert!(
        words
            .iter()
            .all(|w| w.len() >= 2 && w.bytes().all(|b| b.is_ascii_lowercase()))
    );
    assert!(words.windows(2).all(|pair| pair[0] < pair[1]));
}

#[test]
fn rebuilding_from_the_word_list_reproduces_the_committed_dictionary() {
    let text = wordlist();
    let words: Vec<&str> = text.lines().collect();

    let rebuilt = compile(&words).expect("the vendored list compiles");

    assert_eq!(
        sha256_hex(&rebuilt),
        DICT_SHA256,
        "rebuilding the dictionary did not reproduce the committed bytes"
    );
    assert_eq!(rebuilt, artifact());
}

#[test]
fn the_committed_dictionary_answers_for_every_word_in_the_list() {
    let bytes = artifact();
    let dawg = Dawg::parse(&bytes).expect("the committed dictionary parses");
    let text = wordlist();

    assert_eq!(dawg.word_count(), WORDS);
    for word in text.lines() {
        assert!(dawg.contains(word.as_bytes()), "missing: {word}");
    }
}

#[test]
fn the_committed_dictionary_rejects_things_that_are_not_words() {
    let bytes = artifact();
    let dawg = Dawg::parse(&bytes).expect("the committed dictionary parses");

    for word in [
        "qwertyuiop",
        "zzzzz",
        "thequickbrownfox",
        "xylophonic",
        "aa", // in the list, sanity check for the negatives below
    ] {
        let expected = word == "aa";
        assert_eq!(dawg.contains(word.as_bytes()), expected, "wrong for {word}");
    }
}

// -- a minimal SHA-256, so this crate keeps its empty dependency list ---------

const K: [u32; 64] = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
];

fn sha256(data: &[u8]) -> [u8; 32] {
    let mut h: [u32; 8] = [
        0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab,
        0x5be0cd19,
    ];

    let mut message = data.to_vec();
    let bits = (data.len() as u64) * 8;
    message.push(0x80);
    while message.len() % 64 != 56 {
        message.push(0);
    }
    message.extend_from_slice(&bits.to_be_bytes());

    for block in message.as_chunks::<64>().0 {
        let mut w = [0u32; 64];
        for (i, chunk) in block.as_chunks::<4>().0.iter().enumerate() {
            w[i] = u32::from_be_bytes(*chunk);
        }
        for i in 16..64 {
            let s0 = w[i - 15].rotate_right(7) ^ w[i - 15].rotate_right(18) ^ (w[i - 15] >> 3);
            let s1 = w[i - 2].rotate_right(17) ^ w[i - 2].rotate_right(19) ^ (w[i - 2] >> 10);
            w[i] = w[i - 16]
                .wrapping_add(s0)
                .wrapping_add(w[i - 7])
                .wrapping_add(s1);
        }

        let [mut a, mut b, mut c, mut d, mut e, mut f, mut g, mut hh] = h;
        for i in 0..64 {
            let s1 = e.rotate_right(6) ^ e.rotate_right(11) ^ e.rotate_right(25);
            let ch = (e & f) ^ ((!e) & g);
            let t1 = hh
                .wrapping_add(s1)
                .wrapping_add(ch)
                .wrapping_add(K[i])
                .wrapping_add(w[i]);
            let s0 = a.rotate_right(2) ^ a.rotate_right(13) ^ a.rotate_right(22);
            let maj = (a & b) ^ (a & c) ^ (b & c);
            let t2 = s0.wrapping_add(maj);

            hh = g;
            g = f;
            f = e;
            e = d.wrapping_add(t1);
            d = c;
            c = b;
            b = a;
            a = t1.wrapping_add(t2);
        }

        for (slot, value) in h.iter_mut().zip([a, b, c, d, e, f, g, hh]) {
            *slot = slot.wrapping_add(value);
        }
    }

    let mut out = [0u8; 32];
    for (chunk, value) in out.as_chunks_mut::<4>().0.iter_mut().zip(h) {
        *chunk = value.to_be_bytes();
    }
    out
}
