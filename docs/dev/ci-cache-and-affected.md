# CI Cache and Affected Policy

This policy defines how local affected detection, Vite+ task caching, Rust
caching, and project gates are allowed to interact. The short version is:
affected output may save local time, but it never replaces required CI.

## Affected Command

`just affected` runs `node scripts/affected.mjs`. It inspects tracked changes
against `HEAD` plus untracked files that are not ignored by Git. The command is
advisory: it prints the `just` recipes a worker should run for the current
worktree, but CI still runs the required root gates.

Affected detection must be conservative:

| Changed surface                                                                     | Required affected output                                                                  |
| ----------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| Root non-documentation file, toolchain, lockfile, workflow, script, or Vite+ config | `just ci`                                                                                 |
| `packages/localization-bridge-schema/`                                              | `just schema`, `just ci-itotori`, `just ci-kaifuu`, `just ci-utsushi`, `just alpha-proof` |
| `apps/itotori/`, `packages/itotori-db/`                                             | `just ci-itotori`                                                                         |
| `crates/kaifuu-*`                                                                   | `just ci-kaifuu`                                                                          |
| `apps/runtime-web-review/`, `crates/utsushi-*`                                      | `just ci-utsushi`                                                                         |
| `fixtures/`                                                                         | `just fixtures-validate`, `just alpha-proof`                                              |
| `suite/scripts/localize-project/`                                                   | `just localize-project-test`                                                              |
| `roadmap/`                                                                          | `just roadmap-validate`                                                                   |
| Unknown non-documentation paths                                                     | `just check`                                                                              |
| Documentation-only paths                                                            | No affected task, unless the worker or reviewer asks for a broader gate                   |

If a change triggers `just ci`, narrower project gates are redundant and should
not also be printed. Fixture changes may still print `just fixtures-validate`,
and fixture or shared schema changes may still require `just alpha-proof`, so
affected output stays explicit about manifest validation and the cross-project
public-fixture vertical.

When in doubt, run the broader gate. False positives are acceptable; false
negatives are not.

## Vite+ Task Cache Policy

Vite+ is the TypeScript/web task orchestrator. Root `just` recipes remain the
human and CI command surface, while `vite.config.ts` defines the Vite+ task graph:

- `ts:typecheck`, `ts:test`, and `ts:build` run recursive package scripts through
  Vite+ and may use deterministic Vite+ task caching.
- `schema:check` is a prerequisite for TypeScript workspace tasks so schema
  contract changes are noticed before downstream packages run.
- Side-effectful tasks such as `db:migrate:test`, `alpha:public-fixture`, and
  `alpha:public-fixture-validate` must keep `cache: false`; database state,
  emitted vertical artifacts, and generated review evidence cannot be restored
  from a task cache.
- `.vite/` and `.vite-task/` are local build/task caches and remain ignored.
  They are not a CI correctness boundary.

Cache hits may skip repeated deterministic work, but they must never suppress
required validation. `just check` still runs `pnpm exec vp check`, root policy
validation, localize-project node tests, TypeScript typecheck, `cargo fmt
--check`, and `cargo check --workspace`. If Vite+ cannot prove a task is
current, the task must run.

## Rust Cache Policy

Cargo is the Rust authority. Rust cache restoration may speed up compilation,
but Cargo commands still decide correctness:

- CI installs the stable Rust toolchain with `rustfmt` and `clippy`.
- `Swatinem/rust-cache@v2` may restore Cargo build artifacts, registry data, and
  git dependency data.
- `Cargo.lock`, `Cargo.toml`, crate manifests, `rust-toolchain.toml`, and source
  changes are cache inputs in practice and require the relevant Cargo gates.
- `just check` runs `cargo fmt --check` and `cargo check --workspace`.
- `just test` runs `cargo test --workspace`.
- `just ci` additionally runs strict workspace clippy and `cargo deny check`.

A Rust cache miss only costs time. A stale cache must not hide a failing
compile, test, lint, or dependency audit because the Cargo command still runs.

## CI Cache Policy

The CI workflow must remain lockfile strict:

- Node uses `.node-version`.
- pnpm uses the committed `packageManager` pin through Corepack.
- GitHub's pnpm cache is keyed from `pnpm-lock.yaml`.
- CI runs `pnpm install --frozen-lockfile`; a lockfile mismatch fails before
  tests can run.
