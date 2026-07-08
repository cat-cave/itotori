# UTSUSHI-063 — Fixture snapshot restore playback smoke

- **Node**: UTSUSHI-063
- **Title**: Fixture snapshot restore playback smoke
- **Branch**: `spec/utsushi-063`
- **Worktree**: `/scratch/worktrees/itotori-spec-utsushi-063`
- **Author**: planning worker (orchestrator)
- **Date**: 2026-06-23
- **Status target**: in_progress → ready_for_review (single implementation slice)
- **Dependencies landed**: UTSUSHI-012 (controlled playback contract), UTSUSHI-023 (snapshot primitives), UTSUSHI-028 (snapshot conformance + `SnapshotStore` + `InMemorySnapshotStore`).
- **Direct downstream**: Engine ports landing controlled playback that emit
  snapshot refs (UTSUSHI-103 siblings) consume the smoke test as a
  determinism oracle; UTSUSHI-064 consumes the same `InMemorySnapshotStore`
  posture for recording metadata smoke.

## 1. Goal restatement

Add an **integration-level smoke test** that exercises the controlled playback
contract through a fixture by performing a full **snapshot save → restore →
re-playback** cycle, using the existing `SnapshotStore` /
`InMemorySnapshotStore` substrate (UTSUSHI-028) and the
`SnapshotConformanceCheck` to assert that the restored state matches the
baseline.

The slice's value is structural: it pins the **smoke contract** that any
controlled-playback engine port must satisfy. The substrate already exists;
this slice writes the gate that consumes it.

Acceptance-criterion-driven shape:

1. **Snapshot round-trip is byte-deterministic.** A snapshot saved into
   `InMemorySnapshotStore`, then resolved back through the same store, then
   re-serialized through the deterministic JSON path, produces bytes
   byte-identical to the original.
2. **State drift surfaces explicitly.** When the post-restore state diverges
   from the baseline at any `StatePath`, the smoke test asserts
   `SnapshotConformanceCheck::run()` returns
   `ResultOutcome::Fail { semantic_code: "utsushi.snapshot.state_drift", … }`
   with one `EvidenceRef::StatePath { path }` per drifted path.
3. **Missing snapshot → typed error.** Resolving a non-existent
   `SnapshotRef` returns `SnapshotError::NotFound { snapshot_id }` with
   semantic code `utsushi.snapshot.store_not_found`, not a silent
   `Result<Option<Snapshot>, _>` `None`.
4. **No host paths in committed fixtures.** Every URI in the smoke fixture
   passes `reject_unredacted_local_paths`; snapshot ids and state paths
   are public, kebab-namespaced strings; no `PathBuf` appears anywhere.

### Hard architectural constraints

- Engine-neutral. The smoke test names no engine; the fixture runtime is
  the only producer.
- Snapshot refs use `SnapshotRef` (id-only); the smoke test never inlines
  bytes or paths.
- `InMemorySnapshotStore` is the resolution backend; no on-disk store, no
  bundle reader, no file I/O.
- Determinism path: snapshot JSON is serialized through the existing
  deterministic JSON helper (`utsushi-core::recorder::deterministic_json_bytes`
  re-export, or the snapshot module's own deterministic emitter — whichever
  the substrate already exposes).
- State drift defends against the audit-focus item "restore drift not
  surfaced" by **always** running `SnapshotConformanceCheck` on the
  post-restore state, even in the happy path; a Pass outcome with no
  `StatePath` evidence is the positive assertion.

## 2. Module placement

The smoke test is a single integration test file in `utsushi-core/tests/`,
sitting alongside the existing `snapshot_round_trip.rs` and
`conformance_snapshot.rs`. Fixtures are inline (constructed in the test)
because the snapshot model is small enough that an external JSON file
provides no review benefit, and using an inline fixture keeps the
deterministic-bytes oracle local.

