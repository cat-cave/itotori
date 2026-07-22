use std::any::Any;
use std::fs;
use std::io::Read;
use std::panic::{self, AssertUnwindSafe};
use std::path::{Path, PathBuf};
use std::process::{Command, ExitStatus, Stdio};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;
use std::thread;
use std::time::{Duration, Instant};

#[cfg(test)]
use serde::Deserialize;
use serde_json::Value;

pub mod clock;
pub mod conformance;
pub mod embed;
pub mod input;
mod observation;
pub mod port;
pub mod replay;
mod runtime_artifact;
mod runtime_capability;
#[path = "lib/runtime_process.rs"]
mod runtime_process;
mod runtime_request;
pub mod sink;
pub mod snapshot;
mod source_tag;
pub mod substrate;
pub mod vfs;

pub use clock::{ClockOrigin, LogicalClock, LogicalClockTick};
pub use conformance::{
    ArtifactCountRange, CONFORMANCE_SCHEMA_VERSION, CaptureCheckSummary, ConformanceAbiVersion,
    ConformanceError, ConformanceManifest, ConformanceProfile, ConformanceResult, DurationRangeMs,
    EvidenceRef, FrameArtifactRef as CaptureFrameArtifactRef, FrameCaptureConformanceCheck,
    ProfileExtension, ProfileId, RecordingCheckSummary, RecordingConformanceCheck,
    RecordingMetadata, ResultOutcome, SnapshotConformanceCheck, SubsystemRequirement,
    cross_validate_conformance_manifest_against_port_manifest,
    cross_validate_results_against_manifest,
    trace_branch::{
        BranchCheckOptions, BranchCheckResult, BranchConformanceCheck, BranchMismatch,
        BranchMismatchKind, GoldenBranch, GoldenTextEvent, ObservedBranch, ObservedTextEvent,
        TextNormalisation, TraceCheckOptions, TraceCheckResult, TraceConformanceCheck,
        TraceMismatch, TraceMismatchKind,
    },
    unsupported_frame_capture_result, unsupported_recording_capture_result,
    unsupported_snapshot_restore_result,
};
// MV/MZ branch coverage read model (data-only join of runtime
// trace observations + Itotori route maps → per-branch coverage status).
pub use conformance::branch_coverage::{
    BRANCH_COVERAGE_READ_MODEL_SCHEMA_VERSION, BranchCoverageError, BranchCoverageFixture,
    BranchCoverageFixtureError, BranchCoverageReadModel, BranchCoverageRecord,
    BranchCoverageSummary, BranchTraceObservation, CoverageStatus, RouteMapEntry,
    derive_coverage_status, join_branch_coverage,
    read_model_from_json as branch_coverage_read_model_from_json,
};
// branch-coverage GAP FINDING emitter (data-only; reads the
// read model and emits gap findings for unvisited-reachable
// ambiguous branches, never visited/unreachable).
pub use conformance::branch_coverage_gaps::{
    BRANCH_COVERAGE_GAP_FINDINGS_SCHEMA_VERSION, BranchCoverageGapFinding, BranchCoverageGapReport,
    BranchCoverageGapSummary, GapArtifactLink, GapKind, GapSeverity, HIGH_TEXT_SEVERITY_THRESHOLD,
    emit_branch_coverage_gap_findings, severity_for as branch_coverage_gap_severity_for,
};
// branch-coverage EXPORT artifact (data-only; reshapes the
// read model + gap summaries into a stable JSON
// Markdown export with an INJECTED generated-at for deterministic snapshots).
pub use conformance::branch_coverage_export::{
    BRANCH_COVERAGE_EXPORT_SCHEMA_VERSION, BranchCoverageExport, BranchCoverageExportError,
    BranchCoverageExportGaps, build_branch_coverage_export, render_branch_coverage_markdown,
};
pub use embed::{
    EMBED_MAX_CAPABILITIES, EmbedCapability, EmbedCapabilityId, EmbedCapabilityStatus, EmbedError,
};
pub use input::{
    CLOCK_BACKTRACK_CODE, ChoiceIndex, INPUT_INVALID_PAYLOAD_CODE, INPUT_UNSUPPORTED_KIND_CODE,
    InputError, InputEvent, InputKind, MenuTarget, PointerButton, REPLAY_NON_MONOTONIC_TICK_CODE,
    REPLAY_REDACTION_VIOLATION_CODE, REPLAY_UNSUPPORTED_SCHEMA_VERSION_CODE, RawInputCode,
};
pub use runtime_artifact::{
    RUNTIME_ARTIFACT_ROOT_MARKER, RUNTIME_ARTIFACT_SOFT_BYTE_BUDGET_LABEL,
    RUNTIME_ARTIFACT_URI_ROOT, RuntimeArtifactKind, RuntimeArtifactName, RuntimeArtifactRoot,
    runtime_artifact_uri, validate_runtime_artifact_uri,
};
pub use runtime_capability::{
    ApproximationTier, ControlledPlaybackSession, EvidenceTier, FidelityTier, RuntimeCapability,
    RuntimeCapabilityClass, RuntimeCapabilityContract, RuntimeFeatureStatus, RuntimeFeatureSupport,
    RuntimeOperation, RuntimePlaybackFeature,
};
use runtime_process::{terminate_runtime_process, wait_for_child_exit};
pub use runtime_request::{RuntimeAdapterDescriptor, RuntimeAdapterDiagnostic, RuntimeRequest};
// Crate-private path-segment validator shared by the launch-capture harness.
pub use port::{
    CAPABILITY_CONTRACT, CapabilityDeclaration, CapabilityReason, CapabilityStance, CaptureOutcome,
    DriftKind, EngineParityProfile, EnginePort, EnginePortAdapter, EnginePortError, EnvFieldSchema,
    EnvFieldShape, LifecycleStage, ManifestError, MomentId, OPTIONAL_LIFECYCLE_STAGES, ParityError,
    ParityFailure, ParityGap, ParityGapKind, ParityPending, ParityReport, PortCapability, PortEnv,
    PortManifest, PortRequest, PortShutdownOutcome, PortShutdownStatus, REQUIRED_LIFECYCLE_STAGES,
    Runner, RunnerCancellation, RunnerObservation, RunnerOutcome, evaluate_parity,
};
pub use replay::{
    REPLAY_LOG_SCHEMA_VERSION, ReplayCursor, ReplayEntry, ReplayLog, ReplayLogBuilder,
    ReplayMetadata, ReplaySchemaVersion,
};
pub(crate) use runtime_artifact::validate_artifact_segment;
pub use sink::{
    AudioEvent, AudioEventKind, AudioEventSink, FrameArtifact, FrameArtifactSink, SinkCapability,
    SinkCapabilitySummary, SinkError, SinkKind, SinkResult, SinkSet, TextLine, TextSurfaceSink,
};
pub use snapshot::{
    BYTES_HASH_HEX_LEN, BYTES_SAMPLE_HEX_LEN, BytesValue, InMemorySnapshotStore, Inspectable,
    MAX_STATE_PATH_BYTES, MAX_STATE_PATH_SEGMENTS, Restorable, RestoreReport,
    SNAPSHOT_EVIDENCE_TIER_CEILING, SNAPSHOT_SCHEMA_VERSION, Snapshot, SnapshotEnvelope,
    SnapshotError, SnapshotId, SnapshotManifest, SnapshotRef, SnapshotRequest,
    SnapshotSchemaVersion, SnapshotStore, SnapshotStoreError, StateChange, StateChangeKind,
    StateDiff, StateNamespace, StatePath, StateTree, StateValue, diff_snapshots, restore_snapshot,
    take_snapshot,
};
pub use source_tag::SourceTag;

