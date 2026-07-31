# Behavior-proof roadmap

This roadmap decomposes [`docs/action-plan.md`](../action-plan.md) without
changing its intent. The action plan remains the authority for product scope,
proof strength, privacy, deployment, and release. GitHub Issues carry planned
intent and native blocked-by/blocking relationships; executable cell results
are the progress ledger.

The first complete production vertical remains RealLive. The synthetic
reference proves only portable contracts. No capability is removed or
deferred, no legacy compatibility path is added, and the closed deployment
registry remains the eight entries in
[`config/environment-registry.json`](../../config/environment-registry.json).

## Audited result

The draft treated every behavior as if it had a distinct implementation for
every canonical engine. Reading each Gherkin outline, every mapped capability,
and the cited implementation or test produced this classification:

| Classification   | Behaviors | Cell rule                                                                             |
| ---------------- | --------: | ------------------------------------------------------------------------------------- |
| Engine-invariant |        31 | one shared cell proves the behavior across engines                                    |
| Engine-varying   |        11 | one cell for each applicable family because code or proof differs                     |
| Profile-varying  |         5 | one family cell aggregates every concrete registered material profile                 |
| **Total**        |    **47** | the full reasoning and evidence are in [`classification.jsonl`](classification.jsonl) |

Only four varying behaviors have explicit outcomes for all 47 canonical rows:
profile qualification, complete extraction, safe patch production, and patched
launch. The other twelve varying behaviors describe registered production
families, so they have cells for the 39 production targets and no invented
synthetic, benchmark, parity, research, or exclusion journey/profile cells.

```text
31 shared cells + (4 × 47 canonical rows) + (12 × 39 production rows)
= 687 honest cells
```

That is 1,522 fewer cells than 2,209, a 68.9% denominator reduction. A profile
cell is green only when every materially distinct profile registered for that
family passes. Generic labels do not create speculative subcells; an
unclassified concrete profile is a failing selected member of its family's
qualification cell.

The 570 authored Examples rows select exactly 3,400 executable cases. The
subject, comparison, applicability, trait, and literal-family rules for all 14
partial engine-shaped outlines are fixed in
[`case-selection.md`](case-selection.md).

## PR-sized specs

[`spec-bundles.jsonl`](spec-bundles.jsonl) defines 26 reviewed bundle rules.
They expand through the canonical engine registry into
[`spec-instances.jsonl`](spec-instances.jsonl):

| Expansion                                       | Definitions | Instances |
| ----------------------------------------------- | ----------: | --------: |
| Shared invariant behavior bundles               |          14 |        14 |
| Registered or bounded production family bundles |           5 |        75 |
| Unqualified production family bundles           |           6 |       144 |
| Non-production bounded-role conformance         |           1 |         8 |
| **Total**                                       |      **26** |   **241** |

The draft had 2,209 atomic issue specs. The audited roadmap has 241 realistic
implementation specs, an 89.1% reduction. Each instance names one or more exact
`cell::<behavior>::<subject>` transitions, has at least five expected changed
files, and carries its bundle's acceptance, non-goal, dependency, sizing basis,
and rationale. Infrastructure and shared-substrate work lands inside a bundle
that turns at least one cell red to green.

## Change-surface sizing

`estimateLines` means authored additions plus deletions in implementation,
tests, schemas, receipts, and directly affected docs. It excludes generated
output, lockfile churn, and private corpus bytes. It is a change-surface
estimate, not a duration or effort estimate.

The adapter/runtime basis is calibrated against three landed family increments.
Re-running `git show --numstat --format=` for commits `82deba5bf`,
`7e611f2df`, and `4ef7136d1`, excluding lockfiles and fixture bytes, measures
2,712 lines across 12 files, 1,603 across 12, and 1,716 across 9. The roadmap
splits comparable full-family work across multiple behavior-closing specs.
Service, browser, policy, contract, and journey bases count the named
production, persistence, boundary-test, receipt, and documentation seams in
the current tree, then round to the nearest 50 lines. Each candidate's owning
cells record the exact base/head diff; a missing measurement is red and does
not alter the sizing rule.

| Estimated changed lines | Specs |
| ----------------------: | ----: |
|                 500–649 |     8 |
|                 650–799 |    43 |
|                800–1000 |   190 |

The median is 900, the range is 600–1,000, and the portfolio total is 211,900
estimated authored changed lines. Every bundle definition explains why its
files belong together; expanded instances inherit that rationale.

## Proof and dependency invariants

- Missing, uncollected, skipped, pending, fixed-empty, zero-assertion, or
  selected/executed-mismatched results are red.
- A production-positive content/runtime cell requires current receipts from
  two independently sourced lawful titles.
- Every structured real-input output reports nonempty over total for every
  field or independently proves source absence.
- Non-production rows pass only their explicit bounded outcomes and cannot
  inflate production support.
- Every spec owns at least one exact cell transition; every classified cell has
  exactly one owning spec.
- The native issue graph is transitively reduced, acyclic, fully reachable,
  and has the sole root `proof-ledger-and-explicit-failures`.
- No roadmap file records issue status, percentage, dates, or delivery
  estimates.

## Files

- [`classification.md`](classification.md) is the readable 47-way audit;
  [`classification.jsonl`](classification.jsonl) is its validated authority.
- [`source-accounting.md`](source-accounting.md) fixes the exact 582-identity
  authority, lineage, states, dispositions, and hashes.
- [`specs.md`](specs.md) explains the 26 bundle rules and 241 expansions.
- [`dependency-dag.md`](dependency-dag.md) defines the native issue graph.
- [`proof-system.md`](proof-system.md) defines executable Gherkin, honest cell
  accounting, issue acceptance, and CI ratchets.
- [`ci-audit.md`](ci-audit.md) preserves the measured CI findings and six
  prerequisite repairs.
- [`ci-initialization.md`](ci-initialization.md) fixes the runner, report,
  lanes, gates, missing-input policy, private path, and initial numerator.
- [`progress-ledger.md`](progress-ledger.md) fixes accepted-report publication,
  base/head transition queries, generated progress views, issue reconciliation,
  and stacked delivery.
- [`real-bytes.md`](real-bytes.md) defines the private maximum-truth proof.
- [`engines.md`](engines.md) explains applicability and canonical subject
  identity without another engine registry.
- [`case-selection.md`](case-selection.md) fixes subject/comparison selection
  and the exact 3,400-case expansion.
- [`action-plan-crosswalk.md`](action-plan-crosswalk.md) reconciles bundles to
  the authoritative workstreams and dependency waves.
- [`unverified.md`](unverified.md) assigns all 32 material evidence
  observations to exact owning cells or finite validator-expanded cell sets.

Run the structural audit with:

```sh
node --test scripts/audit-behavior-roadmap.test.mjs
node scripts/audit-behavior-roadmap.mjs
```
