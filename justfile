# tabla — build pipeline
#
# The cargo/rustc shims are not on PATH on this host (rustup lives in Homebrew,
# toolchains in ~/.rustup), so resolve the active toolchain's bin directory once
# and prepend it for every recipe.
rust_bin := parent_directory(`rustup which rustc 2>/dev/null || echo /usr/bin/rustc`)
export PATH := rust_bin + ":" + env_var('PATH')

wasm_out := justfile_directory() / "app/src/lib/wasm/pkg"

_default:
    @just --list

# Install JS dependencies
install:
    bun install

# Compile both WASM modules for the browser.
#
# Two separate binaries, not one: the core holds the keys, the plugin module
# holds the game rules and links no cryptography at all. Keeping them apart is
# what makes "plugins have no key access" a property of the build rather than a
# rule someone has to remember.
wasm: wasm-core wasm-plugin

wasm-core:
    cd rust/crates/tabla-wasm && wasm-pack build --target web \
        --out-dir {{wasm_out}}/core --out-name tabla_core

wasm-plugin:
    cd rust/crates/tabla-plugin-wasm && wasm-pack build --target web \
        --out-dir {{wasm_out}}/plugin --out-name tabla_plugin

# Recompile the word list into the dictionary the word game reads.
#
# The output is a committed artifact pinned by hash in shared/src/constants.ts,
# so this is not part of `build` — running it is a deliberate act. If it changes
# the file, the golden test fails, which is the point: two players have to be
# playing against the same list, and games already under way agreed to the old
# one. A new list ships as a new id, never as an overwrite. See
# wordlist/PROVENANCE.md.
dict:
    cd rust && cargo run -p tabla-dawg --features build --bin build-dict --release -- \
        {{justfile_directory()}}/wordlist/enable.txt \
        {{justfile_directory()}}/app/static/dict/en-v1.dawg

# Build the SvelteKit PWA (consumes the WASM output)
app: wasm
    cd app && bun run build

# Regenerate Worker binding types from wrangler.jsonc
types:
    cd worker && bunx wrangler types

# Type-check the Worker without deploying
worker: types
    cd worker && bun run check

# Full build: WASM -> app -> worker
build: wasm app worker

# Run the app and relay together for local development
dev:
    #!/usr/bin/env bash
    set -euo pipefail
    trap 'kill 0' EXIT
    cd worker && bun run dev &
    cd app && bun run dev &
    wait

# Serve the *built* app through the Worker (service worker and push behave as in production)
dev-full: build
    cd worker && bun run dev

# Rust unit tests
test-rust:
    # --all-features so the dictionary builder, which is off by default because
    # it must never reach the browser, is still covered by its golden tests.
    cd rust && cargo test --all-features

# TypeScript tests (shared, worker unit + integration, app)
test-ts: types
    cd worker && bun run test
    cd app && bun run test

# Browser acceptance tests against the built app served by the Worker
test-e2e: build
    cd e2e && bunx playwright test

# Everything
test: test-rust test-ts

# Formatting and linting
fmt:
    cd rust && cargo fmt
    bun run --cwd app format

check:
    cd rust && cargo fmt --check && cargo clippy --all-targets --all-features -- -D warnings
    cd app && bun run check

# Deploy the Worker and static assets to Cloudflare
deploy: build
    cd worker && bunx wrangler deploy

# Generate a VAPID keypair for push (run once; store output with `wrangler secret put`)
vapid-keys:
    bunx @pushforge/builder vapid

clean:
    rm -rf app/build app/.svelte-kit {{wasm_out}} rust/target
