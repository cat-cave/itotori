# UTSUSHI-028 — Snapshot conformance

- **Node**: UTSUSHI-028
- **Title**: Snapshot conformance
- **Branch**: `spec/utsushi-028`
- **Worktree**: `/scratch/worktrees/itotori-spec-utsushi-028`
- **Author**: planning worker (orchestrator)
- **Date**: 2026-06-23
- **Status target**: in_progress → ready_for_review (single implementation slice)
- **Dependencies landed**: UTSUSHI-023 (snapshot primitives), UTSUSHI-026
  (conformance manifest + result schema), UTSUSHI-027 (trace + branch
  conformance), UTSUSHI-029 (capture + recording conformance).
- **Direct downstream**: UTSUSHI-030 (Itotori ingestion) consumes the
  snapshot check outputs through the same `ConformanceResult` envelope
  UTSUSHI-026 ships. Engine ports (UTSUSHI-103 sibling work) that emit
  snapshots will resolve them through this slice's `SnapshotStore` trait.

## 1. Goal restatement

Add the **snapshot side** of the runtime conformance contract: a
resolution trait (`SnapshotStore`) for the `RuntimeRequest::snapshot:
Option<SnapshotRef>` field that UTSUSHI-020 introduced as a deferred
shape, a new `EvidenceRef::StatePath { path: String }` variant on the
conformance result enum, and a `SnapshotConformanceCheck` that diffs a
baseline against an observed snapshot and quotes every drifted
`StatePath` verbatim when it fails. The slice produces only types,
validators, semantic codes, a sample fixture store, and inline
fixtures; the actual engine ports producing snapshots are out of scope
(they ship when each engine port's `Inspectable`/`Restorable`
implementation lands).

Acceptance-criterion-driven shape (mirrored from the DAG):

1. **A mutated snapshot fixture fails with state-path diagnostics.** The
   observed-side snapshot differs at one or more paths; the check's
   `run()` returns `Fail` with one `EvidenceRef::StatePath { path }`
   per drifted path, quoting `StateDiff::changed_paths()` verbatim.
2. **Snapshot conformance can run without screenshot support.** The
   check carries zero `RuntimeArtifactKind::Screenshot`, no `FrameSink`
   handle, no renderer hook. Every evidence pointer is either a
   `StatePath`, a snapshot-id reference, or a bridge unit. The
   `ProfileId::SnapshotRestore.required_subsystems()` list (already
   `&[SubsystemRequirement::SnapshotPrimitives]`) is the structural
   guarantee — this slice does NOT add `FrameSink` to that list.
3. **Snapshot report data avoids raw private asset payloads.** The
   serialized check + result envelope passes
   `reject_unredacted_local_paths_in_value` end-to-end; the snapshot
   substrate's own `Snapshot::validate` already runs the redaction walk
   at construction time (UTSUSHI-023 §3) so the check inherits the
   defense. Asset references continue to flow through `AssetId` only;
   no `bytes`-shaped or `path`-shaped leaf is permitted on the check
   surface.
4. **`SnapshotStore` trait** is the resolution layer for
   `RuntimeRequest::snapshot: Option<SnapshotRef>`. The trait has typed
   errors for missing ids, mismatched schema versions, and malformed
   refs; no silent `Ok(stale_payload)` branch exists.
5. **`EvidenceRef::StatePath { path: String }`** is an **additive**
   variant on the conformance result enum (existing variants
   unchanged) and is populated from `StateDiff::changed_paths()`.
6. **`utsushi.snapshot.state_drift`** is a new stable conformance check
   code that quotes the drifted `StatePath` verbatim in its
   `EvidenceRef`. A negative test asserts the check actually fails when
   the diff is non-empty (audit-focus: state drift reported too
   vaguely).

### Hard architectural constraints

- `SnapshotStore` has typed errors only: no `Result<Option<Snapshot>,
  _>`, no `Result<Snapshot, ()>`, no silent fallback. Variants:
  `NotFound`, `MismatchedSchemaVersion`, `InvalidSnapshotRef`,
  `InspectableIdMismatch`, `StoreUnavailable`.
- `EvidenceRef::StatePath` is **additive** — UTSUSHI-027 and
  UTSUSHI-029 explicitly reserved this variant slot (UTSUSHI-029 §2
  notes "neither slice adds an `EvidenceRef` variant in this slice").
  UTSUSHI-028 is the slice that ships the addition. Existing variants
  (`RuntimeArtifact`, `TextLine`, `FrameArtifactRef`, `ReplayLogRef`,
  `ImplMapFixture`, `BridgeUnit`) keep their wire shape and tag value.
  The schema bump is recorded in §10.
- State drift check fails when diff non-empty. A negative test
  (`snapshot_conformance_check_fails_with_state_path_evidence_when_baseline_differs_from_observed`)
  asserts this directly.
- No screenshot or renderer dependency. The check struct contains zero
  fields whose validation would touch `FrameArtifactSink`,
  `RuntimeArtifactKind::Screenshot`, or any frame ref.
- No private asset payloads on the check or result envelope. The
  redaction walk on the serialized form catches accidental leaks; the
  field shape (no `bytes`, no `path`, no `uri` outside the runtime
  artifact root) blocks them at construction time.
- Engine-neutral throughout — no XP3, no KAG, no RGSS3, no Tyrano.
- Stable codes registered in
  `conformance::snapshot_check::codes::ALL` and rolled into
  `conformance::diagnostics::codes::ALL`.

## 2. Module placement

**`utsushi-core::conformance::snapshot_check`** — sibling to
`conformance::trace_branch` (UTSUSHI-027) and
`conformance::capture_recording` (UTSUSHI-029). The submodule name
`snapshot_check` (not `snapshot_restore`) avoids confusion with the
existing `crate::snapshot::*` substrate from UTSUSHI-023; the profile
id is `ProfileId::SnapshotRestore` and the check name is
`SnapshotConformanceCheck`, which keeps the wire / API names sharp.

The `SnapshotStore` trait lives **as a sibling module under the
snapshot substrate** at `crate::snapshot::store` (not under
`conformance`), because the substrate is the natural home for a
resolver of `SnapshotRef` payloads and the trait is consumed by both
the conformance check and any engine port that participates in
controlled-playback. Justification:

- `crate::snapshot` already owns `SnapshotRef`, `SnapshotId`,
  `Snapshot`, `SnapshotError`, the `Inspectable`/`Restorable` traits,
  and the schema version pin. A resolver of `SnapshotRef → Snapshot`
  belongs here on cohesion.
- Conformance is a *downstream consumer* — the check struct in
  `conformance::snapshot_check` borrows a `&dyn SnapshotStore` rather
  than re-implementing resolution. This keeps the conformance crate
  surface minimal and avoids a cycle (no `conformance` → `snapshot` →
  `conformance` re-import).
- The trait error type reuses `SnapshotError` variants where
  appropriate (`SchemaVersionMismatch`, `InvalidSnapshotId`,
  `InspectableIdMismatch`) plus two new `SnapshotStoreError` variants
  that are store-specific (`NotFound`, `StoreUnavailable`).

Justification (mirrors the UTSUSHI-027 / UTSUSHI-029 placement
reasoning):

- `utsushi-core` already owns every type this slice needs:
  `EvidenceTier`, `EvidenceRef`, `ResultOutcome`, `ProfileId`,
  `ConformanceResult`, `Snapshot`, `SnapshotRef`, `SnapshotId`,
  `StateDiff`, `StatePath`, `StateChange`, `SnapshotError`, the
  `conformance::diagnostics::codes` registry, the redaction walk.
