/**
 * The signed list of plugin modules this build will run.
 *
 * A downloadable plugin is the one place where bytes fetched over the network
 * become code, so nothing is fetched, stored, or executed until the manifest
 * naming it has been verified against the publisher key pinned in the build.
 *
 * Verification comes before parsing, deliberately. The signature covers the
 * file exactly as it is stored, so there is no canonical form to agree on and
 * no parser for a forged manifest to reach — a bad signature means the JSON is
 * never looked at.
 *
 * What this is worth is set out in `rust/crates/tabla-core/src/manifest.rs`:
 * the manifest ships in the same bundle as the key that checks it, so this is
 * not a defence against a rewritten bundle. It is what stops an artifact hash
 * changing without a deliberate signing, and it is what will still be here the
 * day a manifest arrives from somewhere other than the bundle.
 */
import { z } from 'zod';

import { MANIFEST_SIGNING_PUBKEY } from '@tabla/shared';

import { loadCore } from '../wasm/core.ts';
import payload from './manifest.json?raw';
import signature from './manifest.sig?raw';

const blob = z.object({
  path: z.string().startsWith('/'),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  bytes: z.number().int().positive(),
});

const schema = z.object({
  version: z.literal(1),
  plugins: z.array(
    z.object({
      id: z.string().min(1),
      version: z.number().int().positive(),
      module: blob,
      assets: z.array(blob.extend({ id: z.string().min(1) })),
    }),
  ),
});

export type PluginManifest = z.infer<typeof schema>;
export type ManifestPlugin = PluginManifest['plugins'][number];
export type ManifestBlob = z.infer<typeof blob>;

export class ManifestError extends Error {
  constructor(message: string) {
    super(message);
  }
}

let verified: Promise<PluginManifest> | null = null;

/**
 * The manifest, verified once per page.
 *
 * A failure here is not a network problem and not something a retry fixes: it
 * means this build disagrees with itself about what it is allowed to run.
 */
export function verifiedManifest(): Promise<PluginManifest> {
  verified ??= verify();
  return verified;
}

async function verify(): Promise<PluginManifest> {
  const core = await loadCore();

  try {
    core.verifyManifest(
      fromHex(MANIFEST_SIGNING_PUBKEY),
      encode(payload),
      fromHex(signature.trim()),
    );
  } catch {
    throw new ManifestError('the plugin manifest is not signed by this build’s publisher key');
  }

  const parsed = schema.safeParse(JSON.parse(payload));
  if (!parsed.success) {
    throw new ManifestError(
      'the plugin manifest is signed but not in a form this build understands',
    );
  }

  return parsed.data;
}

/** What the manifest says about one plugin, or nothing if it lists no such id. */
export async function manifestEntry(
  pluginId: string,
  version: number,
): Promise<ManifestPlugin | undefined> {
  const manifest = await verifiedManifest();
  return manifest.plugins.find((plugin) => plugin.id === pluginId && plugin.version === version);
}

function encode(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

function fromHex(hex: string): Uint8Array {
  return new Uint8Array((hex.match(/../g) ?? []).map((pair) => parseInt(pair, 16)));
}

/** Test seam: forces the next call to verify again. */
export function forgetManifest(): void {
  verified = null;
}
