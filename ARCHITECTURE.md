# tabla architecture

This document is the protocol's source of truth: the log format, the invite
protocol, the sync algorithm, and the plugin interface. It is written as the
system is built, and it is the thing to read before changing any wire format.

## The one invariant

**The relay learns nothing.** It sees ciphertext, byte lengths, timing, and two
opaque public-key hashes per game. It never holds a key, never verifies a
signature, and cannot compute a legal move. Every rule in this document exists
to keep that true; none of them may be simplified away for convenience.

What the relay unavoidably knows, and what we accept as the threat model:

- that two identity-key hashes are playing *some* game together,
- roughly when each move happened and how big it was,
- IP addresses at connection time (Cloudflare's, not ours, but real).

What it never knows: game type, board state, moves, outcomes, display names,
or anything derived from them.

## Cryptography

All protocol crypto lives in one Rust crate, `tabla-core`, compiled to WASM and
used unchanged in the browser, in a Web Worker, and under `cargo test`. One
implementation means canonical encoding, hashing, and verification cannot drift
between contexts — a whole class of bugs that would otherwise be invisible until
two clients disagree mid-game.

| Purpose | Primitive |
|---|---|
| Identity, entry signatures | Ed25519 (`ed25519-dalek`) |
| Session key agreement | X25519 ECDH over identity keys (`x25519-dalek`) |
| Key derivation | HKDF-SHA256 |
| Hashing, chaining | SHA-256 |
| Payload and blob sealing | XChaCha20-Poly1305 |
| Export file KDF | Argon2id |

**No randomness is generated inside `tabla-core`.** Every seed, nonce, and salt
is passed in by the caller, which comes from `crypto.getRandomValues` in the
browser and from fixtures in tests. This keeps the crate deterministic and
testable, and it is why the wasm build carries no `getrandom` JS shim.

XChaCha20-Poly1305 rather than AES-GCM: its 24-byte nonces are safe to generate
randomly per message, with no counter state to coordinate between two devices
that both append to the same log while offline.

### Identity

Each installation generates one long-term Ed25519 keypair on first run and keeps
it in IndexedDB. There are no accounts and no server-side identity.

The private key is stored as **raw seed bytes, not a non-extractable
`CryptoKey`**. This is forced by the product: backup and device migration must
export the keypair, and a non-extractable key cannot be exported by definition.
The tradeoff is explicit — anything with read access to the origin's IndexedDB
has the identity. For a no-account game played between friends, losing the game
history to a device compromise is an acceptable risk; losing the ability to move
to a new phone is not.

After the first completed handshake with a peer, their public key is saved to a
local contacts list, so later games start from a contact picker. Invite links
are the bootstrap, not the ongoing flow.

## The game log

Every game is a **signed, hash-chained, append-only log**. Both clients hold the
full log. The relay holds a copy purely as transport and offline mailbox; it is
never authoritative, and a client that disagrees with the relay believes itself.

### Canonical entry encoding

The preimage is a fixed-order, length-prefixed byte concatenation. Integers are
little-endian. There is no canonical-form ambiguity to get wrong, and no
serialization library in the trusted path.

```
preimage :=
  "tabla-log/v1"          12 bytes, fixed ASCII domain tag
  u32   seq
  [32]  prevHash          all-zero at seq 0
  [16]  gameId
  [32]  authorKeyHash     SHA-256 of the author's 32-byte Ed25519 public key
  u32   len(payload)
  []    payload           ciphertext

entryHash := SHA-256(preimage)
sig       := Ed25519(author_signing_key, preimage)
stored    := preimage || sig        // 64-byte signature, self-delimiting
```

"The signature is over the full entry" necessarily means over the preimage: a
signature cannot cover itself. Since the preimage includes `seq`, `prevHash`,
and `gameId`, an entry cannot be replayed at a different position, in a
different game, or under a different history.

### Payload

The payload is the XChaCha20-Poly1305 sealing of a postcard-encoded body, with
the 24-byte nonce prepended and `gameId || u32(seq)` as associated data. The AAD
is defense in depth; the signature already binds the position.

```rust
enum EntryBody {
    Join { claimer_pub_key: [u8; 32] },
    Setup { config: Vec<u8> },
    Move(Vec<u8>),
    Resign,
}
```

### Verification

Verification happens in two layers, and the split is deliberate.

**Structural** (`tabla_core::log`, needs only the two public keys):

1. `seq` is contiguous from 0 with no gaps.
2. Each `prevHash` equals the `entryHash` of the preceding entry; `prevHash` is
   zero at seq 0.
3. Every signature verifies against the author's Ed25519 public key.
4. Every author is one of the two participants bound to the game.
5. Every entry carries the expected `gameId`.

**Semantic** (needs the per-game key):

6. Every payload decrypts under the per-game key.
7. Authorship follows the turn order the game requires.
8. Each decoded move passes the plugin's `validate_move` against the state
   produced by replaying all prior moves.

The layers are separate because turn order is not a structural property: a
resignation is legal out of turn, so deciding whether an entry is correctly
placed requires knowing what kind of entry it is, which requires the key. Keeping
the structural layer key-free is what lets a client sanity-check a log it has
just pulled from an evicted relay before it has derived anything.

Any failure is fatal to the suffix being checked. The client keeps its own copy
and refuses to advance — there is no safe way to partially accept a history that
failed verification.

Turn alternation is enforced on the client, never by the relay, which cannot
tell one participant's ciphertext from the other's beyond the key hash it routes
on.

## Key derivation

```
ikm  = X25519(my identity key -> Montgomery, peer identity key -> Montgomery)
salt = SHA-256("tabla-salt/v1" || blobId || min(pubA, pubB) || max(pubA, pubB))
game key = HKDF-SHA256(ikm, salt, info = "tabla/v1/msg/" || gameId)   -> 32 bytes
```

Sorting the two public keys makes the salt identical on both sides regardless of
who initiated. The invite blob key is **not** derived from anything: it is 32
random bytes that exist only in the URL fragment.

The Ed25519 to X25519 conversion is the standard one: `to_scalar_bytes()` on the
signing side pairs with `to_montgomery()` on the verifying side, so both parties
compute the same point.

### On reusing identity keys for key agreement

Using one keypair for both signing and ECDH is not the textbook recommendation —
see [eprint 2021/509](https://eprint.iacr.org/2021/509), and dalek's own docs
advise against it. This protocol does it deliberately.

An invite is a single-use bearer link that has to work when the recipient opens
it three days later, on a device that has never exchanged a byte with the
initiator. A proper ephemeral key exchange needs either a live round trip or a
published pre-key infrastructure; the first breaks the asynchrony the entire
product is built on, and the second reintroduces the server-side identity we are
specifically avoiding. The mitigations we do apply: the conversion is the
library-blessed one, every derived key is domain-separated through HKDF with a
salt bound to the specific invite and pair, and no key material is ever reused
across games.

The residual risk is that a single compromised identity key exposes both past
game contents and the ability to forge entries — but a device compromise already
yields both, since the seed sits in IndexedDB by necessity (see above).

## Invitations

The initiator picks game options, seals a config blob, and posts it to the relay.
The share link is:

```
https://<host>/j#<blobId>.<key>
```

The symmetric key lives in the **URL fragment**, which browsers never send to the
server. It is therefore invisible to the relay, to logs, and to the link-preview
crawlers that fetch URLs pasted into chat apps. This is also why the app is a
pure SPA with no SSR: there is no server-side render that could ever observe the
fragment.

The blob's plaintext:

```rust
struct InviteConfig {
    v: u16,
    game_id: [u8; 16],
    plugin_id: String,
    plugin_version: u32,
    dictionary_hash: Option<[u8; 32]>,
    initiator_pub_key: [u8; 32],
    seed: [u8; 32],
    created_at: u64,
}
```

The claimer refuses the invite on any `plugin_id` / `plugin_version` /
`dictionary_hash` mismatch with its own build. Divergent validation discovered
mid-game is unrecoverable, so it must be refused at the start.

### Single-use claim

The link is a bearer token, and exactly one person may redeem it. A pending-invite
Durable Object is addressed by `idFromName(blobId)` and enforces this in one
SQLite statement:

```sql
UPDATE invite SET claimed_by = ?, claim_sig = ?
 WHERE blob_id = ? AND claimed_by IS NULL
```

A second claim changes no rows and gets a 409. The claimer signs
`"tabla-claim/v1" || blobId` with its identity key; the relay stores that
signature without checking it, and the **initiator** verifies it. The relay is
not trusted to authenticate anyone.

Invites expire after 7 days via a DO alarm.

## Sync

Game rooms are addressed `GAME_ROOMS.idFromName(gameId)`, so the same game always
resolves to the same DO identity even if that DO's storage was wiped.

Live sessions use the WebSocket Hibernation API, so an idle game costs nothing
while still holding its connection. Per-connection state is limited to
`{ gameId, keyHash, proto }` in `serializeAttachment` (the cap is 2 KiB);
everything else is rehydrated from SQLite inside `webSocketMessage`.

Messages (JSON, zod-validated, binary fields base64url):

| Direction | Message |
|---|---|
| client to relay | `hello{v, keyHash, tipSeq, tipHash}`, `append{entries}`, `req{fromSeq}`, `push_sub{subscription}` |
| relay to client | `state{tipSeq, tipHash, tombstone?}`, `entries{fromSeq, entries}`, `appended{tipSeq, tipHash}`, `err{code, detail?}` |

On reconnect both sides exchange tips; whoever is behind sends `req` and
fast-forwards. `tipSeq: -1` means the relay holds no log, which happens when the
DO is fresh or was evicted — the first client back re-uploads its whole log.

The relay's checks are strictly transport-level: contiguous `seq` (the SQLite
primary key doubles as the tiebreaker for a simultaneous-append race), `prevHash`
continuity against its own copy, and a 64 KiB per-entry cap. It cannot do more,
and must not try.

Everything above works fully asynchronously. A live socket is an optimization;
making a move, closing the app, and having the opponent move six hours later is
the normal case.

## Retention and tombstones

A room with no activity for 90 days has its ciphertext deleted by alarm. What
remains, permanently, is a ~200-byte tombstone:

```
{ gameId, tipHash, participantKeyHashes, timestamp }
```

The tombstone is what makes eviction safe. Without it, a relay (or anyone who
compromised it) could serve an empty room and silently accept a *shorter*
history than the one that existed — a rollback that erases the last few moves.
A client restoring an evicted game checks that the tombstone's `tipHash` appears
at the expected position in the log being restored, and refuses otherwise.

"Permanent" here means the relay never deletes that row. An operator with
database access can still delete it; that is outside the threat model, and no
client-side protocol can prevent it.

## Push notifications

Push payloads are **content-free**: at most an opaque `gameId`. The client fetches
and decrypts real state when opened. RFC 8291 encrypts payloads in transit, but
APNs and FCM still relay them, and a notification that says what your opponent
just played is exactly the leak this project exists to avoid.

The relay sends one push when the opponent appends, and one reminder if a turn
has gone unanswered for 24 hours. It does not nag beyond that.

iOS constraints shape the UX rather than being worked around:

- push works only when the PWA is installed to the home screen,
- the permission prompt must come from a user gesture,
- cached assets may be evicted after roughly a week of inactivity,
- Background Sync is unavailable, so sync runs on app open and on push.

The app detects standalone mode, shows an install walkthrough to Safari users,
and asks for notification permission only from a button, only after the first
game exists.

## Game plugins

Every game is a set of **pure functions** over bytes:

```rust
fn setup(config: &PluginConfig, seed: u64) -> State;
fn validate_move(state: &State, mv: &Move, player: PlayerId) -> Result<(), MoveError>;
fn apply_move(state: &State, mv: &Move) -> State;
fn player_view(state: &State, player: PlayerId) -> ViewState;
fn is_game_over(state: &State) -> Option<Outcome>;
```

The purity is structural, not a convention:

- **Game rules compile to a separate WASM binary from the core.** `tabla-wasm`
  holds identity, key agreement, the log, and session decryption;
  `tabla-plugin-wasm` holds only game rules and does not depend on `tabla-core`
  at all. The plugin binary therefore contains no cryptographic code — not
  unused code, *no* code. A test asserts this by scanning the built artifact for
  crypto symbols, so the split cannot quietly collapse into a single module.
  (For scale: the core is ~280 KB, the plugin ~40 KB.)
- plugins run in a dedicated module Web Worker whose global `fetch`,
  `XMLHttpRequest`, and `WebSocket` are deleted at startup,
- the worker receives only state and move bytes — never a key, never an
  IndexedDB handle, never the relay connection,
- all I/O, crypto, and relay traffic belong to the core app.

Because the boundary already exists, phase 3 changes only *how* a plugin module
is fetched and verified, not what it is permitted to do.

The plugin also owns move serialization (`encodeMove` / `decodeMove`). The UI
describes a move in its own terms — `{"cell":4}` — and never hand-rolls the wire
bytes, because those bytes are signed into the log: an encoding mismatch between
the UI and the rules would be unrecoverable rather than merely wrong.

`player_view` exists so that a game with hidden state can render without the
renderer ever holding the parts that player is not entitled to see.

Downloadable plugins (phase 3) will ship with hashes pinned in a signed manifest
bundled with the core app, verified on load and refused on mismatch. Phase 1
compiles tic tac toe in, so the isolation is enforced but the manifest is not
yet needed.

## Fairness tiers

**Casual, asynchronous (phase 2).** Hidden state such as a tile bag uses
commit-reveal with a jointly derived seed: both players commit entropy, then
reveal, and the combined hash seeds a deterministic shuffle. At the end of the
game the full seed is revealed and either client can replay every draw. Cheating
is retroactively detectable, which is the right bar among people who know each
other.

**Competitive, real-time (phase 4).** Full mental poker, threshold ElGamal with
a verifiable shuffle. This tier is **synchronous by design**: opening a tile
requires the opponent's live decryption share. Pre-issuing shares to make it
asynchronous does not work — with variable-width draws (refill-to-seven), the
number of shares a player holds leaks lookahead. Competitive means live; casual
means correspondence. Nothing in phases 1 to 3 may preclude this.

## Backup and migration

A single encrypted export contains all game logs **and the identity keypair**.
Without the keypair the logs are unverifiable and unreadable, so an export that
omitted it would be worthless.

```
"TABLAEXPORT1" || argon2 params || salt || nonce ||
  XChaCha20-Poly1305( postcard{ identity_seed, contacts, logs } )
```

## Phases

1. **Now:** the full pipe, with tic tac toe.
2. Word game: SCOWL/ENABLE-derived word list (never TWL/NWL or Collins), original
   board, tile distribution, and name; commit-reveal bag with end-of-game audit.
3. Downloadable plugins with signed manifests and pinned hashes.
4. Real-time competitive tier.
