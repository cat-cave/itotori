//! Conformance fixture builders.
//!
//! Public test-aid surface for downstream consumers (UTSUSHI-027/028/029
//! integration tests) that need a well-formed `ConformanceManifest` or
//! `ConformanceResult` to layer their own assertions on top of. The
//! builders are deterministic and engine-neutral: no XP3/KAG/RGSS3/JSON
//! engine names, no host paths, no fixture id collisions.
//!
//! The constructors are exposed unconditionally so the in-crate
//! integration tests (`cargo test -p utsushi-core`) reach them without
//! a feature pin and downstream test crates can consume them
//! transparently. The `conformance-fixtures` feature is preserved as a
//! documented opt-in marker for cross-crate consumers that want an
//! explicit dev-dep handshake.

use crate::{EvidenceTier, RuntimeArtifactKind, runtime_artifact_uri};

use super::manifest::{ConformanceProfile, ProfileExtension, SubsystemRequirement};
use super::result::{ConformanceResult, EvidenceRef, ResultOutcome};
use super::{CONFORMANCE_SCHEMA_VERSION, ConformanceAbiVersion, ConformanceManifest, ProfileId};

/// Canonical adapter id used by the synthetic test fixtures.
pub const SYNTHETIC_ADAPTER_ID: &str = "utsushi-synthetic";

/// Synthesise a manifest declaring the `text-trace` profile at the
/// profile-id ceiling.
pub fn synthetic_text_trace_manifest() -> ConformanceManifest {
    ConformanceManifest {
        schema_version: CONFORMANCE_SCHEMA_VERSION.to_string(),
        adapter_id: SYNTHETIC_ADAPTER_ID.to_string(),
        abi_version: ConformanceAbiVersion(1),
        supported_profiles: vec![ConformanceProfile {
            id: ProfileId::TextTrace,
            required_subsystems: vec![SubsystemRequirement::TextSink],
            evidence_tier_ceiling: EvidenceTier::E1,
        }],
        optional_extensions: Vec::new(),
    }
}

/// Synthesise a manifest declaring the `frame-capture` profile at the
/// profile-id ceiling, with a `rgba8` extension.
pub fn synthetic_frame_capture_manifest() -> ConformanceManifest {
    ConformanceManifest {
        schema_version: CONFORMANCE_SCHEMA_VERSION.to_string(),
        adapter_id: SYNTHETIC_ADAPTER_ID.to_string(),
        abi_version: ConformanceAbiVersion(1),
        supported_profiles: vec![ConformanceProfile {
            id: ProfileId::FrameCapture,
            required_subsystems: vec![
                SubsystemRequirement::FrameSink,
                SubsystemRequirement::ArtifactStore,
            ],
            evidence_tier_ceiling: EvidenceTier::E2,
        }],
        optional_extensions: vec![ProfileExtension {
            profile_id: ProfileId::FrameCapture,
            key: "rgba8".to_string(),
            note: "Adapter emits frames as 8-bit RGBA captures.".to_string(),
        }],
    }
}

/// Synthesise a pass result for the `text-trace` profile citing a
/// single text-line evidence ref.
pub fn synthetic_text_trace_pass_result() -> ConformanceResult {
    ConformanceResult {
        schema_version: CONFORMANCE_SCHEMA_VERSION.to_string(),
        adapter_id: SYNTHETIC_ADAPTER_ID.to_string(),
        profile_id: ProfileId::TextTrace,
        outcome: ResultOutcome::Pass {
            evidence_tier: EvidenceTier::E1,
        },
        evidence: vec![EvidenceRef::TextLine {
            line_id: "trace-line-001".to_string(),
        }],
        recorded_at: "2026-06-23T12:00:00Z".to_string(),
    }
}

/// Synthesise a pass result for the `frame-capture` profile citing a
/// frame capture under the managed runtime artifact root.
pub fn synthetic_frame_capture_pass_result() -> ConformanceResult {
    let uri = runtime_artifact_uri(
        "synthetic-run",
        RuntimeArtifactKind::FrameCapture,
        "frame-001",
    )
    .expect("synthetic uri");
    ConformanceResult {
        schema_version: CONFORMANCE_SCHEMA_VERSION.to_string(),
        adapter_id: SYNTHETIC_ADAPTER_ID.to_string(),
        profile_id: ProfileId::FrameCapture,
        outcome: ResultOutcome::Pass {
            evidence_tier: EvidenceTier::E2,
        },
        evidence: vec![EvidenceRef::RuntimeArtifact {
            kind: RuntimeArtifactKind::FrameCapture,
            uri,
            artifact_id: Some("frame-001".to_string()),
        }],
        recorded_at: "2026-06-23T12:00:00Z".to_string(),
    }
}

/// Normalize the `recordedAt` field on a serialized result to a
/// canonical sentinel. Use this in golden fixture comparisons so the
/// volatile timestamp does not break round-trip equality. (Documented
/// in plan §10.5.)
pub fn normalize_recorded_at(value: &mut serde_json::Value, sentinel: &str) {
    if let Some(object) = value.as_object_mut()
        && let Some(recorded_at) = object.get_mut("recordedAt")
    {
        *recorded_at = serde_json::Value::String(sentinel.to_string());
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn synthetic_text_trace_manifest_validates() {
        synthetic_text_trace_manifest()
            .validate()
            .expect("validates");
    }

    #[test]
    fn synthetic_frame_capture_manifest_validates() {
        synthetic_frame_capture_manifest()
            .validate()
            .expect("validates");
    }

    #[test]
    fn synthetic_text_trace_pass_result_validates() {
        synthetic_text_trace_pass_result()
            .validate()
            .expect("validates");
    }

    #[test]
    fn synthetic_frame_capture_pass_result_validates() {
        synthetic_frame_capture_pass_result()
            .validate()
            .expect("validates");
    }

    #[test]
    fn normalize_recorded_at_replaces_field() {
        let result = synthetic_text_trace_pass_result();
        let mut value = serde_json::to_value(&result).expect("serializes");
        normalize_recorded_at(&mut value, "NORMALIZED");
        assert_eq!(
            value
                .as_object()
                .and_then(|o| o.get("recordedAt"))
                .and_then(|v| v.as_str()),
            Some("NORMALIZED")
        );
    }
}
