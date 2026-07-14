//! Text-surface sink contract.
//!
//! Text-only adapters (synthetic JSON, RealLive Scene strings, RPG Maker MV/MZ
//! JS DOM when not capturing) emit `TextLine` values into a
//! [`TextSurfaceSink`]. The sink contract enforces a per-emission `E1`
//! evidence ceiling: a text emission proves "the runtime emitted this string
//! for this bridge unit," not "this text was rendered on screen at any
//! point."

use serde::{Deserialize, Serialize};

use crate::{EvidenceTier, ObservationBridgeRef, vfs::AssetId};

use super::errors::{SinkError, SinkResult};
use super::{SinkCapability, SinkKind};

/// Headless text-surface sink. Implementors are `Send + Sync` and accept
/// `&self`-only emissions; interior mutability is the implementor's concern.
pub trait TextSurfaceSink: Send + Sync {
    /// Adapter-declared support for the text-surface sink kind.
    fn capability(&self) -> SinkCapability;

    /// Emit a text line at the declared evidence tier. The sink MUST reject
    /// `evidence_tier > SinkKind::TextSurface.evidence_tier_ceiling()` and
    /// MUST return [`SinkError::UnsupportedKind`] when the adapter declares
    /// the sink as [`SinkCapability::Unsupported`].
    fn emit_line(&self, line: TextLine) -> SinkResult<()>;

    /// Drain queued emissions. Called by the runner after `EnginePort::observe`
    /// to surface lines into [`crate::port::RunnerOutcome`]. Implementors that
    /// stream directly to disk may return an empty `Vec`; the runner treats
    /// the absence of buffered lines as "no in-tick emissions to surface".
    fn drain_lines(&self) -> Vec<TextLine> {
        Vec::new()
    }
}

/// Runtime-observed text line. Engine-neutral: no JSON shape, DOM shape, or
/// opcode bit leaks into the payload.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TextLine {
    /// Stable per-run identifier. Used by trace conformance () to
    /// assert ordering.
    pub line_id: String,
    /// `E0` (no runtime ran, e.g. static text) or `E1` (runtime trace).
    /// Higher tiers are rejected by the sink.
    pub evidence_tier: EvidenceTier,
    /// The observed text. UTF-8, post-decoding
    /// post-engine-text-substitution.
    pub text: String,
    /// Optional speaker label observed by the runtime (e.g. RealLive name
    /// register, MV/MZ event speaker). Never a host identifier.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub speaker: Option<String>,
    /// Optional per-speaker dialogue text colour (RGB), resolved from the
    /// engine's palette (e.g. RealLive `#NAMAE` middle field →
    /// `#COLOR_TABLE` row). `None` = the surface's default glyph colour.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub color: Option<[u8; 3]>,
    /// Optional engine-supplied surface label (e.g. "ADV", "NVL", "Choice"
    /// "Database.terms"). Engine-neutral string; the sink does not interpret.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text_surface: Option<String>,
    /// Bridge-unit linkage. Required by trace conformance bridge-ref checks.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bridge_ref: Option<ObservationBridgeRef>,
    /// Optional asset id this text came from. Uses the `AssetId`
    /// shape, so it is engine-neutral and host-path-free by construction.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_asset: Option<AssetId>,
    /// Optional byte offset of the source text run inside the decoded scene.
    /// RealLive supplies this so patch validation can correlate observed text
    /// with the byte-precise source unit; engines without byte-addressed text
    /// leave it absent.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub byte_offset_in_scene: Option<u32>,
    /// Optional raw Shift-JIS bytes for the observed text run. The wire shape
    /// intentionally matches the legacy replay-log evidence contract
    /// (`bodyShiftJisHex`) while keeping the in-memory value byte-oriented.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        rename = "bodyShiftJisHex",
        with = "optional_hex_bytes"
    )]
    pub body_shift_jis: Option<Vec<u8>>,
}

mod optional_hex_bytes {
    use serde::{Deserialize, Deserializer, Serializer};

    pub fn serialize<S>(value: &Option<Vec<u8>>, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        match value {
            Some(bytes) => serializer.serialize_some(&bytes_to_hex(bytes)),
            None => serializer.serialize_none(),
        }
    }

    pub fn deserialize<'de, D>(deserializer: D) -> Result<Option<Vec<u8>>, D::Error>
    where
        D: Deserializer<'de>,
    {
        let value = Option::<String>::deserialize(deserializer)?;
        value
            .map(|hex| decode_hex(&hex).map_err(serde::de::Error::custom))
            .transpose()
    }

