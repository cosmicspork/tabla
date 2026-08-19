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
