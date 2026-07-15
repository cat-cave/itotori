use std::collections::HashSet;

use serde_json::Value;

use crate::BridgeContractResult;

use super::{
    RUNTIME_EVIDENCE_TIERS, TRIAGE_SEVERITIES, as_record, assert_hash_value,
    assert_minimum_runtime_evidence_tier, assert_portable_uri,
    assert_required_non_negative_integer, assert_required_one_of, assert_required_positive_integer,
    assert_required_string, assert_required_uuid7, assert_uuid7, error, non_negative_integer_value,
    positive_integer_value, required, required_array, string_value,
};

pub(super) fn validate_runtime_trace_event(value: &Value, label: &str) -> BridgeContractResult<()> {
    let event = as_record(value, label)?;
    assert_required_uuid7(event, "traceEventId", &format!("{label}.traceEventId"))?;
    assert_required_one_of(
        event,
        "eventKind",
        &[
            "scene_entered",
            "text_observed",
            "branch_point_reached",
            "capture_requested",
        ],
        &format!("{label}.eventKind"),
    )?;
    validate_runtime_bridge_unit_ref(
        required(event, "bridgeUnitRef", &format!("{label}.bridgeUnitRef"))?,
        &format!("{label}.bridgeUnitRef"),
    )?;
    assert_required_non_negative_integer(event, "frame", &format!("{label}.frame"))?;
    for key in ["traceKey", "observedText"] {
        if let Some(value) = event.get(key) {
            string_value(value, &format!("{label}.{key}"))?;
        }
    }
    if let Some(artifact_ref) = event.get("artifactRef") {
        validate_runtime_artifact_ref(artifact_ref, &format!("{label}.artifactRef"), None)?;
    }
    Ok(())
}

pub(super) fn validate_runtime_branch_event(
    value: &Value,
    label: &str,
) -> BridgeContractResult<()> {
    let event = as_record(value, label)?;
    assert_required_uuid7(event, "branchEventId", &format!("{label}.branchEventId"))?;
    validate_runtime_bridge_unit_ref(
        required(event, "bridgeUnitRef", &format!("{label}.bridgeUnitRef"))?,
        &format!("{label}.bridgeUnitRef"),
    )?;
    assert_required_non_negative_integer(event, "frame", &format!("{label}.frame"))?;
    for key in ["branchPointKey", "promptText"] {
        if let Some(value) = event.get(key) {
            string_value(value, &format!("{label}.{key}"))?;
        }
    }
    let options = required_array(event, "options", &format!("{label}.options"))?;
    if options.is_empty() {
        return error(format!(
            "{label}.options must contain at least one branch option"
        ));
    }
    let mut option_ids = HashSet::new();
    for (index, option) in options.iter().enumerate() {
        let option_label = format!("{label}.options[{index}]");
        let option_id = validate_runtime_branch_option(option, &option_label)?;
        if !option_ids.insert(option_id) {
            return error(format!(
                "{option_label}.optionId must be unique within {label}.options"
            ));
        }
    }
    if let Some(selected_option_id) = event.get("selectedOptionId") {
        let selected_option_id =
            string_value(selected_option_id, &format!("{label}.selectedOptionId"))?;
        assert_uuid7(selected_option_id, &format!("{label}.selectedOptionId"))?;
        if !option_ids.contains(selected_option_id) {
            return error(format!(
                "{label}.selectedOptionId must reference an option in {label}.options"
            ));
        }
    }
    Ok(())
}

pub(super) fn validate_runtime_branch_option(
    value: &Value,
    label: &str,
) -> BridgeContractResult<String> {
    let option = as_record(value, label)?;
    let option_id = assert_required_uuid7(option, "optionId", &format!("{label}.optionId"))?;
    if let Some(label_value) = option.get("label") {
        string_value(label_value, &format!("{label}.label"))?;
    }
    if let Some(label_ref) = option.get("labelBridgeUnitRef") {
        validate_runtime_bridge_unit_ref(label_ref, &format!("{label}.labelBridgeUnitRef"))?;
    }
    if let Some(target_route_key) = option.get("targetRouteKey") {
        string_value(target_route_key, &format!("{label}.targetRouteKey"))?;
    }
    if let Some(target_ref) = option.get("targetBridgeUnitRef") {
        validate_runtime_bridge_unit_ref(target_ref, &format!("{label}.targetBridgeUnitRef"))?;
    }
    Ok(option_id.to_string())
}