/// Re-exports for the local-path redaction filter. The helper itself is a
/// crate-private utility used by observation-hook validators and by the sink
/// payload tests. The re-export keeps the public surface
/// narrow — only the `reject_unredacted_local_paths` entry point is exposed
/// — so cross-crate consumers can run the same filter on their own sink
/// emissions without grabbing the rest of the helper module.
pub mod redaction {
    use crate::UtsushiResult;
    use serde_json::Value;

    /// Reject local-path-shaped strings anywhere inside a serialized payload.
    /// Returns the offending JSON path on failure (e.g.
    /// `"textLine.speaker"`).
    pub fn reject_unredacted_local_paths(path: &str, value: &Value) -> UtsushiResult<()> {
        super::reject_unredacted_local_paths(path, value)
    }
}
pub use vfs::{
    AssetArchiveReader, AssetBytes, AssetId, AssetIdErrorReason, AssetKind, AssetMetadata,
    AssetPackage, AssetRef, AssetSize, CaseFoldedIndex, CaseFoldedIndexEntry, CaseRule,
    CompositeAssetPackage, CompositeSource, HelperId, IoSummary, MountedVfs, PackageDescriptor,
    PackageKind, PackageSource, PlaintextDirPackage, RequiredCapability, ResourceBoundKind,
    RuntimeVfs, TransformKind, TraversalKind, VfsError, VfsResult,
};

/// Crate-private re-export so the `replay` module can reuse the redaction
/// helper without duplicating it.
pub(crate) fn reject_unredacted_local_paths_public(path: &str, value: &Value) -> UtsushiResult<()> {
    reject_unredacted_local_paths(path, value)
}

/// Crate-private re-export so the `replay` module can reuse the path-shape
/// heuristic that the existing observation-hook validator uses.
pub(crate) fn looks_like_local_path_public(value: &str) -> bool {
    looks_like_local_path(value)
}

