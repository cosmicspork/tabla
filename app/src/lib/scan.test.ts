/**
 * That what tabla draws is what tabla can read.
 *
 * A camera cannot be asserted on, but the two ends around it can: a code is
 * rendered with the same library that draws it on screen, turned into the
 * pixels a frame would hold, and put through the decoder an iPhone would use.
 * If those agree, the only thing left untested between a QR on one screen and
 * a game on another is the lens.
 *
 * The decoder is exercised as the *committed file*, not through `decodePixels`,
 * which fetches it from `/qr/jsqr.mjs` — a URL that means nothing in Node. What
 * is worth guarding here is the vendored artifact: that the ES-module shim
 * wrapped around an upstream UMD build still resolves to a working decoder, and
 * still reads the codes this app generates. Re-vendoring it is exactly the
 * change that could silently produce a module that imports but never decodes.
 */
import { toBase64Url } from '@tabla/shared';
import { encode } from 'uqr';
import { beforeAll, describe, expect, it } from 'vitest';

import { linkWordsFrom, parseSharedLink } from './handoff.ts';
import { LINK_WORDS } from './link-words.ts';

type Decode = (data: Uint8ClampedArray, width: number, height: number) => { data: string } | null;

let jsQR: Decode;

beforeAll(async () => {
  const url = new URL('../../static/qr/jsqr.mjs', import.meta.url).href;
  const loaded = (await import(/* @vite-ignore */ url)) as { default: Decode };
  jsQR = loaded.default;
});

/**
 * The pixels a camera frame would hold for this text.
 *
 * Scaled up because a QR drawn one pixel per module is not something a locator
 * can find — nor is it what a phone sees, which is a code filling much of the
 * frame.
 */
function framePixels(text: string, scale = 4) {
  const qr = encode(text, { border: 2 });
  const size = qr.size * scale;
  const data = new Uint8ClampedArray(size * size * 4);

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const dark = qr.data[Math.floor(y / scale)][Math.floor(x / scale)];
      const shade = dark ? 0 : 255;
      const at = (y * size + x) * 4;
      data[at] = shade;
      data[at + 1] = shade;
      data[at + 2] = shade;
      data[at + 3] = 255;
    }
  }

  return { data, size };
}

function read(text: string): string | null {
  const { data, size } = framePixels(text);
  return jsQR(data, size, size)?.data ?? null;
}

const words = LINK_WORDS.slice(0, 6);
const blobId = toBase64Url(new Uint8Array(16).fill(7));
const key = toBase64Url(new Uint8Array(32).fill(9));

describe('the vendored decoder', () => {
  it('is a module that resolves to a function', () => {
    expect(typeof jsQR).toBe('function');
  });

  it('reads back the device-link code the settings page draws', () => {
    // Exactly what `settings/devices/link` renders: the words, hyphenated, in
    // the fragment of a `/link` URL.
    const shown = `https://tabla.example/link#${words.join('-')}`;
    expect(read(shown)).toBe(shown);
  });

  it('reads back the invite code the share panel draws', () => {
    const shown = `https://tabla.example/j#${blobId}.${key}`;
    expect(read(shown)).toBe(shown);
  });

  it('finds nothing in a frame with no code in it', () => {
    const blank = new Uint8ClampedArray(120 * 120 * 4).fill(255);
    expect(jsQR(blank, 120, 120)).toBeNull();
  });
});

describe('a scan and a paste', () => {
  it('agree about a device link, because they end in the same parser', () => {
    const scanned = read(`https://tabla.example/link#${words.join('-')}`);
    expect(scanned).not.toBeNull();
    expect(linkWordsFrom(scanned!)).toBe(words.join(' '));
  });

  it('agree about an invite', () => {
    const scanned = read(`https://tabla.example/j#${blobId}.${key}`);
    expect(scanned).not.toBeNull();
    expect(parseSharedLink(scanned!)).toEqual({
      kind: 'invite',
      to: `/j#${blobId}.${key}`,
    });
  });

  it('agree that a stray code is not a link', () => {
    // The poster on the wall behind the phone. It decodes fine; it is simply
    // not ours, and the scanner has to keep looking rather than fail.
    const scanned = read('https://example.com/lunch-menu');
    expect(scanned).toBe('https://example.com/lunch-menu');
    expect(parseSharedLink(scanned!)).toBeNull();
    expect(linkWordsFrom(scanned!)).toBeNull();
  });
});
