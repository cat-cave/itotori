//! Result schema — one outcome per profile attempted in a conformance
//! run.
//!
//! The result schema's audit-focus invariants:
//! - `Pass` and `Skip` are distinct enum variants ("Skipped != Pass" is
//!   structural).
//! - A `Pass` outcome requires non-empty evidence; the validator rejects
//!   `Pass` with an empty evidence list as
//!   `utsushi.conformance.pass_without_evidence`.
//! - An `Unsupported` outcome with `declared_in_manifest = true` is
//!   immediately rejected because a declared profile cannot be
//!   Unsupported (mirror of the `DeclaredProfileSkipped` cross-check).
//! - `Fail.semantic_code` and friends must match the namespaced shape
//!   `^<provider>\.<subsystem>\.<reason>$` where `<provider>` is the
//!   literal `utsushi` or `kaifuu` alternation.

use serde::{Deserialize, Deserializer, Serialize, Serializer};

use crate::{
    EvidenceTier, RuntimeArtifactKind, UtsushiResult, looks_like_local_path,
    validate_runtime_artifact_uri,
};

use super::diagnostics::ConformanceError;
use super::manifest::is_valid_adapter_id;
use super::{CONFORMANCE_SCHEMA_VERSION, ProfileId};

/// Wire-format helper for [`RuntimeArtifactKind`] so the result schema
/// can serialize/deserialize it via serde without modifying the
/// existing enum at the crate root (which is owned by other concerns).
/// The wire shape is the same `snake_case` string `artifact_kind()`
/// already returns.
// reason: serde `serialize_with` callbacks must take the field by shared
// reference (`&T`); passing `RuntimeArtifactKind` by value would not match the
// signature serde expects.
#[allow(clippy::trivially_copy_pass_by_ref)]
fn serialize_runtime_artifact_kind<S>(
    kind: &RuntimeArtifactKind,
    serializer: S,
) -> Result<S::Ok, S::Error>
where
    S: Serializer,
{
    serializer.serialize_str(kind.artifact_kind())
}

fn deserialize_runtime_artifact_kind<'de, D>(
    deserializer: D,
) -> Result<RuntimeArtifactKind, D::Error>
where
    D: Deserializer<'de>,
{
    let raw = String::deserialize(deserializer)?;
    match raw.as_str() {
        "trace_log" => Ok(RuntimeArtifactKind::TraceLog),
        "screenshot" => Ok(RuntimeArtifactKind::Screenshot),
        "frame_capture" => Ok(RuntimeArtifactKind::FrameCapture),
        "recording" => Ok(RuntimeArtifactKind::Recording),
        "reference_comparison" => Ok(RuntimeArtifactKind::ConformanceReport),
        other => Err(serde::de::Error::custom(format!(
            "unknown runtime artifact kind: {other}"
        ))),
    }
}

