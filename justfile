set shell := ["bash", "-eu", "-o", "pipefail", "-c"]
# DATABASE_URL is per-worktree, NOT a shared fixed port. When it is unset, the DB
# recipes below derive a unique-per-worktree connection string from
# scripts/itotori-db-compose-env.mjs (a hash of the canonical worktree root mapped
# into an ephemeral port range), so two worktrees running `just db-up`/`db-reset`
# concurrently never collide on a host port and one worktree's `db-reset` can
# never truncate another's DB. A hardcoded shared default here would re-introduce
# exactly that hazard, so the fallback is intentionally EMPTY. An explicit
# DATABASE_URL (the devshell hook, CI, or an operator) still wins as the escape
# hatch. Deriving in the top-level export is not viable: `just` evaluates an
# exported variable's backtick eagerly on every invocation, so the derivation
# lives in the recipes that actually connect.
export DATABASE_URL := env_var_or_default('DATABASE_URL', '')
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
    node --test scripts/db-test-skip-visibility.test.mjs
    node --test scripts/catalog-replay-db-gate.test.mjs
    node --test scripts/style-guide-fixture-flow-db-gate.test.mjs
    node --test scripts/qd-full-ci.test.mjs
    node --test scripts/affected.test.mjs
    node --test scripts/alpha-proof-gate.test.mjs
    node --test scripts/validate-tracked-artifact-hygiene.test.mjs
    node scripts/validate-tracked-artifact-hygiene.mjs --mode check
    just localize-project-test
    node scripts/spec-dag-issues.test.mjs
    node scripts/spec-dag-lifecycle.test.mjs
    node scripts/spec-dag-validator.test.mjs
    node scripts/spec-dag.mjs validate
    node --test scripts/audit-no-hardcoded-cost.test.mjs
    node scripts/audit-no-hardcoded-cost.mjs
    node --test scripts/audit-strictness.test.mjs
    node scripts/audit-strictness.mjs
    node --test scripts/generate-engine-capability-matrix.test.mjs
    node scripts/generate-engine-capability-matrix.mjs --check
    node --test scripts/synthetic-coverage-manifest.test.mjs
    node scripts/synthetic-coverage-manifest.mjs --check
    node --test scripts/mutation-differential.test.mjs
    node --test scripts/coverage-parity.test.mjs
    node scripts/coverage-parity.mjs
    node --test scripts/alpha-readiness-checklist.test.mjs
    node scripts/alpha-readiness-checklist.mjs
    node --test scripts/rgt-readiness-checklist.test.mjs
    node scripts/rgt-readiness-checklist.mjs
    just fixtures-validate
    node --test fixtures/generate-kaifuu-encrypted-public-fixtures.test.mjs
    just impl-map-schema-validate
    node scripts/verify-toolchain-policy.mjs
    node scripts/verify-deny-strict.mjs
    pnpm exec vp run ts:typecheck
    cargo fmt --check
    cargo check --workspace
    cargo clippy --workspace --all-targets --all-features -- -D warnings
    cargo deny check

impl-map-schema-validate:
    pnpm exec node scripts/validate-impl-map-schema.mjs

fixtures-validate:
    pnpm exec node fixtures/validate-public-manifests.mjs

test:
    pnpm exec vp run ts:test
    cargo test --workspace

