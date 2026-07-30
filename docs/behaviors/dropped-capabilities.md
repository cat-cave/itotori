# Dropped capability ledger

These 58 source capabilities do not express a portable, persona-facing
behavior. Each still has exactly one row in the machine-readable capability
map. The reason below is copied from that row.

## Decode

- `decode.engine.nscripter` — Binding action-plan scope drops dedicated
  NScripter/ONScripter support; retaining an intended production mapping would
  silently contradict that decision.

## Localization

- `localization.run-journal-and-leases` — The source explicitly retires this
  persistence mechanism; resumable work remains covered without prescribing
  it.
- `localization.result-revision-editor` — Direct human unit mutation violates
  the binding whole-round refinement boundary; scene and moment feedback
  replaces it.
- `localization.reviewer-queue-workflow` — The source explicitly retires the
  human per-unit queue in favor of played-patch feedback rounds.

## Platform

- `platform.domain-boundary-architecture` — Dependency direction, layers,
  cycles, and cross-engine imports describe one repository architecture
  rather than a portable persona outcome.
- `platform.offline-worktree-setup` — Offline dependency installation for this
  repository's worktrees is contributor setup, not an outcome at a product or
  extension boundary.
- `platform.per-worktree-rust-target` — Build-target hashing and same-basename
  worktree collisions are repository mechanics with no fixed-persona product
  outcome.
- `platform.per-worktree-database` — Compose projects, test databases, ports,
  and worktree teardown scopes are repository test isolation rather than
  service behavior.
- `platform.database-port-allocation` — Allocating ports among concurrent
  development worktrees is local test infrastructure, not a portable
  deployment behavior.
- `platform.database-capacity-defaults` — Connection defaults chosen for the
  repository's parallel database suite are test-environment tuning, not a
  user-observable service contract.
- `platform.fixture-path-hermeticity` — Compile-time fixture locations,
  worktree paths, and current-directory independence are repository test
  harness concerns.
- `platform.cross-worktree-reproducibility` — Reproducing repository checks
  from a clean worktree is contributor and CI governance, not a persona-facing
  product outcome.
- `platform.owned-cache-garbage-collection` — Worktrees, compiler targets,
  scratch test databases, and browser caches are development-resource
  housekeeping rather than product retention behavior.
- `platform.single-gate-mode` — Choosing one per-change synthetic lane and a
  separate private oracle is CI topology; truthful profile qualification is
  retained elsewhere.
- `platform.public-private-ci-lanes` — Public and private lane layout is CI
  architecture; `quality.private-data-stays-within-approved-boundaries`
  retains the portable privacy outcome.
- `platform.affected-lane-selection` — Mapping changed repository files to
  Rust, TypeScript, database, browser, fixture, and documentation lanes is CI
  implementation.
- `platform.affected-base-selection` — Selecting a comparison commit for
  branch and default-branch CI is version-control plumbing, not a persona
  outcome.
- `platform.full-workspace-rust-gates` — Workspace-member discovery and Rust
  build, lint, test, and documentation commands are repository CI coverage.
- `platform.typescript-suite-coverage` — Selecting consuming TypeScript test
  suites from source changes is repository CI coverage, not portable product
  behavior.
- `platform.database-gate-fail-loud` — The authoritative database lane and its
  skip detection are CI mechanics; explicit missing-input failure is retained
  in `quality.failures-stay-explicit`.
- `platform.browser-gate-hermeticity` — Browser versions, parallel test launch,
  capture stability, and injected mismatches describe a test harness rather
  than a user outcome.
- `platform.max-strict-lints` — Compiler, linter, formatting, dependency, and
  custom-audit settings govern repository source quality rather than user
  behavior.
- `platform.audit-strictness-guard` — Scanning test attributes, filenames, skip
  spellings, and thresholds is a CI guard about other tests, not a persona
  outcome.
- `platform.file-and-function-budgets` — Source line and function-size budgets
  constrain repository organization, not a portable product outcome.
- `platform.production-loc-budget` — A governed source-line budget and
  deleted-code measurement are implementation-maintenance constraints.
- `platform.module-boundaries-and-deletion-ledger` — Kept, rewritten, deleted,
  imported, and forbidden module inventories are repository architecture
  governance.
- `platform.no-legacy-imports` — Import and re-export bans name retired
  implementation modules rather than an observable user outcome.
- `platform.title-node-neutrality` — Source, documentation, filename, and
  planning-token scans are repository hygiene, not a portable persona
  behavior.
