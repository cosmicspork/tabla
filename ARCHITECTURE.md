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

### Per-game draw entropy

A game with hidden state needs a secret that fixes what a player will draw
before they can see anything that might tempt them to choose. It is **derived,
not stored**:

```text
draw_seed = HKDF-SHA256(ikm: identity seed, salt: "tabla/draw-seed/v1", info: game_id)
```

Deriving rather than storing is what keeps backups working. The export already
carries the identity seed, so a restored device recomputes the same value and
rebuilds a half-played rack from the log alone — a browser test checks exactly
that, restoring a game in progress into a fresh profile and finding the same
tiles. A separate stored secret would mean a backup that restored the board but
not your hand.

HKDF rather than the seed itself, because this value is **published** when the
game ends so the opponent can audit every draw. The reveal has to say nothing
about the key that signs entries.

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
continuity against its own copy, and a 64 KiB per-entry cap. Batches apply
all-or-nothing, and re-sending an entry the relay already holds is accepted as a
no-op if it is byte-identical — reconnecting clients do this routinely — but
refused if it differs. It cannot do more, and must not try.

### Exactly how much the relay understands

The relay reads an entry's **framing** and nothing else: the sequence number at
offset 12, the previous hash at offset 16, and the entry's own hash, computed as
SHA-256 over everything but the trailing 64-byte signature. It never touches the
payload, and holds no key with which it could.

That much is needed for two jobs:

1. Refusing an append that does not continue the log it already holds, so a
   racing or buggy client cannot corrupt the shared copy.
2. Writing an accurate tombstone. The relay computes the tip hash **itself**
   rather than believing a client, because a client that reported a hash for a
   history that never existed could otherwise permanently block its opponent
   from restoring the game.

This duplicates a small piece of the format in TypeScript
(`shared/src/framing.ts`), which is a real drift risk: a disagreement with the
Rust core would mean silently rejected appends or tombstones pointing at nothing.
So a test builds real signed entries with the Rust core and asserts the
TypeScript helpers read the same sequence numbers and compute the same hashes.

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
has gone unanswered for 24 hours. It does not nag beyond that: the reminder's
due time is deleted as it fires, so waking again cannot re-send it. A push is
skipped entirely when the opponent already has a live socket — they have the
move already.

The room counts delivery attempts and records the last result, because a push
that silently fails is otherwise invisible: the person simply never hears about
their turn.

