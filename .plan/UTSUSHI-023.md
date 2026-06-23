# UTSUSHI-023 — Inspectable state and snapshot primitives

- **Node**: UTSUSHI-023
- **Title**: Inspectable state and snapshot primitives
- **Branch**: `spec/utsushi-023`
- **Worktree**: `/scratch/worktrees/itotori-spec-utsushi-023`
- **Author**: planning worker (orchestrator)
- **Date**: 2026-06-23
- **Status target**: in_progress → ready_for_review (single implementation slice)
- **Dependency layer landed**: UTSUSHI-020 (VFS), UTSUSHI-021 (input/clock/replay),
  UTSUSHI-022 (sinks), UTSUSHI-026 (conformance manifest + result schema), and
  UTSUSHI-103 (engine port runner template) all on main.

## 1. Goal restatement

Provide the engine-neutral substrate for **inspectable runtime state +
controlled-playback snapshots**: a portable, immutable snapshot that captures the
state of a controlled playback session, a `restore` operation that puts a
runtime back into that state with deterministic replay, and a `diff` operation
that names exactly which state path changed when two snapshots disagree. The
substrate must satisfy three claims that downstream nodes can mechanically
falsify:

1. **Round-trip determinism.** A fixture runtime that takes a snapshot, mutates
   state, restores the snapshot, and re-takes a snapshot produces a snapshot
   that compares equal to the original — bit-for-bit on the canonical
   serialized form.
2. **Path-keyed diff.** When two snapshots disagree, `diff` reports the changed
   state paths (e.g. `runtime.input.cursor`, `bridge.unit.123`) rather than a
   single "snapshot did not match" boolean. UTSUSHI-028 consumes the diff to
   produce per-path conformance diagnostics.
3. **Redacted payload.** The serialized snapshot passes
   `reject_unredacted_local_paths` and contains no raw asset bytes (or no more
   than a bounded, hex-encoded sample plus a content hash). Asset references
   use `AssetId` only.

Downstream consumers and what they require from this layer:

- **UTSUSHI-028** (snapshot conformance) — `dependsOn: UTSUSHI-026, UTSUSHI-023`.
  Consumes `Snapshot`, `restore_snapshot`, and `diff` to produce
  `ConformanceResult` entries whose `EvidenceRef` cites changed state paths.
  Needs `StateDiff` shape stable enough for the conformance result schema.
- **UTSUSHI-146** (RealLive runtime port) — `dependsOn: UTSUSHI-023, UTSUSHI-103,
UTSUSHI-120`. The RealLive port implements the `Inspectable` trait against
  its Scene/SEEN replay state (frame counter, sel-stack cursor, bridge-unit
  cursor). It MUST NOT have to leak engine-specific structures into the state
  tree; the substrate's state-value taxonomy has to be expressive enough for
  RealLive without being shaped by it.
- **UTSUSHI-024** (WASM embed ABI) — serializes `Snapshot` across the embed
  boundary. Snapshot types must be `Send + Sync`, serialize without host-only
  types (no `PathBuf`, no `Instant`, no `SystemTime`), and stay below a
  bounded size when no asset bytes are included.
- **UTSUSHI-027** (trace / branch conformance) — independent today, but the
  `state_tree` shape MAY hold a logical-tick anchor that lets trace and branch
  conformance correlate a snapshot to a recorded replay log entry.
- **UTSUSHI-104** (cross-engine moment index) — a `MomentId` may eventually be
  stored on a `Snapshot` as a moment anchor; nothing is foreclosed.

## 2. Module placement

**Recommendation: keep the substrate in `utsushi-core` under a new public
module `utsushi_core::snapshot`, sibling to `utsushi_core::vfs`,
`utsushi_core::replay`, `utsushi_core::sink`, `utsushi_core::port`, and
`utsushi_core::conformance`.**

Justification (mirrors the UTSUSHI-020 / UTSUSHI-021 / UTSUSHI-022 / UTSUSHI-026
placement reasoning):

- `utsushi-core` already owns every shared type this module needs:
  `AssetId` (UTSUSHI-020), `LogicalClockTick` and `ClockOrigin` (UTSUSHI-021),
  `EvidenceTier`, `RuntimeArtifactRoot`, `validate_runtime_artifact_uri`,
  `reject_unredacted_local_paths`, `OBSERVATION_HOOK_SCHEMA_VERSION`, and
  `PortRequest` / `EnginePort` (UTSUSHI-103). A standalone
  `utsushi-snapshot` crate would have to re-export all of these or pull
  `utsushi-core` as a dep, doubling the dep edge on every downstream consumer
  for zero isolation win.
- Every downstream consumer (UTSUSHI-028, UTSUSHI-024, UTSUSHI-146 and beyond)
  already depends on `utsushi-core`. A separate crate produces zero benefit.
- The substrate has a small footprint (snapshot type, state-tree shape,
  state-value enum, inspectable trait, snapshot ops, state diff, semantic
  errors). Module-level isolation inside `utsushi-core/src/snapshot/` matches
  the precedent set by `vfs/`, `sink/`, `port/`, and `conformance/`.

**Submodule layout under `crates/utsushi-core/src/snapshot/`:**

```
crates/utsushi-core/src/snapshot/
  mod.rs           # re-exports + crate docs + SCHEMA_VERSION constant
  state.rs         # StateTree, StatePath, StateValue, normalization rules
  snapshot.rs      # Snapshot, SnapshotId, SnapshotRef, take/restore APIs
  inspectable.rs   # Inspectable trait + read-only snapshot accessor trait
  diff.rs          # StateDiff, StateChange, diff(&Snapshot, &Snapshot)
  redaction.rs     # snapshot-specific redaction filter wrappers
  diagnostics.rs   # SnapshotError + codes::* stable semantic codes
```

`utsushi-core/src/lib.rs` re-exports the public surface:

```rust
pub mod snapshot;

pub use snapshot::{
    Inspectable, Snapshot, SnapshotError, SnapshotId, SnapshotRef,
    SnapshotSchemaVersion, StateChange, StateChangeKind, StateDiff,
    StatePath, StateTree, StateValue, SNAPSHOT_SCHEMA_VERSION,
    take_snapshot, restore_snapshot, diff_snapshots,
};
```

**No new workspace member is introduced.** No new third-party dep is introduced
(`serde`, `serde_json`, and the existing `sha2`/hashing crate already used in
the workspace cover the bytes-hash case). If the workspace does not already
carry a hash dep, the implementation uses a small fixed-output hash adapter
from `std`-only material (e.g. `siphash` via `std::hash::Hasher`) — the choice
is deferred to the implementation worker and reviewed against the workspace's
existing dep policy.

