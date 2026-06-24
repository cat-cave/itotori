//! Integration tests for the UTSUSHI-103 engine-port runner template and
//! the UTSUSHI-224 sinks-bridge migration.
//!
//! Every behavior test exercises a synthetic port defined inside this
//! file; the test crate has no dependency on `utsushi-fixture`. The
//! synthetic ports exercise positive (`ReferencePort`), drift
//! (`MissingObservePort`, `JumpUndeclaredPort`), ABI mismatch
//! (`UnsupportedAbi`), env-leak (`UnredactedEnvRuntimePort`) and
//! tick-ordering (`OrderingProbePort`) paths.

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use serde_json::Value;
use tempfile::TempDir;

use utsushi_core::{
    AudioEvent, AudioEventKind, AudioEventSink, CapabilityReason, CaptureOutcome, DriftKind,
    EnginePort, EnginePortAdapter, EnginePortError, EnvFieldSchema, EnvFieldShape, EvidenceTier,
    FidelityTier, FrameArtifact, FrameArtifactSink, LifecycleStage, MomentId,
    ObservationArtifactRef, PortCapability, PortEnv, PortManifest, PortRequest,
    PortShutdownOutcome, PortShutdownStatus, REQUIRED_LIFECYCLE_STAGES, RUNTIME_ARTIFACT_URI_ROOT,
    Runner, RunnerCancellation, RuntimeAdapter, RuntimeAdapterDescriptor, RuntimeArtifactKind,
    RuntimeArtifactRoot, RuntimeOperation, RuntimeRequest, SinkCapability, SinkResult, SinkSet,
    TextLine, TextSurfaceSink, port::conformance,
};

// ===================================================================
// Helper sinks shared by the synthetic ports
// ===================================================================

struct CollectingTextSink {
    inner: Mutex<Vec<TextLine>>,
}

impl CollectingTextSink {
    fn new() -> Self {
        Self {
            inner: Mutex::new(Vec::new()),
        }
    }
}

impl TextSurfaceSink for CollectingTextSink {
    fn capability(&self) -> SinkCapability {
        SinkCapability::Supported {
            evidence_tier_ceiling: EvidenceTier::E1,
        }
    }

    fn emit_line(&self, line: TextLine) -> SinkResult<()> {
        line.validate()?;
        self.inner.lock().expect("text lock").push(line);
        Ok(())
    }

    fn drain_lines(&self) -> Vec<TextLine> {
        std::mem::take(&mut *self.inner.lock().expect("text lock"))
    }
}

struct CollectingFrameSink {
    inner: Mutex<Vec<FrameArtifact>>,
}

impl CollectingFrameSink {
    fn new() -> Self {
        Self {
            inner: Mutex::new(Vec::new()),
        }
    }
}

impl FrameArtifactSink for CollectingFrameSink {
    fn capability(&self) -> SinkCapability {
        SinkCapability::Supported {
            evidence_tier_ceiling: EvidenceTier::E2,
        }
    }

    fn emit_frame(&self, frame: FrameArtifact) -> SinkResult<()> {
        frame.validate()?;
        self.inner.lock().expect("frame lock").push(frame);
        Ok(())
    }

    fn drain_frames(&self) -> Vec<FrameArtifact> {
        std::mem::take(&mut *self.inner.lock().expect("frame lock"))
    }
}

struct CollectingAudioSink {
    inner: Mutex<Vec<AudioEvent>>,
}

impl CollectingAudioSink {
    fn new() -> Self {
        Self {
            inner: Mutex::new(Vec::new()),
        }
    }
}

impl AudioEventSink for CollectingAudioSink {
    fn capability(&self) -> SinkCapability {
        SinkCapability::Supported {
            evidence_tier_ceiling: EvidenceTier::E0,
        }
    }

    fn emit_event(&self, event: AudioEvent) -> SinkResult<()> {
        event.validate()?;
        self.inner.lock().expect("audio lock").push(event);
        Ok(())
    }

    fn drain_events(&self) -> Vec<AudioEvent> {
        std::mem::take(&mut *self.inner.lock().expect("audio lock"))
    }
}

fn synthetic_text_line(line_id: &str) -> TextLine {
    TextLine {
        line_id: line_id.to_string(),
        evidence_tier: EvidenceTier::E1,
        text: "synthetic text observation".to_string(),
        speaker: None,
        text_surface: None,
        bridge_ref: None,
        source_asset: None,
    }
}

fn synthetic_frame(frame_id: &str) -> FrameArtifact {
    let run_id = "synthetic-run-0001";
    let uri = format!(
        "{}/{}/screenshots/{}.png",
        RUNTIME_ARTIFACT_URI_ROOT, run_id, frame_id
    );
    FrameArtifact {
        frame_id: frame_id.to_string(),
        evidence_tier: EvidenceTier::E2,
        artifact_ref: ObservationArtifactRef {
            artifact_id: frame_id.to_string(),
            artifact_kind: "screenshot".to_string(),
            uri,
            media_type: Some("image/png".to_string()),
        },
        width: Some(320),
        height: Some(180),
        frame_index: 1,
        bridge_ref: None,
    }
}

