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
# holds the game rules and links nothing that could use a key. Keeping them
# apart is what makes "plugins have no key access" a property of the build
# rather than a rule someone has to remember.
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

# Rebuild the downloadable plugin module for the word game.
#
# Like `dict`, this is a committed artifact and not part of `build`: its hash is
# pinned in a signed manifest, so regenerating it is a deliberate act that ends
# in re-signing (`just sign-manifest`). Compilers do not produce byte-identical
# output across toolchains, which is why the pinned bytes are the ones committed
# rather than ones rebuilt on demand.
#
# The generated loader's fetch fallback is replaced with a throw. The sandbox
# has no network, so these bytes can only ever arrive from the host after being
# checked against the manifest — and leaving the fallback in would make Vite
# emit a second copy of the module into the app bundle, which is exactly what
# downloading it is meant to avoid.
#
# Only the current version is built. Version 1's artifact is committed and
# pinned, and games in progress are still playing against those exact bytes, so
# rebuilding it would strand them for no reason.
plugins:
    #!/usr/bin/env bash
    set -euo pipefail
    root={{justfile_directory()}}
    out="$root/app/src/lib/wasm/letras2-pkg"
    cd "$root/rust/crates/tabla-plugin-wasm"
    wasm-pack build --target web --no-pack --out-dir "$out" --out-name tabla_letras2 \
        -- --no-default-features --features letras-v2
    sed -i \
        "s|module_or_path = new URL('tabla_letras2_bg.wasm', import.meta.url);|throw new Error('letras module bytes must be provided by the host');|" \
        "$out/tabla_letras2.js"
    if grep -q 'import.meta.url' "$out/tabla_letras2.js"; then
        echo "the generated loader still resolves its own URL; the patch above needs updating" >&2
        exit 1
    fi
    mkdir -p "$root/app/static/plugins"
    mv "$out/tabla_letras2_bg.wasm" "$root/app/static/plugins/letras-v2.wasm"
    rm -f "$out/.gitignore"

# Re-sign the plugin manifest after a committed artifact changes.
#
# Needs the publisher key in ~/.config/tabla, which is deliberately not in the
# repository: CI verifies the committed signature and cannot produce one.
sign-manifest:
    bun scripts/sign-manifest.mjs

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
    # Each game must also build on its own: a downloadable plugin module is the
    # same crate with one game selected, so a game that only compiles alongside
    # its neighbours would break that build and nothing else would notice.
    cd rust && cargo check -p tabla-plugin-wasm --no-default-features --features tictactoe
    cd rust && cargo check -p tabla-plugin-wasm --no-default-features --features letras-v1
    cd rust && cargo check -p tabla-plugin-wasm --no-default-features --features letras-v2
    cd app && bun run check

# Deploy the Worker and static assets to Cloudflare
deploy: build
    cd worker && bunx wrangler deploy

# Generate a VAPID keypair for push (run once; store output with `wrangler secret put`)
vapid-keys:
    bunx @pushforge/builder vapid

clean:
    rm -rf app/build app/.svelte-kit {{wasm_out}} rust/target