## 3. State tree shape

The state tree is the central engine-neutral type. It is a **path-keyed
hierarchy of typed values**: keys are dotted strings that name a logical
component of controlled-playback state; values are typed leaves drawn from a
bounded `StateValue` enum.

### 3.1 `StatePath`

```rust
/// Dotted, engine-neutral path into the state tree. Construction validates
/// the shape so a malformed path cannot enter the tree.
#[derive(Clone, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct StatePath(String);

impl StatePath {
    /// Parses a dotted path. Validation rules:
    /// - Non-empty.
    /// - Each segment matches `[a-z0-9][a-z0-9_-]*`, lowercase ASCII.
    /// - Maximum overall length `MAX_STATE_PATH_BYTES = 512`.
    /// - Maximum segment count `MAX_STATE_PATH_SEGMENTS = 12`.
    /// - The first segment names a top-level namespace (see §3.2). Unknown
    ///   top-level segments are rejected so engine ports cannot invent
    ///   ad-hoc roots.
    /// - Passes `reject_unredacted_local_paths` (no `/home/`, `/tmp/`,
    ///   `\\`, drive letters, etc.).
    pub fn parse(raw: &str) -> Result<Self, SnapshotError>;

    pub fn as_str(&self) -> &str;
    pub fn segments(&self) -> impl Iterator<Item = &str>;
    pub fn top_level(&self) -> &str;
}
```

### 3.2 Top-level namespaces

The substrate pre-declares the top-level namespaces that engine ports may use.
Unknown namespaces are rejected. New namespaces require a typed `StateNamespace`
enum extension — engine ports cannot smuggle engine-flavoured roots in.

| Top-level  | Owner            | Examples                                                             |
| ---------- | ---------------- | -------------------------------------------------------------------- |
| `runtime`  | substrate        | `runtime.clock.tick`, `runtime.clock.origin`, `runtime.input.cursor` |
| `replay`   | substrate        | `replay.log_id`, `replay.cursor`, `replay.asset_refs`                |
| `bridge`   | observation-hook | `bridge.unit.<bridge_unit_id>`, `bridge.scene.<scene_id>`            |
| `vfs`      | UTSUSHI-020      | `vfs.<package>.<asset_path>`                                         |
| `port`     | engine port      | `port.frame`, `port.sel_stack.depth`, `port.scene_cursor`            |
| `metadata` | substrate        | `metadata.seed`, `metadata.adapter_name`, `metadata.run_id`          |

The implementation models this as:

```rust
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum StateNamespace { Runtime, Replay, Bridge, Vfs, Port, Metadata }
```

`StatePath::parse` looks up the first segment against `StateNamespace` and
rejects unknown roots with `SnapshotError::UnknownStateNamespace`. The
`port` namespace is the engine-port escape hatch; everything ports add lives
under `port.*` so port-specific fields are visible and audit-segregated.

### 3.3 `StateValue`

```rust
/// Engine-neutral leaf value. The enum is bounded; engine ports cannot
/// introduce new variants. `Nested` is the only branch node and lets the
/// tree express grouped values where a `StatePath` per leaf would be
/// awkward.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "valueKind", rename_all = "camelCase")]
pub enum StateValue {
    /// UTF-8 string. Validated through `reject_unredacted_local_paths`.
    #[serde(rename = "string", rename_all = "camelCase")]
    String { value: String },

    /// Signed 64-bit integer.
    #[serde(rename = "int", rename_all = "camelCase")]
    Int { value: i64 },

    /// Unsigned 64-bit integer.
    #[serde(rename = "uint", rename_all = "camelCase")]
    Uint { value: u64 },

    /// Boolean.
    #[serde(rename = "bool", rename_all = "camelCase")]
    Bool { value: bool },

    /// Asset reference. Stored as `AssetId`; never a raw path.
    #[serde(rename = "assetId", rename_all = "camelCase")]
    AssetId { value: crate::AssetId },

    /// Bounded, hex-encoded bytes plus a content hash. Used for opaque
    /// engine-defined state regions (e.g. RealLive sel-stack frame). The
    /// hex sample is capped (see §7); the hash is always present and is
    /// what `diff` and equality use.
    #[serde(rename = "bytes", rename_all = "camelCase")]
    Bytes(BytesValue),

    /// Logical clock tick (UTSUSHI-021). Carried as a typed leaf so the
    /// state tree can name `runtime.clock.tick` semantically.
    #[serde(rename = "tick", rename_all = "camelCase")]
    Tick { value: crate::LogicalClockTick },

    /// Ordered list of homogeneous leaves. Used sparingly (e.g.
    /// `replay.asset_refs`).
    #[serde(rename = "list", rename_all = "camelCase")]
    List { items: Vec<StateValue> },

    /// Nested subtree. Keys are leaf-level segments, not full
    /// `StatePath`s. Used to group fields that always co-vary.
    #[serde(rename = "nested", rename_all = "camelCase")]
    Nested { entries: BTreeMap<String, StateValue> },
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BytesValue {
    /// Hex-encoded prefix of the bytes, at most `BYTES_SAMPLE_HEX_LEN`
    /// characters (= `BYTES_SAMPLE_LEN` raw bytes). Lowercase hex; no
    /// `0x` prefix.
    pub sample_hex: String,
    /// Full content hash of the raw bytes, lowercase hex. The hash is
    /// the load-bearing comparison key — `diff` and equality compare on
    /// `hash`, never on `sample_hex`.
    pub hash: String,
    /// Total byte length of the original bytes (informational; not
    /// secret).
    pub length: u64,
}
```

`StateValue` is the only place where bytes can enter a snapshot. The bytes
variant always stores hash + sample, never the full payload. The hash field is
required (asserted at validation); `sample_hex` is bounded; `length` is
informational.

### 3.4 `StateTree`

```rust
/// Flat path-keyed state tree. The internal storage is a `BTreeMap` keyed
/// by canonicalized `StatePath` strings so serialization order is
/// deterministic.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(transparent)]
pub struct StateTree(BTreeMap<StatePath, StateValue>);

impl StateTree {
    pub fn new() -> Self;
    pub fn insert(&mut self, path: StatePath, value: StateValue)
        -> Result<(), SnapshotError>;
    pub fn get(&self, path: &StatePath) -> Option<&StateValue>;
    pub fn paths(&self) -> impl Iterator<Item = &StatePath>;
    pub fn iter(&self) -> impl Iterator<Item = (&StatePath, &StateValue)>;
    pub fn len(&self) -> usize;
    pub fn is_empty(&self) -> bool;

    /// Validate the whole tree. Runs redaction on every value, asserts every
    /// `StateValue::Bytes` has a non-empty `hash`, asserts every
    /// `StatePath` is unique by canonical form, and asserts the serialized
    /// tree stays under `STATE_TREE_MAX_SERIALIZED_BYTES`.
    pub fn validate(&self) -> Result<(), SnapshotError>;
}
```