/// Reference to a piece of evidence supporting a conformance outcome.
/// Tagged by `artifactKind` on the wire.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "artifactKind", rename_all = "camelCase")]
pub enum EvidenceRef {
    /// Reference to an artifact-store-managed runtime artifact. `uri` is
    /// validated through
    /// [`crate::validate_runtime_artifact_uri`] — rejects absolute
    /// paths, traversal, `file:`/`data:`/`blob:` schemes, and anything
    /// outside the managed runtime root.
    #[serde(rename = "runtimeArtifact", rename_all = "camelCase")]
    RuntimeArtifact {
        #[serde(
            serialize_with = "serialize_runtime_artifact_kind",
            deserialize_with = "deserialize_runtime_artifact_kind"
        )]
        kind: RuntimeArtifactKind,
        uri: String,
        #[serde(skip_serializing_if = "Option::is_none", default)]
        artifact_id: Option<String>,
    },

    /// Reference to a `TextSurfaceSink` emission identified by line id.
    #[serde(rename = "textLine", rename_all = "camelCase")]
    TextLine { line_id: String },

    /// Reference to a `FrameArtifactSink` emission identified by frame id.
    #[serde(rename = "frameArtifactRef", rename_all = "camelCase")]
    FrameArtifactRef { frame_id: String },

    /// Reference to a recorded `ReplayLog` whose `run_id` proves the
    /// replay run (UTSUSHI-021).
    #[serde(rename = "replayLogRef", rename_all = "camelCase")]
    ReplayLogRef { run_id: String },

    /// Cross-reference to an impl-map fixture id (UTSUSHI-025). This is
    /// the only coupling between conformance and impl-map; it is
    /// one-way and string-keyed (no Rust type coupling).
    #[serde(rename = "implMapFixture", rename_all = "camelCase")]
    ImplMapFixture { fixture_id: String },

    /// Bridge-unit linkage. The bridge unit id format is checked via
    /// the same id rules as
    /// `ObservationBridgeRef`.
    #[serde(rename = "bridgeUnit", rename_all = "camelCase")]
    BridgeUnit { bridge_unit_id: String },

    /// Reference to a [`crate::StatePath`] quoted verbatim from a
    /// snapshot diff. Additive variant introduced by UTSUSHI-028. The
    /// `path` string is the canonical wire form returned by
    /// [`crate::StatePath::as_str`] (already lowercase ASCII with `.`
    /// segment separators; the snapshot substrate enforces this at parse
    /// time). The wire shape is
    /// `{ "artifactKind": "statePath", "path": "<state path>" }`.
    #[serde(rename = "statePath", rename_all = "camelCase")]
    StatePath { path: String },
}

impl EvidenceRef {
    /// Validate the evidence reference's structural shape.
    pub fn validate(&self) -> Result<(), ConformanceError> {
        match self {
            Self::RuntimeArtifact {
                uri, artifact_id, ..
            } => {
                if let Err(error) = validate_runtime_artifact_uri(uri) {
                    return Err(ConformanceError::EvidenceRefInvalid {
                        artifact_kind: "runtime_artifact",
                        reason: error.to_string(),
                    });
                }
                if let Some(artifact_id) = artifact_id {
                    validate_id_string("runtime_artifact", "artifact_id", artifact_id)?;
                }
                Ok(())
            }
            Self::TextLine { line_id } => validate_id_string("text_line", "line_id", line_id),
            Self::FrameArtifactRef { frame_id } => {
                validate_id_string("frame_artifact_ref", "frame_id", frame_id)
            }
            Self::ReplayLogRef { run_id } => validate_id_string("replay_log_ref", "run_id", run_id),
            Self::ImplMapFixture { fixture_id } => {
                validate_id_string("impl_map_fixture", "fixture_id", fixture_id)
            }
            Self::BridgeUnit { bridge_unit_id } => {
                validate_id_string("bridge_unit", "bridge_unit_id", bridge_unit_id)
            }
            Self::StatePath { path } => {
                if path.is_empty() {
                    return Err(ConformanceError::EvidenceRefInvalid {
                        artifact_kind: "state_path",
                        reason: "path is empty".to_string(),
                    });
                }
                if path.chars().any(char::is_whitespace) {
                    return Err(ConformanceError::EvidenceRefInvalid {
                        artifact_kind: "state_path",
                        reason: "path contains whitespace".to_string(),
                    });
                }
                // Defense in depth: also block local-path-shaped inputs
                // before delegating to the substrate parser. The parser
                // already rejects them, but the EvidenceRef::validate
                // contract is the single seam the conformance layer
                // trusts.
                if looks_like_local_path(path) {
                    return Err(ConformanceError::EvidenceRefInvalid {
                        artifact_kind: "state_path",
                        reason: "path looks like a local path".to_string(),
                    });
                }
                // Reuse the UTSUSHI-023 parser so the conformance layer
                // cannot accept any string the substrate would have
                // rejected. The parser enforces the namespace allow
                // list, the segment shape, and the byte ceiling.
                crate::StatePath::parse(path).map_err(|err| {
                    ConformanceError::EvidenceRefInvalid {
                        artifact_kind: "state_path",
                        reason: err.to_string(),
                    }
                })?;
                Ok(())
            }
        }
    }
}

