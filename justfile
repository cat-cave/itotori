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
    node scripts/spec-dag-issues.test.mjs
    node scripts/spec-dag-lifecycle.test.mjs
    node scripts/spec-dag-validator.test.mjs
    node scripts/spec-dag.mjs validate
    just fixtures-validate
    node scripts/verify-toolchain-policy.mjs
    pnpm exec vp run ts:typecheck
    cargo fmt --check
    cargo check --workspace

fixtures-validate:
    pnpm exec node fixtures/validate-public-manifests.mjs

test:
    pnpm exec vp run ts:test
    cargo test --workspace

build:
    pnpm exec vp run ts:build
    cargo build --workspace

itotori-scale-build:
    pnpm --filter @itotori/localization-bridge-schema build
    pnpm --filter @itotori/db build
    pnpm --filter @itotori/app build

itotori-scale-smoke: itotori-scale-build db-up db-wait
    node scripts/itotori-scale-harness.mjs --profile smoke

itotori-scale-large: itotori-scale-build db-up db-wait
    node scripts/itotori-scale-harness.mjs --profile large

ci: check build db-migrate test
    cargo clippy --workspace --all-targets --all-features -- -D warnings
    cargo deny check

ci-itotori:
    #!/usr/bin/env bash
    set -euo pipefail
    just db-up
    trap 'just db-down' EXIT
    just db-wait
    just db-reset
    pnpm --filter @itotori/db typecheck
    pnpm --filter @itotori/db test
    pnpm --filter @itotori/db build
    pnpm --filter @itotori/app typecheck
    pnpm --filter @itotori/app test
    pnpm --filter @itotori/app build

ci-kaifuu:
    cargo test -p kaifuu-core -p kaifuu-delta -p kaifuu-engine-fixture -p kaifuu-cli

ci-utsushi:
    pnpm --filter @itotori/runtime-web-review typecheck
    pnpm --filter @itotori/runtime-web-review test
    pnpm --filter @itotori/runtime-web-review build
    cargo test -p utsushi-core -p utsushi-fixture -p utsushi-cli

schema:
    pnpm --filter @itotori/localization-bridge-schema typecheck
    pnpm --filter @itotori/localization-bridge-schema test
    pnpm --filter @itotori/localization-bridge-schema build

contract-validate-ts:
    pnpm --filter @itotori/localization-bridge-schema test

contract-validate-rust:
    cargo test -p kaifuu-core shared_contract_fixture_suite

contract-validate: contract-validate-ts contract-validate-rust

db-up:
    node scripts/itotori-db-compose-env.mjs
    docker compose --env-file .tmp/itotori-db/compose.env up -d postgres

db-down:
    node scripts/itotori-db-compose-env.mjs
    docker compose --env-file .tmp/itotori-db/compose.env down

db-wait:
    node scripts/itotori-db-compose-env.mjs
    for i in {1..60}; do docker compose --env-file .tmp/itotori-db/compose.env exec -T postgres sh -c 'pg_isready -U "$POSTGRES_USER" -d "$POSTGRES_DB"' && exit 0; sleep 1; done; exit 1

db-cli-build:
    pnpm --filter @itotori/localization-bridge-schema build
    pnpm --filter @itotori/db build
    pnpm --filter @itotori/app build

db-migrate: db-cli-build
    node apps/itotori/dist/cli.js db-migrate

db-reset: db-migrate
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

roadmap-validate:
    node scripts/spec-dag.mjs validate

roadmap-ready:
    node scripts/spec-dag.mjs ready

roadmap-pop:
    node scripts/spec-dag.mjs pop

roadmap-dashboard:
    pnpm --filter @itotori/spec-dag-dashboard build
    node packages/spec-dag-dashboard/dist/cli.js

roadmap-dashboard-watch:
    pnpm --filter @itotori/spec-dag-dashboard build
    node packages/spec-dag-dashboard/dist/cli.js --watch

upgrade:
    corepack enable
    node scripts/update-node-version.mjs
    corepack use pnpm@latest
    node scripts/sync-pnpm-engine.mjs
    pnpm update --latest --recursive
    rustup update stable
    cargo update
    node scripts/verify-toolchain-policy.mjs
