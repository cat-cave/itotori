//! Frame-artifact sink contract.
//!
//! Adapters that produce frame bytes write them through
//! [`crate::RuntimeArtifactRoot::write_bytes`] and then announce the result
//! to the sink as an [`ObservationArtifactRef`]. The sink never carries
//! bytes; it is the *announcement* surface, not the storage surface.

use serde::{Deserialize, Serialize};

use crate::{EvidenceTier, ObservationArtifactRef, ObservationBridgeRef};

use super::errors::{SinkError, SinkResult};
use super::{SinkCapability, SinkKind};

/// Frame-artifact kinds the headless runtime sinks may announce. Anything
/// outside this list is policy-rejected.
const FRAME_ARTIFACT_KIND_ALLOW_LIST: &[&str] = &["screenshot", "frame_capture", "recording"];

/// Headless frame-artifact sink.
pub trait FrameArtifactSink: Send + Sync {
    /// Adapter-declared support for the frame-artifact sink kind.
    fn capability(&self) -> SinkCapability;

    /// Emit a frame artifact reference. The sink MUST reject
    /// `evidence_tier < EvidenceTier::E2` because a frame artifact is the
    /// minimum E2 evidence; lower tiers must use a different sink. The sink
    /// MUST also reject any [`FrameArtifact`] whose `artifact_ref` URI fails
    /// [`crate::validate_runtime_artifact_uri`], or whose `artifact_kind` is
    /// not in the allow-list.
    fn emit_frame(&self, artifact: FrameArtifact) -> SinkResult<()>;

    /// Drain queued emissions. Called by the runner after `EnginePort::observe`
    /// (after the text sink drain) to surface frame announcements into
    /// [`crate::port::RunnerOutcome`].
    fn drain_frames(&self) -> Vec<FrameArtifact> {
        Vec::new()
    }
}

/// Runtime-announced frame artifact. Bytes live behind the artifact-store
/// API; this struct only carries a portable reference.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FrameArtifact {
    /// Stable per-run identifier; UTSUSHI-029 uses this for portability
    /// assertions.
    pub frame_id: String,
    /// Always `>= E2`. `E3` is allowed for replay-review adapters; `E4` is
    /// allowed only for adapters that have reference-comparison evidence and
    /// declare `ReferenceFidelity` in their descriptor. Tier validation
    /// against the descriptor happens upstream of the sink; the sink only
    /// enforces the per-payload floor.
    pub evidence_tier: EvidenceTier,
    /// Portable artifact reference. The URI MUST live under
    /// `RUNTIME_ARTIFACT_URI_ROOT` (`artifacts/utsushi/runtime/...`).
    pub artifact_ref: ObservationArtifactRef,
    /// Optional pixel dimensions; informational only.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub width: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub height: Option<u32>,
    /// Monotonic frame number from the runtime clock. Required so frame
    /// streams stay deterministic; UTSUSHI-021 owns the clock.
    pub frame_index: u64,
    /// Bridge-unit linkage (the bridge unit this capture was taken for).
    /// Optional because not every capture corresponds to a specific
    /// localized unit (e.g. transition frames).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bridge_ref: Option<ObservationBridgeRef>,
}

