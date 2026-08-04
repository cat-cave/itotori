# Existing CI and merge-queue audit

This audit was completed before the roadmap was designed. It describes revision
`aa8b55f4fcc405ef79a2e525a02a008d75fa046f`; live GitHub state can change, so
the commands below are part of each claim.

## Audit method

```text
node scripts/developer-command.mjs ci tier0-meta
node scripts/audit-behavior-catalog.mjs
node scripts/generate-engine-capability-matrix.mjs --check
node scripts/ci/public-lane-coverage.mjs --check
node scripts/synthetic-coverage-manifest.mjs --check
node scripts/test-collection-guard.mjs
gh run view 30581776204
gh api repos/cat-cave/itotori/actions/runners
gh api repos/cat-cave/itotori/branches/main/protection/required_status_checks
gh api repos/cat-cave/itotori/rulesets/18793614
gh api 'repos/cat-cave/itotori/actions/runs/30581776204/jobs?per_page=100'
gh api 'repos/cat-cave/itotori/actions/workflows/real-bytes-oracle.yml/runs?per_page=100'
gh api 'repos/cat-cave/itotori/actions/runs/<returned-run-id>/jobs?per_page=100'
gh api 'repos/cat-cave/itotori/actions/runs?event=merge_group&status=success&per_page=100'
```

The behavior-catalog test group measured 0/31 passing because its copied-input
helper and direct command require removed `docs/inventory/*.md` files. This is
a current required-lane failure, not evidence that the 31 catalog invariants
are wrong
(`scripts/audit-behavior-catalog.test.mjs`,
`scripts/audit-behavior-catalog-human.mjs`).

## Merge path

`.github/workflows/pr-tiers.yml` invokes both reusable tiers on pull requests,
merge groups, main pushes, and manual dispatch.

| Required context or lane    | What runs                                                                                      | What it actually establishes                                                                      | Honest limit                                                                                                             |
| --------------------------- | ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `tier0 / Tier 0 / required` | `_tier0.yml`: parallel `meta`, `ts`, `rust`, `manifest`, then an `always()` aggregate          | All four matrix jobs must succeed                                                                 | Current `meta` is red; the aggregate is therefore red                                                                    |
| Tier 0 `meta`               | `developer-command.mjs check meta`                                                             | Static guards, guard tests, generated-file checks, fixture validation, and selected harness tests | Mostly syntax/registry evidence; it does not execute the product behavior catalog                                        |
| Tier 0 `ts`                 | workspace check and TypeScript typecheck                                                       | Formatting/lint/unit selection and type correctness                                               | Package selection excludes several root script suites and does not prove private inputs                                  |
| Tier 0 `rust`               | format, workspace check, all-target/all-feature clippy, dependency policy                      | Compilation, lint, and declared dependency rules                                                  | Real-input tests remain ignored/externally selected                                                                      |
| Tier 0 `manifest`           | `developer-command.mjs ci tier0-manifest`                                                      | Nothing: the dispatcher prints `manifest gate pending` and exits zero                             | False green; `scripts/ci/lane-manifest-gate.mjs` does not exist                                                          |
| `tier1 / Tier 1 / required` | `_tier1.yml`: native, five portable shards, database, browser, alpha, mutation, then aggregate | Every named group must report success                                                             | Success is limited to each group's selection and available inputs                                                        |
| Tier 1 `native`             | release native CLI build and upload                                                            | Native artifacts compile                                                                          | All portable shards wait for this one artifact; retention is short                                                       |
| Tier 1 `portable`           | five shards consume the native artifact                                                        | Portable Rust and app selections complete                                                         | Serial dependency on native adds queue time even where a shard does not need the release binary                          |
| Tier 1 `db`                 | migrations, 71 serialized database-package suite files, then the full app suite                | Database-package and app selections run against a service database                                | Repeats app work after TS shards; app files remain parallel and their isolated migrations queue behind one advisory lock |
| Tier 1 `browser`            | Nix-pinned browser/fonts and both browser suites                                               | Renderer exists and exact visual/browser assertions execute                                       | It is strong for its selected fixtures, not real owned content                                                           |
| Tier 1 `alpha`              | alpha selector                                                                                 | Named alpha contract tests pass                                                                   | It does not replace complete journey or private proof                                                                    |
| Tier 1 `mutation`           | ten fixed mutations across two families                                                        | The selected synthetic suite kills those mutation classes                                         | It does not establish other mutations, families, or real-input agreement                                                 |