The tree is **flat** at the public API: `insert` takes a full `StatePath` and
`StateValue::Nested` is the only grouping mechanism. This keeps `diff`
straightforward (path-keyed set difference + leaf compare) and keeps the
serialized JSON stable (one map, one ordering).

## 4. Inspectable state trait

```rust
/// Engine ports implement `Inspectable` to expose their inspectable state
/// into the snapshot substrate. The trait is read-only on `&self` for the
/// inspection side; restoration is a separate trait so a port that can
/// expose state but cannot restore it surfaces typed
/// `SnapshotError::RestoreUnsupported`.
pub trait Inspectable: Send + Sync {
    /// Stable identifier of the inspectable surface (e.g.
    /// `"utsushi-fixture"`, `"utsushi-reallive"`). Used by `Snapshot`
    /// metadata so two snapshots from different ports cannot be
    /// accidentally diffed.
    fn inspectable_id(&self) -> &'static str;

    /// Read the port's current state into a `StateTree`. Implementors
    /// MUST NOT include host paths, raw asset bytes, or process/thread
    /// identifiers; the substrate's `StateValue::Bytes` requires a hash
    /// so opaque blobs are addressable but not mirrored. The runner
    /// re-validates the produced `StateTree`.
    fn inspect_state(&self) -> Result<StateTree, SnapshotError>;
}

/// Separate trait for ports that can restore. A port that implements
/// `Inspectable` but not `Restorable` declares the inspect-only posture
/// explicitly. Conformance (UTSUSHI-028) inspects which port supports
/// restoration before scheduling a restore-based check.
pub trait Restorable: Inspectable {
    /// Restore the port to the supplied state tree. Implementors MUST:
    /// - Validate that every consumed `StatePath` belongs to a known
    ///   namespace they own (port.*, replay.*, runtime.*). Unknown paths
    ///   return `SnapshotError::RestoreStatePathUnknown { path }`.
    /// - Validate that every consumed value's type matches the port's
    ///   expectation; mismatch returns
    ///   `SnapshotError::RestoreTypeMismatch { path, expected, found }`.
    /// - Reject out-of-range or invalid values with
    ///   `SnapshotError::RestoreValueOutOfRange { path, reason }`.
    /// - NEVER silently skip a path; every path is either consumed,
    ///   ignored-by-design (must return `Ok(_)` with an explicit
    ///   "ignored" tally so the runner can assert no unexpected ignore),
    ///   or rejected.
    fn restore_state(&mut self, state: &StateTree)
        -> Result<RestoreReport, SnapshotError>;
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RestoreReport {
    pub consumed_paths: Vec<StatePath>,
    pub ignored_by_design: Vec<StatePath>,
}
```

The `consumed_paths` / `ignored_by_design` split is the audit-focus
"silent best effort" mitigation: a port either consumes a path, declares it
ignored on purpose, or returns a typed error. There is no third option.

### 4.1 `Send + Sync` and read-only-after-construction

- `Snapshot`, `StateTree`, `StateValue`, `StateDiff`, and `StatePath` are
  `Send + Sync`.
- `Snapshot` exposes no `&mut` accessor; all of its public methods take
  `&self`. The `state_tree`, `snapshot_id`, `schema_version`, and
  `generated_at` fields are private; readers go through accessors that return
  `&` references.
- `take_snapshot` returns an owned `Snapshot`; there is no factory that
  produces a builder-style mutable snapshot. The snapshot is immutable by
  construction.

## 5. Snapshot operations

### 5.1 `Snapshot` type

```rust
pub const SNAPSHOT_SCHEMA_VERSION: &str = "0.1.0-alpha";

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotSchemaVersion(pub String);

#[derive(Clone, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct SnapshotId(String);

impl SnapshotId {
    /// Construct from a UUIDv7-shaped string; format validated.
    pub fn parse(raw: &str) -> Result<Self, SnapshotError>;
    pub fn as_str(&self) -> &str;
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    schema_version: SnapshotSchemaVersion,
    snapshot_id: SnapshotId,
    /// RFC3339 instant. Reduced to date when redaction is at its strictest
    /// tier; the substrate stores the full instant and the WASM ABI (024)
    /// downsamples if needed.
    generated_at: String,
    /// Stable identifier of the inspectable surface that produced the
    /// snapshot. Two snapshots from different `inspectable_id` cannot be
    /// diffed (see §6.2).
    inspectable_id: String,
    state_tree: StateTree,
    /// Evidence tier of the snapshot. Snapshots are E2-by-default
    /// (controlled-playback evidence) and capped at E3. Higher tiers
    /// require a separate sink and are not part of this surface.
    evidence_tier: EvidenceTier,
}

impl Snapshot {
    pub fn schema_version(&self) -> &SnapshotSchemaVersion;
    pub fn snapshot_id(&self) -> &SnapshotId;
    pub fn generated_at(&self) -> &str;
    pub fn inspectable_id(&self) -> &str;
    pub fn state_tree(&self) -> &StateTree;
    pub fn evidence_tier(&self) -> EvidenceTier;

    /// Validates the snapshot end-to-end. Runs on construction and on
    /// `from_json_value`. Asserts schema version, inspectable id shape,
    /// non-empty state tree, evidence tier <= E3, full serialized form
    /// passing `reject_unredacted_local_paths`, serialized size under
    /// `SNAPSHOT_MAX_SERIALIZED_BYTES`.
    pub fn validate(&self) -> Result<(), SnapshotError>;

    pub fn to_json_value(&self) -> Result<Value, SnapshotError>;
    pub fn from_json_value(value: Value) -> Result<Self, SnapshotError>;
}

/// Lightweight reference to a snapshot for additive plumbing through
/// `RuntimeRequest` (see §8). Carries only the id; the full payload is
/// resolved out of band so `RuntimeRequest` does not grow unbounded.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotRef {
    pub snapshot_id: SnapshotId,
    pub inspectable_id: String,
    pub evidence_tier: EvidenceTier,
}
```

### 5.2 `take_snapshot`