fn synthetic_audio(event_id: &str) -> AudioEvent {
    AudioEvent {
        event_id: event_id.to_string(),
        evidence_tier: EvidenceTier::E0,
        event_kind: AudioEventKind::Marker,
        cue_id: None,
        source_asset: None,
        bridge_ref: None,
        frame_index: Some(1),
    }
}

fn build_default_sink_set() -> (
    Arc<CollectingTextSink>,
    Arc<CollectingFrameSink>,
    Arc<CollectingAudioSink>,
    SinkSet,
) {
    let text = Arc::new(CollectingTextSink::new());
    let frame = Arc::new(CollectingFrameSink::new());
    let audio = Arc::new(CollectingAudioSink::new());
    let sink_set = SinkSet::new()
        .with_text(text.clone() as Arc<dyn TextSurfaceSink>)
        .with_frame(frame.clone() as Arc<dyn FrameArtifactSink>)
        .with_audio(audio.clone() as Arc<dyn AudioEventSink>);
    (text, frame, audio, sink_set)
}

// ===================================================================
// Synthetic ports
// ===================================================================

/// Reference port: implements every required stage and pushes one text
/// observation per launch into its sink set.
struct ReferencePort {
    state: PortState,
    sink_set: SinkSet,
    text: Arc<CollectingTextSink>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum PortState {
    Idle,
    Launched,
    Observed,
    ShutDown,
}

impl ReferencePort {
    const MANIFEST: PortManifest = PortManifest {
        id: "utsushi-synthetic-ref",
        name: "Synthetic Reference Port",
        version: "0.0.0",
        abi_version: 1,
        capabilities: &[
            PortCapability::Launch,
            PortCapability::Observe,
            PortCapability::Capture,
            PortCapability::Shutdown,
        ],
        required_methods: REQUIRED_LIFECYCLE_STAGES,
        optional_methods: &[],
        env_schema: &[],
        fidelity_tier_max: FidelityTier::LayoutProbe,
        evidence_tier_max: EvidenceTier::E2,
        limitations: &["Synthetic test-only port; emits no real engine evidence."],
    };

    fn new() -> Self {
        let (text, _frame, _audio, sink_set) = build_default_sink_set();
        Self {
            state: PortState::Idle,
            sink_set,
            text,
        }
    }
}

impl EnginePort for ReferencePort {
    const MANIFEST: PortManifest = Self::MANIFEST;

    fn launch(&mut self, request: &PortRequest<'_>) -> Result<(), EnginePortError> {
        request.cancellation.check(LifecycleStage::Launch)?;
        self.state = PortState::Launched;
        Ok(())
    }

    fn observe(&mut self, _request: &PortRequest<'_>) -> Result<(), EnginePortError> {
        if self.state == PortState::Launched {
            self.state = PortState::Observed;
            self.text
                .emit_line(synthetic_text_line("ref-event-1"))
                .map_err(|error| EnginePortError::Lifecycle {
                    stage: LifecycleStage::Observe,
                    message: format!("text emit failed: {error}"),
                    source: None,
                })?;
        }
        Ok(())
    }

    fn sink_set(&self) -> &SinkSet {
        &self.sink_set
    }

    fn capture(&mut self, request: &PortRequest<'_>) -> Result<CaptureOutcome, EnginePortError> {
        let root = request
            .artifact_root
            .ok_or_else(|| EnginePortError::Lifecycle {
                stage: LifecycleStage::Capture,
                message: "capture requires an artifact root".to_string(),
                source: None,
            })?;
        let uri = utsushi_core::runtime_artifact_uri(
            request.run_id,
            RuntimeArtifactKind::ConformanceReport,
            "reference-capture",
        )
        .map_err(|error| EnginePortError::Lifecycle {
            stage: LifecycleStage::Capture,
            message: format!("artifact uri build failed: {error}"),
            source: None,
        })?;
        let path = root
            .write_bytes(&uri, b"{\"synthetic\":true}\n")
            .map_err(|error| EnginePortError::Lifecycle {
                stage: LifecycleStage::Capture,
                message: format!("artifact write failed: {error}"),
                source: None,
            })?;
        Ok(CaptureOutcome::new(uri).with_path(path).with_summary("ok"))
    }

    fn shutdown(&mut self) -> Result<PortShutdownOutcome, EnginePortError> {
        if self.state == PortState::ShutDown {
            Ok(PortShutdownOutcome::already_shut_down())
        } else {
            self.state = PortState::ShutDown;
            Ok(PortShutdownOutcome::clean())
        }
    }
}

/// Jump-capable port: declares Jump in its manifest and overrides the
/// trait method to succeed.
struct JumpCapablePort(ReferencePort);

impl JumpCapablePort {
    const MANIFEST: PortManifest = PortManifest {
        id: "utsushi-synthetic-jump",
        name: "Synthetic Jump-Capable Port",
        version: "0.0.0",
        abi_version: 1,
        capabilities: &[
            PortCapability::Launch,
            PortCapability::Observe,
            PortCapability::Capture,
            PortCapability::Shutdown,
            PortCapability::Jump,
        ],
        required_methods: REQUIRED_LIFECYCLE_STAGES,
        optional_methods: &[LifecycleStage::Jump],
        env_schema: &[],
        fidelity_tier_max: FidelityTier::LayoutProbe,
        evidence_tier_max: EvidenceTier::E2,
        limitations: &[],
    };