pub(super) fn validate_runtime_capture(value: &Value, label: &str) -> BridgeContractResult<()> {
    let capture = as_record(value, label)?;
    assert_required_uuid7(capture, "captureId", &format!("{label}.captureId"))?;
    validate_runtime_bridge_unit_ref(
        required(capture, "bridgeUnitRef", &format!("{label}.bridgeUnitRef"))?,
        &format!("{label}.bridgeUnitRef"),
    )?;
    let evidence_tier = assert_required_one_of(
        capture,
        "evidenceTier",
        RUNTIME_EVIDENCE_TIERS,
        &format!("{label}.evidenceTier"),
    )?;
    assert_minimum_runtime_evidence_tier(evidence_tier, "E2", &format!("{label}.evidenceTier"))?;
    assert_required_non_negative_integer(capture, "frame", &format!("{label}.frame"))?;
    assert_required_positive_integer(capture, "width", &format!("{label}.width"))?;
    assert_required_positive_integer(capture, "height", &format!("{label}.height"))?;
    if let Some(non_zero_pixels) = capture.get("nonZeroPixels") {
        non_negative_integer_value(non_zero_pixels, &format!("{label}.nonZeroPixels"))?;
    }
    if let Some(region) = capture.get("region") {
        super::validate_pixel_region(region, &format!("{label}.region"))?;
    }
    validate_runtime_artifact_ref(
        required(capture, "artifactRef", &format!("{label}.artifactRef"))?,
        &format!("{label}.artifactRef"),
        Some("screenshot"),
    )
}

pub(super) fn validate_runtime_recording(value: &Value, label: &str) -> BridgeContractResult<()> {
    let recording = as_record(value, label)?;
    assert_required_uuid7(recording, "recordingId", &format!("{label}.recordingId"))?;
    validate_runtime_bridge_unit_ref(
        required(
            recording,
            "bridgeUnitRef",
            &format!("{label}.bridgeUnitRef"),
        )?,
        &format!("{label}.bridgeUnitRef"),
    )?;
    let evidence_tier = assert_required_one_of(
        recording,
        "evidenceTier",
        RUNTIME_EVIDENCE_TIERS,
        &format!("{label}.evidenceTier"),
    )?;
    assert_minimum_runtime_evidence_tier(evidence_tier, "E3", &format!("{label}.evidenceTier"))?;
    assert_required_non_negative_integer(
        recording,
        "startedAtFrame",
        &format!("{label}.startedAtFrame"),
    )?;
    assert_required_positive_integer(recording, "frameCount", &format!("{label}.frameCount"))?;
    assert_required_positive_integer(recording, "width", &format!("{label}.width"))?;
    assert_required_positive_integer(recording, "height", &format!("{label}.height"))?;
    assert_required_string(recording, "encoding", &format!("{label}.encoding"))?;
    validate_runtime_artifact_ref(
        required(recording, "artifactRef", &format!("{label}.artifactRef"))?,
        &format!("{label}.artifactRef"),
        Some("recording"),
    )
}