fn validate_id_string(
    artifact_kind: &'static str,
    field: &str,
    value: &str,
) -> Result<(), ConformanceError> {
    if value.is_empty() {
        return Err(ConformanceError::EvidenceRefInvalid {
            artifact_kind,
            reason: format!("{field} is empty"),
        });
    }
    if value.chars().any(char::is_whitespace) {
        return Err(ConformanceError::EvidenceRefInvalid {
            artifact_kind,
            reason: format!("{field} contains whitespace"),
        });
    }
    if looks_like_local_path(value) {
        return Err(ConformanceError::EvidenceRefInvalid {
            artifact_kind,
            reason: format!("{field} looks like a local path"),
        });
    }
    Ok(())
}

/// Discriminator-tagged outcome variants. The wire tag is `"kind"`,
/// matching the UTSUSHI-030 ingestion contract.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ResultOutcome {
    /// The profile was attempted and satisfied.
    #[serde(rename_all = "camelCase")]
    Pass { evidence_tier: EvidenceTier },

    /// The profile was attempted and failed. `semantic_code` is one of
    /// the `utsushi.*` or `kaifuu.*` failure codes; `detail` is a
    /// short, public-string description.
    #[serde(rename_all = "camelCase")]
    Fail {
        semantic_code: String,
        detail: String,
    },

    /// The profile was deliberately not attempted in this run. Skip is
    /// **forbidden for declared profiles** (cross-validated).
    #[serde(rename_all = "camelCase")]
    Skip {
        semantic_code: String,
        reason: String,
    },

    /// The adapter does not implement this profile. **Forbidden** when
    /// the manifest declared the profile — `declared_in_manifest = true`
    /// is the immediate validation reject.
    #[serde(rename_all = "camelCase")]
    Unsupported {
        semantic_code: String,
        declared_in_manifest: bool,
    },
}

/// One outcome per profile attempted in a conformance run.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConformanceResult {
    /// Schema version pin.
    pub schema_version: String,

    /// Adapter id that produced this result. Must equal the manifest's
    /// `adapter_id` when paired (validated by the cross-checker).
    pub adapter_id: String,

    /// Profile this outcome reports on.
    pub profile_id: ProfileId,

    /// Outcome discriminator.
    pub outcome: ResultOutcome,

    /// Evidence references. May be empty for Skip/Unsupported variants;
    /// MUST be non-empty for Pass.
    pub evidence: Vec<EvidenceRef>,

    /// RFC3339 timestamp the runner recorded when finalising this
    /// result. Volatile by design.
    pub recorded_at: String,
}

impl ConformanceResult {
    /// Validate the result's standalone, result-internal rules.
    pub fn validate(&self) -> Result<(), ConformanceError> {
        if self.schema_version != CONFORMANCE_SCHEMA_VERSION {
            return Err(ConformanceError::UnsupportedSchemaVersion {
                observed: self.schema_version.clone(),
                expected: CONFORMANCE_SCHEMA_VERSION,
            });
        }
        if !is_valid_adapter_id(&self.adapter_id) {
            return Err(ConformanceError::AdapterIdMalformed {
                id: self.adapter_id.clone(),
            });
        }
        if !is_valid_rfc3339_instant(&self.recorded_at) {
            return Err(ConformanceError::RecordedAtMalformed {
                recorded_at: self.recorded_at.clone(),
            });
        }
        for evidence in &self.evidence {
            evidence.validate()?;
        }
        match &self.outcome {
            ResultOutcome::Pass { evidence_tier } => {
                if self.evidence.is_empty() {
                    return Err(ConformanceError::PassWithoutEvidence {
                        profile: self.profile_id,
                    });
                }
                let ceiling = self.profile_id.evidence_tier_ceiling();
                if *evidence_tier > ceiling {
                    return Err(ConformanceError::EvidenceTierAboveProfileCeiling {
                        profile: self.profile_id,
                        claimed: *evidence_tier,
                        ceiling,
                    });
                }
            }
            ResultOutcome::Fail {
                semantic_code,
                detail: _,
            }
            | ResultOutcome::Skip {
                semantic_code,
                reason: _,
            } => {
                validate_semantic_code(semantic_code)?;
            }
            ResultOutcome::Unsupported {
                semantic_code,
                declared_in_manifest,
            } => {
                validate_semantic_code(semantic_code)?;
                if *declared_in_manifest {
                    return Err(ConformanceError::DeclaredProfileReportedAsUnsupported {
                        profile: self.profile_id,
                    });
                }
            }
        }
        Ok(())
    }

