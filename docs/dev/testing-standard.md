# Testing standard

Tests prove observable behavior. Prefer a public boundary—HTTP, persisted data,
rendered DOM, or bytes produced by a decoder or patcher—over assertions about
private helper calls. Pure model logic may use direct unit tests when no public
boundary exists. A test name should say what a user or caller can observe.

Public CI must be deterministic. It may use public fixtures, fake providers,
MSW, and a local disposable database, but it must not need provider credentials,
private corpora, or a live remote service. Real-byte and browser evidence are
separate named lanes; a green static or public lane does not prove either.

## Command surface

The root `justfile` is deliberately thin. It exposes six delegates:
`worktree-setup`, `dev`, `doctor`, `check`, `test`, and `ci`. A selector is data
validated by `scripts/developer-command.mjs`; do not invent a recipe name for a
new selector. Run `just --summary` for the delegates and inspect that dispatcher
for the complete, executable selector lists.

| Command                   | What it runs                                                                                                         |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `just worktree-setup`     | Offline, frozen pnpm install for a fresh worktree.                                                                   |
| `just doctor core`        | Native-dependency probe for the core profile.                                                                        |
| `just doctor render`      | Native-dependency probe for the render profile.                                                                      |
| `just doctor full`        | Native-dependency probe for the full profile.                                                                        |
| `just check`              | All static checks: metadata/policy guards, TypeScript checks, and Rust format, check, clippy, and dependency checks. |
| `just check meta`         | Repository metadata, guard, generated-artifact, and dispatcher checks.                                               |
| `just check ts`           | TypeScript formatting and typecheck.                                                                                 |
| `just check rust`         | Rust formatting, workspace check, clippy, and dependency audit.                                                      |
| `just check fixtures`     | Public fixture-manifest validation.                                                                                  |
| `just test`               | TypeScript test tasks and `cargo test --workspace`.                                                                  |
| `just test dlsite-demand` | The supported scoped app-suite selector.                                                                             |
| `just test ratio`         | A report-only classification of tracked test files by seam.                                                          |
| `just ci public`          | The public integration sequence: all checks, build, database migration, all tests, and mutation differential.        |

Use the smallest command that exercises the changed behavior during a tight
loop, then run the lane required by the change. Package-level commands are fine
when a package documents one, but a handoff must name the root command or
concrete package command that was actually run.

The three `doctor` profile selectors are passed to the native-dependency
checker as `--profile core`, `--profile render`, and `--profile full`.
They are valid dispatcher commands, not an `unknown argument` limitation. A
profile still exits nonzero when one of its required native dependencies is
unavailable; its report names the missing dependency and a remediation.

## CI lanes and their limits

`ci-lanes.md` is the complete lane map. In short:

- `just ci tier0` runs the static meta, TypeScript, Rust, and manifest lanes.
- Tier-1 selectors split public TypeScript, Rust, database, browser, behavior,
  and mutation work. `just ci private-real-bytes` runs the local preflight but
  cannot pass while the protected external evidence agent is unavailable.
- `just test browser` requires a runnable browser binary. `just test
real-bytes` and the oracle selectors require their private inputs. Missing
  required inputs must fail rather than turn into an implied pass.

The test-seam classifier is useful for drift, but it is not a quality gate: it
classifies a file’s strongest detectable seam and exits successfully. Likewise,
unit and integration tests cannot establish performance, privacy, or
real-corpus fidelity unless they exercise and measure those properties.

## Fixture and database discipline

Use the lowest suitable fixture layer:

| Layer                | Use                                                                                        |
| -------------------- | ------------------------------------------------------------------------------------------ |
| Inline values        | A small, readable behavior example.                                                        |
| Builders             | Repeated valid test objects within a package or crate.                                     |
| Public fixture       | Cross-package or golden behavior; it needs a committed manifest.                           |
| Private local corpus | Licensed or non-redistributable evidence; ignored by Git and never a public-CI dependency. |

Database tests require a real database when they claim persistence behavior.
`just test db` is the required database selector; it fails if the required
database is unavailable. A package test that explicitly reports its database
skip has not tested persistence and must not be reported as a database pass.

When `DATABASE_URL` is unset, `pnpm --filter @itotori/db test` deliberately
skips all 69 database suites and says that it did not validate the DB layer.
The DB Vitest configuration has `fileParallelism: false`: every suite migrates
an isolated schema under one Postgres advisory lock, so parallel file execution
queues migrations and can hit the 90-second hook timeout. This skip proves
neither database behavior nor test success; use `just test db` for that.

## Guard boundaries

The repository’s structural guards are intentionally narrow claims:

- The line-cap guard enforces a 500-line maximum for tracked `.js`, `.mjs`,
  `.rs`, `.ts`, and `.tsx` source files; on this tree it scans 3,131 files and
  all are at or below the cap. It counts newline characters and prints both its
  extension counts and limits. It cannot inspect untracked or ignored files,
  untracked generated output, or source files with other extensions.
- The test-collection guard compares conventional `*.test.*` files on disk
  under `packages/` and `apps/` with every configured Vitest project plus the
  DB Node-runner manifest. It currently reports
  `307 on disk, 307 collected, 0 uncollected`. It verifies configured discovery
  only: a collected suite can still fail when its test bodies run.
- The game-name guard scans tracked UTF-8 text using structural identity shapes,
  not a title list, and checks a limited Shift-JIS byte-literal form. It cannot
  reliably identify arbitrary prose names, opaque bytes, non-UTF-8 files, or
  a form outside those shapes.
- The node-id guard scans all tracked files, including binary data, for its
  structural identifier and prose-reference patterns. Generated fixtures,
  the planning export, and applied migrations are scoped exemptions; untracked
  and ignored files are outside its view.
- The environment-registry guard allows only literals declared in
  `config/environment-registry.json` and verifies that `.env.example` matches.
  It has a zero-undeclared-read budget. It sees tracked literal read forms, not
  dynamically assembled names or untracked files.

Environment variables are deployment inputs for the person hosting the
application. Anything a translator might want to set differently is application
configuration, not an environment variable.

## Review checklist

1. The behavior has a test through the strongest practical public boundary.
2. A scoped test or relevant lane was run after the final edit.
3. Fixtures are redistributable and have a manifest when they cross packages.
4. A database, browser, private-corpus, or provider claim names the input that
   was actually exercised; an absent input is reported as absent, not passed.
5. Generated artifacts and the structural guards are clean.
