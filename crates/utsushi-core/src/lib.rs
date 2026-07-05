use std::any::Any;
use std::collections::HashSet;
use std::fs;
use std::io::{self, Read};
use std::panic::{self, AssertUnwindSafe};
use std::path::{Component, Path, PathBuf};
use std::process::{Child, Command, ExitStatus, Stdio};
use std::str::FromStr;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;
use std::thread;
use std::time::{Duration, Instant};

// UTSUSHI-093: fd-relative / no-follow runtime-artifact filesystem operations.
// The managed root is opened once as a directory descriptor and every
// write/rename/cleanup is driven RELATIVE to that descriptor with `O_NOFOLLOW`,
// so a subdirectory validated as a real directory cannot be swapped for a
// symlink that escapes the root between the check and the operation.
#[cfg(unix)]
use std::ffi::OsStr;
#[cfg(unix)]
use std::os::fd::{AsFd, BorrowedFd, OwnedFd};

use serde::{Deserialize, Deserializer, Serialize, Serializer};
use serde_json::{Map, Value};

pub mod clock;
pub mod conformance;
pub mod embed;
pub mod input;
pub mod port;
pub mod recorder;
pub mod replay;
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
// UTSUSHI-009: MV/MZ branch coverage read model (data-only join of runtime
// trace observations + Itotori route maps → per-branch coverage status).
pub use conformance::branch_coverage::{
    BRANCH_COVERAGE_READ_MODEL_SCHEMA_VERSION, BranchCoverageError, BranchCoverageFixture,
    BranchCoverageFixtureError, BranchCoverageReadModel, BranchCoverageRecord,
    BranchCoverageSummary, BranchTraceObservation, CoverageStatus, RouteMapEntry,
    derive_coverage_status, join_branch_coverage,
    read_model_from_json as branch_coverage_read_model_from_json,
};
// UTSUSHI-069: branch-coverage GAP FINDING emitter (data-only; reads the
// UTSUSHI-009 read model and emits gap findings for unvisited-reachable +
// ambiguous branches, never visited/unreachable).
pub use conformance::branch_coverage_gaps::{
    BRANCH_COVERAGE_GAP_FINDINGS_SCHEMA_VERSION, BranchCoverageGapFinding, BranchCoverageGapReport,
    BranchCoverageGapSummary, GapArtifactLink, GapKind, GapSeverity, HIGH_TEXT_SEVERITY_THRESHOLD,
    emit_branch_coverage_gap_findings, severity_for as branch_coverage_gap_severity_for,
};
// UTSUSHI-070: branch-coverage EXPORT artifact (data-only; reshapes the
// UTSUSHI-009 read model + UTSUSHI-069 gap summaries into a stable JSON +
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
pub use port::{
    CapabilityReason, CaptureOutcome, DriftKind, EnginePort, EnginePortAdapter, EnginePortError,
    EnvFieldSchema, EnvFieldShape, LifecycleStage, ManifestError, MomentId,
    OPTIONAL_LIFECYCLE_STAGES, PortCapability, PortEnv, PortManifest, PortRequest,
    PortShutdownOutcome, PortShutdownStatus, REQUIRED_LIFECYCLE_STAGES, Runner, RunnerCancellation,
    RunnerObservation, RunnerOutcome,
};
pub use recorder::{
    InMemoryReferenceRecorder, REFERENCE_TRACE_SCHEMA_VERSION, RecordingTextSink,
    ReferenceRecorder, ReferenceTrace, SourceTag, deterministic_json_bytes,
};
pub use replay::{
    REPLAY_LOG_SCHEMA_VERSION, ReplayCursor, ReplayEntry, ReplayLog, ReplayLogBuilder,
    ReplayMetadata, ReplaySchemaVersion,
};
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
/// payload tests (see UTSUSHI-022). The re-export keeps the public surface
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

pub type UtsushiResult<T> = Result<T, Box<dyn std::error::Error>>;

pub const RUNTIME_ARTIFACT_URI_ROOT: &str = "artifacts/utsushi/runtime";
pub const RUNTIME_ARTIFACT_ROOT_MARKER: &str = ".utsushi-runtime-artifacts";
// UTSUSHI-224: the legacy `deleted-hook-envelope` enum + its schema version
// constant were deleted along with the typed observation-hook envelope. The
// engine-port substrate now drives observation via the sink-set bridge in
// `crate::sink::SinkSet`; the wire-shape `observationHookEvents` array
// remains a `kaifuu-core` contract surface (validated independently of any
// `utsushi-core` Rust type).

const DEFAULT_HARNESS_TIMEOUT: Duration = Duration::from_secs(30);
const DEFAULT_HARNESS_SHUTDOWN_GRACE: Duration = Duration::from_secs(2);
const DEFAULT_HARNESS_HOOK_TIMEOUT: Duration = Duration::from_secs(5);
const DEFAULT_HARNESS_POLL_INTERVAL: Duration = Duration::from_millis(10);
const RUNTIME_ARTIFACT_STAGING_DIR: &str = ".staging";

const OBVIOUS_UNMANAGED_ROOT_SENTINELS: &[&str] = &[
    ".git",
    "Cargo.toml",
    "package.json",
    "pyproject.toml",
    "go.mod",
    "project.godot",
    "Assets",
];

#[derive(Clone)]
pub struct RuntimeRequest<'a> {
    pub input_root: &'a Path,
    pub artifact_root: Option<&'a Path>,
    /// Optional, additive handoff for downstream nodes that consume the
    /// runtime VFS (UTSUSHI-021/022/023/024/103). Slice A of UTSUSHI-020
    /// only adds the field so callers can begin to populate it.
    pub vfs: Option<Arc<dyn RuntimeVfs>>,
    /// Optional, additive handoff for the deterministic replay log
    /// (UTSUSHI-021). When `Some`, an adapter that drives input MUST consume
    /// events through `ReplayLog::next_event` instead of querying live input.
    /// `Arc<ReplayLog>` keeps cloning cheap when the runner shares the log
    /// across multiple adapter invocations.
    pub replay: Option<Arc<ReplayLog>>,
    /// Cancellation token. The `EnginePortAdapter` bridge forwards this
    /// into `EnginePort::launch`/`observe`/`capture` so a long-running
    /// port honours cooperative cancellation; adapters that do not run a
    /// cancellable loop ignore the field.
    pub cancellation: Option<RunnerCancellation>,
    /// Optional snapshot anchor (UTSUSHI-023). When `Some`, the runner is
    /// being asked to restore the snapshot at `start` and replay from the
    /// matching anchor. The reference is intentionally lightweight
    /// (id-only, no payload); the full [`Snapshot`] is resolved by the
    /// runner through the [`SnapshotStore`] trait (UTSUSHI-028). The
    /// trait has typed errors only — `NotFound`,
    /// `MismatchedSchemaVersion`, `InvalidSnapshotRef`,
    /// `InspectableIdMismatch`, `StoreUnavailable` — so an adapter
    /// receiving this field can rely on the runner having resolved the
    /// ref through a single audit seam. Adapters that do not consume
    /// snapshots ignore the field.
    pub snapshot: Option<SnapshotRef>,
}

impl std::fmt::Debug for RuntimeRequest<'_> {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("RuntimeRequest")
            .field("input_root", &self.input_root)
            .field("artifact_root", &self.artifact_root)
            .field("vfs", &self.vfs.as_ref().map(|_| "Arc<dyn RuntimeVfs>"))
            .field("replay", &self.replay.as_ref().map(|_| "Arc<ReplayLog>"))
            .field(
                "cancellation",
                &self.cancellation.as_ref().map(|_| "RunnerCancellation"),
            )
            .field(
                "snapshot",
                &if self.snapshot.is_some() {
                    "<present>"
                } else {
                    "<absent>"
                },
            )
            .finish()
    }
}

impl<'a> RuntimeRequest<'a> {
    pub fn new(input_root: &'a Path) -> Self {
        Self {
            input_root,
            artifact_root: None,
            vfs: None,
            replay: None,
            cancellation: None,
            snapshot: None,
        }
    }

    pub fn with_artifact_root(mut self, artifact_root: &'a Path) -> Self {
        self.artifact_root = Some(artifact_root);
        self
    }

    pub fn with_vfs(mut self, vfs: Arc<dyn RuntimeVfs>) -> Self {
        self.vfs = Some(vfs);
        self
    }

    pub fn with_replay(mut self, replay: Arc<ReplayLog>) -> Self {
        self.replay = Some(replay);
        self
    }

    pub fn with_cancellation(mut self, cancellation: RunnerCancellation) -> Self {
        self.cancellation = Some(cancellation);
        self
    }

    pub fn with_snapshot(mut self, snapshot: SnapshotRef) -> Self {
        self.snapshot = Some(snapshot);
        self
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum RuntimeArtifactKind {
    TraceLog,
    Screenshot,
    FrameCapture,
    Recording,
    ConformanceReport,
}

impl RuntimeArtifactKind {
    pub fn artifact_kind(self) -> &'static str {
        match self {
            Self::TraceLog => "trace_log",
            Self::Screenshot => "screenshot",
            Self::FrameCapture => "frame_capture",
            Self::Recording => "recording",
            Self::ConformanceReport => "reference_comparison",
        }
    }

    pub fn directory(self) -> &'static str {
        match self {
            Self::TraceLog => "traces",
            Self::Screenshot => "screenshots",
            Self::FrameCapture => "frame-captures",
            Self::Recording => "recordings",
            Self::ConformanceReport => "conformance-reports",
        }
    }

