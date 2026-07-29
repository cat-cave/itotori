# CI lanes

The root `justfile` has six delegates. CI selection happens through `just ci
<lane>`; the accepted lane names and their exact commands are the source code in
[`scripts/developer-command.mjs`](../../scripts/developer-command.mjs). This
document maps that stable surface without inventing additional recipes.

## Public lanes

| Lane                     | Contents                                                                             | Boundary                                                                     |
| ------------------------ | ------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------- |
| `just ci public`         | `check all`, build, DB migration, `test all`, and mutation differential              | Public integration entry point; needs the local database path for migration. |
| `just ci affected`       | qd’s affected-aware runner                                                           | qd owns the disposable DB lifecycle and decides the affected scope.          |
| `just ci tier0`          | Meta, TypeScript, Rust, and manifest sublanes                                        | Static and public checks; no browser or private corpus proof.                |
| `just ci tier0-meta`     | Repository scripts, structural guards, generated-artifact checks, and metadata tests | Detects only what its individual guards scan.                                |
| `just ci tier0-ts`       | TypeScript format and typecheck                                                      | Does not run all TypeScript tests.                                           |
| `just ci tier0-rust`     | Rust format, check, clippy, and dependency audit                                     | Does not run all Rust tests.                                                 |
| `just ci tier0-manifest` | Optional manifest gate                                                               | Prints that the gate is pending when its script is absent.                   |

Tier-1 public work is partitioned rather than hidden behind aliases:

- `tier1-ts-public-1of2` and `tier1-ts-public-2of2` build TypeScript and run
  complementary public package/app test partitions.
- `tier1-rust-1of3`, `tier1-rust-2of3`, and `tier1-rust-3of3` use Cargo
  nextest partitions.
- `tier1-db` exercises migration/reset and database-backed tests.
- `tier1-mutation` runs the mutation-differential selector.

## Evidence lanes

`just ci tier1-browser` runs the renderer contract, browser selector, and
visual tests. The browser selector requires an executable browser supplied by
the environment; absence is a hard failure. `just ci private-real-bytes` runs
the private-real-byte preflight. `just test real-bytes`, `just test
real-bytes-oracle`, and `just test real-bytes-oracle-drift` are named evidence
commands, not substitutes for a public lane.

These lanes can establish only the evidence they actually run. A static pass
does not prove browser rendering, and a successful public fixture test does not
prove behavior on private bytes. Conversely, private byte evidence is not a
reason to weaken the reproducible public lanes.

## Selecting a lane

For ordinary changes, begin with the narrowest `check` or `test` selector that
matches the behavior, then use `just ci public` or the CI partition selected by
the workflow. For qd work, use `just ci affected` rather than manually copying
the disposable database setup. `just check affected` is advisory: it prints
recommended commands and does not replace required CI.

The GitHub workflow configuration remains the authority for required PR checks.
The landing path is a pull request through GitHub’s native merge queue; see
[`docs/orchestration.md`](../orchestration.md).