impl FrameArtifact {
    /// Per-payload validator. Called by the sink before insertion. Enforces:
    /// the per-sink evidence floor (E2), the artifact-ref URI shape, and the
    /// artifact-kind allow-list.
    pub fn validate(&self) -> SinkResult<()> {
        if self.evidence_tier < EvidenceTier::E2 {
            return Err(SinkError::EvidenceTierMismatch {
                sink: SinkKind::FrameArtifact,
                claimed: self.evidence_tier,
                ceiling: EvidenceTier::E2,
            });
        }
        self.artifact_ref
            .validate()
            .map_err(|error| SinkError::ArtifactPolicy {
                artifact_id: self.artifact_ref.artifact_id.clone(),
                reason: error.to_string(),
            })?;
        if !FRAME_ARTIFACT_KIND_ALLOW_LIST.contains(&self.artifact_ref.artifact_kind.as_str()) {
            return Err(SinkError::ArtifactPolicy {
                artifact_id: self.artifact_ref.artifact_id.clone(),
                reason: format!(
                    "artifact_kind not in headless-runtime allow-list: {}",
                    self.artifact_ref.artifact_kind
                ),
            });
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;

    use serde_json::json;
    use tempfile::TempDir;

    use crate::redaction::reject_unredacted_local_paths;
    use crate::{RUNTIME_ARTIFACT_URI_ROOT, RuntimeArtifactRoot};

    use super::*;

    struct CollectingFrameSink {
        capability: SinkCapability,
        adapter_id: String,
        frames: Mutex<Vec<FrameArtifact>>,
    }

    impl CollectingFrameSink {
        fn supported() -> Self {
            Self {
                capability: SinkCapability::Supported {
                    evidence_tier_ceiling: EvidenceTier::E2,
                },
                adapter_id: "headless-capture".to_string(),
                frames: Mutex::new(Vec::new()),
            }
        }

        fn unsupported() -> Self {
            Self {
                capability: SinkCapability::Unsupported,
                adapter_id: "text-only-adapter".to_string(),
                frames: Mutex::new(Vec::new()),
            }
        }
    }

    impl FrameArtifactSink for CollectingFrameSink {
        fn capability(&self) -> SinkCapability {
            self.capability
        }

        fn emit_frame(&self, artifact: FrameArtifact) -> SinkResult<()> {
            if matches!(self.capability, SinkCapability::Unsupported) {
                return Err(SinkError::UnsupportedKind {
                    sink: SinkKind::FrameArtifact,
                    adapter_id: self.adapter_id.clone(),
                    reason: "adapter does not produce frame artifacts".to_string(),
                });
            }
            artifact.validate()?;
            self.frames.lock().expect("lock").push(artifact);
            Ok(())
        }
    }

    const HARNESS_RUN_ID: &str = "0190a000-0000-7000-8000-0000000000aa";
    const HARNESS_FRAME_ID: &str = "0190a000-0000-7000-8000-0000000000bb";

    fn managed_uri() -> String {
        format!("{RUNTIME_ARTIFACT_URI_ROOT}/{HARNESS_RUN_ID}/screenshots/{HARNESS_FRAME_ID}.png")
    }

    fn sample_artifact_ref(uri: &str, artifact_kind: &str) -> ObservationArtifactRef {
        ObservationArtifactRef {
            artifact_id: HARNESS_FRAME_ID.to_string(),
            artifact_kind: artifact_kind.to_string(),
            uri: uri.to_string(),
            media_type: Some("image/png".to_string()),
        }
    }

    fn sample_frame(
        evidence_tier: EvidenceTier,
        artifact_ref: ObservationArtifactRef,
    ) -> FrameArtifact {
        FrameArtifact {
            frame_id: HARNESS_FRAME_ID.to_string(),
            evidence_tier,
            artifact_ref,
            width: Some(1920),
            height: Some(1080),
            frame_index: 7,
            bridge_ref: Some(ObservationBridgeRef {
                bridge_unit_id: Some("0190a000-0000-7000-8000-000000000001".to_string()),
                source_unit_key: None,
                runtime_object_id: None,
            }),
        }
    }

    #[test]
    fn frame_sink_accepts_e2_capture_through_managed_artifact_root() {
        let temp = TempDir::new().expect("tempdir");
        let root = RuntimeArtifactRoot::new(temp.path());
        root.prepare().expect("prepare root");
        let uri = managed_uri();
        let written = root
            .write_bytes(&uri, &[0u8; 4])
            .expect("write managed bytes");
        assert!(written.starts_with(temp.path()));

        let sink = CollectingFrameSink::supported();
        let frame = sample_frame(EvidenceTier::E2, sample_artifact_ref(&uri, "screenshot"));
        sink.emit_frame(frame).expect("E2 frame accepted");
        assert_eq!(sink.frames.lock().unwrap().len(), 1);
    }

    #[test]
    fn frame_sink_rejects_e1_emission_as_evidence_tier_mismatch() {
        let sink = CollectingFrameSink::supported();
        let frame = sample_frame(
            EvidenceTier::E1,
            sample_artifact_ref(&managed_uri(), "screenshot"),
        );
        let error = sink.emit_frame(frame).expect_err("E1 floor enforced");
        assert!(matches!(
            error,
            SinkError::EvidenceTierMismatch {
                sink: SinkKind::FrameArtifact,
                claimed: EvidenceTier::E1,
                ceiling: EvidenceTier::E2,
            }
        ));
    }

    #[test]
    fn frame_sink_rejects_e0_emission_as_evidence_tier_mismatch() {
        let sink = CollectingFrameSink::supported();
        let frame = sample_frame(
            EvidenceTier::E0,
            sample_artifact_ref(&managed_uri(), "screenshot"),
        );
        sink.emit_frame(frame).expect_err("E0 rejected");
    }

    #[test]
    fn frame_sink_rejects_artifact_ref_with_absolute_path_uri() {
        let sink = CollectingFrameSink::supported();
        let frame = sample_frame(
            EvidenceTier::E2,
            sample_artifact_ref("/tmp/leak/frame.png", "screenshot"),
        );
        let error = sink.emit_frame(frame).expect_err("absolute path rejected");
        assert!(matches!(error, SinkError::ArtifactPolicy { .. }));
        assert_eq!(error.semantic_code(), "utsushi.sink.artifact_policy");
    }

    #[test]
    fn frame_sink_rejects_artifact_ref_with_file_scheme() {
        let sink = CollectingFrameSink::supported();
        let frame = sample_frame(
            EvidenceTier::E2,
            sample_artifact_ref("file:///home/leak/frame.png", "screenshot"),
        );
        let error = sink.emit_frame(frame).expect_err("file scheme rejected");
        assert!(matches!(error, SinkError::ArtifactPolicy { .. }));
    }

    #[test]
    fn frame_sink_rejects_artifact_ref_outside_runtime_artifact_root() {
        let sink = CollectingFrameSink::supported();
        let frame = sample_frame(
            EvidenceTier::E2,
            sample_artifact_ref("artifacts/other/frame.png", "screenshot"),
        );
        let error = sink.emit_frame(frame).expect_err("outside root rejected");
        assert!(matches!(error, SinkError::ArtifactPolicy { .. }));
    }

    #[test]
    fn frame_sink_rejects_artifact_kind_outside_allow_list() {
        let sink = CollectingFrameSink::supported();
        let frame = sample_frame(
            EvidenceTier::E2,
            sample_artifact_ref(&managed_uri(), "trace_log"),
        );
        let error = sink
            .emit_frame(frame)
            .expect_err("artifact kind allow-list enforced");
        assert!(matches!(error, SinkError::ArtifactPolicy { .. }));
    }

    #[test]
    fn frame_sink_accepts_each_allow_listed_artifact_kind() {
        let sink = CollectingFrameSink::supported();
        for kind in ["screenshot", "frame_capture", "recording"] {
            let uri = format!(
                "{RUNTIME_ARTIFACT_URI_ROOT}/{HARNESS_RUN_ID}/screenshots/{HARNESS_FRAME_ID}-{kind}.png"
            );
            let frame = sample_frame(EvidenceTier::E2, sample_artifact_ref(&uri, kind));
            sink.emit_frame(frame)
                .unwrap_or_else(|error| panic!("kind {kind} should be accepted: {error}"));
        }
    }

    #[test]
    fn frame_sink_capability_declaration_prevents_text_only_adapter_from_emitting() {
        let sink = CollectingFrameSink::unsupported();
        let frame = sample_frame(
            EvidenceTier::E2,
            sample_artifact_ref(&managed_uri(), "screenshot"),
        );
        let error = sink.emit_frame(frame).expect_err("unsupported rejects");
        match error {
            SinkError::UnsupportedKind {
                sink, adapter_id, ..
            } => {
                assert_eq!(sink, SinkKind::FrameArtifact);
                assert_eq!(adapter_id, "text-only-adapter");
            }
            other => panic!("expected UnsupportedKind, got {other:?}"),
        }
    }

    #[test]
    fn frame_sink_emission_passes_observation_redaction_filter() {
        let frame = sample_frame(
            EvidenceTier::E2,
            sample_artifact_ref(&managed_uri(), "screenshot"),
        );
        let value = json!({ "frameArtifact": serde_json::to_value(&frame).unwrap() });
        reject_unredacted_local_paths("", &value).expect("clean emission passes");
    }

    #[test]
    fn frame_sink_payload_serializes_with_camel_case() {
        let frame = sample_frame(
            EvidenceTier::E2,
            sample_artifact_ref(&managed_uri(), "screenshot"),
        );
        let value = serde_json::to_value(&frame).expect("serialize");
        let obj = value.as_object().expect("object");
        assert!(obj.contains_key("frameId"));
        assert!(obj.contains_key("evidenceTier"));
        assert!(obj.contains_key("artifactRef"));
        assert!(obj.contains_key("frameIndex"));
        assert!(!obj.contains_key("frame_id"));
        assert!(!obj.contains_key("artifact_ref"));
    }
}