    fn new() -> Self {
        Self(ReferencePort::new())
    }
}

impl EnginePort for JumpCapablePort {
    const MANIFEST: PortManifest = Self::MANIFEST;

    fn launch(&mut self, request: &PortRequest<'_>) -> Result<(), EnginePortError> {
        self.0.launch(request)
    }

    fn observe(&mut self, request: &PortRequest<'_>) -> Result<(), EnginePortError> {
        self.0.observe(request)
    }

    fn sink_set(&self) -> &SinkSet {
        self.0.sink_set()
    }

    fn capture(&mut self, request: &PortRequest<'_>) -> Result<CaptureOutcome, EnginePortError> {
        self.0.capture(request)
    }

    fn jump(
        &mut self,
        _request: &PortRequest<'_>,
        _moment: &MomentId,
    ) -> Result<(), EnginePortError> {
        Ok(())
    }

    fn shutdown(&mut self) -> Result<PortShutdownOutcome, EnginePortError> {
        self.0.shutdown()
    }
}

/// Drift port: overrides `jump` but does NOT declare `Jump` in the
/// manifest. The conformance harness must surface
/// `ManifestCapabilityDrift { kind: UnclaimedImplementation }`.
struct JumpUndeclaredPort(ReferencePort);

impl JumpUndeclaredPort {
    const MANIFEST: PortManifest = PortManifest {
        id: "utsushi-synthetic-jundecl",
        name: "Synthetic Jump-Undeclared Port",
        version: "0.0.0",
        abi_version: 1,
        capabilities: &[
            PortCapability::Launch,
            PortCapability::Observe,
            PortCapability::Capture,
            PortCapability::Shutdown,
        ],
        required_methods: REQUIRED_LIFECYCLE_STAGES,
        optional_methods: &[],
        env_schema: &[],
        fidelity_tier_max: FidelityTier::LayoutProbe,
        evidence_tier_max: EvidenceTier::E2,
        limitations: &[],
    };

    fn new() -> Self {
        Self(ReferencePort::new())
    }
}

impl EnginePort for JumpUndeclaredPort {
    const MANIFEST: PortManifest = Self::MANIFEST;

    fn launch(&mut self, request: &PortRequest<'_>) -> Result<(), EnginePortError> {
        self.0.launch(request)
    }

    fn observe(&mut self, request: &PortRequest<'_>) -> Result<(), EnginePortError> {
        self.0.observe(request)
    }

    fn sink_set(&self) -> &SinkSet {
        self.0.sink_set()
    }

    fn capture(&mut self, request: &PortRequest<'_>) -> Result<CaptureOutcome, EnginePortError> {
        self.0.capture(request)
    }

    fn jump(
        &mut self,
        _request: &PortRequest<'_>,
        _moment: &MomentId,
    ) -> Result<(), EnginePortError> {
        // Drift: implements jump without declaring Jump capability.
        Ok(())
    }

    fn shutdown(&mut self) -> Result<PortShutdownOutcome, EnginePortError> {
        self.0.shutdown()
    }
}

/// Missing-observe port: returns CapabilityUnsupported from `observe`,
/// which the conformance harness must surface as a lifecycle failure.
struct MissingObservePort {
    launched: bool,
    shut_down: bool,
    sink_set: SinkSet,
}

impl MissingObservePort {
    const MANIFEST: PortManifest = PortManifest {
        id: "utsushi-synthetic-nobs",
        name: "Synthetic Missing-Observe Port",
        version: "0.0.0",
        abi_version: 1,
        capabilities: &[
            PortCapability::Launch,
            PortCapability::Observe,
            PortCapability::Capture,
            PortCapability::Shutdown,
        ],
        required_methods: REQUIRED_LIFECYCLE_STAGES,
        optional_methods: &[],
        env_schema: &[],
        fidelity_tier_max: FidelityTier::LayoutProbe,
        evidence_tier_max: EvidenceTier::E2,
        limitations: &[],
    };

    fn new() -> Self {
        let (_text, _frame, _audio, sink_set) = build_default_sink_set();
        Self {
            launched: false,
            shut_down: false,
            sink_set,
        }
    }
}

impl EnginePort for MissingObservePort {
    const MANIFEST: PortManifest = Self::MANIFEST;

    fn launch(&mut self, _request: &PortRequest<'_>) -> Result<(), EnginePortError> {
        self.launched = true;
        Ok(())
    }

