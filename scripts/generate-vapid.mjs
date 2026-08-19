#!/usr/bin/env node
/**
 * Generates a VAPID keypair for Web Push.
 *
 * Run once, offline. The private key goes into the Worker as a secret and never
 * anywhere else; the public key is served to clients so they can subscribe.
 *
 *   node scripts/generate-vapid.mjs
 *   cd worker && bunx wrangler secret put VAPID_PRIVATE_KEY
 */
import { webcrypto } from 'node:crypto';

const base64url = (buffer) =>
  Buffer.from(buffer).toString('base64').replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');

const pair = await webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
  'sign',
  'verify',
]);

const publicKey = base64url(await webcrypto.subtle.exportKey('raw', pair.publicKey));
const jwk = await webcrypto.subtle.exportKey('jwk', pair.privateKey);

console.log('VAPID_PUBLIC_KEY  =', publicKey);
console.log('VAPID_PRIVATE_KEY =', jwk.d);
console.log();
console.log('Set them as Worker secrets:');
console.log('  cd worker');
console.log('  bunx wrangler secret put VAPID_PUBLIC_KEY');
console.log('  bunx wrangler secret put VAPID_PRIVATE_KEY');
console.log();
console.log('VAPID_SUBJECT should be a mailto: or https: URL you control.');
