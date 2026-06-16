set shell := ["bash", "-eu", "-o", "pipefail", "-c"]
export DATABASE_URL := env_var_or_default('DATABASE_URL', 'postgres://itotori:itotori@127.0.0.1:55433/itotori')

install:
    pnpm install

dev:
    pnpm --filter @itotori/app dev

dashboard:
    node apps/itotori/dist/server.js

check:
    pnpm exec vp check
    pnpm exec vp run ts:typecheck
    cargo fmt --check
    cargo check --workspace

test:
    pnpm exec vp run ts:test
    cargo test --workspace

build:
    pnpm exec vp run ts:build
    cargo build --workspace

ci: check build db-migrate test
    cargo clippy --workspace --all-targets --all-features -- -D warnings
    cargo deny check

ci-itotori:
    pnpm --filter @itotori/app typecheck
    pnpm --filter @itotori/app test
    pnpm --filter @itotori/app build

ci-kaifuu:
    cargo test -p kaifuu-core -p kaifuu-delta -p kaifuu-cli

ci-utsushi:
    cargo test -p utsushi-core -p utsushi-fixture -p utsushi-cli

schema:
    pnpm --filter @itotori/localization-bridge-schema test

db-up:
    docker compose up -d postgres

db-down:
    docker compose down

db-wait:
    for i in {1..60}; do pg_isready -d "$DATABASE_URL" && exit 0; sleep 1; done; exit 1

db-migrate:
    node apps/itotori/dist/cli.js db-migrate

db-reset:
    node apps/itotori/dist/cli.js db-reset

hello: build
    rm -rf .tmp/hello-world
    mkdir -p .tmp/hello-world
    node apps/itotori/dist/cli.js db-migrate
    node apps/itotori/dist/cli.js db-reset
    cargo run -p kaifuu-cli -- extract fixtures/hello-game --output .tmp/hello-world/bridge.json
    node apps/itotori/dist/cli.js import --bridge .tmp/hello-world/bridge.json --project .tmp/hello-world/itotori-project.json
    node apps/itotori/dist/cli.js draft --project .tmp/hello-world/itotori-project.json --locale en-US
    node apps/itotori/dist/cli.js export-patch --project .tmp/hello-world/itotori-project.json --output .tmp/hello-world/patch-export.json
    cargo run -p kaifuu-cli -- patch fixtures/hello-game --patch .tmp/hello-world/patch-export.json --output .tmp/hello-world/patched-game
    cargo run -p kaifuu-cli -- diff fixtures/hello-game .tmp/hello-world/patched-game --output .tmp/hello-world/hello.kaifuu
    cargo run -p kaifuu-cli -- apply fixtures/hello-game --patch .tmp/hello-world/hello.kaifuu --output .tmp/hello-world/delta-applied-game
    cargo run -p kaifuu-cli -- verify .tmp/hello-world/delta-applied-game --output .tmp/hello-world/kaifuu-verify.json
    cargo run -p utsushi-cli -- trace .tmp/hello-world/delta-applied-game --output .tmp/hello-world/runtime-trace.json
    cargo run -p utsushi-cli -- capture .tmp/hello-world/delta-applied-game --output .tmp/hello-world/frame-capture.json
    cargo run -p utsushi-cli -- smoke .tmp/hello-world/delta-applied-game --output .tmp/hello-world/runtime-report.json
    node apps/itotori/dist/cli.js ingest-runtime --project .tmp/hello-world/itotori-project.json --runtime-report .tmp/hello-world/runtime-report.json --output .tmp/hello-world/final-summary.json
    node apps/itotori/dist/cli.js dashboard-status --output .tmp/hello-world/dashboard-status.json
    node scripts/print-hello-summary.mjs .tmp/hello-world/final-summary.json

affected:
    node scripts/affected.mjs

upgrade:
    corepack enable
    corepack prepare pnpm@latest --activate
    pnpm update --latest --recursive
    rustup update stable
    cargo update
