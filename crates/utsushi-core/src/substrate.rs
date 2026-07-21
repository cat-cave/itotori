//! Engine-neutral runtime substrate facade.
//!
//! This module is the **single import root** for engine ports and
//! conformance consumers. The narrow public surface re-exported here is
//! the only stable API surface; everything else under
//! `utsushi_core::*` is internal substrate detail subject to change.
//!
//! See `docs/utsushi-substrate-facade.md` for the contract.
//!
//! The facade is **pure aggregation**: every item below is a `pub use`
//! of an existing substrate symbol. No new types, traits, free
//! functions, or schema versions are introduced here. If a downstream
//! consumer needs a helper that does not appear in this module, the
//! correct response is to file a substrate facade revision — not to
//! reach around the facade.
//!
//! The deliberately-excluded surface (engine-implementation helpers
//! conformance internals, crate-private validators) is enumerated in
//! the doc cited above. See §3.2 of `.plan/.md`.

// --- VFS subsystem () -------------------------------------
pub use crate::vfs::{
    AssetBytes, AssetId, AssetKind, AssetMetadata, AssetPackage, AssetSize, CaseRule,
    PackageDescriptor, PackageKind, PackageSource, RuntimeVfs, TraversalKind, VfsError, VfsResult,
};

// --- Clock + input + replay () -----------------------------
pub use crate::clock::{ClockOrigin, LogicalClock, LogicalClockTick};
pub use crate::input::{
    ChoiceIndex, InputError, InputEvent, InputKind, MenuTarget, PointerButton, RawInputCode,
};
pub use crate::replay::{
    REPLAY_LOG_SCHEMA_VERSION, ReplayCursor, ReplayEntry, ReplayLog, ReplayLogBuilder,
    ReplayMetadata, ReplaySchemaVersion,
};

// --- Sink subsystem () -------------------------------------
pub use crate::sink::{
    AudioEvent, AudioEventKind, AudioEventSink, FrameArtifact, FrameArtifactSink, SinkCapability,
    SinkCapabilitySummary, SinkError, SinkKind, SinkResult, SinkSet, TextLine, TextSurfaceSink,
};

// --- Snapshot subsystem () ---------------------------------
pub use crate::snapshot::{
    InMemorySnapshotStore, Inspectable, Restorable, RestoreReport, SNAPSHOT_SCHEMA_VERSION,
    Snapshot, SnapshotError, SnapshotId, SnapshotRef, SnapshotRequest, SnapshotSchemaVersion,
    SnapshotStore, SnapshotStoreError, StateChange, StateChangeKind, StateDiff, StateNamespace,
    StatePath, StateTree, StateValue, diff_snapshots, restore_snapshot, take_snapshot,
};

// --- Embed capability surface () ---------------------------
pub use crate::embed::{EmbedCapability, EmbedCapabilityId, EmbedCapabilityStatus, EmbedError};

// --- Source tagging ------------------------------------------------------
pub use crate::SourceTag;

// --- Conformance manifest + checks (..030) -----------------
pub use crate::conformance::trace_branch::{
    BranchCheckResult, BranchConformanceCheck, GoldenTextEvent, ObservedBranch, ObservedTextEvent,
    TextNormalisation, TraceCheckOptions, TraceCheckResult, TraceConformanceCheck,
};
pub use crate::conformance::{
    CONFORMANCE_SCHEMA_VERSION, CaptureCheckSummary, ConformanceAbiVersion, ConformanceError,
    ConformanceManifest, ConformanceProfile, ConformanceResult, EvidenceRef,
    FrameCaptureConformanceCheck, ProfileExtension, ProfileId, RecordingCheckSummary,
    RecordingConformanceCheck, RecordingMetadata, ResultOutcome, SnapshotConformanceCheck,
    cross_validate_conformance_manifest_against_port_manifest,
    cross_validate_results_against_manifest,
};

