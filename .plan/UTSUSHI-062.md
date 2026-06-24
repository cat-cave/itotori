# UTSUSHI-062 — Bridge-linked jump target and replay-log fixture

- **Node**: UTSUSHI-062
- **Title**: Bridge-linked jump target and replay-log fixture
- **Branch**: `spec/utsushi-062`
- **Worktree**: `/scratch/worktrees/itotori-spec-utsushi-062`
- **Author**: planning worker (orchestrator)
- **Date**: 2026-06-23
- **Status target**: in_progress → ready_for_review (single implementation slice)
- **Dependencies landed**: UTSUSHI-012 (controlled playback contract), UTSUSHI-021 (deterministic input clock + replay log), UTSUSHI-060 (reference recorder).
- **Direct downstream**: UTSUSHI-027 trace/branch conformance consumes the bridge-linked replay log; engine ports landing controlled playback consume the fixture as a determinism oracle.

## 1. Goal restatement

Ship a deterministic fixture artifact set that **links every jump target to a
stable `bridge_unit_id`** and a paired **replay-log artifact** that exercises the
controlled playback contract end-to-end. The artifacts are produced by a fixture
runner over the existing `ReplayLog` / `ReferenceRecorder` substrate and are
consumed by:

- conformance trace/branch checks (UTSUSHI-027) as the canonical bridge-linked
  trace input,
- engine ports landing controlled playback as the determinism oracle, and
- Itotori ingestion (downstream of UTSUSHI-030) as the fixture set the citation
  manifest references when a batch's `sceneId` is materialized via a fixture.

Acceptance-criterion-driven shape:

1. **Bridge linkage on every jump target.** Each fixture jump target carries a
   stable `bridge_unit_id` that resolves through the canonical bridge unit
   index. A jump target with no linkage is rejected at validation; the fixture
   loader emits `JumpTargetMissingBridgeUnit { target_id }` rather than
   silently dropping the target.
2. **Replay log determinism.** The recorded replay log produced by exercising
   the fixture through the controlled playback contract is byte-identical
   across runs when produced through the `ReferenceRecorder` substrate
   (UTSUSHI-060). A diff against the committed replay log artifact is the
   regression gate.
3. **No host paths in committed fixtures.** Every URI in fixture artifacts
   passes `reject_unredacted_local_paths`; bridge unit ids and jump target
   ids are public, kebab-namespaced strings; no `PathBuf`, no `file:` URI, no
   absolute path appears anywhere in the committed JSON or the in-memory
   model.

### Hard architectural constraints

- Engine-neutral throughout. `SourceTag::Fixture` is the only producer; no
  engine family or version surfaces on any fixture field.
- Bridge unit ids match the `bridge_unit_id` shape used by
  `EvidenceRef::BridgeUnit { bridge_unit_id }` and by ITOTORI-013's scene
  summary citations. The fixture does NOT define a new id schema.
- Replay log artifacts use the existing `ReplayLog` shape from UTSUSHI-021;
  this slice does NOT extend `ReplayLog` or `ReplayEntry`. Bridge linkage is
  carried on the jump-target fixture model that lives alongside the replay
  log, not embedded in `ReplayEntry`.
- The fixture loader's redaction walk reuses
  `reject_unredacted_local_paths_in_value` (already in `utsushi-core`).

## 2. Module placement

Fixtures land in **`crates/utsushi-fixture/tests/fixtures/jump_targets/`**
(committed JSON artifacts) plus a small loader+model in
`crates/utsushi-fixture/src/jump_targets.rs`. The integration test that drives
the fixture through controlled playback and asserts replay-log determinism
lives in `crates/utsushi-core/tests/replay_log_jump_target.rs`.