```rust
/// Read the inspectable port's state into an immutable `Snapshot`. The
/// builder pattern is internal; the public API is a single function so
/// callers cannot construct a snapshot from a partial / un-validated
/// tree.
pub fn take_snapshot(
    inspectable: &dyn Inspectable,
    request: &SnapshotRequest<'_>,
) -> Result<Snapshot, SnapshotError>;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SnapshotRequest<'a> {
    /// Run id supplied by the runner; used as the namespace seed for
    /// `SnapshotId` derivation when the caller supplies no explicit id.
    pub run_id: &'a str,
    /// Optional caller-supplied id (otherwise derived deterministically
    /// from `run_id` + `LogicalClockTick`). Deterministic derivation is
    /// the test-friendly default.
    pub snapshot_id: Option<SnapshotId>,
    /// Caller-declared evidence tier (capped at E3 by `validate`).
    pub evidence_tier: EvidenceTier,
    /// RFC3339 instant. Required; the substrate does NOT call
    /// `SystemTime::now()` — the runner supplies the timestamp from its
    /// own clock so determinism is in the caller's hands.
    pub generated_at: &'a str,
}
```

The function:

1. Calls `inspectable.inspect_state()` to produce a `StateTree`.
2. Validates the tree (`StateTree::validate`).
3. Constructs the snapshot with the supplied / derived id and tier.
4. Runs `Snapshot::validate` end-to-end.
5. Returns the owned snapshot or a typed `SnapshotError`.

### 5.3 `restore_snapshot`

```rust
pub fn restore_snapshot(
    restorable: &mut dyn Restorable,
    snapshot: &Snapshot,
) -> Result<RestoreReport, SnapshotError>;
```

The function:

1. Asserts `snapshot.inspectable_id() == restorable.inspectable_id()`. Mismatch
   returns `SnapshotError::InspectableIdMismatch { expected, found }`. A port
   never restores a snapshot it does not own.
2. Asserts `snapshot.schema_version()` equals `SNAPSHOT_SCHEMA_VERSION`. Mismatch
   returns `SnapshotError::SchemaVersionMismatch { observed, expected }`.
3. Forwards to `restorable.restore_state(snapshot.state_tree())`.
4. Returns the `RestoreReport` from the port.

The function is intentionally a thin orchestrator — the port owns
restoration semantics. The substrate provides the contract (typed errors,
shape, validation); it does not implement engine-specific restoration.

### 5.4 `diff_snapshots`

```rust
pub fn diff_snapshots(
    before: &Snapshot,
    after: &Snapshot,
) -> Result<StateDiff, SnapshotError>;
```

The function:

1. Asserts both snapshots share `inspectable_id`. Different ports' snapshots
   are not comparable; mismatch returns
   `SnapshotError::DiffInspectableIdMismatch { left, right }`.
2. Asserts both snapshots share `schema_version`.
3. Computes a path-keyed set diff (added in `after`, removed in `after`,
   modified). Modified leaves carry both the old and new value.
4. Returns the `StateDiff`.

## 6. `StateDiff` shape

```rust
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StateDiff {
    pub schema_version: SnapshotSchemaVersion,
    pub left_snapshot_id: SnapshotId,
    pub right_snapshot_id: SnapshotId,
    pub inspectable_id: String,
    pub changes: Vec<StateChange>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StateChange {
    pub path: StatePath,
    pub kind: StateChangeKind,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum StateChangeKind {
    #[serde(rename_all = "camelCase")]
    Added { value: StateValue },
    #[serde(rename_all = "camelCase")]
    Removed { value: StateValue },
    #[serde(rename_all = "camelCase")]
    Modified { old: StateValue, new: StateValue },
}

impl StateDiff {
    pub fn is_empty(&self) -> bool { self.changes.is_empty() }
    pub fn changed_paths(&self) -> impl Iterator<Item = &StatePath>;
    pub fn validate(&self) -> Result<(), SnapshotError>;
}
```

Ordering: `changes` is sorted by `path.as_str()` so two equal diffs serialize
identically. The serialized form passes `reject_unredacted_local_paths`.

### 6.1 Path-keyed identification, by construction

Every audit-focus item "state diffs too vague to debug" is met because every
`StateChange` carries the full `StatePath`. UTSUSHI-028's conformance check
quotes the path verbatim when it fails: a failed restore says
`utsushi.snapshot.state_drift { path: "port.scene_cursor" }`, not "restore
failed."

### 6.2 No cross-port diff

`diff_snapshots` requires the same `inspectable_id` because state path
taxonomy under `port.*` differs per engine and a cross-port diff would
report meaningless "added" entries for every `port.*` field on each side.
The conformance layer is allowed to compare cross-port `runtime.*` /
`replay.*` paths through a separate helper added later if needed; that
helper is out of scope here.

## 7. Redaction

The substrate enforces redaction at three layers:

1. **`StatePath::parse`** rejects any path whose serialized form would match
   `looks_like_local_path` (e.g. `vfs.my-pkg.\\home\\trevor\\data.txt`).
   Top-level namespace + segment regex already covers most leaks; the explicit
   filter catches engine ports that try to encode host paths in `port.*`
   segments.
2. **`StateValue::String`** carries a private validator that runs
   `reject_unredacted_local_paths` on the value at insertion time.
3. **`Snapshot::validate` / `StateDiff::validate`** runs the same filter on
   the fully serialized JSON form before returning. A snapshot that somehow
   accumulated a leaking field fails serialization with
   `SnapshotError::RedactionViolation { field_path }`.

Constants:

```rust
/// Max length of the hex-encoded sample stored in `BytesValue::sample_hex`.
/// 128 hex chars = 64 raw bytes. Enough to distinguish blobs in a debug
/// dump; small enough to keep snapshots compact.
pub const BYTES_SAMPLE_HEX_LEN: usize = 128;

/// Max serialized snapshot size (JSON, bytes). A 16 KiB ceiling catches
/// accidental binary embedding loudly.
pub const SNAPSHOT_MAX_SERIALIZED_BYTES: usize = 16 * 1024;

/// Max serialized state-tree size (JSON, bytes). Slightly smaller than
/// the snapshot ceiling to leave room for the metadata envelope.
pub const STATE_TREE_MAX_SERIALIZED_BYTES: usize = 12 * 1024;

/// Max path-string length (bytes).
pub const MAX_STATE_PATH_BYTES: usize = 512;

/// Max number of segments in a state path.
pub const MAX_STATE_PATH_SEGMENTS: usize = 12;

/// Hash digest length (lowercase hex chars). 64 = 32-byte digest. The
/// digest algorithm choice (e.g. BLAKE3 or SHA-256) is the implementor's
/// call; both produce 64-char hex digests, both are deterministic.
pub const BYTES_HASH_HEX_LEN: usize = 64;
```

