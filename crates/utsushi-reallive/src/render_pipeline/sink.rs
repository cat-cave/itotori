//! The supported recording [`FrameArtifactSink`], moved verbatim out of
//! the render-pipeline root module.

use utsushi_core::substrate::{EvidenceTier, FrameArtifact, FrameArtifactSink};

/// A concrete supported [`FrameArtifactSink`] that validates every
/// announced [`FrameArtifact`] against the substrate contract (E2
/// floor, managed-URI shape, artifact-kind allow-list) and collects the
/// accepted frames. Used by the render-validate CLI surface and the
/// redaction tests.
#[derive(Debug, Default)]
pub struct RecordingFrameArtifactSink {
    frames: std::sync::Mutex<Vec<FrameArtifact>>,
}

impl RecordingFrameArtifactSink {
    pub fn new() -> Self {
        Self::default()
    }

    /// The accepted (validated, E2+) frames in announcement order.
    pub fn frames(&self) -> Vec<FrameArtifact> {
        self.frames.lock().expect("frame sink lock").clone()
    }

    pub fn len(&self) -> usize {
        self.frames.lock().expect("frame sink lock").len()
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }
}

impl FrameArtifactSink for RecordingFrameArtifactSink {
    fn capability(&self) -> utsushi_core::substrate::SinkCapability {
        utsushi_core::substrate::SinkCapability::Supported {
            evidence_tier_ceiling: EvidenceTier::E2,
        }
    }

    fn emit_frame(&self, artifact: FrameArtifact) -> utsushi_core::substrate::SinkResult<()> {
        artifact.validate()?;
        self.frames.lock().expect("frame sink lock").push(artifact);
        Ok(())
    }
}