Branch protection requires exactly the two aggregate contexts above, each
bound to the GitHub Actions App ID 15368. Active ruleset 18793614 requires
`HEADGREEN`, a 60-minute check-response timeout, at most four entries building
and ten entries merging, and `SQUASH`. GitHub reports the audited pull request
as mergeable but `BLOCKED`; a red required aggregate keeps it out of the queue
without creating a distinct queue failure
(`gh api .../required_status_checks`, `gh api .../rulesets`,
`gh pr view 798`).

## Other workflows

| Workflow/job                                   | Claimed purpose                    | Measured truth                                                                                                                       |
| ---------------------------------------------- | ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `real-bytes-oracle.yml / drift-check`          | Synthetic-versus-real drift anchor | Hosted job executed successfully in all 21 inspected scheduled runs, but it has no private bytes                                     |
| `real-bytes-oracle.yml / ground-truth`         | Full real-input oracle             | Requires `[self-hosted, itotori-corpora]`; 20 inspected jobs were cancelled and the current job was queued, with zero executed steps |
| `real-bytes-oracle.yml / browser-e2e`          | Real-input browser proof           | Same missing runner and zero executed steps                                                                                          |
| `real-bytes-private-proof.yml / private-proof` | Opt-in private proof               | Zero workflow runs; the only invoked selector performs preflight, not extract, structure, patch, or replay                           |

The runner API returned `total_count: 0`. The supplied roadmap brief is the
authority for the incident count of 26 earlier absent-input false greens; the
repository history independently contains multiple repairs titled “stop
real-input proofs passing without their real inputs”
(`git log --grep='real-input proofs' --all --oneline`). If they start, the
current periodic scripts reject missing required inventory and zero execution;
the inspected schedule contains no runner execution proving those checks work.

The private workflow can also succeed with no evidence: it calls
`just ci private-real-bytes`, whose dispatcher invokes
`private-real-byte-proof.mjs --preflight`; its `always()` artifact upload uses
`if-no-files-found: warn` (`.github/workflows/real-bytes-private-proof.yml`,
`scripts/developer-command.mjs`). A pull-request label can select PR-controlled
code for the corpus-tagged runner without trusted-ref checkout, environment
approval, actor allowlisting, or an egress barrier. Candidate code or the
repository-local setup action can put arbitrary private bytes at the upload
path, so the public upload credential is an exfiltration boundary even when
preflight fails. The candidate also has ordinary network egress through its
runner and repository-local setup, so removing that upload step alone would
not close the exfiltration boundary.

## Required guard suite and stated limits

The live Tier-0 guard set is the union of the explicit
`Ratchet control-plane surface` workflow step and the `meta` case in
`scripts/developer-command.mjs`. The surface and environment guards run before
the dispatcher; most other rows are dispatched by `meta`. “Required” below
means one of those live paths invokes it, not that it proves more than its
stated boundary.

