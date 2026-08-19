# tabla

Ad-free, privacy-preserving asynchronous multiplayer games for people who know
each other — a replacement for the kind of turn-based game app that pays for
itself with ads and data harvesting.

The defining property: **the relay is zero-knowledge.** It transports and stores
ciphertext blobs plus minimal routing metadata. It never sees game state, moves,
chat, or keys. All cryptography and rule validation happen on the clients.

Tic tac toe ships in the core app. A word game and downloadable plugins come
later; see [ARCHITECTURE.md](ARCHITECTURE.md) for the protocol and the phase plan.

## Status

**Phase 1 is complete**: identity, single-use encrypted invites, the signed
hash-chained log, the zero-knowledge relay, live and asynchronous sync, offline
play, content-free push, and encrypted backup — proven end to end with tic tac
toe.

Phase 2 (the word game) has not been started. See [ARCHITECTURE.md](ARCHITECTURE.md)
for the plan and for every protocol decision.

## Stack

| Piece | What |
|---|---|
| `app/` | SvelteKit PWA (Svelte 5), built as a pure SPA with `adapter-static` |
| `rust/` | Game rules, the hash-chained log, and all protocol crypto, compiled to WASM |
| | — built as *two* modules: the core (keys, log, crypto) and the plugin (rules only) |
| `worker/` | Cloudflare Worker + two Durable Objects: the relay |
| `shared/` | Wire formats (zod) shared by the app, the Worker, and the tests |

The Worker serves the built app as static assets and owns only `/api/*` and
`/ws/*`, so the whole thing is one origin and one deploy.

## Prerequisites

- Rust stable with the `wasm32-unknown-unknown` target, and `wasm-pack`
- Bun (used for dependency install and scripts) and Node 22+
- `just`

```bash
rustup target add wasm32-unknown-unknown
cargo install wasm-pack
just install
```

> On hosts where rustup lives in Homebrew but toolchains live in `~/.rustup`,
> the `cargo` shim may not be on `PATH`. The justfile resolves the active
> toolchain's bin directory itself, so `just` recipes work regardless.

## Running it

```bash
just dev        # vite dev server + wrangler dev, with /api and /ws proxied
just dev-full   # build, then serve the *built* app through the Worker
```

Use `just dev-full` when testing anything involving the service worker, install
prompts, or push — those behave differently under the Vite dev server.

## Building and testing

```bash
just build      # wasm -> app -> worker
just test       # cargo test + vitest (worker, app)
just test-e2e   # browser acceptance tests against the built app
just check      # fmt check, clippy, svelte-check
```

What the suites cover:

| Suite | What it proves |
|---|---|
| `cargo test` | the log format, chain and signature verification, tombstone rollback refusal, key agreement, the export format, and the game rules — with frozen wire vectors so the formats cannot drift |
| `worker` vitest | the relay's storage, single-use claims, retention and tombstones, and a full two-client game over real WebSockets inside workerd, including eviction and re-upload |
| `app` vitest | that the TypeScript boundary produces the same bytes as the Rust vectors, and that the relay's framing helpers agree with the core |
| `e2e` | two real browser profiles playing to a result, single-use invites, surviving relay data loss, backup and migration into a fresh profile, and the iOS install/offline paths |

## Verifying push on a real device

Automated tests cover everything up to the push service's door; delivery itself
cannot be exercised in CI. To check the rest by hand:

1. `just vapid-keys`, set the two secrets, and deploy.
2. Open the app on an iPhone in Safari and add it to the Home Screen. Push does
   not work in a tab on iOS, which is why the app walks you through installing.
3. Open the app from the Home Screen, start a game, and turn on notifications
   from the button (the prompt has to come from a tap).
4. Have the other player move. The notification should say only that it is your
   turn — if it ever names a move, that is a bug worth reporting loudly.

## Deploying

Phase 1 is developed against `wrangler dev` only; the deploy path is configured
but not exercised.

```bash
just vapid-keys                     # once, offline
cd worker
bunx wrangler secret put VAPID_PUBLIC_KEY
bunx wrangler secret put VAPID_PRIVATE_KEY
cd .. && just deploy
```

## Layout

```
app/      SvelteKit PWA (SPA)
rust/     Cargo workspace
  crates/tabla-core         canonical encoding, hash-chained log, crypto
  crates/tabla-plugin-api   the pure-function game plugin interface
  crates/tabla-tictactoe    the bundled game
  crates/tabla-wasm         core wasm: identity, log, sessions (holds keys)
  crates/tabla-plugin-wasm  rules wasm: no crypto linked in (holds none)
shared/   wire formats shared by app, worker, and tests
worker/   relay: Worker + GameRoomDO + PendingInviteDO
```

## License

MIT
