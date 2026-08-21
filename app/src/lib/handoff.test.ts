/**
 * Carrying a link across by hand.
 *
 * On iOS a link never reaches the installed app, so the last resort is the
 * person copying it out of Safari and pasting it into tabla. What arrives is
 * whatever survived the trip, and the cost of not recognising it is high: the
 * link is single-use, so "that does not look like a link" sends someone back to
 * their friend for another one. These check that the shapes a link actually
 * turns up in are all understood, and that nothing else is.
 */
import { toBase64Url } from '@tabla/shared';
import { describe, expect, it } from 'vitest';

import { parseSharedLink } from './handoff.ts';
import { LINK_WORDS } from './link-words.ts';

const blobId = toBase64Url(new Uint8Array(16).fill(7));
const key = toBase64Url(new Uint8Array(32).fill(9));
const inviteFragment = `${blobId}.${key}`;

const words = LINK_WORDS.slice(0, 6);

describe('an invite link', () => {
  it('is recognised as the whole URL, which is what a copy gives', () => {
    expect(parseSharedLink(`https://tabla.example/j#${inviteFragment}`)).toEqual({
      kind: 'invite',
      to: `/j#${inviteFragment}`,
    });
  });

  it('is recognised as a bare fragment, with or without the hash', () => {
    const expected = { kind: 'invite', to: `/j#${inviteFragment}` };
    expect(parseSharedLink(`#${inviteFragment}`)).toEqual(expected);
    expect(parseSharedLink(inviteFragment)).toEqual(expected);
  });

  it('survives the whitespace a paste brings with it', () => {
    expect(parseSharedLink(`  https://tabla.example/j#${inviteFragment}\n`)).toEqual({
      kind: 'invite',
      to: `/j#${inviteFragment}`,
    });
  });

  it('is refused when the key is short, rather than spent on a bad claim', () => {
    const short = `${blobId}.${toBase64Url(new Uint8Array(8))}`;
    expect(parseSharedLink(`https://tabla.example/j#${short}`)).toBeNull();
  });

  it('is refused when the fragment was left behind', () => {
    // What a link-preview crawler or an over-helpful chat app hands back.
    expect(parseSharedLink('https://tabla.example/j')).toBeNull();
  });
});

describe('a device link', () => {
  it('is recognised as the URL the QR code carries, hyphens and all', () => {
    expect(parseSharedLink(`https://tabla.example/link#${words.join('-')}`)).toEqual({
      kind: 'device',
      to: `/link#${words.join('-')}`,
    });
  });

  it('is recognised as six words read out loud', () => {
    expect(parseSharedLink(words.join(' '))).toEqual({
      kind: 'device',
      to: `/link#${words.join('-')}`,
    });
  });

  it('does not care about case or spacing, which a person will not either', () => {
    expect(parseSharedLink(`  ${words.join('  ').toUpperCase()} `)).toEqual({
      kind: 'device',
      to: `/link#${words.join('-')}`,
    });
  });

  it('is refused when a word is not on the list', () => {
    expect(parseSharedLink([...words.slice(0, 5), 'zzzz'].join(' '))).toBeNull();
  });

  it('is refused when there are not six of them', () => {
    expect(parseSharedLink(words.slice(0, 5).join(' '))).toBeNull();
  });
});

describe('anything else', () => {
  it('is not a link', () => {
    expect(parseSharedLink('')).toBeNull();
    expect(parseSharedLink('   ')).toBeNull();
    expect(parseSharedLink('hello')).toBeNull();
    expect(parseSharedLink('https://tabla.example/')).toBeNull();
  });

  it('is not a link because it points at the wrong page', () => {
    // The secret is right, the route is not: redeeming it as an invite would
    // claim something that is not there.
    expect(parseSharedLink(`https://tabla.example/settings#${inviteFragment}`)).toBeNull();
    expect(parseSharedLink(`https://tabla.example/link#${inviteFragment}`)).toBeNull();
    expect(parseSharedLink(`https://tabla.example/j#${words.join('-')}`)).toBeNull();
  });

  it('is not a link just because it has a scheme', () => {
    expect(parseSharedLink(`javascript:alert(1)#${inviteFragment}`)).toBeNull();
  });
});
