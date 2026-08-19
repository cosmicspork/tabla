/**
 * The dictionary the app ships.
 *
 * The Rust golden test proves the artifact is what the word list compiles to.
 * This one proves the *app* agrees about it: the hash written into every Letras
 * invite has to be the hash of the file the app actually serves, or two players
 * who both have the file would still refuse to play each other.
 */
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { DICTIONARY_EN_V1 } from '@tabla/shared';

const artifact = fileURLToPath(new URL(`../../static${DICTIONARY_EN_V1.path}`, import.meta.url));

describe('the shipped dictionary', () => {
  it('is the file the pinned hash names', async () => {
    const bytes = await readFile(artifact);
    const digest = createHash('sha256').update(bytes).digest('hex');

    expect(digest).toBe(DICTIONARY_EN_V1.sha256);
  });

  it('is a word list of the format and size the reader expects', async () => {
    const bytes = await readFile(artifact);

    // Header: magic, format version 1, then the word count at offset 16.
    expect(bytes.subarray(0, 4).toString('latin1')).toBe('TDWG');
    expect(bytes.readUInt16LE(4)).toBe(1);
    expect(bytes.readUInt32LE(16)).toBe(DICTIONARY_EN_V1.words);
  });
});