```
crates/utsushi-core/tests/
  fixture_snapshot_restore.rs    # NEW — the smoke test
  snapshot_round_trip.rs          # existing (UTSUSHI-023)
  conformance_snapshot.rs         # existing (UTSUSHI-028)
  snapshot_state_drift.rs         # existing (UTSUSHI-028)
```

The test reuses:

- `utsushi_core::snapshot::{Snapshot, SnapshotRef, SnapshotId, SnapshotStore, InMemorySnapshotStore, SnapshotError}` from UTSUSHI-023/028.
- `utsushi_core::conformance::snapshot_check::SnapshotConformanceCheck` from UTSUSHI-028.
- `utsushi_core::ReplayLog`, `utsushi_core::ReferenceRecorder`, `utsushi_core::SourceTag::Fixture` from UTSUSHI-021/060 to drive controlled playback through a fixture runtime.

No new module, no new workspace member, no new source file outside the
single integration test.

Coordination with UTSUSHI-062 / UTSUSHI-064 (parallel siblings):

- UTSUSHI-062 owns the jump-target + replay-log fixture set; this slice
  does NOT depend on those fixtures and constructs its own inline snapshot
  fixture so the two integration tests stay decoupled.
- UTSUSHI-064 owns the recording-metadata smoke; this slice does NOT
  touch capture / recording surfaces.

## 3. Smoke pipeline

The smoke test performs the following operations in order. Each step is a
named sub-test (the `#[test]` functions in §6 each exercise a subset of
this pipeline).

1. **Construct an inline fixture snapshot.** A `Snapshot` with:
   - `id: "smoke-snapshot-001"` (kebab-namespaced).
   - `schema_version: SNAPSHOT_SCHEMA_VERSION`.
   - `state`: 4 `StatePath` entries (e.g. `scene.id`,
     `scene.position.line`, `flags.read_count`, `inventory.slot.0`) with
     deterministic string/integer values.
   - `assets`: empty (no asset refs needed for the smoke).
   - `clock_tick: LogicalClockTick(7)`.
2. **Save snapshot.** `store.save(&snapshot)` on a fresh
   `InMemorySnapshotStore`.
3. **Resolve snapshot.** `store.resolve(&snapshot_ref)` returns the
   saved snapshot. Assert deep-equality.
4. **Serialize round-trip.** Serialize the resolved snapshot through the
   deterministic JSON helper; assert byte-equality with a previously
   computed canonical serialization (also computed in-test from the
   baseline, so the gate is "serialize twice → same bytes").
5. **Drive a `ReplayLog` over a fixture runtime.** Use
   `InMemoryReferenceRecorder` (UTSUSHI-060) to record a short replay
   beginning at `clock_tick: 7` (post-restore tail replay).
6. **Conformance check.** Build a `SnapshotConformanceCheck` with the
   baseline snapshot and the post-restore snapshot, run it, and assert
   `ResultOutcome::Pass { evidence_tier: <profile ceiling> }`.
7. **State drift twin.** Mutate one `StatePath` value in the post-restore
   snapshot; rerun the conformance check; assert
   `ResultOutcome::Fail { semantic_code: "utsushi.snapshot.state_drift", … }`
   with the mutated path appearing in the `EvidenceRef::StatePath`
   evidence list.

## 4. Determinism oracle

The smoke test serializes the baseline snapshot twice (once at construction
time, once after the resolve round-trip) and asserts byte-equality. This is
the canonical "serialize twice → same bytes" pattern from UTSUSHI-022 /
UTSUSHI-060 fixtures.

The deterministic serializer is whichever path the snapshot substrate
already exposes; the test calls it through the public re-export at
`utsushi_core::snapshot::serialize_deterministic_json_bytes` or
`utsushi_core::recorder::deterministic_json_bytes` (whichever is the
documented snapshot path).