    pub fn default_extension(self) -> &'static str {
        match self {
            Self::TraceLog | Self::ConformanceReport => "json",
            Self::Screenshot | Self::FrameCapture => "png",
            Self::Recording => "webm",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RuntimeArtifactName {
    pub run_id: String,
    pub kind: RuntimeArtifactKind,
    pub artifact_id: String,
    pub extension: String,
}

impl RuntimeArtifactName {
    pub fn new(
        run_id: impl Into<String>,
        kind: RuntimeArtifactKind,
        artifact_id: impl Into<String>,
    ) -> UtsushiResult<Self> {
        Self::with_extension(run_id, kind, artifact_id, kind.default_extension())
    }

    pub fn with_extension(
        run_id: impl Into<String>,
        kind: RuntimeArtifactKind,
        artifact_id: impl Into<String>,
        extension: impl Into<String>,
    ) -> UtsushiResult<Self> {
        let name = Self {
            run_id: run_id.into(),
            kind,
            artifact_id: artifact_id.into(),
            extension: extension.into(),
        };
        validate_artifact_segment("run id", &name.run_id)?;
        validate_artifact_segment("artifact id", &name.artifact_id)?;
        validate_artifact_extension(&name.extension)?;
        Ok(name)
    }

    pub fn uri(&self) -> String {
        format!(
            "{}/{}/{}/{}.{}",
            RUNTIME_ARTIFACT_URI_ROOT,
            self.run_id,
            self.kind.directory(),
            self.artifact_id,
            self.extension
        )
    }
}

/// Stable `budget` label surfaced by [`RuntimeArtifactRoot::write_bytes`] when
/// a write exceeds the configured soft artifact-byte budget. This is the
/// `budget` field of [`SinkError::BudgetExhausted`] for every write routed
/// through the artifact store; the artifact store is the `FrameArtifact` sink's
/// storage surface, so the accompanying sink id is always
/// [`SinkKind::FrameArtifact`].
pub const RUNTIME_ARTIFACT_SOFT_BYTE_BUDGET_LABEL: &str = "frame_byte_cap";

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RuntimeArtifactRoot {
    root: PathBuf,
    /// Optional soft artifact-byte budget. When set, a [`Self::write_bytes`]
    /// whose payload exceeds this cap surfaces [`SinkError::BudgetExhausted`]
    /// instead of writing. `None` (the default from [`Self::new`]) disables the
    /// check, preserving the historical unbudgeted behaviour.
    soft_byte_budget: Option<u64>,
}

impl RuntimeArtifactRoot {
    pub fn new(root: impl Into<PathBuf>) -> Self {
        Self {
            root: root.into(),
            soft_byte_budget: None,
        }
    }

    /// Configure a soft artifact-byte budget. A subsequent [`Self::write_bytes`]
    /// whose payload exceeds `budget` bytes surfaces
    /// [`SinkError::BudgetExhausted`] (`sink = SinkKind::FrameArtifact`,
    /// `budget = RUNTIME_ARTIFACT_SOFT_BYTE_BUDGET_LABEL`) rather than writing.
    /// This is the real artifact-store budget surface: any adapter writing
    /// through this root receives the diagnostic on the live path.
    #[must_use]
    pub fn with_soft_byte_budget(mut self, budget: u64) -> Self {
        self.soft_byte_budget = Some(budget);
        self
    }

    pub fn path(&self) -> &Path {
        &self.root
    }

    pub fn artifact_path(&self, uri: &str) -> UtsushiResult<PathBuf> {
        let relative = validate_runtime_artifact_uri(uri)?;
        Ok(self.root.join(relative))
    }

    /// Reject a write of `len` bytes when it would exceed the configured soft
    /// artifact-byte budget, returning [`SinkError::BudgetExhausted`] with the
    /// artifact-store sink id and budget label. `Ok(())` when under budget or
    /// when no budget is configured. Shared by the unix and non-unix
    /// [`Self::write_bytes`] paths so the budget diagnostic is reachable from
    /// the real write path on every platform.
    fn check_soft_byte_budget(&self, len: usize) -> Result<(), SinkError> {
        if let Some(budget) = self.soft_byte_budget
            && len as u64 > budget
        {
            return Err(SinkError::BudgetExhausted {
                sink: SinkKind::FrameArtifact,
                budget: RUNTIME_ARTIFACT_SOFT_BYTE_BUDGET_LABEL.to_string(),
            });
        }
        Ok(())
    }
}

// UTSUSHI-093: all mutating runtime-artifact operations are fd-relative and
// no-follow (openat/mkdirat/renameat/unlinkat/getdents against a directory
// descriptor opened once with `O_NOFOLLOW`). This closes the TOCTOU window in
// which a concurrent actor could swap a directory that was validated as real
// for a symlink that escapes the managed root before the write/rename/cleanup
// executes.
#[cfg(unix)]
impl RuntimeArtifactRoot {
    pub fn prepare(&self) -> UtsushiResult<()> {
        // Open the root as a directory descriptor with `O_NOFOLLOW`; if it does
        // not exist yet, create it (and any missing ancestors) then re-open.
        let root_fd = match artifact_fs::open_root_dir(&self.root) {
            Ok(fd) => fd,
            Err(error) if error.kind() == io::ErrorKind::NotFound => {
                artifact_fs::create_directory_no_follow(&self.root)?;
                artifact_fs::open_root_dir(&self.root)
                    .map_err(|error| artifact_fs::describe_root_open(&self.root, error))?
            }
            Err(error) => return Err(artifact_fs::describe_root_open(&self.root, error)),
        };

        self.assert_not_obvious_unmanaged_root(root_fd.as_fd())?;

        // The marker is resolved relative to the held descriptor, so it always
        // refers to an entry inside the directory we actually opened.
        match artifact_fs::entry_file_type(root_fd.as_fd(), RUNTIME_ARTIFACT_ROOT_MARKER) {
            Ok(file_type) => {
                if file_type.is_symlink() || !file_type.is_file() {
                    return Err(format!(
                        "runtime artifact root marker must be a regular file: {}",
                        self.root.join(RUNTIME_ARTIFACT_ROOT_MARKER).display()
                    )
                    .into());
                }
                return Ok(());
            }
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.into()),
        }

        if artifact_fs::dir_has_entries(root_fd.as_fd())? {
            return Err(format!(
                "refusing to adopt non-empty unmarked runtime artifact root {}",
                self.root.display()
            )
            .into());
        }

        artifact_fs::write_marker(root_fd.as_fd())?;
        Ok(())
    }

    pub fn write_bytes(&self, uri: &str, contents: &[u8]) -> UtsushiResult<PathBuf> {
        // Soft artifact-budget gate on the real write path: an over-budget
        // write surfaces SinkError::BudgetExhausted (boxed into UtsushiResult)
        // before any filesystem mutation.
        self.check_soft_byte_budget(contents.len())?;
        let relative = validate_runtime_artifact_uri(uri)?;
        let Some(parent) = relative.parent() else {
            return Err(
                format!("runtime artifact uri is missing parent directories: {uri}").into(),
            );
        };
        let Some(filename) = relative.file_name() else {
            return Err(format!("runtime artifact uri is missing a filename: {uri}").into());
        };

        let root_fd = self.open_managed_root_fd()?;
        let dir_fd = artifact_fs::open_or_create_dir_chain(root_fd.as_fd(), parent)?;
        artifact_fs::write_file_no_follow(dir_fd.as_fd(), filename, contents)?;
        Ok(self.root.join(&relative))
    }

    pub fn prepare_staging_file(
        &self,
        run_id: &str,
        artifact_id: &str,
        extension: &str,
    ) -> UtsushiResult<PathBuf> {
        validate_artifact_segment("run id", run_id)?;
        validate_artifact_segment("artifact id", artifact_id)?;
        validate_artifact_extension(extension)?;
        self.prepare()?;

        let relative_dir = Path::new(RUNTIME_ARTIFACT_STAGING_DIR).join(run_id);
        let filename = format!("{artifact_id}.{extension}");

        let root_fd = self.open_managed_root_fd()?;
        let dir_fd = artifact_fs::open_or_create_dir_chain(root_fd.as_fd(), &relative_dir)?;
        // Clear any stale entry (no-follow); refuse a symlink squatting on the
        // staging filename so the externally-written path can never be a link.
        artifact_fs::clear_staging_destination(dir_fd.as_fd(), OsStr::new(&filename))?;
        Ok(self.root.join(&relative_dir).join(&filename))
    }

    pub fn cleanup_staging_run(&self, run_id: &str) -> UtsushiResult<()> {
        validate_artifact_segment("run id", run_id)?;
        let root_fd = self.open_managed_root_fd()?;

        let staging_fd = match artifact_fs::open_child_dir_optional(
            root_fd.as_fd(),
            RUNTIME_ARTIFACT_STAGING_DIR,
        ) {
            Ok(Some(fd)) => fd,
            Ok(None) => return Ok(()),
            Err(error) => return Err(error),
        };

        let run_name = std::ffi::CString::new(run_id.as_bytes())?;
        artifact_fs::remove_entry(staging_fd.as_fd(), &run_name)?;

        if !artifact_fs::dir_has_entries(staging_fd.as_fd())? {
            drop(staging_fd);
            let staging_name = std::ffi::CString::new(RUNTIME_ARTIFACT_STAGING_DIR.as_bytes())?;
            artifact_fs::remove_empty_dir_if_present(root_fd.as_fd(), &staging_name)?;
        }
        Ok(())
    }

    pub fn cleanup_contents(&self) -> UtsushiResult<()> {
        let root_fd = self.open_managed_root_fd()?;
        let marker = std::ffi::CString::new(RUNTIME_ARTIFACT_ROOT_MARKER.as_bytes())?;
        for name in artifact_fs::read_dir_names(root_fd.as_fd())? {
            if name == marker {
                continue;
            }
            artifact_fs::remove_entry(root_fd.as_fd(), &name)?;
        }
        Ok(())
    }

    /// Open the managed root as a directory descriptor, refusing obvious
    /// unmanaged roots and requiring the regular-file marker. The returned
    /// descriptor is the capability every mutating operation resolves against.
    fn open_managed_root_fd(&self) -> UtsushiResult<OwnedFd> {
        let root_fd = artifact_fs::open_root_dir(&self.root)
            .map_err(|error| artifact_fs::describe_root_open(&self.root, error))?;
        self.assert_not_obvious_unmanaged_root(root_fd.as_fd())?;
        match artifact_fs::entry_file_type(root_fd.as_fd(), RUNTIME_ARTIFACT_ROOT_MARKER) {
            Ok(file_type) if !file_type.is_symlink() && file_type.is_file() => Ok(root_fd),
            Ok(_) => Err(format!(
                "runtime artifact cleanup requires regular managed root marker {} under {}",
                RUNTIME_ARTIFACT_ROOT_MARKER,
                self.root.display()
            )
            .into()),
            Err(error) if error.kind() == io::ErrorKind::NotFound => Err(format!(
                "runtime artifact cleanup requires managed root marker {} under {}",
                RUNTIME_ARTIFACT_ROOT_MARKER,
                self.root.display()
            )
            .into()),
            Err(error) => Err(error.into()),
        }
    }

    fn assert_not_obvious_unmanaged_root(&self, root: BorrowedFd<'_>) -> UtsushiResult<()> {
        for sentinel in OBVIOUS_UNMANAGED_ROOT_SENTINELS {
            match artifact_fs::entry_file_type(root, *sentinel) {
                Ok(_) => {
                    return Err(format!(
                        "refusing to use obvious source or project root as runtime artifact root: {} contains {}",
                        self.root.display(),
                        sentinel
                    )
                    .into());
                }
                Err(error) if error.kind() == io::ErrorKind::NotFound => {}
                Err(error) => return Err(error.into()),
            }
        }
        Ok(())
    }
}

#[cfg(not(unix))]
impl RuntimeArtifactRoot {
    pub fn prepare(&self) -> UtsushiResult<()> {
        Err(RUNTIME_ARTIFACT_UNSUPPORTED_PLATFORM.into())
    }

    pub fn write_bytes(&self, _uri: &str, _contents: &[u8]) -> UtsushiResult<PathBuf> {
        // Keep the soft artifact-budget diagnostic platform-independent: an
        // over-budget write surfaces SinkError::BudgetExhausted here too.
        self.check_soft_byte_budget(_contents.len())?;
        Err(RUNTIME_ARTIFACT_UNSUPPORTED_PLATFORM.into())
    }

    pub fn prepare_staging_file(
        &self,
        _run_id: &str,
        _artifact_id: &str,
        _extension: &str,
    ) -> UtsushiResult<PathBuf> {
        Err(RUNTIME_ARTIFACT_UNSUPPORTED_PLATFORM.into())
    }

    pub fn cleanup_staging_run(&self, _run_id: &str) -> UtsushiResult<()> {
        Err(RUNTIME_ARTIFACT_UNSUPPORTED_PLATFORM.into())
    }

