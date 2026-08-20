# Security policy

Tabla's guarantees rest on a cryptographic protocol implemented in this
repository rather than borrowed from an audited library. Security reports are
taken seriously and appreciated.

## Reporting a vulnerability

Please report security issues **privately** via
[GitHub security advisories](https://github.com/cosmicspork/tabla/security/advisories/new)
rather than a public issue or PR. Include what you found, where (crate or
module), and how to reproduce it. You'll get an acknowledgment as soon as the
report is read, and credit in the fix's release notes unless you'd rather not.

## Scope

Most valuable: anything that breaks a stated guarantee.

- **The relay learning anything.** It is supposed to see ciphertext, entry
  framing, and routing metadata — nothing else (`worker/`).
- **The deal.** A player reading a tile they were not dealt, playing one they
  do not hold, or biasing what they draw. That means soundness or
  zero-knowledge failures in the shuffle argument, the key-share proof, or the
  decryption-share proof (`rust/crates/tabla-deal`), and it also means the
  host's cross-check between what a move claims and what the deal actually
  opened (`app/src/lib/deal.ts`).
- **The log.** Signature or chain-verification bypasses, or a rollback that
  survives the tombstone check (`rust/crates/tabla-core`).
- **The sandbox.** Anything that gets key material, network access, or storage
  into a plugin module (`rust/crates/tabla-plugin-wasm`).
- **Plugin distribution.** Getting a client to run bytes the signed manifest
  does not name.

Out of scope: the limits already written down in
[ARCHITECTURE.md](ARCHITECTURE.md#what-is-not-automatically-verifiable) — in
particular that whoever serves the app is trusted to serve the app, that a
player can always abandon a game, and that the relay can see entry sizes and
timing. Also out of scope: anything requiring a compromised device or a stolen
identity seed.

## Supported versions

Pre-1.0, only the latest release is supported; fixes ship as normal releases
from `main`.