- `node_modules/`, Cargo `target/`, Vite output, and Vite+ task caches are not
  committed.

Do not add a cache that can replace an install, build, test, lint, migration, or
audit command. Caches are only accelerators.

## Gate Matrix

| Gate                         | Project or surface                                       | Required checks                                                                                                                                                                                                                                                                    |
| ---------------------------- | -------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `just check`                 | Whole repo baseline                                      | Vite+ config check, roadmap validation, fixture manifest validation, localize-project node tests, toolchain policy, TypeScript typecheck, Rust fmt, Rust check                                                                                                                     |
| `just build`                 | Whole repo build                                         | Vite+ TypeScript/web build and Cargo workspace build                                                                                                                                                                                                                               |
| `just test`                  | Whole repo tests                                         | Vite+ TypeScript/web tests and Cargo workspace tests                                                                                                                                                                                                                               |
| `just ci`                    | Full CI (single-mode synthetic, copyright-free)          | `check`, `build`, database migration, `test`, strict clippy, cargo-deny, plus `mutation-differential` (the synthetic differential guardrail proving synthetic ≥ real for regression detection). Needs NO real corpora — the ~30-45min real-bytes lane is periodic-only (see below) |
| `just qd-full-ci`            | Local qd full CI (per-gate)                              | Starts a worktree-scoped disposable Postgres stack, runs the affected-aware subset of `just ci` lanes (single-mode synthetic; a crate change runs that family's rust gate + `mutation-differential`, never the real-bytes lane), then tears the stack down                         |
| `just schema`                | Shared bridge schema                                     | Schema typecheck, tests, and build                                                                                                                                                                                                                                                 |
| `just ci-itotori`            | Itotori app and DB package                               | DB typecheck/test/build, app typecheck/test/build                                                                                                                                                                                                                                  |
| `just ci-kaifuu`             | Kaifuu Rust crates                                       | Tests for all `crates/kaifuu-*` workspace crates                                                                                                                                                                                                                                   |
| `just ci-utsushi`            | Utsushi Rust crates and web review                       | Runtime web review typecheck/test/build, tests for all `crates/utsushi-*` workspace crates                                                                                                                                                                                         |
| `just fixtures-validate`     | Public fixture manifests                                 | Public manifest JSON Schema validation plus raw fixture hash and byte-count checks                                                                                                                                                                                                 |
| `just localize-project-test` | Localize-project suite scripts                           | Node test suite for `suite/scripts/localize-project/*.test.mjs`                                                                                                                                                                                                                    |
| `just alpha-proof`           | Public-fixture vertical (required integration guardrail) | TS build, `vp run alpha:public-fixture` (composes Itotori/Kaifuu/Utsushi/provider/benchmark/SHARED-025 artifacts), then `vp run alpha:public-fixture-validate` (independent schema + hash-addressing + cross-artifact linkage re-proof). Public-fixture-only; no DB, no creds      |
| `just roadmap-validate`      | Roadmap data and audit schemas                           | Spec DAG and audit report schema/example validation                                                                                                                                                                                                                                |

Before merge, rely on CI workflow results, not only affected output. For local
parallel work, run `just affected` first, then run every printed recipe.

## Per-gate synthetic vs. periodic real bytes

Per-gate CI is **single-mode synthetic**: every gate (including the full `just
ci`) runs the fast, copyright-free synthetic suites plus the
`mutation-differential` differential guardrail, and needs **no** real corpora
(no `ITOTORI_REAL_GAME_ROOT`). The `mutation-differential` + `coverage-parity`
harnesses prove the synthetic fixtures are **as strong as** the real-bytes lanes
at catching regressions (`synthetic ≥ real`; see
`docs/synthetic-differential-validation.md`), so no coverage is lost.

The ~30-45min **real-bytes** suite (`just ci-real-bytes`) is the **periodic
ground-truth oracle** — `just real-bytes-oracle`, run nightly/on-demand OUTSIDE
per-gate CI (see `docs/real-bytes-periodic-oracle.md`). It re-runs the real
corpora as ground truth and drift-checks the synthetic manifest against them.
This is what killed the old ~30min per-gate real-bytes drag. There is no corpus
opt-out flag: when the oracle runs, an absent corpus is an unconditional hard
failure, so a green real-bytes run can never mean "zero real bytes exercised".