    pub fn cleanup_contents(&self) -> UtsushiResult<()> {
        Err(RUNTIME_ARTIFACT_UNSUPPORTED_PLATFORM.into())
    }
}

#[cfg(not(unix))]
const RUNTIME_ARTIFACT_UNSUPPORTED_PLATFORM: &str =
    "runtime artifact filesystem operations require fd-relative no-follow syscalls (unix)";

pub fn runtime_artifact_uri(
    run_id: &str,
    kind: RuntimeArtifactKind,
    artifact_id: &str,
) -> UtsushiResult<String> {
    Ok(RuntimeArtifactName::new(run_id, kind, artifact_id)?.uri())
}

pub fn validate_runtime_artifact_uri(uri: &str) -> UtsushiResult<PathBuf> {
    if uri.starts_with('/')
        || uri.contains('\\')
        || uri.starts_with("data:")
        || uri.starts_with("blob:")
        || uri.starts_with("file:")
        || has_uri_scheme(uri)
    {
        return Err(format!("runtime artifact uri must be managed and portable: {uri}").into());
    }

    let Some(relative) = uri.strip_prefix(&format!("{RUNTIME_ARTIFACT_URI_ROOT}/")) else {
        return Err(format!(
            "runtime artifact uri must live under {RUNTIME_ARTIFACT_URI_ROOT}: {uri}"
        )
        .into());
    };
    if relative
        .split('/')
        .any(|segment| segment.is_empty() || segment == "." || segment == "..")
    {
        return Err(format!("runtime artifact uri must not contain traversal: {uri}").into());
    }
    let path = Path::new(relative);
    let mut clean = PathBuf::new();
    for component in path.components() {
        match component {
            Component::Normal(segment) => clean.push(segment),
            _ => {
                return Err(
                    format!("runtime artifact uri must not contain traversal: {uri}").into(),
                );
            }
        }
    }
    if clean.components().count() < 3 {
        return Err(
            format!("runtime artifact uri is missing run, kind, or filename: {uri}").into(),
        );
    }
    Ok(clean)
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RuntimeAdapterDescriptor {
    pub name: String,
    pub version: String,
    pub fidelity_tier: FidelityTier,
    pub evidence_tier_ceiling: EvidenceTier,
    pub capability_contract: RuntimeCapabilityContract,
    pub capabilities: Vec<RuntimeCapability>,
    pub approximation_tiers: Vec<ApproximationTier>,
    pub diagnostics: Vec<RuntimeAdapterDiagnostic>,
    pub limitations: Vec<String>,
}

impl RuntimeAdapterDescriptor {
    pub fn supports(&self, capability: RuntimeCapability) -> bool {
        self.capabilities.contains(&capability)
    }

    pub fn uses_approximation(&self, approximation_tier: ApproximationTier) -> bool {
        self.approximation_tiers.contains(&approximation_tier)
    }

    pub fn validate_contract(&self) -> UtsushiResult<()> {
        self.capability_contract.validate()?;
        if self.evidence_tier_ceiling > self.fidelity_tier.evidence_ceiling() {
            return Err(format!(
                "runtime adapter {} evidence ceiling {} exceeds fidelity tier {}",
                self.name,
                self.evidence_tier_ceiling.as_str(),
                self.fidelity_tier.as_str()
            )
            .into());
        }
        if self.evidence_tier_ceiling > self.capability_contract.evidence_tier_ceiling {
            return Err(format!(
                "runtime adapter {} evidence ceiling {} exceeds capability contract ceiling {}",
                self.name,
                self.evidence_tier_ceiling.as_str(),
                self.capability_contract.evidence_tier_ceiling.as_str()
            )
            .into());
        }
        if !self
            .capability_contract
            .supports_required_features(&self.capabilities)
        {
            return Err(format!(
                "runtime adapter {} descriptor capabilities exceed its runtime capability contract",
                self.name
            )
            .into());
        }
        Ok(())
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RuntimeAdapterDiagnostic {
    pub diagnostic_kind: String,
    pub status: String,
    pub severity: String,
    pub message: String,
    pub details: Vec<(String, Value)>,
}

impl RuntimeAdapterDiagnostic {
    pub fn new(
        diagnostic_kind: impl Into<String>,
        status: impl Into<String>,
        severity: impl Into<String>,
        message: impl Into<String>,
    ) -> Self {
        Self {
            diagnostic_kind: diagnostic_kind.into(),
            status: status.into(),
            severity: severity.into(),
            message: message.into(),
            details: Vec::new(),
        }
    }

    pub fn with_detail(mut self, key: impl Into<String>, value: impl Into<String>) -> Self {
        self.details.push((key.into(), Value::String(value.into())));
        self
    }

    pub fn with_detail_value(mut self, key: impl Into<String>, value: Value) -> Self {
        self.details.push((key.into(), value));
        self
    }

    pub fn to_json(&self) -> Value {
        let mut value = serde_json::Map::new();
        value.insert(
            "diagnosticKind".to_string(),
            self.diagnostic_kind.clone().into(),
        );
        value.insert("status".to_string(), self.status.clone().into());
        value.insert("severity".to_string(), self.severity.clone().into());
        value.insert("message".to_string(), self.message.clone().into());
        if !self.details.is_empty() {
            value.insert(
                "details".to_string(),
                Value::Object(
                    self.details
                        .iter()
                        .map(|(key, value)| (key.clone(), value.clone()))
                        .collect::<serde_json::Map<_, _>>(),
                ),
            );
        }
        Value::Object(value)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum RuntimeOperation {
    Trace,
    BranchDiscovery,
    Capture,
    SmokeValidation,
}

impl RuntimeOperation {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Trace => "trace",
            Self::BranchDiscovery => "branch_discovery",
            Self::Capture => "capture",
            Self::SmokeValidation => "smoke_validation",
        }
    }

    pub fn required_capability(self) -> RuntimeCapability {
        match self {
            Self::Trace => RuntimeCapability::Trace,
            Self::BranchDiscovery => RuntimeCapability::BranchDiscovery,
            Self::Capture => RuntimeCapability::FrameCapture,
            Self::SmokeValidation => RuntimeCapability::SmokeValidation,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum RuntimeCapability {
    Trace,
    BranchDiscovery,
    FrameCapture,
    SmokeValidation,
    ReplayReview,
    ReferenceComparison,
}

impl RuntimeCapability {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Trace => "trace",
            Self::BranchDiscovery => "branch_discovery",
            Self::FrameCapture => "frame_capture",
            Self::SmokeValidation => "smoke_validation",
            Self::ReplayReview => "replay_review",
            Self::ReferenceComparison => "reference_comparison",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum EvidenceTier {
    E0,
    E1,
    E2,
    E3,
    E4,
}

impl EvidenceTier {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::E0 => "E0",
            Self::E1 => "E1",
            Self::E2 => "E2",
            Self::E3 => "E3",
            Self::E4 => "E4",
        }
    }
}

impl FromStr for EvidenceTier {
    type Err = String;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        match value {
            "E0" => Ok(Self::E0),
            "E1" => Ok(Self::E1),
            "E2" => Ok(Self::E2),
            "E3" => Ok(Self::E3),
            "E4" => Ok(Self::E4),
            _ => Err(format!("unknown evidence tier: {value}")),
        }
    }
}

impl Serialize for EvidenceTier {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        serializer.serialize_str(self.as_str())
    }
}

impl<'de> Deserialize<'de> for EvidenceTier {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let value = String::deserialize(deserializer)?;
        Self::from_str(&value).map_err(serde::de::Error::custom)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum FidelityTier {
    TraceOnly,
    LayoutProbe,
    ReplayReview,
    ReferenceFidelity,
}

impl FidelityTier {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::TraceOnly => "trace_only",
            Self::LayoutProbe => "layout_probe",
            Self::ReplayReview => "replay_review",
            Self::ReferenceFidelity => "reference_fidelity",
        }
    }

    pub fn evidence_ceiling(self) -> EvidenceTier {
        match self {
            Self::TraceOnly => EvidenceTier::E1,
            Self::LayoutProbe => EvidenceTier::E2,
            Self::ReplayReview => EvidenceTier::E3,
            Self::ReferenceFidelity => EvidenceTier::E4,
        }
    }

    pub fn rank(self) -> u8 {
        match self {
            Self::TraceOnly => 1,
            Self::LayoutProbe => 2,
            Self::ReplayReview => 3,
            Self::ReferenceFidelity => 4,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum ApproximationTier {
    None,
    DeterministicFixture,
    LayoutProbe,
    EnginePartial,
    ReferenceMatched,
}

impl ApproximationTier {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::None => "none",
            Self::DeterministicFixture => "deterministic_fixture",
            Self::LayoutProbe => "layout_probe",
            Self::EnginePartial => "engine_partial",
            Self::ReferenceMatched => "reference_matched",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum RuntimeCapabilityClass {
    StaticTrace,
    LaunchCapture,
    InstrumentedRuntime,
    PartialVm,
    ReferenceVm,
}

impl RuntimeCapabilityClass {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::StaticTrace => "static_trace",
            Self::LaunchCapture => "launch_capture",
            Self::InstrumentedRuntime => "instrumented_runtime",
            Self::PartialVm => "partial_vm",
            Self::ReferenceVm => "reference_vm",
        }
    }

    pub fn fidelity_tier_ceiling(self) -> FidelityTier {
        match self {
            Self::StaticTrace => FidelityTier::TraceOnly,
            Self::LaunchCapture => FidelityTier::LayoutProbe,
            Self::InstrumentedRuntime | Self::PartialVm => FidelityTier::ReplayReview,
            Self::ReferenceVm => FidelityTier::ReferenceFidelity,
        }
    }

    pub fn evidence_tier_ceiling(self) -> EvidenceTier {
        self.fidelity_tier_ceiling().evidence_ceiling()
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum RuntimePlaybackFeature {
    StaticTrace,
    Launch,
    TextTrace,
    BranchDiscovery,
    FrameCapture,
    Jump,
    Snapshot,
    Screenshot,
    Recording,
    InstrumentationHooks,
    VmStateInspection,
    ReferenceComparison,
}

impl RuntimePlaybackFeature {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::StaticTrace => "static_trace",
            Self::Launch => "launch",
            Self::TextTrace => "text_trace",
            Self::BranchDiscovery => "branch_discovery",
            Self::FrameCapture => "frame_capture",
            Self::Jump => "jump",
            Self::Snapshot => "snapshot",
            Self::Screenshot => "screenshot",
            Self::Recording => "recording",
            Self::InstrumentationHooks => "instrumentation_hooks",
            Self::VmStateInspection => "vm_state_inspection",
            Self::ReferenceComparison => "reference_comparison",
        }
    }

    fn covers_runtime_capability(self, capability: RuntimeCapability) -> bool {
        matches!(
            (self, capability),
            (
                Self::StaticTrace | Self::Launch | Self::TextTrace,
                RuntimeCapability::Trace
            ) | (Self::BranchDiscovery, RuntimeCapability::BranchDiscovery)
                | (
                    Self::FrameCapture | Self::Screenshot,
                    RuntimeCapability::FrameCapture
                )
                | (
                    Self::TextTrace | Self::FrameCapture | Self::Screenshot,
                    RuntimeCapability::SmokeValidation
                )
                | (Self::Recording, RuntimeCapability::ReplayReview)
                | (
                    Self::ReferenceComparison,
                    RuntimeCapability::ReferenceComparison
                )
        )
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum RuntimeFeatureStatus {
    Supported,
    Partial,
    Unsupported,
}

impl RuntimeFeatureStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Supported => "supported",
            Self::Partial => "partial",
            Self::Unsupported => "unsupported",
        }
    }

    fn is_available(self) -> bool {
        matches!(self, Self::Supported | Self::Partial)
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RuntimeFeatureSupport {
    pub feature: RuntimePlaybackFeature,
    pub status: RuntimeFeatureStatus,
    pub evidence_tier_ceiling: Option<EvidenceTier>,
    pub description: String,
    pub limitations: Vec<String>,
}

impl RuntimeFeatureSupport {
    pub fn supported(
        feature: RuntimePlaybackFeature,
        evidence_tier_ceiling: EvidenceTier,
        description: impl Into<String>,
    ) -> Self {
        Self {
            feature,
            status: RuntimeFeatureStatus::Supported,
            evidence_tier_ceiling: Some(evidence_tier_ceiling),
            description: description.into(),
            limitations: Vec::new(),
        }
    }

    pub fn partial(
        feature: RuntimePlaybackFeature,
        evidence_tier_ceiling: EvidenceTier,
        description: impl Into<String>,
        limitations: Vec<String>,
    ) -> Self {
        Self {
            feature,
            status: RuntimeFeatureStatus::Partial,
            evidence_tier_ceiling: Some(evidence_tier_ceiling),
            description: description.into(),
            limitations,
        }
    }

    pub fn unsupported(feature: RuntimePlaybackFeature, description: impl Into<String>) -> Self {
        Self {
            feature,
            status: RuntimeFeatureStatus::Unsupported,
            evidence_tier_ceiling: None,
            description: description.into(),
            limitations: Vec::new(),
        }
    }

    pub fn to_json(&self) -> Value {
        let mut value = serde_json::Map::new();
        value.insert("feature".to_string(), self.feature.as_str().into());
        value.insert("status".to_string(), self.status.as_str().into());
        if let Some(evidence_tier_ceiling) = self.evidence_tier_ceiling {
            value.insert(
                "evidenceTierCeiling".to_string(),
                evidence_tier_ceiling.as_str().into(),
            );
        }
        value.insert("description".to_string(), self.description.clone().into());
        value.insert(
            "limitations".to_string(),
            self.limitations
                .iter()
                .map(|limitation| Value::String(limitation.clone()))
                .collect::<Vec<_>>()
                .into(),
        );
        Value::Object(value)
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RuntimeCapabilityContract {
    pub contract_version: String,
    pub capability_class: RuntimeCapabilityClass,
    pub fidelity_tier_ceiling: FidelityTier,
    pub evidence_tier_ceiling: EvidenceTier,
    pub features: Vec<RuntimeFeatureSupport>,
    pub limitations: Vec<String>,
}

impl RuntimeCapabilityContract {
    pub fn new(
        capability_class: RuntimeCapabilityClass,
        fidelity_tier_ceiling: FidelityTier,
        evidence_tier_ceiling: EvidenceTier,
        features: Vec<RuntimeFeatureSupport>,
        limitations: Vec<String>,
    ) -> Self {
        Self {
            contract_version: "0.2.0".to_string(),
            capability_class,
            fidelity_tier_ceiling,
            evidence_tier_ceiling,
            features,
            limitations,
        }
    }

    pub fn validate(&self) -> UtsushiResult<()> {
        if self.fidelity_tier_ceiling.rank() > self.capability_class.fidelity_tier_ceiling().rank()
        {
            return Err(format!(
                "runtime capability class {} cannot claim fidelity ceiling {}",
                self.capability_class.as_str(),
                self.fidelity_tier_ceiling.as_str()
            )
            .into());
        }
        if self.evidence_tier_ceiling > self.fidelity_tier_ceiling.evidence_ceiling() {
            return Err(format!(
                "runtime capability contract evidence ceiling {} exceeds fidelity ceiling {}",
                self.evidence_tier_ceiling.as_str(),
                self.fidelity_tier_ceiling.as_str()
            )
            .into());
        }
        if self.evidence_tier_ceiling > self.capability_class.evidence_tier_ceiling() {
            return Err(format!(
                "runtime capability class {} cannot claim evidence ceiling {}",
                self.capability_class.as_str(),
                self.evidence_tier_ceiling.as_str()
            )
            .into());
        }
        for feature in &self.features {
            match (feature.status, feature.evidence_tier_ceiling) {
                (RuntimeFeatureStatus::Supported | RuntimeFeatureStatus::Partial, None) => {
                    return Err(format!(
                        "runtime feature {} must declare an evidence ceiling",
                        feature.feature.as_str()
                    )
                    .into());
                }
                (RuntimeFeatureStatus::Unsupported, Some(_)) => {
                    return Err(format!(
                        "unsupported runtime feature {} must not declare an evidence ceiling",
                        feature.feature.as_str()
                    )
                    .into());
                }
                (_, Some(feature_ceiling)) if feature_ceiling > self.evidence_tier_ceiling => {
                    return Err(format!(
                        "runtime feature {} evidence ceiling {} exceeds contract ceiling {}",
                        feature.feature.as_str(),
                        feature_ceiling.as_str(),
                        self.evidence_tier_ceiling.as_str()
                    )
                    .into());
                }
                _ => {}
            }
        }
        Ok(())
    }

    pub fn supports_required_features(&self, capabilities: &[RuntimeCapability]) -> bool {
        capabilities.iter().all(|capability| {
            self.features.iter().any(|feature| {
                feature.status.is_available()
                    && feature.feature.covers_runtime_capability(*capability)
            })
        })
    }

    pub fn to_json(&self) -> Value {
        serde_json::json!({
            "contractVersion": self.contract_version,
            "capabilityClass": self.capability_class.as_str(),
            "fidelityTierCeiling": self.fidelity_tier_ceiling.as_str(),
            "evidenceTierCeiling": self.evidence_tier_ceiling.as_str(),
            "features": self.features.iter().map(RuntimeFeatureSupport::to_json).collect::<Vec<_>>(),
            "limitations": self.limitations
        })
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ControlledPlaybackSession {
    pub session_id: String,
    pub adapter_name: String,
    pub adapter_version: String,
    pub capability_class: RuntimeCapabilityClass,
    pub requested_operation: RuntimeOperation,
    pub status: String,
    pub fidelity_tier: FidelityTier,
    pub evidence_tier: EvidenceTier,
    pub features_used: Vec<RuntimePlaybackFeature>,
    pub limitations: Vec<String>,
}

impl ControlledPlaybackSession {
    pub fn to_json(&self) -> Value {
        serde_json::json!({
            "sessionId": self.session_id,
            "adapterName": self.adapter_name,
            "adapterVersion": self.adapter_version,
            "capabilityClass": self.capability_class.as_str(),
            "requestedOperation": self.requested_operation.as_str(),
            "status": self.status,
            "fidelityTier": self.fidelity_tier.as_str(),
            "evidenceTier": self.evidence_tier.as_str(),
            "featuresUsed": self
                .features_used
                .iter()
                .map(|feature| feature.as_str())
                .collect::<Vec<_>>(),
            "limitations": self.limitations
        })
    }
}

// UTSUSHI-224: `deleted-hook-envelopeKind` + `deleted-hook-envelope` deleted.
// Engine ports now push observation payloads through the
// `crate::sink::SinkSet` bridge. The wire-shape `observationHookEvents`
// array remains a `kaifuu-core` contract surface and is synthesized as raw
// JSON in the fixture engine ports (no `utsushi-core` Rust type backs it).

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ObservationAdapterId {
    pub name: String,
    pub version: String,
}

impl ObservationAdapterId {
    pub fn validate(&self) -> UtsushiResult<()> {
        validate_required_metadata("adapterId.name", &self.name)?;
        validate_required_metadata("adapterId.version", &self.version)?;
        Ok(())
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ObservationEnvironment {
    pub runtime: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub engine: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub platform: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub display: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub locale: Option<String>,
}

impl ObservationEnvironment {
    pub fn validate(&self) -> UtsushiResult<()> {
        validate_required_metadata("environment.runtime", &self.runtime)?;
        Ok(())
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ObservationSourceRevision {
    pub source_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub revision_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub content_hash: Option<String>,
}

impl ObservationSourceRevision {
    pub fn validate(&self) -> UtsushiResult<()> {
        validate_required_metadata("sourceRevision.sourceId", &self.source_id)?;
        Ok(())
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ObservationBridgeRef {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bridge_unit_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_unit_key: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub runtime_object_id: Option<String>,
}

impl ObservationBridgeRef {
    pub fn validate(&self) -> UtsushiResult<()> {
        if is_absent_or_blank(self.bridge_unit_id.as_deref())
            && is_absent_or_blank(self.source_unit_key.as_deref())
            && is_absent_or_blank(self.runtime_object_id.as_deref())
        {
            return Err("observation bridge ref must identify a bridge unit, source unit, or runtime object".into());
        }
        Ok(())
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum ObservationRedactionStatus {
    NotRequired,
    Redacted,
}

impl ObservationRedactionStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::NotRequired => "not_required",
            Self::Redacted => "redacted",
        }
    }
}

impl FromStr for ObservationRedactionStatus {
    type Err = String;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        match value {
            "not_required" => Ok(Self::NotRequired),
            "redacted" => Ok(Self::Redacted),
            _ => Err(format!("unknown observation redaction status: {value}")),
        }
    }
}

impl Serialize for ObservationRedactionStatus {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        serializer.serialize_str(self.as_str())
    }
}

impl<'de> Deserialize<'de> for ObservationRedactionStatus {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let value = String::deserialize(deserializer)?;
        Self::from_str(&value).map_err(serde::de::Error::custom)
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ObservationRedactionMetadata {
    pub status: ObservationRedactionStatus,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub rules: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub redacted_fields: Vec<String>,
}

impl ObservationRedactionMetadata {
    pub fn not_required() -> Self {
        Self {
            status: ObservationRedactionStatus::NotRequired,
            rules: Vec::new(),
            redacted_fields: Vec::new(),
        }
    }

    pub fn redacted(rules: Vec<String>, redacted_fields: Vec<String>) -> Self {
        Self {
            status: ObservationRedactionStatus::Redacted,
            rules,
            redacted_fields,
        }
    }

    pub fn validate(&self) -> UtsushiResult<()> {
        match self.status {
            ObservationRedactionStatus::NotRequired => {
                if !self.rules.is_empty() || !self.redacted_fields.is_empty() {
                    return Err("observation redaction metadata with status not_required must not declare redaction rules or fields".into());
                }
            }
            ObservationRedactionStatus::Redacted => {
                if self.rules.is_empty() || self.redacted_fields.is_empty() {
                    return Err("redacted observation hook events must declare redaction rules and redacted fields".into());
                }
                for rule in &self.rules {
                    validate_required_metadata("redaction.rules[]", rule)?;
                }
                for field in &self.redacted_fields {
                    validate_required_metadata("redaction.redactedFields[]", field)?;
                }
            }
        }
        Ok(())
    }
}

// UTSUSHI-224: `deleted-hookPayload` + every payload variant
// (`ObservationTextPayload`, `ObservationChoicePayload`,
// `ObservationChoiceOption`, `ObservationBranchPayload`,
// `ObservationScenePayload`, `ObservationFramePayload`,
// `ObservationErrorPayload`) deleted. The substrate observation surface is
// now the sink-set bridge (`crate::sink::TextLine` / `FrameArtifact` /
// `AudioEvent`); choice / branch / scene / error payloads have no
// production consumer in the Sweetie HD ground-truth scope and are
// re-introduced only when an engine port pushes them through a typed
// sink contract.

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ObservationArtifactRef {
    pub artifact_id: String,
    pub artifact_kind: String,
    pub uri: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub media_type: Option<String>,
}

impl ObservationArtifactRef {
    pub fn validate(&self) -> UtsushiResult<()> {
        validate_required_metadata("payload.artifactRef.artifactId", &self.artifact_id)?;
        validate_required_metadata("payload.artifactRef.artifactKind", &self.artifact_kind)?;
        validate_runtime_artifact_uri(&self.uri)?;
        Ok(())
    }
}

pub fn validate_runtime_evidence_report_value(report: &Value) -> UtsushiResult<()> {
    let report = value_object(report, "RuntimeEvidenceReportV02")?;
    require_literal(
        report,
        "schemaVersion",
        "0.2.0",
        "RuntimeEvidenceReportV02.schemaVersion",
    )?;
    require_uuid7_field(
        report,
        "runtimeReportId",
        "RuntimeEvidenceReportV02.runtimeReportId",
    )?;
    optional_uuid7_field(
        report,
        "sourceBridgeId",
        "RuntimeEvidenceReportV02.sourceBridgeId",
    )?;
    optional_non_blank_field(
        report,
        "sourceBundleHash",
        "RuntimeEvidenceReportV02.sourceBundleHash",
    )?;
    optional_non_blank_field(
        report,
        "sourceLocale",
        "RuntimeEvidenceReportV02.sourceLocale",
    )?;
    optional_non_blank_field(
        report,
        "targetLocale",
        "RuntimeEvidenceReportV02.targetLocale",
    )?;
    let adapter_name = require_non_blank_field(
        report,
        "adapterName",
        "RuntimeEvidenceReportV02.adapterName",
    )?;
    let adapter_version = require_non_blank_field(
        report,
        "adapterVersion",
        "RuntimeEvidenceReportV02.adapterVersion",
    )?;
    let fidelity_tier = parse_fidelity_tier_field(
        report,
        "fidelityTier",
        "RuntimeEvidenceReportV02.fidelityTier",
    )?;
    let evidence_tier = parse_evidence_tier_field(
        report,
        "evidenceTier",
        "RuntimeEvidenceReportV02.evidenceTier",
    )?;
    if evidence_tier > fidelity_tier.evidence_ceiling() {
        return Err(format!(
            "RuntimeEvidenceReportV02.evidenceTier must not exceed {} for the declared fidelityTier",
            fidelity_tier.evidence_ceiling().as_str()
        )
        .into());
    }
    let status = require_one_of_field(
        report,
        "status",
        &["passed", "failed"],
        "RuntimeEvidenceReportV02.status",
    )?;
    let created_at =
        require_non_blank_field(report, "createdAt", "RuntimeEvidenceReportV02.createdAt")?;
    validate_rfc3339_instant_metadata("RuntimeEvidenceReportV02.createdAt", created_at)?;

    let trace_events = required_value_array(
        report,
        "traceEvents",
        "RuntimeEvidenceReportV02.traceEvents",
    )?;
    for (index, event) in trace_events.iter().enumerate() {
        validate_runtime_trace_event_value(
            event,
            &format!("RuntimeEvidenceReportV02.traceEvents[{index}]"),
        )?;
    }
    let branch_events = required_value_array(
        report,
        "branchEvents",
        "RuntimeEvidenceReportV02.branchEvents",
    )?;
    for (index, event) in branch_events.iter().enumerate() {
        validate_runtime_branch_event_value(
            event,
            &format!("RuntimeEvidenceReportV02.branchEvents[{index}]"),
        )?;
    }
    // UTSUSHI-224: the per-event observation envelope validation that
    // previously round-tripped each entry through `deleted-hook-envelope`
    // is replaced by a structural shape check. The full wire-shape
    // contract lives in `kaifuu-core::contracts::validate_runtime_evidence_report_v02`
    // (which validates every field of `observationHookEvents[]` against
    // the runtime evidence contract); the `utsushi-core` validator only
    // enforces (a) the array is well-shaped, (b) each entry carries an
    // `evidenceTier` that does not exceed the report's declared
    // evidence tier.
    let observation_events = optional_value_array(
        report,
        "observationHookEvents",
        "RuntimeEvidenceReportV02.observationHookEvents",
    )?;
    for (index, event) in observation_events.iter().enumerate() {
        let event_object = event
            .as_object()
            .ok_or_else(|| -> Box<dyn std::error::Error> {
                format!("RuntimeEvidenceReportV02.observationHookEvents[{index}] must be an object")
                    .into()
            })?;
        let event_tier_str = event_object
            .get("evidenceTier")
            .and_then(Value::as_str)
            .ok_or_else(|| -> Box<dyn std::error::Error> {
                format!(
                    "RuntimeEvidenceReportV02.observationHookEvents[{index}].evidenceTier must be present"
                )
                .into()
            })?;
        let event_tier = EvidenceTier::from_str(event_tier_str).map_err(|_| -> Box<dyn std::error::Error> {
            format!(
                "RuntimeEvidenceReportV02.observationHookEvents[{index}].evidenceTier {event_tier_str} is not a recognised tier"
            )
            .into()
        })?;
        if event_tier > evidence_tier {
            return Err(format!(
                "RuntimeEvidenceReportV02.observationHookEvents[{index}].evidenceTier must not exceed report evidenceTier {}",
                evidence_tier.as_str()
            )
            .into());
        }
    }
    let captures = required_value_array(report, "captures", "RuntimeEvidenceReportV02.captures")?;
    for (index, capture) in captures.iter().enumerate() {
        validate_runtime_capture_value(
            capture,
            &format!("RuntimeEvidenceReportV02.captures[{index}]"),
        )?;
    }
    let recordings =
        required_value_array(report, "recordings", "RuntimeEvidenceReportV02.recordings")?;
    for (index, recording) in recordings.iter().enumerate() {
        validate_runtime_recording_value(
            recording,
            &format!("RuntimeEvidenceReportV02.recordings[{index}]"),
        )?;
    }
    let approximations = required_value_array(
        report,
        "approximations",
        "RuntimeEvidenceReportV02.approximations",
    )?;
    for (index, approximation) in approximations.iter().enumerate() {
        validate_runtime_approximation_value(
            approximation,
            &format!("RuntimeEvidenceReportV02.approximations[{index}]"),
        )?;
    }
    let findings = required_value_array(
        report,
        "validationFindings",
        "RuntimeEvidenceReportV02.validationFindings",
    )?;
    for (index, finding) in findings.iter().enumerate() {
        validate_runtime_validation_finding_value(
            finding,
            &format!("RuntimeEvidenceReportV02.validationFindings[{index}]"),
        )?;
    }
    let reference_comparisons = optional_value_array(
        report,
        "referenceComparisons",
        "RuntimeEvidenceReportV02.referenceComparisons",
    )?;
    validate_string_array_field(
        report,
        "limitations",
        "RuntimeEvidenceReportV02.limitations",
    )?;

    if let Some(runtime_capabilities) = report.get("runtimeCapabilities") {
        validate_runtime_capability_contract_value(
            runtime_capabilities,
            "RuntimeEvidenceReportV02.runtimeCapabilities",
            fidelity_tier,
            evidence_tier,
        )?;
    }
    if let Some(session) = report.get("controlledPlaybackSession") {
        validate_controlled_playback_session_value(
            session,
            adapter_name,
            adapter_version,
            fidelity_tier,
            evidence_tier,
            status,
            report.get("runtimeCapabilities"),
        )?;
        let operation = value_object(
            session,
            "RuntimeEvidenceReportV02.controlledPlaybackSession",
        )
        .and_then(|session| {
            require_one_of_field(
                session,
                "requestedOperation",
                &["trace", "branch_discovery", "capture", "smoke_validation"],
                "RuntimeEvidenceReportV02.controlledPlaybackSession.requestedOperation",
            )
        })?;
        validate_controlled_playback_surface(
            operation,
            !branch_events.is_empty(),
            !captures.is_empty(),
            !recordings.is_empty(),
            !reference_comparisons.is_empty(),
        )?;
    }

    if trace_events.is_empty()
        && branch_events.is_empty()
        && observation_events.is_empty()
        && captures.is_empty()
        && recordings.is_empty()
    {
        return Err("RuntimeEvidenceReportV02 must contain trace, observation hook, capture, branch, or recording evidence".into());
    }
    if !captures.is_empty() && evidence_tier < EvidenceTier::E2 {
        return Err(
            "RuntimeEvidenceReportV02.evidenceTier must be at least E2 when captures are present"
                .into(),
        );
    }
    if !recordings.is_empty() && evidence_tier < EvidenceTier::E3 {
        return Err(
            "RuntimeEvidenceReportV02.evidenceTier must be at least E3 when recordings are present"
                .into(),
        );
    }
    if fidelity_tier != FidelityTier::ReferenceFidelity && approximations.is_empty() {
        return Err(
            "RuntimeEvidenceReportV02.approximations must document non-reference runtime limits"
                .into(),
        );
    }
    if (fidelity_tier == FidelityTier::ReferenceFidelity || evidence_tier == EvidenceTier::E4)
        && reference_comparisons.is_empty()
    {
        return Err("RuntimeEvidenceReportV02.referenceComparisons must include reference-runtime or conformance comparison evidence for E4/reference_fidelity claims".into());
    }
    if status == "failed" && findings.is_empty() {
        return Err(
            "RuntimeEvidenceReportV02.validationFindings must explain failed runtime evidence"
                .into(),
        );
    }
    Ok(())
}

fn value_object<'a>(value: &'a Value, label: &str) -> UtsushiResult<&'a Map<String, Value>> {
    value
        .as_object()
        .ok_or_else(|| format!("{label} must be an object").into())
}

fn require_literal<'a>(
    object: &'a Map<String, Value>,
    field: &str,
    expected: &str,
    label: &str,
) -> UtsushiResult<&'a str> {
    let value = require_non_blank_field(object, field, label)?;
    if value != expected {
        return Err(format!("{label} must be {expected}").into());
    }
    Ok(value)
}

fn require_non_blank_field<'a>(
    object: &'a Map<String, Value>,
    field: &str,
    label: &str,
) -> UtsushiResult<&'a str> {
    object
        .get(field)
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| format!("{label} must be a non-empty string").into())
}

fn optional_non_blank_field<'a>(
    object: &'a Map<String, Value>,
    field: &str,
    label: &str,
) -> UtsushiResult<Option<&'a str>> {
    object
        .get(field)
        .map(|_| require_non_blank_field(object, field, label))
        .transpose()
}

fn require_uuid7_field<'a>(
    object: &'a Map<String, Value>,
    field: &str,
    label: &str,
) -> UtsushiResult<&'a str> {
    let value = require_non_blank_field(object, field, label)?;
    validate_uuid7(value, label)?;
    Ok(value)
}

fn optional_uuid7_field<'a>(
    object: &'a Map<String, Value>,
    field: &str,
    label: &str,
) -> UtsushiResult<Option<&'a str>> {
    object
        .get(field)
        .map(|_| require_uuid7_field(object, field, label))
        .transpose()
}

fn validate_uuid7(value: &str, label: &str) -> UtsushiResult<()> {
    let bytes = value.as_bytes();
    let valid = bytes.len() == 36
        && bytes[8] == b'-'
        && bytes[13] == b'-'
        && bytes[18] == b'-'
        && bytes[23] == b'-'
        && bytes[14] == b'7'
        && matches!(bytes[19], b'8' | b'9' | b'a' | b'b' | b'A' | b'B')
        && bytes
            .iter()
            .enumerate()
            .all(|(index, byte)| matches!(index, 8 | 13 | 18 | 23) || byte.is_ascii_hexdigit());
    if valid {
        Ok(())
    } else {
        Err(format!("{label} must be a UUID7 string").into())
    }
}

fn require_one_of_field<'a>(
    object: &'a Map<String, Value>,
    field: &str,
    allowed: &[&str],
    label: &str,
) -> UtsushiResult<&'a str> {
    let value = require_non_blank_field(object, field, label)?;
    if !allowed.contains(&value) {
        return Err(format!("{label} has unsupported value: {value}").into());
    }
    Ok(value)
}