    /// Serialize to JSON after validation.
    pub fn to_json_value(&self) -> UtsushiResult<serde_json::Value> {
        self.validate().map_err(boxed_error)?;
        Ok(serde_json::to_value(self)?)
    }

    /// Deserialize from JSON and validate.
    pub fn from_json_value(value: serde_json::Value) -> UtsushiResult<Self> {
        let result: Self = serde_json::from_value(value)?;
        result.validate().map_err(boxed_error)?;
        Ok(result)
    }
}

/// Validates that a semantic code matches
/// `^(utsushi|kaifuu)\.[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$`.
pub(super) fn validate_semantic_code(code: &str) -> Result<(), ConformanceError> {
    if !is_valid_semantic_code(code) {
        return Err(ConformanceError::MalformedSemanticCode {
            code: code.to_string(),
        });
    }
    Ok(())
}

fn is_valid_semantic_code(code: &str) -> bool {
    let mut parts = code.split('.');
    let Some(provider) = parts.next() else {
        return false;
    };
    if !(provider == "utsushi" || provider == "kaifuu") {
        return false;
    }
    let Some(subsystem) = parts.next() else {
        return false;
    };
    let Some(reason) = parts.next() else {
        return false;
    };
    if parts.next().is_some() {
        return false;
    }
    is_valid_segment(subsystem) && is_valid_segment(reason)
}

fn is_valid_segment(segment: &str) -> bool {
    if segment.is_empty() {
        return false;
    }
    let bytes = segment.as_bytes();
    if !bytes[0].is_ascii_lowercase() {
        return false;
    }
    bytes
        .iter()
        .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || *byte == b'_')
}

fn boxed_error(error: ConformanceError) -> Box<dyn std::error::Error> {
    Box::new(error)
}

/// Local RFC3339 instant parser. Kept here so the result module does
/// not depend on the lib.rs validator helpers being widened to `pub`.
fn is_valid_rfc3339_instant(value: &str) -> bool {
    let Some((date, time_and_offset)) = value.split_once('T') else {
        return false;
    };
    if date.len() != 10
        || date.as_bytes().get(4) != Some(&b'-')
        || date.as_bytes().get(7) != Some(&b'-')
    {
        return false;
    }
    let Some(year) = parse_u32_digits(&date[0..4]) else {
        return false;
    };
    let Some(month) = parse_u32_digits(&date[5..7]) else {
        return false;
    };
    let Some(day) = parse_u32_digits(&date[8..10]) else {
        return false;
    };

    let (time, offset) = if let Some(time) = time_and_offset.strip_suffix('Z') {
        (time, "Z")
    } else if let Some((offset_index, _)) = time_and_offset
        .char_indices()
        .rev()
        .find(|(_, c)| *c == '+' || *c == '-')
    {
        if offset_index == 0 {
            return false;
        }
        (
            &time_and_offset[..offset_index],
            &time_and_offset[offset_index..],
        )
    } else {
        return false;
    };

    if time.len() < 8
        || time.as_bytes().get(2) != Some(&b':')
        || time.as_bytes().get(5) != Some(&b':')
    {
        return false;
    }
    let Some(hour) = parse_u32_digits(&time[0..2]) else {
        return false;
    };
    let Some(minute) = parse_u32_digits(&time[3..5]) else {
        return false;
    };
    let second_text = &time[6..];
    let (second_text, fraction) = second_text
        .split_once('.')
        .map_or((second_text, None), |(second, fraction)| {
            (second, Some(fraction))
        });
    let Some(second) = parse_u32_digits(second_text) else {
        return false;
    };
    if second_text.len() != 2
        || fraction.is_some_and(|fraction| {
            fraction.is_empty() || !fraction.as_bytes().iter().all(u8::is_ascii_digit)
        })
    {
        return false;
    }

    if month == 0
        || month > 12
        || day == 0
        || day > days_in_month(year, month)
        || hour > 23
        || minute > 59
        || second > 59
    {
        return false;
    }

    if offset == "Z" {
        return true;
    }
    if offset.len() != 6 || offset.as_bytes().get(3) != Some(&b':') {
        return false;
    }
    let Some(offset_hour) = parse_u32_digits(&offset[1..3]) else {
        return false;
    };
    let Some(offset_minute) = parse_u32_digits(&offset[4..6]) else {
        return false;
    };
    offset_hour <= 23 && offset_minute <= 59
}