    fn bytes_to_hex(bytes: &[u8]) -> String {
        let mut out = String::with_capacity(bytes.len() * 2);
        for byte in bytes {
            use std::fmt::Write;
            let _ = write!(out, "{byte:02x}");
        }
        out
    }

    fn decode_hex(hex: &str) -> Result<Vec<u8>, &'static str> {
        if !hex.len().is_multiple_of(2) {
            return Err("hex byte evidence must contain an even number of digits");
        }
        let bytes = hex.as_bytes();
        let mut out = Vec::with_capacity(bytes.len() / 2);
        for pair in bytes.chunks_exact(2) {
            let high = (pair[0] as char)
                .to_digit(16)
                .ok_or("hex byte evidence contains a non-hex digit")?;
            let low = (pair[1] as char)
                .to_digit(16)
                .ok_or("hex byte evidence contains a non-hex digit")?;
            out.push(((high << 4) | low) as u8);
        }
        Ok(out)
    }
}

impl TextLine {
    /// Per-payload validator. Called by the sink before insertion.
    pub fn validate(&self) -> SinkResult<()> {
        if self.evidence_tier > SinkKind::TextSurface.evidence_tier_ceiling() {
            return Err(SinkError::EvidenceTierMismatch {
                sink: SinkKind::TextSurface,
                claimed: self.evidence_tier,
                ceiling: SinkKind::TextSurface.evidence_tier_ceiling(),
            });
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;

    use serde_json::json;

    use crate::redaction::reject_unredacted_local_paths;

    use super::*;

    struct CollectingTextSink {
        capability: SinkCapability,
        adapter_id: String,
        lines: Mutex<Vec<TextLine>>,
    }

    impl CollectingTextSink {
        fn supported() -> Self {
            Self {
                capability: SinkCapability::Supported {
                    evidence_tier_ceiling: EvidenceTier::E1,
                },
                adapter_id: "synthetic-json".to_string(),
                lines: Mutex::new(Vec::new()),
            }
        }

        fn unsupported() -> Self {
            Self {
                capability: SinkCapability::Unsupported,
                adapter_id: "audio-only-adapter".to_string(),
                lines: Mutex::new(Vec::new()),
            }
        }
    }

    impl TextSurfaceSink for CollectingTextSink {
        fn capability(&self) -> SinkCapability {
            self.capability
        }

        fn emit_line(&self, line: TextLine) -> SinkResult<()> {
            if matches!(self.capability, SinkCapability::Unsupported) {
                return Err(SinkError::UnsupportedKind {
                    sink: SinkKind::TextSurface,
                    adapter_id: self.adapter_id.clone(),
                    reason: "adapter does not produce text lines".to_string(),
                });
            }
            line.validate()?;
            self.lines.lock().expect("lock").push(line);
            Ok(())
        }
    }

    fn sample_bridge_ref() -> ObservationBridgeRef {
        ObservationBridgeRef {
            bridge_unit_id: Some("0190a000-0000-7000-8000-000000000001".to_string()),
            source_unit_key: Some("intro/line/1".to_string()),
            runtime_object_id: Some("scene-intro/text-1".to_string()),
        }
    }

    fn sample_line(evidence_tier: EvidenceTier) -> TextLine {
        TextLine {
            line_id: "line-001".to_string(),
            evidence_tier,
            text: "hello".to_string(),
            speaker: Some("narrator".to_string()),
            color: None,
            text_surface: Some("adv".to_string()),
            bridge_ref: Some(sample_bridge_ref()),
            source_asset: Some(
                AssetId::parse("vfs://www/data/Map001.json").expect("valid asset id"),
            ),
            byte_offset_in_scene: None,
            body_shift_jis: None,
        }
    }

    #[test]
    fn text_sink_accepts_e1_emission_for_bridge_unit() {
        let sink = CollectingTextSink::supported();
        let line = sample_line(EvidenceTier::E1);
        sink.emit_line(line).expect("E1 emission accepted");
        assert_eq!(sink.lines.lock().unwrap().len(), 1);
    }

    #[test]
    fn text_sink_accepts_e0_emission_for_static_text() {
        let sink = CollectingTextSink::supported();
        let line = sample_line(EvidenceTier::E0);
        sink.emit_line(line).expect("E0 emission accepted");
    }

    #[test]
    fn text_sink_rejects_e2_emission_as_evidence_tier_mismatch() {
        let sink = CollectingTextSink::supported();
        let line = sample_line(EvidenceTier::E2);
        let error = sink.emit_line(line).expect_err("E2 rejected");
        assert!(matches!(
            error,
            SinkError::EvidenceTierMismatch {
                sink: SinkKind::TextSurface,
                claimed: EvidenceTier::E2,
                ceiling: EvidenceTier::E1,
            }
        ));
        assert_eq!(error.semantic_code(), "utsushi.sink.evidence_tier_mismatch");
    }

    #[test]
    fn text_sink_rejects_e3_emission_as_evidence_tier_mismatch() {
        let sink = CollectingTextSink::supported();
        let line = sample_line(EvidenceTier::E3);
        let error = sink.emit_line(line).expect_err("E3 rejected");
        assert!(matches!(
            error,
            SinkError::EvidenceTierMismatch {
                sink: SinkKind::TextSurface,
                claimed: EvidenceTier::E3,
                ..
            }
        ));
    }

    #[test]
    fn text_sink_unsupported_capability_returns_unsupported_kind() {
        let sink = CollectingTextSink::unsupported();
        let line = sample_line(EvidenceTier::E1);
        let error = sink.emit_line(line).expect_err("unsupported sink rejects");
        match error {
            SinkError::UnsupportedKind {
                sink, adapter_id, ..
            } => {
                assert_eq!(sink, SinkKind::TextSurface);
                assert_eq!(adapter_id, "audio-only-adapter");
            }
            other => panic!("expected UnsupportedKind, got {other:?}"),
        }
    }

    #[test]
    fn text_sink_emission_with_source_asset_uses_vfs_asset_id() {
        let sink = CollectingTextSink::supported();
        let line = sample_line(EvidenceTier::E1);
        sink.emit_line(line.clone()).expect("accepted");
        // Compile-level guarantee: TextLine::source_asset is AssetId, not a
        // PathBuf. The behavior-level guarantee is exercised through serde:
        // serialization round-trips the vfs:// scheme.
        let value = serde_json::to_value(&line).expect("serialize");
        assert_eq!(
            value["sourceAsset"].as_str(),
            Some("vfs://www/data/Map001.json")
        );
    }

    #[test]
    fn text_sink_emission_serializes_with_camel_case() {
        let line = sample_line(EvidenceTier::E1);
        let value = serde_json::to_value(&line).expect("serialize");
        let obj = value.as_object().expect("object");
        assert!(obj.contains_key("lineId"));
        assert!(obj.contains_key("evidenceTier"));
        assert!(obj.contains_key("textSurface"));
        assert!(obj.contains_key("bridgeRef"));
        assert!(obj.contains_key("sourceAsset"));
        // snake_case forms MUST NOT leak through.
        assert!(!obj.contains_key("line_id"));
        assert!(!obj.contains_key("text_surface"));
    }

    #[test]
    fn text_sink_emission_passes_observation_redaction_filter() {
        let line = sample_line(EvidenceTier::E1);
        let value = json!({ "textLine": serde_json::to_value(&line).unwrap() });
        reject_unredacted_local_paths("", &value).expect("no host path in clean emission");
    }

    #[test]
    fn text_sink_emission_with_local_path_in_speaker_fails_redaction() {
        let mut line = sample_line(EvidenceTier::E1);
        line.speaker = Some("/home/leak/profile".to_string());
        let value = json!({ "textLine": serde_json::to_value(&line).unwrap() });
        let error =
            reject_unredacted_local_paths("", &value).expect_err("local path in speaker is caught");
        let rendered = error.to_string();
        assert!(
            rendered.contains("speaker"),
            "redaction error should name speaker field: {rendered}"
        );
    }

    #[test]
    fn engine_neutral_text_sink_accepts_three_engine_shapes() {
        let sink = CollectingTextSink::supported();
        for (idx, surface) in ["adv", "event_command", "scene_string"].iter().enumerate() {
            let mut line = sample_line(EvidenceTier::E1);
            line.line_id = format!("line-{idx}");
            line.text_surface = Some((*surface).to_string());
            sink.emit_line(line).expect("each engine shape accepted");
        }
        assert_eq!(sink.lines.lock().unwrap().len(), 3);
    }
}