fn parse_fidelity_tier_field(
    object: &Map<String, Value>,
    field: &str,
    label: &str,
) -> UtsushiResult<FidelityTier> {
    match require_non_blank_field(object, field, label)? {
        "trace_only" => Ok(FidelityTier::TraceOnly),
        "layout_probe" => Ok(FidelityTier::LayoutProbe),
        "replay_review" => Ok(FidelityTier::ReplayReview),
        "reference_fidelity" => Ok(FidelityTier::ReferenceFidelity),
        value => Err(format!("{label} has unsupported value: {value}").into()),
    }
}

fn parse_evidence_tier_field(
    object: &Map<String, Value>,
    field: &str,
    label: &str,
) -> UtsushiResult<EvidenceTier> {
    EvidenceTier::from_str(require_non_blank_field(object, field, label)?)
        .map_err(|error| format!("{label} {error}").into())
}

fn required_value_array<'a>(
    object: &'a Map<String, Value>,
    field: &str,
    label: &str,
) -> UtsushiResult<&'a Vec<Value>> {
    object
        .get(field)
        .and_then(Value::as_array)
        .ok_or_else(|| format!("{label} must be an array").into())
}

fn optional_value_array<'a>(
    object: &'a Map<String, Value>,
    field: &str,
    label: &str,
) -> UtsushiResult<&'a [Value]> {
    match object.get(field) {
        Some(value) => value
            .as_array()
            .map(Vec::as_slice)
            .ok_or_else(|| format!("{label} must be an array").into()),
        None => Ok(&[]),
    }
}