### 7.1 `AssetId` references only

The only path-shaped values allowed in a snapshot are `AssetId`s, which are
`vfs://<package>/<path>`-shaped by construction and host-path-free. The
`vfs.*` namespace's path values use `AssetId`, never `&Path` or `String`,
so host-path leakage is structurally impossible at the boundary.

## 8. Integration with `RuntimeRequest`

UTSUSHI-020 added `vfs: Option<Arc<dyn RuntimeVfs>>`. UTSUSHI-021 added
`replay: Option<Arc<ReplayLog>>`. UTSUSHI-022 added `sinks: Option<SinkSet>`.
UTSUSHI-103 added `cancellation: Option<RunnerCancellation>`. UTSUSHI-023
makes the analogous additive change:

```rust
#[derive(Clone)]
pub struct RuntimeRequest<'a> {
    pub input_root: &'a Path,
    pub artifact_root: Option<&'a Path>,
    pub vfs: Option<Arc<dyn RuntimeVfs>>,
    pub replay: Option<Arc<ReplayLog>>,
    pub sinks: Option<SinkSet>,
    pub cancellation: Option<RunnerCancellation>,
    /// Optional snapshot anchor. When present, the runner is being
    /// asked to restore the snapshot at `start` and replay from the
    /// matching anchor. The reference is intentionally lightweight
    /// (id-only, no payload); the full `Snapshot` is resolved by the
    /// runner from the supplied `SnapshotStore` or test fixture.
    pub snapshot: Option<SnapshotRef>,
}

impl<'a> RuntimeRequest<'a> {
    pub fn with_snapshot(mut self, snapshot: SnapshotRef) -> Self {
        self.snapshot = Some(snapshot);
        self
    }
}
```

`SnapshotRef` is chosen over `Arc<Snapshot>` because:

- The snapshot payload may be larger than other request fields; carrying the
  full payload would inflate the request struct and make `Debug` noisy.
- Most consumers do not need to interpret the snapshot; the runner resolves
  it via a separate store abstraction (introduced lazily by UTSUSHI-028 or
  the first port that needs it).
- The id-only reference round-trips through serde cleanly so UTSUSHI-024
  can pass it across the WASM ABI without payload duplication.

The `Debug` impl prints `snapshot: <present>/<absent>` (matches the existing
`sinks` and `vfs` formatting).

The `RuntimeAdapter` trait does NOT change. Adapters that consume snapshots
read `request.snapshot.as_ref()` from inside their existing trait methods.
The signature decision (whether to add a typed `restore` lifecycle method to
`EnginePort`) is deferred to UTSUSHI-028 / UTSUSHI-146, which are the first
consumers that need it.

### 8.1 Coordination with parallel iter-4 nodes

Three other iter-4 nodes are in flight: UTSUSHI-027 (trace + branch
conformance), UTSUSHI-029 (capture conformance), KAIFUU-010 (patch result
v0.2). Only UTSUSHI-023 touches `utsushi-core/src/snapshot/`. UTSUSHI-027 and
UTSUSHI-029 add new `EvidenceRef` variants on the existing
`conformance::result::EvidenceRef` enum; UTSUSHI-023 may add one too (a
`StatePath` evidence variant — see §11.4) but the addition is additive and
sorts as a one-line conflict on the enum body. Merge conflicts on `lib.rs`
re-exports are similarly additive (a `pub use snapshot::{...};` line).
No shared private type changes between the four nodes.

## 9. Semantic errors

```rust
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum SnapshotError {
    /// `Snapshot::schema_version` is not `SNAPSHOT_SCHEMA_VERSION`.
    SchemaVersionMismatch { observed: String, expected: &'static str },

    /// `StatePath::parse` rejected a malformed path.
    InvalidStatePath { raw: String, reason: String },

    /// `StatePath` top-level segment is not a known
    /// `StateNamespace`.
    UnknownStateNamespace { raw: String, observed_root: String },

    /// `StatePath` collided with another path that canonicalises to
    /// the same form on insert.
    DuplicateStatePath { path: String },

    /// `restore_snapshot` saw a path the port does not know how to
    /// consume.
    RestoreStatePathUnknown { path: StatePath },

    /// `restore_snapshot` saw a value whose type did not match the
    /// port's expectation.
    RestoreTypeMismatch {
        path: StatePath,
        expected: &'static str,
        found: &'static str,
    },

    /// `restore_snapshot` saw a value outside the port's accepted
    /// range. `reason` is a stable, public phrase.
    RestoreValueOutOfRange { path: StatePath, reason: String },

    /// `restore_snapshot` failed because the port does not implement
    /// `Restorable`. Conformance reports this as
    /// `utsushi.snapshot.restore_unsupported`.
    RestoreUnsupported { inspectable_id: String },

    /// Snapshot vs port inspectable id mismatch.
    InspectableIdMismatch { expected: String, found: String },

    /// `diff_snapshots` saw two snapshots with different
    /// inspectable ids.
    DiffInspectableIdMismatch { left: String, right: String },

    /// A field path inside the serialized snapshot or state tree
    /// matched `looks_like_local_path`.
    RedactionViolation { field_path: String },

    /// A `BytesValue` carried a sample longer than
    /// `BYTES_SAMPLE_HEX_LEN`, a hash of wrong length, or a
    /// non-hex digest character.
    InvalidBytesValue { field_path: String, reason: String },

    /// Serialized snapshot exceeded
    /// `SNAPSHOT_MAX_SERIALIZED_BYTES`.
    SnapshotTooLarge { size: usize, ceiling: usize },

    /// Serialized state tree exceeded
    /// `STATE_TREE_MAX_SERIALIZED_BYTES`.
    StateTreeTooLarge { size: usize, ceiling: usize },

    /// Snapshot was constructed with `evidence_tier > E3`.
    EvidenceTierOverclaim { claimed: EvidenceTier, ceiling: EvidenceTier },
}

impl SnapshotError {
    pub fn semantic_code(&self) -> &'static str {
        match self {
            Self::SchemaVersionMismatch { .. } => "utsushi.snapshot.schema_version_mismatch",
            Self::InvalidStatePath { .. } => "utsushi.snapshot.invalid_state_path",
            Self::UnknownStateNamespace { .. } => "utsushi.snapshot.unknown_state_namespace",
            Self::DuplicateStatePath { .. } => "utsushi.snapshot.duplicate_state_path",
            Self::RestoreStatePathUnknown { .. } => "utsushi.snapshot.restore_state_path_unknown",
            Self::RestoreTypeMismatch { .. } => "utsushi.snapshot.restore_type_mismatch",
            Self::RestoreValueOutOfRange { .. } => "utsushi.snapshot.restore_value_out_of_range",
            Self::RestoreUnsupported { .. } => "utsushi.snapshot.restore_unsupported",
            Self::InspectableIdMismatch { .. } => "utsushi.snapshot.inspectable_id_mismatch",
            Self::DiffInspectableIdMismatch { .. } => "utsushi.snapshot.diff_inspectable_id_mismatch",
            Self::RedactionViolation { .. } => "utsushi.snapshot.redaction_violation",
            Self::InvalidBytesValue { .. } => "utsushi.snapshot.invalid_bytes_value",
            Self::SnapshotTooLarge { .. } => "utsushi.snapshot.snapshot_too_large",
            Self::StateTreeTooLarge { .. } => "utsushi.snapshot.state_tree_too_large",
            Self::EvidenceTierOverclaim { .. } => "utsushi.snapshot.evidence_tier_overclaim",
        }
    }
}

impl std::error::Error for SnapshotError {}
```