The test does NOT compare against a committed JSON artifact (unlike
UTSUSHI-062's replay-log determinism gate). Rationale: the snapshot's
canonical bytes are derived in-test from the inline fixture, so a
committed artifact would be a tautology. The two-pass byte-equality check
catches every nondeterminism source the deterministic helper can reach
(serde hashmap iteration, serializer-internal buffering).

## 5. State-drift detection

`SnapshotConformanceCheck` (UTSUSHI-028) is the canonical drift detector.
The smoke test uses it in both happy-path and twin form:

- **Happy path.** The check runs against `(baseline, post_restore)` where
  both are the same snapshot bytes. Validation passes; `run()` returns
  `Pass`.
- **Twin.** A mutated post-restore snapshot (one `StatePath` value
  changed) is fed to the same check; `run()` returns
  `Fail { semantic_code: "utsushi.snapshot.state_drift" }` with the
  mutated path in `EvidenceRef::StatePath`. The test asserts the exact
  string of the mutated path appears in the evidence list (defends
  audit-focus "drift reported too vaguely").

## 6. Test plan

Tests live in `crates/utsushi-core/tests/fixture_snapshot_restore.rs`.
Tests follow `docs/dev/testing-standard.md`: falsifiable, behavior-named,
synthetic inline fixtures only.

### 6.1 Happy path

- `fixture_snapshot_round_trips_through_in_memory_store_byte_for_byte()`.
- `fixture_snapshot_resolves_to_deep_equal_baseline()`.
- `fixture_snapshot_serializes_identically_across_two_consecutive_calls()`.
- `fixture_snapshot_conformance_check_passes_when_baseline_and_observed_match()`.

### 6.2 State drift

- `fixture_snapshot_conformance_check_fails_with_state_drift_code_when_one_state_path_diverges()`.
- `fixture_snapshot_conformance_check_lists_every_drifted_state_path_in_evidence()`
  — mutate three `StatePath` values, assert all three appear in the
  `EvidenceRef::StatePath` evidence vec.
- `fixture_snapshot_conformance_check_fail_detail_quotes_state_path_verbatim()`
  — defends audit-focus "drift reported too vaguely"; asserts the exact
  string of the mutated path is in the failure `detail`.

### 6.3 Missing snapshot

- `fixture_snapshot_store_resolve_returns_not_found_when_snapshot_ref_missing()`
  — asserts `SnapshotError::NotFound { snapshot_id }` with semantic code
  `utsushi.snapshot.store_not_found`.
- `fixture_snapshot_store_does_not_silently_return_optional_none()` —
  asserts the trait signature is `Result<Snapshot, SnapshotError>`, not
  `Result<Option<Snapshot>, _>`. (Compile-time / type-level assertion via
  `static_assertions::assert_impl_one!` or a trait-bound check.)

### 6.4 Schema-version guard

- `fixture_snapshot_store_resolve_returns_mismatched_schema_version_when_baseline_pinned_to_old_version()`
  — constructs a snapshot with a fabricated old schema version and asserts
  `SnapshotError::MismatchedSchemaVersion` with code
  `utsushi.snapshot.store_mismatched_schema_version`.

### 6.5 Controlled-playback alignment

- `fixture_snapshot_clock_tick_aligns_with_replay_log_post_restore_tail()`
  — drives a `ReplayLog` whose first entry's clock tick equals the
  snapshot's `clock_tick`; asserts the recorder emits the tail entries
  in the expected order. Defends audit-focus "deterministic playback
  gaps".

### 6.6 Redaction filter

- `fixture_snapshot_smoke_payload_passes_reject_unredacted_local_paths_filter()`
  — walks the serialized snapshot JSON + the conformance result JSON and
  asserts the project-wide redaction filter does not flag any leaf.
- `fixture_snapshot_smoke_does_not_inline_bytes_in_any_field()` —
  inspects every field via serde reflection (or a hand-written walker)
  and asserts no `bytes`-shaped or `path`-shaped leaf appears.

### 6.7 Determinism oracle (parametrized)

- `fixture_snapshot_serialize_resolve_serialize_produces_byte_identical_output_across_three_runs()`
  — runs the serialize → resolve → serialize cycle three times in a single
  test and asserts all three serialized payloads are byte-identical.

## 7. Verification commands

```
cargo fmt --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test -p utsushi-core fixture_snapshot_restore
cargo test -p utsushi-fixture
just check
```

`pnpm exec vp run ts:test` and `pnpm exec vp run ts:typecheck` are
preserved as runtime gates by `just check`; this slice does NOT change
any TypeScript surface.

## 8. Risks

### 8.1 InMemorySnapshotStore concurrency posture

`InMemorySnapshotStore` (UTSUSHI-028) is `Arc<Mutex<BTreeMap<...>>>`; the
smoke test runs single-threaded so this is structurally fine. Risk:
future concurrent smoke variants would need to revisit the mutex
contract. Mitigation: this slice is single-threaded by design; the
multi-thread story is a follow-up.

### 8.2 Conformance check API surface drift

`SnapshotConformanceCheck` (UTSUSHI-028) is the canonical drift detector.
Risk: a downstream slice tightens the check's signature (e.g. adds a
required field). Mitigation: the smoke test consumes the public surface
only; any change to `SnapshotConformanceCheck` will surface here as a
compile error and the smoke test refresh is mechanical.

