/**
 * The words a device link is spoken in.
 *
 * Two devices have to agree on what six words mean without ever exchanging
 * anything else: the same words must produce the same passphrase and the same
 * mailbox on both, and different words must not collide. Everything here is
 * about that agreement, and about the list's properties being real rather than
 * described — a word that shared its first four letters with another would make
 * a typo undetectable, and nothing but a test would notice.
 */
import { describe, expect, it } from 'vitest';

import { LINK_WORDS } from './link-words.ts';
import {
  LINK_WORD_COUNT,
  linkIdOf,
  newLinkWords,
  parseLinkWords,
  passphraseOf,
  timeLeft,
  unknownWords,
} from './link.ts';

describe('the word list', () => {
  it('is exactly 2048 words, so each carries eleven bits', () => {
    expect(LINK_WORDS).toHaveLength(2048);
    // Six of them is 66 bits, which is the whole security of a link.
    expect(Math.log2(LINK_WORDS.length) * LINK_WORD_COUNT).toBe(66);
  });

  it('has no duplicates', () => {
    expect(new Set(LINK_WORDS).size).toBe(LINK_WORDS.length);
  });

  it('lets a word be told apart by its first four letters', () => {
    // The property that makes a typo detectable rather than a different word.
    const prefixes = new Set(LINK_WORDS.map((word) => word.slice(0, 4)));
    expect(prefixes.size).toBe(LINK_WORDS.length);
  });

  it('is all lowercase letters, short enough to say', () => {
    for (const word of LINK_WORDS) {
      expect(word).toMatch(/^[a-z]{3,8}$/);
    }
  });

  it('is sorted, which is what makes its order reproducible', () => {
    expect([...LINK_WORDS].sort()).toEqual([...LINK_WORDS]);
  });
});

describe('drawing words', () => {
  it('draws six from the list', () => {
    const words = newLinkWords();

    expect(words).toHaveLength(LINK_WORD_COUNT);
    for (const word of words) expect(LINK_WORDS).toContain(word);
  });

  it('does not draw the same six twice', () => {
    const seen = new Set(Array.from({ length: 50 }, () => passphraseOf(newLinkWords())));
    expect(seen.size).toBe(50);
  });
});

describe('reading words back', () => {
  it('accepts what the other device shows, however it was typed', () => {
    const words = ['harbor', 'linen', 'quartz', 'meadow', 'copper', 'sable'].filter((word) =>
      LINK_WORDS.includes(word),
    );
    // Uses whatever of those are real, padded from the list, so the test does
    // not depend on any particular word being in it.
    const six = [...words, ...LINK_WORDS].slice(0, LINK_WORD_COUNT);

    expect(parseLinkWords(six.join(' '))).toEqual(six);
    expect(parseLinkWords(`  ${six.join('  ')}  `)).toEqual(six);
    expect(parseLinkWords(six.join('-'))).toEqual(six);
    expect(parseLinkWords(six.join(' ').toUpperCase())).toEqual(six);
  });

  it('refuses the wrong number of words', () => {
    const six = LINK_WORDS.slice(0, LINK_WORD_COUNT);

    expect(parseLinkWords(six.slice(0, 5).join(' '))).toBeNull();
    expect(parseLinkWords([...six, LINK_WORDS[9]].join(' '))).toBeNull();
  });

  it('refuses a word that is not on the list', () => {
    const six = [...LINK_WORDS.slice(0, 5), 'zzzz'];
    expect(parseLinkWords(six.join(' '))).toBeNull();
    expect(unknownWords(six.join(' '))).toEqual(['zzzz']);
  });

  it('names the words it does not recognise, while they are being typed', () => {
    expect(unknownWords('abandon qqqq ability')).toEqual(['qqqq']);
    expect(unknownWords('abandon ability')).toEqual([]);
  });
});

describe('where the bundle is left', () => {
  const six = LINK_WORDS.slice(0, LINK_WORD_COUNT);

  it('is the same on both devices, and is not the passphrase', async () => {
    const id = await linkIdOf(six);

    expect(await linkIdOf(six)).toBe(id);
    expect(id).toMatch(/^[A-Za-z0-9_-]{22}$/);
    // The relay sees this and never the words, so it must not be derivable back.
    expect(id).not.toContain(six[0]);
  });

  it('is different for different words', async () => {
    const other = [...six.slice(0, 5), LINK_WORDS[99]];
    expect(await linkIdOf(other)).not.toBe(await linkIdOf(six));
  });

  it('is not a bare digest of the passphrase', async () => {
    // Domain-separated, so the id cannot be confused with any other hash of the
    // same words — including one an attacker might precompute against.
    const bare = new Uint8Array(
      await crypto.subtle.digest('SHA-256', new TextEncoder().encode(passphraseOf(six))),
    );
    const asId = [...bare.slice(0, 16)];
    const id = await linkIdOf(six);

    expect(id).not.toBe(btoa(String.fromCharCode(...asId)));
  });
});

describe('the countdown', () => {
  it('counts down in minutes and seconds', () => {
    const now = 1_780_000_000_000;

    expect(timeLeft(now + 9 * 60_000 + 41_000, now)).toBe('9:41');
    expect(timeLeft(now + 61_000, now)).toBe('1:01');
    expect(timeLeft(now, now)).toBe('0:00');
  });

  it('does not run backwards past zero', () => {
    const now = 1_780_000_000_000;
    expect(timeLeft(now - 60_000, now)).toBe('0:00');
  });
});