    fn observe(&mut self, _request: &PortRequest<'_>) -> Result<(), EnginePortError> {
        Err(EnginePortError::CapabilityUnsupported {
            capability: PortCapability::Observe,
            reason: CapabilityReason::DefaultUnimplemented,
        })
    }

    fn sink_set(&self) -> &SinkSet {
        &self.sink_set
    }

    fn capture(&mut self, _request: &PortRequest<'_>) -> Result<CaptureOutcome, EnginePortError> {
        Err(EnginePortError::CapabilityUnsupported {
            capability: PortCapability::Capture,
            reason: CapabilityReason::DefaultUnimplemented,
        })
    }

    fn shutdown(&mut self) -> Result<PortShutdownOutcome, EnginePortError> {
        if self.shut_down {
            Ok(PortShutdownOutcome::already_shut_down())
        } else {
            self.shut_down = true;
            Ok(PortShutdownOutcome::clean())
        }
    }
}

/// Manifest declaring abi_version = 99. Used to assert the runner
/// rejects ports it cannot drive.
const UNSUPPORTED_ABI_MANIFEST: PortManifest = PortManifest {
    id: "utsushi-synthetic-badabi",
    name: "Unsupported ABI Port",
    version: "0.0.0",
    abi_version: 99,
    capabilities: &[
        PortCapability::Launch,
        PortCapability::Observe,
        PortCapability::Capture,
        PortCapability::Shutdown,
    ],
    required_methods: REQUIRED_LIFECYCLE_STAGES,
    optional_methods: &[],
    env_schema: &[],
    fidelity_tier_max: FidelityTier::LayoutProbe,
    evidence_tier_max: EvidenceTier::E2,
    limitations: &[],
};

/// Port declaring a forbidden env shape in its manifest.
const ENV_PATH_FORBIDDEN_MANIFEST: PortManifest = PortManifest {
    id: "utsushi-synthetic-envpath",
    name: "Env Path Forbidden Port",
    version: "0.0.0",
    abi_version: 1,
    capabilities: &[
        PortCapability::Launch,
        PortCapability::Observe,
        PortCapability::Capture,
        PortCapability::Shutdown,
    ],
    required_methods: REQUIRED_LIFECYCLE_STAGES,
    optional_methods: &[],
    env_schema: &[EnvFieldSchema {
        key: "UTSUSHI_PORT_DIR",
        shape: EnvFieldShape::Path,
        required: false,
        purpose: "tries to read a directory path via env",
    }],
    fidelity_tier_max: FidelityTier::LayoutProbe,
    evidence_tier_max: EvidenceTier::E2,
    limitations: &[],
};

/// Port that declares a single `OpaqueToken` env field. The harness
/// supplies a runtime value matching `looks_like_local_path` to confirm
/// the runner rejects it at launch time.
struct UnredactedEnvRuntimePort {
    sink_set: SinkSet,
}

impl UnredactedEnvRuntimePort {
    const MANIFEST: PortManifest = PortManifest {
        id: "utsushi-synthetic-envrun",
        name: "Unredacted Env Runtime Port",
        version: "0.0.0",
        abi_version: 1,
        capabilities: &[
            PortCapability::Launch,
            PortCapability::Observe,
            PortCapability::Capture,
            PortCapability::Shutdown,
        ],
        required_methods: REQUIRED_LIFECYCLE_STAGES,
        optional_methods: &[],
        env_schema: &[EnvFieldSchema {
            key: "UTSUSHI_RUN_TOKEN",
            shape: EnvFieldShape::OpaqueToken,
            required: true,
            purpose: "runtime token; runner must reject local-path-shaped values",
        }],
        fidelity_tier_max: FidelityTier::LayoutProbe,
        evidence_tier_max: EvidenceTier::E2,
        limitations: &[],
    };

    fn new() -> Self {
        let (_text, _frame, _audio, sink_set) = build_default_sink_set();
        Self { sink_set }
    }
}

impl EnginePort for UnredactedEnvRuntimePort {
    const MANIFEST: PortManifest = Self::MANIFEST;

    fn launch(&mut self, _request: &PortRequest<'_>) -> Result<(), EnginePortError> {
        Ok(())
    }

    fn observe(&mut self, _request: &PortRequest<'_>) -> Result<(), EnginePortError> {
        Ok(())
    }

    fn sink_set(&self) -> &SinkSet {
        &self.sink_set
    }

    fn capture(&mut self, _request: &PortRequest<'_>) -> Result<CaptureOutcome, EnginePortError> {
        Ok(CaptureOutcome::new(
            "artifacts/utsushi/runtime/x/conformance-reports/x.json",
        ))
    }

    fn shutdown(&mut self) -> Result<PortShutdownOutcome, EnginePortError> {
        Ok(PortShutdownOutcome::clean())
    }
}

/// Recording sink that timestamps every emission against a shared
/// counter so the runner's per-tick ordering invariant
/// (text → frame → audio) is observable from a single `Vec<Sample>`.
#[derive(Clone, Debug, PartialEq, Eq)]
enum DrainSample {
    Text(String),
    Frame(String),
    Audio(String),
}

#[derive(Default)]
struct OrderingProbeRecorder {
    samples: Mutex<Vec<DrainSample>>,
}

impl OrderingProbeRecorder {
    fn new() -> Self {
        Self::default()
    }