- Every downstream consumer (UTSUSHI-030 ingestion, plus engine port
  crates that produce snapshot conformance results) already depends on
  `utsushi-core`. A separate crate buys zero isolation.
- The slice is small (one check struct, one trait + sample in-memory
  store, one new `EvidenceRef` variant, fixtures, validators, codes).

**Submodule layout** under `crates/utsushi-core/src/conformance/` and
`crates/utsushi-core/src/snapshot/`:

```
crates/utsushi-core/src/conformance/
  mod.rs                  # existing; re-exports new symbols.
  result.rs               # ADDITIVE: new EvidenceRef::StatePath
                          #   variant + validate arm. Existing variants
                          #   stay unchanged.
  diagnostics.rs          # ADDITIVE: new ConformanceError variants for
                          #   snapshot-specific validation; new codes
                          #   re-exported into codes::ALL.
  fixtures.rs             # ADDITIVE: snapshot synthetic fixtures
                          #   referenced by §6.
  snapshot_check/         # NEW module
    mod.rs                # re-exports + module docs + unsupported
                          #   result helper.
    check.rs              # SnapshotConformanceCheck struct, validator,
                          #   run() helper → ResultOutcome. Borrows a
                          #   &dyn SnapshotStore for resolution.
    codes.rs              # snapshot_check-namespaced stable codes
                          #   wired into conformance::diagnostics::codes::ALL.

crates/utsushi-core/src/snapshot/
  mod.rs                  # existing; re-exports new SnapshotStore +
                          #   InMemorySnapshotStore + SnapshotStoreError.
  store.rs                # NEW. SnapshotStore trait,
                          #   SnapshotStoreError enum,
                          #   InMemorySnapshotStore (stateful fixture
                          #   store).
```

`utsushi-core/src/lib.rs` re-exports the public surface (additive):

```rust
pub use conformance::snapshot_check::{
    SnapshotConformanceCheck, unsupported_snapshot_restore_result,
};
pub use snapshot::{
    InMemorySnapshotStore, SnapshotStore, SnapshotStoreError,
};
```

`RuntimeRequest::snapshot` keeps its existing
`Option<SnapshotRef>` shape — this slice does NOT alter the
`RuntimeRequest` struct. The doc comment is rewritten to point at the
new `SnapshotStore` trait as the documented resolution layer (replacing
the "deferred to UTSUSHI-028" note that currently sits there).

No new workspace member; no new third-party dependency.

## 3. `SnapshotStore` trait

### 3.1 Trait shape

```rust
/// Resolution layer for `RuntimeRequest::snapshot: Option<SnapshotRef>`.
///
/// The store is the single substrate seam at which a `SnapshotRef`
/// (lightweight, id-only) becomes a fully validated `Snapshot`. The
/// audit-focus item the trait defends against is "silent stale or empty
/// payload" — every error is typed, the trait has no `Result<Option<_>,
/// _>` shape, and there is no documented best-effort branch.
///
/// `Send + Sync` because the runner shares the store across threads
/// (the synthetic in-memory implementation uses an `Arc<Mutex<_>>`
/// internally; engine-port implementations may use a different sync
/// primitive but must remain `Send + Sync`).
pub trait SnapshotStore: Send + Sync + std::fmt::Debug {
    /// Resolve a snapshot ref to a fully validated snapshot.
    ///
    /// Contract:
    /// - Returns `Ok(snapshot)` only after `snapshot.validate()`
    ///   succeeds AND `snapshot.snapshot_id() == reference.snapshot_id`
    ///   AND `snapshot.inspectable_id() == reference.inspectable_id`
    ///   AND `snapshot.schema_version().as_str() ==
    ///        SNAPSHOT_SCHEMA_VERSION`.
    /// - Returns `Err(SnapshotStoreError::NotFound { snapshot_id })`
    ///   when no snapshot matches the requested id (NEVER a stale
    ///   payload, NEVER an empty `Snapshot`).
    /// - Returns `Err(SnapshotStoreError::MismatchedSchemaVersion { ... })`
    ///   when a stored payload exists but its `schema_version` does
    ///   not match the pin.
    /// - Returns `Err(SnapshotStoreError::InvalidSnapshotRef { ... })`
    ///   when `reference.validate()` fails.
    /// - Returns `Err(SnapshotStoreError::InspectableIdMismatch { ... })`
    ///   when a stored payload exists at the id but its inspectable id
    ///   diverges from the ref.
    /// - Returns `Err(SnapshotStoreError::StoreUnavailable { ... })`
    ///   on backing-store failures (I/O, lock poison, etc.); never
    ///   silently returns success.
    fn resolve(
        &self,
        reference: &SnapshotRef,
    ) -> Result<Snapshot, SnapshotStoreError>;
}
```

### 3.2 `SnapshotStoreError`

```rust
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum SnapshotStoreError {
    /// No snapshot matches the requested id. The ref is well-formed;
    /// the store simply does not hold it.
    NotFound { snapshot_id: SnapshotId },

    /// A stored payload exists at the id but its schema version does
    /// not match the substrate pin. Wraps the underlying
    /// `SnapshotError::SchemaVersionMismatch`.
    MismatchedSchemaVersion {
        snapshot_id: SnapshotId,
        observed: String,
        expected: &'static str,
    },

    /// `SnapshotRef::validate` rejected the input ref. Wraps the
    /// underlying `SnapshotError` for the reviewer to inspect.
    InvalidSnapshotRef { reason: SnapshotError },

    /// A stored payload exists at the requested id but its
    /// `inspectable_id` does not match the ref's `inspectable_id`. The
    /// ref pointed at the right id but the wrong port.
    InspectableIdMismatch {
        snapshot_id: SnapshotId,
        expected: String,
        found: String,
    },

    /// Backing store unavailable (lock poison, I/O failure, etc.).
    /// Carries a short, public-string description; never a host path.
    StoreUnavailable { reason: String },
}
```

Each variant maps to a stable code (§7):

| Variant                     | Code                                                 |
| --------------------------- | ---------------------------------------------------- |
| `NotFound`                  | `utsushi.snapshot.store_not_found`                   |
| `MismatchedSchemaVersion`   | `utsushi.snapshot.store_mismatched_schema_version`   |
| `InvalidSnapshotRef`        | `utsushi.snapshot.store_invalid_snapshot_ref`        |
| `InspectableIdMismatch`     | `utsushi.snapshot.store_inspectable_id_mismatch`     |
| `StoreUnavailable`          | `utsushi.snapshot.store_unavailable`                 |

`SnapshotStoreError` implements `std::error::Error`, `Display` (uses
the semantic code as prefix), and exposes `semantic_code(&self) ->
&'static str` mirroring the `SnapshotError` pattern from UTSUSHI-023.

### 3.3 `InMemorySnapshotStore` — sample fixture store

```rust
/// Stateful in-memory snapshot store backing the synthetic fixtures
/// and integration tests. Stores `Snapshot`s keyed by `SnapshotId`;
/// resolution is `O(1)`. Internally an `Arc<Mutex<BTreeMap<SnapshotId,
/// Snapshot>>>` so the store is `Send + Sync` and cheap to clone.
#[derive(Clone, Debug, Default)]
pub struct InMemorySnapshotStore {
    inner: Arc<Mutex<BTreeMap<SnapshotId, Snapshot>>>,
}

impl InMemorySnapshotStore {
    /// Construct an empty store.
    pub fn new() -> Self {
        Self::default()
    }

