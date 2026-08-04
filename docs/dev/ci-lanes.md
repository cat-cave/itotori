# CI lanes

The root `justfile` has six delegates. CI selection happens through `just ci
<lane>`; the accepted lane names and their exact commands are the source code in
[`scripts/developer-command.mjs`](../../scripts/developer-command.mjs). This
document maps that stable surface without inventing additional recipes.

## Public lanes

| Lane                     | Contents                                                                             | Boundary                                                                     |
| ------------------------ | ------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------- |
| `just ci public`         | `check all`, build, DB migration, `test all`, and mutation differential              | Public integration entry point; needs the local database path for migration. |
| `just ci tier0`          | Meta, TypeScript, Rust, and manifest sublanes                                        | Static and public checks; no browser or private corpus proof.                |
| `just ci tier0-meta`     | Repository scripts, structural guards, generated-artifact checks, and metadata tests | Detects only what its individual guards scan.                                |
| `just ci tier0-ts`       | TypeScript format and typecheck                                                      | Does not run all TypeScript tests.                                           |
| `just ci tier0-rust`     | Rust format, check, clippy, and dependency audit                                     | Does not run all Rust tests.                                                 |
| `just ci tier0-manifest` | Live behavior manifest and Cucumber collection gate                                  | Requires exact outline, row, case, cell, and non-applicable-pair counts.     |

Tier-1 public work is partitioned rather than hidden behind aliases:

- `tier1-ts-public-1of2` and `tier1-ts-public-2of2` build TypeScript and run
  complementary portable package/app test partitions. DB-owned app proofs are
  excluded from both shards by their discovered adjacent ownership declarations.
- `tier1-rust-1of3`, `tier1-rust-2of3`, and `tier1-rust-3of3` use Cargo
  nextest partitions.
- `tier1-db` exercises migration/reset and every database-backed app/package
  proof discovered from its adjacent ownership declaration against its Postgres
  service and native CLI artifact; those tests fail loudly if `DATABASE_URL` is
  absent.
- `tier1-mutation` runs the mutation-differential selector.
- `tier1-behavior` runs the behavior ledger, local evidence verifier,
  fixed-success mutation proof, and private-input failure contracts.

The behavior artifact has three deliberately different verdicts. The required
Tier-1 context downloads the artifact and runs
`node scripts/ci/verify-behavior-gate.mjs --local-candidate`. That command
rebuilds the cell conclusions from the signed selection plan, raw Cucumber
fragments, portable evidence, and fixed-success mutation run; it establishes a
local candidate contract only. Running the verifier with `--accepted` (or with
no mode) performs that local validation and then fails with
`external-verifier-app-unavailable`, because no protected external verifier App
is installed. A local receipt cannot be relabeled as external acceptance.

The distinct `Tier 1 / behavior full matrix` context downloads and validates
the same artifact, then requires all 687 applicable cells to pass. It is
excluded from the required-job aggregation and has no `continue-on-error`; at
the root implementation's honest 6/687 state it intentionally remains red as
`full-matrix-incomplete:6/687`.

## Evidence lanes

`just ci tier1-browser` runs the renderer contract, browser selector, and
visual tests. The browser selector requires an executable browser supplied by
the environment; absence is a hard failure. `just ci private-real-bytes` runs
the legacy local preflight and then fails closed because the protected external
evidence agent is not installed. Its old candidate-controlled private workflow
is quarantined and has no pull-request trigger, private runner, checkout, or
artifact upload. `just test real-bytes`, `just test model-profile`, and `just
test browser-real-bytes` invoke exact manifest-owned evidence bodies and reject
missing inputs or skipped receipts; the oracle selectors schedule the broader
real-byte check. None substitutes for a public lane.

These lanes can establish only the evidence they actually run. A static pass
does not prove browser rendering, and a successful public fixture test does not
prove behavior on private bytes. Conversely, private byte evidence is not a
reason to weaken the reproducible public lanes.

## Selecting a lane

For ordinary changes, begin with the narrowest `check` or `test` selector that
matches the behavior, then use `just ci public` or the CI partition selected by
the workflow. `just check affected` is advisory: it prints recommended commands
and does not replace required CI.

The GitHub workflow configuration remains the authority for required PR checks.
The landing path is a pull request through GitHub’s native merge queue.