fn validate_string_array_field(
    object: &Map<String, Value>,
    field: &str,
    label: &str,
) -> UtsushiResult<()> {
    let values = required_value_array(object, field, label)?;
    for (index, value) in values.iter().enumerate() {
        if value.as_str().is_none() {
            return Err(format!("{label}[{index}] must be a string").into());
        }
    }
    Ok(())
}

fn require_u64_field(object: &Map<String, Value>, field: &str, label: &str) -> UtsushiResult<u64> {
    object
        .get(field)
        .and_then(Value::as_u64)
        .ok_or_else(|| format!("{label} must be a non-negative integer").into())
}

fn require_positive_u64_field(
    object: &Map<String, Value>,
    field: &str,
    label: &str,
) -> UtsushiResult<u64> {
    let value = require_u64_field(object, field, label)?;
    if value == 0 {
        return Err(format!("{label} must be positive").into());
    }
    Ok(value)
}

fn validate_runtime_trace_event_value(value: &Value, label: &str) -> UtsushiResult<()> {
    let event = value_object(value, label)?;
    require_uuid7_field(event, "traceEventId", &format!("{label}.traceEventId"))?;
    require_non_blank_field(event, "eventKind", &format!("{label}.eventKind"))?;
    validate_runtime_bridge_unit_ref_value(
        event
            .get("bridgeUnitRef")
            .ok_or_else(|| format!("{label}.bridgeUnitRef is required"))?,
        &format!("{label}.bridgeUnitRef"),
    )?;
    require_u64_field(event, "frame", &format!("{label}.frame"))?;
    Ok(())
}

fn validate_runtime_branch_event_value(value: &Value, label: &str) -> UtsushiResult<()> {
    let event = value_object(value, label)?;
    require_uuid7_field(event, "branchEventId", &format!("{label}.branchEventId"))?;
    require_non_blank_field(event, "branchKind", &format!("{label}.branchKind"))?;
    validate_runtime_bridge_unit_ref_value(
        event
            .get("bridgeUnitRef")
            .ok_or_else(|| format!("{label}.bridgeUnitRef is required"))?,
        &format!("{label}.bridgeUnitRef"),
    )?;
    Ok(())
}

fn validate_runtime_capture_value(value: &Value, label: &str) -> UtsushiResult<()> {
    let capture = value_object(value, label)?;
    require_uuid7_field(capture, "captureId", &format!("{label}.captureId"))?;
    validate_runtime_bridge_unit_ref_value(
        capture
            .get("bridgeUnitRef")
            .ok_or_else(|| format!("{label}.bridgeUnitRef is required"))?,
        &format!("{label}.bridgeUnitRef"),
    )?;
    parse_evidence_tier_field(capture, "evidenceTier", &format!("{label}.evidenceTier"))?;
    require_u64_field(capture, "frame", &format!("{label}.frame"))?;
    require_positive_u64_field(capture, "width", &format!("{label}.width"))?;
    require_positive_u64_field(capture, "height", &format!("{label}.height"))?;
    validate_runtime_artifact_ref_value(
        capture
            .get("artifactRef")
            .ok_or_else(|| format!("{label}.artifactRef is required"))?,
        &format!("{label}.artifactRef"),
        Some("screenshot"),
    )
}

fn validate_runtime_recording_value(value: &Value, label: &str) -> UtsushiResult<()> {
    let recording = value_object(value, label)?;
    require_uuid7_field(recording, "recordingId", &format!("{label}.recordingId"))?;
    require_u64_field(
        recording,
        "startedAtFrame",
        &format!("{label}.startedAtFrame"),
    )?;
    require_positive_u64_field(recording, "frameCount", &format!("{label}.frameCount"))?;
    require_positive_u64_field(recording, "width", &format!("{label}.width"))?;
    require_positive_u64_field(recording, "height", &format!("{label}.height"))?;
    require_non_blank_field(recording, "encoding", &format!("{label}.encoding"))?;
    validate_runtime_artifact_ref_value(
        recording
            .get("artifactRef")
            .ok_or_else(|| format!("{label}.artifactRef is required"))?,
        &format!("{label}.artifactRef"),
        Some("recording"),
    )
}

