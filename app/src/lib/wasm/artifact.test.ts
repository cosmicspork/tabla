/**
 * The downloadable plugin module, tested as the bytes players receive.
 *
 * `app/static/plugins/letras-v1.wasm` is a committed artifact whose hash is
 * pinned in the signed manifest, so it is not rebuilt as part of `just build`.
 * That makes going stale the failure worth guarding against: source can move on
 * while the committed bytes stay behind, and nothing else in the suite would
 * notice, because everything else loads a freshly compiled module.
 *
 * So this file loads the artifact itself and plays the opening of a real game
 * with it, against the real word list.
 */
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { DICTIONARY_EN_V1 } from '@tabla/shared';

import { loadLetrasFromDisk, readLetrasWasm } from './node.ts';

const letras = await loadLetrasFromDisk();

const dictionary = new Uint8Array(
  await readFile(fileURLToPath(new URL('../../../static/dict/en-v1.dawg', import.meta.url))),
);

function fromHex(hex: string): Uint8Array {
  return new Uint8Array((hex.match(/../g) ?? []).map((pair) => parseInt(pair, 16)));
}

/** What the initiator writes into the log's setup entry: version, then hash. */
const CONFIG = new Uint8Array([1, ...fromHex(DICTIONARY_EN_V1.sha256)]);

describe('the downloadable letras module', () => {
  it('carries only the game it was built for', () => {
    expect(letras.available_plugins()).toEqual(['letras']);
    expect(letras.plugin_version('letras')).toBe(1);

    // Tic tac toe is bundled with the app, so this module has no reason to
    // carry it — and the feature gating means it genuinely does not.
    expect(() => letras.plugin_version('tictactoe')).toThrow(/unknown plugin/);
  });

  it('is built without any keyed cryptography linked in', async () => {
    // The same scan the bundled module gets. A downloaded module is the one
    // case where "no keys compiled in" could quietly stop being true without
    // anyone rebuilding the app, so the committed bytes are what is scanned.
    const text = new TextDecoder('utf-8', { fatal: false })
      .decode(await readLetrasWasm())
      .toLowerCase();

    for (const symbol of ['chacha', 'ed25519', 'curve25519', 'argon', 'hkdf']) {
      expect(text).not.toContain(symbol);
    }
  });

  it('cannot fetch its own bytes', async () => {
    // The sandbox deletes `fetch` before loading anything, and the generated
    // loader's fallback is patched out by `just plugins`. If a regenerated
    // artifact ever arrived unpatched, the module would try to resolve itself
    // relative to the worker bundle — and Vite would emit a second copy of it
    // into the app, which is the thing downloading it is meant to avoid.
    const glue = await readFile(
      fileURLToPath(new URL('./letras-pkg/tabla_letras.js', import.meta.url)),
      'utf8',
    );

    expect(glue).not.toContain('import.meta.url');
  });

  it('refuses a word list that is not the one the game agreed to', () => {
    expect(() =>
      letras.setup('letras', CONFIG, new Uint8Array(32), new Uint8Array([1, 2, 3])),
    ).toThrow(/game data/);
  });

  it('opens a game against the real word list', () => {
    const state = letras.setup('letras', CONFIG, new Uint8Array(32).fill(0x11), dictionary);
    const view = JSON.parse(letras.player_view('letras', state, 0));

    expect(letras.is_game_over('letras', state)).toBeFalsy();
    expect(view.board).toHaveLength(15 * 15);

    // The opening entry is not a play but a commitment, which the rules hand
    // the UI rather than letting it invent. Taking it proves this artifact
    // still agrees with the protocol the app speaks.
    const move = {
      nonce: [...new Uint8Array(24).fill(0x22)],
      rackCommitment: view.rackCommitment ?? null,
      action: view.auto,
    };

    expect(view.auto).toBeTruthy();

    const encoded = letras.encodeMove('letras', JSON.stringify(move));
    letras.validate_move('letras', state, encoded, 0, dictionary);

    const next = letras.replay(
      'letras',
      CONFIG,
      new Uint8Array(32).fill(0x11),
      [encoded],
      dictionary,
    );
    expect(JSON.parse(letras.decodeMove('letras', encoded)).action).toEqual(view.auto);
    expect(next.length).toBeGreaterThan(0);
  });
});