/// Crate-wide result whose error is intentionally the boxed trait object.
///
/// `utsushi-core` is the runtime substrate: a single call chain mixes
/// `std::io::Error`, `serde_json::Error`, the crate's own typed errors
/// (`SinkError`, `InputError`, `VfsError`, `SnapshotError`, `EnginePortError`
/// `ConformanceError`, …) and JSON-shape validation messages. Boxing is the
/// correct heterogeneous-boundary choice: a single closed enum spanning all of
/// those subsystems would be a churn magnet that no caller matches on in full.
/// Each subsystem keeps its own typed error; those are boxed into this alias
/// via `?`/`From` at the boundary.
pub type UtsushiResult<T> = Result<T, Box<dyn std::error::Error>>;

/// Shared cross-validator semantic code emitted when an observation-hook
/// runtime-evidence timestamp is not a valid RFC3339 date-time instant.
///
/// This matches the Kaifuu Rust and localization-bridge-schema TypeScript
/// validators. See `docs/contracts/rfc3339-instant-acceptance.md`.
pub const SEMANTIC_RFC3339_INSTANT_MALFORMED: &str = "itotori.contract.rfc3339_instant_malformed";

/// Typed observation-hook runtime-evidence validation rejection.
///
/// The runtime-evidence validator otherwise uses the crate-wide heterogeneous
/// [`UtsushiResult`] boundary. This type preserves a stable semantic code for
/// timestamp rejections, so callers do not need to parse its display message.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ObservationHookValidationError {
    code: &'static str,
    field: String,
    message: String,
}

impl ObservationHookValidationError {
    fn malformed_rfc3339_instant(field: &str) -> Self {
        Self {
            code: SEMANTIC_RFC3339_INSTANT_MALFORMED,
            field: field.to_string(),
            message: format!(
                "observation hook event field {field} must be a valid RFC3339 timestamp instant"
            ),
        }
    }

    /// Stable semantic code for this rejection.
    #[must_use]
    pub fn code(&self) -> &'static str {
        self.code
    }

    /// Runtime-evidence field that failed validation.
    #[must_use]
    pub fn field(&self) -> &str {
        &self.field
    }
}

impl std::fmt::Display for ObservationHookValidationError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(formatter, "{}: {}", self.code, self.message)
    }
}

impl std::error::Error for ObservationHookValidationError {}

// the legacy `deleted-hook-envelope` enum + its schema version
// constant were deleted along with the typed observation-hook envelope. The
// engine-port substrate now drives observation via the sink-set bridge in
// `crate::sink::SinkSet`; the wire-shape `observationHookEvents` array
// remains a `kaifuu-core` contract surface (validated independently of any
// `utsushi-core` Rust type).

const DEFAULT_HARNESS_TIMEOUT: Duration = Duration::from_secs(30);
const DEFAULT_HARNESS_SHUTDOWN_GRACE: Duration = Duration::from_secs(2);
const DEFAULT_HARNESS_HOOK_TIMEOUT: Duration = Duration::from_secs(5);
const DEFAULT_HARNESS_POLL_INTERVAL: Duration = Duration::from_millis(10);

// Observation metadata + runtime-evidence validation (bodies in `observation`).
pub(crate) use observation::reject_unredacted_local_paths;
#[cfg(test)]
pub(crate) use observation::validate_rfc3339_instant_metadata;
pub use observation::{
    ObservationAdapterId, ObservationArtifactRef, ObservationBridgeRef, ObservationEnvironment,
    ObservationRedactionMetadata, ObservationRedactionStatus, ObservationSourceRevision,
    looks_like_local_path, validate_runtime_evidence_report_value,
};

#[path = "lib/runtime_capture.rs"]
mod runtime_capture;
pub use runtime_capture::{
    CaptureWriteFence, RuntimeAdapter, RuntimeAdapterRegistry, RuntimeCaptureArtifactStore,
    RuntimeCaptureBoundary, RuntimeCaptureContext, RuntimeCaptureHook, RuntimeCaptureHooks,
    RuntimeCapturedArtifact, RuntimeHarnessError, RuntimeHarnessErrorKind,
    RuntimeLaunchCaptureHarness, RuntimeLaunchCaptureOutcome, RuntimeLaunchCapturePlan,
    RuntimeLaunchCommand, RuntimeProcessCleanup, RuntimeProcessCleanupScope, RuntimeProcessExit,
};

pub fn write_json(path: &Path, value: &Value) -> UtsushiResult<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::write(path, format!("{}\n", serde_json::to_string_pretty(value)?))?;
    Ok(())
}

fn unsupported_operation(
    descriptor: &RuntimeAdapterDescriptor,
    operation: RuntimeOperation,
) -> String {
    format!(
        "runtime adapter {} does not support {}",
        descriptor.name,
        operation.as_str()
    )
}

#[cfg(test)]
#[path = "lib/tests.rs"]
mod tests;