```
crates/utsushi-fixture/
  src/
    lib.rs                       # additive re-exports
    jump_targets.rs              # JumpTargetFixture, JumpTargetSet, loader,
                                 #   validator, BridgeUnitIndex contract
  tests/                         # NEW (no existing crate-level tests today)
    fixtures/
      jump_targets/
        single_branch.json       # 1 jump target → 1 bridge unit
        multi_branch.json        # 3 jump targets → 3 bridge units, fan-in
        looping.json             # loop-back jump target
        replay_logs/
          single_branch.replay-log.json
          multi_branch.replay-log.json
          looping.replay-log.json
    jump_target_round_trip.rs    # loader round-trip + redaction filter
crates/utsushi-core/tests/
  replay_log_jump_target.rs      # end-to-end determinism gate via
                                 #   InMemoryReferenceRecorder
```

Justification:

- `utsushi-fixture` already owns engine-neutral fixture surfaces
  (`reference_corpus`, `launch_adapters`). Jump targets are a fixture domain
  artifact, not a runtime primitive.
- The integration test lives in `utsushi-core/tests/` because it consumes
  `ReferenceRecorder` + `ReplayLog` + `RuntimeRequest` directly; that keeps
  the heavy substrate dependencies on the core crate side. The fixture crate
  stays a thin data + validation surface.
- The new tests directory in `utsushi-fixture/` is intentionally additive
  (no existing tests dir today). The crate's existing `src` modules stay
  untouched modulo additive `pub use`.

No new workspace member; no new third-party dependency.

## 3. Types

All new types live in `crates/utsushi-fixture/src/jump_targets.rs`. They are
the contract between the loader, the controlled playback driver, and the
replay-log determinism gate.

### 3.1 `JumpTargetFixture`

```rust
/// A single fixture jump target. Every target is bridge-linked.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct JumpTargetFixture {
    /// Stable target id (kebab-namespaced public string). Never a host
    /// path. Validator rejects whitespace, traversal segments, and
    /// `looks_like_local_path`.
    pub target_id: String,
    /// Bridge unit id this target resolves into. MUST exist in the
    /// `BridgeUnitIndex` passed to `validate`; otherwise the loader
    /// emits `JumpTargetMissingBridgeUnit { target_id }`.
    pub bridge_unit_id: String,
    /// Optional human-readable label for review tooling only. Public
    /// string; redaction filter applies.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    /// Logical clock tick the target activates on. Used to align the
    /// jump in the replay log. Always `> 0` (zero is the implicit
    /// "before any input" state and is reserved).
    pub activates_at_tick: LogicalClockTick,
}
```

### 3.2 `JumpTargetSet`

```rust
/// A fixture's full set of bridge-linked jump targets, plus the
/// canonical ordering for replay-log alignment.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct JumpTargetSet {
    /// Schema version pin (matches REFERENCE_TRACE_SCHEMA_VERSION
    /// posture). Loader rejects unknown versions.
    pub schema_version: String,
    /// `SourceTag::Fixture` only in this slice. The field exists so
    /// future engine-ported fixtures plug in without a schema bump.
    pub source: SourceTag,
    /// Public adapter identifier (matches the conformance manifest
    /// adapter_id used by the paired replay log).
    pub adapter_id: String,
    /// Jump targets in canonical order (sorted by
    /// `(activates_at_tick, target_id)`). Loader re-sorts on load and
    /// rejects duplicates by `target_id`.
    pub targets: Vec<JumpTargetFixture>,
}
```

### 3.3 `BridgeUnitIndex` contract

```rust
/// Resolver passed to `JumpTargetSet::validate`. The fixture crate does
/// not own bridge unit storage; callers supply an index. The integration
/// test in `utsushi-core/tests/` constructs an in-memory index from the
/// fixture's bridge unit list to keep the gate self-contained.
pub trait BridgeUnitIndex {
    fn contains(&self, bridge_unit_id: &str) -> bool;
}

/// Built-in in-memory implementation for tests + the integration gate.
pub struct InMemoryBridgeUnitIndex(BTreeSet<String>);
```

### 3.4 Diagnostic enum

