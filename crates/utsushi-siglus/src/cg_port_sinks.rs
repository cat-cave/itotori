//! Observation sinks exposed by the static Siglus engine port.

use std::sync::{Arc, Mutex};

use utsushi_core::substrate::{
    AudioEvent, AudioEventSink, EvidenceTier, FrameArtifact, FrameArtifactSink, SinkCapability,
    SinkError, SinkKind, SinkResult, SinkSet, TextLine, TextSurfaceSink,
};

const PORT_ID: &str = "utsushi-siglus";

/// Text collector owned by the static E1 observation port.
#[derive(Debug, Default)]
pub struct SiglusTextSink {
    buffer: Mutex<Vec<TextLine>>,
}

impl SiglusTextSink {
    fn new() -> Self {
        Self::default()
    }
}

impl TextSurfaceSink for SiglusTextSink {
    fn capability(&self) -> SinkCapability {
        SinkCapability::Supported {
            evidence_tier_ceiling: EvidenceTier::E1,
        }
    }

    fn emit_line(&self, line: TextLine) -> SinkResult<()> {
        line.validate()?;
        self.buffer
            .lock()
            .expect("Siglus text sink lock")
            .push(line);
        Ok(())
    }

    fn drain_lines(&self) -> Vec<TextLine> {
        std::mem::take(&mut *self.buffer.lock().expect("Siglus text sink lock"))
    }
}

/// Static observation has no frame evidence to announce.
#[derive(Debug)]
struct SiglusFrameSink;

impl FrameArtifactSink for SiglusFrameSink {
    fn capability(&self) -> SinkCapability {
        SinkCapability::Unsupported
    }

    fn emit_frame(&self, _frame: FrameArtifact) -> SinkResult<()> {
        Err(SinkError::UnsupportedKind {
            sink: SinkKind::FrameArtifact,
            adapter_id: PORT_ID.to_string(),
            reason: "utsushi-siglus static text observation emits no frame evidence".to_string(),
        })
    }
}

/// Static observation has no audio evidence to announce.
#[derive(Debug)]
struct SiglusAudioSink;

impl AudioEventSink for SiglusAudioSink {
    fn capability(&self) -> SinkCapability {
        SinkCapability::Unsupported
    }

    fn emit_event(&self, _audio: AudioEvent) -> SinkResult<()> {
        Err(SinkError::UnsupportedKind {
            sink: SinkKind::AudioEvent,
            adapter_id: PORT_ID.to_string(),
            reason: "utsushi-siglus static text observation emits no audio evidence".to_string(),
        })
    }
}

/// Sink bundle owned by [`crate::UtsushiSiglusPort`].
#[derive(Debug)]
pub struct SiglusObservationSinks {
    text: Arc<SiglusTextSink>,
    sink_set: SinkSet,
}

impl SiglusObservationSinks {
    pub(crate) fn new() -> Self {
        let text = Arc::new(SiglusTextSink::new());
        let sink_set = SinkSet::new()
            .with_text(text.clone() as Arc<dyn TextSurfaceSink>)
            .with_frame(Arc::new(SiglusFrameSink) as Arc<dyn FrameArtifactSink>)
            .with_audio(Arc::new(SiglusAudioSink) as Arc<dyn AudioEventSink>);
        Self { text, sink_set }
    }

    pub(crate) fn sink_set(&self) -> &SinkSet {
        &self.sink_set
    }

    pub(crate) fn text(&self) -> &Arc<SiglusTextSink> {
        &self.text
    }
}

impl Default for SiglusObservationSinks {
    fn default() -> Self {
        Self::new()
    }
}
