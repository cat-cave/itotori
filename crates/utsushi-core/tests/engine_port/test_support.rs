use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use tempfile::TempDir;

use utsushi_core::{
    AudioEvent, AudioEventKind, AudioEventSink, CaptureOutcome, EnginePort, EnginePortError,
    EvidenceTier, FidelityTier, FrameArtifact, FrameArtifactSink, LifecycleStage, MomentId,
    ObservationArtifactRef, PortCapability, PortEnv, PortManifest, PortRequest,
    PortShutdownOutcome, REQUIRED_LIFECYCLE_STAGES, RUNTIME_ARTIFACT_URI_ROOT, RuntimeArtifactKind,
    RuntimeArtifactRoot, SinkCapability, SinkResult, SinkSet, TextLine, TextSurfaceSink,
    port::conformance,
};

#[path = "test_support/negative_ports.rs"]
mod negative_ports;
#[path = "test_support/ordering.rs"]
mod ordering;

pub(crate) use negative_ports::{
    ENV_PATH_FORBIDDEN_MANIFEST, MissingObservePort, NonIdempotentShutdownPort,
    UNSUPPORTED_ABI_MANIFEST, UnredactedEnvRuntimePort,
};
pub(crate) use ordering::{DrainSample, OrderingProbePort};

// Helper sinks shared by the synthetic ports

pub(super) struct CollectingTextSink {
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

pub(super) struct CollectingFrameSink {
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

pub(super) struct CollectingAudioSink {
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

pub(super) fn synthetic_text_line(line_id: &str) -> TextLine {
    TextLine {
        line_id: line_id.to_string(),
        evidence_tier: EvidenceTier::E1,
        text: "synthetic text observation".to_string(),
        speaker: None,
        color: None,
        text_surface: None,
        bridge_ref: None,
        source_asset: None,
        byte_offset_in_scene: None,
        body_shift_jis: None,
    }
}

pub(super) fn synthetic_frame(frame_id: &str) -> FrameArtifact {
    let run_id = "synthetic-run-0001";
    let uri = format!("{RUNTIME_ARTIFACT_URI_ROOT}/{run_id}/screenshots/{frame_id}.png");
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

pub(super) fn synthetic_audio(event_id: &str) -> AudioEvent {
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

pub(super) fn build_default_sink_set() -> (
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

// Synthetic ports

/// Reference port: implements every required stage and pushes one text
/// observation per launch into its sink set.
pub(crate) struct ReferencePort {
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

    pub(crate) fn new() -> Self {
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
            RuntimeArtifactKind::Screenshot,
            "0190a000-0000-7000-8000-000000000201",
        )
        .map_err(|error| EnginePortError::Lifecycle {
            stage: LifecycleStage::Capture,
            message: format!("artifact uri build failed: {error}"),
            source: None,
        })?;
        let path = root
            .write_bytes(&uri, b"\x89PNG\r\n\x1a\nsynthetic reference capture\n")
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
pub(crate) struct JumpCapablePort(ReferencePort);

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

    pub(crate) fn new() -> Self {
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
pub(crate) struct JumpUndeclaredPort(ReferencePort);

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

    pub(crate) fn new() -> Self {
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

// Helpers

pub(crate) fn build_artifact_root() -> (TempDir, RuntimeArtifactRoot) {
    let dir = TempDir::new().expect("tempdir");
    let root = RuntimeArtifactRoot::new(dir.path().to_path_buf());
    root.prepare().expect("prepare artifact root");
    (dir, root)
}

pub(crate) fn build_fixture(
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

// Fixture-style helpers reused across tests

pub(crate) fn build_input_root() -> (TempDir, PathBuf) {
    let dir = TempDir::new().expect("tempdir");
    // Empty input root suffices for the synthetic ports; they do not
    // read from disk.
    let path = dir.path().to_path_buf();
    (dir, path)
}

// Silence "imported but unused" for items only referenced via type
// inference in helpers above when feature flags strip a test path.
// reason: compile-time witness that keeps Arc<Mutex<_>> referenced when feature flags strip its only use.
#[allow(dead_code)]
fn _force_arc_mutex_in_scope(value: Arc<Mutex<u8>>) -> Arc<Mutex<u8>> {
    value
}