    fn record(&self, sample: DrainSample) {
        self.samples.lock().expect("record lock").push(sample);
    }

    fn snapshot(&self) -> Vec<DrainSample> {
        self.samples.lock().expect("record lock").clone()
    }
}

struct OrderedTextSink {
    inner: Mutex<Vec<TextLine>>,
    recorder: Arc<OrderingProbeRecorder>,
}

impl TextSurfaceSink for OrderedTextSink {
    fn capability(&self) -> SinkCapability {
        SinkCapability::Supported {
            evidence_tier_ceiling: EvidenceTier::E1,
        }
    }

    fn emit_line(&self, line: TextLine) -> SinkResult<()> {
        line.validate()?;
        self.inner.lock().expect("text lock").push(line);
        Ok(())
    }

    fn drain_lines(&self) -> Vec<TextLine> {
        let drained = std::mem::take(&mut *self.inner.lock().expect("text lock"));
        for line in &drained {
            self.recorder
                .record(DrainSample::Text(line.line_id.clone()));
        }
        drained
    }
}

struct OrderedFrameSink {
    inner: Mutex<Vec<FrameArtifact>>,
    recorder: Arc<OrderingProbeRecorder>,
}

impl FrameArtifactSink for OrderedFrameSink {
    fn capability(&self) -> SinkCapability {
        SinkCapability::Supported {
            evidence_tier_ceiling: EvidenceTier::E2,
        }
    }

    fn emit_frame(&self, frame: FrameArtifact) -> SinkResult<()> {
        frame.validate()?;
        self.inner.lock().expect("frame lock").push(frame);
        Ok(())
    }

    fn drain_frames(&self) -> Vec<FrameArtifact> {
        let drained = std::mem::take(&mut *self.inner.lock().expect("frame lock"));
        for frame in &drained {
            self.recorder
                .record(DrainSample::Frame(frame.frame_id.clone()));
        }
        drained
    }
}

struct OrderedAudioSink {
    inner: Mutex<Vec<AudioEvent>>,
    recorder: Arc<OrderingProbeRecorder>,
}

impl AudioEventSink for OrderedAudioSink {
    fn capability(&self) -> SinkCapability {
        SinkCapability::Supported {
            evidence_tier_ceiling: EvidenceTier::E0,
        }
    }

    fn emit_event(&self, event: AudioEvent) -> SinkResult<()> {
        event.validate()?;
        self.inner.lock().expect("audio lock").push(event);
        Ok(())
    }

    fn drain_events(&self) -> Vec<AudioEvent> {
        let drained = std::mem::take(&mut *self.inner.lock().expect("audio lock"));
        for event in &drained {
            self.recorder
                .record(DrainSample::Audio(event.event_id.clone()));
        }
        drained
    }
}

struct OrderingProbePort {
    recorder: Arc<OrderingProbeRecorder>,
    text: Arc<OrderedTextSink>,
    frame: Arc<OrderedFrameSink>,
    audio: Arc<OrderedAudioSink>,
    sink_set: SinkSet,
    observe_calls: usize,
    shut_down: bool,
}

impl OrderingProbePort {
    const MANIFEST: PortManifest = PortManifest {
        id: "utsushi-synthetic-order",
        name: "Synthetic Ordering Probe Port",
        version: "0.0.0",
        abi_version: 1,
        capabilities: &[
            PortCapability::Launch,
            PortCapability::Observe,
            PortCapability::Capture,
            PortCapability::Shutdown,
        ],
        required_methods: REQUIRED_LIFECYCLE_STAGES,
        optional_methods: &[],
        env_schema: &[],
        fidelity_tier_max: FidelityTier::LayoutProbe,
        evidence_tier_max: EvidenceTier::E2,
        limitations: &[],
    };

    fn new() -> Self {
        let recorder = Arc::new(OrderingProbeRecorder::new());
        let text = Arc::new(OrderedTextSink {
            inner: Mutex::new(Vec::new()),
            recorder: recorder.clone(),
        });
        let frame = Arc::new(OrderedFrameSink {
            inner: Mutex::new(Vec::new()),
            recorder: recorder.clone(),
        });
        let audio = Arc::new(OrderedAudioSink {
            inner: Mutex::new(Vec::new()),
            recorder: recorder.clone(),
        });
        let sink_set = SinkSet::new()
            .with_text(text.clone() as Arc<dyn TextSurfaceSink>)
            .with_frame(frame.clone() as Arc<dyn FrameArtifactSink>)
            .with_audio(audio.clone() as Arc<dyn AudioEventSink>);
        Self {
            recorder,
            text,
            frame,
            audio,
            sink_set,
            observe_calls: 0,
            shut_down: false,
        }
    }

