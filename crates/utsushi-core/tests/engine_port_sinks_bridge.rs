//! Substrate-side smoke test for the UTSUSHI-224 sinks-bridge path on
//! the `EnginePort` trait. Mirrors the per-tick ordering invariant doc
//! comment on [`utsushi_core::Runner::tick`] and asserts that a port can
//! drive the sink set without going through the deleted
//! observation-hook envelope.
//!
//! This is the substrate-side, in-crate smoke (a labelled `SmokePort`,
//! not an engine). The REAL-bytes producer proof — a real RealLive port
//! driving all three sinks from decoded Sweetie HD / Kanon bytes — lives
//! in `utsushi-reallive`'s `tests/engine_port_real_bytes.rs`.

use std::sync::{Arc, Mutex};

use utsushi_core::{
    AudioEvent, AudioEventKind, AudioEventSink, CaptureOutcome, EnginePort, EnginePortError,
    EvidenceTier, FidelityTier, FrameArtifact, FrameArtifactSink, LifecycleStage,
    ObservationArtifactRef, PortCapability, PortManifest, PortRequest, PortShutdownOutcome,
    REQUIRED_LIFECYCLE_STAGES, RUNTIME_ARTIFACT_URI_ROOT, Runner, RuntimeOperation, SinkCapability,
    SinkResult, SinkSet, TextLine, TextSurfaceSink,
};

struct VecTextSink(Mutex<Vec<TextLine>>);
impl TextSurfaceSink for VecTextSink {
    fn capability(&self) -> SinkCapability {
        SinkCapability::Supported {
            evidence_tier_ceiling: EvidenceTier::E1,
        }
    }
    fn emit_line(&self, line: TextLine) -> SinkResult<()> {
        line.validate()?;
        self.0.lock().unwrap().push(line);
        Ok(())
    }
    fn drain_lines(&self) -> Vec<TextLine> {
        std::mem::take(&mut *self.0.lock().unwrap())
    }
}

struct VecFrameSink(Mutex<Vec<FrameArtifact>>);
impl FrameArtifactSink for VecFrameSink {
    fn capability(&self) -> SinkCapability {
        SinkCapability::Supported {
            evidence_tier_ceiling: EvidenceTier::E2,
        }
    }
    fn emit_frame(&self, frame: FrameArtifact) -> SinkResult<()> {
        frame.validate()?;
        self.0.lock().unwrap().push(frame);
        Ok(())
    }
    fn drain_frames(&self) -> Vec<FrameArtifact> {
        std::mem::take(&mut *self.0.lock().unwrap())
    }
}

struct VecAudioSink(Mutex<Vec<AudioEvent>>);
impl AudioEventSink for VecAudioSink {
    fn capability(&self) -> SinkCapability {
        SinkCapability::Supported {
            evidence_tier_ceiling: EvidenceTier::E0,
        }
    }
    fn emit_event(&self, event: AudioEvent) -> SinkResult<()> {
        event.validate()?;
        self.0.lock().unwrap().push(event);
        Ok(())
    }
    fn drain_events(&self) -> Vec<AudioEvent> {
        std::mem::take(&mut *self.0.lock().unwrap())
    }
}

struct SmokePort {
    text: Arc<VecTextSink>,
    frame: Arc<VecFrameSink>,
    audio: Arc<VecAudioSink>,
    sink_set: SinkSet,
    ticks: usize,
    shut_down: bool,
}

impl SmokePort {
    const MANIFEST: PortManifest = PortManifest {
        id: "utsushi-bridge-smoke",
        name: "Utsushi Sinks Bridge Smoke Port",
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
        let text = Arc::new(VecTextSink(Mutex::new(Vec::new())));
        let frame = Arc::new(VecFrameSink(Mutex::new(Vec::new())));
        let audio = Arc::new(VecAudioSink(Mutex::new(Vec::new())));
        let sink_set = SinkSet::new()
            .with_text(text.clone() as Arc<dyn TextSurfaceSink>)
            .with_frame(frame.clone() as Arc<dyn FrameArtifactSink>)
            .with_audio(audio.clone() as Arc<dyn AudioEventSink>);
        Self {
            text,
            frame,
            audio,
            sink_set,
            ticks: 0,
            shut_down: false,
        }
    }
}

impl EnginePort for SmokePort {
    const MANIFEST: PortManifest = Self::MANIFEST;

    fn launch(&mut self, request: &PortRequest<'_>) -> Result<(), EnginePortError> {
        request.cancellation.check(LifecycleStage::Launch)?;
        Ok(())
    }