pub(super) fn validate_runtime_approximation(
    value: &Value,
    label: &str,
) -> BridgeContractResult<()> {
    let approximation = as_record(value, label)?;
    assert_required_uuid7(
        approximation,
        "approximationId",
        &format!("{label}.approximationId"),
    )?;
    assert_required_one_of(
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
    assert_required_string(approximation, "scope", &format!("{label}.scope"))?;
    assert_required_string(
        approximation,
        "description",
        &format!("{label}.description"),
    )?;
    let refs = required_array(
        approximation,
        "affectedBridgeUnitRefs",
        &format!("{label}.affectedBridgeUnitRefs"),
    )?;
    if refs.is_empty() {
        return error(format!(
            "{label}.affectedBridgeUnitRefs must contain at least one bridge unit ref"
        ));
    }
    for (index, unit_ref) in refs.iter().enumerate() {
        validate_runtime_bridge_unit_ref(
            unit_ref,
            &format!("{label}.affectedBridgeUnitRefs[{index}]"),
        )?;
    }
    assert_required_one_of(
        approximation,
        "evidenceTierCeiling",
        RUNTIME_EVIDENCE_TIERS,
        &format!("{label}.evidenceTierCeiling"),
    )?;
    Ok(())
}

pub(super) fn validate_runtime_validation_finding(
    value: &Value,
    label: &str,
) -> BridgeContractResult<()> {
    let finding = as_record(value, label)?;
    assert_required_uuid7(finding, "findingId", &format!("{label}.findingId"))?;
    assert_required_one_of(
        finding,
        "findingKind",
        &[
            "missing_trace",
            "missing_capture",
            "text_mismatch",
            "artifact_unreadable",
            "unsupported_runtime_feature",
            "schema_violation",
        ],
        &format!("{label}.findingKind"),
    )?;
    assert_required_one_of(
        finding,
        "severity",
        TRIAGE_SEVERITIES,
        &format!("{label}.severity"),
    )?;
    if let Some(unit_ref) = finding.get("bridgeUnitRef") {
        validate_runtime_bridge_unit_ref(unit_ref, &format!("{label}.bridgeUnitRef"))?;
    }
    if let Some(artifact_ref) = finding.get("artifactRef") {
        validate_runtime_artifact_ref(artifact_ref, &format!("{label}.artifactRef"), None)?;
    }
    assert_required_string(finding, "message", &format!("{label}.message"))?;
    assert_required_one_of(
        finding,
        "evidenceTier",
        RUNTIME_EVIDENCE_TIERS,
        &format!("{label}.evidenceTier"),
    )?;
    Ok(())
}

pub(super) fn validate_runtime_reference_comparison(
    value: &Value,
    label: &str,
) -> BridgeContractResult<bool> {
    let comparison = as_record(value, label)?;
    assert_required_uuid7(comparison, "comparisonId", &format!("{label}.comparisonId"))?;
    assert_required_one_of(
        comparison,
        "comparisonKind",
        &["reference_runtime", "conformance_fixture"],
        &format!("{label}.comparisonKind"),
    )?;
    let status = assert_required_one_of(
        comparison,
        "status",
        &["passed", "failed"],
        &format!("{label}.status"),
    )?;
    assert_required_string(comparison, "scope", &format!("{label}.scope"))?;
    let refs = required_array(
        comparison,
        "coveredBridgeUnitRefs",
        &format!("{label}.coveredBridgeUnitRefs"),
    )?;
    if refs.is_empty() {
        return error(format!(
            "{label}.coveredBridgeUnitRefs must contain at least one bridge unit ref"
        ));
    }
    for (index, unit_ref) in refs.iter().enumerate() {
        validate_runtime_bridge_unit_ref(
            unit_ref,
            &format!("{label}.coveredBridgeUnitRefs[{index}]"),
        )?;
    }
    validate_runtime_artifact_ref(
        required(comparison, "artifactRef", &format!("{label}.artifactRef"))?,
        &format!("{label}.artifactRef"),
        Some("reference_comparison"),
    )?;
    Ok(status == "passed")
}

pub(super) fn validate_runtime_bridge_unit_ref(
    value: &Value,
    label: &str,
) -> BridgeContractResult<()> {
    let unit_ref = as_record(value, label)?;
    assert_required_string(unit_ref, "bridgeUnitId", &format!("{label}.bridgeUnitId"))?;
    if let Some(source_unit_key) = unit_ref.get("sourceUnitKey") {
        string_value(source_unit_key, &format!("{label}.sourceUnitKey"))?;
    }
    Ok(())
}

pub(super) fn validate_runtime_artifact_ref(
    value: &Value,
    label: &str,
    expected_kind: Option<&str>,
) -> BridgeContractResult<()> {
    let artifact_ref = as_record(value, label)?;
    assert_required_uuid7(artifact_ref, "artifactId", &format!("{label}.artifactId"))?;
    let kind = assert_required_one_of(
        artifact_ref,
        "artifactKind",
        &[
            "trace_log",
            "screenshot",
            "recording",
            "capture_metadata",
            "reference_comparison",
            "runtime_report",
        ],
        &format!("{label}.artifactKind"),
    )?;
    if let Some(expected_kind) = expected_kind
        && kind != expected_kind
    {
        return error(format!("{label}.artifactKind must be {expected_kind}"));
    }
    assert_portable_uri(
        required(artifact_ref, "uri", &format!("{label}.uri"))?,
        &format!("{label}.uri"),
    )?;
    if let Some(hash) = artifact_ref.get("hash") {
        assert_hash_value(hash, &format!("{label}.hash"))?;
    }
    if let Some(media_type) = artifact_ref.get("mediaType") {
        string_value(media_type, &format!("{label}.mediaType"))?;
    }
    if let Some(byte_size) = artifact_ref.get("byteSize") {
        positive_integer_value(byte_size, &format!("{label}.byteSize"))?;
    }
    Ok(())
}