localize-project-test:
    node --test suite/scripts/localize-project/*.test.mjs

# ALPHA-007: public fixture vertical (suite/scripts/alpha-public-fixture).
# Deterministic; offline (injects a committed ITOTORI-026 harness output).
alpha-public-fixture-test:
    node --test suite/scripts/alpha-public-fixture/run.test.mjs suite/scripts/alpha-public-fixture/linkage.test.mjs

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

# clippy + `cargo deny check` now live in the `check` recipe (single source of
# truth), which `ci` depends on, so every local gate enforces them.
#
# `ci` is the COMPLETE per-gate gate and is SINGLE-MODE SYNTHETIC: it runs the
# fast, copyright-free synthetic suites (via `test`) plus the `mutation-differential`
# differential guardrail (synthetic >= real for regression detection). It does
# NOT run the ~30-45min real-bytes lane — that lane is the PERIODIC ground-truth
# oracle only (`just real-bytes-oracle`), outside per-gate CI, so `ci` needs NO
# real corpora. The per-gate `qd-full-ci` wrapper runs an AFFECTED-AWARE subset by
# default (only the lanes a diff can touch); force the full gate with
# `node scripts/qd-full-ci.mjs --all`. See scripts/qd-full-ci.mjs + affected.mjs.
ci: check build db-migrate test mutation-differential

# synthetic-fixture-differential-validation: the guardrail that certifies the
# fast, copyright-free SYNTHETIC fixtures are AS STRONG AS the ~30-minute
# real-bytes lanes at catching regressions, so a per-gate lane MAY run synthetic
# instead of the real archives without losing regression-detection power.
#
# The source-level MUTATION harness applies each realistic decoder/patchback/
# replay bug (wrong offset, mis-typed opcode, off-by-one framing, skipped xor_2,
# broken AVG32 back-ref, patchback jump-recalc error, dropped choice, paletted
# G00 decode, cross-family RPG Maker code) to the REAL source, recompiles, and
# asserts the SYNTHETIC (default, no-real-bytes) suite turns RED. It FAILS LOUD
# (exit 1) if any mutation ESCAPES — i.e. if the synthetic fixtures are ever
# weaker than the real lanes. The mutations are never shipped: each is reverted
# and verified byte-identical. Deterministic; fast (~90s), no ~30-min real lane.
#
# The lighter coverage-parity + unit lanes (synthetic ⊇ real component surface,
# harness logic) run in `just check`; this recipe is the heavy Rust-recompiling
# kill-matrix. See docs/synthetic-differential-validation.md.
mutation-differential:
    node scripts/mutation-differential.mjs

# Explicit alias for the COMPLETE gate (same as `just ci`), for callers that want
# to be unambiguous that no affected-lane pruning is applied.
ci-full: ci

# real-bytes-tests-in-ci: run EVERY crate's real-bytes suite against its staged
# real corpus. This lane is PERIODIC-ONLY — it is the ground-truth oracle
# (`just real-bytes-oracle`), deliberately OUTSIDE per-gate CI. Per-gate CI is
# single-mode synthetic (fast, copyright-free); this ~30-45min real-bytes lane
# runs nightly/on-demand as the anchor + drift detector, NOT on every gate.
# Reads the corpora in place, read-only; NEVER copies copyrighted bytes.
# Real-bytes coverage is STRICT: the real_corpus support helper HARD-FAILS on an
# absent corpus (no opt-out), so a green run can never mean "zero real bytes
# exercised". PRE-CHECKS every corpus root up front so a missing corpus fails
# cleanly (non-zero) even if zero ignored tests match. Corpus roots are
# overridable via env for machines that stage elsewhere.
#
# Coverage spans five engine/source families across the corpus roots below:
#   - RealLive        Sweetie HD + Kanon   ITOTORI_REAL_GAME_ROOT{,_2}
#   - RPG Maker MV/MZ LustMemory           ITOTORI_REAL_GAME_ROOT_RPG_MAKER_MV_MZ
#   - vault source    live read-only vault ITOTORI_VAULT_ROOT
#   - Siglus          Karetoshi + Gamekoi  ITOTORI_VAULT_ROOT (vault-materialized)
#
# The Siglus corpus is NOT a copied corpus: both titles are vaulted PORTABLE
# INSTALLS (bare by-id artifacts) that the `live_vault_siglus_test` materializes
# on demand from ITOTORI_VAULT_ROOT into throwaway scratch, exactly like the
# RealLive vault-source lane. Downstream Siglus real-bytes nodes therefore
# consume the corpus via the vault (ITOTORI_VAULT_ROOT + the two canonical ids
# pinned in that test), never a staged copy. The RealLive-style env override
# `ITOTORI_REAL_GAME_ROOT_SIGLUS{,_2}` is reserved for pointing a downstream
# test at a pre-materialized plaintext Siglus game tree (a directory holding
# Scene.pck + Gameexe.dat + SiglusEngine.exe); when unset, vault-materialize is
# the canonical path.
#
# Invocation is split per crate because a blanket `-- --ignored` is unsafe for
# two crates: utsushi-core's real-bytes proofs are plain `#[test]`s (its OTHER
# `#[ignore]`s are child-process harness entry points that must NOT run
# standalone), and kaifuu-vault-source carries unrelated tracked `#[ignore]`s
# (KAIFUU-236/237) that are not real-bytes coverage.
ci-real-bytes:
    #!/usr/bin/env bash
    set -euo pipefail
    export ITOTORI_REAL_GAME_ROOT="${ITOTORI_REAL_GAME_ROOT:-/scratch/itotori-research/sweetie-hd}"
    export ITOTORI_REAL_GAME_ROOT_2="${ITOTORI_REAL_GAME_ROOT_2:-/scratch/itotori-research/kanon}"
    export ITOTORI_REAL_GAME_ROOT_RPG_MAKER_MV_MZ="${ITOTORI_REAL_GAME_ROOT_RPG_MAKER_MV_MZ:-/scratch/itotori-research/rpg-maker-mv-mz}"
    export ITOTORI_VAULT_ROOT="${ITOTORI_VAULT_ROOT:-/archive/vault}"
    for var in ITOTORI_REAL_GAME_ROOT ITOTORI_REAL_GAME_ROOT_2 ITOTORI_REAL_GAME_ROOT_RPG_MAKER_MV_MZ ITOTORI_VAULT_ROOT; do
      dir="${!var}"
      if [ ! -d "$dir" ]; then
        echo "ci-real-bytes: required real-bytes corpus $var=$dir is missing (dir not found);" >&2
        echo "  refusing to pass with zero real-bytes coverage. Stage the corpus or override $var." >&2
        exit 1
      fi
    done
    echo "ci-real-bytes: RealLive corpus-1 (Sweetie HD) = $ITOTORI_REAL_GAME_ROOT"
    echo "ci-real-bytes: RealLive corpus-2 (Kanon)      = $ITOTORI_REAL_GAME_ROOT_2"
    echo "ci-real-bytes: RPG Maker MV/MZ (LustMemory)   = $ITOTORI_REAL_GAME_ROOT_RPG_MAKER_MV_MZ"
    echo "ci-real-bytes: vault source (live vault)      = $ITOTORI_VAULT_ROOT"
    echo "ci-real-bytes: Siglus (Karetoshi + Gamekoi)   = $ITOTORI_VAULT_ROOT (vault-materialized)"
    echo "ci-real-bytes: strict (missing corpus hard-fails, no opt-out); running real-bytes suites"
    # RealLive + RPG Maker MV/MZ: #[ignore]-gated real-bytes suites.
    cargo test -p kaifuu-reallive -p utsushi-reallive -p kaifuu-cli -p utsushi-cli -p kaifuu-rpgmaker -p kaifuu-engine-fixture -- --ignored
    # utsushi-core: real-bytes proofs are plain #[test]s (target the files, no --ignored).
    cargo test -p utsushi-core --test composite_asset_package_real_bytes
    # kaifuu-vault-source: only the live-vault #[ignore] proofs (avoid unrelated KAIFUU-236/237 ignores).
    # live_vault_siglus_test materializes both Siglus portable installs (Karetoshi + Gamekoi) by-id.
    cargo test -p kaifuu-vault-source --test live_vault_open_test --test live_vault_by_id_test --test live_vault_siglus_test -- --ignored

# real-bytes-periodic-ground-truth-oracle (P2): the strict-proof ANCHOR for the
# synthetic-CI collapse. PERIODIC (nightly + on-demand), invoked OUTSIDE per-gate
# CI — it is deliberately NOT in affected.mjs / qd-full-ci (that is the whole
# point: per-gate green never pays for or waits on this ~30-45min run). It (A)
# re-runs the FULL real-bytes suite (`ci-real-bytes`) against the real corpora as
# GROUND TRUTH, then (B) re-derives the coverage manifest from the SAME live
# source-of-truth catalogues and diffs it against the committed manifest — a
# SYNTHETIC-vs-REAL DRIFT CHECK. Any divergence FAILS LOUD (nonzero) telling the
# operator to RE-DERIVE the synthetic. Real corpora are read-only; no copyrighted
# bytes are copied. Cadence + failure-meaning: docs/real-bytes-periodic-oracle.md.
real-bytes-oracle:
    node scripts/real-bytes-oracle.mjs

# Drift-only slice of the oracle: the SYNTHETIC-vs-REAL drift check WITHOUT the
# corpora-bound ground-truth suite (repo sources only). Runs anywhere (incl.
# hosted CI runners with no corpora) so drift can be caught nightly even where
# the real bytes are not staged. Still OUTSIDE per-gate CI.
real-bytes-oracle-drift:
    node scripts/real-bytes-oracle.mjs --drift-only

# Per-gate CI entrypoint. Affected-aware by default: selects only the lanes the
# diff (vs ITOTORI_QD_AFFECTED_BASE, default `main`) can touch — apps/itotori-only
# changes run the itotori gate + check; crate changes run that family's gate (+
# dependents) + the synthetic `mutation-differential` guardrail; shared/foundational
# changes run the full `ci`. Per-gate CI is single-mode synthetic (copyright-free,
# needs no real corpora); the real-bytes lane is periodic-only (real-bytes-oracle).
# Nothing is permanently skipped: `just ci` / `just ci-full` /
# `node scripts/qd-full-ci.mjs --all` still run everything.
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
    rm -f .tmp/itotori-db/no-database-skipped.json
    pnpm --filter @itotori/db test:db
    node scripts/assert-db-tests-not-skipped.mjs
    # CATALOG-072: prove the catalog source-adapter replay + idempotency suites
    # (CATALOG-065 contract) explicitly RAN against this database — a skipped or
    # zero-test outcome fails loudly rather than passing as replay coverage.
    node scripts/catalog-replay-db-gate.mjs
    pnpm --filter @itotori/db build
    pnpm --filter @itotori/app typecheck
    pnpm --filter @itotori/app test
    pnpm --filter @itotori/app build

ci-kaifuu:
    cargo test -p kaifuu-core -p kaifuu-delta -p kaifuu-engine-fixture -p kaifuu-reallive -p kaifuu-siglus -p kaifuu-cli -p kaifuu-vault-source -p kaifuu-rpgmaker -p kaifuu-kirikiri -p kaifuu-tyrano -p kaifuu-softpal -p kaifuu-nexas

ci-utsushi:
    pnpm --filter @itotori/runtime-web-review typecheck
    pnpm --filter @itotori/runtime-web-review test
    pnpm --filter @itotori/runtime-web-review build
    # The cargo run below covers the engine-port capability PARITY GATE:
    # `utsushi-core`'s parity contract unit tests + the cross-engine
    # conformance gate `utsushi-cli/tests/engine_parity_gate.rs` (the CLI is
    # the crate that sees every registered engine port). The gate is RED if
    # any engine silently lacks a capability another engine wires.
    cargo test -p utsushi-core -p utsushi-fixture -p utsushi-reallive -p utsushi-rpgmaker-mv -p utsushi-rpgmaker-mv-mz -p utsushi-siglus -p utsushi-kirikiri -p utsushi-kirikiri-xp3 -p utsushi-cli

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
    DATABASE_URL="$(node scripts/itotori-db-compose-env.mjs --print-database-url)" node apps/itotori/dist/cli.js db-migrate

db-reset: db-migrate
    DATABASE_URL="$(node scripts/itotori-db-compose-env.mjs --print-database-url)" node apps/itotori/dist/cli.js db-reset

# ITOTORI-121: LOCAL honesty gate for the DB layer. Unlike the fast-local
# `pnpm --filter @itotori/db test` (which SKIPS with a prominent, machine-
# readable marker when DATABASE_URL is unset), this command NEVER passes on a
# skip: it runs the Postgres-backed repository suites via the `--require-
# database` path and then asserts no skip marker was recorded. It FAILS
# (non-zero) when DATABASE_URL is missing/empty or the DB-backed tests did not
# actually run, so "I validated the DB layer" can only be claimed when the
# suites truly executed. Point it at a reachable Postgres (see `just db-up`);
# it does not itself manage docker. Run `DATABASE_URL= just test-db-strict`
# to see the missing-DATABASE_URL failure.
test-db-strict:
    #!/usr/bin/env bash
    set -euo pipefail
    rm -f .tmp/itotori-db/no-database-skipped.json
    pnpm --filter @itotori/db test:db
    node scripts/assert-db-tests-not-skipped.mjs

# CATALOG-072: DB-backed local gate PROVING the catalog source-adapter replay +
# idempotency repository tests (the CATALOG-065 idempotent fact-import contract)
# actually ran against a disposable database. These suites are DB-classified, so
# a fast-local run SKIPS them — and a skipped suite is NOT replay coverage. This
# gate makes "full replay coverage ran" provable: with no DATABASE_URL it writes
# a machine-readable skipped artifact and FAILS (non-zero) instead of going
# green-on-skip; with a reachable Postgres it runs ONLY the catalog replay/
# idempotency suites and asserts each one executed replayed tests (per-suite
# count > 0, zero skipped, zero failed), emitting a deterministic proof artifact.
# Bring up a disposable Postgres first (see `just db-up` / `just db-migrate`);
# this recipe does not itself manage docker. Run `DATABASE_URL= just
# catalog-replay-db-strict` to see the missing-DATABASE_URL failure.
catalog-replay-db-strict:
    node scripts/catalog-replay-db-gate.mjs

# ITOTORI-135: DB-backed local gate PROVING the ITOTORI-007 style-guide
# fixture-flow persistence suite actually ran against a disposable database. That
# suite drives the recorded conversational style-guide flow (public fixture)
# through the real @itotori/db repositories, so it is DB-classified and a
# fast-local run SKIPS it — and a skipped suite is NOT persistence coverage. This
# gate makes "the style-guide fixture flow persisted for real" provable: with no
# DATABASE_URL it writes a machine-readable skipped artifact and FAILS (non-zero)
# instead of going green-on-skip; with a reachable Postgres it runs ONLY the
# fixture-flow suite and asserts it executed persistence tests (per-suite
# count > 0, zero skipped, zero failed), emitting a deterministic proof artifact.
# Public-fixture-only: no private providers, no real bytes. Bring up a disposable
# Postgres first (see `just db-up` / `just db-migrate`); this recipe does not
# itself manage docker. Run `DATABASE_URL= just style-guide-fixture-flow-db-strict`
# to see the missing-DATABASE_URL failure.
style-guide-fixture-flow-db-strict:
    node scripts/style-guide-fixture-flow-db-gate.mjs

# ALPHA-009: the suite alpha proof / public-fixture vertical is the required
# integration guardrail (replaces the retired literal Hello World gate).
# Runs the ALPHA-007 public-fixture vertical and then re-proves cross-artifact
# linkage from the emitted artifacts independently. Both stages FAIL unless
# bridge, patch export, PatchResult, provider proof, benchmark report, runtime
# observation, dashboard/read-model ingestion, and the SHARED-025 manifest agree
# on the same public fixture id, source revision, locale branch, and content
# hashes. Public-fixture-only and deterministic: no DB, no creds, no private
# corpora, no success-string assertion.
alpha-proof:
    pnpm exec vp run alpha:public-fixture
    pnpm exec vp run alpha:public-fixture-validate

# ALPHA-005: fresh-clone public-fixture demo entry point. Public-fixture-only,
# deterministic, no DB / creds / private corpora / real bytes — it delegates to
# the alpha proof so a new user can prove a fresh clone end-to-end in one command.
# See docs/alpha-readiness.md and docs/install.md.
alpha-demo: alpha-proof

# ALPHA-005: alpha localization-project readiness checklist. Re-derives the
# readiness-doc claims from the GENERATED capability matrix + the SHARED-025
# proof manifest (never hand-maintained claims), validates the evidence node
# references, and confirms the UTSUSHI-119 patched-output runtime proof consumed
# a PatchResult + SHARED-025 manifest ids. Also run inside `just check`.
alpha-readiness-checklist:
    node scripts/alpha-readiness-checklist.mjs

# RGT-005: real-game-testing-ready milestone readiness checklist. Re-derives the
# substrate readiness surfaces (catalog / benchmark / dashboard / MV-MZ-readiness
# / synthetic-encrypted / real-bytes-parse / dag-lint) from the committed roadmap
# DAG and confirms each is wired under the RGT-005 hub; warns on any non-complete
# P1 real-game-testing-ready node not yet an ancestor of RGT-005. Also run inside
# `just check`. Mirrors `alpha-readiness-checklist` for the RGT tier.
rgt-readiness-checklist:
    node scripts/rgt-readiness-checklist.mjs

# ALPHA-009: `hello` is retained ONLY as a compatibility alias for nodes that
# still declare `just hello` as a verification. It cannot diverge from the alpha
# proof gate — it delegates directly to `just alpha-proof`. There is no separate
# Hello World source of truth and no literal hello-world success string.
hello: alpha-proof

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
    DATABASE_URL="$(node scripts/itotori-db-compose-env.mjs --print-database-url)" node apps/itotori/dist/cli.js db-migrate
    DATABASE_URL="$(node scripts/itotori-db-compose-env.mjs --print-database-url)" node apps/itotori/dist/cli.js db-reset
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

# ITOTORI-116: public provider-proof harness in RECORDED mode (no creds).
# Proves the draft + QA provider path with reject-before-record schema
# validation, bounded schema-repair, a token/cost/latency ledger that
# reconciles with the ITOTORI-100 route report, and a seeded QA oracle
# scoring report. Emits a sanitized ProviderProofBundle (no raw
# prompts/responses/keys). Opt-in live mode: `node apps/itotori/dist/cli.js
# provider-proof --live` with ITOTORI_PROVIDER_PROOF_LIVE=1 + an exported
# OPENROUTER_API_KEY + OPENROUTER_ZDR_ACCOUNT_ASSERTED=1.
provider-proof: build
    rm -rf .tmp/provider-proof
    mkdir -p .tmp/provider-proof
    node apps/itotori/dist/cli.js provider-proof --output .tmp/provider-proof/recorded-proof-bundle.json

# ITOTORI-117: deliberately-naive raw-MTL degenerate baseline proof, run
# through the SAME ITOTORI-116 provider-proof path (recorded default; --live
# opts in to a bounded real ZDR call). Emits systemKind raw_mtl_baseline.
raw-mtl-baseline-proof: build
    rm -rf .tmp/raw-mtl-baseline-proof
    mkdir -p .tmp/raw-mtl-baseline-proof
    node apps/itotori/dist/cli.js raw-mtl-baseline-proof --output .tmp/raw-mtl-baseline-proof/recorded-baseline-artifact.json

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

# UTSUSHI-227: patched-Seen.txt replay-validate surface smoke. Runs the
# in-crate `replay-validate` command unit tests (no real bytes required)
# so a fresh-clone reviewer can verify the
# `utsushi-cli replay-validate --engine reallive` surface — argv parsing,
# engine gating, and the observed-output help contract — plus the live
# `--help` output, without touching the vault. Replay validation of the
# actual observed engine output now lives on the caller side (the
# localize-project driver) and in the real-bytes lane
# (`crates/utsushi-cli/tests/single_scene_xor2_replay_real_bytes.rs`),
# run separately with ITOTORI_REAL_GAME_ROOT set per the spec block.
hello-replay-validate:
    cargo test -p utsushi-cli --bins replay_validate -- --nocapture
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