fn validate_runtime_approximation_value(value: &Value, label: &str) -> UtsushiResult<()> {
    let approximation = value_object(value, label)?;
    require_uuid7_field(
        approximation,
        "approximationId",
        &format!("{label}.approximationId"),
    )?;
    require_one_of_field(
        approximation,
        "approximationTier",
        &[
            "none",
            "deterministic_fixture",
            "layout_probe",
            "engine_partial",
            "reference_matched",
        ],
        &format!("{label}.approximationTier"),
    )?;
    require_non_blank_field(approximation, "scope", &format!("{label}.scope"))?;
    require_non_blank_field(
        approximation,
        "description",
        &format!("{label}.description"),
    )?;
    let refs = required_value_array(
        approximation,
        "affectedBridgeUnitRefs",
        &format!("{label}.affectedBridgeUnitRefs"),
    )?;
    if refs.is_empty() {
        return Err(format!("{label}.affectedBridgeUnitRefs must not be empty").into());
    }
    for (index, unit_ref) in refs.iter().enumerate() {
        validate_runtime_bridge_unit_ref_value(
            unit_ref,
            &format!("{label}.affectedBridgeUnitRefs[{index}]"),
        )?;
    }
    parse_evidence_tier_field(
        approximation,
        "evidenceTierCeiling",
        &format!("{label}.evidenceTierCeiling"),
    )?;
    Ok(())
}

fn validate_runtime_validation_finding_value(value: &Value, label: &str) -> UtsushiResult<()> {
    let finding = value_object(value, label)?;
    require_uuid7_field(finding, "findingId", &format!("{label}.findingId"))?;
    require_non_blank_field(finding, "findingKind", &format!("{label}.findingKind"))?;
    require_non_blank_field(finding, "severity", &format!("{label}.severity"))?;
    require_non_blank_field(finding, "message", &format!("{label}.message"))?;
    parse_evidence_tier_field(finding, "evidenceTier", &format!("{label}.evidenceTier"))?;
    Ok(())
}

fn validate_runtime_bridge_unit_ref_value(value: &Value, label: &str) -> UtsushiResult<()> {
    let unit_ref = value_object(value, label)?;
    require_non_blank_field(unit_ref, "bridgeUnitId", &format!("{label}.bridgeUnitId"))?;
    optional_non_blank_field(unit_ref, "sourceUnitKey", &format!("{label}.sourceUnitKey"))?;
    Ok(())
}

fn validate_runtime_artifact_ref_value(
    value: &Value,
    label: &str,
    expected_kind: Option<&str>,
) -> UtsushiResult<()> {
    let artifact_ref = value_object(value, label)?;
    require_uuid7_field(artifact_ref, "artifactId", &format!("{label}.artifactId"))?;
    let kind = require_non_blank_field(
        artifact_ref,
        "artifactKind",
        &format!("{label}.artifactKind"),
    )?;
    if let Some(expected_kind) = expected_kind
        && kind != expected_kind
    {
        return Err(format!("{label}.artifactKind must be {expected_kind}").into());
    }
    validate_runtime_artifact_uri(require_non_blank_field(
        artifact_ref,
        "uri",
        &format!("{label}.uri"),
    )?)?;
    optional_non_blank_field(artifact_ref, "mediaType", &format!("{label}.mediaType"))?;
    Ok(())
}

fn validate_runtime_capability_contract_value(
    value: &Value,
    label: &str,
    report_fidelity_tier: FidelityTier,
    report_evidence_tier: EvidenceTier,
) -> UtsushiResult<()> {
    let contract = value_object(value, label)?;
    require_literal(
        contract,
        "contractVersion",
        "0.2.0",
        &format!("{label}.contractVersion"),
    )?;
    require_one_of_field(
        contract,
        "capabilityClass",
        &[
            "static_trace",
            "launch_capture",
            "instrumented_runtime",
            "partial_vm",
            "reference_vm",
        ],
        &format!("{label}.capabilityClass"),
    )?;
    let fidelity_tier_ceiling = parse_fidelity_tier_field(
        contract,
        "fidelityTierCeiling",
        &format!("{label}.fidelityTierCeiling"),
    )?;
    let evidence_tier_ceiling = parse_evidence_tier_field(
        contract,
        "evidenceTierCeiling",
        &format!("{label}.evidenceTierCeiling"),
    )?;
    if report_fidelity_tier.rank() > fidelity_tier_ceiling.rank() {
        return Err(
            "RuntimeEvidenceReportV02.fidelityTier exceeds runtimeCapabilities.fidelityTierCeiling"
                .into(),
        );
    }
    if report_evidence_tier > evidence_tier_ceiling {
        return Err(
            "RuntimeEvidenceReportV02.evidenceTier exceeds runtimeCapabilities.evidenceTierCeiling"
                .into(),
        );
    }
    let features = required_value_array(contract, "features", &format!("{label}.features"))?;
    if features.is_empty() {
        return Err(format!("{label}.features must not be empty").into());
    }
    let mut seen = HashSet::new();
    for (index, feature) in features.iter().enumerate() {
        let feature_label = format!("{label}.features[{index}]");
        let feature = value_object(feature, &feature_label)?;
        let name = require_one_of_field(
            feature,
            "feature",
            &[
                "static_trace",
                "launch",
                "text_trace",
                "branch_discovery",
                "frame_capture",
                "jump",
                "snapshot",
                "screenshot",
                "recording",
                "instrumentation_hooks",
                "vm_state_inspection",
                "reference_comparison",
            ],
            &format!("{feature_label}.feature"),
        )?;
        if !seen.insert(name.to_string()) {
            return Err(format!("{feature_label}.feature must be unique").into());
        }
        let status = require_one_of_field(
            feature,
            "status",
            &["supported", "partial", "unsupported"],
            &format!("{feature_label}.status"),
        )?;
        let has_ceiling = feature.get("evidenceTierCeiling").is_some();
        if status == "unsupported" && has_ceiling {
            return Err(format!("{feature_label}.evidenceTierCeiling must be omitted for unsupported runtime features").into());
        }
        if status != "unsupported" && !has_ceiling {
            return Err(format!(
                "{feature_label}.evidenceTierCeiling is required for supported runtime features"
            )
            .into());
        }
        if has_ceiling {
            let feature_ceiling = parse_evidence_tier_field(
                feature,
                "evidenceTierCeiling",
                &format!("{feature_label}.evidenceTierCeiling"),
            )?;
            if feature_ceiling > evidence_tier_ceiling {
                return Err(format!(
                    "{feature_label}.evidenceTierCeiling exceeds contract ceiling"
                )
                .into());
            }
        }
        require_non_blank_field(
            feature,
            "description",
            &format!("{feature_label}.description"),
        )?;
        validate_string_array_field(
            feature,
            "limitations",
            &format!("{feature_label}.limitations"),
        )?;
    }
    validate_string_array_field(contract, "limitations", &format!("{label}.limitations"))?;
    Ok(())
}

fn validate_controlled_playback_session_value(
    value: &Value,
    adapter_name: &str,
    adapter_version: &str,
    report_fidelity_tier: FidelityTier,
    report_evidence_tier: EvidenceTier,
    report_status: &str,
    runtime_capabilities: Option<&Value>,
) -> UtsushiResult<()> {
    let session = value_object(value, "RuntimeEvidenceReportV02.controlledPlaybackSession")?;
    require_uuid7_field(
        session,
        "sessionId",
        "RuntimeEvidenceReportV02.controlledPlaybackSession.sessionId",
    )?;
    if require_non_blank_field(
        session,
        "adapterName",
        "RuntimeEvidenceReportV02.controlledPlaybackSession.adapterName",
    )? != adapter_name
    {
        return Err("RuntimeEvidenceReportV02.controlledPlaybackSession.adapterName must match RuntimeEvidenceReportV02.adapterName".into());
    }
    if require_non_blank_field(
        session,
        "adapterVersion",
        "RuntimeEvidenceReportV02.controlledPlaybackSession.adapterVersion",
    )? != adapter_version
    {
        return Err("RuntimeEvidenceReportV02.controlledPlaybackSession.adapterVersion must match RuntimeEvidenceReportV02.adapterVersion".into());
    }
    require_one_of_field(
        session,
        "capabilityClass",
        &[
            "static_trace",
            "launch_capture",
            "instrumented_runtime",
            "partial_vm",
            "reference_vm",
        ],
        "RuntimeEvidenceReportV02.controlledPlaybackSession.capabilityClass",
    )?;
    require_one_of_field(
        session,
        "requestedOperation",
        &["trace", "branch_discovery", "capture", "smoke_validation"],
        "RuntimeEvidenceReportV02.controlledPlaybackSession.requestedOperation",
    )?;
    if require_one_of_field(
        session,
        "status",
        &["passed", "failed"],
        "RuntimeEvidenceReportV02.controlledPlaybackSession.status",
    )? != report_status
    {
        return Err("RuntimeEvidenceReportV02.controlledPlaybackSession.status must match RuntimeEvidenceReportV02.status".into());
    }
    let fidelity_tier = parse_fidelity_tier_field(
        session,
        "fidelityTier",
        "RuntimeEvidenceReportV02.controlledPlaybackSession.fidelityTier",
    )?;
    let evidence_tier = parse_evidence_tier_field(
        session,
        "evidenceTier",
        "RuntimeEvidenceReportV02.controlledPlaybackSession.evidenceTier",
    )?;
    if fidelity_tier.rank() > report_fidelity_tier.rank() {
        return Err("RuntimeEvidenceReportV02.controlledPlaybackSession.fidelityTier must not exceed report fidelityTier".into());
    }
    if evidence_tier > report_evidence_tier {
        return Err("RuntimeEvidenceReportV02.controlledPlaybackSession.evidenceTier must not exceed report evidenceTier".into());
    }
    let features = required_value_array(
        session,
        "featuresUsed",
        "RuntimeEvidenceReportV02.controlledPlaybackSession.featuresUsed",
    )?;
    for (index, feature) in features.iter().enumerate() {
        let feature = feature.as_str().ok_or_else(|| {
            format!("RuntimeEvidenceReportV02.controlledPlaybackSession.featuresUsed[{index}] must be a string")
        })?;
        if !is_runtime_playback_feature(feature) {
            return Err(format!(
                "RuntimeEvidenceReportV02.controlledPlaybackSession.featuresUsed[{index}] has unsupported value: {feature}"
            )
            .into());
        }
        if let Some(runtime_capabilities) = runtime_capabilities {
            validate_runtime_capability_supports_feature_value(
                runtime_capabilities,
                feature,
                "RuntimeEvidenceReportV02.runtimeCapabilities",
            )?;
        }
    }
    validate_string_array_field(
        session,
        "limitations",
        "RuntimeEvidenceReportV02.controlledPlaybackSession.limitations",
    )?;
    Ok(())
}

fn validate_runtime_capability_supports_feature_value(
    value: &Value,
    feature_name: &str,
    label: &str,
) -> UtsushiResult<()> {
    let contract = value_object(value, label)?;
    let features = required_value_array(contract, "features", &format!("{label}.features"))?;
    for feature in features {
        let feature = value_object(feature, &format!("{label}.features[]"))?;
        if feature.get("feature").and_then(Value::as_str) == Some(feature_name) {
            let status = require_one_of_field(
                feature,
                "status",
                &["supported", "partial", "unsupported"],
                &format!("{label}.features[].status"),
            )?;
            if status == "supported" || status == "partial" {
                return Ok(());
            }
        }
    }
    Err(format!("{label} does not support {feature_name} capability").into())
}

fn validate_controlled_playback_surface(
    requested_operation: &str,
    has_branch_events: bool,
    has_captures: bool,
    has_recordings: bool,
    has_reference_comparisons: bool,
) -> UtsushiResult<()> {
    match requested_operation {
        "trace" => {
            reject_operation_evidence(requested_operation, has_branch_events, "branch event")?;
            reject_operation_evidence(requested_operation, has_captures, "capture")?;
            reject_operation_evidence(requested_operation, has_recordings, "recording")?;
            reject_operation_evidence(
                requested_operation,
                has_reference_comparisons,
                "reference comparison",
            )?;
        }
        "branch_discovery" => {
            reject_operation_evidence(requested_operation, has_captures, "capture")?;
            reject_operation_evidence(requested_operation, has_recordings, "recording")?;
            reject_operation_evidence(
                requested_operation,
                has_reference_comparisons,
                "reference comparison",
            )?;
        }
        "capture" => {
            reject_operation_evidence(requested_operation, has_branch_events, "branch event")?;
            reject_operation_evidence(requested_operation, has_recordings, "recording")?;
            reject_operation_evidence(
                requested_operation,
                has_reference_comparisons,
                "reference comparison",
            )?;
        }
        "smoke_validation" => {}
        _ => unreachable!("requestedOperation validated before evidence surface check"),
    }
    Ok(())
}

