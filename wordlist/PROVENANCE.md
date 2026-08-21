# Where the word list comes from

`enable.txt` is **ENABLE** — the Enhanced North American Benchmark Lexicon,
assembled by Alan Beale and Mendel Cooper and released by its authors into the
**public domain**. It is the list behind a great many open word games and word
tools, and it can be redistributed and modified without permission or
attribution.

| | |
|---|---|
| File | `enable.txt` (specifically `enable1.txt`) |
| Words | 172,823 |
| Character set | lowercase ASCII `a`–`z`, one word per line, sorted |
| Lengths | 2–28 letters |
| SHA-256 | `3f16130220645692ed49c7134e24a18504c2ca55b3c012f7290e3e77c63b1a89` |
| Obtained from | <https://github.com/dolph/dictionary> (`enable1.txt`), a mirror of the original release |
| Licence | Public domain |

The file is vendored here rather than fetched at build time so that the build
is reproducible and the exact bytes that became the shipped dictionary are in
version control next to the hash that pins them.

## Word lists this project will not use

**TWL/NWL** (the North American tournament list) and **Collins/CSW** (the
international one) are proprietary. They are owned and licensed by Hasbro,
Mattel, and Collins respectively, and using them in a released game requires a
licence regardless of how the file was obtained. They must never appear in this
repository, in a build, or in a downloadable dictionary pack.

**SCOWL** (MIT-like) would also have been acceptable and is the reasonable
fallback if ENABLE ever proves unsuitable — it is more configurable, offering
size and dialect tiers. ENABLE was chosen because it is a single fixed list
with the simplest possible licensing story, and a fixed list is what a hash pin
wants.

## How the shipped dictionary is produced

```
just dict
```

which runs `tabla-dawg`'s builder over this file and writes
`app/static/dict/en-v1.dawg`. That artifact is committed, and its hash is
pinned in two places — `shared/src/constants.ts` and the Rust golden test — so
a dictionary that does not match the one both players agreed to in their invite
is rejected rather than silently producing a game where the two sides disagree
about which words are real.

Rebuilding from this file must reproduce the committed artifact byte for byte.
A golden test asserts exactly that; if it fails, either the word list or the
compiler changed, and both are events that need a version bump rather than a
regenerated fixture.

## Changing the word list

Do not edit `enable.txt`. A word list is part of the rules: two clients running
different lists will disagree about whether a challenged word is valid, which is
unrecoverable mid-game. A new or amended list ships as a **new file with a new
id** (`en-v2`, say) and a new pinned hash, and old games keep playing against
the list they started with.

## The list device links are spoken in

`bip39-english.txt` is the **BIP-39 English wordlist**, from
[bitcoin/bips](https://github.com/bitcoin/bips) (`bip-0039/english.txt`), where
BIP-0039 is published under the **BSD 2-Clause** licence.

| | |
|---|---|
| File | `bip39-english.txt` |
| Words | 2,048 |
| Character set | lowercase ASCII `a`–`z`, one word per line, sorted |
| Lengths | 3–8 letters |
| SHA-256 | `2f5eed53a4727b4bf8880d8f3f199efc90e58503646d9ff8eff3a2ed3b24dbda` |
| Licence | BSD 2-Clause |

It has nothing to do with the word game and is never played against. It is the
alphabet a device link is spoken in: six of these words carry 66 bits, which is
both the key the bundle is encrypted under and the name of the place it is left.

The curation is the reason to use this list rather than draw 2,048 words out of
ENABLE. Every word here is four to eight letters, no two share their first four
letters — so a word can be recognised, and a typo detected, before it is
finished — and the list was deliberately picked over for words that sound alike
and words nobody would want to read aloud to someone else. None of that falls
out of a large lexicon on its own.

`scripts/build-link-words.mjs` turns it into the module the app ships, and
`app/src/lib/link-words.test.ts` re-checks the properties above against the
generated list rather than trusting this description of it.