- `platform.security-test-retention` — Ignored tests, named lanes, and
  upstream-failure masking are CI governance; the underlying traversal,
  secret, permission, and malformed-input outcomes remain in portable
  behaviors.
- `platform.retired-planning-control-plane` — The inventory explicitly
  excludes a machine-managed planning lifecycle; catalog stewardship needs no
  user behavior for it.
- `platform.retired-planning-state-import` — The inventory explicitly excludes
  importing or atomically swapping a machine planning database.
- `platform.retired-audit-disposition-workflow` — The inventory explicitly
  retains audit findings as ordinary review artifacts rather than a
  transactional planning workflow.
- `platform.retired-planning-state-export` — The inventory explicitly excludes
  a generated canonical planning-state export.
- `platform.retired-roadmap-path-validator` — The inventory explicitly
  excludes validating verification paths as machine planning records.
- `platform.retired-milestone-reporting` — The inventory records state rather
  than sequence and explicitly excludes machine milestone reporting.
- `platform.retired-planning-dashboard-provenance` — Evidence strength is
  carried directly by capability and behavior state, so the inventory
  explicitly excludes a planning-dashboard provenance mechanism.
- `platform.retired-issue-synchronization` — The inventory explicitly excludes
  creating or mutating external issues from planning records.
- `platform.retired-planning-gate-reconciliation` — The inventory explicitly
  requires reviewed state changes rather than automatic advancement from
  check results.
- `platform.retired-planning-graph-validation` — The inventory stores no
  planning graph and explicitly excludes graph validation and lifecycle
  readiness.
- `platform.readiness-hub` — This is explicitly an aggregate about other
  capabilities and says it cannot prove a product outcome itself; fixed
  personas consume the underlying journey, support, evidence, privacy, and
  evaluation behaviors.

## Product

- `product.design-system-tokens` — Design tokens are framework implementation,
  not a portable user outcome.
- `product.review-queue` — The source explicitly retires the human per-unit
  review queue.
- `product.single-review-actions` — The source explicitly retires human unit
  disposition actions in favor of whole-round feedback.
- `product.batch-review-actions` — The source explicitly retires batched unit
  transitions in favor of whole-round feedback.
- `product.line-scene-result-editor` — Direct human line or scene mutation
  violates the binding whole-round refinement boundary.

## Quality

- `quality.hollow-implementation-killer` — This prescribes mutation testing of
  an implementation; each retained behavior already states the user-observable
  outcome its portable test must make nonvacuous.
- `quality.exact-error-path-testing` — This is a rule about how negative tests
  are written; stable observable failure classes are retained in
  `quality.failures-stay-explicit`.
- `quality.no-dual-production-paths` — Producer count, symbols, aliases, and
  compatibility-shim topology are internal architecture rather than a
  portable persona outcome.
- `quality.no-dead-contract-variants` — Reachability of internal variants is
  contract-maintenance bookkeeping; constructible public outcomes are covered
  by their owning behaviors.
- `quality.behavior-first-test-classification` — Unit, integration, and
  dependency classifications describe the repository test suite, not an
  outcome wanted by a fixed persona.
- `quality.browser-e2e` — Browser automation is a test mechanism for user
  journeys already represented by portable journey, review, play, and
  administration behaviors.
- `quality.component-isolation-and-visual-regression` — Story harnesses,
  component forwarding, and baseline-management mechanics are internal tests;
  accessible interface and visible play outcomes remain in
  `studio.find-authorized-work` and `play.observe-localized-surfaces`.
- `quality.per-gate-synthetic-coverage` — Per-change lane selection and runtime
  are CI topology; profile qualification already retains the observable
  coverage and divergence outcomes.
- `quality.safe-mutation-isolation` — Copied workspaces, parallel mutation
  lanes, and source-hash test setup are repository test mechanics, not a
  persona outcome.
- `quality.permission-guard-parser-rigor` — Alias, comment, SQL, and
  syntax-tree scanners test repository implementation patterns; access
  outcomes are covered by `account.administer-access`.
- `quality.no-title-or-node-mechanisms` — Source tokens, filenames, and
  planning identifiers are repository hygiene rather than a portable user
  outcome.
- `quality.lean-self-documenting-code` — Module size, function length,
  comments, shims, imports, and code organization are implementation-quality
  constraints, not persona behavior.
- `quality.blind-multifamily-judge-panel` — The inventory explicitly retires
  the live multi-family panel; frozen-label calibration remains in
  `evaluation.compare-contestants`.
