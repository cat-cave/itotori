# Executable behavior-proof system

The existing feature files are portable contracts, not executable tests.
`proof-ledger-and-explicit-failures` turns them into the sole progress ledger;
later specs fill that ledger rather than writing status into planning files.

## Classified matrix

The source authorities are:

- 47 behavior IDs in `docs/behaviors/catalog.jsonl`;
- 47 canonical engine rows in
  `docs/behaviors/engine-families.jsonl`;
- 570 Examples rows in `docs/behaviors/features/*.feature`; and
- the evidence-backed applicability in
  [`classification.jsonl`](classification.jsonl).

The classified denominator is:

```text
31 invariant behaviors × 1 shared subject
4 varying behaviors × 47 canonical engine subjects
12 varying behaviors × 39 production subjects
= 687 cells
```

The four full-canonical behaviors have one explicit Gherkin Examples row per
canonical engine. The twelve production-only behaviors use generic registered
native, web, or family/profile examples. The protected selection rules in
[`case-selection.md`](case-selection.md) expand the 570 authored rows into
exactly 3,400 executable cases. They select every applicable cell and no
non-production case absent from the scenarios.

Each scenario case gains one protected selector:

- `shared` selects the one invariant subject;
- `canonical:<sourceCapability>` selects one declared canonical-row outcome;
- `production-trait:<trait>` resolves through adapter-owned metadata for
  production subjects; and
- `comparison:<sourceCapability>` names a secondary contestant/reference and
  never changes the cell subject.

Unknown selectors, duplicate matches, attempted subject overrides, or a
classified cell with zero selected cases are red. Nonapplicable candidates are
absent from the signed selection plan, not skipped.

## Profile aggregation

Profile-varying cells use the canonical family `sourceCapability` as their
subject, but their result aggregates every concrete registered profile for that
family. The signed plan records profile identities, traits, and selected cases.
Missing, duplicate, generic-only, unclassified, or selected/executed-mismatched
profiles are red.

The family/profile crosswalk is adapter-owned data generated from the sole
engine authority. Recipes, workflows, orchestration, and deployment inputs
cannot contain another engine list. [`engines.md`](engines.md) resolves the
action-plan discovery language into the 47 canonical rows and fixes the
material profiles that each owning qualification cell must register. An
omitted or generic-only required profile fails that cell.

## Runner contract