What automated tests can show is that the relay attempts a push to the right
participant, that the body encrypts cleanly under RFC 8291, and that the reminder
fires exactly once. Actual delivery runs through APNs and FCM and cannot be
exercised in CI, so it stays a manual check on a real device.

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
fn setup(config: &[u8], seed: &[u8; 32], assets: &[u8]) -> Result<State, PluginError>;
fn validate_move(state: &State, mv: &Move, player: PlayerId, assets: &[u8]) -> Result<(), PluginError>;
fn apply_move(state: State, mv: &Move, assets: &[u8]) -> Result<State, PluginError>;
fn player_view(state: &State, player: PlayerId) -> View;
fn is_game_over(state: &State) -> Option<Outcome>;
```

`assets` is bulk reference data a game needs but does not carry — a word list,
say. It is passed in because a plugin cannot fetch anything, and it is
**untrusted**: a game that reads assets verifies them against a hash carried in
its own configuration, which is itself pinned in the invite both players agreed
to. Two clients reading different word lists would disagree about whether a
challenged word is real, which is exactly the desync the determinism rule exists
to prevent. A game that needs no reference data is handed an empty slice and
must behave identically whatever it is given; a test asserts that of tic tac
toe.

Across the sandbox boundary the bytes are sent once and referenced by hash
afterwards. The position is recomputed from the whole move list on every render,
so copying half a megabyte per request would be absurd: the worker reports what
it is missing, the host supplies it, and the request is retried.

The purity is structural, not a convention:

- **Game rules compile to a separate WASM binary from the core.** `tabla-wasm`
  holds identity, key agreement, the log, and session decryption;
  `tabla-plugin-wasm` holds only game rules and does not depend on `tabla-core`
  at all. The plugin binary therefore holds no key material and links nothing
  that could use one. A test asserts this by scanning the built artifact for the
  symbols that would say otherwise, so the split cannot quietly collapse into a
  single module. (For scale: the core is ~284 KB, the plugin ~203 KB with both
  games in it.)

  A game with hidden state does hash — commitments and the tile draw are
  SHA-256 over public values, and the point of them is that the opponent can
  recheck the result. That is not a capability, and the invariant worth stating
  precisely is the one the test enforces: no keys, and nothing keyed.
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

**Casual, asynchronous (phase 2, built).** Hidden state such as a tile bag uses
**private draw streams with an end-of-game audit**. This is not the design the
original specification described, and the difference is worth setting out.

The specification asked for commit-reveal over a *jointly derived* seed: both
players contribute entropy, the combined hash seeds one shuffle of a shared bag,
and the seed is revealed at the end so every draw can be replayed. Those two
halves cannot both hold. If both players can derive the joint seed then both can
read the whole bag, including each other's racks, and there is nothing left to
reveal at the end. If neither can derive it until the end, then neither can
compute their own draws during the game. Opening part of a shared shuffle
without opening the rest is precisely mental poker, which needs a live opponent
for every draw and therefore belongs to the competitive tier below.

What is built instead keeps every property the specification was reaching for.
Each player has their own secret for the game, derived from their identity key
(see [Key derivation](#key-derivation)). Player P's *i*th tile is chosen by

```text
SHA-256(s_P ‖ nonce ‖ i)
```

where `nonce` is fresh randomness from the **opponent's** most recent log entry.
P publishes `H(s_P)` before any nonce they will draw against exists, so P cannot
search for a seed that deals well; the opponent chooses nonces without knowing
`s_P`, so they cannot steer the draw either. Refills wait for the opponent's
next entry rather than landing when a play is made, so a player cannot see what
they are about to draw before deciding how many tiles to spend — and so a play
that is challenged off the board can have its refill cancelled.

After every draw the player publishes `H(rack ‖ salt)`. At the end of the game
both reveal their seeds, and every draw either of them made is recomputed from
scratch and checked against those promises, along with every tile they claimed
to play. The audit is a pure function of the public log, so both devices reach
the same verdict, and a player who fails it loses whatever the score said.
Cheating is made visible rather than impossible, which is the right bar among
people who know each other.

**The cost, stated plainly.** A player draws from the tiles *they* have not
seen, which includes whatever is on the opponent's rack. So both players can
hold the same physical tile at once, and over a game the board can show more
copies of a letter than the bag contained. Tile counting is softened as a
result. This is what asynchronous hidden state costs; the collision-free version
is the competitive tier, and it is not asynchronous.

Two further limits are accepted rather than solved. A player who loses the
opening toss can simply abandon the game, which is indistinguishable from any
other abandoned game. And a player who refuses to reveal at the end leaves the
game unsettled; resigning is the escape hatch, and it skips the audit by
design.

**Competitive, real-time (phase 4, not built).** Full mental poker, threshold ElGamal with
a verifiable shuffle. This tier is **synchronous by design**: opening a tile
requires the opponent's live decryption share. Pre-issuing shares to make it
asynchronous does not work — with variable-width draws (refill-to-seven), the
number of shares a player holds leaks lookahead. Competitive means live; casual
means correspondence. Nothing in phases 1 to 3 may preclude this.

## Letras

The word game that phase 2 exists for. The rules live in `tabla-letras` and are
summarised here only where they bear on the protocol; the crate documentation
has the rest.

**Turn structure.** The log alternates strictly, so every turn is an entry:
passing, exchanging, yielding the opening, and forfeiting a challenged turn are
all moves. A game opens with two commitments, the initiator opening the toss for
who plays first, and — if the toss went against the claimer's slot — a yield.

**Challenges.** A play is legal the moment it is geometrically sound. Whether it
is a word is a question the opponent has to raise, and pays for if they raise it
wrongly. The window is exactly one entry wide: anything else the opponent does
waives it, which is why waiving needs no move of its own. A successful challenge
takes the play back — board, score, tiles, and the refill it had earned — and
costs the placer their next turn. A failed one costs the challenger theirs.

This is the tournament rule, and it is deliberate. Checking words automatically
would make a wrong word impossible rather than punishable, which is a different
game, and it would turn the word list from a referee into a rule.

**Honour mode.** There is none, and there will not be one beyond a label. The
specification is explicit: no anti-cheat. The audit is not anti-cheat — it is a
receipt.

**Original content.** The board layout, the tile distribution, the point values,
and the name are all original, and two of them are original *by construction*:
the tile set is derived from the word list's own letter frequencies by a
checked-in script that a test re-runs, and the premium layout is written as one
eighth of the board and mirrored eight ways. Triple-word squares sit two squares
in from each corner rather than at the corners, there is no diagonal double-word
chain out of the centre, and the premium counts are 8/12/16/20 against the
familiar 8/17/12/24.

**The word list** is ENABLE, public domain, vendored with its provenance in
`wordlist/PROVENANCE.md` and compiled to a 492 KB graph. TWL/NWL and Collins are
proprietary and must never appear here. The compiled artifact is committed and
pinned by hash in two places — a Rust golden test that rebuilds it from the word
list and compares bytes, and `shared/src/constants.ts`, where the app checks it
before handing it to the sandbox. It is excluded from the service worker's
install-time precache and fetched on first use, so a visitor who never plays it
never downloads it, and a player who has works offline afterwards.

## Backup and migration

A single encrypted export contains all game logs **and the identity keypair**.
Without the keypair the logs are unverifiable and unreadable, so an export that
omitted it would be worthless.

```
"TABLAEXPORT1" || argon2 params || salt || nonce ||
  XChaCha20-Poly1305( postcard{ identity_seed, contacts, logs } )
```

## What is not automatically verifiable

Stated plainly, because a test suite that stays quiet about its blind spots is
worse than one that names them:

- **Push delivery.** Everything up to the push service's door is tested; the leg
  through APNs and FCM cannot run in CI. Delivery is a manual check on a real
  device, described in the README.
- **Real iOS behaviour.** The install gate, standalone detection, and offline
  shell are exercised against an emulated iPhone, which gets the user agent and
  viewport right but is still Chromium. Home Screen installation, seven-day
  cache eviction, and Safari's push implementation need hardware.
- **Opponent tile possession, during a game.** Nothing checks that the tiles an
  opponent plays are tiles they actually drew until both seeds are revealed at
  the end. That is not an oversight; it is what hidden state means. The audit is
  the check, and it is retrospective by construction.
- **Tombstone permanence against the operator.** A tombstone protects against a
  relay that lost data or is lying about history. It cannot protect against
  someone with database access deleting the row; that is outside the threat
  model and no client-side protocol can fix it.

## Phases

1. **Done:** the full pipe, with tic tac toe.
2. **Done:** Letras — ENABLE-derived word list (never TWL/NWL or Collins),
   original board, tile distribution, and name; private draw streams with an
   end-of-game audit, and tournament-style challenges.
3. Downloadable plugins with signed manifests and pinned hashes. The asset seam
   and the hash pinning landed with phase 2, so what remains is fetching a
   *module* the way a dictionary is already fetched.
4. Real-time competitive tier.