fn reject_operation_evidence(
    requested_operation: &str,
    has_evidence: bool,
    evidence_label: &str,
) -> UtsushiResult<()> {
    if has_evidence {
        return Err(format!(
            "RuntimeEvidenceReportV02.controlledPlaybackSession.requestedOperation {requested_operation} must not carry {evidence_label} evidence"
        )
        .into());
    }
    Ok(())
}

fn is_runtime_playback_feature(value: &str) -> bool {
    matches!(
        value,
        "static_trace"
            | "launch"
            | "text_trace"
            | "branch_discovery"
            | "frame_capture"
            | "jump"
            | "snapshot"
            | "screenshot"
            | "recording"
            | "instrumentation_hooks"
            | "vm_state_inspection"
            | "reference_comparison"
    )
}

// UTSUSHI-224: `ObservationErrorPayload` deleted along with the rest of
// the typed observation-hook surface. Error-shaped runtime diagnostics are
// surfaced through `RuntimeAdapterDiagnostic` (already engine-neutral) and
// never flow through a deleted enum variant.

fn validate_required_metadata(field: &str, value: &str) -> UtsushiResult<()> {
    if value.trim().is_empty() {
        return Err(format!("observation hook event missing required field {field}").into());
    }
    Ok(())
}

fn validate_rfc3339_instant_metadata(field: &str, value: &str) -> UtsushiResult<()> {
    if is_valid_rfc3339_instant(value) {
        Ok(())
    } else {
        Err(format!(
            "observation hook event field {field} must be a valid RFC3339 timestamp instant"
        )
        .into())
    }
}

fn is_valid_rfc3339_instant(value: &str) -> bool {
    let Some((date, time_and_offset)) = value.split_once('T') else {
        return false;
    };
    if date.len() != 10
        || date.as_bytes().get(4) != Some(&b'-')
        || date.as_bytes().get(7) != Some(&b'-')
    {
        return false;
    }
    let Some(year) = parse_u32_digits(&date[0..4]) else {
        return false;
    };
    let Some(month) = parse_u32_digits(&date[5..7]) else {
        return false;
    };
    let Some(day) = parse_u32_digits(&date[8..10]) else {
        return false;
    };

    let (time, offset) = if let Some(time) = time_and_offset.strip_suffix('Z') {
        (time, "Z")
    } else if let Some((offset_index, _)) = time_and_offset
        .char_indices()
        .rev()
        .find(|(_, c)| *c == '+' || *c == '-')
    {
        if offset_index == 0 {
            return false;
        }
        (
            &time_and_offset[..offset_index],
            &time_and_offset[offset_index..],
        )
    } else {
        return false;
    };

    if time.len() < 8
        || time.as_bytes().get(2) != Some(&b':')
        || time.as_bytes().get(5) != Some(&b':')
    {
        return false;
    }
    let Some(hour) = parse_u32_digits(&time[0..2]) else {
        return false;
    };
    let Some(minute) = parse_u32_digits(&time[3..5]) else {
        return false;
    };
    let second_text = &time[6..];
    let (second_text, fraction) = second_text
        .split_once('.')
        .map_or((second_text, None), |(second, fraction)| {
            (second, Some(fraction))
        });
    let Some(second) = parse_u32_digits(second_text) else {
        return false;
    };
    if second_text.len() != 2
        || fraction.is_some_and(|fraction| {
            fraction.is_empty() || !fraction.as_bytes().iter().all(u8::is_ascii_digit)
        })
    {
        return false;
    }

    if month == 0
        || month > 12
        || day == 0
        || day > days_in_month(year, month)
        || hour > 23
        || minute > 59
        || second > 59
    {
        return false;
    }

    if offset == "Z" {
        return true;
    }
    if offset.len() != 6 || offset.as_bytes().get(3) != Some(&b':') {
        return false;
    }
    let Some(offset_hour) = parse_u32_digits(&offset[1..3]) else {
        return false;
    };
    let Some(offset_minute) = parse_u32_digits(&offset[4..6]) else {
        return false;
    };
    offset_hour <= 23 && offset_minute <= 59
}

fn parse_u32_digits(value: &str) -> Option<u32> {
    if value.is_empty() || !value.as_bytes().iter().all(u8::is_ascii_digit) {
        return None;
    }
    value.parse().ok()
}

fn days_in_month(year: u32, month: u32) -> u32 {
    match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 if is_leap_year(year) => 29,
        2 => 28,
        _ => 0,
    }
}

fn is_leap_year(year: u32) -> bool {
    year.is_multiple_of(4) && (!year.is_multiple_of(100) || year.is_multiple_of(400))
}

fn is_absent_or_blank(value: Option<&str>) -> bool {
    value.is_none_or(|value| value.trim().is_empty())
}

fn reject_unredacted_local_paths(path: &str, value: &Value) -> UtsushiResult<()> {
    match value {
        Value::String(text) if looks_like_local_path(text) => Err(format!(
            "observation hook event contains unredacted local path at {path}: {text}"
        )
        .into()),
        Value::Array(values) => {
            for (index, value) in values.iter().enumerate() {
                reject_unredacted_local_paths(&format!("{path}[{index}]"), value)?;
            }
            Ok(())
        }
        Value::Object(map) => {
            for (key, value) in map {
                let child_path = if path.is_empty() {
                    key.clone()
                } else {
                    format!("{path}.{key}")
                };
                reject_unredacted_local_paths(&child_path, value)?;
            }
            Ok(())
        }
        _ => Ok(()),
    }
}

/// Audit predicate used by `EnvFieldSchema::validate_value` and the
/// observation event redaction filter. Widened from crate-private to
/// `pub` by UTSUSHI-103 so engine port crates can apply the same
/// rejection rule when stamping their own diagnostics.
pub fn looks_like_local_path(value: &str) -> bool {
    let lower = value.to_ascii_lowercase();
    lower.starts_with("file:")
        || lower.contains("file://")
        || lower.starts_with("~/")
        || lower.starts_with("/home/")
        || lower.contains("/home/")
        || lower.starts_with("/users/")
        || lower.contains("/users/")
        || lower.starts_with("/tmp/")
        || lower.contains("/tmp/")
        || lower.starts_with("/var/folders/")
        || lower.contains("/var/folders/")
        || (value.as_bytes().get(1) == Some(&b':')
            && value
                .as_bytes()
                .get(2)
                .is_some_and(|separator| *separator == b'\\' || *separator == b'/'))
}

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
    /// UTSUSHI-096: a capture hook worker attempted to write a managed runtime
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
    /// (UTSUSHI-162) when the operator opts into the `UTSUSHI_STRICT_DISPLAY`
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

/// UTSUSHI-096: a write fence shared between the launch-capture harness and a
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
    // UTSUSHI-096: gates managed-artifact writes. Shared (cloned) with the
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
        // UTSUSHI-096: refuse writes once the capture boundary has closed. This
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
        // path; on every error path the child is terminated, the pipe closes,
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
    // UTSUSHI-096: install a fresh open fence and keep a clone in the harness.
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
    // UTSUSHI-096: the capture boundary is crossed the instant the harness stops
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

fn has_uri_scheme(value: &str) -> bool {
    let Some(colon) = value.find(':') else {
        return false;
    };
    let scheme = &value[..colon];
    !scheme.is_empty()
        && scheme.chars().enumerate().all(|(index, character)| {
            character.is_ascii_alphabetic()
                || (index > 0
                    && (character.is_ascii_digit()
                        || character == '+'
                        || character == '.'
                        || character == '-'))
        })
}

fn validate_artifact_segment(label: &str, value: &str) -> UtsushiResult<()> {
    if value.is_empty()
        || value == "."
        || value == ".."
        || value.contains('/')
        || value.contains('\\')
        || !value.chars().all(|character| {
            character.is_ascii_alphanumeric() || matches!(character, '-' | '_' | '.')
        })
    {
        return Err(format!("runtime artifact {label} is not a safe path segment: {value}").into());
    }
    Ok(())
}

fn validate_artifact_extension(extension: &str) -> UtsushiResult<()> {
    if extension.is_empty()
        || extension.starts_with('.')
        || !extension
            .chars()
            .all(|character| character.is_ascii_alphanumeric())
    {
        return Err(format!("runtime artifact extension is not safe: {extension}").into());
    }
    Ok(())
}

/// UTSUSHI-093: fd-relative / no-follow filesystem primitives for the runtime
/// artifact root.
///
/// Every mutating operation resolves paths RELATIVE to a directory descriptor
/// opened once with `O_NOFOLLOW`, and every `openat` that descends into a
/// subdirectory also carries `O_NOFOLLOW | O_DIRECTORY`. This closes the TOCTOU
/// window between validating that a path component is a real directory and
/// using it: if a concurrent actor swaps a validated subdirectory for a symlink
/// (pointing outside the managed root), the very next `openat` fails with
/// `ELOOP` instead of following the link out of the root. Cleanup traverses
/// only real directories (opened `O_NOFOLLOW`); a symlink entry is `unlinkat`ed
/// in place (the link itself removed) and is never recursed into, so cleanup
/// can never follow a symlink to a target outside the root.
#[cfg(unix)]
mod artifact_fs {
    use super::{RUNTIME_ARTIFACT_ROOT_MARKER, UtsushiResult};
    use std::ffi::{CStr, CString, OsStr};
    use std::io::{self, Write};
    use std::os::fd::{AsFd, BorrowedFd, OwnedFd};
    use std::path::{Component, Path, PathBuf};

    use rustix::fs::{AtFlags, Dir, FileType, Mode, OFlags};

    fn dir_open_flags() -> OFlags {
        OFlags::RDONLY | OFlags::DIRECTORY | OFlags::NOFOLLOW | OFlags::CLOEXEC
    }

    fn file_create_flags() -> OFlags {
        OFlags::WRONLY | OFlags::CREATE | OFlags::EXCL | OFlags::NOFOLLOW | OFlags::CLOEXEC
    }

    /// Open the managed root directory itself, refusing to follow a final-
    /// component symlink (`O_NOFOLLOW`).
    pub fn open_root_dir(path: &Path) -> io::Result<OwnedFd> {
        rustix::fs::open(path, dir_open_flags(), Mode::empty()).map_err(io::Error::from)
    }

    /// Re-open the directory referenced by `dir` (via `.`) to obtain an owned
    /// descriptor to the same inode without following any symlink.
    fn reopen_dir(dir: BorrowedFd<'_>) -> io::Result<OwnedFd> {
        rustix::fs::openat(
            dir,
            ".",
            OFlags::RDONLY | OFlags::DIRECTORY | OFlags::CLOEXEC,
            Mode::empty(),
        )
        .map_err(io::Error::from)
    }

    /// Open a child directory relative to `dir` with `O_NOFOLLOW`, so a symlink
    /// swapped in for a real subdirectory fails with `ELOOP`.
    fn open_child_dir<P: rustix::path::Arg>(dir: BorrowedFd<'_>, name: P) -> io::Result<OwnedFd> {
        rustix::fs::openat(dir, name, dir_open_flags(), Mode::empty()).map_err(io::Error::from)
    }

    /// Classify an entry relative to `dir` WITHOUT following symlinks.
    pub fn entry_file_type<P: rustix::path::Arg>(
        dir: BorrowedFd<'_>,
        name: P,
    ) -> io::Result<FileType> {
        let stat =
            rustix::fs::statat(dir, name, AtFlags::SYMLINK_NOFOLLOW).map_err(io::Error::from)?;
        Ok(FileType::from_raw_mode(stat.st_mode))
    }

    /// Convert a failure to open a supposedly-real subdirectory into a
    /// descriptive error; a `symlink` re-classification means the entry was
    /// swapped for a symlink and `O_NOFOLLOW` refused to traverse it.
    fn describe_child_dir_error(
        parent: BorrowedFd<'_>,
        name: &OsStr,
        error: io::Error,
    ) -> Box<dyn std::error::Error> {
        if let Ok(file_type) = entry_file_type(parent, name) {
            if file_type.is_symlink() {
                return format!(
                    "runtime artifact path component must not be a symlink: {}",
                    name.to_string_lossy()
                )
                .into();
            }
            if !file_type.is_dir() {
                return format!(
                    "runtime artifact path component must be a directory: {}",
                    name.to_string_lossy()
                )
                .into();
            }
        }
        error.into()
    }

