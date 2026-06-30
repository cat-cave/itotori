set shell := ["bash", "-eu", "-o", "pipefail", "-c"]
export DATABASE_URL := env_var_or_default('DATABASE_URL', 'postgres://itotori:itotori@127.0.0.1:55433/itotori')
export COMPOSE_DISABLE_ENV_FILE := '1'
export ITOTORI_DB_COMPOSE_ENV_PATH := env_var_or_default('ITOTORI_DB_COMPOSE_ENV_PATH', '.tmp/itotori-db/compose.env')

install:
    pnpm install

dev:
    pnpm --filter @itotori/app dev

dashboard:
    node apps/itotori/dist/server.js

check:
    pnpm exec vp check
    node --test scripts/itotori-db-compose-config.test.mjs
    node --test scripts/qd-full-ci.test.mjs
    node --test scripts/affected.test.mjs
    node --test scripts/validate-tracked-artifact-hygiene.test.mjs
    node scripts/validate-tracked-artifact-hygiene.mjs --mode check
    just localize-project-test
    node scripts/spec-dag-issues.test.mjs
    node scripts/spec-dag-lifecycle.test.mjs
    node scripts/spec-dag-validator.test.mjs
    node scripts/spec-dag.mjs validate
    node --test scripts/audit-no-hardcoded-cost.test.mjs
    node scripts/audit-no-hardcoded-cost.mjs
    node --test scripts/generate-engine-capability-matrix.test.mjs
    node scripts/generate-engine-capability-matrix.mjs --check
    just fixtures-validate
    just impl-map-schema-validate
    node scripts/verify-toolchain-policy.mjs
    pnpm exec vp run ts:typecheck
    cargo fmt --check
    cargo check --workspace

impl-map-schema-validate:
    pnpm exec node scripts/validate-impl-map-schema.mjs

fixtures-validate:
    pnpm exec node fixtures/validate-public-manifests.mjs

test:
    pnpm exec vp run ts:test
    cargo test --workspace

