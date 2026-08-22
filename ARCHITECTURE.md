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
- IP addresses at connection time (Cloudflare's, not ours, but real),
- that an opaque mailbox id exists, is being written to, and is being polled —
  see **Inviting a contact**, which also says why that is not a new kind of
  knowledge, and **Playing from more than one device**, which adds one such id
  per device without making any of them distinguishable from a contact's.

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

Starting a game asks who before what, and an invite addressed to a contact
records who it was meant for. That is an intention rather than a fact — the link
is a bearer token, and whoever opens it first is the opponent — so if a
different key claims it, the name is dropped and the real one is taken from
their prologue entry instead.

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
    name: String,          // v2: what the initiator would like to be called
}
```

`name` is a label and nothing else — not checked, not unique, and renameable by
whoever receives it. The public key is who someone is. It rides here rather than
in the claim so the relay never sees it, which is what keeps display names on
the list of things the relay does not know.

Version 1 blobs, which have no name, are still opened: invites live for seven
days, and a format change must not kill links already in flight. Postcard is not
self-describing, so the version is read first and the rest decoded to match —
decoding a v1 blob as a v2 struct would not fail cleanly, it would read whatever
followed the last field it recognised.

The claimer refuses the invite on any `plugin_id` / `plugin_version` /
`dictionary_hash` mismatch with its own build. Divergent validation discovered
mid-game is unrecoverable, so it must be refused at the start.

### Names in the log

The invite carries the initiator's name. The claimer's travels the other way, in
the prologue:

```rust
enum EntryBody {
    Join   { claimer_pub_key },              // as it always was
    JoinAs { claimer_pub_key, name },        // the same, with a name
    ...
}
```

A separate variant rather than a field on `Join`, for the same postcard reason:
adding a field would change how every prologue already written is read, and
those are in games people are still playing. A new variant leaves them exactly
as they were, and a build with no name to give still writes the old one.

Both names are inside things the relay cannot read — a sealed blob and a signed,
encrypted log entry — so nothing about this reaches it.

### Inviting a contact

A link is how you reach a stranger. After one finished game it is no longer
needed: both sides hold the other's identity key, so both can compute the same
X25519 secret, and that is enough to agree on somewhere to leave an invitation.

```
pair       = X25519(mine, peer)
mailboxId  = HKDF(ikm = pair, salt = "tabla-mailbox/v1",     info = "to" || recipient)[0..16]
mailboxKey = HKDF(ikm = pair, salt = "tabla-mailbox-msg/v1", info = mailboxId)
body       = XChaCha20-Poly1305(mailboxKey, nonce, aad = "tabla-mailbox/v1" || mailboxId,
                                postcard{ blob_id, blob_key, plugin_id, plugin_version, created_at })