    /// Map a root-open failure onto a stable, descriptive error (e.g. the root
    /// itself being a symlink that `O_NOFOLLOW` refused).
    pub fn describe_root_open(path: &Path, error: io::Error) -> Box<dyn std::error::Error> {
        if let Ok(metadata) = std::fs::symlink_metadata(path) {
            if metadata.file_type().is_symlink() {
                return format!(
                    "runtime artifact root must not be a symlink: {}",
                    path.display()
                )
                .into();
            }
            if !metadata.is_dir() {
                return format!(
                    "runtime artifact root must be a directory: {}",
                    path.display()
                )
                .into();
            }
        }
        error.into()
    }

    fn create_dir_ignore_existing<P: rustix::path::Arg>(
        dir: BorrowedFd<'_>,
        name: P,
    ) -> UtsushiResult<()> {
        match rustix::fs::mkdirat(dir, name, Mode::RWXU) {
            Ok(()) => Ok(()),
            Err(error) if error == rustix::io::Errno::EXIST => Ok(()),
            Err(error) => Err(io::Error::from(error).into()),
        }
    }

    /// Descend `relative` from `root`, creating missing components, and return a
    /// descriptor to the deepest directory. Each hop is `mkdirat` + `openat`
    /// with `O_NOFOLLOW`, so no component can be a symlink at the moment we
    /// traverse it.
    pub fn open_or_create_dir_chain(
        root: BorrowedFd<'_>,
        relative: &Path,
    ) -> UtsushiResult<OwnedFd> {
        let mut current = reopen_dir(root).map_err(Box::<dyn std::error::Error>::from)?;
        for component in relative.components() {
            let Component::Normal(name) = component else {
                return Err(format!(
                    "runtime artifact relative path must contain only normal segments: {}",
                    relative.display()
                )
                .into());
            };
            create_dir_ignore_existing(current.as_fd(), name)?;
            let opened = open_child_dir(current.as_fd(), name);
            current = match opened {
                Ok(fd) => fd,
                Err(error) => {
                    return Err(describe_child_dir_error(current.as_fd(), name, error));
                }
            };
        }
        Ok(current)
    }

    /// Open a child directory that may not exist, `O_NOFOLLOW`. A symlink in
    /// that slot is refused (never followed).
    pub fn open_child_dir_optional(
        dir: BorrowedFd<'_>,
        name: &str,
    ) -> UtsushiResult<Option<OwnedFd>> {
        match open_child_dir(dir, name) {
            Ok(fd) => Ok(Some(fd)),
            Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
            Err(error) => {
                if let Ok(file_type) = entry_file_type(dir, name)
                    && file_type.is_symlink()
                {
                    return Err(format!(
                        "runtime artifact staging root must not be a symlink: {name}"
                    )
                    .into());
                }
                Err(error.into())
            }
        }
    }

    /// Write `contents` to `filename` inside `dir` atomically and no-follow:
    /// create a temp with `O_CREAT|O_EXCL|O_NOFOLLOW`, then `renameat` it over
    /// the destination (rename never follows a symlink at the destination, so a
    /// concurrently swapped-in symlink is replaced in place, never written
    /// through). A symlink already occupying the destination is refused.
    pub fn write_file_no_follow(
        dir: BorrowedFd<'_>,
        filename: &OsStr,
        contents: &[u8],
    ) -> UtsushiResult<()> {
        match entry_file_type(dir, filename) {
            Ok(file_type) if file_type.is_symlink() => {
                return Err(format!(
                    "runtime artifact destination must not be a symlink: {}",
                    filename.to_string_lossy()
                )
                .into());
            }
            Ok(file_type) if file_type.is_dir() => {
                return Err(format!(
                    "runtime artifact destination must not be a directory: {}",
                    filename.to_string_lossy()
                )
                .into());
            }
            Ok(_) => {}
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.into()),
        }

        let base = filename.to_string_lossy();
        let mut last_error: Option<io::Error> = None;
        for attempt in 0..16 {
            let temporary = format!(".{base}.tmp-{}-{attempt}", std::process::id());
            match rustix::fs::openat(
                dir,
                temporary.as_str(),
                file_create_flags(),
                Mode::RUSR | Mode::WUSR,
            ) {
                Ok(fd) => {
                    let mut file = std::fs::File::from(fd);
                    if let Err(error) = file.write_all(contents).and_then(|()| file.sync_all()) {
                        let _ = rustix::fs::unlinkat(dir, temporary.as_str(), AtFlags::empty());
                        return Err(error.into());
                    }
                    drop(file);
                    rustix::fs::renameat(dir, temporary.as_str(), dir, filename)
                        .map_err(io::Error::from)?;
                    return Ok(());
                }
                Err(error) if error == rustix::io::Errno::EXIST => {
                    last_error = Some(io::Error::from(error));
                }
                Err(error) => return Err(io::Error::from(error).into()),
            }
        }
        Err(last_error
            .unwrap_or_else(|| {
                io::Error::new(io::ErrorKind::AlreadyExists, "temporary file exists")
            })
            .into())
    }

    /// Clear any stale entry occupying a staging filename, refusing a symlink or
    /// directory squatting there. Used for an externally-written staging path so
    /// the returned path is guaranteed not to be a link at hand-off time.
    pub fn clear_staging_destination(dir: BorrowedFd<'_>, filename: &OsStr) -> UtsushiResult<()> {
        match entry_file_type(dir, filename) {
            Ok(file_type) if file_type.is_symlink() => Err(format!(
                "runtime artifact destination must not be a symlink: {}",
                filename.to_string_lossy()
            )
            .into()),
            Ok(file_type) if file_type.is_dir() => Err(format!(
                "runtime artifact destination must not be a directory: {}",
                filename.to_string_lossy()
            )
            .into()),
            Ok(_) => {
                rustix::fs::unlinkat(dir, filename, AtFlags::empty()).map_err(io::Error::from)?;
                Ok(())
            }
            Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(error.into()),
        }
    }

    /// Collect the entry names in `dir` (excluding `.`/`..`) via `getdents` on
    /// the held descriptor.
    pub fn read_dir_names(dir: BorrowedFd<'_>) -> UtsushiResult<Vec<CString>> {
        let mut names = Vec::new();
        let mut reader = Dir::read_from(dir).map_err(io::Error::from)?;
        while let Some(entry) = reader.read() {
            let entry = entry.map_err(io::Error::from)?;
            let name = entry.file_name();
            if name == c"." || name == c".." {
                continue;
            }
            names.push(name.to_owned());
        }
        Ok(names)
    }

    pub fn dir_has_entries(dir: BorrowedFd<'_>) -> UtsushiResult<bool> {
        Ok(!read_dir_names(dir)?.is_empty())
    }

    /// Remove an entry relative to `parent` without ever following a symlink.
    /// Real directories are opened `O_NOFOLLOW`, emptied recursively, then
    /// removed with `AT_REMOVEDIR`. Anything else (regular file, symlink, …) is
    /// `unlinkat`ed in place, so a symlink is removed as a link and never
    /// recursed into a target outside the root.
    pub fn remove_entry(parent: BorrowedFd<'_>, name: &CStr) -> UtsushiResult<()> {
        let file_type = match entry_file_type(parent, name) {
            Ok(file_type) => file_type,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
            Err(error) => return Err(error.into()),
        };

        if file_type.is_dir() {
            match open_child_dir(parent, name) {
                Ok(child) => {
                    remove_dir_children(child.as_fd())?;
                    drop(child);
                    rustix::fs::unlinkat(parent, name, AtFlags::REMOVEDIR)
                        .map_err(io::Error::from)?;
                }
                Err(open_error) => {
                    // The directory we classified may have been swapped for a
                    // symlink between the stat and the open; re-classify
                    // no-follow and, if it is now a symlink, unlink the LINK
                    // (never follow it out of the root).
                    match entry_file_type(parent, name) {
                        Ok(swapped) if swapped.is_symlink() => {
                            rustix::fs::unlinkat(parent, name, AtFlags::empty())
                                .map_err(io::Error::from)?;
                        }
                        Ok(_) => return Err(open_error.into()),
                        Err(error) if error.kind() == io::ErrorKind::NotFound => {}
                        Err(error) => return Err(error.into()),
                    }
                }
            }
        } else {
            rustix::fs::unlinkat(parent, name, AtFlags::empty()).map_err(io::Error::from)?;
        }
        Ok(())
    }

    fn remove_dir_children(dir: BorrowedFd<'_>) -> UtsushiResult<()> {
        for name in read_dir_names(dir)? {
            remove_entry(dir, &name)?;
        }
        Ok(())
    }

    /// Remove an empty directory relative to `parent` if present; tolerate a
    /// concurrent race that refilled or removed it.
    pub fn remove_empty_dir_if_present(parent: BorrowedFd<'_>, name: &CStr) -> UtsushiResult<()> {
        match rustix::fs::unlinkat(parent, name, AtFlags::REMOVEDIR) {
            Ok(()) => Ok(()),
            Err(error)
                if error == rustix::io::Errno::NOENT || error == rustix::io::Errno::NOTEMPTY =>
            {
                Ok(())
            }
            Err(error) => Err(io::Error::from(error).into()),
        }
    }

    /// Create the managed root directory (and any missing ancestors) at setup
    /// time, refusing symlinked components. This governs the root's own path
    /// (operator space); every artifact operation thereafter is fd-relative
    /// against the opened root descriptor.
    pub fn create_directory_no_follow(path: &Path) -> UtsushiResult<()> {
        if path.as_os_str().is_empty() {
            return Err("runtime artifact root must not be empty".into());
        }

        let mut current = PathBuf::new();
        for component in path.components() {
            match component {
                Component::Prefix(prefix) => current.push(prefix.as_os_str()),
                Component::RootDir => current.push(component.as_os_str()),
                Component::CurDir => {}
                Component::ParentDir | Component::Normal(_) => {
                    current.push(component.as_os_str());
                    match std::fs::symlink_metadata(&current) {
                        Ok(metadata) => {
                            if metadata.file_type().is_symlink() {
                                return Err(format!(
                                    "runtime artifact path component must not be a symlink: {}",
                                    current.display()
                                )
                                .into());
                            }
                            if !metadata.is_dir() {
                                return Err(format!(
                                    "runtime artifact path component must be a directory: {}",
                                    current.display()
                                )
                                .into());
                            }
                        }
                        Err(error) if error.kind() == io::ErrorKind::NotFound => {
                            std::fs::create_dir(&current)?;
                        }
                        Err(error) => return Err(error.into()),
                    }
                }
            }
        }
        Ok(())
    }

    /// Write the managed-root marker relative to the held root descriptor
    /// (`O_CREAT|O_EXCL|O_NOFOLLOW`), so it cannot land on a swapped-in symlink.
    pub fn write_marker(root: BorrowedFd<'_>) -> UtsushiResult<()> {
        let fd = rustix::fs::openat(
            root,
            RUNTIME_ARTIFACT_ROOT_MARKER,
            file_create_flags(),
            Mode::RUSR | Mode::WUSR,
        )
        .map_err(io::Error::from)?;
        let mut file = std::fs::File::from(fd);
        file.write_all(b"managed-by=utsushi-runtime\n")?;
        file.sync_all()?;
        Ok(())
    }
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

    // UTSUSHI-096: poll the out-of-band slot the detached hook worker records
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

    // UTSUSHI-224: tests that exercised the deleted typed
    // `deleted-hook-envelope` envelope (round-trip, schema-version,
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
        // (rewritten in UTSUSHI-224 to drop its `deleted-hook-envelope`
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

    // UTSUSHI-096: a hook that blocks past its timeout and, once released by the
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

    // UTSUSHI-096: a hook that times out during launch-capture leaves a detached
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

    // UTSUSHI-096: the fence must not disturb the normal path — a write made
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

    // UTSUSHI-093 crux: a concurrent actor SWAPS a validated run directory for a
    // symlink pointing OUTSIDE the managed root while writes are in flight. The
    // fd-relative / no-follow write path must never follow the swapped-in link,
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

    // UTSUSHI-151: the soft artifact-byte budget is enforced on the REAL
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

    // UTSUSHI-151: a root with no configured budget never rejects a write for
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

    // UTSUSHI-093: cleanup traverses ONLY real directories. A symlink anywhere
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
