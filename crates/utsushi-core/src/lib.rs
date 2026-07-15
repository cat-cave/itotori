use std::any::Any;
use std::fs;
use std::io::{self, Read};
use std::panic::{self, AssertUnwindSafe};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, ExitStatus, Stdio};
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
pub mod recorder;
pub mod replay;
mod runtime_artifact;
mod runtime_capability;
mod runtime_request;
pub mod sink;
pub mod snapshot;
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
pub use recorder::{
    InMemoryReferenceRecorder, REFERENCE_TRACE_SCHEMA_VERSION, RecordingTextSink,
    ReferenceRecorder, ReferenceTrace, SourceTag, deterministic_json_bytes,
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

/// The one deliberate, scoped browser-engine exception to the workspace's
/// "no shipped `Command::new`" port posture.
///
/// `to_command` builds the `std::process::Command::new(&self.program)` spawn
/// that drives the MV/MZ browser runtime-evidence adapter
/// (`BrowserLaunchAdapter` in `utsushi-fixture`/`launch_adapters.rs`
/// registered as a production adapter in `utsushi-cli`). RPG Maker MV/MZ games
/// are browser/NW.js JavaScript games with no proprietary opcode VM, so
/// launching a real headless Chromium runs the actual engine rather than a
/// from-scratch mimic — the faithful runtime for a browser game is the
/// browser. This is the ONLY shipped external-process spawn: every other
/// `Command::new` in the workspace is a `#[cfg(test)]` dev-oracle that
/// re-launches `current_exe()` or an integration-test binary invocation, and
/// every other `kaifuu`/`utsushi` engine module retains its
/// no-`Command::new`, in-process-Rust rule.
///
/// See `docs/dev/architecture.md` ("MV/MZ runtime evidence: real-Chromium
/// policy") for the full decided policy and its scope boundary.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RuntimeLaunchCommand {
    pub program: PathBuf,
    pub args: Vec<String>,
    pub current_dir: Option<PathBuf>,
    pub env: Vec<(String, String)>,
}

impl RuntimeLaunchCommand {
    pub fn new(program: impl Into<PathBuf>) -> Self {
        Self {
            program: program.into(),
            args: Vec::new(),
            current_dir: None,
            env: Vec::new(),
        }
    }

    pub fn arg(mut self, arg: impl Into<String>) -> Self {
        self.args.push(arg.into());
        self
    }

    pub fn args<I, S>(mut self, args: I) -> Self
    where
        I: IntoIterator<Item = S>,
        S: Into<String>,
    {
        self.args.extend(args.into_iter().map(Into::into));
        self
    }

    pub fn current_dir(mut self, current_dir: impl Into<PathBuf>) -> Self {
        self.current_dir = Some(current_dir.into());
        self
    }

    pub fn env(mut self, key: impl Into<String>, value: impl Into<String>) -> Self {
        self.env.push((key.into(), value.into()));
        self
    }