| Guard                        | Required boundary                                   | Stated detection limit                                                                                                                                                                                                                                                              |
| ---------------------------- | --------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Dispatcher/config harnesses  | Yes                                                 | Unit-test named command parsing, database compose/wait, recipes, native dependencies, and installable packaging; they do not execute every dispatched suite                                                                                                                         |
| Control-plane surface budget | Yes, directly in `_tier0.yml` before the dispatcher | Compares current tracked prefixed-name and parsed Just-recipe counts with `origin/main` merge-base; growth or shrink fails. Dynamic names, untracked files, recipe semantics, and other command surfaces are invisible; its regression tests are not selected                       |
| Environment registry         | Yes, directly and through `meta`                    | Treats the eight names in `.env.example` as its declaration authority and finds recognized literal reads in tracked regular files; it neither reads nor proves equality with the eight-entry `config/environment-registry.json`, and assembled/dynamic reads remain invisible       |
| Tracked-artifact hygiene     | Yes                                                 | Checks tracked-and-ignored files below `artifacts/`, with explicit exclusions; other leakage surfaces are outside it                                                                                                                                                                |
| Stale residue                | Yes                                                 | Fixed high-risk expressions, Markdown targets, and one facade table; it is not semantic documentation validation                                                                                                                                                                    |
| Behavior catalog             | Yes, currently red                                  | Checks hashes, accounting, weakest declared state, portable outline shape, and five 47-row tables; it never executes behavior                                                                                                                                                       |
| Hardcoded cost               | Yes                                                 | Static patterns in selected roots/extensions with exemptions; other roots, languages, and dynamic values are outside scope                                                                                                                                                          |
| Rust strictness              | Yes                                                 | Selected lexical laxity, dependency settings, and statically parsed real-input crate enrollment; not assertion quality or input presence                                                                                                                                            |
| Test seam classifier         | Tests only                                          | Classification report is non-blocking and the live classifier always exits successfully                                                                                                                                                                                             |
| Test collection              | Tests only                                          | Its tests exercise the scanner, but required CI never runs the live scan over the repository                                                                                                                                                                                        |
| Hardcoded roles              | Yes                                                 | Recognized AST shapes in shipped app/package/crate source; tests, fixtures, docs, and unknown authorization forms are excluded                                                                                                                                                      |
| Direct provider invocation   | Yes                                                 | AST/taint patterns only below `apps/itotori/src`; other roots, languages, and dynamic loading are outside scope                                                                                                                                                                     |
| Privacy, retention, egress   | Yes                                                 | Markers in four named files plus lexical scans of one app subtree and migrations; it is not whole-program dataflow                                                                                                                                                                  |
| Node identifiers             | Yes                                                 | Fixed patterns over tracked files with fixture/migration exemptions; unknown provenance shapes and untracked files are invisible                                                                                                                                                    |
| Game identity                | Yes                                                 | Structural identity shapes in tracked UTF-8 plus one narrow byte-literal form; arbitrary prose, opaque bytes, and other encodings are outside it                                                                                                                                    |
| Generalization purge         | Yes                                                 | Fixed known identity tokens with explicit historical/test/fixture allowances; it cannot discover unknown identities                                                                                                                                                                 |
| CI input pins                | Yes                                                 | Line-oriented workflow checks for known actions/installers and the tool version; comments and general runner/container provenance are not authenticated                                                                                                                             |
| File line cap                | Yes                                                 | Counts newlines in tracked `.js`, `.mjs`, `.rs`, `.ts`, and `.tsx`; no whitelist exists at the audited revision, so the current bound is absolute. The code can initialize a committed shrink-only whitelist later; Markdown, other extensions, and untracked files remain excluded |
| App CSS contract             | Yes                                                 | Static token references and class literals; computed classes, import, reachability, and actual rendering are not established                                                                                                                                                        |
| Deletion ledger              | Yes                                                 | Enumerated paths/counts and retained seams only; unlisted residue and schema execution are outside it                                                                                                                                                                               |
| Legacy model residue         | Yes                                                 | Fixed symbols/paths in three source roots; unnamed designs and other roots are outside it                                                                                                                                                                                           |
| Model import boundary        | Yes                                                 | Static import edges over listed roots; computed loading and undeclared roots are outside it                                                                                                                                                                                         |
| Provider dependency pin      | Yes                                                 | Pin metadata, manifest, and lockfile text agree; provenance and runtime compatibility are not established                                                                                                                                                                           |
| Model line budget            | Yes                                                 | Newlines under configured roots/exclusions; it says nothing about complexity and passes if the root is absent                                                                                                                                                                       |
| Renderer contract            | Test only in `meta`; live in Tier 1 browser         | The Tier-0 unit test validates helper logic only; Tier 1 performs an inline Nix executable/font preflight, reruns the live contract, and executes both browser selections, but an allowed override can still change the configured identity                                         |
| Public-lane coverage         | Yes                                                 | Discovers adjacent ownership declarations, then checks marker text and command wiring; it does not execute cited tests                                                                                                                                                              |
| Private-proof contract       | Tests only                                          | Tests the preflight helper; one assertion matches obsolete command text in a comment and misses the workflow's preflight-only execution                                                                                                                                             |
| Migration parity             | Yes                                                 | Filenames, registry order, and selected facade names; it does not execute SQL                                                                                                                                                                                                       |
| Engine capability matrix     | Yes                                                 | Byte-staleness over enumerated declarations/fixtures; completeness stops at its input registry and it is not runtime proof                                                                                                                                                          |
| Synthetic coverage manifest  | Yes                                                 | Recognized source symbols in enumerated files; it does not prove semantics or real-input fidelity                                                                                                                                                                                   |
| Coverage parity              | Yes                                                 | Derived manifest-group-to-function citations and function existence; it does not run or inspect the assertions                                                                                                                                                                      |
| Public fixture manifests     | Yes                                                 | Validates discovered manifests and listed hashes; unmanifested files are invisible and metadata-only classes stop at schema validation                                                                                                                                              |
| Toolchain policy             | Yes                                                 | Exact versions and command presence in known files; actual installation and runner image identity are separate                                                                                                                                                                      |
| Dependency strictness        | Yes                                                 | Two policy settings and adjacent reasons; semantic dependency analysis is in the Rust lane                                                                                                                                                                                          |
| Mutation differential        | Tests only in meta; execution in Tier 1             | Representative mutation policy for two engine families; no other mutation or required real-input corroboration                                                                                                                                                                      |

