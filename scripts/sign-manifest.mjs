/**
 * Rebuilds and signs the plugin manifest.
 *
 * Run this after `just plugins` or `just dict` changes a committed artifact —
 * the manifest pins those bytes by hash, so an artifact that moves without a
 * re-signing leaves the app refusing to load it. That refusal is the point: it
 * is what makes an artifact change a deliberate act rather than a diff nobody
 * looked at.
 *
 * The signing key never enters the repository. It is generated once into
 * ~/.config/tabla/manifest-signing.key and stays there; CI verifies the
 * committed signature and can never produce one.
 */
import { createHash, createPublicKey, generateKeyPairSync, sign } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const KEY_PATH = join(homedir(), '.config', 'tabla', 'manifest-signing.key');

/** Signed alongside the payload so a signature is only valid as a manifest. */
const DOMAIN = 'tabla-manifest/v1';

/**
 * What the manifest describes.
 *
 * Paths are what the app fetches; hashes and sizes are read from the committed
 * files, never written by hand, so the manifest cannot claim something the
 * repository does not contain.
 */
const CONTENTS = [
  {
    id: 'letras',
    version: 3,
    module: 'app/static/plugins/letras-v3.wasm',
    assets: [{ id: 'en-v1', file: 'app/static/dict/en-v1.dawg' }],
  },
  {
    // Listed for games that began under it, and never rebuilt.
    id: 'letras',
    version: 2,
    module: 'app/static/plugins/letras-v2.wasm',
    assets: [{ id: 'en-v1', file: 'app/static/dict/en-v1.dawg' }],
  },
  {
    // Still listed so a game started under the oldest rules can still fetch them.
    // Its module is never rebuilt — the bytes below are the ones those games
    // are already playing against.
    id: 'letras',
    version: 1,
    module: 'app/static/plugins/letras-v1.wasm',
    assets: [{ id: 'en-v1', file: 'app/static/dict/en-v1.dawg' }],
  },
];

function describe(file) {
  const bytes = readFileSync(join(ROOT, file));
  return {
    path: file.replace(/^app\/static/, ''),
    sha256: createHash('sha256').update(bytes).digest('hex'),
    bytes: bytes.length,
  };
}

function privateKey() {
  try {
    return readFileSync(KEY_PATH, 'utf8');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }

  const { privateKey: created } = generateKeyPairSync('ed25519');
  const pem = created.export({ format: 'pem', type: 'pkcs8' });

  mkdirSync(dirname(KEY_PATH), { recursive: true });
  writeFileSync(KEY_PATH, pem);
  chmodSync(KEY_PATH, 0o600);

  console.log(`generated a new signing key at ${KEY_PATH}`);
  return pem;
}

const key = privateKey();

const payload = {
  version: 1,
  plugins: CONTENTS.map((entry) => ({
    id: entry.id,
    version: entry.version,
    module: describe(entry.module),
    assets: entry.assets.map((asset) => ({ id: asset.id, ...describe(asset.file) })),
  })),
};

// Two spaces and a trailing newline: the signature covers these exact bytes, so
// the formatting is part of the artifact. `app/.prettierignore` keeps anything
// else from having an opinion about it.
const serialized = `${JSON.stringify(payload, null, 2)}\n`;
const signature = sign(null, Buffer.concat([Buffer.from(DOMAIN), Buffer.from(serialized)]), key);

writeFileSync(join(ROOT, 'app/src/lib/plugin/manifest.json'), serialized);
writeFileSync(join(ROOT, 'app/src/lib/plugin/manifest.sig'), `${signature.toString('hex')}\n`);

// The raw 32-byte key is the tail of the SPKI encoding; that is the form the
// Rust verifier takes, and what shared/src/constants.ts pins.
const spki = createPublicKey(key).export({ format: 'der', type: 'spki' });

console.log(`signed ${payload.plugins.length} plugin(s)`);
console.log(`publisher public key: ${spki.subarray(spki.length - 32).toString('hex')}`);
console.log('pin this as MANIFEST_SIGNING_PUBKEY in shared/src/constants.ts');