Pin the root development dependency to
[`@cucumber/cucumber@13.2.0`](https://github.com/cucumber/cucumber-js/tree/v13.2.0)
under the frozen pnpm lock. The repository's Node 24.14.0 satisfies that
release's runtime contract. One JavaScript runner parses every feature,
executes with strict mode, and emits the documented Cucumber Messages NDJSON
and JUnit streams.

Precompiled ESM step definitions live under `suite/behavior/steps/`; World
support lives under `suite/behavior/support/`; boundary drivers live under
`suite/behavior/drivers/`. TypeScript drivers exercise command, HTTP, and
rendered boundaries. Rust behavior is exercised through built product CLI
binaries using argv/stdin and typed JSON stdout, so it enters the same World
and result stream. The Rust-native
[`cucumber@0.23.0`](https://docs.rs/cucumber/0.23.0/cucumber/) runner
is rejected: it would add a second parser, glue system, and formatter while the
product boundary would still be a subprocess.

Candidate code cannot define its own proof. A protected verifier outside the
pull-request tree owns classification, case selection, role oracles,
base/head comparison, result schemas, negative controls, and the required
conclusion. A distinct GitHub App with a digest-pinned verifier is preferred.
A separately protected required workflow is acceptable only after its
immutability and availability are demonstrated. Candidate code never executes
through `pull_request_target`.

The verifier signs one execution plan. An unprivileged hosted job runs the
candidate through the pinned runner and returns a content-addressed event
stream. It has no check-writing, issue-writing, private-evidence, or broker
credential. The verifier authenticates plan, runner, tree, event stream, and
hosted execution provenance before deciding.

The root bundle must:

1. Parse all 47 features and measure all 570 Examples rows.
2. Load all 582 stable source identities and verify the sorted-identity digest
   `48777d244fafe26e8ba834ed6b456b1756217380ef6a4af17ef27b42a942bcb3`;
   older aggregate prose is evidence context, not a competing identity set.
3. Bind every observable Gherkin clause to public-boundary drivers and
   assertions; missing bindings are executable red cases.
4. Apply the classification and protected selectors to generate exactly 687
   unique cells and exactly 3,400 selected executable cases, with at least one
   selected case for every cell.
5. Bind Given/When/Then phrases to reusable drivers whose gaps fail with typed
   outcomes rather than pending or skipped results.
6. Require selected, executed, asserted, and reported cases and profiles to
   agree exactly.
7. Emit content-free result JSON, JUnit, mutation results, and a human summary.
8. Register `kill::<behavior>::<subject>` for every cell and require the cell's
   protected hollow, fixed-empty, or corruption mutation to turn it red.

The runner fails on:

- an unbound or ambiguous step, parse error, missing World, duplicate cell, or
  unknown selector;
- a missing, skipped, pending, undefined, filtered, or zero-assertion selected
  case;
- an absent selected cell/profile or unexpected executed cell/profile;
- a successful empty/default response where the scenario requires an
  operation or explicit failure;
- missing input, runner, tool, corpus, receipt, or evidence field;
- a green result whose role cannot support its claimed outcome;
- a result document with fewer or more than 687 unique cells; or
- a linked spec that turns none of its owned cells red to green.

`cell_transition_rejects_fixed_empty_driver` is the root's
implementation-killing test: replacing the explicit-failure driver with fixed
success must remove the typed non-success, diagnostic, and no-effect
observations and fail that test. Package-promotion planning has an equivalent
fixed-empty negative control in the same cell-closing root bundle. Every later
spec must retain at least one protected mutant that kills a cell it owns.

## Field-population truth

Every structured producer records privately, for each real input:

```text
field, nonempty_count, total_count, status, private_source_evidence_handle
```

`status` is exactly one of:

- `populated`;
- `source-absent` — independent source evidence proves the source lacks it;
- `extractor-missing` — the source contains it but extraction is not
  implemented;
- `implemented-but-empty` — the implementation ran and produced no value;
- `invalid`; or
- `unknown`.

Only `populated` and independently proved `source-absent` satisfy a claimed
complete field. Missing data is not encoded as zero. Reports compare sibling
profiles when sources provide comparable evidence. Any whole-work,
multi-project, concurrency, throughput, density, or capacity claim executes at
that declared scale and records the measured count, size, or rate. Visual
density claims retain fixed-viewport screenshots.

Exact private counts, sizes, durations, screenshots, and evidence handles stay
private because candidate-controlled numeric/hash fields can become covert
channels. Public fixture reports may publish redistributable measurements.
Private candidate runs publish only request-known cell identities, a generic
conclusion, and a randomized commitment.

## Required CI checks

### Collection and identity

Replace the placeholder manifest member with a real behavior-manifest job in
the existing required aggregate. It:

- collects 47 behaviors, 47 canonical engines, 31/11/5 classification rows,
  687 cells, 26 bundle definitions, and 241 specs;
- reports the measured candidate and nonzero selected case counts without
  assuming an engine cross-product, and requires the protected total of 3,400;
- validates selectors, role/applicability, subject/comparison separation,
  clause mappings, step bindings, spec ownership, and result schemas;
- runs the live repository test-collection scan, not only its unit tests;
- rejects an unreviewed behavior, classification, cell, case, or spec drop; and
- rejects a spec-linked pull request whose issue names no owned cell.

This check establishes collection, not a pass claim.

### Execution and protected verifier

An unprivileged behavior-proof job joins the existing required execution
aggregate and submits protected proof requests. It does not author the trusted
conclusion.

The external verifier publishes the distinct App-bound required context
`behavior-proof / required`. Install it and atomically add its expected App to
the ruleset while retaining existing aggregates. A missing installation,
result, or expected-App binding fails
`cell::quality.evidence-is-traceable-and-portable::all`; a same-named Actions
job cannot satisfy it.

The verifier enforces:

```text
no base-green cell becomes head-red
each governed implementation change links at least one open semantic spec
each linked spec turns at least one owned base-red cell candidate-green
every transitioned cell is owned by exactly one linked open spec
every transitioned cell's protected negative control turns it red again
selected cells and profiles equal executed and reported cells and profiles
skip, pending, missing assertion, or zero-byte receipt cannot be green
```

Public cells execute on pull requests. A private production cell stays red
until an approved candidate receives its protected broker run and, where
required, authenticated human evidence. Private or human work never starts
inside the merge queue.

The merge verifier resolves the union of linked specs, rejects conflicting
ownership, and checks each pre-issued receipt against the final candidate tree,
build, and dependency cone. A matching subject is reusable; an affected cone
fails closed and needs new evidence. After squash, main verifies tree/build
equivalence or requests fresh proof.

### Full matrix

The full-matrix check consumes the same execution and protected receipts. It
reports `green/687` plus per-behavior, per-subject, and per-profile failures. It
stays visibly red while any cell is red and never uses neutral conclusions,
shell suppression, or continue-on-error to imply completion. It becomes a
required release policy only when it first reaches 687/687.

## Semantic GitHub Issue contract

Every issue contains:

```text
Spec: <semantic instance name>
Bundle: <bundle name>
Subject: all | <canonical sourceCapability>
Cells: <exact array from spec-instances.jsonl>
Expected red observation: <failing behavior>
Green observation: <bundle acceptance>
Negative controls: <one or more kill::<behavior>::<subject>>
Evidence class: public-safe | private receipt
Estimated changed lines/files: <instance values and sizing basis>
Non-goal: <bundle non-goal>
```

The checked-in idempotent renderer is
`scripts/render-roadmap-issues.mjs`. `--check` is read-only; a repository owner
invokes authenticated `--apply`. It reads the contract hash, bundle definitions,
and instances; creates or reconciles 26 bundle parents and 241 semantic
subissues; then rereads bodies and relationships and compares them byte for
byte. Runtime opaque identifiers are never committed.

Every reduced edge is reconciled through GitHub's native `addBlockedBy` and
`removeBlockedBy` GraphQL mutations. Bundle membership uses native subissues.
The renderer queries 100 nodes per page and sends mutation batches of 20 fixed
aliases, aborting the batch on any partial error. It reads the native
`blockedBy`, `blocking`, `issueDependenciesSummary`, `parent`, `subIssues`, and
`subIssuesSummary` fields, cross-checks the REST
`/issues/{issue_number}/dependencies/blocked_by` view, and enforces the 50-link
limit. The implementation pull request links every spec it intends to close.
The verifier rejects an unlinked transition, a linked spec with no transition,
duplicate cell ownership, or a governed change with no linked spec.

Issue Forms and Projects automation are rejected because forms cannot validate
dependency truth and Projects would create a second status ledger. The
external App uses read-only contents, pull-request, and issue access plus check
write access, caches the native graph, and never performs one API call per
cell.

## Evidence retention and diagnosis

Each run retains content-free:

- collection, profile-selection, and cell-result JSON;
- JUnit with one aggregate testcase per cell and child case references;
- base/head transition and spec-ownership diff;
- public-fixture screenshots and only opaque commitments for private captures;
- mutation kill report;
- public fixture and synthetic-parity summaries; and
- verified private receipt subjects and signature results.

The aggregate reports every failed lane even when an earlier guard fails.
Retention follows the immutable-artifact cell. Alerts name the failed check,
revision, semantic spec, cell identities, and artifact handle, never private
paths or content.
