use std::sync::{Arc, Mutex};

use super::{synthetic_audio, synthetic_frame, synthetic_text_line};

use utsushi_core::{
    AudioEvent, AudioEventSink, CaptureOutcome, EnginePort, EnginePortError, EvidenceTier,
    FidelityTier, FrameArtifact, FrameArtifactSink, PortCapability, PortManifest, PortRequest,
    PortShutdownOutcome, REQUIRED_LIFECYCLE_STAGES, SinkCapability, SinkResult, SinkSet, TextLine,
    TextSurfaceSink,
};

/// Recording sink that timestamps every emission against a shared
/// counter so the runner's per-tick ordering invariant
/// (text → frame → audio) is observable from a single `Vec<Sample>`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum DrainSample {
    Text(String),
    Frame(String),
    Audio(String),
}

#[derive(Default)]
pub(crate) struct OrderingProbeRecorder {
    samples: Mutex<Vec<DrainSample>>,
}

impl OrderingProbeRecorder {
    fn new() -> Self {
        Self::default()
    }

    fn record(&self, sample: DrainSample) {
        self.samples.lock().expect("record lock").push(sample);
    }

    pub(crate) fn snapshot(&self) -> Vec<DrainSample> {
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

pub(crate) struct OrderingProbePort {
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

    pub(crate) fn new() -> Self {
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

    pub(crate) fn recorder(&self) -> Arc<OrderingProbeRecorder> {
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
        // recorder can verify the runner drains text first, then frame
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