`SnapshotError: std::error::Error + Send + Sync + 'static`, converts to
`Box<dyn std::error::Error>` so it lives inside `UtsushiResult<T>`.

The `codes::*` module in `snapshot::diagnostics` exposes
`pub const ALL: &[&str] = &[...]` so the conformance schema package and
`just schema` can verify the `utsushi.snapshot.*` prefix is registered
without retrofitting later (mirrors the UTSUSHI-022 pre-allocation
precedent for `utsushi.sink.*` and UTSUSHI-026's `utsushi.conformance.*`).

**No silent best-effort path exists.** A restore that runs into anything
unexpected returns a typed `SnapshotError` variant. The contract has no
"return `Ok(())` and log a warning" branch.

## 10. Test plan

Behavior-first names per `docs/testing-standard.md`. Unit tests live under
`crates/utsushi-core/src/snapshot/{state,snapshot,inspectable,diff,redaction,diagnostics}.rs`
with `#[cfg(test)] mod tests`. Integration tests live under
`crates/utsushi-core/tests/snapshot_*.rs`.

### 10.1 `StatePath` and `StateValue`

- `state_path_parses_valid_dotted_segments_into_canonical_form()`.
- `state_path_rejects_empty_path_with_invalid_state_path_error()`.
- `state_path_rejects_uppercase_segment_with_invalid_state_path_error()`.
- `state_path_rejects_more_than_max_segments_with_invalid_state_path_error()`.
- `state_path_rejects_path_longer_than_max_bytes()`.
- `state_path_rejects_unknown_top_level_namespace()`.
- `state_path_rejects_segment_containing_host_path_shape()`.
- `state_value_string_serializes_with_value_kind_tag()`.
- `state_value_string_with_local_path_fails_redaction_on_validate()`.
- `state_value_int_round_trips_through_serde_json()`.
- `state_value_asset_id_uses_vfs_scheme_string_in_wire_form()`.
- `state_value_bytes_requires_full_length_hash()`.
- `state_value_bytes_caps_sample_hex_at_documented_length()`.
- `state_value_bytes_diff_compares_on_hash_not_sample_hex()`.
- `state_value_tick_round_trips_through_serde_json()`.
- `state_value_nested_serializes_entries_in_sorted_key_order()`.

### 10.2 `StateTree`

- `state_tree_insert_canonicalises_path_and_rejects_duplicates()`.
- `state_tree_validate_rejects_value_carrying_host_path()`.
- `state_tree_validate_rejects_serialized_form_exceeding_ceiling()`.
- `state_tree_iter_returns_paths_in_sorted_order()` — load-bearing for
  deterministic serialization.
- `state_tree_serialized_form_passes_reject_unredacted_local_paths()`.

### 10.3 `Snapshot`

- `snapshot_validate_accepts_well_formed_snapshot_at_e2()`.
- `snapshot_validate_rejects_evidence_tier_above_e3()`.
- `snapshot_validate_rejects_empty_state_tree()`.
- `snapshot_from_json_value_rejects_mismatched_schema_version()`.
- `snapshot_round_trips_through_serde_json()`.
- `snapshot_to_json_value_passes_reject_unredacted_local_paths()`.
- `snapshot_serialized_form_stays_under_documented_ceiling()`.
- `snapshot_does_not_expose_state_tree_mut_accessor()` — `compile_fail` test
  asserting `snapshot.state_tree_mut()` does not exist.
- `snapshot_ref_round_trips_id_inspectable_id_and_tier_only()`.

### 10.4 `take_snapshot`

- `take_snapshot_from_fixture_inspectable_returns_validated_snapshot()`.
- `take_snapshot_derives_id_deterministically_from_run_id_when_unset()`.
- `take_snapshot_rejects_inspectable_that_produces_invalid_state_tree()`.
- `take_snapshot_requires_caller_supplied_generated_at_rfc3339_string()`.
- `take_snapshot_does_not_call_system_time_now()` — structural assertion
  (compile-check via test that runs under a fake-time wrapper, or a
  documented review note in the impl).

### 10.5 `restore_snapshot`

- `restore_snapshot_round_trip_produces_equal_snapshot_on_re_take()` —
  the headline determinism claim from §1.
- `restore_snapshot_with_mismatched_inspectable_id_returns_typed_error()`.
- `restore_snapshot_with_unknown_state_path_returns_restore_state_path_unknown()`.
- `restore_snapshot_with_wrong_type_returns_restore_type_mismatch()`.
- `restore_snapshot_with_out_of_range_value_returns_restore_value_out_of_range()`.
- `restore_snapshot_on_inspect_only_port_returns_restore_unsupported()`.
- `restore_snapshot_with_old_schema_version_returns_schema_version_mismatch()`.

### 10.6 `diff_snapshots`

- `diff_of_equal_snapshots_is_empty()`.
- `diff_identifies_changed_path_for_single_int_modification()` — load-bearing
  audit-focus assertion.
- `diff_identifies_added_path_when_after_has_new_value()`.
- `diff_identifies_removed_path_when_after_drops_value()`.
- `diff_with_mismatched_inspectable_id_returns_typed_error()`.
- `diff_changes_are_sorted_by_path_string()`.
- `diff_serialized_form_passes_reject_unredacted_local_paths()`.
- `diff_modified_kind_carries_both_old_and_new_values_for_typed_inspection()`.

### 10.7 Fixture-driven round-trip determinism (integration)

A new integration test
`crates/utsushi-core/tests/snapshot_round_trip.rs`:

- `fixture_inspectable_round_trip_produces_equal_state_tree()`:
  - Build an in-test `FixtureInspectable` implementing both `Inspectable`
    and `Restorable`. It holds a small `StateTree` (a clock tick, a bridge
    unit cursor, a port-scoped frame counter, an `AssetId` reference, and
    one `Nested` group).
  - Take snapshot A.
  - Mutate the fixture (advance the clock, change the bridge cursor, swap
    the asset id).
  - Restore from A.
  - Take snapshot B.
  - Assert `A == B` (via `Snapshot::PartialEq` and via byte-level JSON
    equality after `to_json_value`).

- `fixture_inspectable_round_trip_replay_emits_equal_observation_sequence()`:
  - With UTSUSHI-021's `ReplayLog` in hand (constructed in-test), drive the
    fixture, take a snapshot at tick T, mutate, restore from the snapshot,
    replay the tail of the log from T onward, and assert the observation
    sequence emitted matches the original from-zero replay tail. This is
    the determinism-with-replay claim from §1 and the UTSUSHI-021
    coordination call-out.

### 10.8 Conformance failure path (integration)

A second integration test
`crates/utsushi-core/tests/snapshot_state_drift.rs`:

- `mutated_state_produces_diff_naming_the_drifted_state_path()`:
  - Take snapshot A.
  - Mutate exactly one state path (e.g. `port.frame`).
  - Take snapshot B.
  - Diff A and B.
  - Assert `diff.changes.len() == 1`.
  - Assert `diff.changes[0].path.as_str() == "port.frame"`.
  - Assert `diff.changes[0].kind` is `Modified { old, new }` with the
    correct typed values.

### 10.9 Redaction (integration)

`crates/utsushi-core/tests/snapshot_redaction.rs`:

- `snapshot_payload_does_not_contain_temp_path_after_inspectable_emits_one()`:
  - Build an `Inspectable` that tries to insert
    `StateValue::String { value: "/tmp/secret" }` under
    `port.cache_dir`. Assert `inspect_state` (or
    `take_snapshot`) returns `SnapshotError::RedactionViolation`.
- `snapshot_payload_does_not_embed_raw_asset_bytes()`:
  - Try to insert a `StateValue::Bytes` with a 1 KiB `sample_hex`. Assert
    `InvalidBytesValue` on `validate`.
- `snapshot_with_asset_id_references_does_not_embed_asset_bytes()`:
  - Build a snapshot with a `StateValue::AssetId` and assert the serialized
    form contains only `vfs://...` strings, no asset payload bytes, and
    passes `reject_unredacted_local_paths`.

### 10.10 No regression in `utsushi-fixture`

`cargo test -p utsushi-fixture` must pass unchanged. The fixture adapter is
NOT refactored to implement `Inspectable` in this slice (Slice B posture —
follow-up; see §13). No new test is added there. Its existing tests must
continue to pass.

### 10.11 Test placement summary

- Unit tests: `crates/utsushi-core/src/snapshot/{state,snapshot,inspectable,diff,redaction,diagnostics}.rs`.
- Integration tests: `crates/utsushi-core/tests/snapshot_round_trip.rs`,
  `snapshot_state_drift.rs`, `snapshot_redaction.rs`.
- One `compile_fail` doc test asserting `Snapshot` has no `state_tree_mut`
  accessor. (If `trybuild` is declined as policy, replace with a stricter
  documentation comment + a runtime presence test — same posture
  UTSUSHI-020/021 took.)

## 11. Verification commands

```
cargo test -p utsushi-core snapshot
cargo test -p utsushi-core
cargo test -p utsushi-fixture
just schema
just check
```

Reasoning, per the brief:

- `cargo test -p utsushi-core snapshot` is the targeted bar for the new
  module's unit + integration tests.
- `cargo test -p utsushi-core` is the substrate bar — confirms snapshot
  integration does not regress VFS, replay, sink, port, or conformance
  tests.
- `cargo test -p utsushi-fixture` confirms no regression in the fixture
  surface; the additive `snapshot: Option<SnapshotRef>` field on
  `RuntimeRequest` is opt-in and the fixture does not consume it in this
  slice.
- `just schema` validates the schema package, which now includes the
  `utsushi.snapshot.*` semantic-code prefix (pre-registered via
  `codes::ALL`, matching the UTSUSHI-022 / UTSUSHI-026 precedent).
- `just check` (fmt, clippy, schema lint) is the local pre-CI bar.

No `cargo test -p utsushi-snapshot` because no new crate is introduced.

## 12. Risks and unknowns

### 12.1 State-tree taxonomy evolution

The pre-declared top-level namespace set (`runtime`, `replay`, `bridge`,
`vfs`, `port`, `metadata`) is small by design. Adding a new top-level is a
typed enum extension on `StateNamespace`; removing one is a breaking change.
Risk: a future engine needs a root that does not fit any of the six. Most
realistic candidates already fit under `port.*` (the engine-port escape
hatch). Mitigation: review `StateNamespace` at each new port slice
(UTSUSHI-146 is the first real test case); only add new variants when a
port has a concrete need that `port.*` cannot express cleanly.

### 12.2 Binary-blob handling at scale

`StateValue::Bytes` stores hash + bounded sample, never the full payload.
Risk: a port that needs to capture a "large" engine state region (e.g. a
RealLive sel-stack frame at midgame) ends up with a snapshot dominated by
many `Bytes` entries. Mitigation: the substrate caps total serialized size
at `SNAPSHOT_MAX_SERIALIZED_BYTES = 16 KiB`. Ports that need richer
state-region capture must either (a) decompose the region into typed leaves
under their `port.*` subtree, or (b) emit the blob as a `RuntimeArtifact`
under `RuntimeArtifactRoot` and reference it from the snapshot via an
`AssetId` — never embed it. The 16 KiB ceiling forces this decision early,
which is the desired bias.

### 12.3 Cross-engine restore semantics

`restore_snapshot` requires matching `inspectable_id`. Cross-engine
restoration is structurally rejected; the substrate does not pretend to
translate state between engines. UTSUSHI-104 (cross-engine moment index)
may eventually add a translation layer; nothing here forecloses it. Risk:
a tester accidentally feeds a fixture snapshot into a RealLive port. The
typed `InspectableIdMismatch` error makes the mistake immediate and
audit-visible.

### 12.4 `EvidenceRef` extension for state paths

UTSUSHI-028 (snapshot conformance) needs to cite a changed state path in
its `EvidenceRef`. The current `EvidenceRef` enum (UTSUSHI-026) has six
variants; adding a `StatePath { path: String }` variant is a one-line
addition. **Decision deferred to UTSUSHI-028** because conformance owns
that schema. UTSUSHI-023 commits not to require the addition in its own
test surface; the snapshot test plan asserts `StateDiff` correctness
directly, not through `EvidenceRef`. This avoids coupling the substrate
PR to a conformance-schema bump.

### 12.5 Deterministic timestamp

`take_snapshot` requires the caller to supply `generated_at`. The substrate
does NOT call `SystemTime::now()`. Risk: a careless caller passes the wall
clock, defeating determinism for replay. Mitigation: the runner (UTSUSHI-103
template + UTSUSHI-146 port) is responsible for supplying a deterministic
instant (typically derived from the recording's start time + the logical
clock tick). The substrate documents this requirement in its rustdoc and
the test plan asserts the substrate never calls `SystemTime::now()`. This
mirrors the UTSUSHI-021 clock posture.

### 12.6 `SnapshotRef` resolution to full payload

`RuntimeRequest.snapshot` is a `SnapshotRef` (id-only). The full payload is
resolved out of band. UTSUSHI-023 does NOT define a `SnapshotStore` trait
because the first consumer (UTSUSHI-028) and the first port (UTSUSHI-146)
have not yet declared what shape they need. Risk: every consumer reinvents
storage. Mitigation: the `SnapshotRef` shape is the only commitment;
storage is deferred and tracked as a follow-up on UTSUSHI-028 / UTSUSHI-146.
Adding a `SnapshotStore` trait later is purely additive — the
`SnapshotRef` field on `RuntimeRequest` does not change.

### 12.7 Hash algorithm choice

`BytesValue::hash` is a 64-char lowercase hex digest. The substrate does not
mandate a specific algorithm at the type level so the implementation worker
can pick from existing workspace deps (BLAKE3, SHA-256). The choice MUST be
deterministic and the same algorithm MUST be used for every `BytesValue`
in a given Utsushi version. A constant `BYTES_HASH_ALGORITHM: &str` is
serialized as snapshot metadata so a future bump is audit-visible. Risk:
silent algorithm churn between versions. Mitigation: the constant is asserted
on `from_json_value` so an older snapshot with a different algorithm
fails with `SchemaVersionMismatch` rather than silently mis-comparing.

### 12.8 Coordination with UTSUSHI-027 / UTSUSHI-029 / KAIFUU-010

Three other iter-4 nodes are in flight. Only UTSUSHI-023 touches
`utsushi-core/src/snapshot/`. UTSUSHI-027 and UTSUSHI-029 add
`EvidenceRef` variants on the conformance result enum; their additions are
orthogonal to snapshot. KAIFUU-010 is patch-result v0.2 in a sibling crate.
Merge conflicts on `lib.rs` re-exports are additive (one `pub use
snapshot::{...};` line on this side). No shared private type changes.

## 13. Out of scope

- **Snapshot conformance checks** (UTSUSHI-028). UTSUSHI-023 produces the
  primitives (snapshot, restore, diff); UTSUSHI-028 wires them into the
  conformance manifest and result schema.
- **Actual engine-port snapshot implementations**. The fixture adapter does
  not gain `Inspectable` in this slice (matches UTSUSHI-020 / UTSUSHI-022
  Slice A posture). The first real `Inspectable` impl lives in the
  RealLive port (UTSUSHI-146). The in-test `FixtureInspectable` used by
  the integration tests lives in `crates/utsushi-core/tests/` and is not a
  shipped product.
- **Cross-version snapshot migration**. The schema is pinned to
  `SNAPSHOT_SCHEMA_VERSION = "0.1.0-alpha"`. Reading older formats is a
  follow-up node, not part of the alpha substrate.
- **`SnapshotStore` trait**. Storage abstraction is deferred until the
  first downstream consumer (UTSUSHI-028 or UTSUSHI-146) declares its
  shape. `SnapshotRef` is the only commitment here.
- **Restore lifecycle method on `EnginePort`**. UTSUSHI-103's
  `EnginePort` trait is unchanged in this slice. UTSUSHI-028 or
  UTSUSHI-146 will decide whether to add a typed `restore` lifecycle
  stage; this slice provides the substrate they will call into.
- **Snapshot signing, encryption, or compression**. Snapshots are plain
  JSON in this slice. Binary-efficient encodings and integrity envelopes
  are later performance / security concerns, not alpha-substrate ones.
- **WASM embed ABI for snapshots**. UTSUSHI-024 consumes `Snapshot` and
  `SnapshotRef` through the embed boundary; this node designs the
  Rust-side types only.
- **`utsushi-fixture` refactor to implement `Inspectable`**. Mirrors the
  Slice B posture UTSUSHI-020 / UTSUSHI-022 took. Sibling implementation
  slice once Slice A merges.

## 14. Worker scoping

Recommendation: **one implementation slice** owned by a single worker.

Rationale:

- `StatePath`, `StateValue`, `StateTree`, `Snapshot`, `Inspectable`,
  `Restorable`, `restore_snapshot`, and `diff_snapshots` are tightly
  coupled. `StateTree::validate` runs the same redaction walk that
  `Snapshot::validate` runs; `restore_snapshot` calls into the same path
  validators; `diff_snapshots` reuses `StateTree::iter()` semantics. A
  multi-PR split would create cross-PR coupling on shared private
  helpers (`canonicalise_path`, redaction walk, byte-hash construction).
- The fixture adapter is NOT refactored in this slice (mirrors UTSUSHI-020
  / UTSUSHI-022 Slice A posture). The natural follow-up is the fixture
  Slice B (fixture-adapter `Inspectable` + `Restorable` impl) plus the
  RealLive port (UTSUSHI-146), both separately tracked.
- Test surface is moderate: ~40 unit tests, 3 integration files, 1
  `compile_fail` (or substitute). All inside `utsushi-core`. The
  `utsushi-fixture` no-regression bar is satisfied because the request
  field is additive.

Verification (per §11):
`cargo test -p utsushi-core snapshot`,
`cargo test -p utsushi-core`,
`cargo test -p utsushi-fixture`,
`just schema`,
`just check`.

Estimated worker time: medium. The state-value enum + serde plumbing are
mechanical; the heavier work is the round-trip determinism integration
test, the diff identification of exact state paths, and the redaction
integration. Substrate-only; fixture-adapter unchanged.

## Plan ends here.