```rust
#[derive(Clone, Debug, PartialEq, Eq, thiserror::Error)]
pub enum JumpTargetError {
    #[error("schema version {observed:?} not supported; expected {expected:?}")]
    UnsupportedSchemaVersion { observed: String, expected: String },
    #[error("target id {target_id:?} fails redaction filter ({reason})")]
    TargetIdLooksLikeLocalPath { target_id: String, reason: String },
    #[error("target id {target_id:?} duplicated")]
    DuplicateTargetId { target_id: String },
    #[error("target {target_id:?} references missing bridge unit {bridge_unit_id:?}")]
    JumpTargetMissingBridgeUnit { target_id: String, bridge_unit_id: String },
    #[error("activates_at_tick must be > 0 (target {target_id:?})")]
    ActivatesAtTickIsZero { target_id: String },
    #[error("replay log fingerprint mismatch (observed {observed:?}, expected {expected:?})")]
    ReplayLogFingerprintMismatch { observed: String, expected: String },
}
```

Each variant maps to a stable semantic code:

```
utsushi.fixture.jump_target.unsupported_schema_version
utsushi.fixture.jump_target.target_id_looks_like_local_path
utsushi.fixture.jump_target.duplicate_target_id
utsushi.fixture.jump_target.missing_bridge_unit
utsushi.fixture.jump_target.activates_at_tick_is_zero
utsushi.fixture.jump_target.replay_log_fingerprint_mismatch
```

Codes live in `jump_targets::codes::ALL` and the integration test asserts
every `JumpTargetError` variant's `semantic_code()` is in `ALL` (mirrors the
UTSUSHI-022/026 parity test pattern).

## 4. Loader and validator

`JumpTargetSet::load_from_json(bytes: &[u8]) -> Result<Self, JumpTargetError>`:

1. Parse via `serde_json::from_slice` with `deny_unknown_fields`.
2. Reject `schema_version` mismatches.
3. Walk every string leaf with `reject_unredacted_local_paths_in_value`.
4. Sort `targets` by `(activates_at_tick, target_id)` to normalize.

`JumpTargetSet::validate(&self, index: &dyn BridgeUnitIndex) ->
Result<(), JumpTargetError>`:

1. Each `target_id` passes `looks_like_local_path == false`.
2. No duplicate `target_id`s.
3. Each `bridge_unit_id` exists in the supplied `BridgeUnitIndex`.
4. `activates_at_tick > 0` for every target.

The validator is a pure function — no I/O, no clock, no env.

## 5. Replay-log artifact pairing

Each `*.json` jump target fixture has a paired
`replay_logs/<name>.replay-log.json` file containing the **expected**
`ReplayLog` produced by driving the fixture through controlled playback. The
artifact is the output of `ReferenceRecorder::serialize` (UTSUSHI-060) over an
`InMemoryReferenceRecorder` driven by the fixture's input plan.

The integration test (`replay_log_jump_target.rs`):