    /// Insert a snapshot, returning the previously stored snapshot at
    /// the same id if any (so callers can detect overwrites). Validates
    /// the snapshot end-to-end before insertion; rejects payloads that
    /// would otherwise round-trip as `MismatchedSchemaVersion`.
    pub fn insert(
        &self,
        snapshot: Snapshot,
    ) -> Result<Option<Snapshot>, SnapshotStoreError> { ... }

    /// Number of snapshots currently stored.
    pub fn len(&self) -> usize { ... }

    pub fn is_empty(&self) -> bool { ... }
}

impl SnapshotStore for InMemorySnapshotStore { ... }
```

Engine-port implementations (out of scope) replace
`InMemorySnapshotStore` with a backing store that reads from an
artifact bundle or a controlled-playback session log. Both
implementations share the trait contract and the `SnapshotStoreError`
shape.

## 4. `EvidenceRef::StatePath { path: String }` (additive)

The variant is appended to the existing `EvidenceRef` enum in
`conformance/result.rs`. Wire shape (the `EvidenceRef` enum uses
`#[serde(tag = "artifactKind", rename_all = "camelCase")]`):

```json
{ "artifactKind": "statePath", "path": "port.frame" }
```

> Note on tag value: the brief specifies `{ kind: "state_path", path:
> "..." }` (snake_case `kind`). The existing `EvidenceRef` enum uses
> `artifactKind` as the tag name and `camelCase` for variant tags
> (e.g. `"runtimeArtifact"`, `"frameArtifactRef"`). This slice
> **conforms to the existing enum's serde shape** — `artifactKind:
> "statePath"` — because changing the tag name or per-variant casing
> rule for one variant breaks the wire format for the other five
> variants. The brief's snake_case shape is reflected in the **semantic
> code** (`utsushi.snapshot.state_drift`) and in the conformance check
> code names (`SNAPSHOT_STATE_DRIFT`); the field name `path` is
> retained verbatim. The schema-version bump in §10 documents the
> additive change.

Variant Rust shape (added at the end of the existing enum, after
`BridgeUnit`):

```rust
/// Reference to a `StatePath` quoted verbatim from a snapshot diff.
/// The path string is the canonical wire form returned by
/// `StatePath::as_str` (already lowercase ASCII with `.` segment
/// separators; UTSUSHI-023 enforces this at parse time).
#[serde(rename = "statePath", rename_all = "camelCase")]
StatePath { path: String },
```

`EvidenceRef::validate` arm:

```rust
Self::StatePath { path } => {
    if path.is_empty() {
        return Err(ConformanceError::EvidenceRefInvalid {
            artifact_kind: "state_path",
            reason: "path is empty".to_string(),
        });
    }
    // Reuse the existing UTSUSHI-023 parser so the conformance
    // layer cannot accept any string that the substrate would have
    // rejected. The parser already enforces the namespace allow
    // list, the segment shape, and the byte ceiling.
    StatePath::parse(path).map_err(|err| {
        ConformanceError::EvidenceRefInvalid {
            artifact_kind: "state_path",
            reason: err.to_string(),
        }
    })?;
    // Defense in depth: also block local-path-shaped inputs even
    // though the parser already rejects them, because the
    // EvidenceRef::validate contract is the single seam the
    // conformance layer trusts.
    if looks_like_local_path(path) {
        return Err(ConformanceError::EvidenceRefInvalid {
            artifact_kind: "state_path",
            reason: "path looks like a local path".to_string(),
        });
    }
    Ok(())
}
```

The schema-version pin (`CONFORMANCE_SCHEMA_VERSION`) increments per
§10.

## 5. `SnapshotConformanceCheck`

### 5.1 Check shape

```rust
/// Snapshot-restore conformance check. Resolves a baseline and an
/// observed snapshot through a `SnapshotStore`, computes a path-keyed
/// `StateDiff`, and projects the result into a `ResultOutcome`.
///
/// Construction does NOT resolve or validate; the check carries refs
/// only. Call `run(&dyn SnapshotStore)` to resolve, diff, and produce
/// the outcome.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotConformanceCheck {
    /// Always `ProfileId::SnapshotRestore` (validated by `validate`).
    pub profile: ProfileId,

    /// Lightweight reference to the baseline snapshot. Resolved
    /// through the `SnapshotStore` at `run` time.
    pub baseline: SnapshotRef,

    /// Lightweight reference to the observed snapshot. Resolved
    /// through the `SnapshotStore` at `run` time.
    pub observed: SnapshotRef,

    /// Evidence tier the runner expects on a `Pass`. MUST satisfy
    /// `expected_tier <= ProfileId::SnapshotRestore.evidence_tier_ceiling()`
    /// (E1 per UTSUSHI-026). The actual tier emitted on a Pass is the
    /// `min(expected_tier, baseline.evidence_tier,
    /// observed.evidence_tier)` so the runner cannot dress up a low-
    /// tier snapshot pair as a high-tier pass.
    pub expected_tier: EvidenceTier,
}
```

The check struct does **not** carry the full snapshots; the runner
constructs the check, passes the store, and the check's `run` resolves
both refs at the point of execution. This keeps the JSON shape narrow
(two `SnapshotRef`s are id-only) and the redaction surface trivial.

### 5.2 Validation rules

`SnapshotConformanceCheck::validate(&self) -> Result<(),
ConformanceError>`:

1. `self.profile == ProfileId::SnapshotRestore`. Failure:
   `ConformanceError::SnapshotCheckProfileMismatch { observed,
   expected }`, code
   `utsushi.conformance.snapshot_check_profile_mismatch`.
2. `self.baseline.validate()` succeeds (delegates to
   `SnapshotRef::validate` from UTSUSHI-023). Failure: wrap as
   `ConformanceError::SnapshotRefInvalid { side: "baseline", reason:
   err.to_string() }`, code
   `utsushi.conformance.snapshot_ref_invalid`.
3. `self.observed.validate()` succeeds. Failure: same code, `side:
   "observed"`.
4. `self.baseline.inspectable_id == self.observed.inspectable_id`.
   Failure:
   `ConformanceError::SnapshotInspectableIdMismatch { baseline,
   observed }`, code
   `utsushi.conformance.snapshot_inspectable_id_mismatch`. Diffing
   snapshots from different inspectable surfaces is meaningless;
   `StateDiff` itself rejects this at runtime, but the check rejects
   it at validate time so the negative diagnostic is sharp.
5. `self.expected_tier <=
   ProfileId::SnapshotRestore.evidence_tier_ceiling()` (E1). Failure:
   `ConformanceError::SnapshotEvidenceTierOverclaim { observed,
   ceiling }`, code
   `utsushi.conformance.snapshot_evidence_tier_overclaim`.

### 5.3 `run()` helper

```rust
impl SnapshotConformanceCheck {
    pub fn run(&self, store: &dyn SnapshotStore) -> ResultOutcome {
        // 1. Validate the check itself; surface as Fail with the
        //    matching semantic code.
        if let Err(err) = self.validate() {
            return ResultOutcome::Fail {
                semantic_code: err.semantic_code().to_string(),
                detail: err.to_string(),
            };
        }
        // 2. Resolve both refs through the store. A store error is a
        //    Fail with the store error's semantic code (never a Pass).
        let baseline = match store.resolve(&self.baseline) {
            Ok(snapshot) => snapshot,
            Err(err) => return self.store_error_to_fail("baseline", err),
        };
        let observed = match store.resolve(&self.observed) {
            Ok(snapshot) => snapshot,
            Err(err) => return self.store_error_to_fail("observed", err),
        };
        // 3. Compute the diff. A substrate error (e.g. inspectable id
        //    mismatch slipped past validate, schema version mismatch)
        //    is a Fail with the substrate's semantic code.
        let diff = match diff_snapshots(&baseline, &observed) {
            Ok(diff) => diff,
            Err(err) => return ResultOutcome::Fail {
                semantic_code: err.semantic_code().to_string(),
                detail: err.to_string(),
            },
        };
        // 4. Empty diff → Pass at the lower of the three tiers.
        if diff.is_empty() {
            return ResultOutcome::Pass {
                evidence_tier: self.tier_floor(&baseline, &observed),
            };
        }
        // 5. Non-empty diff → Fail with state_drift code. The runner
        //    pulls EvidenceRef::StatePath entries off the diff via
        //    `state_path_evidence_from_diff(&diff)`; the check struct
        //    itself surfaces only the semantic code and a short
        //    detail string naming the count of drifted paths.
        ResultOutcome::Fail {
            semantic_code: codes::SNAPSHOT_STATE_DRIFT.to_string(),
            detail: format!(
                "snapshot drift: {} path(s) differ",
                diff.changes.len()
            ),
        }
    }

