use super::*;

#[cfg(feature = "build")]
use crate::build::{BuildError, Builder, compile};

#[cfg(feature = "build")]
const TINY: &[&str] = &[
    "cat", "cats", "cot", "cots", "dog", "dogs", "do", "doge", "a", "an", "and",
];

#[cfg(feature = "build")]
fn tiny() -> Vec<u8> {
    compile(TINY).unwrap()
}

#[test]
fn an_empty_slice_is_not_a_word_list() {
    assert_eq!(Dawg::parse(&[]).unwrap_err(), DawgError::BadMagic);
    assert_eq!(Dawg::parse(b"nope").unwrap_err(), DawgError::BadMagic);
}

#[cfg(feature = "build")]
mod round_trip {
    use super::*;

    #[test]
    fn every_word_that_went_in_comes_back_out() {
        let bytes = tiny();
        let dawg = Dawg::parse(&bytes).unwrap();

        for word in TINY {
            assert!(dawg.contains(word.as_bytes()), "missing: {word}");
        }
        assert_eq!(dawg.word_count(), TINY.len() as u32);
    }

    #[test]
    fn words_that_did_not_go_in_are_absent() {
        let bytes = tiny();
        let dawg = Dawg::parse(&bytes).unwrap();

        // Prefixes of real words are the interesting negative case: `ca` walks
        // a real path and must still be rejected, because the edge that gets
        // there is not marked as ending a word.
        for word in ["ca", "c", "d", "catss", "dogx", "zebra", "andy"] {
            assert!(
                !dawg.contains(word.as_bytes()),
                "unexpectedly present: {word}"
            );
        }
    }

    #[test]
    fn nothing_but_lowercase_letters_is_a_word() {
        let bytes = tiny();
        let dawg = Dawg::parse(&bytes).unwrap();

        assert!(!dawg.contains(b""));
        assert!(!dawg.contains(b"CAT"));
        assert!(!dawg.contains(b"cat "));
        assert!(!dawg.contains("caté".as_bytes()));
    }

    #[test]
    fn suffixes_are_shared_rather_than_repeated() {
        // The point of a DAWG over a trie: `cats`, `cots` and `dogs` all end in
        // the same terminal `s`, so the graph must be smaller than the trie
        // that would hold each separately.
        let bytes = tiny();
        let dawg = Dawg::parse(&bytes).unwrap();

        let letters: usize = TINY.iter().map(|w| w.len()).sum();
        assert!(
            (dawg.unit_count as usize) < letters,
            "expected sharing: {} units for {letters} letters",
            dawg.unit_count
        );
    }

    #[test]
    fn the_same_words_always_produce_the_same_bytes() {
        // The committed dictionary is pinned by hash, so an unstable layout
        // would break the build rather than merely being untidy.
        assert_eq!(compile(TINY).unwrap(), compile(TINY).unwrap());

        let mut shuffled: Vec<&str> = TINY.to_vec();
        shuffled.reverse();
        assert_eq!(compile(TINY).unwrap(), compile(&shuffled).unwrap());
    }

    #[test]
    fn the_builder_insists_on_sorted_unique_lowercase_input() {
        let mut b = Builder::new();
        assert_eq!(b.insert(b"Cat").unwrap_err(), BuildError::NotLowercase);
        assert_eq!(b.insert(b"").unwrap_err(), BuildError::NotLowercase);

        b.insert(b"cat").unwrap();
        assert_eq!(b.insert(b"cat").unwrap_err(), BuildError::Duplicate);
        assert_eq!(b.insert(b"ant").unwrap_err(), BuildError::OutOfOrder);
    }

    #[test]
    fn a_single_word_list_works() {
        let bytes = compile(&["hello"]).unwrap();
        let dawg = Dawg::parse(&bytes).unwrap();

        assert!(dawg.contains(b"hello"));
        assert!(!dawg.contains(b"hell"));
        assert!(!dawg.contains(b"helloo"));
    }

    #[test]
    fn an_empty_list_answers_no_to_everything() {
        let bytes = Builder::new().finish().unwrap();
        let dawg = Dawg::parse(&bytes).unwrap();

        assert_eq!(dawg.word_count(), 0);
        assert!(!dawg.contains(b"anything"));
    }

    // -- corrupt input ------------------------------------------------------

    #[test]
    fn a_file_from_another_format_version_is_refused() {
        let mut bytes = tiny();
        bytes[4] = 9;

        assert_eq!(
            Dawg::parse(&bytes).unwrap_err(),
            DawgError::BadVersion { found: 9 }
        );
    }

    #[test]
    fn a_truncated_file_is_refused_rather_than_read_short() {
        let bytes = tiny();

        for cut in [HEADER_LEN, HEADER_LEN + 4, bytes.len() - 1] {
            assert_eq!(
                Dawg::parse(&bytes[..cut]).unwrap_err(),
                DawgError::Truncated
            );
        }
    }

    #[test]
    fn a_root_pointing_off_the_end_is_refused() {
        let mut bytes = tiny();
        bytes[12..16].copy_from_slice(&9999u32.to_le_bytes());

        assert_eq!(Dawg::parse(&bytes).unwrap_err(), DawgError::BadRoot);
    }

    #[test]
    fn a_corrupt_graph_answers_no_instead_of_crashing() {
        // Every unit body scrambled, header left intact: the reader is now
        // walking nonsense and must still terminate and stay in bounds.
        let mut bytes = tiny();
        for (i, byte) in bytes[HEADER_LEN..].iter_mut().enumerate() {
            *byte ^= (i as u8).wrapping_mul(37).wrapping_add(11);
        }

        let dawg = Dawg::parse(&bytes).unwrap();
        for word in TINY {
            let _ = dawg.contains(word.as_bytes());
        }
        for word in ["zzzzzzzz", "a", "qqq"] {
            let _ = dawg.contains(word.as_bytes());
        }
    }

    #[test]
    fn a_child_index_past_the_end_answers_no() {
        let mut bytes = tiny();
        // Point the first unit's child at a node that does not exist.
        let unit = u32::from_le_bytes(bytes[HEADER_LEN..HEADER_LEN + 4].try_into().unwrap());
        let broken = (unit & 0x7f) | (0x00ff_ffffu32 << 7);
        bytes[HEADER_LEN..HEADER_LEN + 4].copy_from_slice(&broken.to_le_bytes());

        let dawg = Dawg::parse(&bytes).unwrap();
        for word in TINY {
            let _ = dawg.contains(word.as_bytes());
        }
    }
}
