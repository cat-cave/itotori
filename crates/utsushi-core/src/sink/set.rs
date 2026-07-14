//! Holder for the three sinks. Carried as a single optional field on
//! [`crate::RuntimeRequest`] so the request struct stays additive.

use std::sync::Arc;

use serde::{Deserialize, Serialize};

use super::audio::AudioEventSink;
use super::frame::FrameArtifactSink;
use super::text::TextSurfaceSink;
use super::{SinkCapability, SinkKind};

/// Container for the three runtime sink trait objects. Cheap to clone (each
/// sink is an `Arc<dyn...>` slot).
#[derive(Clone, Default)]
pub struct SinkSet {
    text: Option<Arc<dyn TextSurfaceSink>>,
    frame: Option<Arc<dyn FrameArtifactSink>>,
    audio: Option<Arc<dyn AudioEventSink>>,
}

impl SinkSet {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn with_text(mut self, sink: Arc<dyn TextSurfaceSink>) -> Self {
        self.text = Some(sink);
        self
    }

    pub fn with_frame(mut self, sink: Arc<dyn FrameArtifactSink>) -> Self {
        self.frame = Some(sink);
        self
    }

    pub fn with_audio(mut self, sink: Arc<dyn AudioEventSink>) -> Self {
        self.audio = Some(sink);
        self
    }

    pub fn text(&self) -> Option<&dyn TextSurfaceSink> {
        self.text.as_deref()
    }

    pub fn frame(&self) -> Option<&dyn FrameArtifactSink> {
        self.frame.as_deref()
    }

    pub fn audio(&self) -> Option<&dyn AudioEventSink> {
        self.audio.as_deref()
    }

    /// Drain queued text emissions. Returns an empty `Vec` when no text sink is
    /// registered.
    pub fn drain_text(&self) -> Vec<super::text::TextLine> {
        self.text
            .as_deref()
            .map(TextSurfaceSink::drain_lines)
            .unwrap_or_default()
    }

    /// Drain queued frame emissions. Returns an empty `Vec` when no frame sink
    /// is registered.
    pub fn drain_frame(&self) -> Vec<super::frame::FrameArtifact> {
        self.frame
            .as_deref()
            .map(FrameArtifactSink::drain_frames)
            .unwrap_or_default()
    }

    /// Drain queued audio emissions. Returns an empty `Vec` when no audio sink
    /// is registered.
    pub fn drain_audio(&self) -> Vec<super::audio::AudioEvent> {
        self.audio
            .as_deref()
            .map(AudioEventSink::drain_events)
            .unwrap_or_default()
    }

    /// Capability summary suitable for descriptor / conformance introspection.
    pub fn capabilities(&self) -> SinkCapabilitySummary {
        SinkCapabilitySummary {
            text: self.text.as_deref().map_or(
                SinkCapability::Unsupported,
                super::text::TextSurfaceSink::capability,
            ),
            frame: self.frame.as_deref().map_or(
                SinkCapability::Unsupported,
                super::frame::FrameArtifactSink::capability,
            ),
            audio: self.audio.as_deref().map_or(
                SinkCapability::Unsupported,
                super::audio::AudioEventSink::capability,
            ),
        }
    }
}

impl std::fmt::Debug for SinkSet {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("SinkSet")
            .field("text", &marker(&self.text))
            .field("frame", &marker(&self.frame))
            .field("audio", &marker(&self.audio))
            .finish()
    }
}

fn marker<T: ?Sized>(slot: &Option<Arc<T>>) -> &'static str {
    if slot.is_some() {
        "<present>"
    } else {
        "<absent>"
    }
}

/// Per-sink capability snapshot. The summary intentionally collapses an
/// absent sink (no `Arc<dyn...>` registered) and an explicitly-unsupported
/// sink (registered but reporting `SinkCapability::Unsupported`) into the
/// same `Unsupported` value — both must surface the same way to downstream
/// conformance.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SinkCapabilitySummary {
    pub text: SinkCapability,
    pub frame: SinkCapability,
    pub audio: SinkCapability,
}