    /// Map every `StateDiff::changed_paths()` entry to an
    /// `EvidenceRef::StatePath`. Called by the runner after `run`
    /// returns `Fail` with the `state_drift` code; the runner uses
    /// these to populate the `ConformanceResult::evidence` vec.
    pub fn state_path_evidence_from_diff(
        diff: &StateDiff,
    ) -> Vec<EvidenceRef> {
        diff.changed_paths()
            .map(|path| EvidenceRef::StatePath {
                path: path.as_str().to_string(),
            })
            .collect()
    }

    fn tier_floor(&self, baseline: &Snapshot, observed: &Snapshot) -> EvidenceTier {
        self.expected_tier
            .min(baseline.evidence_tier())
            .min(observed.evidence_tier())
    }

    fn store_error_to_fail(&self, side: &'static str, err: SnapshotStoreError) -> ResultOutcome {
        ResultOutcome::Fail {
            semantic_code: err.semantic_code().to_string(),
            detail: format!("{side}: {err}"),
        }
    }
}
```

The runner is responsible for wrapping the `ResultOutcome` into a
`ConformanceResult` envelope and populating
`ConformanceResult::evidence`:

- On `Pass`: the runner inserts a single
  `EvidenceRef::StatePath { path: <one canonical path the runner
  considers load-bearing for the slice> }` so the
  `pass_without_evidence` validator from UTSUSHI-026 accepts the
  payload. The check struct exposes
  `pass_evidence_for(&Snapshot) -> EvidenceRef` returning the
  baseline's first sorted path; the runner can substitute its own.
- On `Fail` with `state_drift`: the runner calls
  `SnapshotConformanceCheck::state_path_evidence_from_diff(&diff)`
  and populates the evidence vec from the result. The diff's
  `changed_paths()` iterator is sorted (the diff validates the sort
  per UTSUSHI-023 §diff.rs); the resulting evidence vec inherits the
  sort. This is the audit-focus defense for "state drift reported
  too vaguely": every drifted path is quoted verbatim, no
  summarization, no truncation.

### 5.4 Unsupported handling

The runner translates manifest state into result-outcome shape before
calling the check:

1. **Adapter manifest declares `SnapshotRestore` but the store
   returns `NotFound` for either ref**: the runner constructs the
   check normally; `run` returns `Fail { semantic_code:
   "utsushi.snapshot.store_not_found", detail }`. This is the
   "never silently returning a stale or empty payload" defense.
2. **Adapter manifest does NOT declare `SnapshotRestore`**: the
   runner does NOT call the check. Instead, it emits
   `ResultOutcome::Unsupported { semantic_code:
   "utsushi.conformance.snapshot_restore_unsupported",
   declared_in_manifest: false }`. The helper
   `unsupported_snapshot_restore_result()` mirrors the
   `unsupported_frame_capture_result()` pattern from UTSUSHI-029 §
   mod.rs.
3. **Adapter declares `SnapshotRestore` as `Unsupported` capability
   through the substrate**: the UTSUSHI-026 manifest validator
   already rejects this combination at registration time
   (`MissingSubsystem` when `SubsystemRequirement::SnapshotPrimitives`
   is absent). UTSUSHI-028 does not re-check it.

### 5.5 Why no renderer / screenshot surface

The check struct contains exactly four fields: a `ProfileId`, two
`SnapshotRef`s, and an `EvidenceTier`. None of these touch
`FrameArtifactSink`, `RuntimeArtifactKind::Screenshot`,
`RuntimeArtifactKind::FrameCapture`, or any renderer-coupled API. The
`ProfileId::SnapshotRestore.required_subsystems()` list already pins
this structurally — `&[SubsystemRequirement::SnapshotPrimitives]`
contains no frame or screenshot subsystem, and a fixture test in §8.3
asserts the equality holds. The redaction walk applies to the
serialized snapshot only; no image bytes ever enter the surface.

## 6. Fixtures

All check / store fixtures live in
`utsushi-core::conformance::fixtures` (additive) and snapshot store
fixtures (the sample `InMemorySnapshotStore` instances) live in the
same module. The fixtures are exposed unconditionally for in-crate use,
matching the UTSUSHI-026 / UTSUSHI-029 fixtures posture.

### 6.1 Positive — identical snapshots → Pass

`synthetic_snapshot_check_identical_baseline_and_observed()`:

- Builds an `InMemorySnapshotStore`, inserts two snapshots constructed
  from the same `Inspectable` fixture (the `DummyInspect` shape from
  UTSUSHI-023 §snapshot tests) under different ids
  (`snap-baseline-001`, `snap-observed-001`) but identical state trees.
- Returns a `SnapshotConformanceCheck` with:
  - `profile: ProfileId::SnapshotRestore`,
  - `baseline: SnapshotRef { snapshot_id: "snap-baseline-001",
    inspectable_id: "utsushi-fixture", evidence_tier: E1 }`,
  - `observed: SnapshotRef { snapshot_id: "snap-observed-001", ... }`,
  - `expected_tier: E1`.
- `run(&store)` returns `ResultOutcome::Pass { evidence_tier: E1 }`.

### 6.2 Mutated — one path differs → Fail with state-path EvidenceRef

`synthetic_snapshot_check_observed_drifts_at_port_frame()`:

- Same shape as 6.1 but the observed snapshot has `port.frame`
  changed from `Uint { value: 1 }` to `Uint { value: 99 }`.
- `run(&store)` returns `ResultOutcome::Fail { semantic_code:
  "utsushi.snapshot.state_drift", detail: "snapshot drift: 1 path(s)
  differ" }`.
- `SnapshotConformanceCheck::state_path_evidence_from_diff(&diff)`
  returns `vec![EvidenceRef::StatePath { path: "port.frame"
  .to_string() }]`. The runner builds the
  `ConformanceResult::evidence` vec from this; the result envelope
  validates clean.
- **This is the audit-focus negative case** — the test
  `snapshot_conformance_check_fails_with_state_path_evidence_when_baseline_differs_from_observed`
  asserts the `Fail` outcome AND the verbatim-path evidence AND the
  drift code.

### 6.3 Mutated — multiple paths differ → Fail with sorted evidence

`synthetic_snapshot_check_observed_drifts_at_two_paths()`:

- Observed snapshot differs at `port.frame` AND `port.last`.
- `state_path_evidence_from_diff(&diff)` returns a `Vec` of length 2
  sorted ascending (`port.frame` before `port.last`), matching
  `diff.changed_paths()` ordering. Test asserts the sort.

### 6.4 Missing baseline → `SnapshotStoreError::NotFound` → typed Fail

`synthetic_snapshot_check_baseline_missing_from_store()`:

- The store contains only the observed snapshot. The check's `baseline`
  ref points at `snap-baseline-001`, which is not in the store.
- `run(&store)` returns `ResultOutcome::Fail { semantic_code:
  "utsushi.snapshot.store_not_found", detail: "baseline: ..." }`.

### 6.5 Mismatched schema version → typed Fail

`synthetic_snapshot_check_observed_has_mismatched_schema_version()`:

- Constructed by inserting a snapshot whose `schema_version` was
  smuggled past `Snapshot::validate` (using the same `Raw` JSON
  round-trip trick as `restore_snapshot_with_old_schema_version_*` in
  UTSUSHI-023 tests). The store rejects it on `insert()`, so the
  fixture instead exposes a small in-test `SnapshotStore`
  implementation `StaleSchemaStore` that returns
  `Err(SnapshotStoreError::MismatchedSchemaVersion { ... })` on the
  observed-side resolve. The fixture returns the check struct + the
  stale store.
- `run(&stale_store)` returns `ResultOutcome::Fail { semantic_code:
  "utsushi.snapshot.store_mismatched_schema_version", ... }`.

### 6.6 Inspectable id mismatch on ref → reject at validate

`synthetic_snapshot_check_with_mismatched_inspectable_ids()`:

- `baseline.inspectable_id = "port-a"`, `observed.inspectable_id =
  "port-b"`.
- `validate()` returns
  `Err(ConformanceError::SnapshotInspectableIdMismatch { ... })`,
  code `utsushi.conformance.snapshot_inspectable_id_mismatch`. The
  check never reaches the store.

### 6.7 Profile mismatch → reject at validate

`synthetic_snapshot_check_with_wrong_profile()`:

- `profile = ProfileId::TextTrace`.
- `validate()` returns
  `Err(ConformanceError::SnapshotCheckProfileMismatch { ... })`, code
  `utsushi.conformance.snapshot_check_profile_mismatch`.

### 6.8 Unsupported outcome helper

`synthetic_snapshot_restore_unsupported_result()`:

- Returns a `ConformanceResult` envelope (not a check struct) with
  `ResultOutcome::Unsupported { semantic_code:
  "utsushi.conformance.snapshot_restore_unsupported",
  declared_in_manifest: false }`.
- The companion manifest does NOT declare `SnapshotRestore`; the
  cross-validation against the manifest succeeds.

### 6.9 Cross-validation fixture

`synthetic_snapshot_paired_manifest_and_results()`:

- Manifest declares `SnapshotRestore` at E1.
- Results array: one `SnapshotRestore` Pass result.
- `cross_validate_results_against_manifest` returns `Ok(())`.
- A negative twin swaps the Pass tier to E2, expects the
  cross-checker to reject with `PassAboveManifestCeiling` (the
  UTSUSHI-026 code).

### 6.10 Sample in-memory store

The fixtures module also exposes
`synthetic_in_memory_snapshot_store()` returning a populated
`InMemorySnapshotStore` for use by external test suites that want to
reuse the same baseline / observed shape.

## 7. Semantic codes

All stable codes for this slice live in
`utsushi-core::conformance::snapshot_check::codes` and (for the
store-side codes) in
`utsushi-core::snapshot::diagnostics::codes`. The brief asks for 5-7
new `utsushi.conformance.snapshot_*` codes; this slice ships **7**
conformance-side codes plus **5** snapshot-store codes plus
`utsushi.snapshot.state_drift` (the state-drift code is registered
under the `utsushi.snapshot.*` namespace because the *evidence* is a
state-drift report from the substrate, even though the *outcome* is a
conformance Fail).

### 7.1 New `utsushi.conformance.snapshot_*` codes (7)

```rust
pub mod codes {
    pub const SNAPSHOT_RESTORE_UNSUPPORTED: &str =
        "utsushi.conformance.snapshot_restore_unsupported";
    pub const SNAPSHOT_CHECK_PROFILE_MISMATCH: &str =
        "utsushi.conformance.snapshot_check_profile_mismatch";
    pub const SNAPSHOT_REF_INVALID: &str =
        "utsushi.conformance.snapshot_ref_invalid";
    pub const SNAPSHOT_INSPECTABLE_ID_MISMATCH: &str =
        "utsushi.conformance.snapshot_inspectable_id_mismatch";
    pub const SNAPSHOT_EVIDENCE_TIER_OVERCLAIM: &str =
        "utsushi.conformance.snapshot_evidence_tier_overclaim";
    pub const SNAPSHOT_DIFF_INSPECTABLE_ID_MISMATCH: &str =
        "utsushi.conformance.snapshot_diff_inspectable_id_mismatch";
    pub const SNAPSHOT_RESOLUTION_FAILED: &str =
        "utsushi.conformance.snapshot_resolution_failed";

    pub const ALL: &[&str] = &[
        SNAPSHOT_RESTORE_UNSUPPORTED,
        SNAPSHOT_CHECK_PROFILE_MISMATCH,
        SNAPSHOT_REF_INVALID,
        SNAPSHOT_INSPECTABLE_ID_MISMATCH,
        SNAPSHOT_EVIDENCE_TIER_OVERCLAIM,
        SNAPSHOT_DIFF_INSPECTABLE_ID_MISMATCH,
        SNAPSHOT_RESOLUTION_FAILED,
    ];
}
```

Rolled into `conformance::diagnostics::codes::ALL` via re-export
(mirroring the UTSUSHI-029 capture_recording pattern).

### 7.2 New `utsushi.snapshot.*` codes (6 total: 5 store + 1 drift)

Appended to `crate::snapshot::diagnostics::codes` and to its `ALL`
slice (additive enum + slice entries; existing 20 codes stay
unchanged):

```rust
pub const STORE_NOT_FOUND: &str = "utsushi.snapshot.store_not_found";
pub const STORE_MISMATCHED_SCHEMA_VERSION: &str =
    "utsushi.snapshot.store_mismatched_schema_version";
pub const STORE_INVALID_SNAPSHOT_REF: &str =
    "utsushi.snapshot.store_invalid_snapshot_ref";
pub const STORE_INSPECTABLE_ID_MISMATCH: &str =
    "utsushi.snapshot.store_inspectable_id_mismatch";
pub const STORE_UNAVAILABLE: &str =
    "utsushi.snapshot.store_unavailable";
pub const STATE_DRIFT: &str = "utsushi.snapshot.state_drift";
```

`STATE_DRIFT` is the audit-focus headline code (acceptance criterion
6).

Each `SnapshotStoreError` variant maps onto its corresponding code via
`fn semantic_code(&self) -> &'static str` on the error type; the
mapping table is in §3.2.

The parity test in §8.5 asserts every variant maps into `ALL` and that
every code in `ALL` is also in `conformance::diagnostics::codes::ALL`
when relevant.

## 8. Test plan

Tests follow `docs/testing-standard.md`: falsifiable, behavior-named,
synthetic inline fixtures only, no live providers, no host paths.

### 8.1 `SnapshotStore` round-trip (`snapshot/store.rs::tests`)

Round-trip and resolution:

- `in_memory_snapshot_store_round_trips_a_validated_snapshot()`.
- `in_memory_snapshot_store_resolve_returns_byte_equal_snapshot_to_inserted()`.
- `in_memory_snapshot_store_insert_rejects_snapshot_with_mismatched_schema_version()`.
- `in_memory_snapshot_store_insert_returns_previous_payload_on_overwrite()`.

Typed errors:

- `in_memory_snapshot_store_resolve_returns_not_found_when_id_absent()`
  — asserts the typed `NotFound` variant, NOT `None`, NOT an empty
  `Snapshot`.
- `in_memory_snapshot_store_resolve_returns_invalid_snapshot_ref_when_ref_malformed()`.
- `in_memory_snapshot_store_resolve_returns_inspectable_id_mismatch_when_ref_targets_wrong_port()`.
- `in_memory_snapshot_store_resolve_returns_store_unavailable_on_lock_poison()` —
  exercised by deliberately poisoning the internal mutex.
- `snapshot_store_error_semantic_code_maps_every_variant_into_codes_all()` —
  parity test like UTSUSHI-023's
  `every_snapshot_error_variant_returns_a_code_in_codes_all`.

Send + Sync assertion:

- `in_memory_snapshot_store_is_send_and_sync()` (compile-time bound
  via `fn assert_send_sync<T: Send + Sync>()`).

### 8.2 `EvidenceRef::StatePath` serde + validate (`conformance/result.rs::tests`)

- `evidence_ref_state_path_round_trips_through_serde_json()`.
- `evidence_ref_state_path_serializes_as_artifact_kind_camel_case_state_path()` —
  asserts the wire tag is `"statePath"`.
- `evidence_ref_state_path_validate_accepts_canonical_path()`.
- `evidence_ref_state_path_validate_rejects_empty_path()`.
- `evidence_ref_state_path_validate_rejects_path_with_whitespace()`.
- `evidence_ref_state_path_validate_rejects_path_that_looks_like_local_path()`.
- `evidence_ref_state_path_validate_rejects_path_with_unknown_namespace()`.
- `evidence_ref_state_path_validate_rejects_path_with_uppercase_segment()`.
- `every_existing_evidence_ref_variant_still_round_trips_through_serde()` —
  belt-and-suspenders: confirm the additive variant did not perturb
  the existing five variants' wire shape.

### 8.3 `SnapshotConformanceCheck` (`conformance/snapshot_check/check.rs::tests`)

Round-trip and serde:

- `snapshot_conformance_check_round_trips_through_serde_json()`.
- `snapshot_conformance_check_serializes_with_camel_case()`.

Profile + subsystem:

- `snapshot_restore_profile_required_subsystems_does_not_include_frame_sink_or_artifact_store()` —
  audit-focus: snapshot conformance does not depend on screenshot
  support.
- `snapshot_restore_profile_evidence_tier_ceiling_is_e1()`.

Positive validation + run:

- `snapshot_conformance_check_validates_well_formed_baseline_and_observed_refs()`.
- `snapshot_conformance_check_runs_pass_on_identical_baseline_and_observed()` —
  identical snapshots return
  `ResultOutcome::Pass { evidence_tier: E1 }`.
- `snapshot_conformance_check_pass_tier_clamps_to_minimum_of_three_tier_sources()` —
  asserts the `expected_tier.min(baseline.tier).min(observed.tier)`
  clamp.

Negative validation (one per code):

- `snapshot_conformance_check_rejects_wrong_profile()`.
- `snapshot_conformance_check_rejects_malformed_baseline_ref()`.
- `snapshot_conformance_check_rejects_malformed_observed_ref()`.
- `snapshot_conformance_check_rejects_mismatched_baseline_and_observed_inspectable_ids()`.
- `snapshot_conformance_check_rejects_expected_tier_above_profile_ceiling()`.

State-drift behavior (the audit-focus negative case):

- `snapshot_conformance_check_fails_with_state_path_evidence_when_baseline_differs_from_observed()` —
  the headline negative-case test required by the DAG. Asserts:
  - outcome is `Fail`,
  - `semantic_code == "utsushi.snapshot.state_drift"`,
  - `state_path_evidence_from_diff` returns
    `vec![EvidenceRef::StatePath { path: "port.frame".to_string() }]`,
  - the `path` field is the verbatim `StateDiff::changed_paths()`
    string with no truncation.
- `snapshot_conformance_check_fails_with_one_state_path_per_drifted_path_for_two_path_drift()` —
  asserts two `EvidenceRef::StatePath` entries, sorted ascending,
  one per drifted path.
- `snapshot_conformance_check_fails_when_state_diff_is_non_empty()` —
  the broader negative invariant: any non-empty diff → Fail. Quantifies
  the "state drift check actually fails when diff non-empty" hard
  constraint.

Store-side failure → Fail (never silent success):

- `snapshot_conformance_check_run_returns_fail_with_store_not_found_when_baseline_missing()`.
- `snapshot_conformance_check_run_returns_fail_with_store_mismatched_schema_version_for_stale_observed()`.
- `snapshot_conformance_check_run_returns_fail_with_store_inspectable_id_mismatch_for_wrong_port_resolve()`.
- `snapshot_conformance_check_run_never_returns_pass_when_store_resolution_fails()` —
  property-style test (10 random store failure injections via a
  `MockStore`) confirming `Pass` is structurally impossible on store
  failure.

Redaction:

- `snapshot_conformance_check_serialized_form_passes_reject_unredacted_local_paths()` —
  serializes a check + populates evidence via
  `state_path_evidence_from_diff`, asserts the JSON passes the
  project-wide redaction walk. Audit-focus: snapshot fixtures contain
  no host paths.
- `snapshot_conformance_check_evidence_vec_contains_no_runtime_artifact_or_screenshot_kind()` —
  iterates the fixture-built result envelope's `evidence` field and
  asserts no entry is `RuntimeArtifact { kind: Screenshot, .. }` or
  `FrameArtifactRef { .. }`.

### 8.4 Codes registry (`conformance/snapshot_check/codes.rs::tests`)

- `snapshot_check_codes_all_registered_in_conformance_diagnostics()`.
- `snapshot_check_codes_are_kebab_namespaced_under_utsushi_conformance()`.
- `snapshot_check_codes_all_unique()`.
- `snapshot_check_codes_all_has_seven_entries()` —
  pins the count (matches the brief's "5-7 new codes" upper bound).

### 8.5 Snapshot-store codes (`snapshot/diagnostics.rs::tests`, additive)

- `every_snapshot_store_error_variant_returns_a_code_in_codes_all()` —
  parity test like UTSUSHI-023's existing
  `every_snapshot_error_variant_returns_a_code_in_codes_all`,
  extended to also cover `SnapshotStoreError`.
- `snapshot_store_state_drift_code_namespaced_under_utsushi_snapshot()`.
- `snapshot_store_codes_added_to_codes_all_in_documented_order()`.

### 8.6 Fixtures (`conformance/fixtures.rs::tests`, additive)

- `synthetic_snapshot_check_identical_baseline_and_observed_validates()`.
- `synthetic_snapshot_check_identical_baseline_and_observed_runs_pass()`.
- `synthetic_snapshot_check_observed_drifts_at_port_frame_runs_fail_with_state_drift()`.
- `synthetic_snapshot_check_observed_drifts_at_port_frame_evidence_quotes_path_verbatim()`.
- `synthetic_snapshot_check_observed_drifts_at_two_paths_evidence_is_sorted()`.
- `synthetic_snapshot_check_baseline_missing_from_store_runs_fail_with_not_found()`.
- `synthetic_snapshot_check_observed_has_mismatched_schema_version_runs_fail_with_typed_code()`.
- `synthetic_snapshot_check_with_mismatched_inspectable_ids_fails_validation()`.
- `synthetic_snapshot_check_with_wrong_profile_fails_validation()`.
- `synthetic_snapshot_restore_unsupported_result_cross_validates_against_undeclared_manifest()`.
- `synthetic_snapshot_paired_manifest_and_results_cross_validates()`.
- `synthetic_snapshot_paired_negative_rejects_tier_above_manifest_ceiling()`.
- `synthetic_in_memory_snapshot_store_returns_inserted_snapshots_for_known_ids()`.

### 8.7 Integration tests

`crates/utsushi-core/tests/conformance_snapshot.rs` (new):

- `snapshot_conformance_check_run_through_synthetic_runner_emits_one_pass_per_profile()`.
- `snapshot_conformance_unsupported_path_does_not_invoke_check_struct()`.
- `snapshot_conformance_result_envelope_carries_state_path_evidence_in_serialized_output()` —
  asserts the audit-focus "state drift reported too vaguely" item is
  structurally impossible (the wire JSON contains
  `"artifactKind": "statePath"` and the verbatim path string
  literally).
- `snapshot_conformance_result_envelope_passes_reject_unredacted_local_paths_filter()`.
- `snapshot_conformance_check_negative_case_against_mutated_fixture_emits_state_path_evidence()` —
  the integration-level negative case: builds a populated
  `InMemorySnapshotStore`, mutates the observed snapshot, runs the
  full check + envelope build, asserts the result envelope
  serializes a `Fail` with `state_drift` code and one
  `EvidenceRef::StatePath` per drifted path.

`crates/utsushi-core/tests/conformance_cross_validation.rs` (existing
file, additive tests):

- `snapshot_restore_pass_results_cross_validate_against_snapshot_restore_manifest()`.
- `cross_validation_rejects_snapshot_restore_pass_above_manifest_ceiling()`.

### 8.8 Audit-focus checklist mapping

| Audit focus                                                          | Test that pins it                                                                                            |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| State drift reported too vaguely                                     | `snapshot_conformance_check_fails_with_state_path_evidence_when_baseline_differs_from_observed` (§8.3, §8.7) |
| Snapshot checks requiring renderer support                           | `snapshot_restore_profile_required_subsystems_does_not_include_frame_sink_or_artifact_store` (§8.3)          |
| Private data embedded in snapshot reports                            | `snapshot_conformance_check_serialized_form_passes_reject_unredacted_local_paths` (§8.3)                     |
| SnapshotStore typed errors, never silent stale / empty               | `in_memory_snapshot_store_resolve_returns_not_found_when_id_absent` + property test in §8.3                  |
| EvidenceRef::StatePath round-trips cleanly                           | `evidence_ref_state_path_round_trips_through_serde_json` (§8.2) + §8.3 envelope test                         |
| State-drift check actually fails on non-empty diff (negative case)   | `snapshot_conformance_check_fails_when_state_diff_is_non_empty` (§8.3)                                       |

## 9. Verification commands

```
cargo test -p utsushi-core conformance::snapshot_check
cargo test -p utsushi-core
just schema
just check
```

`pnpm exec vp run ts:test` and `pnpm exec vp run ts:typecheck` are
preserved as runtime gates by `just check`; this slice does NOT change
any TypeScript surface (UTSUSHI-030 owns the TS-side mirror of the new
codes, including `utsushi.snapshot.state_drift` and the seven new
`utsushi.conformance.snapshot_*` codes).

`just schema` regenerates the conformance JSON Schema artifact under
`artifacts/schemas/` and asserts the new `EvidenceRef::StatePath`
variant lands in the published wire schema. The schema-version pin
bump (§10) is verified by the schema generator's snapshot test.

## 10. Schema version bump

The `EvidenceRef` enum gains an additive variant, so the conformance
schema version pin
`crate::conformance::CONFORMANCE_SCHEMA_VERSION` increments from the
UTSUSHI-026 baseline. Bump rule (recorded in §10.4 of the UTSUSHI-026
plan, applied here):

- **UTSUSHI-026 baseline**: `"0.1.0-alpha"`.
- **After UTSUSHI-028**: `"0.2.0-alpha"`. The minor bump (not the
  patch bump) reflects the additive enum variant, which is
  forward-compatible for readers but requires a written-format change
  for ingestion validators that match exhaustively on
  `EvidenceRef::*`. UTSUSHI-027 and UTSUSHI-029 ship without an enum
  addition (per their plans §3.5 / §3.5) and therefore do not bump
  the version themselves; the UTSUSHI-028 bump covers the additive
  evidence-ref surface.

A migration note lives in
`docs/conformance/EVIDENCE_REF_STATE_PATH.md` (additive doc; 30 lines)
explaining the new variant, the wire shape `{ "artifactKind":
"statePath", "path": "<state path>" }`, and the
`utsushi.snapshot.state_drift` code that produces it. The doc is
referenced from `docs/conformance/README.md` (one-line addition).

## 11. Risks and unknowns

### 11.1 SnapshotStore production wiring deferred to engine ports

The slice ships only the `InMemorySnapshotStore` sample. Real engine
ports (UTSUSHI-103 sibling work, KAIFUU-* engine ports) will implement
the trait against their own backing stores (artifact bundles,
controlled-playback session logs). Risk: a port that violates the
trait's typed-error contract (e.g. returns
`Err(SnapshotStoreError::StoreUnavailable { reason: "..." })`
unconditionally as a silent failure mode) bypasses the audit-focus
defense. Mitigation: the conformance check treats every store error as
a typed `Fail` outcome with the matching semantic code, so a
misbehaving store still produces a reviewable failure rather than a
silent success. The trait-level audit is recorded for the first
production wiring slice.

### 11.2 `EvidenceRef` enum evolution

Adding a variant to `EvidenceRef` is a backward-compatible read change
(deserializers that pre-date this slice will fail on the new variant
with a typed serde error, which is the desired loud-failure mode). The
risk is that downstream consumers (UTSUSHI-030 ingestion) ship before
the schema version bump propagates. Mitigation: §10's schema-version
bump is the single tripwire; the schema-emit test (`just schema`) is
the gate. Coordination with UTSUSHI-030 is one-way (the codes::ALL
slice and the schema artifact); no shared structural surface.

### 11.3 Snapshot fixture size

The synthetic fixtures embed full `Snapshot` payloads in the
`InMemorySnapshotStore` setup helpers. UTSUSHI-023's
`SNAPSHOT_MAX_SERIALIZED_BYTES = 16 KiB` ceiling caps the fixture size;
the §8 tests assert each fixture stays well under this limit. The
risk is that future fixtures (multi-namespace state trees) brush the
ceiling. Mitigation: the redaction walk + size check in
`Snapshot::validate` already fires before the fixture lands; a
fixture that exceeds the ceiling fails its own validate at
construction time, not at use time.

### 11.4 Wire-tag rename for `EvidenceRef::StatePath`

The brief specifies the wire shape `{ kind: "state_path", path: "..."
}` (snake_case `kind`). The existing `EvidenceRef` enum uses
`artifactKind: "<camelCase>"`. This slice keeps the enum's existing
serde shape (`artifactKind: "statePath"`) so the additive change does
not break the wire format of the other five variants. The brief's
intent (a state-path-shaped evidence pointer with verbatim path
quoting) is preserved; the field name `path` and the semantic code
`utsushi.snapshot.state_drift` match the brief verbatim. The
serialization shape is documented at the point of variant definition
and in the §10 migration note. If a future PR wants to flip the
top-level tag name across all variants, that is a coordinated wire-
format change, out of scope here.

### 11.5 Pass-without-evidence interaction

UTSUSHI-026's `ConformanceResult::validate` rejects `Pass` with an
empty `evidence` vec. The check struct's `run` returns
`ResultOutcome::Pass` without populating evidence (the check struct
does not own the result envelope). The runner MUST attach at least
one `EvidenceRef` before serializing the envelope. The
`SnapshotConformanceCheck::pass_evidence_for(&Snapshot) ->
EvidenceRef` helper returns a deterministic load-bearing
`EvidenceRef::StatePath` from the baseline (the first sorted path).
Risk: a runner that forgets to call the helper produces a result
envelope that fails `validate`. Mitigation: this is a runner-side
contract violation that already exists for every other profile (the
check returning `Pass` without evidence is a generic UTSUSHI-026
issue); the slice documents the helper and exercises it in the §8.7
integration test.

### 11.6 Audit-focus checklist

| Audit focus                                           | Structural defense                                                                                                                                                              |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| State drift reported too vaguely                      | `EvidenceRef::StatePath` quotes the verbatim path; one entry per `StateDiff::changed_paths()` element; §8.3 negative test asserts each path is the literal substrate string.    |
| Snapshot checks requiring renderer support            | Check struct contains zero frame / screenshot fields; `ProfileId::SnapshotRestore.required_subsystems()` excludes `FrameSink`; §8.3 subsystem-list test pins this structurally. |
| Private data embedded in snapshot reports             | Redaction walk on serialized check + envelope; check carries no `bytes`/`path`/`uri` leaf; substrate's `Snapshot::validate` walks the JSON form at construction time.           |
| SnapshotStore returns stale / empty silent payload    | Trait returns `Result<Snapshot, SnapshotStoreError>` only; no `Result<Option<Snapshot>, _>`; §8.1 typed-error tests assert every failure mode is a named variant.               |
| EvidenceRef::StatePath round-trips through the schema | §8.2 round-trip + validate suite; §8.3 envelope serialization test; `just schema` regenerates the wire schema.                                                                  |
| State-drift check fails on non-empty diff             | `run()` returns `Fail { semantic_code: SNAPSHOT_STATE_DRIFT }` whenever `diff.is_empty() == false`; §8.3 negative test pins this; §8.7 integration negative case pins it again. |

## 12. Out of scope

- **Actual snapshot production in any specific engine port**. No
  engine port is modified by this slice. The first port to publish
  snapshot conformance results is a follow-up (sibling to the
  per-port PortManifest landings; coordinated through UTSUSHI-103
  engine-port substrate).
- **UTSUSHI-030 ingestion**. UTSUSHI-030 consumes the new
  `EvidenceRef::StatePath` variant and the seven new
  `utsushi.conformance.snapshot_*` codes through the existing
  `ConformanceResult` JSON shape. No new wire fields are emitted by
  this slice beyond the additive variant. TypeScript mirror of the
  new codes and the new variant lives in UTSUSHI-030's slice.
- **Snapshot-restore conformance for adapters that do not implement
  `Restorable`**. The substrate already returns
  `SnapshotError::RestoreUnsupported` from this path (UTSUSHI-023
  §diagnostics); the conformance check inherits the typed error.
  Production wiring against a port that does not implement
  `Restorable` is a runner-level concern, deferred to the first
  engine port slice that needs the path.
- **Persistent / on-disk snapshot stores**. The `InMemorySnapshotStore`
  sample is the only implementation shipped. A file-backed or
  artifact-store-backed implementation lands with the first engine
  port that needs it; the trait contract is unchanged.
- **Property tests on `StateDiff`**. UTSUSHI-023 already owns the diff
  primitive's property surface (round-trip determinism, sort
  invariance). This slice consumes the diff and asserts the
  diff-derived evidence vec inherits the sort; it does not re-test
  the diff primitive itself.
