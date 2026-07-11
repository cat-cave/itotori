//! Sink adaptor that records every accepted text emission.
//!
//! [`RecordingTextSink`] wraps an inner [`TextSurfaceSink`] plus a shared
//! [`ReferenceRecorder`]. On every accepted emission the inner sink is
//! called first; only if the inner sink returns `Ok` does the recorder
//! observe the line. Rationale (test 10 in the plan): recording is
//! observation of accepted output. If the inner sink rejects, the line was
//! not emitted, and the recorder must not pretend it was.

use std::sync::Arc;

use crate::sink::{SinkCapability, SinkResult, TextLine, TextSurfaceSink};

use super::builder::ReferenceRecorder;

/// Text sink adaptor that records every successfully emitted line.
pub struct RecordingTextSink<S: TextSurfaceSink> {
    inner: S,
    recorder: Arc<dyn ReferenceRecorder>,
}

impl<S: TextSurfaceSink> RecordingTextSink<S> {
    /// Build a recording adaptor around an inner sink. The recorder is
    /// shared via `Arc` so the same recorder can observe text emissions and
    /// (in a future widening) other sink streams.
    pub fn new(inner: S, recorder: Arc<dyn ReferenceRecorder>) -> Self {
        Self { inner, recorder }
    }

    /// Borrow the inner sink (for test inspection).
    pub fn inner(&self) -> &S {
        &self.inner
    }
}

impl<S: TextSurfaceSink> TextSurfaceSink for RecordingTextSink<S> {
    fn capability(&self) -> SinkCapability {
        self.inner.capability()
    }

    fn emit_line(&self, line: TextLine) -> SinkResult<()> {
        // Forward first; only record on the success path. Recording is
        // observation of accepted output.
        self.inner.emit_line(line.clone())?;
        self.recorder.record_text_event(line);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;

    use crate::EvidenceTier;
    use crate::ObservationBridgeRef;
    use crate::sink::{SinkError, SinkKind, TextLine};
    use crate::vfs::AssetId;

    use super::super::builder::InMemoryReferenceRecorder;
    use super::super::trace::SourceTag;
    use super::*;

    struct CollectingTextSink {
        capability: SinkCapability,
        lines: Mutex<Vec<TextLine>>,
    }

    impl CollectingTextSink {
        fn supported() -> Self {
            Self {
                capability: SinkCapability::Supported {
                    evidence_tier_ceiling: EvidenceTier::E1,
                },
                lines: Mutex::new(Vec::new()),
            }
        }
    }

    impl TextSurfaceSink for CollectingTextSink {
        fn capability(&self) -> SinkCapability {
            self.capability
        }

        fn emit_line(&self, line: TextLine) -> SinkResult<()> {
            self.lines.lock().expect("lock").push(line);
            Ok(())
        }
    }

    struct RejectingTextSink;

    impl TextSurfaceSink for RejectingTextSink {
        fn capability(&self) -> SinkCapability {
            SinkCapability::Unsupported
        }

        fn emit_line(&self, _line: TextLine) -> SinkResult<()> {
            Err(SinkError::UnsupportedKind {
                sink: SinkKind::TextSurface,
                adapter_id: "rejecting-sink".to_string(),
                reason: "test-only rejection".to_string(),
            })
        }
    }

    fn sample_line(id: &str) -> TextLine {
        TextLine {
            line_id: id.to_string(),
            evidence_tier: EvidenceTier::E1,
            text: "hello".to_string(),
            speaker: Some("narrator".to_string()),
            color: None,
            text_surface: Some("adv".to_string()),
            bridge_ref: Some(ObservationBridgeRef {
                bridge_unit_id: Some("0190a000-0000-7000-8000-000000000001".to_string()),
                source_unit_key: Some("intro/line/1".to_string()),
                runtime_object_id: Some("scene-intro/text-1".to_string()),
            }),
            source_asset: Some(
                AssetId::parse("vfs://www/data/Map001.json").expect("valid asset id"),
            ),
            byte_offset_in_scene: None,
            body_shift_jis: None,
        }
    }

    #[test]
    fn recording_text_sink_forwards_to_inner_and_recorder() {
        let recorder: Arc<dyn ReferenceRecorder> = Arc::new(InMemoryReferenceRecorder::new(
            SourceTag::Fixture,
            "fixture-adapter",
            "fixture-run-1",
        ));
        let inner = CollectingTextSink::supported();
        let bridge = RecordingTextSink::new(inner, Arc::clone(&recorder));

        let line = sample_line("line-001");
        bridge.emit_line(line.clone()).expect("accepted");

        assert_eq!(bridge.inner().lines.lock().unwrap().len(), 1);
        let trace = recorder.finalize();
        assert_eq!(trace.text_events.len(), 1);
        assert_eq!(trace.text_events[0].line_id, "line-001");
        assert_eq!(trace.text_events[0], line);
    }

    #[test]
    fn recording_text_sink_does_not_record_when_inner_rejects() {
        // Audit contract: recording is observation of accepted output. If
        // the inner sink rejects, the recorder must NOT record the line.
        let recorder: Arc<dyn ReferenceRecorder> = Arc::new(InMemoryReferenceRecorder::new(
            SourceTag::Fixture,
            "fixture-adapter",
            "fixture-run-1",
        ));
        let bridge = RecordingTextSink::new(RejectingTextSink, Arc::clone(&recorder));

        let line = sample_line("line-001");
        let error = bridge
            .emit_line(line)
            .expect_err("inner rejection propagates");
        match error {
            SinkError::UnsupportedKind { sink, .. } => {
                assert_eq!(sink, SinkKind::TextSurface);
            }
            other => panic!("expected UnsupportedKind, got {other:?}"),
        }

        let trace = recorder.finalize();
        assert!(
            trace.text_events.is_empty(),
            "recorder must not observe rejected lines",
        );
    }

    #[test]
    fn recording_text_sink_capability_delegates_to_inner() {
        let recorder: Arc<dyn ReferenceRecorder> = Arc::new(InMemoryReferenceRecorder::new(
            SourceTag::Fixture,
            "fixture-adapter",
            "fixture-run-1",
        ));
        let inner = CollectingTextSink::supported();
        let bridge = RecordingTextSink::new(inner, recorder);
        match bridge.capability() {
            SinkCapability::Supported {
                evidence_tier_ceiling,
            } => {
                assert_eq!(evidence_tier_ceiling, EvidenceTier::E1);
            }
            SinkCapability::Unsupported => panic!("expected Supported, got Unsupported"),
        }
    }
}
