use serde_json::Value;

use super::runtime_report::{
    optional_non_blank_field, parse_evidence_tier_field, require_non_blank_field,
    require_one_of_field, require_positive_u64_field, require_u64_field, require_uuid7_field,
    required_value_array, value_object,
};
use crate::{UtsushiResult, validate_runtime_artifact_uri};

pub(super) fn validate_runtime_trace_event_value(value: &Value, label: &str) -> UtsushiResult<()> {
    let event = value_object(value, label)?;
    require_uuid7_field(event, "traceEventId", &format!("{label}.traceEventId"))?;
    require_non_blank_field(event, "eventKind", &format!("{label}.eventKind"))?;
    validate_runtime_bridge_unit_ref_value(
        event
            .get("bridgeUnitRef")
            .ok_or_else(|| format!("{label}.bridgeUnitRef is required"))?,
        &format!("{label}.bridgeUnitRef"),
    )?;
    require_u64_field(event, "frame", &format!("{label}.frame"))?;
    Ok(())
}

pub(super) fn validate_runtime_branch_event_value(value: &Value, label: &str) -> UtsushiResult<()> {
    let event = value_object(value, label)?;
    require_uuid7_field(event, "branchEventId", &format!("{label}.branchEventId"))?;
    require_non_blank_field(event, "branchKind", &format!("{label}.branchKind"))?;
    validate_runtime_bridge_unit_ref_value(
        event
            .get("bridgeUnitRef")
            .ok_or_else(|| format!("{label}.bridgeUnitRef is required"))?,
        &format!("{label}.bridgeUnitRef"),
    )?;
    Ok(())
}

pub(super) fn validate_runtime_capture_value(value: &Value, label: &str) -> UtsushiResult<()> {
    let capture = value_object(value, label)?;
    require_uuid7_field(capture, "captureId", &format!("{label}.captureId"))?;
    validate_runtime_bridge_unit_ref_value(
        capture
            .get("bridgeUnitRef")
            .ok_or_else(|| format!("{label}.bridgeUnitRef is required"))?,
        &format!("{label}.bridgeUnitRef"),
    )?;
    parse_evidence_tier_field(capture, "evidenceTier", &format!("{label}.evidenceTier"))?;
    require_u64_field(capture, "frame", &format!("{label}.frame"))?;
    require_positive_u64_field(capture, "width", &format!("{label}.width"))?;
    require_positive_u64_field(capture, "height", &format!("{label}.height"))?;
    validate_runtime_artifact_ref_value(
        capture
            .get("artifactRef")
            .ok_or_else(|| format!("{label}.artifactRef is required"))?,
        &format!("{label}.artifactRef"),
        Some("screenshot"),
    )
}

pub(super) fn validate_runtime_recording_value(value: &Value, label: &str) -> UtsushiResult<()> {
    let recording = value_object(value, label)?;
    require_uuid7_field(recording, "recordingId", &format!("{label}.recordingId"))?;
    require_u64_field(
        recording,
        "startedAtFrame",
        &format!("{label}.startedAtFrame"),
    )?;
    require_positive_u64_field(recording, "frameCount", &format!("{label}.frameCount"))?;
    require_positive_u64_field(recording, "width", &format!("{label}.width"))?;
    require_positive_u64_field(recording, "height", &format!("{label}.height"))?;
    require_non_blank_field(recording, "encoding", &format!("{label}.encoding"))?;
    validate_runtime_artifact_ref_value(
        recording
            .get("artifactRef")
            .ok_or_else(|| format!("{label}.artifactRef is required"))?,
        &format!("{label}.artifactRef"),
        Some("recording"),
    )
}

pub(super) fn validate_runtime_approximation_value(
    value: &Value,
    label: &str,
) -> UtsushiResult<()> {
    let approximation = value_object(value, label)?;
    require_uuid7_field(
        approximation,
        "approximationId",
        &format!("{label}.approximationId"),
    )?;
    require_one_of_field(
        approximation,
        "approximationTier",
        &[
            "none",
            "deterministic_fixture",
            "layout_probe",
            "engine_partial",
            "reference_matched",
        ],
        &format!("{label}.approximationTier"),
    )?;
    require_non_blank_field(approximation, "scope", &format!("{label}.scope"))?;
    require_non_blank_field(
        approximation,
        "description",
        &format!("{label}.description"),
    )?;
    let refs = required_value_array(
        approximation,
        "affectedBridgeUnitRefs",
        &format!("{label}.affectedBridgeUnitRefs"),
    )?;
    if refs.is_empty() {
        return Err(format!("{label}.affectedBridgeUnitRefs must not be empty").into());
    }
    for (index, unit_ref) in refs.iter().enumerate() {
        validate_runtime_bridge_unit_ref_value(
            unit_ref,
            &format!("{label}.affectedBridgeUnitRefs[{index}]"),
        )?;
    }
    parse_evidence_tier_field(
        approximation,
        "evidenceTierCeiling",
        &format!("{label}.evidenceTierCeiling"),
    )?;
    Ok(())
}

pub(super) fn validate_runtime_validation_finding_value(
    value: &Value,
    label: &str,
) -> UtsushiResult<()> {
    let finding = value_object(value, label)?;
    require_uuid7_field(finding, "findingId", &format!("{label}.findingId"))?;
    require_non_blank_field(finding, "findingKind", &format!("{label}.findingKind"))?;
    require_non_blank_field(finding, "severity", &format!("{label}.severity"))?;
    require_non_blank_field(finding, "message", &format!("{label}.message"))?;
    parse_evidence_tier_field(finding, "evidenceTier", &format!("{label}.evidenceTier"))?;
    Ok(())
}

fn validate_runtime_bridge_unit_ref_value(value: &Value, label: &str) -> UtsushiResult<()> {
    let unit_ref = value_object(value, label)?;
    require_non_blank_field(unit_ref, "bridgeUnitId", &format!("{label}.bridgeUnitId"))?;
    optional_non_blank_field(unit_ref, "sourceUnitKey", &format!("{label}.sourceUnitKey"))?;
    Ok(())
}

fn validate_runtime_artifact_ref_value(
    value: &Value,
    label: &str,
    expected_kind: Option<&str>,
) -> UtsushiResult<()> {
    let artifact_ref = value_object(value, label)?;
    require_uuid7_field(artifact_ref, "artifactId", &format!("{label}.artifactId"))?;
    let kind = require_non_blank_field(
        artifact_ref,
        "artifactKind",
        &format!("{label}.artifactKind"),
    )?;
    if let Some(expected_kind) = expected_kind
        && kind != expected_kind
    {
        return Err(format!("{label}.artifactKind must be {expected_kind}").into());
    }
    validate_runtime_artifact_uri(require_non_blank_field(
        artifact_ref,
        "uri",
        &format!("{label}.uri"),
    )?)?;
    optional_non_blank_field(artifact_ref, "mediaType", &format!("{label}.mediaType"))?;
    Ok(())
}
