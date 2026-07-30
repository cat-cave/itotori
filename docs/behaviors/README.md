# Portable behavior catalog

Start with the [eight personas](personas.md). They were fixed before any
behavior was derived, and every retained behavior names at least one of them.

This catalog reduces 582 canonical source capabilities to 47 user-observable
behaviors. It is the portable BDD view of the capability inventory: each
behavior and its test is intended to be copyable into a fresh repository and
exercised through boundaries a greenfield implementation would also expose.

## Accounting

| disposition | capabilities | meaning                                                            |
| ----------- | -----------: | ------------------------------------------------------------------ |
| folded      |          188 | one capability contributes to one behavior                         |
| merged      |          190 | overlapping capabilities contribute to one behavior                |
| split       |          146 | one broad capability contributes to two or more behaviors          |
| dropped     |           58 | no persona-facing portable outcome; an explicit reason is recorded |
| **total**   |      **582** | every canonical source row appears exactly once                    |

The exhaustive machine-readable mapping is split by subsystem under
[`capability-map/`](capability-map/). The
[drop ledger](dropped-capabilities.md) presents every dropped capability and
its reason in one human-readable list. Nothing is unaccounted for.

The audit proves structural accounting and portable specification shape.
Whether a source capability was mapped to the right user outcome remains a
reviewed derivation, not something a count or hash can decide.

Behavior state is the weakest state of every capability folded into that
behavior. The resulting 47 behaviors are 34 `intended`, 5 `asserted`, 6
`built`, and 2 `proven-synthetic`. No behavior is labelled `proven-real`
because every candidate at that altitude includes at least one weaker source
capability.

## Portable specifications

The 47 `Scenario Outline` specifications are grouped by subject under
[`features/`](features/):

- catalog and knowledge;
- engine and content;
- identity and access;
- localization runs;
- platform operation;
- play and runtime evidence;
- quality and safety; and
- review and evaluation.

Every outline has `Examples`, and every placeholder is a named slot in both
the examples table and [`catalog.jsonl`](catalog.jsonl). Common slots include
actor, observable boundary, engine family, profile, support role, target
locale, placement, provider posture, privacy posture, run mode, scope,
failure case, and expected outcome.

Five engine-shaped behaviors use the exact same 47-row matrix:

- `support.qualify-profile`;
- `support.disclose-compatibility`;
- `content.extract-complete-scope`;
- `patch.produce-safe-output`; and
- `play.launch-patched-content`.

The matrix is canonical in
[`engine-families.jsonl`](engine-families.jsonl). It distinguishes production
targets, unqualified target profiles, research-only profiles, synthetic and
benchmark references, parity reference, and explicit exclusion. Engine
families are example values only; they never appear in a behavior identifier.

## Source and audit trail

[`source-inventory/`](source-inventory/) is a lossless JSONL copy of the 582
canonical source rows. The exact identity lineage, state/subsystem totals, and
sorted-ID hashes are recorded in
[`../roadmap/source-accounting.md`](../roadmap/source-accounting.md).
[`catalog.jsonl`](catalog.jsonl) records each behavior's personas, weakest
state, observable boundaries, parameters, feature file, and portability test.
The catalog audit verifies:

- the canonical 582-row source hash and source-field population;
- exact one-for-one mapping coverage, order, and source state;
- exact disposition totals, shape, and explicit reasons;
- synchronization of the human drop ledger;
- weakest-state derivation;
- persona, observable-boundary, and portability-test presence;
- `Scenario Outline` / `Examples` correspondence;
- the exact 47-row engine matrix in all five engine-shaped behaviors;
- engine values only in examples cells; and
- the 500-line limit for every behavior artifact, including the source JSONL,
  and the linked overview documents.

Run it with:

```sh
node --test scripts/audit-behavior-catalog.test.mjs
node scripts/audit-behavior-catalog.mjs
```

## Strategy reconciliation

The earlier stable-name scope contained 553 identities: 543 carry over
unchanged and ten retired planning-control identities have one-for-one neutral
replacements with the same meaning, acceptance boundary, order, and `dropped`
state. The canonical input then appends 29 intended engine-row identities,
bringing decode from 121 to 150 and the overall total to 582. Those identities
are slots, not implied support. The action plan remains authoritative: research
profiles stay research-only, the fixture remains synthetic-only, the benchmark
and parity rows remain references, and the dedicated excluded profile remains
excluded.