    fn observe(&mut self, _request: &PortRequest<'_>) -> Result<(), EnginePortError> {
        if self.ticks >= 3 {
            return Ok(());
        }
        let tick = self.ticks;
        self.ticks += 1;
        let line_id = format!("smoke-text-{tick:02}");
        self.text
            .emit_line(TextLine {
                line_id,
                evidence_tier: EvidenceTier::E1,
                text: format!("smoke line {tick}"),
                speaker: None,
                text_surface: None,
                bridge_ref: None,
                source_asset: None,
            })
            .expect("text emit");
        let artifact_id = format!("smoke-shot-{tick:02}");
        let uri =
            format!("{RUNTIME_ARTIFACT_URI_ROOT}/smoke-run-0001/screenshots/{artifact_id}.png");
        self.frame
            .emit_frame(FrameArtifact {
                frame_id: artifact_id.clone(),
                evidence_tier: EvidenceTier::E2,
                artifact_ref: ObservationArtifactRef {
                    artifact_id,
                    artifact_kind: "screenshot".to_string(),
                    uri,
                    media_type: Some("image/png".to_string()),
                },
                width: Some(320),
                height: Some(180),
                frame_index: tick as u64 + 1,
                bridge_ref: None,
            })
            .expect("frame emit");
        self.audio
            .emit_event(AudioEvent {
                event_id: format!("smoke-audio-{tick:02}"),
                evidence_tier: EvidenceTier::E0,
                event_kind: AudioEventKind::Marker,
                cue_id: None,
                source_asset: None,
                bridge_ref: None,
                frame_index: Some(tick as u64 + 1),
            })
            .expect("audio emit");
        Ok(())
    }

    fn sink_set(&self) -> &SinkSet {
        &self.sink_set
    }

    fn capture(&mut self, _request: &PortRequest<'_>) -> Result<CaptureOutcome, EnginePortError> {
        Ok(CaptureOutcome::new(
            "artifacts/utsushi/runtime/smoke/conformance-reports/x.json",
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

#[test]
fn engine_port_sinks_bridge_observe_does_not_return_event() {
    // Compile-time + runtime check: the new signature is `-> Result<()>`.
    let mut port = SmokePort::new();
    let tmp = tempfile::TempDir::new().expect("tempdir");
    let request = PortRequest::new(tmp.path(), "smoke", RuntimeOperation::Trace);
    let result: Result<(), EnginePortError> = port.observe(&request);
    result.expect("smoke observe succeeds");
}

#[test]
fn engine_port_sinks_bridge_runner_tick_drains_all_three_sinks_per_call() {
    let mut port = SmokePort::new();
    let tmp = tempfile::TempDir::new().expect("tempdir");
    let request = PortRequest::new(tmp.path(), "smoke", RuntimeOperation::Trace);
    let runner = Runner::new();

    let observation = runner.tick(&mut port, &request).expect("first tick");
    assert_eq!(observation.text.len(), 1, "tick must drain queued text");
    assert_eq!(observation.frames.len(), 1, "tick must drain queued frames");
    assert_eq!(observation.audio.len(), 1, "tick must drain queued audio");
    assert_eq!(observation.total(), 3);
    assert!(!observation.is_empty());
}

#[test]
fn engine_port_sinks_bridge_runner_run_trace_collects_three_ticks_then_terminates() {
    let mut port = SmokePort::new();
    let tmp = tempfile::TempDir::new().expect("tempdir");
    let request = PortRequest::new(tmp.path(), "smoke", RuntimeOperation::Trace);
    let runner = Runner::new();

    let outcome = runner
        .run_trace(&mut port, &request)
        .expect("run_trace succeeds");
    // SmokePort emits for three ticks; the fourth tick is empty and
    // signals end-of-stream to the runner.
    assert_eq!(outcome.observations.len(), 3);
    for tick in &outcome.observations {
        assert_eq!(tick.text.len(), 1);
        assert_eq!(tick.frames.len(), 1);
        assert_eq!(tick.audio.len(), 1);
    }
}

#[test]
fn engine_port_sinks_bridge_sink_set_accessor_is_a_shared_reference() {
    let port = SmokePort::new();
    // The accessor must return a `&SinkSet` so the runner can drive it
    // without taking the port by mut reference. The Default impl on
    // `SinkSet` carries `Unsupported` for every kind; the smoke port's
    // accessor instead surfaces the registered text/frame/audio sinks.
    let summary = port.sink_set().capabilities();
    assert!(matches!(summary.text, SinkCapability::Supported { .. }));
    assert!(matches!(summary.frame, SinkCapability::Supported { .. }));
    assert!(matches!(summary.audio, SinkCapability::Supported { .. }));
}
