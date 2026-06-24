//! Inspectable state and snapshot primitives (UTSUSHI-023).
//!
//! Engine-neutral substrate for inspectable runtime state and
//! controlled-playback snapshots. Provides:
//!
//! - [`Snapshot`] — an immutable, validated payload that captures the state
//!   of a controlled-playback session.
//! - [`take_snapshot`] / [`restore_snapshot`] / [`diff_snapshots`] — the
//!   three operations the substrate exposes.
//! - [`Inspectable`] / [`Restorable`] — engine-port-facing traits whose
//!   implementors expose and consume state-tree fields.
//! - [`StateTree`] / [`StatePath`] / [`StateValue`] — the engine-neutral
//!   state-tree taxonomy.
//! - [`StateDiff`] / [`StateChange`] / [`StateChangeKind`] — path-keyed
//!   diff over two snapshots.
//! - [`SnapshotError`] — typed, semantic-coded diagnostics. The
//!   substrate has no silent best-effort branch.
//!
//! The substrate satisfies three claims downstream consumers can
//! mechanically falsify:
//!
//! 1. **Round-trip determinism** — snapshot → restore → snapshot is byte-
//!    equal on the canonical serialized form. The integration test
//!    `tests/snapshot_round_trip.rs` asserts this against a fixture
//!    `Inspectable + Restorable` implementation.
//! 2. **Path-keyed diff** — every `StateChange` carries the full
//!    `StatePath`. The integration test `tests/snapshot_state_drift.rs`
//!    asserts the diff names the drifted path verbatim.
//! 3. **Redacted payload** — the serialized snapshot passes
//!    `reject_unredacted_local_paths` at three layers (path parse, leaf
//!    insert, serialized-form walk). Asset references use [`crate::AssetId`]
//!    only. The integration test `tests/snapshot_redaction.rs` asserts
//!    every layer.
//!
//! ## Engine-port escape hatch
//!
//! Engine ports add their port-specific fields under [`StateNamespace::Port`]
//! (`port.*`). The substrate pre-declares six namespaces total: `runtime`,
//! `replay`, `bridge`, `vfs`, `port`, `metadata`. Unknown namespaces are
//! rejected at parse time; adding a new namespace is an additive enum
//! extension reviewed once per port slice.
//!
//! ## Coordination with UTSUSHI-021 logical clock
//!
//! `StateValue::Tick` exposes [`crate::LogicalClockTick`] as a typed leaf
//! so the state tree can name `runtime.clock.tick` semantically. The
//! `ClockOrigin::SnapshotRestore` variant exists explicitly for this
//! substrate.

pub mod diagnostics;
pub mod diff;
pub mod envelope;
pub mod inspectable;
pub mod redaction;
#[allow(clippy::module_inception)]
pub mod snapshot;
pub mod state;
pub mod store;

pub use diagnostics::SnapshotError;
pub use diff::{StateChange, StateChangeKind, StateDiff, diff_snapshots};
pub use envelope::{SnapshotEnvelope, SnapshotManifest};
pub use inspectable::{Inspectable, Restorable, RestoreReport};
pub use snapshot::{
    MAX_SNAPSHOT_ID_BYTES, SNAPSHOT_EVIDENCE_TIER_CEILING, SNAPSHOT_SCHEMA_VERSION, Snapshot,
    SnapshotId, SnapshotRef, SnapshotRequest, SnapshotSchemaVersion, restore_snapshot,
    take_snapshot,
};
pub use state::{
    BYTES_HASH_HEX_LEN, BYTES_SAMPLE_HEX_LEN, BytesValue, MAX_STATE_PATH_BYTES,
    MAX_STATE_PATH_SEGMENTS, StateNamespace, StatePath, StateTree, StateValue,
};
pub use store::{InMemorySnapshotStore, SnapshotStore, SnapshotStoreError};