    fn recorder(&self) -> Arc<OrderingProbeRecorder> {
        self.recorder.clone()
    }
}

impl EnginePort for OrderingProbePort {
    const MANIFEST: PortManifest = Self::MANIFEST;

    fn launch(&mut self, _request: &PortRequest<'_>) -> Result<(), EnginePortError> {
        Ok(())
    }

    fn observe(&mut self, _request: &PortRequest<'_>) -> Result<(), EnginePortError> {
        if self.observe_calls > 0 {
            return Ok(());
        }
        self.observe_calls = 1;
        // Push one text + one frame + one audio in a single tick so the
        // recorder can verify the runner drains text first, then frame,
        // then audio, regardless of the push order on the port side.
        // Deliberately push audio first to exercise the ordering invariant.
        self.audio
            .emit_event(synthetic_audio("audio-1"))
            .expect("audio emit");
        self.frame
            .emit_frame(synthetic_frame("frame-1"))
            .expect("frame emit");
        self.text
            .emit_line(synthetic_text_line("text-1"))
            .expect("text emit");
        Ok(())
    }

    fn sink_set(&self) -> &SinkSet {
        &self.sink_set
    }

    fn capture(&mut self, _request: &PortRequest<'_>) -> Result<CaptureOutcome, EnginePortError> {
        Ok(CaptureOutcome::new(
            "artifacts/utsushi/runtime/order/conformance-reports/x.json",
        ))
    }

