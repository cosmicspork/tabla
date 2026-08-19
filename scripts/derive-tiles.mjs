#!/usr/bin/env node
/**
 * Derives Letras' tile distribution and point values from the word list.
 *
 * The legal constraint is that the tile set must be original rather than a copy
 * of an existing game's. Deriving it mechanically from ENABLE's own letter
 * frequencies is the cleanest way to satisfy that: the numbers come from a
 * public-domain corpus by a stated rule, so they are original by construction
 * and demonstrably not copied from anywhere.
 *
 * It is also, on its own terms, the right way to build a tile set — the
 * distribution matches the letters players will actually need.
 *
 * Run with `node scripts/derive-tiles.mjs`; the output is pasted into
 * rust/crates/tabla-letras/src/tiles.rs, and a Rust test re-derives it from the
 * same word list so the constants can never drift from the method.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const LETTERS = 100;
const BLANKS = 2;
const ALPHABET = 'abcdefghijklmnopqrstuvwxyz'.split('');

/**
 * Point value by how many tiles a letter gets: common letters are cheap,
 * scarce ones are dear. The bands are a design choice; the counts that feed
 * them are not.
 */
function valueFor(count, rank) {
  // The two rarest letters in the corpus are worth more than scarcity alone
  // would suggest, so that a lucky draw is worth playing around.
  if (rank < 2) return 10;
  if (count >= 8) return 1;
  if (count >= 6) return 2;
  if (count >= 4) return 3;
  if (count === 3) return 4;
  if (count === 2) return 5;
  return 8;
}

export function deriveTiles(words) {
  const raw = new Map(ALPHABET.map((l) => [l, 0]));
  for (const word of words) {
    for (const letter of word) raw.set(letter, raw.get(letter) + 1);
  }

  const total = [...raw.values()].reduce((a, b) => a + b, 0);

  // Largest-remainder apportionment: floor every share, then hand out what is
  // left over to the largest remainders. Ties break alphabetically so the
  // result depends on nothing but the corpus.
  const exact = ALPHABET.map((letter) => ({
    letter,
    raw: raw.get(letter),
    share: (raw.get(letter) / total) * LETTERS,
  }));

  for (const entry of exact) {
    entry.count = Math.floor(entry.share);
    entry.remainder = entry.share - entry.count;
  }

  let assigned = exact.reduce((a, e) => a + e.count, 0);
  const byRemainder = [...exact].sort(
    (a, b) => b.remainder - a.remainder || a.letter.localeCompare(b.letter),
  );
  for (let i = 0; assigned < LETTERS; i += 1, assigned += 1) {
    byRemainder[i % byRemainder.length].count += 1;
  }

  // Every letter must be playable at least once, paid for by the most common
  // letter — a bag with no `q` in it is a worse game than one with a spare `e`
  // missing.
  const byCount = () => [...exact].sort((a, b) => b.count - a.count || a.letter.localeCompare(b.letter));
  for (const entry of exact) {
    if (entry.count === 0) {
      entry.count = 1;
      byCount()[0].count -= 1;
    }
  }

  const rarity = [...exact].sort((a, b) => a.raw - b.raw || a.letter.localeCompare(b.letter));
  const rank = new Map(rarity.map((e, i) => [e.letter, i]));

  return exact.map((e) => ({
    letter: e.letter,
    count: e.count,
    value: valueFor(e.count, rank.get(e.letter)),
    raw: e.raw,
  }));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const path = new URL('../wordlist/enable.txt', import.meta.url);
  const words = readFileSync(path, 'utf8').split('\n').filter(Boolean);
  const tiles = deriveTiles(words);

  const letters = tiles.reduce((a, t) => a + t.count, 0);
  const points = tiles.reduce((a, t) => a + t.count * t.value, 0);

  console.log('// letter, count, value');
  for (const t of tiles) {
    console.log(`(b'${t.letter}', ${t.count}, ${t.value}),  // ${t.raw} occurrences`);
  }
  console.log(`\n// ${letters} letter tiles + ${BLANKS} blanks = ${letters + BLANKS}`);
  console.log(`// ${points} points on the board`);
}
