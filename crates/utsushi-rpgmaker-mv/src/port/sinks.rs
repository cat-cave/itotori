//! Observation sink adapters owned by the RPG Maker MV/MZ port.

use std::sync::{Arc, Mutex};

use utsushi_core::substrate::{
    AudioEvent, AudioEventSink, EvidenceTier, FrameArtifact, FrameArtifactSink, SinkCapability,
    SinkError, SinkKind, SinkResult, SinkSet, TextLine, TextSurfaceSink,
};

use super::PORT_ID;

/// Collector text sink. The port pushes one [`TextLine`] per `observe`
/// tick; the runner drains via [`TextSurfaceSink::drain_lines`].
pub struct RpgmakerMvTextSink {
    buffer: Mutex<Vec<TextLine>>,
}

impl RpgmakerMvTextSink {
    pub fn new() -> Self {
        Self {
            buffer: Mutex::new(Vec::new()),
        }
    }
}

impl Default for RpgmakerMvTextSink {
    fn default() -> Self {
        Self::new()
    }
}

impl TextSurfaceSink for RpgmakerMvTextSink {
    fn capability(&self) -> SinkCapability {
        SinkCapability::Supported {
            evidence_tier_ceiling: EvidenceTier::E1,
        }
    }

    fn emit_line(&self, line: TextLine) -> SinkResult<()> {
        line.validate()?;
        self.buffer.lock().expect("text sink lock").push(line);
        Ok(())
    }

    fn drain_lines(&self) -> Vec<TextLine> {
        std::mem::take(&mut *self.buffer.lock().expect("text sink lock"))
    }
}

/// Explicitly-unsupported frame sink. The MV/MZ runtime renders to a JS
/// DOM/canvas; this port observes the text stream only and does not
/// rasterise frames. Declaring the sink `Unsupported` is the audit-correct
/// posture for "this port has no frame evidence to announce" (vs silently
/// omitting the sink).
struct RpgmakerMvFrameSink;

impl FrameArtifactSink for RpgmakerMvFrameSink {
    fn capability(&self) -> SinkCapability {
        SinkCapability::Unsupported
    }

    fn emit_frame(&self, _frame: FrameArtifact) -> SinkResult<()> {
        Err(SinkError::UnsupportedKind {
            sink: SinkKind::FrameArtifact,
            adapter_id: PORT_ID.to_string(),
            reason: "utsushi-rpgmaker-mv observes the text stream only; frame rasterisation is a deferred surface".to_string(),
        })
    }
}

/// Explicitly-unsupported audio sink — the static event-stream walk
/// announces no audio evidence.
struct RpgmakerMvAudioSink;

impl AudioEventSink for RpgmakerMvAudioSink {
    fn capability(&self) -> SinkCapability {
        SinkCapability::Unsupported
    }

    fn emit_event(&self, _audio: AudioEvent) -> SinkResult<()> {
        Err(SinkError::UnsupportedKind {
            sink: SinkKind::AudioEvent,
            adapter_id: PORT_ID.to_string(),
            reason: "utsushi-rpgmaker-mv has no audio evidence to announce".to_string(),
        })
    }
}

/// Sink bundle owned by [`super::UtsushiRpgmakerMvPort`].
pub struct RpgmakerMvObservationSinks {
    pub(super) text: Arc<RpgmakerMvTextSink>,
    sink_set: SinkSet,
}

impl RpgmakerMvObservationSinks {
    pub fn new() -> Self {
        let text = Arc::new(RpgmakerMvTextSink::new());
        let sink_set = SinkSet::new()
            .with_text(text.clone() as Arc<dyn TextSurfaceSink>)
            .with_frame(Arc::new(RpgmakerMvFrameSink) as Arc<dyn FrameArtifactSink>)
            .with_audio(Arc::new(RpgmakerMvAudioSink) as Arc<dyn AudioEventSink>);
        Self { text, sink_set }
    }

    pub fn sink_set(&self) -> &SinkSet {
        &self.sink_set
    }
}

impl Default for RpgmakerMvObservationSinks {
    fn default() -> Self {
        Self::new()
    }
}