The collection scanner, public-manifest validator, public-lane declarations,
and synthetic component catalog derive their current counts from the tree.
Those are bounded results, not test-case or behavior execution
(`scripts/test-collection-guard.mjs`,
`fixtures/validate-public-manifests.mjs`,
`scripts/ci/public-lane-coverage.mjs`,
`scripts/synthetic-coverage-manifest.mjs`).

## Defined but not live-gated

- The live test-collection scan; only its two unit tests are selected.
- The seam classifier; only its tests run and the report itself is non-blocking.
- Live permission-denial and catalog-replay database selectors.
- The affected-work advisor, whose fixtures still recommend removed recipes.
- Generator equality for `.env.example`, surface-budget regression tests,
  real-input-lane regression tests, and the production runbook test.
- Four hermetic Vite tasks: private-local triage, validation renderer,
  key-hunt, and encrypted-readiness. Direct execution measured 60/60 passing,
  but no-corpus paths deliberately emit successful skip artifacts.
- `just ci public`; no workflow invokes it.
- Every ground-truth, periodic private-browser, and opt-in private execution,
  because no matching runner is registered.

These findings come from `scripts/developer-command.mjs`, `package.json`,
`justfile`, `.github/workflows/*.yml`, and a direct comparison of collected
tests to required workflow commands.

## Timing and avoidable serialization

The inspected pull-request run spent about 15 minutes in Tier 1. Its database
job took about 15 minutes; mutation about 6 minutes; native about 4 minutes; and
the portable shards then ran for roughly 2–4 minutes. The latest 100 successful
merge groups measured median 10m37s and p95 15m08s; the latest success was
15m05s with a 14m49s database job (`gh run view 30581776204` and merge-group
run/job API queries).

The main avoidable costs are visible in `_tier1.yml` and package Vitest config:

- all five portable shards wait for the native release artifact;
- package install, setup, TypeScript build, and schema work repeat across jobs;
- the database lane repeats the full app selection after TS shards;
- the 71 database-package suite files explicitly run with file parallelism
  disabled, then the entire app suite runs with file parallelism enabled; app
  files that call `isolatedMigratedContext` queue migrations through one global
  Postgres advisory lock under 90-second limits, so lock wait can appear as a
  test timeout; and
- the meta shell runs guards serially, so the first failure masks later guard
  results.

Parallelize only independent work: build one reusable immutable workspace
artifact, remove the native dependency from shards that do not consume it,
partition database setup around one migrated template or explicitly serialize
migration ownership, and emit all guard results before the aggregate fails.
Measure the resulting merge-group median and p95; do not promise an unmeasured
speedup.

## What must change first

These repairs land inside the named semantic bundles, never as completion-free
infrastructure specs:

1. In the sole root bundle, `proof-ledger-and-explicit-failures`, restore the
   behavior-catalog guard's real inputs without weakening the exact 582-source
   identity, state, disposition, mapping, and hash checks in
   [`source-accounting.md`](source-accounting.md); replace the placeholder
   manifest member with executable 687-cell accounting, and run the live
   302/302 suite-file collection scan in required CI.
2. In the same root, execute the Gherkin and make missing steps, skips,
   fixed-empty adapters, zero assertions, and selected/executed mismatch red.
3. In the first-production profile and extraction instances,
   `admitted-profile-intake-safety/decode.engine.reallive` and
   `admitted-extraction-population/decode.engine.reallive`, replace the
   nonexistent corpus runner path with the isolated evidence-agent design in
   [`real-bytes.md`](real-bytes.md); require input presence, byte hashing,
   actual stages, and signed content-free receipts.
4. Make merge-group receipt verification required before any production cell
   can close. Quarantine the old corpus jobs before a private host is attached;
   delete the disabled path only after the replacement has completed two
   independently requested full cycles.
5. Gate every retained validator and every retained claim it supports. Remove
   a validator only with an explicitly retired mechanism whose replacement
   capability is covered; repair stale selectors/counts, retain
   JUnit/cell/browser/mutation/proof summaries, and add aggregate failure
   notification.
6. Change database migration ownership and shared setup only with before/after
   queue measurements and the same test collection.

Until items 1–4 are in place, the remainder of this roadmap can be authored and
reviewed, but no real production cell can honestly turn green.