    fn to_command(&self) -> Command {
        let mut command = Command::new(&self.program);
        command
            .args(&self.args)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        if let Some(current_dir) = &self.current_dir {
            command.current_dir(current_dir);
        }
        for (key, value) in &self.env {
            command.env(key, value);
        }
        command
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RuntimeLaunchCapturePlan {
    pub run_id: String,
    pub operation: RuntimeOperation,
    pub command: RuntimeLaunchCommand,
    pub timeout: Duration,
    pub shutdown_grace: Duration,
    pub hook_timeout: Duration,
    pub poll_interval: Duration,
    pub artifact_root: Option<PathBuf>,
    /// When set, the harness pipes the launched process's stdout and drains
    /// it on a dedicated reader thread, surfacing the captured bytes as
    /// [`RuntimeLaunchCaptureOutcome::stdout`]. This is how the MV/MZ browser
    /// trace probe reads the live post-render DOM (`--dump-dom`) instead of
    /// the fixture-declared text. Off by default so screenshot/capture launches
    /// keep discarding stdout.
    pub capture_stdout: bool,
}

impl RuntimeLaunchCapturePlan {
    pub fn new(
        run_id: impl Into<String>,
        operation: RuntimeOperation,
        command: RuntimeLaunchCommand,
    ) -> Self {
        Self {
            run_id: run_id.into(),
            operation,
            command,
            timeout: DEFAULT_HARNESS_TIMEOUT,
            shutdown_grace: DEFAULT_HARNESS_SHUTDOWN_GRACE,
            hook_timeout: DEFAULT_HARNESS_HOOK_TIMEOUT,
            poll_interval: DEFAULT_HARNESS_POLL_INTERVAL,
            artifact_root: None,
            capture_stdout: false,
        }
    }

    /// Enable draining and capturing the launched process's stdout. Used by
    /// the browser trace probe to read the live `--dump-dom` output.
    pub fn with_stdout_capture(mut self, capture_stdout: bool) -> Self {
        self.capture_stdout = capture_stdout;
        self
    }

    pub fn with_timeout(mut self, timeout: Duration) -> Self {
        self.timeout = timeout;
        self
    }

    pub fn with_shutdown_grace(mut self, shutdown_grace: Duration) -> Self {
        self.shutdown_grace = shutdown_grace;
        self
    }

    pub fn with_hook_timeout(mut self, hook_timeout: Duration) -> Self {
        self.hook_timeout = hook_timeout;
        self
    }

    pub fn with_poll_interval(mut self, poll_interval: Duration) -> Self {
        self.poll_interval = poll_interval;
        self
    }

    pub fn with_artifact_root(mut self, artifact_root: impl Into<PathBuf>) -> Self {
        self.artifact_root = Some(artifact_root.into());
        self
    }

    fn validate(&self) -> Result<(), RuntimeHarnessError> {
        if let Err(error) = validate_artifact_segment("run id", &self.run_id) {
            return Err(RuntimeHarnessError::new(
                RuntimeHarnessErrorKind::InvalidPlan,
                self.operation,
                format!("invalid runtime harness run id: {error}"),
            ));
        }
        if self.command.program.as_os_str().is_empty() {
            return Err(RuntimeHarnessError::new(
                RuntimeHarnessErrorKind::InvalidPlan,
                self.operation,
                "runtime launch command program must not be empty",
            ));
        }
        if self.timeout.is_zero() {
            return Err(RuntimeHarnessError::new(
                RuntimeHarnessErrorKind::InvalidPlan,
                self.operation,
                "runtime launch timeout must be greater than zero",
            ));
        }
        if self.shutdown_grace.is_zero() {
            return Err(RuntimeHarnessError::new(
                RuntimeHarnessErrorKind::InvalidPlan,
                self.operation,
                "runtime launch shutdown grace must be greater than zero",
            ));
        }
        if self.hook_timeout.is_zero() {
            return Err(RuntimeHarnessError::new(
                RuntimeHarnessErrorKind::InvalidPlan,
                self.operation,
                "runtime capture hook timeout must be greater than zero",
            ));
        }
        if self.poll_interval.is_zero() {
            return Err(RuntimeHarnessError::new(
                RuntimeHarnessErrorKind::InvalidPlan,
                self.operation,
                "runtime launch poll interval must be greater than zero",
            ));
        }
        Ok(())
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum RuntimeCaptureBoundary {
    AfterLaunch,
    BeforeTerminate,
    AfterExit,
}

impl RuntimeCaptureBoundary {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::AfterLaunch => "after_launch",
            Self::BeforeTerminate => "before_terminate",
            Self::AfterExit => "after_exit",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum RuntimeHarnessErrorKind {
    InvalidPlan,
    LaunchFailed,
    Timeout,
    ProcessFailed,
    ProcessWaitFailed,
    ProcessCleanupFailed,
    CaptureTimeout,
    CaptureFailed,
    /// a capture hook worker attempted to write a managed runtime
    /// artifact after the capture boundary closed (the hook timed out or
    /// `launch-capture` already returned). The write fence refuses the mutation
    /// so a detached, still-running hook worker cannot corrupt managed artifact
    /// state after completion. Semantic code: `runtime_capture_boundary_closed`.
    /// Distinct from `CaptureTimeout` so a fenced late write is distinguishable
    /// from the normal timeout diagnostic.
    CaptureBoundaryClosed,
    ArtifactStoreUnavailable,
    ArtifactWriteFailed,
    /// Browser-launch path could not locate a Chromium-compatible binary.
    ///
    /// Reported when neither an explicitly configured browser, the
    /// `UTSUSHI_BROWSER_BIN` env override, the PATH lookup, nor the
    /// platform-specific install-path fallback yields a launchable executable.
    /// The semantic code attached to the harness error is
    /// `utsushi.browser.chromium_unavailable`.
    ChromiumUnavailable,
    /// Browser-launch path detected a Chromium binary whose major version is
    /// below the minimum supported floor. Semantic code:
    /// `utsushi.browser.chromium_version_mismatch`.
    ChromiumVersionMismatch,
    /// Browser-launch path could not reach a usable display surface under
    /// strict display checking. Produced by the strict-display probe
    /// () when the operator opts into the `UTSUSHI_STRICT_DISPLAY`
    /// activation gate and no usable display surface is detected; off by
    /// default. Semantic code: `utsushi.browser.display_unavailable`.
    ChromiumDisplayUnavailable,
    /// Adapter is research-tier and not advertised as alpha capability;
    /// invoking trace/capture/smoke returns this kind. Semantic code:
    /// `utsushi.runtime.research_tier_unsupported`.
    ResearchTierUnsupported,
}

impl RuntimeHarnessErrorKind {
    pub fn code(self) -> &'static str {
        match self {
            Self::InvalidPlan => "runtime_harness_invalid_plan",
            Self::LaunchFailed => "runtime_launch_failed",
            Self::Timeout => "runtime_launch_timeout",
            Self::ProcessFailed => "runtime_process_failed",
            Self::ProcessWaitFailed => "runtime_process_wait_failed",
            Self::ProcessCleanupFailed => "runtime_process_cleanup_failed",
            Self::CaptureTimeout => "runtime_capture_timeout",
            Self::CaptureFailed => "runtime_capture_failed",
            Self::CaptureBoundaryClosed => "runtime_capture_boundary_closed",
            Self::ArtifactStoreUnavailable => "runtime_artifact_store_unavailable",
            Self::ArtifactWriteFailed => "runtime_artifact_write_failed",
            Self::ChromiumUnavailable => "runtime_browser_chromium_unavailable",
            Self::ChromiumVersionMismatch => "runtime_browser_chromium_version_mismatch",
            Self::ChromiumDisplayUnavailable => "runtime_browser_display_unavailable",
            Self::ResearchTierUnsupported => "runtime_research_tier_unsupported",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RuntimeProcessCleanupScope {
    ProcessTree,
}

impl RuntimeProcessCleanupScope {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::ProcessTree => "process_tree",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct RuntimeProcessCleanup {
    pub attempted: bool,
    pub completed: bool,
    pub scope: RuntimeProcessCleanupScope,
    pub escalated: bool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RuntimeHarnessError {
    pub kind: RuntimeHarnessErrorKind,
    pub operation: RuntimeOperation,
    pub message: String,
    pub boundary: Option<RuntimeCaptureBoundary>,
    pub process_id: Option<u32>,
    pub cleanup: Option<RuntimeProcessCleanup>,
    pub details: Vec<(String, String)>,
}

impl RuntimeHarnessError {
    pub fn new(
        kind: RuntimeHarnessErrorKind,
        operation: RuntimeOperation,
        message: impl Into<String>,
    ) -> Self {
        Self {
            kind,
            operation,
            message: message.into(),
            boundary: None,
            process_id: None,
            cleanup: None,
            details: Vec::new(),
        }
    }

    pub fn capture_failed(operation: RuntimeOperation, message: impl Into<String>) -> Self {
        Self::new(RuntimeHarnessErrorKind::CaptureFailed, operation, message)
    }

    pub fn code(&self) -> &'static str {
        self.kind.code()
    }

    pub fn with_boundary(mut self, boundary: RuntimeCaptureBoundary) -> Self {
        self.boundary = Some(boundary);
        self
    }

    pub fn with_process_id(mut self, process_id: u32) -> Self {
        self.process_id = Some(process_id);
        self
    }

    pub fn with_cleanup(mut self, cleanup: RuntimeProcessCleanup) -> Self {
        self.cleanup = Some(cleanup);
        if !cleanup.completed && self.kind != RuntimeHarnessErrorKind::Timeout {
            self.kind = RuntimeHarnessErrorKind::ProcessCleanupFailed;
        }
        self
    }

    pub fn with_detail(mut self, key: impl Into<String>, value: impl Into<String>) -> Self {
        self.details.push((key.into(), value.into()));
        self
    }

    pub fn to_json(&self) -> Value {
        let details = self
            .details
            .iter()
            .map(|(key, value)| (key.clone(), Value::String(value.clone())))
            .collect::<serde_json::Map<_, _>>();
        let mut value = serde_json::Map::new();
        value.insert("errorCode".to_string(), self.code().into());
        value.insert("message".to_string(), self.message.clone().into());
        value.insert("operation".to_string(), self.operation.as_str().into());
        if let Some(boundary) = self.boundary {
            value.insert("boundary".to_string(), boundary.as_str().into());
        }
        if let Some(process_id) = self.process_id {
            value.insert("processId".to_string(), process_id.into());
        }
        if let Some(cleanup) = self.cleanup {
            value.insert(
                "cleanup".to_string(),
                serde_json::json!({
                    "attempted": cleanup.attempted,
                    "completed": cleanup.completed,
                    "scope": cleanup.scope.as_str(),
                    "escalated": cleanup.escalated
                }),
            );
        }
        if !details.is_empty() {
            value.insert("details".to_string(), Value::Object(details));
        }
        Value::Object(value)
    }

    pub fn to_validation_finding(
        &self,
        finding_id: impl Into<String>,
        finding_kind: impl Into<String>,
        severity: impl Into<String>,
        evidence_tier: EvidenceTier,
    ) -> Value {
        serde_json::json!({
            "findingId": finding_id.into(),
            "findingKind": finding_kind.into(),
            "severity": severity.into(),
            "message": format!("{}: {}", self.code(), self.message),
            "evidenceTier": evidence_tier.as_str()
        })
    }
}

impl std::fmt::Display for RuntimeHarnessError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(formatter, "{}: {}", self.code(), self.message)
    }
}

impl std::error::Error for RuntimeHarnessError {}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RuntimeCapturedArtifact {
    pub artifact_id: String,
    pub artifact_kind: RuntimeArtifactKind,
    pub uri: String,
    pub media_type: Option<String>,
    pub byte_size: u64,
    pub path: PathBuf,
    pub boundary: Option<RuntimeCaptureBoundary>,
}

impl RuntimeCapturedArtifact {
    pub fn artifact_ref_json(&self) -> Value {
        let mut value = serde_json::Map::new();
        value.insert("artifactId".to_string(), self.artifact_id.clone().into());
        value.insert(
            "artifactKind".to_string(),
            self.artifact_kind.artifact_kind().into(),
        );
        value.insert("uri".to_string(), self.uri.clone().into());
        if let Some(media_type) = &self.media_type {
            value.insert("mediaType".to_string(), media_type.clone().into());
        }
        value.insert("byteSize".to_string(), self.byte_size.into());
        Value::Object(value)
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RuntimeCaptureArtifactStore {
    root: RuntimeArtifactRoot,
    run_id: String,
}

impl RuntimeCaptureArtifactStore {
    pub fn prepare(
        root: impl Into<PathBuf>,
        run_id: impl Into<String>,
        operation: RuntimeOperation,
    ) -> Result<Self, RuntimeHarnessError> {
        let run_id = run_id.into();
        if let Err(error) = validate_artifact_segment("run id", &run_id) {
            return Err(RuntimeHarnessError::new(
                RuntimeHarnessErrorKind::InvalidPlan,
                operation,
                format!("invalid runtime artifact run id: {error}"),
            ));
        }
        let store = Self {
            root: RuntimeArtifactRoot::new(root.into()),
            run_id,
        };
        store.root.prepare().map_err(|error| {
            RuntimeHarnessError::new(
                RuntimeHarnessErrorKind::ArtifactWriteFailed,
                operation,
                format!("failed to prepare runtime artifact root: {error}"),
            )
        })?;
        Ok(store)
    }

    pub fn root(&self) -> &RuntimeArtifactRoot {
        &self.root
    }

    pub fn write_artifact(
        &self,
        kind: RuntimeArtifactKind,
        artifact_id: impl Into<String>,
        media_type: impl Into<Option<String>>,
        contents: &[u8],
    ) -> UtsushiResult<RuntimeCapturedArtifact> {
        self.write_artifact_with_extension(
            kind,
            artifact_id,
            kind.default_extension(),
            media_type,
            contents,
        )
    }

    pub fn write_artifact_with_extension(
        &self,
        kind: RuntimeArtifactKind,
        artifact_id: impl Into<String>,
        extension: impl Into<String>,
        media_type: impl Into<Option<String>>,
        contents: &[u8],
    ) -> UtsushiResult<RuntimeCapturedArtifact> {
        let artifact_id = artifact_id.into();
        let name = RuntimeArtifactName::with_extension(
            &self.run_id,
            kind,
            artifact_id.clone(),
            extension.into(),
        )?;
        let uri = name.uri();
        let path = self.root.write_bytes(&uri, contents)?;
        Ok(RuntimeCapturedArtifact {
            artifact_id,
            artifact_kind: kind,
            uri,
            media_type: media_type.into(),
            byte_size: contents.len() as u64,
            path,
            boundary: None,
        })
    }
}

/// a write fence shared between the launch-capture harness and a
/// spawned capture-hook worker thread.
///
/// A capture hook runs on a detached worker thread (see
/// [`run_capture_hook_with_timeout`]). When the hook times out, the harness
/// stops waiting and `launch-capture` returns, but the worker thread may still
/// be running and still holds a clone of the [`RuntimeCaptureArtifactStore`].
/// Without a fence, that detached worker could write a managed runtime artifact
/// *after* the capture boundary, corrupting managed artifact state
/// (use-after-completion side effect).
///
/// The fence is open while a hook's bounded capture window is valid and is
/// closed at the capture boundary (the moment the harness stops waiting for the
/// hook — completion or timeout). Every managed-artifact write is gated on the
/// fence, so a post-boundary write from a still-running worker is refused
/// (typed [`RuntimeHarnessErrorKind::CaptureBoundaryClosed`], no state
/// mutation) while writes during the valid window still succeed.
#[derive(Clone, Debug)]
pub struct CaptureWriteFence {
    open: Arc<AtomicBool>,
}

impl CaptureWriteFence {
    /// A fresh, open fence: managed-artifact writes are permitted until it is
    /// [`close`](Self::close)d at the capture boundary.
    fn open() -> Self {
        Self {
            open: Arc::new(AtomicBool::new(true)),
        }
    }

    /// Whether managed-artifact writes are currently permitted. Checked before
    /// every write so a late write from a detached worker is refused.
    fn is_open(&self) -> bool {
        self.open.load(Ordering::SeqCst)
    }

    /// Close the fence at the capture boundary. Idempotent; once closed, any
    /// subsequent managed-artifact write through a context sharing this fence
    /// is refused.
    fn close(&self) {
        self.open.store(false, Ordering::SeqCst);
    }
}

impl Default for CaptureWriteFence {
    fn default() -> Self {
        Self::open()
    }
}

pub struct RuntimeCaptureContext {
    pub operation: RuntimeOperation,
    pub boundary: RuntimeCaptureBoundary,
    pub process_id: u32,
    pub run_id: String,
    artifact_store: Option<RuntimeCaptureArtifactStore>,
    artifacts: Vec<RuntimeCapturedArtifact>,
    // gates managed-artifact writes. Shared (cloned) with the
    // harness so the harness can close it at the capture boundary and refuse
    // writes from a detached worker that outlives `launch-capture`.
    write_fence: CaptureWriteFence,
}

impl RuntimeCaptureContext {
    fn new(
        operation: RuntimeOperation,
        boundary: RuntimeCaptureBoundary,
        process_id: u32,
        run_id: impl Into<String>,
        artifact_store: Option<RuntimeCaptureArtifactStore>,
    ) -> Self {
        Self {
            operation,
            boundary,
            process_id,
            run_id: run_id.into(),
            artifact_store,
            artifacts: Vec::new(),
            write_fence: CaptureWriteFence::open(),
        }
    }

    pub fn write_artifact(
        &mut self,
        kind: RuntimeArtifactKind,
        artifact_id: impl Into<String>,
        media_type: impl Into<Option<String>>,
        contents: &[u8],
    ) -> Result<RuntimeCapturedArtifact, RuntimeHarnessError> {
        // refuse writes once the capture boundary has closed. This
        // is checked before touching the store so a detached worker that keeps
        // running after `launch-capture` returns cannot mutate managed artifact
        // state; the refusal carries a distinct code from a normal timeout.
        if !self.write_fence.is_open() {
            return Err(RuntimeHarnessError::new(
                RuntimeHarnessErrorKind::CaptureBoundaryClosed,
                self.operation,
                "capture hook attempted to write a managed runtime artifact after the capture boundary closed; write refused",
            )
            .with_boundary(self.boundary)
            .with_process_id(self.process_id));
        }
        let Some(store) = &self.artifact_store else {
            return Err(RuntimeHarnessError::new(
                RuntimeHarnessErrorKind::ArtifactStoreUnavailable,
                self.operation,
                "capture hook requested artifact storage but no managed runtime artifact root was configured",
            )
            .with_boundary(self.boundary)
            .with_process_id(self.process_id));
        };
        let mut artifact = store
            .write_artifact(kind, artifact_id, media_type, contents)
            .map_err(|error| {
                RuntimeHarnessError::new(
                    RuntimeHarnessErrorKind::ArtifactWriteFailed,
                    self.operation,
                    format!("capture hook failed to write runtime artifact: {error}"),
                )
                .with_boundary(self.boundary)
                .with_process_id(self.process_id)
            })?;
        artifact.boundary = Some(self.boundary);
        self.artifacts.push(artifact.clone());
        Ok(artifact)
    }

    pub fn artifacts(&self) -> &[RuntimeCapturedArtifact] {
        &self.artifacts
    }

    fn into_artifacts(self) -> Vec<RuntimeCapturedArtifact> {
        self.artifacts
    }
}

pub trait RuntimeCaptureHook: Send + 'static {
    fn boundary(&self) -> RuntimeCaptureBoundary;

    fn capture(&mut self, context: &mut RuntimeCaptureContext) -> Result<(), RuntimeHarnessError>;
}

#[derive(Default)]
pub struct RuntimeCaptureHooks {
    hooks: Vec<Box<dyn RuntimeCaptureHook>>,
}

impl RuntimeCaptureHooks {
    pub fn new() -> Self {
        Self { hooks: Vec::new() }
    }

    pub fn push<H>(&mut self, hook: H)
    where
        H: RuntimeCaptureHook,
    {
        self.hooks.push(Box::new(hook));
    }

    pub fn push_boxed(&mut self, hook: Box<dyn RuntimeCaptureHook>) {
        self.hooks.push(hook);
    }

    pub fn is_empty(&self) -> bool {
        self.hooks.is_empty()
    }
}

impl From<Vec<Box<dyn RuntimeCaptureHook>>> for RuntimeCaptureHooks {
    fn from(hooks: Vec<Box<dyn RuntimeCaptureHook>>) -> Self {
        Self { hooks }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct RuntimeProcessExit {
    pub success: bool,
    pub code: Option<i32>,
}

impl RuntimeProcessExit {
    fn from_status(status: ExitStatus) -> Self {
        Self {
            success: status.success(),
            code: status.code(),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RuntimeLaunchCaptureOutcome {
    pub process_id: u32,
    pub exit: RuntimeProcessExit,
    pub elapsed: Duration,
    pub artifacts: Vec<RuntimeCapturedArtifact>,
    /// Captured process stdout, present only when the plan set
    /// [`RuntimeLaunchCapturePlan::capture_stdout`]. Carries the live
    /// post-render DOM for the browser trace probe. Bytes are decoded
    /// lossily as UTF-8.
    pub stdout: Option<String>,
}

#[derive(Clone, Copy)]
struct RuntimeHookRun<'a> {
    plan: &'a RuntimeLaunchCapturePlan,
    process_id: u32,
    artifact_store: Option<&'a RuntimeCaptureArtifactStore>,
}

#[derive(Clone, Debug, Default)]
pub struct RuntimeLaunchCaptureHarness;

impl RuntimeLaunchCaptureHarness {
    pub fn new() -> Self {
        Self
    }

    pub fn run(
        &self,
        plan: &RuntimeLaunchCapturePlan,
        hooks: &mut RuntimeCaptureHooks,
    ) -> Result<RuntimeLaunchCaptureOutcome, RuntimeHarnessError> {
        plan.validate()?;
        let artifact_store = plan
            .artifact_root
            .as_ref()
            .map(|artifact_root| {
                RuntimeCaptureArtifactStore::prepare(
                    artifact_root.clone(),
                    plan.run_id.clone(),
                    plan.operation,
                )
            })
            .transpose()?;

        let started_at = Instant::now();
        let deadline = started_at + plan.timeout;
        let mut command = plan.command.to_command();
        if plan.capture_stdout {
            command.stdout(Stdio::piped());
        }
        configure_runtime_process_tree(&mut command, plan.operation)?;
        let mut child = command.spawn().map_err(|error| {
            RuntimeHarnessError::new(
                RuntimeHarnessErrorKind::LaunchFailed,
                plan.operation,
                format!(
                    "failed to launch runtime command {}: {error}",
                    plan.command.program.display()
                ),
            )
            .with_detail("ioKind", error.kind().to_string())
        })?;
        let process_id = child.id();
        // Drain stdout on a dedicated thread so a large `--dump-dom` payload
        // cannot deadlock the poll-based wait by filling the pipe buffer while
        // the child blocks writing. The buffer is joined only on the success
        // path; on every error path the child is terminated, the pipe closes
        // and the detached reader thread completes on its own.
        let mut stdout_reader: Option<thread::JoinHandle<Vec<u8>>> = if plan.capture_stdout {
            child.stdout.take().map(|mut stdout| {
                thread::spawn(move || {
                    let mut buffer = Vec::new();
                    let _ = stdout.read_to_end(&mut buffer);
                    buffer
                })
            })
        } else {
            None
        };
        let mut artifacts = Vec::new();
        let hook_run = RuntimeHookRun {
            plan,
            process_id,
            artifact_store: artifact_store.as_ref(),
        };

        if let Err(error) = Self::run_hooks(
            RuntimeCaptureBoundary::AfterLaunch,
            hook_run,
            hooks,
            &mut artifacts,
            bounded_hook_timeout(plan, deadline),
        ) {
            let cleanup =
                terminate_runtime_process(&mut child, plan.shutdown_grace, plan.poll_interval);
            return Err(error.with_process_id(process_id).with_cleanup(cleanup));
        }

        let status =
            match wait_for_child_exit(&mut child, remaining_until(deadline), plan.poll_interval) {
                Ok(Some(status)) => status,
                Ok(None) => {
                    let before_terminate_error = Self::run_hooks(
                        RuntimeCaptureBoundary::BeforeTerminate,
                        hook_run,
                        hooks,
                        &mut artifacts,
                        plan.hook_timeout,
                    );
                    let cleanup = terminate_runtime_process(
                        &mut child,
                        plan.shutdown_grace,
                        plan.poll_interval,
                    );
                    let mut error = RuntimeHarnessError::new(
                        RuntimeHarnessErrorKind::Timeout,
                        plan.operation,
                        format!("runtime command exceeded timeout of {:?}", plan.timeout),
                    )
                    .with_process_id(process_id)
                    .with_cleanup(cleanup)
                    .with_detail("timeoutMillis", plan.timeout.as_millis().to_string());
                    if let Err(hook_error) = before_terminate_error {
                        error = error
                            .with_detail("beforeTerminateHookError", hook_error.code())
                            .with_detail("beforeTerminateHookMessage", hook_error.message);
                    }
                    return Err(error);
                }
                Err(error) => {
                    let cleanup = terminate_runtime_process(
                        &mut child,
                        plan.shutdown_grace,
                        plan.poll_interval,
                    );
                    return Err(RuntimeHarnessError::new(
                        RuntimeHarnessErrorKind::ProcessWaitFailed,
                        plan.operation,
                        format!("failed while waiting for runtime process: {error}"),
                    )
                    .with_process_id(process_id)
                    .with_cleanup(cleanup)
                    .with_detail("ioKind", error.kind().to_string()));
                }
            };

        let after_exit_error = Self::run_hooks(
            RuntimeCaptureBoundary::AfterExit,
            hook_run,
            hooks,
            &mut artifacts,
            plan.hook_timeout,
        )
        .err();

        let exit = RuntimeProcessExit::from_status(status);
        if !exit.success {
            let cleanup =
                terminate_runtime_process(&mut child, plan.shutdown_grace, plan.poll_interval);
            if let Some(error) = after_exit_error {
                let mut error = error
                    .with_process_id(process_id)
                    .with_cleanup(cleanup)
                    .with_detail(
                        "processFailure",
                        RuntimeHarnessErrorKind::ProcessFailed.code(),
                    );
                if let Some(code) = exit.code {
                    error = error.with_detail("exitCode", code.to_string());
                }
                return Err(error);
            }
            let mut error = RuntimeHarnessError::new(
                RuntimeHarnessErrorKind::ProcessFailed,
                plan.operation,
                "runtime process exited with a non-zero status",
            )
            .with_process_id(process_id)
            .with_cleanup(cleanup);
            if let Some(code) = exit.code {
                error = error.with_detail("exitCode", code.to_string());
            }
            return Err(error);
        }

        if let Some(error) = after_exit_error {
            return Err(error
                .with_detail("processExit", "success")
                .with_detail("processExitSuccess", "true"));
        }

        let stdout = stdout_reader.take().map(|handle| {
            let bytes = handle.join().unwrap_or_default();
            String::from_utf8_lossy(&bytes).into_owned()
        });

        Ok(RuntimeLaunchCaptureOutcome {
            process_id,
            exit,
            elapsed: started_at.elapsed(),
            artifacts,
            stdout,
        })
    }

    fn run_hooks(
        boundary: RuntimeCaptureBoundary,
        run: RuntimeHookRun<'_>,
        hooks: &mut RuntimeCaptureHooks,
        artifacts: &mut Vec<RuntimeCapturedArtifact>,
        hook_timeout: Duration,
    ) -> Result<(), RuntimeHarnessError> {
        let mut index = 0;
        while index < hooks.hooks.len() {
            if hooks.hooks[index].boundary() != boundary {
                index += 1;
                continue;
            }
            let hook = hooks.hooks.remove(index);
            let context = RuntimeCaptureContext::new(
                run.plan.operation,
                boundary,
                run.process_id,
                run.plan.run_id.clone(),
                run.artifact_store.cloned(),
            );
            match run_capture_hook_with_timeout(hook, context, hook_timeout) {
                Ok((hook, hook_artifacts)) => {
                    artifacts.extend(hook_artifacts);
                    hooks.hooks.insert(index, hook);
                    index += 1;
                }
                Err(RuntimeHookExecutionError::Failed { hook, error }) => {
                    hooks.hooks.insert(index, hook);
                    return Err(error
                        .with_boundary(boundary)
                        .with_process_id(run.process_id));
                }
                Err(RuntimeHookExecutionError::Unrecoverable(error)) => return Err(error),
            }
        }
        Ok(())
    }
}

struct RuntimeHookThreadResult {
    hook: Box<dyn RuntimeCaptureHook>,
    result: Result<Vec<RuntimeCapturedArtifact>, RuntimeHarnessError>,
}

enum RuntimeHookExecutionError {
    Failed {
        hook: Box<dyn RuntimeCaptureHook>,
        error: RuntimeHarnessError,
    },
    Unrecoverable(RuntimeHarnessError),
}

fn run_capture_hook_with_timeout(
    mut hook: Box<dyn RuntimeCaptureHook>,
    mut context: RuntimeCaptureContext,
    timeout: Duration,
) -> Result<(Box<dyn RuntimeCaptureHook>, Vec<RuntimeCapturedArtifact>), RuntimeHookExecutionError>
{
    if timeout.is_zero() {
        return Err(RuntimeHookExecutionError::Unrecoverable(
            capture_hook_timeout_error(
                context.operation,
                context.boundary,
                context.process_id,
                timeout,
            ),
        ));
    }

    let operation = context.operation;
    let boundary = context.boundary;
    let process_id = context.process_id;
    // install a fresh open fence and keep a clone in the harness.
    // The worker thread receives its own clone inside `context`; closing the
    // harness-side handle at the capture boundary flips the shared flag so any
    // later write from a still-running worker is refused.
    let fence = CaptureWriteFence::open();
    context.write_fence = fence.clone();
    let (sender, receiver) = mpsc::channel();
    thread::spawn(move || {
        let result = match panic::catch_unwind(AssertUnwindSafe(|| hook.capture(&mut context))) {
            Ok(Ok(())) => Ok(context.into_artifacts()),
            Ok(Err(error)) => Err(error),
            Err(payload) => Err(RuntimeHarnessError::capture_failed(
                operation,
                format!(
                    "capture hook panicked at {}: {}",
                    boundary.as_str(),
                    panic_payload_message(payload.as_ref())
                ),
            )
            .with_boundary(boundary)
            .with_process_id(process_id)),
        };
        let _ = sender.send(RuntimeHookThreadResult { hook, result });
    });

    let outcome = receiver.recv_timeout(timeout);
    // the capture boundary is crossed the instant the harness stops
    // waiting for the hook (completion OR timeout). Close the fence here so any
    // write the worker attempts after this point is refused, while writes made
    // during the valid in-progress window above still succeeded.
    fence.close();

    match outcome {
        Ok(RuntimeHookThreadResult {
            hook,
            result: Ok(artifacts),
        }) => Ok((hook, artifacts)),
        Ok(RuntimeHookThreadResult {
            hook,
            result: Err(error),
        }) => Err(RuntimeHookExecutionError::Failed { hook, error }),
        Err(mpsc::RecvTimeoutError::Timeout) => Err(RuntimeHookExecutionError::Unrecoverable(
            capture_hook_timeout_error(operation, boundary, process_id, timeout),
        )),
        Err(mpsc::RecvTimeoutError::Disconnected) => Err(RuntimeHookExecutionError::Unrecoverable(
            RuntimeHarnessError::capture_failed(
                operation,
                format!(
                    "capture hook worker stopped before reporting {}",
                    boundary.as_str()
                ),
            )
            .with_boundary(boundary)
            .with_process_id(process_id),
        )),
    }
}

fn capture_hook_timeout_error(
    operation: RuntimeOperation,
    boundary: RuntimeCaptureBoundary,
    process_id: u32,
    timeout: Duration,
) -> RuntimeHarnessError {
    RuntimeHarnessError::new(
        RuntimeHarnessErrorKind::CaptureTimeout,
        operation,
        format!(
            "capture hook at {} exceeded timeout of {:?}",
            boundary.as_str(),
            timeout
        ),
    )
    .with_boundary(boundary)
    .with_process_id(process_id)
    .with_detail("hookTimeoutMillis", timeout.as_millis().to_string())
}

fn panic_payload_message(payload: &(dyn Any + Send)) -> String {
    if let Some(message) = payload.downcast_ref::<&str>() {
        return (*message).to_string();
    }
    if let Some(message) = payload.downcast_ref::<String>() {
        return message.clone();
    }
    "non-string panic payload".to_string()
}

fn bounded_hook_timeout(plan: &RuntimeLaunchCapturePlan, deadline: Instant) -> Duration {
    let remaining = remaining_until(deadline);
    if remaining < plan.hook_timeout {
        remaining
    } else {
        plan.hook_timeout
    }
}

fn remaining_until(deadline: Instant) -> Duration {
    deadline
        .checked_duration_since(Instant::now())
        .unwrap_or(Duration::ZERO)
}

// reason: the return is only infallible on unix (where clippy evaluates this);
// the `#[cfg(not(unix))]` sibling below legitimately returns `Err` because
// process-tree cleanup is unsupported there, so the `Result` is required.
#[cfg(unix)]
// reason: the #[cfg(unix)] sibling returns Err on unsupported targets, so the Result wrapper is required for signature parity.
#[allow(clippy::unnecessary_wraps)]
fn configure_runtime_process_tree(
    command: &mut Command,
    _operation: RuntimeOperation,
) -> Result<(), RuntimeHarnessError> {
    use std::os::unix::process::CommandExt;

    command.process_group(0);
    Ok(())
}

#[cfg(not(unix))]
fn configure_runtime_process_tree(
    _command: &mut Command,
    operation: RuntimeOperation,
) -> Result<(), RuntimeHarnessError> {
    Err(RuntimeHarnessError::new(
        RuntimeHarnessErrorKind::InvalidPlan,
        operation,
        "runtime launch process-tree cleanup is unsupported on this platform",
    )
    .with_detail(
        "cleanupScope",
        RuntimeProcessCleanupScope::ProcessTree.as_str(),
    ))
}

pub trait RuntimeAdapter {
    fn descriptor(&self) -> RuntimeAdapterDescriptor;

    fn trace(&self, request: &RuntimeRequest<'_>) -> UtsushiResult<Value>;

    fn discover_branches(&self, _request: &RuntimeRequest<'_>) -> UtsushiResult<Value> {
        Err(unsupported_operation(&self.descriptor(), RuntimeOperation::BranchDiscovery).into())
    }

    fn capture(&self, _request: &RuntimeRequest<'_>) -> UtsushiResult<Value> {
        Err(unsupported_operation(&self.descriptor(), RuntimeOperation::Capture).into())
    }

    fn smoke_validate(&self, _request: &RuntimeRequest<'_>) -> UtsushiResult<Value> {
        Err(unsupported_operation(&self.descriptor(), RuntimeOperation::SmokeValidation).into())
    }

    fn replay_review(&self, _request: &RuntimeRequest<'_>) -> UtsushiResult<Value> {
        Err(unsupported_operation(&self.descriptor(), RuntimeOperation::ReplayReview).into())
    }

    fn run(
        &self,
        operation: RuntimeOperation,
        request: &RuntimeRequest<'_>,
    ) -> UtsushiResult<Value> {
        match operation {
            RuntimeOperation::Trace => self.trace(request),
            RuntimeOperation::BranchDiscovery => self.discover_branches(request),
            RuntimeOperation::Capture => self.capture(request),
            RuntimeOperation::SmokeValidation => self.smoke_validate(request),
            RuntimeOperation::ReplayReview => self.replay_review(request),
        }
    }
}

pub struct RuntimeAdapterRegistry<'a> {
    adapters: Vec<&'a dyn RuntimeAdapter>,
}

impl<'a> RuntimeAdapterRegistry<'a> {
    pub fn new() -> Self {
        Self {
            adapters: Vec::new(),
        }
    }

    pub fn register(&mut self, adapter: &'a dyn RuntimeAdapter) -> UtsushiResult<()> {
        let descriptor = adapter.descriptor();
        descriptor.validate_contract()?;
        if self
            .adapters
            .iter()
            .any(|registered| registered.descriptor().name == descriptor.name)
        {
            return Err(format!("runtime adapter already registered: {}", descriptor.name).into());
        }
        self.adapters.push(adapter);
        Ok(())
    }

    pub fn adapter(&self, name: &str) -> Option<&'a dyn RuntimeAdapter> {
        self.adapters
            .iter()
            .find(|adapter| adapter.descriptor().name == name)
            .copied()
    }

    pub fn require(&self, name: &str) -> UtsushiResult<&'a dyn RuntimeAdapter> {
        self.adapter(name)
            .ok_or_else(|| format!("runtime adapter not registered: {name}").into())
    }

    pub fn descriptors(&self) -> Vec<RuntimeAdapterDescriptor> {
        self.adapters
            .iter()
            .map(|adapter| adapter.descriptor())
            .collect()
    }

    pub fn run(
        &self,
        adapter_name: &str,
        operation: RuntimeOperation,
        request: &RuntimeRequest<'_>,
    ) -> UtsushiResult<Value> {
        let adapter = self.require(adapter_name)?;
        let descriptor = adapter.descriptor();
        let required_capability = operation.required_capability();
        if !descriptor.supports(required_capability) {
            return Err(unsupported_operation(&descriptor, operation).into());
        }
        adapter.run(operation, request)
    }
}

impl Default for RuntimeAdapterRegistry<'_> {
    fn default() -> Self {
        Self::new()
    }
}

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

fn wait_for_child_exit(
    child: &mut Child,
    timeout: Duration,
    poll_interval: Duration,
) -> io::Result<Option<ExitStatus>> {
    let started_at = Instant::now();
    loop {
        if let Some(status) = child.try_wait()? {
            return Ok(Some(status));
        }
        let elapsed = started_at.elapsed();
        if elapsed >= timeout {
            return Ok(None);
        }
        let remaining = timeout.saturating_sub(elapsed);
        thread::sleep(if remaining < poll_interval {
            remaining
        } else {
            poll_interval
        });
    }
}

fn terminate_runtime_process(
    child: &mut Child,
    shutdown_grace: Duration,
    poll_interval: Duration,
) -> RuntimeProcessCleanup {
    if matches!(child.try_wait(), Ok(Some(_))) {
        match process_tree_exists(child.id()) {
            Ok(false) => {
                return RuntimeProcessCleanup {
                    attempted: false,
                    completed: true,
                    scope: RuntimeProcessCleanupScope::ProcessTree,
                    escalated: false,
                };
            }
            Ok(true) => {}
            Err(_) => {
                return RuntimeProcessCleanup {
                    attempted: false,
                    completed: false,
                    scope: RuntimeProcessCleanupScope::ProcessTree,
                    escalated: false,
                };
            }
        }
    }

    let attempted = terminate_process_tree(child.id()).is_ok();
    match wait_for_runtime_process_tree_exit(child, child.id(), shutdown_grace, poll_interval) {
        Ok(true) => {
            return RuntimeProcessCleanup {
                attempted,
                completed: true,
                scope: RuntimeProcessCleanupScope::ProcessTree,
                escalated: false,
            };
        }
        Ok(false) => {}
        Err(_) => {
            return RuntimeProcessCleanup {
                attempted,
                completed: false,
                scope: RuntimeProcessCleanupScope::ProcessTree,
                escalated: false,
            };
        }
    }

    let escalated = kill_process_tree(child.id()).is_ok();
    match wait_for_runtime_process_tree_exit(child, child.id(), shutdown_grace, poll_interval) {
        Ok(true) => RuntimeProcessCleanup {
            attempted,
            completed: true,
            scope: RuntimeProcessCleanupScope::ProcessTree,
            escalated,
        },
        Ok(false) | Err(_) => RuntimeProcessCleanup {
            attempted,
            completed: false,
            scope: RuntimeProcessCleanupScope::ProcessTree,
            escalated,
        },
    }
}

fn wait_for_runtime_process_tree_exit(
    child: &mut Child,
    process_id: u32,
    timeout: Duration,
    poll_interval: Duration,
) -> io::Result<bool> {
    let started_at = Instant::now();
    loop {
        let child_exited = child.try_wait()?.is_some();
        if child_exited && !process_tree_exists(process_id)? {
            return Ok(true);
        }
        let elapsed = started_at.elapsed();
        if elapsed >= timeout {
            return Ok(false);
        }
        let remaining = timeout.saturating_sub(elapsed);
        thread::sleep(if remaining < poll_interval {
            remaining
        } else {
            poll_interval
        });
    }
}

#[cfg(unix)]
fn terminate_process_tree(process_id: u32) -> io::Result<()> {
    unix_signal_process_group(process_id, unix_signals::SIGTERM)
}

#[cfg(unix)]
fn kill_process_tree(process_id: u32) -> io::Result<()> {
    unix_signal_process_group(process_id, unix_signals::SIGKILL)
}

#[cfg(unix)]
fn process_tree_exists(process_id: u32) -> io::Result<bool> {
    match unix_signal_process_group_raw(process_id, 0) {
        Ok(()) => Ok(true),
        Err(error) if error.raw_os_error() == Some(unix_signals::ESRCH) => Ok(false),
        Err(error) => Err(error),
    }
}

#[cfg(not(unix))]
fn terminate_process_tree(_process_id: u32) -> io::Result<()> {
    Err(io::Error::new(
        io::ErrorKind::Unsupported,
        "process-tree cleanup is unsupported on this platform",
    ))
}

#[cfg(not(unix))]
fn kill_process_tree(_process_id: u32) -> io::Result<()> {
    Err(io::Error::new(
        io::ErrorKind::Unsupported,
        "process-tree cleanup is unsupported on this platform",
    ))
}

#[cfg(not(unix))]
fn process_tree_exists(_process_id: u32) -> io::Result<bool> {
    Err(io::Error::new(
        io::ErrorKind::Unsupported,
        "process-tree cleanup is unsupported on this platform",
    ))
}

#[cfg(unix)]
fn unix_signal_process_group(process_id: u32, signal: i32) -> io::Result<()> {
    match unix_signal_process_group_raw(process_id, signal) {
        Ok(()) => Ok(()),
        Err(error) if error.raw_os_error() == Some(unix_signals::ESRCH) => Ok(()),
        Err(error) => Err(error),
    }
}

#[cfg(unix)]
// reason: process-group signalling needs the libc kill(2) FFI; there is no safe
// std wrapper for negative-pgid delivery. Minimal unsafe surface.
#[allow(unsafe_code)]
fn unix_signal_process_group_raw(process_id: u32, signal: i32) -> io::Result<()> {
    let process_group_id = i32::try_from(process_id).map_err(|_| {
        io::Error::new(
            io::ErrorKind::InvalidInput,
            format!("process id {process_id} cannot be represented as a Unix process group id"),
        )
    })?;
    let result = unsafe { unix_signals::kill(-process_group_id, signal) };
    if result == 0 {
        return Ok(());
    }
    Err(io::Error::last_os_error())
}

#[cfg(unix)]
// reason: declares the libc kill(2) FFI symbol used by process-group signalling.
#[allow(unsafe_code)]
mod unix_signals {
    pub const ESRCH: i32 = 3;
    pub const SIGTERM: i32 = 15;
    pub const SIGKILL: i32 = 9;

    unsafe extern "C" {
        pub fn kill(pid: i32, sig: i32) -> i32;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::process::Command as StdCommand;
    use std::sync::{
        Arc, Mutex,
        atomic::{AtomicBool, AtomicUsize, Ordering},
        mpsc,
    };
    use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

    struct FakeTraceAdapter;

    const HARNESS_RUN_ID: &str = "019ed003-0000-7000-8000-000000001014";
    const HARNESS_SCREENSHOT_ID: &str = "019ed003-0000-7000-8000-000000004014";
    const HARNESS_FRAME_ID: &str = "019ed003-0000-7000-8000-000000004015";

    fn trace_contract() -> RuntimeCapabilityContract {
        RuntimeCapabilityContract::new(
            RuntimeCapabilityClass::StaticTrace,
            FidelityTier::TraceOnly,
            EvidenceTier::E1,
            vec![
                RuntimeFeatureSupport::supported(
                    RuntimePlaybackFeature::StaticTrace,
                    EvidenceTier::E1,
                    "static trace fixture",
                ),
                RuntimeFeatureSupport::supported(
                    RuntimePlaybackFeature::TextTrace,
                    EvidenceTier::E1,
                    "text trace fixture",
                ),
                RuntimeFeatureSupport::unsupported(
                    RuntimePlaybackFeature::Jump,
                    "jump is not part of the base trace contract",
                ),
                RuntimeFeatureSupport::unsupported(
                    RuntimePlaybackFeature::Snapshot,
                    "snapshot is not part of the base trace contract",
                ),
                RuntimeFeatureSupport::unsupported(
                    RuntimePlaybackFeature::Screenshot,
                    "screenshots are not part of the base trace contract",
                ),
                RuntimeFeatureSupport::unsupported(
                    RuntimePlaybackFeature::Recording,
                    "recording is not part of the base trace contract",
                ),
            ],
            vec!["unit test adapter".to_string()],
        )
    }

    fn temp_root(name: &str) -> PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!(
            "utsushi-core-{name}-{}-{nonce}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        root
    }

    fn harness_child_command(test_name: &str) -> RuntimeLaunchCommand {
        RuntimeLaunchCommand::new(std::env::current_exe().unwrap()).args([
            "--exact",
            test_name,
            "--ignored",
            "--nocapture",
        ])
    }

    fn harness_child_command_with_env(
        test_name: &str,
        env: &[(&str, &Path)],
    ) -> RuntimeLaunchCommand {
        let mut command = harness_child_command(test_name);
        for (key, value) in env {
            command = command.env(*key, value.display().to_string());
        }
        command
    }

    fn wait_for_path(path: &Path, timeout: Duration) -> bool {
        let started_at = Instant::now();
        while started_at.elapsed() < timeout {
            if path.exists() {
                return true;
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        path.exists()
    }

    // poll the out-of-band slot the detached hook worker records
    // its (fenced) write outcome into.
    fn wait_for_late_write(
        slot: &Arc<Mutex<Option<Result<PathBuf, String>>>>,
        timeout: Duration,
    ) -> Option<Result<PathBuf, String>> {
        let started_at = Instant::now();
        loop {
            if let Some(value) = slot.lock().unwrap().clone() {
                return Some(value);
            }
            if started_at.elapsed() > timeout {
                return None;
            }
            std::thread::sleep(Duration::from_millis(10));
        }
    }

    // tests that exercised the deleted typed
    // `deleted-hook-envelope` envelope (round-trip, schema-version
    // redaction rejection on the typed shape) have been removed. The
    // wire-shape envelope's per-field validation is now tested only by
    // the independent `kaifuu-core::contracts::validate_runtime_evidence_report_v02`
    // suite, and the `RuntimeEvidenceReportV02` integration validator
    // (`validate_runtime_evidence_report_value`) is exercised in the
    // `utsushi-fixture` reference-corpus path. The substrate-side sink
    // contracts (text / frame / audio) carry their own per-payload
    // validators with dedicated tests in `crates/utsushi-core/src/sink/*`.

    #[test]
    fn evidence_report_observation_event_rejects_tier_above_report_ceiling() {
        // Spot-check that the JSON-shape observationHookEvents validator
        // (rewritten in to drop its `deleted-hook-envelope`
        // dependency) still rejects an entry whose tier exceeds the
        // report's declared evidenceTier.
        let report = json!({
            "schemaVersion": "0.2.0",
            "runtimeReportId": "0190a000-0000-7000-8000-000000000001",
            "adapterName": "utsushi-test",
            "adapterVersion": "0.0.0-test",
            "fidelityTier": "layout_probe",
            "evidenceTier": "E1",
            "status": "passed",
            "createdAt": "2026-06-17T00:00:00.000Z",
            "traceEvents": [],
            "branchEvents": [],
            "observationHookEvents": [
                {"evidenceTier": "E3"}
            ],
            "captures": [],
            "recordings": [],
            "approximations": [],
            "validationFindings": [],
            "limitations": [],
        });
        let error = validate_runtime_evidence_report_value(&report)
            .expect_err("E3 entry under E1 report must reject");
        let rendered = error.to_string();
        assert!(
            rendered.contains("evidenceTier must not exceed"),
            "rendered={rendered}"
        );
    }

    /// The Utsushi observation-hook timestamp validator shares the exact
    /// accept/reject boundary and semantic rejection code used by the Kaifuu
    /// Rust and localization-bridge-schema TypeScript validators.
    #[test]
    fn rfc3339_instant_parity_matrix_matches_observation_hook_validator() {
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct MatrixRow {
            id: String,
            value: Value,
            expected: String,
        }

        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct ParityMatrix {
            semantic_code: String,
            rows: Vec<MatrixRow>,
        }

        let fixture_path = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..").join(
            "packages/localization-bridge-schema/test/rfc3339-instant-parity-matrix.v0.2.json",
        );
        let matrix: ParityMatrix = serde_json::from_str(
            &fs::read_to_string(&fixture_path).expect("parity matrix fixture should be readable"),
        )
        .expect("parity matrix fixture should be valid JSON");

        assert_eq!(
            matrix.semantic_code, SEMANTIC_RFC3339_INSTANT_MALFORMED,
            "matrix must pin the shared cross-validator semantic code",
        );
        assert!(
            matrix.rows.iter().any(|row| row.expected == "accept")
                && matrix.rows.iter().any(|row| row.expected == "reject"),
            "matrix must cover both accept and reject",
        );

        for row in &matrix.rows {
            let value = row
                .value
                .as_str()
                .unwrap_or_else(|| panic!("row {} value must be a JSON string", row.id));
            let result = validate_rfc3339_instant_metadata("matrix", value);
            match row.expected.as_str() {
                "accept" => assert!(
                    result.is_ok(),
                    "row {} ({value:?}) should be ACCEPTED, got {result:?}",
                    row.id,
                ),
                "reject" => {
                    let error = result
                        .expect_err(&format!("row {} ({value:?}) should be REJECTED", row.id));
                    let semantic_error = error
                        .downcast_ref::<ObservationHookValidationError>()
                        .unwrap_or_else(|| {
                            panic!(
                                "row {} rejection should be ObservationHookValidationError, got {error:?}",
                                row.id
                            )
                        });
                    assert_eq!(
                        semantic_error.code(),
                        SEMANTIC_RFC3339_INSTANT_MALFORMED,
                        "row {} rejection must carry the shared semantic code",
                        row.id,
                    );
                    assert_eq!(semantic_error.field(), "matrix");
                }
                other => panic!("row {} has unknown expected value {other}", row.id),
            }
        }
    }

    const HARNESS_STDOUT_SENTINEL: &str = "UTSUSHI-STDOUT-CAPTURE-SENTINEL-6f3a2d";

    #[test]
    #[ignore = "child-process harness entry point; spawned by a parent harness test, not run standalone"]
    fn harness_child_exits() {}

    #[test]
    #[ignore = "child-process harness entry point; spawned by a parent harness test, not run standalone"]
    fn harness_child_prints_stdout_sentinel() {
        println!("{HARNESS_STDOUT_SENTINEL}");
    }

    #[test]
    #[ignore = "child-process harness entry point; spawned by a parent harness test, not run standalone"]
    fn harness_child_sleeps() {
        std::thread::sleep(Duration::from_secs(5));
    }

    #[test]
    #[ignore = "child-process harness entry point; spawned by a parent harness test, not run standalone"]
    fn harness_child_spawns_grandchild() {
        let heartbeat_path =
            PathBuf::from(std::env::var("UTSUSHI_TEST_GRANDCHILD_HEARTBEAT").unwrap());
        let pid_path = PathBuf::from(std::env::var("UTSUSHI_TEST_GRANDCHILD_PID").unwrap());
        let mut child = StdCommand::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "tests::harness_grandchild_heartbeats",
                "--ignored",
                "--nocapture",
            ])
            .env("UTSUSHI_TEST_GRANDCHILD_HEARTBEAT", &heartbeat_path)
            .env("UTSUSHI_TEST_GRANDCHILD_PID", &pid_path)
            .spawn()
            .unwrap();
        assert!(wait_for_path(&pid_path, Duration::from_secs(1)));
        loop {
            if let Ok(Some(_)) = child.try_wait() {
                panic!("grandchild exited before harness cleanup");
            }
            std::thread::sleep(Duration::from_millis(50));
        }
    }

    #[test]
    #[ignore = "child-process harness entry point; spawned by a parent harness test, not run standalone"]
    fn harness_child_spawns_grandchild_then_fails() {
        let heartbeat_path =
            PathBuf::from(std::env::var("UTSUSHI_TEST_GRANDCHILD_HEARTBEAT").unwrap());
        let pid_path = PathBuf::from(std::env::var("UTSUSHI_TEST_GRANDCHILD_PID").unwrap());
        let _child = StdCommand::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "tests::harness_grandchild_heartbeats",
                "--ignored",
                "--nocapture",
            ])
            .env("UTSUSHI_TEST_GRANDCHILD_HEARTBEAT", &heartbeat_path)
            .env("UTSUSHI_TEST_GRANDCHILD_PID", &pid_path)
            .spawn()
            .unwrap();
        assert!(wait_for_path(&pid_path, Duration::from_secs(1)));
        assert!(wait_for_path(&heartbeat_path, Duration::from_secs(1)));
        std::process::exit(42);
    }

    #[test]
    #[ignore = "child-process harness entry point; spawned by a parent harness test, not run standalone"]
    fn harness_grandchild_heartbeats() {
        let heartbeat_path =
            PathBuf::from(std::env::var("UTSUSHI_TEST_GRANDCHILD_HEARTBEAT").unwrap());
        let pid_path = PathBuf::from(std::env::var("UTSUSHI_TEST_GRANDCHILD_PID").unwrap());
        fs::write(&pid_path, std::process::id().to_string()).unwrap();
        let mut heartbeat = 0_u64;
        loop {
            fs::write(&heartbeat_path, heartbeat.to_string()).unwrap();
            heartbeat += 1;
            std::thread::sleep(Duration::from_millis(20));
        }
    }

    struct WritingCaptureHook {
        boundary: RuntimeCaptureBoundary,
        calls: Arc<AtomicUsize>,
    }

    impl WritingCaptureHook {
        fn new(boundary: RuntimeCaptureBoundary, calls: Arc<AtomicUsize>) -> Self {
            Self { boundary, calls }
        }
    }

    impl RuntimeCaptureHook for WritingCaptureHook {
        fn boundary(&self) -> RuntimeCaptureBoundary {
            self.boundary
        }

        fn capture(
            &mut self,
            context: &mut RuntimeCaptureContext,
        ) -> Result<(), RuntimeHarnessError> {
            self.calls.fetch_add(1, Ordering::SeqCst);
            assert_eq!(context.boundary, self.boundary);
            assert_eq!(context.run_id, HARNESS_RUN_ID);
            context.write_artifact(
                RuntimeArtifactKind::Screenshot,
                HARNESS_SCREENSHOT_ID,
                Some("image/png".to_string()),
                b"runtime screenshot bytes",
            )?;
            context.write_artifact(
                RuntimeArtifactKind::FrameCapture,
                HARNESS_FRAME_ID,
                Some("image/png".to_string()),
                b"runtime frame capture bytes",
            )?;
            Ok(())
        }
    }

    struct ArtifactRequiredHook;

    impl RuntimeCaptureHook for ArtifactRequiredHook {
        fn boundary(&self) -> RuntimeCaptureBoundary {
            RuntimeCaptureBoundary::AfterLaunch
        }

        fn capture(
            &mut self,
            context: &mut RuntimeCaptureContext,
        ) -> Result<(), RuntimeHarnessError> {
            context.write_artifact(
                RuntimeArtifactKind::Screenshot,
                HARNESS_SCREENSHOT_ID,
                Some("image/png".to_string()),
                b"requires an artifact root",
            )?;
            Ok(())
        }
    }

    struct SleepingCaptureHook {
        boundary: RuntimeCaptureBoundary,
        started: Arc<AtomicBool>,
        sleep: Duration,
    }

    impl RuntimeCaptureHook for SleepingCaptureHook {
        fn boundary(&self) -> RuntimeCaptureBoundary {
            self.boundary
        }

        fn capture(
            &mut self,
            _context: &mut RuntimeCaptureContext,
        ) -> Result<(), RuntimeHarnessError> {
            self.started.store(true, Ordering::SeqCst);
            std::thread::sleep(self.sleep);
            Ok(())
        }
    }

    // a hook that blocks past its timeout and, once released by the
    // test (after `launch-capture` has already returned), attempts a managed
    // artifact write from the detached worker thread. The outcome is recorded
    // out-of-band so the test can assert the write was fenced.
    struct LateWritingCaptureHook {
        boundary: RuntimeCaptureBoundary,
        started: Arc<AtomicBool>,
        proceed: mpsc::Receiver<()>,
        late_write: Arc<Mutex<Option<Result<PathBuf, String>>>>,
    }

    impl RuntimeCaptureHook for LateWritingCaptureHook {
        fn boundary(&self) -> RuntimeCaptureBoundary {
            self.boundary
        }

        fn capture(
            &mut self,
            context: &mut RuntimeCaptureContext,
        ) -> Result<(), RuntimeHarnessError> {
            self.started.store(true, Ordering::SeqCst);
            // Block until the test releases us. By then the harness has timed
            // this hook out and `launch-capture` has returned, so this write is
            // strictly after the capture boundary.
            let _ = self.proceed.recv();
            let outcome = match context.write_artifact(
                RuntimeArtifactKind::Screenshot,
                HARNESS_SCREENSHOT_ID,
                Some("image/png".to_string()),
                b"post-boundary late write that must be refused",
            ) {
                Ok(artifact) => Ok(artifact.path),
                Err(error) => Err(error.code().to_string()),
            };
            *self.late_write.lock().unwrap() = Some(outcome);
            Ok(())
        }
    }

    struct PanickingCaptureHook {
        boundary: RuntimeCaptureBoundary,
    }

    impl RuntimeCaptureHook for PanickingCaptureHook {
        fn boundary(&self) -> RuntimeCaptureBoundary {
            self.boundary
        }

        fn capture(
            &mut self,
            _context: &mut RuntimeCaptureContext,
        ) -> Result<(), RuntimeHarnessError> {
            std::panic::resume_unwind(Box::new("intentional capture hook panic"))
        }
    }

    struct FailingCaptureHook {
        boundary: RuntimeCaptureBoundary,
    }

    impl RuntimeCaptureHook for FailingCaptureHook {
        fn boundary(&self) -> RuntimeCaptureBoundary {
            self.boundary
        }

        fn capture(
            &mut self,
            context: &mut RuntimeCaptureContext,
        ) -> Result<(), RuntimeHarnessError> {
            Err(RuntimeHarnessError::capture_failed(
                context.operation,
                "intentional after-exit hook failure",
            ))
        }
    }

    impl RuntimeAdapter for FakeTraceAdapter {
        fn descriptor(&self) -> RuntimeAdapterDescriptor {
            RuntimeAdapterDescriptor {
                name: "fake-trace".to_string(),
                version: "0.0.0-test".to_string(),
                fidelity_tier: FidelityTier::TraceOnly,
                evidence_tier_ceiling: EvidenceTier::E1,
                capability_contract: trace_contract(),
                capabilities: vec![RuntimeCapability::Trace],
                approximation_tiers: vec![ApproximationTier::DeterministicFixture],
                diagnostics: vec![],
                limitations: vec!["unit test adapter".to_string()],
            }
        }

        fn trace(&self, request: &RuntimeRequest<'_>) -> UtsushiResult<Value> {
            Ok(json!({
                "operation": "trace",
                "inputRoot": request.input_root.display().to_string()
            }))
        }
    }

    struct OverclaimingAdapter;

    impl RuntimeAdapter for OverclaimingAdapter {
        fn descriptor(&self) -> RuntimeAdapterDescriptor {
            RuntimeAdapterDescriptor {
                name: "overclaiming".to_string(),
                version: "0.0.0-test".to_string(),
                fidelity_tier: FidelityTier::LayoutProbe,
                evidence_tier_ceiling: EvidenceTier::E4,
                capability_contract: RuntimeCapabilityContract::new(
                    RuntimeCapabilityClass::LaunchCapture,
                    FidelityTier::LayoutProbe,
                    EvidenceTier::E4,
                    vec![RuntimeFeatureSupport::supported(
                        RuntimePlaybackFeature::FrameCapture,
                        EvidenceTier::E4,
                        "overclaims capture evidence",
                    )],
                    vec![],
                ),
                capabilities: vec![RuntimeCapability::Trace, RuntimeCapability::FrameCapture],
                approximation_tiers: vec![ApproximationTier::ReferenceMatched],
                diagnostics: vec![],
                limitations: vec![],
            }
        }

        fn trace(&self, _request: &RuntimeRequest<'_>) -> UtsushiResult<Value> {
            Ok(json!({ "operation": "trace" }))
        }
    }

    #[test]
    fn fidelity_tiers_match_runtime_schema_evidence_ceilings() {
        assert_eq!(FidelityTier::TraceOnly.evidence_ceiling(), EvidenceTier::E1);
        assert_eq!(
            FidelityTier::LayoutProbe.evidence_ceiling(),
            EvidenceTier::E2
        );
        assert_eq!(
            FidelityTier::ReplayReview.evidence_ceiling(),
            EvidenceTier::E3
        );
        assert_eq!(
            FidelityTier::ReferenceFidelity.evidence_ceiling(),
            EvidenceTier::E4
        );
    }

    #[test]
    fn registry_dispatches_by_adapter_name() {
        let adapter = FakeTraceAdapter;
        let mut registry = RuntimeAdapterRegistry::new();
        registry.register(&adapter).unwrap();

        let input_root = Path::new("fixtures/hello-game");
        let report = registry
            .run(
                "fake-trace",
                RuntimeOperation::Trace,
                &RuntimeRequest::new(input_root),
            )
            .unwrap();

        assert_eq!(report["operation"], "trace");
        assert_eq!(report["inputRoot"], "fixtures/hello-game");
        assert_eq!(registry.descriptors()[0].name, "fake-trace");
    }

    #[test]
    fn registry_rejects_duplicate_adapter_names() {
        let adapter = FakeTraceAdapter;
        let mut registry = RuntimeAdapterRegistry::new();

        registry.register(&adapter).unwrap();
        let error = registry.register(&adapter).unwrap_err().to_string();

        assert!(error.contains("already registered"));
    }

    #[test]
    fn registry_rejects_adapter_evidence_overclaims() {
        let adapter = OverclaimingAdapter;
        let mut registry = RuntimeAdapterRegistry::new();

        let error = registry.register(&adapter).unwrap_err().to_string();

        assert!(error.contains("exceeds"));
    }

    #[test]
    fn capability_contract_serializes_base_unsupported_features() {
        let contract = trace_contract();
        contract.validate().unwrap();

        let value = contract.to_json();

        assert_eq!(value["capabilityClass"], "static_trace");
        assert_eq!(value["evidenceTierCeiling"], "E1");
        assert!(
            value["features"].as_array().unwrap().iter().any(|feature| {
                feature["feature"] == "jump" && feature["status"] == "unsupported"
            })
        );
        assert!(value["features"].as_array().unwrap().iter().any(|feature| {
            feature["feature"] == "snapshot" && feature["status"] == "unsupported"
        }));
        assert!(value["features"].as_array().unwrap().iter().any(|feature| {
            feature["feature"] == "screenshot" && feature["status"] == "unsupported"
        }));
        assert!(value["features"].as_array().unwrap().iter().any(|feature| {
            feature["feature"] == "recording" && feature["status"] == "unsupported"
        }));
    }

    #[test]
    fn capability_classes_map_to_expected_evidence_boundaries() {
        assert_eq!(
            RuntimeCapabilityClass::StaticTrace.evidence_tier_ceiling(),
            EvidenceTier::E1
        );
        assert_eq!(
            RuntimeCapabilityClass::LaunchCapture.evidence_tier_ceiling(),
            EvidenceTier::E2
        );
        assert_eq!(
            RuntimeCapabilityClass::InstrumentedRuntime.evidence_tier_ceiling(),
            EvidenceTier::E3
        );
        assert_eq!(
            RuntimeCapabilityClass::PartialVm.evidence_tier_ceiling(),
            EvidenceTier::E3
        );
        assert_eq!(
            RuntimeCapabilityClass::ReferenceVm.evidence_tier_ceiling(),
            EvidenceTier::E4
        );
    }

    #[test]
    fn registry_fails_closed_for_unsupported_operations() {
        let adapter = FakeTraceAdapter;
        let mut registry = RuntimeAdapterRegistry::new();
        registry.register(&adapter).unwrap();

        let error = registry
            .run(
                "fake-trace",
                RuntimeOperation::Capture,
                &RuntimeRequest::new(Path::new("fixtures/hello-game")),
            )
            .unwrap_err()
            .to_string();

        assert!(error.contains("does not support capture"));
    }

    #[test]
    fn launch_capture_harness_captures_stdout_when_requested() {
        let plan = RuntimeLaunchCapturePlan::new(
            HARNESS_RUN_ID,
            RuntimeOperation::Trace,
            harness_child_command("tests::harness_child_prints_stdout_sentinel"),
        )
        .with_timeout(Duration::from_secs(5))
        .with_shutdown_grace(Duration::from_secs(1))
        .with_stdout_capture(true);
        let harness = RuntimeLaunchCaptureHarness::new();
        let mut hooks = RuntimeCaptureHooks::new();

        let outcome = harness.run(&plan, &mut hooks).unwrap();

        assert!(outcome.exit.success);
        let stdout = outcome
            .stdout
            .expect("stdout must be captured when the plan requests it");
        assert!(
            stdout.contains(HARNESS_STDOUT_SENTINEL),
            "captured stdout should carry the live child output, was: {stdout}"
        );
    }

    #[test]
    fn launch_capture_harness_discards_stdout_by_default() {
        let plan = RuntimeLaunchCapturePlan::new(
            HARNESS_RUN_ID,
            RuntimeOperation::Trace,
            harness_child_command("tests::harness_child_prints_stdout_sentinel"),
        )
        .with_timeout(Duration::from_secs(5))
        .with_shutdown_grace(Duration::from_secs(1));
        let harness = RuntimeLaunchCaptureHarness::new();
        let mut hooks = RuntimeCaptureHooks::new();

        let outcome = harness.run(&plan, &mut hooks).unwrap();

        assert!(outcome.exit.success);
        assert!(
            outcome.stdout.is_none(),
            "stdout must be discarded unless capture is explicitly enabled"
        );
    }

    #[test]
    fn launch_capture_harness_runs_process_and_persists_hook_artifacts() {
        let temp = temp_root("harness-success");
        let artifact_root = temp.join("runtime-artifacts");
        let plan = RuntimeLaunchCapturePlan::new(
            HARNESS_RUN_ID,
            RuntimeOperation::Capture,
            harness_child_command("tests::harness_child_exits"),
        )
        .with_artifact_root(&artifact_root)
        .with_timeout(Duration::from_secs(5))
        .with_shutdown_grace(Duration::from_secs(1));
        let harness = RuntimeLaunchCaptureHarness::new();
        let calls = Arc::new(AtomicUsize::new(0));
        let mut hooks = RuntimeCaptureHooks::new();
        hooks.push(WritingCaptureHook::new(
            RuntimeCaptureBoundary::AfterLaunch,
            Arc::clone(&calls),
        ));

        let outcome = harness.run(&plan, &mut hooks).unwrap();

        assert!(outcome.exit.success);
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        assert_eq!(outcome.artifacts.len(), 2);
        let screenshot = &outcome.artifacts[0];
        assert_eq!(screenshot.artifact_kind, RuntimeArtifactKind::Screenshot);
        assert_eq!(
            screenshot.boundary,
            Some(RuntimeCaptureBoundary::AfterLaunch)
        );
        assert!(screenshot.path.starts_with(&artifact_root));
        assert!(screenshot.path.is_file());
        assert_eq!(
            fs::read(&screenshot.path).unwrap(),
            b"runtime screenshot bytes"
        );
        let frame_capture = &outcome.artifacts[1];
        assert_eq!(
            frame_capture.artifact_kind,
            RuntimeArtifactKind::FrameCapture
        );
        assert!(frame_capture.path.starts_with(&artifact_root));
        assert!(frame_capture.path.is_file());

        let artifact_ref = screenshot.artifact_ref_json();
        assert_eq!(artifact_ref["artifactKind"], "screenshot");
        assert_eq!(
            artifact_ref["uri"],
            format!(
                "{RUNTIME_ARTIFACT_URI_ROOT}/{HARNESS_RUN_ID}/screenshots/{HARNESS_SCREENSHOT_ID}.png"
            )
        );
        assert!(artifact_ref.get("data").is_none());
        assert!(artifact_ref.get("bytes").is_none());
        assert!(artifact_ref.get("localPath").is_none());
        assert!(artifact_root.join(RUNTIME_ARTIFACT_ROOT_MARKER).is_file());
        let _ = fs::remove_dir_all(temp);
    }

    #[test]
    fn launch_capture_harness_times_out_and_reaps_child() {
        let plan = RuntimeLaunchCapturePlan::new(
            HARNESS_RUN_ID,
            RuntimeOperation::Capture,
            harness_child_command("tests::harness_child_sleeps"),
        )
        .with_timeout(Duration::from_millis(50))
        .with_shutdown_grace(Duration::from_secs(1))
        .with_poll_interval(Duration::from_millis(5));
        let harness = RuntimeLaunchCaptureHarness::new();
        let started_at = Instant::now();
        let mut hooks = RuntimeCaptureHooks::new();

        let error = harness.run(&plan, &mut hooks).unwrap_err();

        assert!(started_at.elapsed() < Duration::from_secs(3));
        assert_eq!(error.kind, RuntimeHarnessErrorKind::Timeout);
        assert_eq!(error.code(), "runtime_launch_timeout");
        let cleanup = error.cleanup.unwrap();
        assert!(cleanup.attempted);
        assert!(cleanup.completed);
        assert_eq!(cleanup.scope, RuntimeProcessCleanupScope::ProcessTree);
        assert!(error.process_id.is_some());
    }

    #[test]
    fn launch_failures_report_semantic_errors() {
        let temp = temp_root("harness-launch-error");
        let missing_command = temp.join("missing-runtime-command");
        let plan = RuntimeLaunchCapturePlan::new(
            HARNESS_RUN_ID,
            RuntimeOperation::Capture,
            RuntimeLaunchCommand::new(&missing_command),
        );
        let harness = RuntimeLaunchCaptureHarness::new();
        let mut hooks = RuntimeCaptureHooks::new();

        let error = harness.run(&plan, &mut hooks).unwrap_err();

        assert_eq!(error.kind, RuntimeHarnessErrorKind::LaunchFailed);
        let semantic = error.to_json();
        assert_eq!(semantic["errorCode"], "runtime_launch_failed");
        assert_eq!(semantic["operation"], "capture");
        assert!(
            semantic["message"]
                .as_str()
                .unwrap()
                .contains("failed to launch")
        );

        let finding = error.to_validation_finding(
            "019ed003-0000-7000-8000-000000009014",
            "unsupported_runtime_feature",
            "critical",
            EvidenceTier::E1,
        );
        assert_eq!(finding["findingKind"], "unsupported_runtime_feature");
        assert!(
            finding["message"]
                .as_str()
                .unwrap()
                .contains("runtime_launch_failed")
        );
        let _ = fs::remove_dir_all(temp);
    }

    #[test]
    fn capture_hooks_require_managed_artifact_store_boundary() {
        let plan = RuntimeLaunchCapturePlan::new(
            HARNESS_RUN_ID,
            RuntimeOperation::Capture,
            harness_child_command("tests::harness_child_sleeps"),
        )
        .with_timeout(Duration::from_secs(5))
        .with_shutdown_grace(Duration::from_secs(1))
        .with_poll_interval(Duration::from_millis(5));
        let harness = RuntimeLaunchCaptureHarness::new();
        let mut hooks = RuntimeCaptureHooks::new();
        hooks.push(ArtifactRequiredHook);

        let error = harness.run(&plan, &mut hooks).unwrap_err();

        assert_eq!(
            error.kind,
            RuntimeHarnessErrorKind::ArtifactStoreUnavailable
        );
        assert_eq!(error.boundary, Some(RuntimeCaptureBoundary::AfterLaunch));
        let cleanup = error.cleanup.unwrap();
        assert!(cleanup.attempted);
        assert!(cleanup.completed);
        assert_eq!(cleanup.scope, RuntimeProcessCleanupScope::ProcessTree);
        assert_eq!(
            error.to_json()["errorCode"],
            "runtime_artifact_store_unavailable"
        );
    }

    #[test]
    fn after_launch_hook_timeout_cleans_up_runtime_process() {
        let plan = RuntimeLaunchCapturePlan::new(
            HARNESS_RUN_ID,
            RuntimeOperation::Capture,
            harness_child_command("tests::harness_child_sleeps"),
        )
        .with_timeout(Duration::from_secs(5))
        .with_hook_timeout(Duration::from_millis(50))
        .with_shutdown_grace(Duration::from_secs(1))
        .with_poll_interval(Duration::from_millis(5));
        let harness = RuntimeLaunchCaptureHarness::new();
        let started = Arc::new(AtomicBool::new(false));
        let mut hooks = RuntimeCaptureHooks::new();
        hooks.push(SleepingCaptureHook {
            boundary: RuntimeCaptureBoundary::AfterLaunch,
            started: Arc::clone(&started),
            sleep: Duration::from_secs(2),
        });
        let started_at = Instant::now();

        let error = harness.run(&plan, &mut hooks).unwrap_err();

        assert!(started.load(Ordering::SeqCst));
        assert!(started_at.elapsed() < Duration::from_secs(2));
        assert_eq!(error.kind, RuntimeHarnessErrorKind::CaptureTimeout);
        assert_eq!(error.boundary, Some(RuntimeCaptureBoundary::AfterLaunch));
        assert_eq!(error.code(), "runtime_capture_timeout");
        let cleanup = error.cleanup.unwrap();
        assert!(cleanup.attempted);
        assert!(cleanup.completed);
        assert_eq!(cleanup.scope, RuntimeProcessCleanupScope::ProcessTree);
    }

    // a hook that times out during launch-capture leaves a detached
    // worker thread running that still holds a clone of the managed artifact
    // store. This test proves that once the capture boundary closes, a late
    // write from that worker is REFUSED by the write fence (managed artifact
    // state unchanged), while the timeout diagnostic still names the boundary.
    #[test]
    fn timed_out_hook_write_is_fenced_after_capture_boundary() {
        let temp = temp_root("harness-fence-late");
        let artifact_root = temp.join("runtime-artifacts");
        let plan = RuntimeLaunchCapturePlan::new(
            HARNESS_RUN_ID,
            RuntimeOperation::Capture,
            harness_child_command("tests::harness_child_sleeps"),
        )
        .with_artifact_root(&artifact_root)
        .with_timeout(Duration::from_secs(5))
        .with_hook_timeout(Duration::from_millis(50))
        .with_shutdown_grace(Duration::from_secs(1))
        .with_poll_interval(Duration::from_millis(5));
        let harness = RuntimeLaunchCaptureHarness::new();
        let started = Arc::new(AtomicBool::new(false));
        let late_write: Arc<Mutex<Option<Result<PathBuf, String>>>> = Arc::new(Mutex::new(None));
        let (proceed_tx, proceed_rx) = mpsc::channel();
        let mut hooks = RuntimeCaptureHooks::new();
        hooks.push(LateWritingCaptureHook {
            boundary: RuntimeCaptureBoundary::AfterLaunch,
            started: Arc::clone(&started),
            proceed: proceed_rx,
            late_write: Arc::clone(&late_write),
        });

        // The hook blocks (never receives `proceed`) so the harness times it out
        // and `launch-capture` returns.
        let error = harness.run(&plan, &mut hooks).unwrap_err();

        // (3) The timeout diagnostic still identifies the capture boundary and
        // is distinct from the fenced-late-write refusal below.
        assert!(started.load(Ordering::SeqCst));
        assert_eq!(error.kind, RuntimeHarnessErrorKind::CaptureTimeout);
        assert_eq!(error.code(), "runtime_capture_timeout");
        assert_eq!(error.boundary, Some(RuntimeCaptureBoundary::AfterLaunch));

        // launch-capture has returned; release the detached worker so it now
        // attempts a managed-artifact write strictly after the capture boundary.
        proceed_tx.send(()).unwrap();

        // The late write is refused with a code distinct from the timeout.
        match wait_for_late_write(&late_write, Duration::from_secs(5)) {
            Some(Err(code)) => assert_eq!(code, "runtime_capture_boundary_closed"),
            other => panic!("expected fenced late write to be refused, got {other:?}"),
        }

        // Crux + mutation proof: managed artifact state is unchanged. Without the
        // fence check in `write_artifact`, this file would have been created by
        // the detached worker and this assertion would fail.
        let leaked = artifact_root
            .join(HARNESS_RUN_ID)
            .join("screenshots")
            .join(format!("{HARNESS_SCREENSHOT_ID}.png"));
        assert!(
            !leaked.exists(),
            "fenced late write must not create a managed artifact: {}",
            leaked.display()
        );

        let _ = fs::remove_dir_all(temp);
    }

    // the fence must not disturb the normal path — a write made
    // while the capture window is still valid (fence open) succeeds and persists.
    #[test]
    fn in_boundary_hook_write_succeeds_within_fence() {
        let temp = temp_root("harness-fence-inbound");
        let artifact_root = temp.join("runtime-artifacts");
        let plan = RuntimeLaunchCapturePlan::new(
            HARNESS_RUN_ID,
            RuntimeOperation::Capture,
            harness_child_command("tests::harness_child_exits"),
        )
        .with_artifact_root(&artifact_root)
        .with_timeout(Duration::from_secs(5))
        .with_hook_timeout(Duration::from_secs(5))
        .with_shutdown_grace(Duration::from_secs(1));
        let harness = RuntimeLaunchCaptureHarness::new();
        let calls = Arc::new(AtomicUsize::new(0));
        let mut hooks = RuntimeCaptureHooks::new();
        hooks.push(WritingCaptureHook::new(
            RuntimeCaptureBoundary::AfterLaunch,
            Arc::clone(&calls),
        ));

        let outcome = harness.run(&plan, &mut hooks).unwrap();

        assert!(outcome.exit.success);
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        assert_eq!(outcome.artifacts.len(), 2);
        for artifact in &outcome.artifacts {
            assert!(artifact.path.starts_with(&artifact_root));
            assert!(artifact.path.is_file());
        }
        let _ = fs::remove_dir_all(temp);
    }

    #[test]
    fn panicking_capture_hooks_are_contained_and_cleanup_runtime_process() {
        let plan = RuntimeLaunchCapturePlan::new(
            HARNESS_RUN_ID,
            RuntimeOperation::Capture,
            harness_child_command("tests::harness_child_sleeps"),
        )
        .with_timeout(Duration::from_secs(5))
        .with_hook_timeout(Duration::from_secs(1))
        .with_shutdown_grace(Duration::from_secs(1))
        .with_poll_interval(Duration::from_millis(5));
        let harness = RuntimeLaunchCaptureHarness::new();
        let mut hooks = RuntimeCaptureHooks::new();
        hooks.push(PanickingCaptureHook {
            boundary: RuntimeCaptureBoundary::AfterLaunch,
        });

        let error = harness.run(&plan, &mut hooks).unwrap_err();

        assert_eq!(error.kind, RuntimeHarnessErrorKind::CaptureFailed);
        assert_eq!(error.boundary, Some(RuntimeCaptureBoundary::AfterLaunch));
        assert!(error.message.contains("capture hook panicked"));
        let cleanup = error.cleanup.unwrap();
        assert!(cleanup.attempted);
        assert!(cleanup.completed);
        assert_eq!(cleanup.scope, RuntimeProcessCleanupScope::ProcessTree);
    }

    #[test]
    fn before_terminate_hook_timeout_does_not_delay_cleanup() {
        let plan = RuntimeLaunchCapturePlan::new(
            HARNESS_RUN_ID,
            RuntimeOperation::Capture,
            harness_child_command("tests::harness_child_sleeps"),
        )
        .with_timeout(Duration::from_millis(50))
        .with_hook_timeout(Duration::from_millis(50))
        .with_shutdown_grace(Duration::from_secs(1))
        .with_poll_interval(Duration::from_millis(5));
        let harness = RuntimeLaunchCaptureHarness::new();
        let started = Arc::new(AtomicBool::new(false));
        let mut hooks = RuntimeCaptureHooks::new();
        hooks.push(SleepingCaptureHook {
            boundary: RuntimeCaptureBoundary::BeforeTerminate,
            started: Arc::clone(&started),
            sleep: Duration::from_secs(2),
        });
        let started_at = Instant::now();

        let error = harness.run(&plan, &mut hooks).unwrap_err();

        assert!(started.load(Ordering::SeqCst));
        assert!(started_at.elapsed() < Duration::from_secs(2));
        assert_eq!(error.kind, RuntimeHarnessErrorKind::Timeout);
        assert!(
            error
                .details
                .iter()
                .any(|(key, value)| key == "beforeTerminateHookError"
                    && value == "runtime_capture_timeout")
        );
        let cleanup = error.cleanup.unwrap();
        assert!(cleanup.attempted);
        assert!(cleanup.completed);
        assert_eq!(cleanup.scope, RuntimeProcessCleanupScope::ProcessTree);
    }

    #[cfg(unix)]
    #[test]
    fn timeout_cleanup_terminates_runtime_process_tree() {
        let temp = temp_root("process-tree");
        let heartbeat_path = temp.join("grandchild-heartbeat");
        let pid_path = temp.join("grandchild.pid");
        let plan = RuntimeLaunchCapturePlan::new(
            HARNESS_RUN_ID,
            RuntimeOperation::Capture,
            harness_child_command_with_env(
                "tests::harness_child_spawns_grandchild",
                &[
                    ("UTSUSHI_TEST_GRANDCHILD_HEARTBEAT", &heartbeat_path),
                    ("UTSUSHI_TEST_GRANDCHILD_PID", &pid_path),
                ],
            ),
        )
        .with_timeout(Duration::from_millis(250))
        .with_shutdown_grace(Duration::from_secs(1))
        .with_poll_interval(Duration::from_millis(5));
        let harness = RuntimeLaunchCaptureHarness::new();
        let mut hooks = RuntimeCaptureHooks::new();

        let error = harness.run(&plan, &mut hooks).unwrap_err();

        assert_eq!(error.kind, RuntimeHarnessErrorKind::Timeout);
        let cleanup = error.cleanup.unwrap();
        assert!(cleanup.attempted);
        assert!(cleanup.completed);
        assert_eq!(cleanup.scope, RuntimeProcessCleanupScope::ProcessTree);
        assert!(pid_path.is_file(), "grandchild should have started");
        assert!(
            heartbeat_path.is_file(),
            "grandchild should have written at least one heartbeat"
        );
        let heartbeat_after_cleanup = fs::read_to_string(&heartbeat_path).unwrap();
        std::thread::sleep(Duration::from_millis(150));
        assert_eq!(
            fs::read_to_string(&heartbeat_path).unwrap(),
            heartbeat_after_cleanup,
            "grandchild heartbeat changed after process-tree cleanup"
        );
        let _ = fs::remove_dir_all(temp);
    }

    #[cfg(unix)]
    #[test]
    fn nonzero_exit_cleanup_terminates_runtime_process_tree() {
        let temp = temp_root("nonzero-process-tree");
        let heartbeat_path = temp.join("grandchild-heartbeat");
        let pid_path = temp.join("grandchild.pid");
        let plan = RuntimeLaunchCapturePlan::new(
            HARNESS_RUN_ID,
            RuntimeOperation::Capture,
            harness_child_command_with_env(
                "tests::harness_child_spawns_grandchild_then_fails",
                &[
                    ("UTSUSHI_TEST_GRANDCHILD_HEARTBEAT", &heartbeat_path),
                    ("UTSUSHI_TEST_GRANDCHILD_PID", &pid_path),
                ],
            ),
        )
        .with_timeout(Duration::from_secs(5))
        .with_shutdown_grace(Duration::from_secs(1))
        .with_poll_interval(Duration::from_millis(5));
        let harness = RuntimeLaunchCaptureHarness::new();
        let mut hooks = RuntimeCaptureHooks::new();

        let error = harness.run(&plan, &mut hooks).unwrap_err();

        assert_eq!(error.kind, RuntimeHarnessErrorKind::ProcessFailed);
        assert_eq!(error.code(), "runtime_process_failed");
        assert!(
            error
                .details
                .iter()
                .any(|(key, value)| { key == "exitCode" && value == "42" })
        );
        let cleanup = error.cleanup.unwrap();
        assert!(cleanup.attempted);
        assert!(cleanup.completed);
        assert_eq!(cleanup.scope, RuntimeProcessCleanupScope::ProcessTree);
        assert!(pid_path.is_file(), "grandchild should have started");
        assert!(
            heartbeat_path.is_file(),
            "grandchild should have written at least one heartbeat"
        );
        let heartbeat_after_cleanup = fs::read_to_string(&heartbeat_path).unwrap();
        std::thread::sleep(Duration::from_millis(150));
        assert_eq!(
            fs::read_to_string(&heartbeat_path).unwrap(),
            heartbeat_after_cleanup,
            "grandchild heartbeat changed after non-zero process cleanup"
        );
        let _ = fs::remove_dir_all(temp);
    }

    #[cfg(unix)]
    #[test]
    fn nonzero_exit_after_exit_hook_failure_cleans_process_tree_before_returning() {
        let temp = temp_root("nonzero-after-exit-hook-process-tree");
        let heartbeat_path = temp.join("grandchild-heartbeat");
        let pid_path = temp.join("grandchild.pid");
        let plan = RuntimeLaunchCapturePlan::new(
            HARNESS_RUN_ID,
            RuntimeOperation::Capture,
            harness_child_command_with_env(
                "tests::harness_child_spawns_grandchild_then_fails",
                &[
                    ("UTSUSHI_TEST_GRANDCHILD_HEARTBEAT", &heartbeat_path),
                    ("UTSUSHI_TEST_GRANDCHILD_PID", &pid_path),
                ],
            ),
        )
        .with_timeout(Duration::from_secs(5))
        .with_shutdown_grace(Duration::from_secs(1))
        .with_poll_interval(Duration::from_millis(5));
        let harness = RuntimeLaunchCaptureHarness::new();
        let mut hooks = RuntimeCaptureHooks::new();
        hooks.push(FailingCaptureHook {
            boundary: RuntimeCaptureBoundary::AfterExit,
        });

        let error = harness.run(&plan, &mut hooks).unwrap_err();

        assert_eq!(error.kind, RuntimeHarnessErrorKind::CaptureFailed);
        assert_eq!(error.code(), "runtime_capture_failed");
        assert_eq!(error.boundary, Some(RuntimeCaptureBoundary::AfterExit));
        assert!(
            error
                .message
                .contains("intentional after-exit hook failure")
        );
        assert!(
            error
                .details
                .iter()
                .any(|(key, value)| key == "processFailure" && value == "runtime_process_failed")
        );
        assert!(
            error
                .details
                .iter()
                .any(|(key, value)| key == "exitCode" && value == "42")
        );
        let cleanup = error.cleanup.unwrap();
        assert!(cleanup.attempted);
        assert!(cleanup.completed);
        assert_eq!(cleanup.scope, RuntimeProcessCleanupScope::ProcessTree);
        assert!(pid_path.is_file(), "grandchild should have started");
        assert!(
            heartbeat_path.is_file(),
            "grandchild should have written at least one heartbeat"
        );
        let heartbeat_after_cleanup = fs::read_to_string(&heartbeat_path).unwrap();
        std::thread::sleep(Duration::from_millis(150));
        assert_eq!(
            fs::read_to_string(&heartbeat_path).unwrap(),
            heartbeat_after_cleanup,
            "grandchild heartbeat changed after after-exit hook/process cleanup"
        );
        let _ = fs::remove_dir_all(temp);
    }

    #[test]
    fn successful_exit_after_exit_hook_failure_reports_process_exit_diagnostics() {
        let plan = RuntimeLaunchCapturePlan::new(
            HARNESS_RUN_ID,
            RuntimeOperation::Capture,
            harness_child_command("tests::harness_child_exits"),
        )
        .with_timeout(Duration::from_secs(5))
        .with_hook_timeout(Duration::from_secs(1));
        let harness = RuntimeLaunchCaptureHarness::new();
        let mut hooks = RuntimeCaptureHooks::new();
        hooks.push(FailingCaptureHook {
            boundary: RuntimeCaptureBoundary::AfterExit,
        });

        let error = harness.run(&plan, &mut hooks).unwrap_err();

        assert_eq!(error.kind, RuntimeHarnessErrorKind::CaptureFailed);
        assert_eq!(error.boundary, Some(RuntimeCaptureBoundary::AfterExit));
        assert!(
            error
                .details
                .iter()
                .any(|(key, value)| key == "processExit" && value == "success")
        );
        assert!(
            error
                .details
                .iter()
                .any(|(key, value)| key == "processExitSuccess" && value == "true")
        );
        let diagnostic = error.to_json();
        assert_eq!(diagnostic["boundary"], "after_exit");
        assert_eq!(diagnostic["details"]["processExit"], "success");
        assert_eq!(diagnostic["details"]["processExitSuccess"], "true");
    }

    #[cfg(not(unix))]
    #[test]
    fn launch_capture_harness_fails_closed_without_process_tree_cleanup_support() {
        let plan = RuntimeLaunchCapturePlan::new(
            HARNESS_RUN_ID,
            RuntimeOperation::Capture,
            harness_child_command("tests::harness_child_exits"),
        );
        let harness = RuntimeLaunchCaptureHarness::new();
        let mut hooks = RuntimeCaptureHooks::new();

        let error = harness.run(&plan, &mut hooks).unwrap_err();

        assert_eq!(error.kind, RuntimeHarnessErrorKind::InvalidPlan);
        assert!(
            error
                .message
                .contains("process-tree cleanup is unsupported")
        );
        assert!(
            error
                .details
                .iter()
                .any(|(key, value)| key == "cleanupScope" && value == "process_tree")
        );
    }

    #[test]
    fn runtime_artifact_names_are_deterministic_and_managed() {
        let uri = runtime_artifact_uri(
            "019ed003-0000-7000-8000-000000001000",
            RuntimeArtifactKind::Screenshot,
            "019ed003-0000-7000-8000-000000002000",
        )
        .unwrap();

        assert_eq!(
            uri,
            "artifacts/utsushi/runtime/019ed003-0000-7000-8000-000000001000/screenshots/019ed003-0000-7000-8000-000000002000.png"
        );
        assert_eq!(RuntimeArtifactKind::TraceLog.artifact_kind(), "trace_log");
        assert_eq!(
            RuntimeArtifactKind::FrameCapture.artifact_kind(),
            "frame_capture"
        );
        assert_eq!(RuntimeArtifactKind::Recording.artifact_kind(), "recording");
        assert_eq!(
            RuntimeArtifactKind::ConformanceReport.artifact_kind(),
            "reference_comparison"
        );
        assert!(validate_runtime_artifact_uri(&uri).is_ok());
    }

    #[test]
    fn runtime_artifact_paths_reject_traversal_and_external_uris() {
        for uri in [
            "../capture.png",
            "artifacts/utsushi/runtime/run/screenshots/../capture.png",
            "artifacts/utsushi/runtime/run/screenshots/./capture.png",
            "/tmp/capture.png",
            "file:///tmp/capture.png",
            "data:image/png;base64,AAAA",
            "artifacts\\utsushi\\runtime\\run\\capture.png",
            "artifacts/utsushi/hello/frame.png",
        ] {
            assert!(
                validate_runtime_artifact_uri(uri).is_err(),
                "{uri} should be rejected"
            );
        }
    }

    #[test]
    fn runtime_artifact_root_maps_uris_inside_managed_root() {
        let temp = temp_root("artifact-path");
        let root = RuntimeArtifactRoot::new(temp.join("runtime-artifacts"));
        let uri = runtime_artifact_uri("run-1", RuntimeArtifactKind::TraceLog, "trace-1").unwrap();

        let path = root.artifact_path(&uri).unwrap();

        assert!(path.starts_with(root.path()));
        assert_eq!(path.file_name().unwrap(), "trace-1.json");
        assert!(root.artifact_path("../source.json").is_err());
        let _ = fs::remove_dir_all(temp);
    }

    #[test]
    fn runtime_artifact_cleanup_requires_marker_and_keeps_other_roots() {
        let temp = temp_root("cleanup");
        let source_game = temp.join("game");
        let local_corpus = temp.join("local-corpus");
        let benchmark = temp.join("benchmark-output");
        let patch_output = temp.join("patch-output");
        for dir in [&source_game, &local_corpus, &benchmark, &patch_output] {
            fs::create_dir_all(dir).unwrap();
            fs::write(dir.join("keep.txt"), "not managed by utsushi runtime\n").unwrap();
        }

        let source_root = RuntimeArtifactRoot::new(&source_game);
        assert!(source_root.cleanup_contents().is_err());
        assert!(source_game.join("keep.txt").is_file());

        let managed_path = temp.join("runtime-artifacts");
        let managed_root = RuntimeArtifactRoot::new(&managed_path);
        managed_root.prepare().unwrap();
        let uri =
            runtime_artifact_uri("run-cleanup", RuntimeArtifactKind::Recording, "recording-1")
                .unwrap();
        let artifact_path = managed_root
            .write_bytes(&uri, b"runtime recording reference")
            .unwrap();
        assert!(artifact_path.is_file());

        managed_root.cleanup_contents().unwrap();

        assert!(managed_path.join(RUNTIME_ARTIFACT_ROOT_MARKER).is_file());
        assert!(!artifact_path.exists());
        for dir in [&source_game, &local_corpus, &benchmark, &patch_output] {
            assert!(dir.join("keep.txt").is_file());
        }
        let _ = fs::remove_dir_all(temp);
    }

    #[test]
    fn runtime_artifact_prepare_refuses_non_empty_unmarked_roots() {
        let temp = temp_root("adoption");
        let source_game = temp.join("game");
        fs::create_dir_all(&source_game).unwrap();
        fs::write(source_game.join("keep.txt"), "source content\n").unwrap();

        let root = RuntimeArtifactRoot::new(&source_game);
        let error = root.prepare().unwrap_err().to_string();

        assert!(error.contains("non-empty unmarked"));
        assert!(source_game.join("keep.txt").is_file());
        assert!(!source_game.join(RUNTIME_ARTIFACT_ROOT_MARKER).exists());
        let _ = fs::remove_dir_all(temp);
    }

    #[test]
    fn runtime_artifact_cleanup_refuses_marked_source_roots() {
        let temp = temp_root("marked-source");
        let source_root = temp.join("repo");
        fs::create_dir_all(&source_root).unwrap();
        fs::write(
            source_root.join("Cargo.toml"),
            "[package]\nname = \"source\"\n",
        )
        .unwrap();
        fs::write(
            source_root.join(RUNTIME_ARTIFACT_ROOT_MARKER),
            "managed-by=utsushi-runtime\n",
        )
        .unwrap();
        fs::write(source_root.join("keep.txt"), "source content\n").unwrap();

        let root = RuntimeArtifactRoot::new(&source_root);
        let error = root.cleanup_contents().unwrap_err().to_string();

        assert!(error.contains("obvious source or project root"));
        assert!(source_root.join("Cargo.toml").is_file());
        assert!(source_root.join("keep.txt").is_file());
        let _ = fs::remove_dir_all(temp);
    }

    #[cfg(unix)]
    #[test]
    fn runtime_artifact_write_rejects_symlink_parent_components() {
        use std::os::unix::fs as unix_fs;

        let temp = temp_root("symlink-parent");
        let managed_path = temp.join("runtime-artifacts");
        let outside = temp.join("outside");
        fs::create_dir_all(&outside).unwrap();
        let root = RuntimeArtifactRoot::new(&managed_path);
        root.prepare().unwrap();
        unix_fs::symlink(&outside, managed_path.join("run-link")).unwrap();
        let uri =
            runtime_artifact_uri("run-link", RuntimeArtifactKind::TraceLog, "trace-1").unwrap();

        let error = root.write_bytes(&uri, b"trace").unwrap_err().to_string();

        assert!(error.contains("symlink"));
        assert!(!outside.join("traces").exists());
        let _ = fs::remove_dir_all(temp);
    }

    #[cfg(unix)]
    #[test]
    fn runtime_artifact_write_rejects_symlink_destinations() {
        use std::os::unix::fs as unix_fs;

        let temp = temp_root("symlink-destination");
        let managed_path = temp.join("runtime-artifacts");
        let outside = temp.join("outside.txt");
        fs::write(&outside, "outside content\n").unwrap();
        let root = RuntimeArtifactRoot::new(&managed_path);
        root.prepare().unwrap();
        let uri =
            runtime_artifact_uri("run-dest", RuntimeArtifactKind::TraceLog, "trace-1").unwrap();
        let artifact_path = root.artifact_path(&uri).unwrap();
        fs::create_dir_all(artifact_path.parent().unwrap()).unwrap();
        unix_fs::symlink(&outside, &artifact_path).unwrap();

        let error = root.write_bytes(&uri, b"trace").unwrap_err().to_string();

        assert!(error.contains("symlink"));
        assert_eq!(fs::read_to_string(&outside).unwrap(), "outside content\n");
        let _ = fs::remove_dir_all(temp);
    }

    // crux: a concurrent actor SWAPS a validated run directory for a
    // symlink pointing OUTSIDE the managed root while writes are in flight. The
    // fd-relative / no-follow write path must never follow the swapped-in link
    // so nothing is ever created under the escape target — proving the TOCTOU
    // window between "validated as a real directory" and "written into" is shut.
    #[cfg(unix)]
    #[test]
    fn runtime_artifact_write_cannot_escape_via_concurrent_symlink_swap() {
        use std::os::unix::fs as unix_fs;
        use std::sync::Arc;
        use std::sync::atomic::{AtomicBool, Ordering};

        let temp = temp_root("swap-escape");
        let managed = temp.join("runtime-artifacts");
        let outside = temp.join("outside");
        fs::create_dir_all(&outside).unwrap();
        let root = RuntimeArtifactRoot::new(&managed);
        root.prepare().unwrap();

        // "swap" is the run id, so the first path component the writer descends
        // into is `managed/swap`; that is exactly what the attacker swaps.
        let swap_path = managed.join("swap");
        let stop = Arc::new(AtomicBool::new(false));

        let bg_stop = Arc::clone(&stop);
        let bg_target = outside.clone();
        let bg_path = swap_path.clone();
        let attacker = std::thread::spawn(move || {
            while !bg_stop.load(Ordering::Relaxed) {
                // Plant a symlink to the escape target where the run directory
                // lives; a path-following writer would create the artifact tree
                // under `outside` instead of `managed`.
                let _ = unix_fs::symlink(&bg_target, &bg_path);
                std::thread::yield_now();
                // Tear down whatever is there (our own link, or a real dir the
                // writer created) so the swap keeps cycling.
                match fs::symlink_metadata(&bg_path) {
                    Ok(meta) if meta.file_type().is_symlink() => {
                        let _ = fs::remove_file(&bg_path);
                    }
                    Ok(meta) if meta.is_dir() => {
                        let _ = fs::remove_dir_all(&bg_path);
                    }
                    _ => {}
                }
                std::thread::yield_now();
            }
        });

        let uri = runtime_artifact_uri("swap", RuntimeArtifactKind::Screenshot, "frame").unwrap();
        for _ in 0..4000 {
            // Each write either lands inside `managed` or fails — it must NEVER
            // create anything under the swapped-in symlink's target.
            let _ = root.write_bytes(&uri, b"frame-bytes");
            assert!(
                !outside.join("screenshots").exists(),
                "write escaped the managed root through a swapped-in symlink"
            );
        }

        stop.store(true, Ordering::Relaxed);
        attacker.join().unwrap();

        // End state: the escape target was never populated by any write.
        let escaped: Vec<_> = fs::read_dir(&outside)
            .unwrap()
            .map(|entry| entry.unwrap().file_name())
            .collect();
        assert!(
            escaped.is_empty(),
            "escape target must remain empty, found: {escaped:?}"
        );

        // The legitimate case still works once contention stops.
        let _ = fs::remove_dir_all(&swap_path);
        let path = root.write_bytes(&uri, b"frame-bytes").unwrap();
        assert!(path.starts_with(&managed));
        assert_eq!(fs::read(&path).unwrap(), b"frame-bytes");

        let _ = fs::remove_dir_all(temp);
    }

    // the soft artifact-byte budget is enforced on the REAL
    // artifact-store write path (RuntimeArtifactRoot::write_bytes), not a
    // cfg(test) shim. An over-budget write surfaces SinkError::BudgetExhausted
    // with the artifact-store sink id + budget label; an under-budget write
    // succeeds and lands under the managed root.
    #[cfg(unix)]
    #[test]
    fn write_bytes_over_soft_byte_budget_surfaces_budget_exhausted_on_real_path() {
        let temp = temp_root("soft-byte-budget");
        let managed = temp.join("runtime-artifacts");
        let root = RuntimeArtifactRoot::new(&managed).with_soft_byte_budget(8);
        root.prepare().unwrap();

        let uri = runtime_artifact_uri("run", RuntimeArtifactKind::Screenshot, "frame").unwrap();

        // Under budget: the real write succeeds and lands under the managed
        // root with the exact bytes — no false BudgetExhausted.
        let ok = root.write_bytes(&uri, b"12345678").unwrap();
        assert!(ok.starts_with(&managed));
        assert_eq!(fs::read(&ok).unwrap(), b"12345678");

        // Over budget: the real write path surfaces SinkError::BudgetExhausted
        // (boxed into UtsushiResult), downcast back to the stable diagnostic.
        let error = root
            .write_bytes(&uri, b"123456789")
            .expect_err("over-budget write must be rejected");
        let sink_error = error
            .downcast_ref::<SinkError>()
            .expect("over-budget write must box a SinkError");
        match sink_error {
            SinkError::BudgetExhausted { sink, budget } => {
                assert_eq!(*sink, SinkKind::FrameArtifact);
                assert_eq!(budget, RUNTIME_ARTIFACT_SOFT_BYTE_BUDGET_LABEL);
                assert_eq!(budget, "frame_byte_cap");
            }
            other => panic!("expected BudgetExhausted, got {other:?}"),
        }

        // The rejected over-budget write must not have mutated the artifact:
        // it targets the same managed path as the under-budget write (same
        // URI), so that on-disk file must still hold the under-budget payload
        // exactly — never the over-budget bytes that were rejected.
        assert_eq!(
            fs::read(&ok).unwrap(),
            b"12345678",
            "rejected over-budget write must leave the artifact bytes unchanged"
        );

        let _ = fs::remove_dir_all(temp);
    }

    // a root with no configured budget never rejects a write for
    // budget reasons — the historical unbudgeted behaviour is preserved.
    #[cfg(unix)]
    #[test]
    fn write_bytes_without_soft_byte_budget_never_rejects_for_budget() {
        let temp = temp_root("no-soft-byte-budget");
        let managed = temp.join("runtime-artifacts");
        let root = RuntimeArtifactRoot::new(&managed);
        root.prepare().unwrap();

        let uri = runtime_artifact_uri("run", RuntimeArtifactKind::Screenshot, "frame").unwrap();
        let large = vec![0u8; 4096];
        let path = root.write_bytes(&uri, &large).unwrap();
        assert!(path.starts_with(&managed));
        assert_eq!(fs::read(&path).unwrap().len(), large.len());

        let _ = fs::remove_dir_all(temp);
    }

    // cleanup traverses ONLY real directories. A symlink anywhere
    // in the managed tree (top-level or nested) is unlinked in place — the link
    // itself is removed and is never recursed into — so cleanup can never follow
    // a symlink to a target outside the root.
    #[cfg(unix)]
    #[test]
    fn runtime_artifact_cleanup_does_not_follow_symlink_out_of_root() {
        use std::os::unix::fs as unix_fs;

        let temp = temp_root("cleanup-symlink-escape");
        let managed = temp.join("runtime-artifacts");
        let outside = temp.join("outside");
        fs::create_dir_all(&outside).unwrap();
        let secret = outside.join("secret.txt");
        fs::write(&secret, "must survive cleanup\n").unwrap();

        let root = RuntimeArtifactRoot::new(&managed);
        root.prepare().unwrap();

        // A genuine artifact the cleanup should remove.
        let uri = runtime_artifact_uri("run", RuntimeArtifactKind::TraceLog, "trace-1").unwrap();
        let real = root.write_bytes(&uri, b"trace").unwrap();
        assert!(real.is_file());

        // A symlink nested deep in the managed tree, pointing at the outside
        // directory, plus a top-level symlink pointing at the outside file.
        let nested = managed.join("run").join("nested");
        fs::create_dir_all(&nested).unwrap();
        unix_fs::symlink(&outside, nested.join("escape-dir")).unwrap();
        unix_fs::symlink(&secret, managed.join("escape-file")).unwrap();

        root.cleanup_contents().unwrap();

        // Only the managed-root marker survives inside the root.
        let mut remaining: Vec<_> = fs::read_dir(&managed)
            .unwrap()
            .map(|entry| entry.unwrap().file_name())
            .collect();
        remaining.sort();
        assert_eq!(
            remaining,
            vec![std::ffi::OsString::from(RUNTIME_ARTIFACT_ROOT_MARKER)]
        );

        // The symlink targets outside the root were NOT followed or removed.
        assert!(outside.is_dir(), "outside directory must survive cleanup");
        assert_eq!(
            fs::read_to_string(&secret).unwrap(),
            "must survive cleanup\n",
            "outside file must survive cleanup"
        );

        let _ = fs::remove_dir_all(temp);
    }
}
