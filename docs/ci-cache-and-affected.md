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

| Changed surface                                                                     | Required affected output                                                            |
| ----------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| Root non-documentation file, toolchain, lockfile, workflow, script, or Vite+ config | `just ci`                                                                           |
| `packages/localization-bridge-schema/`                                              | `just schema`, `just ci-itotori`, `just ci-kaifuu`, `just ci-utsushi`, `just hello` |
| `apps/itotori/`, `packages/itotori-db/`                                             | `just ci-itotori`                                                                   |
| `crates/kaifuu-*`                                                                   | `just ci-kaifuu`                                                                    |
| `apps/runtime-web-review/`, `crates/utsushi-*`                                      | `just ci-utsushi`                                                                   |
| `fixtures/`, `packages/test-fixtures/`                                              | `just fixtures-validate`, `just hello`                                              |
| `suite/scripts/localize-project/`                                                   | `just localize-project-test`                                                        |
| `roadmap/`                                                                          | `just roadmap-validate`                                                             |
| Unknown non-documentation paths                                                     | `just check`                                                                        |
| Documentation-only paths                                                            | No affected task, unless the worker or reviewer asks for a broader gate             |

If a change triggers `just ci`, narrower project gates are redundant and should
not also be printed. Fixture changes may still print `just fixtures-validate`,
and fixture or shared schema changes may still require `just hello`, so affected
output stays explicit about manifest validation and the cross-project
end-to-end fixture pipeline.

When in doubt, run the broader gate. False positives are acceptable; false
negatives are not.

## Vite+ Task Cache Policy

Vite+ is the TypeScript/web task orchestrator. Root `just` recipes remain the
human and CI command surface, while `vite.config.ts` defines the Vite+ task graph:

- `ts:typecheck`, `ts:test`, and `ts:build` run recursive package scripts through
  Vite+ and may use deterministic Vite+ task caching.
- `schema:check` is a prerequisite for TypeScript workspace tasks so schema
  contract changes are noticed before downstream packages run.
- Side-effectful tasks such as `db:migrate:test` and `hello` must keep
  `cache: false`; database state, fixture output, and generated review evidence
  cannot be restored from a task cache.
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

| Gate                     | Project or surface                 | Required checks                                                                                                                   |
| ------------------------ | ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `just check`             | Whole repo baseline                | Vite+ config check, roadmap validation, fixture manifest validation, localize-project node tests, toolchain policy, TypeScript typecheck, Rust fmt, Rust check |
| `just build`             | Whole repo build                   | Vite+ TypeScript/web build and Cargo workspace build                                                                              |
| `just test`              | Whole repo tests                   | Vite+ TypeScript/web tests and Cargo workspace tests                                                                              |
| `just ci`                | Full CI                            | `check`, `build`, database migration, `test`, strict clippy, cargo-deny                                                           |
| `just schema`            | Shared bridge schema               | Schema typecheck, tests, and build                                                                                                |
| `just ci-itotori`        | Itotori app and DB package         | DB typecheck/test/build, app typecheck/test/build                                                                                 |
| `just ci-kaifuu`         | Kaifuu Rust crates                 | Tests for all `crates/kaifuu-*` workspace crates                                                                                  |
| `just ci-utsushi`        | Utsushi Rust crates and web review | Runtime web review typecheck/test/build, tests for all `crates/utsushi-*` workspace crates                                        |
| `just fixtures-validate` | Public fixture manifests           | Public manifest JSON Schema validation plus raw fixture hash and byte-count checks                                                |
| `just localize-project-test` | Localize-project suite scripts  | Node test suite for `suite/scripts/localize-project/*.test.mjs`                                                                  |
| `just hello`             | End-to-end fixture pipeline        | Build, DB migrate/reset, Kaifuu extract/patch/diff/apply/verify, Utsushi trace/capture/smoke, Itotori runtime ingest              |
| `just roadmap-validate`  | Roadmap data and audit schemas     | Spec DAG and audit report schema/example validation                                                                               |

Before merge, rely on CI workflow results, not only affected output. For local
parallel work, run `just affected` first, then run every printed recipe.