    fn shutdown(&mut self) -> Result<PortShutdownOutcome, EnginePortError> {
        if self.shut_down {
            Ok(PortShutdownOutcome::already_shut_down())
        } else {
            self.shut_down = true;
            Ok(PortShutdownOutcome::clean())
        }
    }
}

// ===================================================================
// Helpers
// ===================================================================

fn build_artifact_root() -> (TempDir, RuntimeArtifactRoot) {
    let dir = TempDir::new().expect("tempdir");
    let root = RuntimeArtifactRoot::new(dir.path().to_path_buf());
    root.prepare().expect("prepare artifact root");
    (dir, root)
}

fn build_fixture(
    artifact_root: RuntimeArtifactRoot,
    input_root: PathBuf,
) -> conformance::ConformanceFixture {
    conformance::ConformanceFixture {
        input_root,
        artifact_root,
        env: PortEnv::new(),
        run_id: "synthetic-run".to_string(),
    }
}

// ===================================================================
// Positive port behaviors
// ===================================================================

#[test]
fn synthetic_port_passes_required_abi_conformance() {
    let (_input_dir, input_root) = build_input_root();
    let (_root_dir, artifact_root) = build_artifact_root();
    let fixture = build_fixture(artifact_root, input_root);

    let report = conformance::run_required_abi(ReferencePort::new, &fixture)
        .expect("reference port passes conformance");

    assert!(report.launched);
    assert_eq!(report.observation_count, 1);
    assert!(report.captured);
    assert!(report.first_shutdown_clean);
    assert!(report.second_shutdown_idempotent);
    assert_eq!(report.jump_outcome, conformance::JumpOutcome::NotDeclared);
    assert!(report.cancellation_observed);
    assert_eq!(report.manifest_id, "utsushi-synthetic-ref");
}

#[test]
fn synthetic_port_launch_observes_cancellation_token() {
    let (_input_dir, input_root) = build_input_root();
    let runner = Runner::new();
    let cancel = RunnerCancellation::new();
    cancel.cancel();

    let mut port = ReferencePort::new();
    let request = PortRequest::new(&input_root, "cancel-run", RuntimeOperation::Trace)
        .with_cancellation(cancel);

    let error = runner
        .run_trace(&mut port, &request)
        .expect_err("cancelled launch must fail");
    match error {
        EnginePortError::Cancelled { stage } => assert_eq!(stage, LifecycleStage::Launch),
        other => panic!("expected Cancelled(Launch), got {other:?}"),
    }
}

#[test]
fn synthetic_port_capture_writes_into_managed_artifact_root() {
    let (_input_dir, input_root) = build_input_root();
    let (_root_dir, artifact_root) = build_artifact_root();
    let runner = Runner::new();
    let mut port = ReferencePort::new();
    let request = PortRequest::new(&input_root, "capture-run", RuntimeOperation::Capture)
        .with_artifact_root(&artifact_root);

    let outcome = runner
        .run_capture(&mut port, &request)
        .expect("capture run succeeds");

    let capture = outcome.capture.expect("capture outcome present");
    let resolved = artifact_root
        .artifact_path(&capture.artifact_uri)
        .expect("artifact uri resolves under managed root");
    assert!(resolved.starts_with(artifact_root.path()));
    assert!(resolved.exists(), "artifact path must exist: {resolved:?}");
}

#[test]
fn synthetic_port_shutdown_is_idempotent() {
    let mut port = ReferencePort::new();
    let first = port.shutdown().expect("first shutdown ok");
    let second = port.shutdown().expect("second shutdown ok");
    assert_eq!(first.status, PortShutdownStatus::Clean);
    assert_eq!(second.status, PortShutdownStatus::AlreadyShutDown);
}

#[test]
fn synthetic_port_jump_returns_capability_unsupported_when_not_declared() {
    let (_input_dir, input_root) = build_input_root();
    let runner = Runner::new();
    let mut port = ReferencePort::new();
    let request = PortRequest::new(&input_root, "jump-run", RuntimeOperation::Trace);

    let error = runner
        .run_jump(&mut port, &request, &MomentId::synthetic())
        .expect_err("undeclared jump must fail");
    match error {
        EnginePortError::CapabilityUnsupported { capability, reason } => {
            assert_eq!(capability, PortCapability::Jump);
            // The runner-level rejection uses NotYetSupported because
            // the capability is missing from the manifest entirely.
            assert!(matches!(
                reason,
                CapabilityReason::NotYetSupported | CapabilityReason::DefaultUnimplemented,
            ));
        }
        other => panic!("expected CapabilityUnsupported, got {other:?}"),
    }
}

// ===================================================================
// Tick ordering invariant (UTSUSHI-224)
// ===================================================================

#[test]
fn runner_tick_drains_sinks_in_text_then_frame_then_audio_order() {
    let (_input_dir, input_root) = build_input_root();
    let runner = Runner::new();
    let mut port = OrderingProbePort::new();
    let recorder = port.recorder();
    let request = PortRequest::new(&input_root, "order-run", RuntimeOperation::Trace);

    let observation = runner.tick(&mut port, &request).expect("tick succeeds");
    assert_eq!(observation.text.len(), 1);
    assert_eq!(observation.frames.len(), 1);
    assert_eq!(observation.audio.len(), 1);

    let samples = recorder.snapshot();
    assert_eq!(
        samples,
        vec![
            DrainSample::Text("text-1".to_string()),
            DrainSample::Frame("frame-1".to_string()),
            DrainSample::Audio("audio-1".to_string()),
        ],
        "Runner::tick must drain in text -> frame -> audio order; got: {samples:?}"
    );
}

// ===================================================================
// Missing-method / drift
// ===================================================================

#[test]
fn port_with_unimplemented_observe_fails_conformance_with_drift_diagnostic() {
    let (_input_dir, input_root) = build_input_root();
    let (_root_dir, artifact_root) = build_artifact_root();
    let fixture = build_fixture(artifact_root, input_root);

    let outcome = conformance::run_required_abi(MissingObservePort::new, &fixture);
    let error = outcome.expect_err("missing-observe port must fail conformance");
    match error {
        EnginePortError::CapabilityUnsupported { capability, .. } => {
            assert_eq!(capability, PortCapability::Observe);
        }
        other => panic!("expected CapabilityUnsupported(Observe), got {other:?}"),
    }
}

#[test]
fn port_overriding_jump_without_declaring_capability_fails_drift_check() {
    let (_input_dir, input_root) = build_input_root();
    let (_root_dir, artifact_root) = build_artifact_root();
    let fixture = build_fixture(artifact_root, input_root);

    let outcome = conformance::run_required_abi(JumpUndeclaredPort::new, &fixture);
    let error = outcome.expect_err("undeclared jump impl must trip drift check");
    match error {
        EnginePortError::ManifestCapabilityDrift { capability, kind } => {
            assert_eq!(capability, PortCapability::Jump);
            assert_eq!(kind, DriftKind::UnclaimedImplementation);
        }
        other => panic!("expected ManifestCapabilityDrift, got {other:?}"),
    }
}

#[test]
fn port_declaring_jump_capability_runs_jump_against_synthetic_moment() {
    let (_input_dir, input_root) = build_input_root();
    let (_root_dir, artifact_root) = build_artifact_root();
    let fixture = build_fixture(artifact_root, input_root);

    let report = conformance::run_required_abi(JumpCapablePort::new, &fixture)
        .expect("jump-capable port passes conformance");
    assert_eq!(report.jump_outcome, conformance::JumpOutcome::Honoured);
}

// ===================================================================
// Version mismatch
// ===================================================================

#[test]
fn port_with_unsupported_abi_version_fails_runner_validate_manifest() {
    let runner = Runner::new();
    let error = runner
        .validate_manifest(&UNSUPPORTED_ABI_MANIFEST)
        .expect_err("abi 99 must be rejected");
    match error {
        EnginePortError::AbiVersionUnsupported {
            declared,
            supported,
        } => {
            assert_eq!(declared, 99);
            assert_eq!(supported, Runner::SUPPORTED_ABI_VERSIONS);
        }
        other => panic!("expected AbiVersionUnsupported, got {other:?}"),
    }
}

// ===================================================================
// Env-leak rejection
// ===================================================================

#[test]
fn port_with_path_shape_env_schema_fails_manifest_validate() {
    let error = ENV_PATH_FORBIDDEN_MANIFEST
        .validate()
        .expect_err("forbidden env shape must reject");
    match error {
        EnginePortError::EnvSchemaForbidsPath { key, shape } => {
            assert_eq!(key, "UTSUSHI_PORT_DIR");
            assert_eq!(shape, EnvFieldShape::Path);
        }
        other => panic!("expected EnvSchemaForbidsPath, got {other:?}"),
    }
}

#[test]
fn port_with_runtime_env_value_matching_local_path_filter_fails_launch() {
    let (_input_dir, input_root) = build_input_root();
    let (_root_dir, artifact_root) = build_artifact_root();
    let runner = Runner::new();
    let mut env = PortEnv::new();
    env.insert("UTSUSHI_RUN_TOKEN", "/home/operator/private/leak");

    let mut port = UnredactedEnvRuntimePort::new();
    let request = PortRequest::new(&input_root, "env-leak", RuntimeOperation::Trace)
        .with_artifact_root(&artifact_root)
        .with_env(env);

    let error = runner
        .run_trace(&mut port, &request)
        .expect_err("leaky env value must reject");
    match error {
        EnginePortError::EnvUnredacted { key, rule } => {
            assert_eq!(key, "UTSUSHI_RUN_TOKEN");
            assert_eq!(rule, "looks_like_local_path");
        }
        other => panic!("expected EnvUnredacted, got {other:?}"),
    }
}

#[test]
fn engine_port_error_for_unredacted_env_path_does_not_include_path_in_display() {
    let leak_path = "/home/operator/private/leak";
    let error = EnginePortError::EnvUnredacted {
        key: "UTSUSHI_RUN_TOKEN",
        rule: "looks_like_local_path",
    };
    let rendered = format!("{error}");
    assert!(
        !rendered.contains(leak_path),
        "rendered error must not include the leaked path: {rendered}"
    );
    assert!(
        !utsushi_core::looks_like_local_path(&rendered),
        "rendered diagnostic must not look like a local path: {rendered}"
    );
}

#[test]
fn runtime_request_debug_does_not_leak_cancellation_or_replay_log() {
    let input_root = Path::new("/tmp-source-only-name-no-real-traversal");
    let cancellation = RunnerCancellation::new();
    let request = RuntimeRequest::new(input_root).with_cancellation(cancellation);
    let rendered = format!("{request:?}");
    assert!(rendered.contains("RuntimeRequest"));
    assert!(rendered.contains("cancellation"));
    // Debug must NOT print the inner Arc pointer or any state derived
    // from it; it must show the static label only.
    assert!(rendered.contains("RunnerCancellation"));
    assert!(!rendered.contains("Arc { strong:"));
}

// ===================================================================
// EnginePortAdapter bridge to legacy RuntimeAdapter
// ===================================================================

#[test]
fn engine_port_adapter_descriptor_reflects_manifest_id_and_version() {
    let adapter = EnginePortAdapter::new(ReferencePort::new()).expect("adapter builds");
    let descriptor: RuntimeAdapterDescriptor = adapter.descriptor();
    assert_eq!(descriptor.name, "utsushi-synthetic-ref");
    assert_eq!(descriptor.version, "0.0.0");
    assert_eq!(descriptor.fidelity_tier, FidelityTier::LayoutProbe);
    assert_eq!(descriptor.evidence_tier_ceiling, EvidenceTier::E2);
    assert!(
        descriptor
            .limitations
            .iter()
            .any(|line| line.contains("Synthetic test-only port"))
    );
}

#[test]
fn engine_port_adapter_trace_runs_lifecycle_and_returns_sink_shaped_observations() {
    let (_input_dir, input_root) = build_input_root();
    let adapter = EnginePortAdapter::new(ReferencePort::new()).expect("adapter builds");
    let request = RuntimeRequest::new(&input_root);
    let value: Value = adapter.trace(&request).expect("trace via adapter");
    assert_eq!(value["adapterName"], "utsushi-synthetic-ref");
    assert_eq!(value["adapterVersion"], "0.0.0");
    assert_eq!(value["schemaVersion"], "0.2.0");
    assert_eq!(value["operation"], "trace");
    // UTSUSHI-224: the adapter's wire shape is now `sinkObservations` —
    // a sink-shaped array — rather than the deleted hook envelope. At
    // least the text emission the reference port pushes during observe
    // must surface here.
    let observations = value["sinkObservations"]
        .as_array()
        .expect("sinkObservations array");
    assert!(
        observations
            .iter()
            .any(|entry| entry["sink"] == "text_surface")
    );
    assert_eq!(value["shutdownStatus"], "clean");
}

// ===================================================================
// Fixture-style helpers reused across tests
// ===================================================================

fn build_input_root() -> (TempDir, PathBuf) {
    let dir = TempDir::new().expect("tempdir");
    // Empty input root suffices for the synthetic ports; they do not
    // read from disk.
    let path = dir.path().to_path_buf();
    (dir, path)
}

// Silence "imported but unused" for items only referenced via type
// inference in helpers above when feature flags strip a test path.
#[allow(dead_code)]
fn _force_arc_mutex_in_scope(value: Arc<Mutex<u8>>) -> Arc<Mutex<u8>> {
    value
}