1. Loads the jump target set + an inline input plan (text-advance ticks until
   each jump target's `activates_at_tick`).
2. Drives `InMemoryReferenceRecorder` to produce a `ReferenceTrace` (using
   `ReplayLog` as the input source per UTSUSHI-021 §1 claim 1).
3. Serializes through `deterministic_json_bytes` (UTSUSHI-060).
4. Compares the bytes to the committed `*.replay-log.json` file.

Mismatch → `ReplayLogFingerprintMismatch`. This is the determinism gate
called out in the audit focus.

Bridge linkage in the replay log:

- The replay log itself does NOT carry `bridge_unit_id` on each entry
  (preserving the UTSUSHI-021 shape; no schema bump).
- Linkage is expressed by **logical-tick correspondence**: each
  `JumpTargetFixture.activates_at_tick` aligns to a specific `ReplayEntry`
  index in the paired log. The integration test asserts this alignment by
  constructing the expected pair `(activates_at_tick, replay_entry_index)`
  and matching it against the recorded log.

This keeps `ReplayLog` engine-neutral and bridge-agnostic; the bridge linkage
lives in the fixture domain.

## 6. Fixture content

### 6.1 `single_branch.json`

- 1 jump target (`target-a` → `bridge-unit-a`) activating at tick 4.
- Replay log: text-advance ticks 1..3, choice tick 4 selecting branch A.
- Demonstrates positive bridge linkage round-trip.

### 6.2 `multi_branch.json`

- 3 jump targets fanning into 3 distinct bridge units, all reachable from a
  single choice prompt at tick 5.
- Replay log: text-advance ticks 1..4, choice tick 5 selecting branch B.
- Demonstrates that the fixture supports multiple alternate jumps without
  the validator rejecting choices that lead to a not-taken target.

### 6.3 `looping.json`

- 1 jump target (`target-loop`) at tick 7 returning to a bridge unit
  already visited at tick 2.
- Replay log: text-advance through the loop body once, then choice tick 7
  triggers the back-edge.
- Demonstrates loop semantics + replay-log determinism under repeated
  bridge-unit visits.

### 6.4 Negative fixtures (in-test only)

The validation test (`jump_target_round_trip.rs`) constructs these inline
(not committed JSON):

- `jump_target_missing_bridge_unit.json` → `JumpTargetMissingBridgeUnit`.
- `jump_target_duplicate_target_id.json` → `DuplicateTargetId`.
- `jump_target_host_path_in_target_id.json` →
  `TargetIdLooksLikeLocalPath`.
- `jump_target_activates_at_zero.json` → `ActivatesAtTickIsZero`.

## 7. Test plan

Tests follow `docs/testing-standard.md`: falsifiable, behavior-named,
synthetic inline fixtures only, no live providers, no host paths.

### 7.1 Loader round-trip (`jump_target_round_trip.rs`)

- `jump_target_set_round_trips_through_serde_json()`.
- `jump_target_set_serializes_with_camel_case()`.
- `jump_target_set_rejects_unknown_fields()`.
- `jump_target_set_rejects_unknown_schema_version()`.
- `jump_target_set_normalizes_target_order_on_load()`.

### 7.2 Validator (positive)

- `jump_target_set_validates_single_branch_fixture()`.
- `jump_target_set_validates_multi_branch_fixture()`.
- `jump_target_set_validates_looping_fixture()`.

### 7.3 Validator (negative, one per code)

- `jump_target_set_rejects_target_id_with_host_path()`.
- `jump_target_set_rejects_target_id_with_whitespace()`.
- `jump_target_set_rejects_duplicate_target_id()`.
- `jump_target_set_rejects_missing_bridge_unit()`.
- `jump_target_set_rejects_activates_at_tick_zero()`.

### 7.4 Redaction filter

- `jump_target_set_passes_reject_unredacted_local_paths_filter()` — walks
  the serialized JSON of every committed fixture and asserts the
  project-wide redaction filter does not flag any leaf.

### 7.5 Replay-log determinism gate (`replay_log_jump_target.rs`)

- `single_branch_replay_log_matches_committed_artifact_byte_for_byte()`.
- `multi_branch_replay_log_matches_committed_artifact_byte_for_byte()`.
- `looping_replay_log_matches_committed_artifact_byte_for_byte()`.
- `replay_log_byte_match_holds_across_two_consecutive_runs()` — runs the
  driver twice in-process and asserts the two outputs are identical
  (catches accidental hashmap-iteration nondeterminism).
- `replay_log_mismatch_emits_fingerprint_diagnostic_with_observed_and_expected()`
  — mutates a known position in the committed artifact and asserts the
  gate emits `ReplayLogFingerprintMismatch`.

### 7.6 Bridge linkage alignment

- `jump_target_activates_at_tick_aligns_to_replay_entry_index_for_each_fixture()`
  — for each committed fixture, asserts every
  `JumpTargetFixture.activates_at_tick` maps to a specific
  `ReplayEntry` index in the paired replay log, and that the entry's input
  kind is `Choice` (the input kind that drives a jump).

### 7.7 Codes registry

- `jump_target_codes_all_registered_in_module_codes_slice()`.
- `every_jump_target_error_variant_emits_a_registered_code()`.

## 8. Verification commands

```
cargo fmt --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test -p utsushi-fixture jump_target
cargo test -p utsushi-core replay_log_jump_target
just check
```

`pnpm exec vp run ts:test` and `pnpm exec vp run ts:typecheck` are preserved
as runtime gates by `just check`; this slice does NOT change any TypeScript
surface (Itotori ingestion of fixture references is downstream of
UTSUSHI-030).

## 9. Risks

### 9.1 Replay-log determinism across serde-json versions

`ReferenceRecorder` already routes serialization through
`deterministic_json_bytes` (UTSUSHI-060) which re-walks every object as a
`BTreeMap`. Risk: a future serde change could perturb numeric formatting
(e.g. integer vs. float representation of `LogicalClockTick`). Mitigation:
the fixture model pins `activates_at_tick` as `u64`, the replay log pins all
tick fields as `u64`, and the determinism gate compares raw bytes — any
serde-side change fails the gate loudly. The mitigation cost is a
fixture-artifact refresh in the upgrade PR, which is a fair tradeoff for
catching drift.

### 9.2 Bridge unit id schema drift

Bridge unit ids are owned by the canonical bridge unit model
(ITOTORI-049 / KAIFUU-053 territory). Risk: a schema change to the
canonical id shape would force fixture artifacts to refresh. Mitigation:
the fixture validator delegates "is this a valid id" to the
`BridgeUnitIndex` resolver; the fixture artifacts hold opaque string
identifiers and don't pin a regex. A canonical schema change is a single
coordinated PR that updates the fixtures + integration test together; the
fixture crate's loader code does not change.

### 9.3 Fixture explosion

Three committed fixtures × two paired files = six committed JSON files.
Risk: per-fixture maintenance burden grows linearly with future fixtures.
Mitigation: the fixture loader treats every file as data; no per-fixture
code lives outside the integration test's parametrized loop. Adding a
fourth fixture is a JSON drop, not a code change.

### 9.4 Audit-focus checklist

| Audit focus | Structural defense |
| --- | --- |
| Jump targets unlinked from bridge units | `JumpTargetFixture.bridge_unit_id` is required (serde non-Option); validator emits `JumpTargetMissingBridgeUnit` against the `BridgeUnitIndex`; integration test 7.6 asserts every fixture aligns. |
| Replay log diverges from playback | Byte-equality determinism gate (test 7.5) runs through `deterministic_json_bytes`; `ReplayLogFingerprintMismatch` quotes both sides. |
| Fixtures committing host paths | `reject_unredacted_local_paths_in_value` walk in `load_from_json`; test 7.4 asserts every committed file passes the filter. |

## 10. Out of scope

- **Frame / audio capture fixtures.** UTSUSHI-063 (snapshot restore smoke)
  and UTSUSHI-064 (recording metadata smoke) own the capture side.
- **Engine port for controlled playback.** A real engine port producing
  bridge-linked replay logs is a follow-up sibling to UTSUSHI-103.
- **`ReplayLog` schema extension.** Bridge linkage stays in the fixture
  domain; `ReplayLog` keeps its UTSUSHI-021 shape.
- **TypeScript fixture loader.** Itotori ingestion (downstream of
  UTSUSHI-030) will consume the JSON shape; the TS mirror is additive and
  downstream of this slice.
- **Bridge unit canonical id schema.** Owned by the bridge-unit substrate;
  this slice consumes the existing string-id contract.
- **Live capture orchestration.** UTSUSHI-061 territory.

## 11. Worker scoping

**One worker.** Scope is bounded:

- One new source module in `utsushi-fixture/src/` (~200 LOC) plus loader.
- One new integration test file in `utsushi-core/tests/` (~200 LOC).
- Six committed JSON fixture files (three jump-target + three replay-log).
- Round-trip test file in `utsushi-fixture/tests/` (~250 LOC).

Estimated diff size: ~900 LOC (≈400 production + ≈500 tests + fixtures),
well inside a single-worker scope per the UTSUSHI-022 / UTSUSHI-026
precedent. No cross-crate API changes; no schema-package changes.

---

## Plan-only confirmation

This document is plan-only. No feature code, no fixture JSON, no test
files, and no loader is committed by this PR. The implementation worker
will translate this plan into code and fixtures in a follow-up branch.