localize-project-test:
    node --test suite/scripts/localize-project/*.test.mjs

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

qd-full-ci:
    node scripts/qd-full-ci.mjs

ci-itotori:
    #!/usr/bin/env bash
    set -euo pipefail
    just db-up
    trap 'just db-down' EXIT
    just db-wait
    just db-reset
    pnpm --filter @itotori/db typecheck
    pnpm --filter @itotori/db test:db
    pnpm --filter @itotori/db build
    pnpm --filter @itotori/app typecheck
    pnpm --filter @itotori/app test
    pnpm --filter @itotori/app build

ci-kaifuu:
    cargo test -p kaifuu-core -p kaifuu-delta -p kaifuu-engine-fixture -p kaifuu-reallive -p kaifuu-siglus -p kaifuu-cli -p kaifuu-vault-source -p kaifuu-rpgmaker

ci-utsushi:
    pnpm --filter @itotori/runtime-web-review typecheck
    pnpm --filter @itotori/runtime-web-review test
    pnpm --filter @itotori/runtime-web-review build
    cargo test -p utsushi-core -p utsushi-fixture -p utsushi-reallive -p utsushi-rpgmaker-mv -p utsushi-siglus -p utsushi-cli

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
    docker compose --env-file "$ITOTORI_DB_COMPOSE_ENV_PATH" up -d postgres

db-down:
    node scripts/itotori-db-compose-env.mjs
    docker compose --env-file "$ITOTORI_DB_COMPOSE_ENV_PATH" down

db-wait:
    node scripts/itotori-db-compose-env.mjs
    for i in {1..60}; do docker compose --env-file "$ITOTORI_DB_COMPOSE_ENV_PATH" exec -T postgres sh -c 'pg_isready -U "$POSTGRES_USER" -d "$POSTGRES_DB"' && exit 0; sleep 1; done; exit 1

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

# ITOTORI-019 / ITOTORI-222: synthetic hello-world loop wired through
# the agentic-loop orchestrator at the drafting stage. Keeps the
# regular `hello` recipe unchanged. Produces an `AgenticLoopBundle`
# AND a derived `DraftArtifactBundle` (via the orchestrator's
# adapter); verifies well-formedness against the schema asserters in
# `@itotori/localization-bridge-schema`.
hello-draft: build
    rm -rf .tmp/hello-draft
    mkdir -p .tmp/hello-draft
    node apps/itotori/dist/cli.js agentic-loop-smoke --bridge apps/itotori/test/fixtures/agentic-loop-smoke-bridge.json --unit-index 0 --pair-policy apps/itotori/test/fixtures/agentic-loop-smoke-pair-policy.json --output .tmp/hello-draft/agentic-loop-bundle.json --draft-artifact-output .tmp/hello-draft/draft-artifact-bundle.json
    node scripts/print-agentic-loop-bundle-summary.mjs .tmp/hello-draft/agentic-loop-bundle.json
    node scripts/print-draft-artifact-bundle-summary.mjs .tmp/hello-draft/draft-artifact-bundle.json

# ITOTORI-025 / ITOTORI-222: synthetic hello-world loop with the v0.2
# patch-export pipeline spliced in after the orchestrator's drafting
# stage. Keeps the regular `hello` and `hello-draft` recipes unchanged.
# Produces a `PatchExportBundle` v0.2 and verifies its well-formedness.
hello-patch: build
    rm -rf .tmp/hello-patch
    mkdir -p .tmp/hello-patch
    node apps/itotori/dist/cli.js db-migrate
    node apps/itotori/dist/cli.js db-reset
    node apps/itotori/dist/cli.js agentic-loop-smoke --bridge apps/itotori/test/fixtures/agentic-loop-smoke-bridge.json --unit-index 0 --pair-policy apps/itotori/test/fixtures/agentic-loop-smoke-pair-policy.json --output .tmp/hello-patch/agentic-loop-bundle.json --draft-artifact-output .tmp/hello-patch/draft-artifact-bundle.json
    node apps/itotori/dist/cli.js export-patch-v2 --project apps/itotori/test/fixtures/patch-export-v2-project.json --draft-bundle .tmp/hello-patch/draft-artifact-bundle.json --locale en-US --output .tmp/hello-patch/patch-export-bundle.json
    node scripts/print-patch-export-bundle-summary.mjs .tmp/hello-patch/patch-export-bundle.json

# ITOTORI-222: standalone agentic-loop smoke recipe. Exercises the
# full orchestrator end-to-end on a single bridge unit using the smoke
# FakeModelProvider; asserts the resulting AgenticLoopBundle is
# well-formed via the schema asserter.
hello-agentic-loop: build
    rm -rf .tmp/hello-agentic-loop
    mkdir -p .tmp/hello-agentic-loop
    node apps/itotori/dist/cli.js agentic-loop-smoke --bridge apps/itotori/test/fixtures/agentic-loop-smoke-bridge.json --unit-index 0 --pair-policy apps/itotori/test/fixtures/agentic-loop-smoke-pair-policy.json --output .tmp/hello-agentic-loop/agentic-loop-bundle.json
    node scripts/print-agentic-loop-bundle-summary.mjs .tmp/hello-agentic-loop/agentic-loop-bundle.json

# UTSUSHI-220: alpha-defining e2e Sweetie HD scene-1 text-replay smoke.
# Runs the synthetic replay_scene acceptance tests through `cargo test`
# (no real bytes required) so a fresh-clone reviewer can verify the
# replay driver produces at least one TextLine event and writes
# byte-deterministic JSON without touching the vault. The real-bytes
# variant ships as `tests/replay_scene_real_bytes.rs` and is run
# separately with ITOTORI_REAL_GAME_ROOT set; see the spec
# verification block.
hello-replay:
    cargo test -p utsushi-reallive --test replay_scene_synthetic -- --nocapture

# UTSUSHI-227: patched-Seen.txt replay-and-verify smoke. Runs the
# synthetic + validator integration tests through `cargo test` (no real
# bytes required) so a fresh-clone reviewer can verify the
# `validate_replay_contains` library API and the generic
# `utsushi-cli replay-validate --engine reallive` surface match
# without touching the vault. The
# real-bytes variant lives in the same integration test file
# (`tests/replay_validate_reallive.rs`) under the env-gated
# ignored test; run it separately with ITOTORI_REAL_GAME_ROOT set
# per the spec verification block.
hello-replay-validate:
    cargo test -p utsushi-reallive --test replay_validate_reallive -- --nocapture
    cargo run -p utsushi-cli -- replay-validate --help

# UTSUSHI-228 — alpha closer. Wraps every other alpha node into one
# command: kaifuu extract -> itotori live agentic loop -> kaifuu patch
# -> utsushi replay-validate. The driver hard-fails if OPENROUTER_API_KEY,
# a corpus source root, or TARGET is unset (no fallback to the recorded
# provider). Pass --dry-run to print the per-phase commands without invoking
# any LLM. The engine is selected by the project's alpha-target-data record:
# `sweetie-hd-alpha-1` (RealLive Seen.txt) or `lust-memory-alpha-1` (RPG Maker
# MV/MZ — extract -> live loop -> JSON patchback + .kaifuu delta -> delta-apply
# -> utsushi-rpgmaker-mv text-trace runtime evidence). The MV/MZ slice is
# bounded to ONE dialogue surface so a live run bills a single ZDR translation.
#
# Required env (unless --dry-run):
#   OPENROUTER_API_KEY                       live OpenRouter key
#   OPENROUTER_ZDR_ACCOUNT_ASSERTED=1        account-wide ZDR assertion (fail-closed)
#   ITOTORI_REAL_CORPUS_MANIFEST             preferred local corpus descriptor
#   ITOTORI_REAL_GAME_ROOT                   single-corpus fallback (RealLive root)
#   ITOTORI_REAL_GAME_ROOT_RPG_MAKER_MV_MZ   single-corpus MV/MZ www/ root
#   LOCALIZE_PROJECT_SOURCE_PATH             direct readonly source root fallback
#   TARGET                                  writable patched copy (RealLive only;
#                                            the MV/MZ path writes under the run dir)
# These may already be in the process environment, or loaded explicitly with
# --env-file <PATH> / ITOTORI_LOCAL_ENV_FILE from a local-only ignored file.
#
# Usage:
#   just localize-project --project sweetie-hd-alpha-1
#   just localize-project --project sweetie-hd-alpha-1 --env-file .env.localize-project
#   just localize-project --dry-run --project sweetie-hd-alpha-1
#   just localize-project --dry-run --project lust-memory-alpha-1
#   just localize-project --project lust-memory-alpha-1 --env-file .env.localize-project
localize-project *ARGS:
    pnpm --filter @itotori/localization-bridge-schema build
    pnpm --filter @itotori/db build
    pnpm --filter @itotori/app build
    node suite/scripts/localize-project/run.mjs {{ARGS}}

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

# Seed itotori_audit_findings from docs/audits/*.md structured finding blocks.
# Requires DATABASE_URL. Runs the migration first so the audit_findings table
# is present even on a fresh DB.
audit-findings-seed:
    pnpm --filter @itotori/app build
    node apps/itotori/dist/audit-findings/seed-cli.js

upgrade:
    corepack enable
    node scripts/update-node-version.mjs
    corepack use pnpm@latest
    node scripts/sync-pnpm-engine.mjs
    pnpm update --latest --recursive
    rustup update stable
    cargo update
    node scripts/verify-toolchain-policy.mjs

# Rebuild the local qd sqlite cache from the committed qd export.
qd-import:
    qd import --from roadmap/spec-dag.json
    just roadmap-validate
    qd doctor --json

qd-export:
    qd export --out roadmap/spec-dag.json
    just roadmap-validate