// --- Port + sinks bridge (, refactored in ) -
pub use crate::port::{
    CaptureOutcome, EnginePort, EnginePortAdapter, EnginePortError, LifecycleStage, MomentId,
    OPTIONAL_LIFECYCLE_STAGES, PortCapability, PortEnv, PortManifest, PortRequest,
    PortShutdownOutcome, PortShutdownStatus, REQUIRED_LIFECYCLE_STAGES, Runner, RunnerCancellation,
    RunnerObservation, RunnerOutcome,
};

// --- Cross-engine capability parity contract + gate --------------------
//
// The parity contract enumerates the uniform engine-port capability surface
// and the conformance gate makes feature-parity across all engines a
// CI-enforced invariant. Each engine adapter publishes an
// `EngineParityProfile` (its manifest + Pending/NotApplicable declarations);
// `evaluate_parity` is RED when any engine silently lacks a capability a peer
// wires.
pub use crate::port::{
    CAPABILITY_CONTRACT, CapabilityDeclaration, CapabilityStance, EngineParityProfile, ParityError,
    ParityFailure, ParityGap, ParityGapKind, ParityPending, ParityReport, evaluate_parity,
};

// --- Evidence / fidelity tiers (crate root) ---------------------------
// `EvidenceTier` and `FidelityTier` live at the crate root because they
// are the universal axes every substrate slice uses. Re-exported here
// so the facade is self-sufficient for downstream port / conformance
// consumers. `ObservationArtifactRef` and `ObservationBridgeRef` are
// the payload-shape types every sink emits and conformance reader
// consumes.
pub use crate::{EvidenceTier, FidelityTier, ObservationArtifactRef, ObservationBridgeRef};

// --- Redaction policy () -----------------------------------
//
// The redaction filter is exposed through the facade because every
// substrate-emitted artifact (snapshot, replay log, conformance result)
// is required to pass the same filter on the way
// out. Engine ports run the filter on adapter-emitted strings before
// handing them to the substrate.
pub use crate::redaction::reject_unredacted_local_paths;

// Const-assertion block. Pins every facade-re-exported schema version
// constant to its expected literal so a substrate slice that bumps its
// version without revising the facade contract fails the build.
//
// The block is a private `const _: () =...;` so it has no runtime
// cost; the assertion is purely compile-time. The runtime mirror lives
// in `tests/substrate_conformance.rs` case
// `every_facade_exposed_schema_version_is_pinned`.

const _: () = {
    // Conformance result + manifest schema ().
    assert!(const_str_eq(CONFORMANCE_SCHEMA_VERSION, "0.2.0-alpha"));
    // Snapshot envelope schema (, bumped under ).
    assert!(const_str_eq(SNAPSHOT_SCHEMA_VERSION, "0.2.0-alpha"));
    // Replay log schema ().
    assert!(const_str_eq(REPLAY_LOG_SCHEMA_VERSION, "0.1.0-alpha"));

    // Engine-neutrality: `SourceTag` is the only engine-family axis and
    // its variant set must stay at exactly four engine-neutral values
    // (Browser / Native / Wine / Fixture). A new variant added without
    // revising the facade contract will not compile because the match
    // is exhaustive.
    let check = |tag: SourceTag| -> u8 {
        match tag {
            SourceTag::Browser => 0,
            SourceTag::Native => 1,
            SourceTag::Wine => 2,
            SourceTag::Fixture => 3,
        }
    };
    let _ = check;
};

/// `const` string-equality helper used by the assertion block above.
/// Bytes-equal comparison; no allocation, no panic at runtime.
const fn const_str_eq(left: &str, right: &str) -> bool {
    let left = left.as_bytes();
    let right = right.as_bytes();
    if left.len() != right.len() {
        return false;
    }
    let mut index = 0;
    while index < left.len() {
        if left[index] != right[index] {
            return false;
        }
        index += 1;
    }
    true
}