```

The id is per direction, so a recipient polls only its own inbox. `POST
/api/mailbox/<id>` leaves a message, `POST /api/mailbox/poll` reads up to 64 at
once, `DELETE /api/mailbox/<id>/<messageId>` drops one, and `PUT
/api/mailbox/<id>/push` registers for a content-free nudge.

**Why nothing is signed.** The id is a 128-bit capability derived from a secret
only two people can compute: anyone able to name a mailbox is already entitled
to write to it. A signature would have to be checked against a key derived from
that same secret, so it would admit exactly the same principals — buying no
access control, while making the relay verify signatures for the first time and
store a key per mailbox. Storage is bounded by a cap instead (16 pending), and
the client's remedy for a contact who abuses it is to remove them, after which
it stops polling that mailbox at all.

**Why the invite blob stays where it was.** The message carries the two halves
of the link and nothing else, so the single-use claim, the cancel token, and
everything built on them are untouched. It also lets a recipient decline
without claiming — claiming is spending.

**What the relay learns.** A stable opaque id per pair and direction, that it is
written to and polled, and when. It can correlate a mailbox write with an invite
created moments earlier from the same address, and so guess that the two are
related — which tells it no more than the game room it leads to, where both
participants' key hashes are visible anyway. It never learns a public key, a
name, a game, or who invited whom.

**One caveat worth stating.** An invitation is a bearer token like any other, so
accepting one checks that the invite's initiator key really is the contact whose
mailbox it came from.

Every device of one person derives the same pair mailboxes, so any of them may
find an invitation from a contact — which is what you want, and used to be a
problem: two live devices would race to consume the same message. They no longer
do, because whichever consumes it tells the others, and a device that hears
about a game it has already been told about writes the same row again. See
**Playing from more than one device**.

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

### Withdrawing one

An invite can also be taken back before anyone redeems it. The problem is that
the relay has never seen the initiator's identity key — it is sealed inside the
blob — so there is nothing it could check a request against. Rather than start
storing the key, which would be exactly the metadata the relay is built not to
hold, `POST /api/invite` returns a second random 16-byte value:

```
{ blobId, expiresAt, cancelToken }
```

`POST /api/invite/<blobId>/cancel` with that token deletes the blob and its
alarm. The token is returned once, at creation, and `status` never repeats it,
so holding it is the same thing as having made the invite. It is compared in
constant time.

A claimed invite is refused with a 409 rather than deleted. By then it is a game
with two players in it, and deleting the blob would not un-start it — resigning
is what ends a game.

### Which browser the link opened in

A link is opened by the operating system, not by us, and on iOS it is never
opened by the installed app. A Home Screen web app there has its own storage
container: same origin, same code, and none of the other one's data. A tapped
URL or a scanned QR code opens Safari — or an in-app browser, which is a third
container again — and nothing in a manifest changes that.

That would be cosmetic if links were repeatable. They are not. Claiming is what
spends an invite, and claiming is also what generates the identity that spends
it: `loadIdentity` makes a key on first call. So a link redeemed in the wrong
container burns the one-use token, mints a stranger's identity, and puts the
game somewhere the app on the Home Screen cannot reach — and looks exactly like
success while doing it. The person finds out days later, when the game is not
there and the link is gone.

Two halves, because no one thing fixes it:

- **Where the platform can route the link, it is asked to.** The manifest
  declares `handle_links: preferred`, which offers in-scope links to the
  installed app, and `launch_handler.client_mode: navigate-existing`, which
  sends them to the window already open rather than a second one. Chromium acts
  on both, subject to the switch the system keeps for it — Android calls it
  "open supported links" — so this is a request and not a guarantee. It is
  enough there, because on Android and the desktop a tab and the installed app
  share one storage container anyway: what is at stake is which window appears,
  never whose games are in it.
- **Where it cannot, nothing irreversible happens until we know.** On iOS in a
  tab, `/j` and `/link` stop before claiming. `identityExists` answers "has
  anyone played in this container?" without the asking being the answer — the
  ordinary `loadIdentity` would generate one and make it true. If the answer is
  no, the person is asked, once, in the only terms that can be checked from
  inside the wrong container: do you already play tabla here? Someone genuinely
  new says no and joins where they landed, which is how most people meet tabla
  and costs them one tap. Someone who already plays is sent to the app with the
  link intact.

What this deliberately does not catch is an in-app browser on Android. The
WebView inside a chat app has its own storage too, but it is told apart from the
real browser only by user-agent guesswork, and a list of chat apps to sniff for
is a list that goes stale. Someone who lands in one joins as a new person, as
they always have; `/open` is the way back, and it is on the game list rather
than behind a link precisely so it can be reached without one.

### Reading the code instead of following it

There is a shorter route whenever the code is on a screen in front of you, and
it is to not let the link out of the app at all. Reading a QR with the phone's
camera app opens Safari, because a URL is what a camera app does; reading it
from inside tabla skips the browser, the clipboard, and everything above. Both
`/open` and `/link` offer it.

That was not possible while scanning meant `BarcodeDetector`, which Safari does
not have — so the one platform where a link cannot reach the installed app was
also the only one never offered a scanner, and the QR on screen was decoration.
A decoder now ships for the engines without a native one: jsQR, vendored at
`static/qr/` and kept out of the install-time precache beside the word list and
the downloadable games, fetched on the first tap of Scan by the devices that
need it and by no others. Around 57 kB, once, on Safari.

`scan.ts` decides between the two decoders and knows nothing else; in
particular it does not know what a code *means*. The scanner hands raw decoded
text to whatever function the caller passes — `parseSharedLink` on `/open`,
`linkWordsFrom` on `/link` — which are the same functions behind the paste box
and the words field. A scan therefore cannot accept something a paste would
refuse, and a stray code the camera catches is not an error but a frame to keep
scanning past.

The hand-off below is what remains for the codes that are not in front of you —
an invite that arrived in a chat message, which is most of them.

The hand-off is manual because it has to be: an installed web app on iOS cannot
be sent a URL. `/open` is the other end of it — paste the link, or the six
words, and it is dispatched. That works for the same reason the relay cannot
read an invite: the secret is in the fragment, which never went to a server and
needs no server to come back. `parseSharedLink` takes whatever survived the
trip — a whole URL, a bare fragment, six words read aloud — because the cost of
not recognising a single-use link is another trip to the person who sent it.

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

Push payloads are **content-free**: at most an opaque `gameId`, or an opaque
`mailbox` id when an invitation has arrived from a contact. The client fetches
and decrypts real state when opened. RFC 8291 encrypts payloads in transit, but
APNs and FCM still relay them, and a notification that says what your opponent
just played is exactly the leak this project exists to avoid.

The relay sends one push when the opponent appends, and one reminder if a turn
has gone unanswered for 24 hours. It does not nag beyond that: the reminder's
due time is deleted as it fires, so waking again cannot re-send it. A push is
skipped entirely when the opponent already has a live socket — they have the
move already.

Subscriptions are stored **per endpoint**, not per participant, so a person with
a phone and a laptop is told on both. They were per participant until devices
existed, which meant whichever subscribed last silently replaced the other and
the first simply stopped hearing about its turns. Rooms already in flight carry
their old subscription into the new table the first time they are touched. A
device that turns notifications off has its own row dropped by the next room it
opens, rather than left to lapse on a 410; the notification tag is the game id,
so playing a move anywhere clears the nudge everywhere.

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
- Background Sync is unavailable, so sync runs on app open and on push,
- an installed app and Safari keep separate storage, and links always open
  Safari — see "Which browser the link opened in",
- there is no `BarcodeDetector`, so scanning a code needs a decoder shipped for
  it — see "Reading the code instead of following it".

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
played word is real, and since version 3 of the word game that is not a dispute
but a fork: one device would seal an entry the other refuses to replay. This is
exactly the desync the determinism rule exists to prevent, and it is why the
list is pinned by hash rather than merely shipped alongside. A game that needs no reference data is handed an empty slice and
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
  single module. (For scale: the core is ~370 KB, the bundled plugin module
  ~100 KB, and the downloadable word game a further ~200 KB.)

  A game with hidden state does hash — commitments and the tile draw are
  SHA-256 over public values, and the point of them is that the opponent can
  recheck the result. That is not a capability, and the invariant worth stating
  precisely is the one the test enforces: no keys, and nothing keyed.
- plugins run in a dedicated module Web Worker whose global `fetch`,
  `XMLHttpRequest`, and `WebSocket` are deleted at startup,
- the worker receives only state and move bytes — never a key, never an
  IndexedDB handle, never the relay connection,
- all I/O, crypto, and relay traffic belong to the core app.

Because the boundary already existed, phase 3 changed only *how* a plugin module
is fetched and verified, not what it is permitted to do. See **Plugin
distribution** below.

The plugin also owns move serialization (`encodeMove` / `decodeMove`). The UI
describes a move in its own terms — `{"cell":4}` — and never hand-rolls the wire
bytes, because those bytes are signed into the log: an encoding mismatch between
the UI and the rules would be unrecoverable rather than merely wrong.

`player_view` exists so that a game with hidden state can render without the
renderer ever holding the parts that player is not entitled to see.

## Plugin distribution

Tic tac toe is compiled into the app. Every other game — Letras today — is a
WASM module of its own, fetched the first time somebody plays it, checked
against a signed manifest, and kept on the device until they remove it.

One game stays bundled deliberately: a fresh install, or a device with no
connection, still has something to play.

### The manifest

`app/src/lib/plugin/manifest.json` names every downloadable module and every
reference file one reads, each by path, SHA-256, and byte count. It ships with
the app, alongside `manifest.sig`: an Ed25519 signature over the tag
`tabla-manifest/v1` followed by the manifest file *verbatim*.

Verbatim matters. The signature covers the bytes as stored, so there is no
canonical form to agree on and no parser for a forged manifest to reach — the
JSON is not looked at until the signature checks out. `app/.prettierignore`
keeps the formatter from having an opinion about a file whose exact bytes are
load-bearing.

Verification happens in the **core** module (`tabla-core::manifest`, exposed as
`verifyManifest`), never in the plugin module, which links no keyed
cryptography at all — the very property the manifest exists to protect. The
publisher's public key is pinned in `shared/src/constants.ts`; the private key
lives outside the repository, so CI can verify a signature and can never
produce one.

### What the signature is and is not worth

Being plain about this is better than implying more. The manifest, the
signature, and the key that checks it all ship in the same bundle: anyone who
can rewrite the bundle can rewrite all three, and the signature proves nothing
about that. Its value is in two real places:

- an artifact's hash cannot change in the repository without someone holding
  the key deliberately re-signing, so a changed binary is never a diff nobody
  looked at; and
- the day a manifest is served from anywhere other than the bundle — a remote
  catalogue, a third-party game — the verification is already in place and
  load-bearing rather than being retrofitted.

Rotating the key means re-signing and shipping the new constant in the same
release. An older build keeps trusting the old key, which is correct: it is
also still running the artifacts that key signed.

### Committed artifacts

`app/static/plugins/letras-v1.wasm` is committed, not built by `just build`.
Compilers do not produce byte-identical output across toolchains, and the bytes
a player downloads have to be the bytes a hash was pinned to. `just plugins`
regenerates it and `just sign-manifest` re-signs; both are deliberate acts, the
way `just dict` already was.

The recipe also patches the generated loader's fetch fallback into a throw. The
sandbox has no network, so a module can only ever arrive from the host — and
leaving the fallback in would make the bundler emit a second copy of the module
into the app, which is precisely what downloading it avoids. A test asserts the
committed loader contains no `import.meta.url`, so a regeneration that skipped
the patch fails loudly.

### Fetching, storing, and removing

`plugin/install.ts` is the only path: verified manifest, then memory, then
IndexedDB, then the network — and every fetch ends in a hash check against the
manifest before the bytes are stored or used. The check is not a formality: the
app is served with a single-page fallback, so a mistyped path comes back as
`index.html` with a cheerful 200.

Files are kept in IndexedDB rather than a cache. The service worker drops every
cache on activation, so a cached module would be re-downloaded on every
release, and a cache cannot promise a player that removing a game gave the
space back. The service worker skips `/plugins/` and `/dict/` entirely, so
nothing is stored twice.

A miss is never fatal, and that is what makes the iOS eviction guidance
straightforward: a device that discards storage after a week of inactivity, and
a player who removed the game and came back, are the same case, handled by the
same line — fetch it again.

Superseded rules are removed without being asked about. A version is held only
because a game in progress agreed to it, so once the last such game is finished
it is holding nothing — and a player who has to reason about which version of a
game they need has been handed the wrong job. The storage page says how much it
freed rather than asking first. Removal never touches a file another installed
version still needs: two versions of the word game share a list, and the same
sharing is why a game's size is counted by distinct file rather than by summing
its versions.

### What "downloadable" does not mean

The rules download; the app does not. A game's board component, its loader
glue, and its registry entry still ship with the app, and so does the manifest
itself. A genuinely new game therefore still needs an app update. What phase 3
buys is that a game's *rules and data* — the bulk of it — are fetched on
demand, verified before they run, and removable afterwards.

## The deal

Tiles are dealt from one encrypted deck that neither player can read. Both
shuffle it, every step carries a proof, and a tile becomes visible only when
somebody with the right to see it opens it. This is the standard mental-poker
construction — threshold ElGamal over ristretto255 with a zero-knowledge
argument of correct shuffle — and it is how the word game deals now.

### The schedule

Each player derives a secret share of the deck key from their identity, so a
restored backup recomputes it and can still read a rack it was dealt. The public
halves are added: the deck is encrypted under the sum, and opening anything
needs a contribution from both. The bag in canonical order is public and
identical on both devices, so the starting deck costs no log entries at all —
the shuffles are what make it a bag.

| Move | Author | Carries |
|---|---|---|
| 0 | initiator | key share, proof of knowledge, commitment to its half of the toss |
| 1 | claimer | key share, proof, its half of the toss in the clear, first shuffle |
| 2 | initiator | second shuffle, opens its toss, deals the claimer's rack |
| 3 | claimer | deals the initiator's rack |
| 4… | initiator | play begins, or a yield if the toss gave the opening away |

Both players shuffle. One would be enough to hide the deck from the opponent and
not at all from the shuffler.

### What each proof pins down

- **Proof of knowledge**, on a published key share: that its author can actually
  open it. Without this a player could publish `Y − X_opponent` for a `Y` of
  their choosing and control the joint key outright.
- **Discrete-logarithm equality**, on every decryption share: that the share was
  computed with the key its author published. A share is otherwise
  unfalsifiable in the wrong direction — a wrong one opens a tile to nonsense,
  which without this proof is indistinguishable from bad luck.
- **The shuffle argument**, on every shuffle: that the new deck is a permutation
  of the old one, re-randomised, with nothing added, dropped, duplicated, or
  substituted.

### Drawing, playing, and opening

A tile is dealt by its holder's *opponent* publishing a decryption share for the
next position off the top. Only the recipient can combine it with their own, so
only they can read it. Which positions each player holds is public; what is in
them is not. Tile counting is exact.

Playing a tile means opening it: the placer publishes their own share, both
shares are then in the log, and anyone can check the tile against what the move
claims. Playing something you were not dealt is not a thing that can happen.
At the end, each player opens their remaining rack so the closing adjustment is
public too.

**Refills ride the opponent's next entry.** After a play spends `n` tiles, the
opponent's next entry carries shares for the next `n` positions — an entry that
was going to exist anyway. Nothing is handed over before the play that earns it
is already public, which is what lets all of this work at correspondence pace.
Since version 3 there is no move that takes a play back off the board, so
nothing can cancel a refill; under versions 1 and 2 a successful challenge did,
and nothing had been pre-issued to claw back.

### What it costs

A shuffle is the largest entry the protocol writes: 102 ciphertexts at 64 bytes
each is 6,528 B, and the proof is 10,240 B, for about 17 KB against the relay's
64 KiB ceiling. Everything else is small — a key share is roughly 350 B and a
seven-tile refill about 700 B. Proving a full bag takes about 26 ms and
verifying it about 16 ms on a development machine; a browser is slower, which is
why a verified deal is snapshotted against the log tip rather than recomputed on
every render.

### The limits, stated plainly

- **A player can stall.** Refusing to open a final rack leaves the game
  unsettled, exactly as refusing to move does. Cheating is impossible; leaving
  is not, and no client-side protocol fixes that. Resigning is the escape hatch.
- **The relay sees sizes and timing.** It cannot read a deck or a tile, but it
  can tell a shuffle entry from a pass by its length. That was already true of
  every other entry and is inherent to a relay that stores anything.
- **Repeated tiles encrypt to the same point.** Both blanks, and every duplicate
  letter, share a plaintext. This leaks nothing: re-randomised ElGamal
  ciphertexts of equal plaintexts are indistinguishable without the key, and the
  shuffle argument is zero knowledge, so neither the deck nor its proofs say
  which positions match. Only opening does, which is what opening is for.
- **The proof system is ours.** It is tested hard — including against a prover
  run faithfully on a witness that is not a permutation — but it has not been
  audited by anyone else.

## Fairness tiers

There are none. There were going to be two, and the reasoning that produced
them is worth keeping, because the correction is the interesting part.

**What was planned.** A casual asynchronous tier using private draw streams,
and a competitive real-time tier using mental poker — separated because opening
a card in mental poker needs the opponent's live decryption share, which reads
as incompatible with correspondence play. Competitive would mean live; casual
would mean whenever you get to it.

**Why that turned out to be wrong.** The premise holds in general and does not
hold here, because of a rule the game already had: you draw after your opponent
moves, not when you play. That rule exists so a player cannot see their next
tiles before deciding how many to spend — and it puts an opponent entry between
every play and its refill. That entry is exactly the slot a decryption share
needs. The shares are issued *after* the play's width is already public, so
nothing is pre-issued and nothing leaks lookahead; the specification's warning
about pre-issued shares is about a design this one does not use.

So full mental-poker fairness runs at correspondence pace, and a second tier
would have bought nothing. The tiers collapsed into one.

**What the earlier design cost, and no longer does.** Version 1 dealt each
player from the tiles *they* had not seen, from a secret of their own, and
reconciled the two streams with an audit when the game ended. Every property it
reached for held — neither player could predict or steer the other's draws, and
every draw was recomputable afterwards — but both players could hold the same
physical tile at once, so tile counting was soft, and a cheat was only ever
*detectable*. Under the deal there is one real deck, tile counting is exact, and
cheating is impossible rather than visible.

A game finishes under the rules it started with, whichever version those are.
Every shipped version's rules, module and hash stay exactly where they were —
there are three of the word game now — and the app carries all of them; see
**Plugin distribution**.

## Letras

The word game. Its rules live in `tabla-letras` and are summarised here only
where they bear on the protocol; the crate documentation has the rest.

**Turn structure.** The log alternates strictly, so every turn is an entry:
passing, exchanging and yielding the opening are all moves, as were challenging
and forfeiting a challenged turn in versions 1 and 2. A game opens with the deal's ceremony — key shares, two shuffles, and
the opening racks — which also carries the toss for who plays first, and then a
yield if it went against whoever holds the next slot.

**Words, from version 3.** A play has to be geometrically sound *and* has to
make words. The check runs in `validate_move`, so an illegal word never reaches
the log: the mover's device refuses it before sealing an entry, and the
opponent's runs the same check while replaying. Both hold the identical list —
pinned by hash in the invite, verified against those bytes before the rules see
them — so they cannot reach different answers, which is the property that makes
checking safe here at all. The refusal names the offending word, because a play
can make several and only one may be the problem, and the board says so beside
the tiles rather than the page saying it above them: a fifteen-square grid is
taller than a phone screen, so a message at the top of the page is one the
player who pressed Play never sees. It stands until the placement changes,
because the answer to it is to move a tile.

**Challenges, in versions 1 and 2.** A play was legal the moment it was
geometrically sound; whether it was a word was a question the opponent had to
raise and pay for if they raised it wrongly, in a window exactly one entry wide.

That is the tournament rule, and it earns its keep across a physical board where
the alternative is one player leafing through a dictionary while the other
waits. It earned nothing here: both devices could already answer the question
instantly and identically, so leaving it unanswered until someone objected meant
a game could be won with letters nobody claims are words, against an opponent
who was not paying attention. The deal made playing a tile you were not dealt
impossible rather than punishable; version 3 does the same for words. Games
begun under the older rules finish under them.

**Honour mode.** There is none, and there will not be one beyond a label. The
specification is explicit: no anti-cheat, and none of this is anti-cheat: the
deal makes an illegal tile impossible rather than punishable, which is a
property of the protocol and not a judgement about anybody.

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

## Playing from more than one device

An identity can live on several devices at once. To an opponent and to the relay
there is still exactly one player: one public key, one fingerprint, one name.
Nothing in the log changed to allow this, and nothing about a game reveals how
many machines are behind it.

### Why there are no per-device keys

The obvious design — a root identity delegating to per-device subkeys carried in
the log — was specified here for a long time and then not built, because reading
what it would have to survive showed it buying nothing.

Every device needs the **identity seed** regardless. `agree_game_key` derives a
game's key from the two root keys; `draw_seed` and `deal_secret` derive from the
seed itself. A device without it cannot open a single game it is told about. So
the seed is copied, and once it is, a subkey is a label rather than a boundary:
a device that has been "revoked" still holds the root and could sign itself a
fresh delegation. The revocation would be enforceable only against a device that
chose to respect it — which is exactly what a plain notice achieves, without the
rest of the cost.

And the cost was real. `Participants` and `expected_author` would widen; new
`EntryBody` variants would be rejected outright by any build that predates them,
since `replay` refuses an unknown prologue rather than ignoring it; and the relay
would have to learn which key hashes belong to one person in order to fan out,
count presence, and push correctly. Today it cannot link your devices at all.
That is a property worth more than an unenforceable revocation.

So devices are **private**: a 16-byte id and a name, both local, both invisible
outside this identity's own sealed messages.

### How devices tell each other things

Each device has its own mailbox, derived from the seed:

```
mailboxId  = HKDF(ikm = seed, salt = "tabla-device-mailbox/v1",     info = deviceId)[0..16]
mailboxKey = HKDF(ikm = seed, salt = "tabla-device-mailbox-msg/v1", info = mailboxId)
body       = XChaCha20-Poly1305(mailboxKey, nonce, aad = "tabla-device/v1" || mailboxId, notice)
```

One box **per device**, not one per person. A shared box would have every device
reading its own writes and racing the others to consume them — the same race a
pair mailbox avoids by being per-direction. A device that learns something posts
a copy to each of the others.

A notice carries a game (in whatever state it is in), a game that has gone, a
contact and what it is called, a device added, removed or renamed, or a change of
display name. Moves are deliberately **not** announced: the other devices get
those from the room and replay them into the same summary. A game *ending* is,
because a device that never opened it could not work that out.

Everything is best effort. A laptop that is switched off must not stop a phone
starting a game, so a notice that fails to send is a device that finds out on its
next poll, or from the game itself. Applying a name that arrived does not
announce it onward, or two devices would inform each other of it forever.

**What the relay learns.** One more opaque id per device: that it exists, is
written to, and is polled. It cannot tell a person's second device from a second
contact, because both look like exactly this.

### Linking a device

A link is a backup that travels through the relay instead of through a file. Six
words from a 2048-word list do two jobs: joined by spaces they are the passphrase
the bundle is sealed under, and hashed with a domain tag their first sixteen
bytes name the place it is left.

```
linkId = SHA-256("tabla-link-id/v1" || words)[0..16]
blob   = export(passphrase = words, bundle)
```

That the client derives the id is the point: the relay never chooses it, so it
cannot enumerate what it holds, and it never sees the words, so it cannot open
what it has. The blob lives ten minutes, is deleted the moment it is collected,
and a second collection is refused. Sixty-six bits against a ten-minute window
on a relay that can rate limit is not a number anybody is getting through, and
six words can be read across a room, which a URL cannot.

The list is BIP-39's English wordlist, vendored beside ENABLE with its own
provenance. The curation is why: no two words share their first four letters, so
a typo is detectable before the word is finished, and it was picked over for
words that sound alike and words nobody would want to read aloud.

A device that has more history than fits gives up the logs of its finished games
first, then of its oldest unfinished ones, and says how many. Those games are
still listed with their outcomes, and a log comes back from its room if the relay
still has it.

### Whose turn it is

Delegation was never what stopped two of your devices answering the same move,
and neither is anything else in the log. The relay already refuses a second
continuation at a sequence it has filled — it keeps the first and rejects the
rest, which it has always done. So a second device writing a move does not fork
anything; it loses.

What that leaves is a UX problem, and it is solved as one. A device that begins
building a move takes a **hold**: relay room state with an expiry, routed only to
sockets sharing the same participant hash, with a body sealed under the game key
so the relay routes it blind. It is never a log entry — there is nothing here an
opponent needs protecting from, and a new entry body would break turn parity and
every build that predates it.

Two minutes, renewed every thirty seconds while tiles are staged. The other
devices dim the board and say where the move is being made; only a hold that
lapses without a move arriving offers to take the turn back. Games with no
staging step — tic tac toe, where a tap is the whole move — never take one.

When both devices are offline and both move anyway, the loser's entries were
never history. Its engine truncates them, forgets them from storage, deals the
deck again from what is left, asks the relay what actually happened, and says so
once. Entries the relay has **acknowledged** are never truncated: a log that
disagrees about those is diverged, and stays diverged.

### Removing a device

Cooperative, and the app says so. A removed device is told through its own
mailbox, stops, and offers to link again or start over. Nothing can take the
seed back off a machine that holds it, so the screen says that removing asks a
device to stop rather than making it, and that a stolen device wants a new
identity rather than this button.

## Backup and migration

A single encrypted export contains all game logs **and the identity keypair**.
Without the keypair the logs are unverifiable and unreadable, so an export that
omitted it would be worthless.

```
"TABLAEXPORT1" || argon2 params || salt || nonce ||
  XChaCha20-Poly1305( postcard{ v, identity_seed, contacts, games, exported_at,
                               name, devices } )