fn parse_u32_digits(value: &str) -> Option<u32> {
    if value.is_empty() || !value.as_bytes().iter().all(u8::is_ascii_digit) {
        return None;
    }
    value.parse().ok()
}

fn days_in_month(year: u32, month: u32) -> u32 {
    match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 if is_leap_year(year) => 29,
        2 => 28,
        _ => 0,
    }
}

fn is_leap_year(year: u32) -> bool {
    year.is_multiple_of(4) && (!year.is_multiple_of(100) || year.is_multiple_of(400))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::runtime_artifact_uri;

    pub(crate) fn baseline_text_line_evidence() -> EvidenceRef {
        EvidenceRef::TextLine {
            line_id: "trace-line-001".to_string(),
        }
    }

    pub(crate) fn baseline_pass_result() -> ConformanceResult {
        ConformanceResult {
            schema_version: CONFORMANCE_SCHEMA_VERSION.to_string(),
            adapter_id: "utsushi-synthetic".to_string(),
            profile_id: ProfileId::TextTrace,
            outcome: ResultOutcome::Pass {
                evidence_tier: EvidenceTier::E1,
            },
            evidence: vec![baseline_text_line_evidence()],
            recorded_at: "2026-06-23T12:00:00Z".to_string(),
        }
    }

    fn fail_result_with_code(code: &str) -> ConformanceResult {
        ConformanceResult {
            outcome: ResultOutcome::Fail {
                semantic_code: code.to_string(),
                detail: "synthetic failure".to_string(),
            },
            evidence: Vec::new(),
            ..baseline_pass_result()
        }
    }

    fn skip_result_with_code(code: &str) -> ConformanceResult {
        ConformanceResult {
            profile_id: ProfileId::FrameCapture,
            outcome: ResultOutcome::Skip {
                semantic_code: code.to_string(),
                reason: "suite filter excluded".to_string(),
            },
            evidence: Vec::new(),
            ..baseline_pass_result()
        }
    }

    fn unsupported_result_with_flag(declared: bool) -> ConformanceResult {
        ConformanceResult {
            profile_id: ProfileId::FrameCapture,
            outcome: ResultOutcome::Unsupported {
                semantic_code: "utsushi.conformance.profile_not_declared".to_string(),
                declared_in_manifest: declared,
            },
            evidence: Vec::new(),
            ..baseline_pass_result()
        }
    }

    #[test]
    fn result_pass_round_trips_through_serde_json() {
        let result = baseline_pass_result();
        let value = result.to_json_value().expect("validates and serializes");
        let restored = ConformanceResult::from_json_value(value).expect("restores");
        assert_eq!(result, restored);
    }

    #[test]
    fn result_fail_round_trips_through_serde_json() {
        let result = fail_result_with_code("utsushi.sink.unsupported_kind");
        let value = result.to_json_value().expect("validates and serializes");
        let restored = ConformanceResult::from_json_value(value).expect("restores");
        assert_eq!(result, restored);
    }

    #[test]
    fn result_skip_round_trips_through_serde_json() {
        let result = skip_result_with_code("utsushi.conformance.profile_not_reported");
        let value = result.to_json_value().expect("validates and serializes");
        let restored = ConformanceResult::from_json_value(value).expect("restores");
        assert_eq!(result, restored);
    }

    #[test]
    fn result_unsupported_round_trips_through_serde_json() {
        let result = unsupported_result_with_flag(false);
        let value = result.to_json_value().expect("validates and serializes");
        let restored = ConformanceResult::from_json_value(value).expect("restores");
        assert_eq!(result, restored);
    }

    #[test]
    fn result_outcome_kind_discriminator_serializes_as_camel_case() {
        let result = baseline_pass_result();
        let value = serde_json::to_value(&result).expect("serializes");
        let outcome = value
            .as_object()
            .and_then(|o| o.get("outcome"))
            .and_then(|v| v.as_object())
            .expect("outcome object");
        assert_eq!(
            outcome.get("kind").and_then(|v| v.as_str()),
            Some("pass"),
            "outcome kind discriminator must be camelCase: {value:?}"
        );
        assert!(
            outcome.contains_key("evidenceTier"),
            "outcome fields must be camelCase: {value:?}"
        );
    }

    #[test]
    fn result_validate_accepts_pass_with_runtime_artifact_evidence() {
        let uri = runtime_artifact_uri("synthetic-run", RuntimeArtifactKind::TraceLog, "trace-001")
            .expect("uri");
        let result = ConformanceResult {
            evidence: vec![EvidenceRef::RuntimeArtifact {
                kind: RuntimeArtifactKind::TraceLog,
                uri,
                artifact_id: Some("trace-001".to_string()),
            }],
            ..baseline_pass_result()
        };
        result.validate().expect("validates");
    }

    #[test]
    fn result_validate_accepts_fail_with_utsushi_sink_semantic_code() {
        let result = fail_result_with_code("utsushi.sink.evidence_tier_mismatch");
        result.validate().expect("validates");
    }

    #[test]
    fn result_validate_accepts_fail_with_kaifuu_provider_semantic_code() {
        let result = fail_result_with_code("kaifuu.profile.unknown_key");
        result.validate().expect("validates");
    }

    #[test]
    fn result_validate_accepts_skip_for_undeclared_profile() {
        let result = skip_result_with_code("utsushi.conformance.profile_not_reported");
        result.validate().expect("validates");
    }

    #[test]
    fn result_validate_rejects_pass_without_evidence() {
        let mut result = baseline_pass_result();
        result.evidence.clear();
        assert!(matches!(
            result.validate(),
            Err(ConformanceError::PassWithoutEvidence { .. })
        ));
    }

    #[test]
    fn result_validate_rejects_pass_with_tier_above_profile_ceiling() {
        let mut result = baseline_pass_result();
        result.outcome = ResultOutcome::Pass {
            evidence_tier: EvidenceTier::E3,
        };
        assert!(matches!(
            result.validate(),
            Err(ConformanceError::EvidenceTierAboveProfileCeiling { .. })
        ));
    }

    #[test]
    fn result_validate_rejects_outcome_with_malformed_semantic_code() {
        let result = fail_result_with_code("not-a-code");
        assert!(matches!(
            result.validate(),
            Err(ConformanceError::MalformedSemanticCode { .. })
        ));
    }

    #[test]
    fn result_validate_rejects_outcome_with_unknown_provider_prefix() {
        let result = fail_result_with_code("rgss3.script.unknown_opcode");
        assert!(matches!(
            result.validate(),
            Err(ConformanceError::MalformedSemanticCode { .. })
        ));
    }

    #[test]
    fn result_validate_rejects_unsupported_when_declared_in_manifest_true() {
        let result = unsupported_result_with_flag(true);
        assert!(matches!(
            result.validate(),
            Err(ConformanceError::DeclaredProfileReportedAsUnsupported { .. })
        ));
    }

    #[test]
    fn result_validate_rejects_recorded_at_not_rfc3339() {
        let mut result = baseline_pass_result();
        result.recorded_at = "not-a-time".to_string();
        assert!(matches!(
            result.validate(),
            Err(ConformanceError::RecordedAtMalformed { .. })
        ));
    }

    #[test]
    fn result_validate_rejects_evidence_ref_runtime_artifact_with_file_scheme() {
        let result = ConformanceResult {
            evidence: vec![EvidenceRef::RuntimeArtifact {
                kind: RuntimeArtifactKind::TraceLog,
                uri: "file:///tmp/leak.json".to_string(),
                artifact_id: None,
            }],
            ..baseline_pass_result()
        };
        assert!(matches!(
            result.validate(),
            Err(ConformanceError::EvidenceRefInvalid {
                artifact_kind: "runtime_artifact",
                ..
            })
        ));
    }

    #[test]
    fn result_validate_rejects_evidence_ref_runtime_artifact_outside_managed_root() {
        let result = ConformanceResult {
            evidence: vec![EvidenceRef::RuntimeArtifact {
                kind: RuntimeArtifactKind::TraceLog,
                uri: "not/the/managed/root/trace.json".to_string(),
                artifact_id: None,
            }],
            ..baseline_pass_result()
        };
        assert!(matches!(
            result.validate(),
            Err(ConformanceError::EvidenceRefInvalid {
                artifact_kind: "runtime_artifact",
                ..
            })
        ));
    }

    #[test]
    fn result_validate_rejects_evidence_ref_text_line_with_whitespace_id() {
        let result = ConformanceResult {
            evidence: vec![EvidenceRef::TextLine {
                line_id: "has space".to_string(),
            }],
            ..baseline_pass_result()
        };
        assert!(matches!(
            result.validate(),
            Err(ConformanceError::EvidenceRefInvalid {
                artifact_kind: "text_line",
                ..
            })
        ));
    }

    #[test]
    fn result_validate_rejects_evidence_ref_bridge_unit_with_local_path_substring() {
        let result = ConformanceResult {
            evidence: vec![EvidenceRef::BridgeUnit {
                bridge_unit_id: "/home/user/leak".to_string(),
            }],
            ..baseline_pass_result()
        };
        assert!(matches!(
            result.validate(),
            Err(ConformanceError::EvidenceRefInvalid {
                artifact_kind: "bridge_unit",
                ..
            })
        ));
    }

    // ---- UTSUSHI-028: EvidenceRef::StatePath ----

    #[test]
    fn evidence_ref_state_path_round_trips_through_serde_json() {
        let evidence = EvidenceRef::StatePath {
            path: "port.frame".to_string(),
        };
        let value = serde_json::to_value(&evidence).expect("serializes");
        let restored: EvidenceRef = serde_json::from_value(value).expect("deserializes");
        assert_eq!(restored, evidence);
    }

    #[test]
    fn evidence_ref_state_path_serializes_as_artifact_kind_camel_case_state_path() {
        let evidence = EvidenceRef::StatePath {
            path: "port.frame".to_string(),
        };
        let value = serde_json::to_value(&evidence).expect("serializes");
        let object = value.as_object().expect("object");
        assert_eq!(
            object.get("artifactKind").and_then(|v| v.as_str()),
            Some("statePath"),
            "wire tag must be camelCase statePath: {value:?}"
        );
        assert_eq!(
            object.get("path").and_then(|v| v.as_str()),
            Some("port.frame"),
            "path field preserved verbatim: {value:?}"
        );
    }

    #[test]
    fn evidence_ref_state_path_validate_accepts_canonical_path() {
        EvidenceRef::StatePath {
            path: "port.frame".to_string(),
        }
        .validate()
        .expect("validates");
    }

    #[test]
    fn evidence_ref_state_path_validate_rejects_empty_path() {
        let err = EvidenceRef::StatePath {
            path: String::new(),
        }
        .validate()
        .expect_err("empty");
        assert!(matches!(
            err,
            ConformanceError::EvidenceRefInvalid {
                artifact_kind: "state_path",
                ..
            }
        ));
    }

    #[test]
    fn evidence_ref_state_path_validate_rejects_path_with_whitespace() {
        let err = EvidenceRef::StatePath {
            path: "port frame".to_string(),
        }
        .validate()
        .expect_err("whitespace");
        assert!(matches!(
            err,
            ConformanceError::EvidenceRefInvalid {
                artifact_kind: "state_path",
                ..
            }
        ));
    }

    #[test]
    fn evidence_ref_state_path_validate_rejects_path_that_looks_like_local_path() {
        let err = EvidenceRef::StatePath {
            path: "/home/user/leak".to_string(),
        }
        .validate()
        .expect_err("local path");
        assert!(matches!(
            err,
            ConformanceError::EvidenceRefInvalid {
                artifact_kind: "state_path",
                ..
            }
        ));
    }

    #[test]
    fn evidence_ref_state_path_validate_rejects_path_with_unknown_namespace() {
        let err = EvidenceRef::StatePath {
            path: "unknown.frame".to_string(),
        }
        .validate()
        .expect_err("unknown namespace");
        assert!(matches!(
            err,
            ConformanceError::EvidenceRefInvalid {
                artifact_kind: "state_path",
                ..
            }
        ));
    }

    #[test]
    fn evidence_ref_state_path_validate_rejects_path_with_uppercase_segment() {
        let err = EvidenceRef::StatePath {
            path: "Port.frame".to_string(),
        }
        .validate()
        .expect_err("uppercase");
        assert!(matches!(
            err,
            ConformanceError::EvidenceRefInvalid {
                artifact_kind: "state_path",
                ..
            }
        ));
    }

    #[test]
    fn every_existing_evidence_ref_variant_still_round_trips_through_serde() {
        // Belt-and-suspenders: the additive variant must not perturb
        // the existing variants' wire shape.
        let uri = crate::runtime_artifact_uri(
            "synthetic-run",
            crate::RuntimeArtifactKind::TraceLog,
            "trace-001",
        )
        .expect("uri");
        let variants = vec![
            EvidenceRef::RuntimeArtifact {
                kind: crate::RuntimeArtifactKind::TraceLog,
                uri,
                artifact_id: Some("trace-001".to_string()),
            },
            EvidenceRef::TextLine {
                line_id: "trace-line-001".to_string(),
            },
            EvidenceRef::FrameArtifactRef {
                frame_id: "frame-0001".to_string(),
            },
            EvidenceRef::ReplayLogRef {
                run_id: "run-001".to_string(),
            },
            EvidenceRef::ImplMapFixture {
                fixture_id: "fixture-a".to_string(),
            },
            EvidenceRef::BridgeUnit {
                bridge_unit_id: "bridge-unit-001".to_string(),
            },
        ];
        for variant in variants {
            let value = serde_json::to_value(&variant).expect("serializes");
            let restored: EvidenceRef = serde_json::from_value(value).expect("deserializes");
            assert_eq!(restored, variant);
            variant.validate().expect("validates");
        }
    }

    #[test]
    fn result_pass_with_state_path_evidence_validates() {
        let result = ConformanceResult {
            profile_id: ProfileId::SnapshotRestore,
            evidence: vec![EvidenceRef::StatePath {
                path: "port.frame".to_string(),
            }],
            ..baseline_pass_result()
        };
        result.validate().expect("validates");
    }
}