- **Cross-engine snapshot comparison**. Diffing snapshots from
  different `inspectable_id` ports is structurally rejected by the
  substrate (`SnapshotError::DiffInspectableIdMismatch`); the
  conformance check rejects the same case at validate time. Cross-
  engine semantics (e.g. comparing an XP3 port's snapshot against a
  KAG port's snapshot) are explicitly not in scope.
- **Audio-event or frame-event drift**. The snapshot substrate covers
  `StateTree` only. Time-series evidence (frame sequences, audio
  events) lives in the UTSUSHI-029 capture/recording surface and is
  not part of snapshot drift.

## 13. Worker scoping

**One worker**, single PR onto `spec/utsushi-028`. The slice is
self-contained inside:

- `utsushi-core/src/conformance/snapshot_check/` (new module).
- `utsushi-core/src/snapshot/store.rs` (new module).
- Three additive touches:
  `conformance::result.rs` (one new `EvidenceRef` variant + its
  validate arm),
  `conformance::diagnostics.rs` (seven new `ConformanceError`
  variants + their codes),
  `conformance::fixtures.rs` (snapshot fixtures + sample store
  helper),
  `snapshot::diagnostics.rs` (six new codes + store-error variants),
  `snapshot::mod.rs` (re-exports),
  `crates/utsushi-core/src/lib.rs` (re-exports + rewritten doc on
  `RuntimeRequest::snapshot`).
- One new integration test file:
  `crates/utsushi-core/tests/conformance_snapshot.rs`.

No cross-crate changes; no schema-package changes; no new workspace
member. Estimated diff size: ~1,400 LOC (≈700 production + ≈700 tests
+ fixtures), well inside a single-worker scope per the UTSUSHI-022 /
UTSUSHI-026 / UTSUSHI-029 precedent.

## 14. Coordination summary

- **UTSUSHI-023 (landed)** owns the snapshot substrate. UTSUSHI-028
  adds `SnapshotStore` as a sibling resolver under `crate::snapshot`;
  the substrate's existing `Snapshot::validate`,
  `diff_snapshots`, and `SnapshotError` surfaces are consumed
  unchanged. The state-drift code lives in the substrate's
  `utsushi.snapshot.*` namespace (it is the substrate's diff that
  drives the conformance signal).
- **UTSUSHI-026 (landed)** owns the conformance manifest / result
  substrate. UTSUSHI-028 ships the first additive `EvidenceRef`
  variant (`StatePath`), bumps `CONFORMANCE_SCHEMA_VERSION`, and
  registers seven new codes under the existing
  `conformance::diagnostics::codes::ALL` slice. The check struct
  produces `ResultOutcome` values the existing envelope already
  carries.
- **UTSUSHI-027 (landed)** and **UTSUSHI-029 (landed)** both
  explicitly reserved the additive `EvidenceRef` slot for this slice.
  No structural overlap. The merge surface (codes::ALL and
  ConformanceError enum) is order-insensitive additive union.
- **UTSUSHI-030 (downstream)** consumes the snapshot check outputs via
  the existing `ConformanceResult` JSON shape. The TS-side mirror of
  the new codes and the new `EvidenceRef::StatePath` variant is
  UTSUSHI-030's responsibility.
- **UTSUSHI-103 (engine-port substrate)** is the first downstream
  slice that will wire `SnapshotStore` to a production backing store
  per engine port. The trait contract documented here is the
  audit-frozen surface those slices implement against.
- **KAIFUU-010 (in parallel)** — the semantic-code shape
  `^(utsushi|kaifuu)\.[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$` already
  permits the new codes. No changes required.