### 8.3 Deterministic JSON helper location

UTSUSHI-060 ships `recorder::deterministic_json_bytes`; the snapshot
substrate may expose its own deterministic emitter. Risk: the smoke test
uses the wrong one and accidentally compares non-canonical bytes.
Mitigation: the test reads through the documented snapshot serialize
path (UTSUSHI-023 / UTSUSHI-028 already pin the helper); if the snapshot
substrate does not yet expose a public deterministic emitter, the smoke
test reaches into `recorder::deterministic_json_bytes` after passing the
snapshot through `serde_json::to_value`. Either path is byte-identical
for `BTreeMap`-backed objects.

### 8.4 Audit-focus checklist

| Audit focus                      | Structural defense                                                                                                                                                       |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Restore drift not surfaced       | `SnapshotConformanceCheck::run()` runs on every happy-path test (6.1) and every drift twin (6.2); a Pass outcome with no `StatePath` evidence is the positive assertion. |
| Snapshot referenced by host path | Inline fixture uses kebab-namespaced ids; redaction filter walk in test 6.6 catches any host path leakage.                                                               |
| Deterministic playback gaps      | Replay-log tail alignment test 6.5 asserts the snapshot's `clock_tick` lines up with the recorder's first post-restore entry.                                            |

## 9. Out of scope

- **Engine-port snapshot store.** A real engine port's snapshot bundle
  reader is a follow-up sibling to UTSUSHI-103; this slice uses
  `InMemorySnapshotStore` only.
- **Asset payloads in snapshots.** The smoke fixture has empty
  `assets`; asset-restore drift detection is a follow-up.
- **Multi-snapshot histories.** The smoke restores a single snapshot;
  history-based restore (UTSUSHI-051) is out of scope.
- **TypeScript snapshot ingestion.** Itotori ingestion (downstream of
  UTSUSHI-030) consumes the JSON shape; the TS mirror is additive and
  downstream of this slice.
- **Capture / recording smoke.** UTSUSHI-064 owns the recording
  metadata smoke.
- **Jump-target / bridge linkage.** UTSUSHI-062 owns that fixture
  family.

## 10. Worker scoping

**One worker.** Scope is bounded:

- One new integration test file in `crates/utsushi-core/tests/`
  (~350 LOC).
- No new modules, no new fixtures committed (inline-only).
- No public-API changes.

Estimated diff size: ~350 LOC test code, well inside a single-worker
scope per the UTSUSHI-022 / UTSUSHI-026 precedent. No cross-crate API
changes; no schema-package changes.

---

## Plan-only confirmation

This document is plan-only. No feature code, no fixture JSON, and no
test files are committed by this PR. The implementation worker will
translate this plan into the smoke integration test in a follow-up
branch.