```

`name` is the display name, added in version 2, and it travels because it
belongs to the identity rather than to the phone: a device that restored
everything except what it is called would introduce itself to everyone it met
next as nobody, and nothing would say so — the people it had already played
cached the name on their own side. What deliberately stays behind is the rest of
the device's local preferences (theme, whether notifications were wanted), which
belong to the phone.

`devices` came with version 3, along with a much fuller record of each game:
status, timestamps, the list summary, and — for an invitation nobody has taken
yet — the half of the link the relay never saw and the token that withdraws it.
Version 2 could not express an unclaimed invitation at all, so an export simply
skipped those games. That was tolerable when restoring meant replacing a lost
phone, and wrong once the same format had to hand an installation to a device
standing next to one still in use.

A restore therefore **adds** a device rather than migrating to one. What it
replaces is whatever was on the device doing the restoring — a machine can only
be one person, and there is no way to reconcile two histories of one game — but
afterwards it is one of that identity's devices beside any others still running,
and it says so to them.

A backup is the one thing here expected to be *old*: the point of one is that it
opens after the phone that wrote it is gone. So version 1 files, which have no
name, and version 2 files, which have no devices, are still read — the version
is decoded first and the rest to match, for the same reason as the invite.

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
- **Our own proof system.** The shuffle argument, the key-share proof and the
  share proofs are implemented here rather than taken from an audited library,
  because no maintained one exists for this construction. They are tested hard,
  including against a prover run faithfully on a witness that is not a
  permutation, and nobody outside this repository has reviewed them.
- **Opponent tile possession, in games started under version 1 of the word
  game.** Those rules check that the tiles an opponent played were tiles they
  drew only when both seeds are revealed at the end. That was what hidden state
  cost before the deal; games still being played under those rules still pay it.
- **Tombstone permanence against the operator.** A tombstone protects against a
  relay that lost data or is lying about history. It cannot protect against
  someone with database access deleting the row; that is outside the threat
  model and no client-side protocol can fix it.
- **Who is talking to whom, against a relay that watches timing.** A pair
  mailbox hides both parties: the id is derived from a secret only they can
  compute, and the body is sealed. What it cannot hide is that an invite was
  created and a mailbox written to from the same address moments apart, from
  which a relay can infer that some pair exists and is arranging a game. The
  game room that follows shows both participants' key hashes anyway, so this
  adds no identity the relay did not already get — but it is an inference the
  design permits rather than prevents. See **Inviting a contact**.
- **A rewritten app bundle.** The plugin manifest is signed, but the signature,
  the manifest, and the key that checks it all ship together — so it detects a
  changed *artifact*, not a changed *app*. Whoever serves the app is trusted to
  serve the app. See **Plugin distribution**.
- **A device that ignores being removed.** Removal is a message, not a lock:
  every device holds the identity seed, so nothing can take it back. A removed
  device that has been modified to disregard the notice keeps playing. The app
  says this where it offers the button, and the honest remedy for a stolen
  device is a new identity. See **Playing from more than one device**.
- **Guessing a link out from under someone.** Six words are 66 bits against a
  ten-minute window, and the blob is deleted on collection — but the relay does
  no rate limiting today, so the margin is arithmetic rather than enforcement.
  Nothing here would notice an attempt; a cap on failed collections per id is
  the cheap answer if one is ever wanted.

## Phases

1. **Done:** the full pipe, with tic tac toe.
2. **Done:** Letras — ENABLE-derived word list (never TWL/NWL or Collins),
   original board, tile distribution, and name; private draw streams with an
   end-of-game audit, and tournament-style challenges.
3. **Done:** downloadable plugins with a signed manifest and pinned hashes.
   Letras is fetched on first play and removable in settings; tic tac toe stays
   bundled so a fresh install can play offline.
4. **Done:** one encrypted deck, shuffled by both players and proven at every
   step — see **The deal**. It was specified as a separate real-time tier; it
   turned out not to need one, and the tiers collapsed. Presence landed with it,
   for every game.
5. **Done:** the product layer the protocol had been waiting for. People have
   names, carried inside the invite and the log's prologue and never seen by the
   relay; a second game against someone you have played reaches them through a
   pair mailbox instead of a link; and words are checked as they are played,
   which retired the challenge. See **Names in the log**, **Inviting a
   contact**, and **Letras**.

   Most of this was possible from phase 1 and simply had not been built. The
   contact picker in particular had been promised in this document, under
   **Identity**, since before there was a relay to promise it about.
6. **Done:** playing from more than one device. Six words hand an installation
   to a laptop through the relay; each device keeps the others in step through
   a mailbox of its own; a device that starts a move claims the turn from its
   siblings, and one that loses the race takes its move back. See **Playing
   from more than one device**, which also records why the per-device signing
   keys this document specified for a long time were not built.

## Roadmap

**Live games, with a clock.** Presence tells you the other player is there; it
does nothing else. A per-game choice between correspondence and live would add a
timer, abandon a game whose player has been away too long, and send a reminder
before it does. Nothing in the protocol needs to change for it — the deal
already works at either pace — so this is a product decision about how a game
ends, not a cryptographic one. Not built.