impl SinkCapabilitySummary {
    /// Lookup by `SinkKind`.
    pub fn for_kind(&self, kind: SinkKind) -> SinkCapability {
        match kind {
            SinkKind::TextSurface => self.text,
            SinkKind::FrameArtifact => self.frame,
            SinkKind::AudioEvent => self.audio,
        }
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;

    use crate::EvidenceTier;

    use super::super::audio::{AudioEvent, AudioEventSink};
    use super::super::errors::{SinkError, SinkResult};
    use super::super::frame::{FrameArtifact, FrameArtifactSink};
    use super::super::text::{TextLine, TextSurfaceSink};
    use super::*;

    struct StubText {
        capability: SinkCapability,
        seen: Mutex<Vec<TextLine>>,
    }

    impl TextSurfaceSink for StubText {
        fn capability(&self) -> SinkCapability {
            self.capability
        }
        fn emit_line(&self, line: TextLine) -> SinkResult<()> {
            if matches!(self.capability, SinkCapability::Unsupported) {
                return Err(SinkError::UnsupportedKind {
                    sink: SinkKind::TextSurface,
                    adapter_id: "stub".to_string(),
                    reason: "unsupported".to_string(),
                });
            }
            line.validate()?;
            self.seen.lock().expect("lock").push(line);
            Ok(())
        }
    }

    struct StubFrame {
        capability: SinkCapability,
    }

    impl FrameArtifactSink for StubFrame {
        fn capability(&self) -> SinkCapability {
            self.capability
        }
        fn emit_frame(&self, _artifact: FrameArtifact) -> SinkResult<()> {
            Ok(())
        }
    }

    struct StubAudio {
        capability: SinkCapability,
    }

    impl AudioEventSink for StubAudio {
        fn capability(&self) -> SinkCapability {
            self.capability
        }
        fn emit_event(&self, _audio: AudioEvent) -> SinkResult<()> {
            Ok(())
        }
    }

    #[test]
    fn sink_set_capability_summary_reports_each_sink_kind() {
        let set = SinkSet::new()
            .with_text(Arc::new(StubText {
                capability: SinkCapability::Supported {
                    evidence_tier_ceiling: EvidenceTier::E1,
                },
                seen: Mutex::new(Vec::new()),
            }))
            .with_frame(Arc::new(StubFrame {
                capability: SinkCapability::Supported {
                    evidence_tier_ceiling: EvidenceTier::E2,
                },
            }))
            .with_audio(Arc::new(StubAudio {
                capability: SinkCapability::Supported {
                    evidence_tier_ceiling: EvidenceTier::E0,
                },
            }));
        let summary = set.capabilities();
        assert!(matches!(
            summary.for_kind(SinkKind::TextSurface),
            SinkCapability::Supported {
                evidence_tier_ceiling: EvidenceTier::E1
            }
        ));
        assert!(matches!(
            summary.for_kind(SinkKind::FrameArtifact),
            SinkCapability::Supported {
                evidence_tier_ceiling: EvidenceTier::E2
            }
        ));
        assert!(matches!(
            summary.for_kind(SinkKind::AudioEvent),
            SinkCapability::Supported {
                evidence_tier_ceiling: EvidenceTier::E0
            }
        ));
    }

    #[test]
    fn sink_set_capability_summary_distinguishes_supported_from_unsupported() {
        let set = SinkSet::new()
            .with_text(Arc::new(StubText {
                capability: SinkCapability::Unsupported,
                seen: Mutex::new(Vec::new()),
            }))
            .with_frame(Arc::new(StubFrame {
                capability: SinkCapability::Supported {
                    evidence_tier_ceiling: EvidenceTier::E2,
                },
            }));
        // text registered but Unsupported → collapses to Unsupported.
        let summary = set.capabilities();
        assert_eq!(summary.text, SinkCapability::Unsupported);
        // frame registered and supported.
        assert!(matches!(summary.frame, SinkCapability::Supported { .. }));
        // audio not registered at all → Unsupported.
        assert_eq!(summary.audio, SinkCapability::Unsupported);
    }

    #[test]
    fn sink_set_default_has_no_sinks_registered() {
        let set = SinkSet::default();
        assert!(set.text().is_none());
        assert!(set.frame().is_none());
        assert!(set.audio().is_none());
        let summary = set.capabilities();
        assert_eq!(summary.text, SinkCapability::Unsupported);
        assert_eq!(summary.frame, SinkCapability::Unsupported);
        assert_eq!(summary.audio, SinkCapability::Unsupported);
    }

    #[test]
    fn sink_set_debug_does_not_expose_implementor_type() {
        let set = SinkSet::new().with_text(Arc::new(StubText {
            capability: SinkCapability::Supported {
                evidence_tier_ceiling: EvidenceTier::E1,
            },
            seen: Mutex::new(Vec::new()),
        }));
        let rendered = format!("{set:?}");
        assert!(rendered.contains("SinkSet"));
        assert!(rendered.contains("<present>"));
        assert!(rendered.contains("<absent>"));
        assert!(
            !rendered.contains("StubText"),
            "Debug must not expose concrete implementor type: {rendered}"
        );
    }
}
