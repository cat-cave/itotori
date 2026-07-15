use std::str::FromStr;

use serde_json::{Map, Value};

use super::rfc3339::validate_rfc3339_instant_metadata;
use super::runtime_report_capabilities::{
    validate_controlled_playback_session_value, validate_controlled_playback_surface,
    validate_runtime_capability_contract_value,
};
use super::runtime_report_events::{
    validate_runtime_approximation_value, validate_runtime_branch_event_value,
    validate_runtime_capture_value, validate_runtime_recording_value,
    validate_runtime_trace_event_value, validate_runtime_validation_finding_value,
};
use crate::{EvidenceTier, FidelityTier, UtsushiResult};

pub fn validate_runtime_evidence_report_value(report: &Value) -> UtsushiResult<()> {
    let report = value_object(report, "RuntimeEvidenceReportV02")?;
    require_literal(
        report,
        "schemaVersion",
        "0.2.0",
        "RuntimeEvidenceReportV02.schemaVersion",
    )?;
    require_uuid7_field(
        report,
        "runtimeReportId",
        "RuntimeEvidenceReportV02.runtimeReportId",
    )?;
    optional_uuid7_field(
        report,
        "sourceBridgeId",
        "RuntimeEvidenceReportV02.sourceBridgeId",
    )?;
    optional_non_blank_field(
        report,
        "sourceBundleHash",
        "RuntimeEvidenceReportV02.sourceBundleHash",
    )?;
    optional_non_blank_field(
        report,
        "sourceLocale",
        "RuntimeEvidenceReportV02.sourceLocale",
    )?;
    optional_non_blank_field(
        report,
        "targetLocale",
        "RuntimeEvidenceReportV02.targetLocale",
    )?;
    let adapter_name = require_non_blank_field(
        report,
        "adapterName",
        "RuntimeEvidenceReportV02.adapterName",
    )?;
    let adapter_version = require_non_blank_field(
        report,
        "adapterVersion",
        "RuntimeEvidenceReportV02.adapterVersion",
    )?;
    let fidelity_tier = parse_fidelity_tier_field(
        report,
        "fidelityTier",
        "RuntimeEvidenceReportV02.fidelityTier",
    )?;
    let evidence_tier = parse_evidence_tier_field(
        report,
        "evidenceTier",
        "RuntimeEvidenceReportV02.evidenceTier",
    )?;
    if evidence_tier > fidelity_tier.evidence_ceiling() {
        return Err(format!(
            "RuntimeEvidenceReportV02.evidenceTier must not exceed {} for the declared fidelityTier",
            fidelity_tier.evidence_ceiling().as_str()
        )
        .into());
    }
    let status = require_one_of_field(
        report,
        "status",
        &["passed", "failed"],
        "RuntimeEvidenceReportV02.status",
    )?;
    let created_at =
        require_non_blank_field(report, "createdAt", "RuntimeEvidenceReportV02.createdAt")?;
    validate_rfc3339_instant_metadata("RuntimeEvidenceReportV02.createdAt", created_at)?;

    let trace_events = required_value_array(
        report,
        "traceEvents",
        "RuntimeEvidenceReportV02.traceEvents",
    )?;
    for (index, event) in trace_events.iter().enumerate() {
        validate_runtime_trace_event_value(
            event,
            &format!("RuntimeEvidenceReportV02.traceEvents[{index}]"),
        )?;
    }
    let branch_events = required_value_array(
        report,
        "branchEvents",
        "RuntimeEvidenceReportV02.branchEvents",
    )?;
    for (index, event) in branch_events.iter().enumerate() {
        validate_runtime_branch_event_value(
            event,
            &format!("RuntimeEvidenceReportV02.branchEvents[{index}]"),
        )?;
    }
    // the per-event observation envelope validation that
    // previously round-tripped each entry through `deleted-hook-envelope`
    // is replaced by a structural shape check. The full wire-shape
    // contract lives in `kaifuu-core::contracts::validate_runtime_evidence_report_v02`
    // (which validates every field of `observationHookEvents[]` against
    // the runtime evidence contract); the `utsushi-core` validator only
    // enforces (a) the array is well-shaped, (b) each entry carries an
    // `evidenceTier` that does not exceed the report's declared
    // evidence tier.
    let observation_events = optional_value_array(
        report,
        "observationHookEvents",
        "RuntimeEvidenceReportV02.observationHookEvents",
    )?;
    for (index, event) in observation_events.iter().enumerate() {
        let event_object = event.as_object().ok_or_else(|| {
            format!("RuntimeEvidenceReportV02.observationHookEvents[{index}] must be an object")
        })?;
        let event_tier_str = event_object
            .get("evidenceTier")
            .and_then(Value::as_str)
            .ok_or_else(|| {
                format!(
                    "RuntimeEvidenceReportV02.observationHookEvents[{index}].evidenceTier must be present"
                )
            })?;
        let event_tier = EvidenceTier::from_str(event_tier_str).map_err(|_| {
            format!(
                "RuntimeEvidenceReportV02.observationHookEvents[{index}].evidenceTier {event_tier_str} is not a recognised tier"
            )
        })?;
        if event_tier > evidence_tier {
            return Err(format!(
                "RuntimeEvidenceReportV02.observationHookEvents[{index}].evidenceTier must not exceed report evidenceTier {}",
                evidence_tier.as_str()
            )
            .into());
        }
    }
    let captures = required_value_array(report, "captures", "RuntimeEvidenceReportV02.captures")?;
    for (index, capture) in captures.iter().enumerate() {
        validate_runtime_capture_value(
            capture,
            &format!("RuntimeEvidenceReportV02.captures[{index}]"),
        )?;
    }
    let recordings =
        required_value_array(report, "recordings", "RuntimeEvidenceReportV02.recordings")?;
    for (index, recording) in recordings.iter().enumerate() {
        validate_runtime_recording_value(
            recording,
            &format!("RuntimeEvidenceReportV02.recordings[{index}]"),
        )?;
    }
    let approximations = required_value_array(
        report,
        "approximations",
        "RuntimeEvidenceReportV02.approximations",
    )?;
    for (index, approximation) in approximations.iter().enumerate() {
        validate_runtime_approximation_value(
            approximation,
            &format!("RuntimeEvidenceReportV02.approximations[{index}]"),
        )?;
    }
    let findings = required_value_array(
        report,
        "validationFindings",
        "RuntimeEvidenceReportV02.validationFindings",
    )?;
    for (index, finding) in findings.iter().enumerate() {
        validate_runtime_validation_finding_value(
            finding,
            &format!("RuntimeEvidenceReportV02.validationFindings[{index}]"),
        )?;
    }
    let reference_comparisons = optional_value_array(
        report,
        "referenceComparisons",
        "RuntimeEvidenceReportV02.referenceComparisons",
    )?;
    validate_string_array_field(
        report,
        "limitations",
        "RuntimeEvidenceReportV02.limitations",
    )?;

    if let Some(runtime_capabilities) = report.get("runtimeCapabilities") {
        validate_runtime_capability_contract_value(
            runtime_capabilities,
            "RuntimeEvidenceReportV02.runtimeCapabilities",
            fidelity_tier,
            evidence_tier,
        )?;
    }
    if let Some(session) = report.get("controlledPlaybackSession") {
        validate_controlled_playback_session_value(
            session,
            adapter_name,
            adapter_version,
            fidelity_tier,
            evidence_tier,
            status,
            report.get("runtimeCapabilities"),
        )?;
        let operation = value_object(
            session,
            "RuntimeEvidenceReportV02.controlledPlaybackSession",
        )
        .and_then(|session| {
            require_one_of_field(
                session,
                "requestedOperation",
                &[
                    "trace",
                    "branch_discovery",
                    "capture",
                    "smoke_validation",
                    "replay_review",
                ],
                "RuntimeEvidenceReportV02.controlledPlaybackSession.requestedOperation",
            )
        })?;
        validate_controlled_playback_surface(
            operation,
            !branch_events.is_empty(),
            !captures.is_empty(),
            !recordings.is_empty(),
            !reference_comparisons.is_empty(),
        )?;
    }

    if trace_events.is_empty()
        && branch_events.is_empty()
        && observation_events.is_empty()
        && captures.is_empty()
        && recordings.is_empty()
    {
        return Err("RuntimeEvidenceReportV02 must contain trace, observation hook, capture, branch, or recording evidence".into());
    }
    if !captures.is_empty() && evidence_tier < EvidenceTier::E2 {
        return Err(
            "RuntimeEvidenceReportV02.evidenceTier must be at least E2 when captures are present"
                .into(),
        );
    }
    if !recordings.is_empty() && evidence_tier < EvidenceTier::E3 {
        return Err(
            "RuntimeEvidenceReportV02.evidenceTier must be at least E3 when recordings are present"
                .into(),
        );
    }
    if fidelity_tier != FidelityTier::ReferenceFidelity && approximations.is_empty() {
        return Err(
            "RuntimeEvidenceReportV02.approximations must document non-reference runtime limits"
                .into(),
        );
    }
    if (fidelity_tier == FidelityTier::ReferenceFidelity || evidence_tier == EvidenceTier::E4)
        && reference_comparisons.is_empty()
    {
        return Err("RuntimeEvidenceReportV02.referenceComparisons must include reference-runtime or conformance comparison evidence for E4/reference_fidelity claims".into());
    }
    if status == "failed" && findings.is_empty() {
        return Err(
            "RuntimeEvidenceReportV02.validationFindings must explain failed runtime evidence"
                .into(),
        );
    }
    Ok(())
}

pub(super) fn value_object<'a>(
    value: &'a Value,
    label: &str,
) -> UtsushiResult<&'a Map<String, Value>> {
    value
        .as_object()
        .ok_or_else(|| format!("{label} must be an object").into())
}

pub(super) fn require_literal<'a>(
    object: &'a Map<String, Value>,
    field: &str,
    expected: &str,
    label: &str,
) -> UtsushiResult<&'a str> {
    let value = require_non_blank_field(object, field, label)?;
    if value != expected {
        return Err(format!("{label} must be {expected}").into());
    }
    Ok(value)
}

pub(super) fn require_non_blank_field<'a>(
    object: &'a Map<String, Value>,
    field: &str,
    label: &str,
) -> UtsushiResult<&'a str> {
    object
        .get(field)
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| format!("{label} must be a non-empty string").into())
}

pub(super) fn optional_non_blank_field<'a>(
    object: &'a Map<String, Value>,
    field: &str,
    label: &str,
) -> UtsushiResult<Option<&'a str>> {
    object
        .get(field)
        .map(|_| require_non_blank_field(object, field, label))
        .transpose()
}

pub(super) fn require_uuid7_field<'a>(
    object: &'a Map<String, Value>,
    field: &str,
    label: &str,
) -> UtsushiResult<&'a str> {
    let value = require_non_blank_field(object, field, label)?;
    validate_uuid7(value, label)?;
    Ok(value)
}

fn optional_uuid7_field<'a>(
    object: &'a Map<String, Value>,
    field: &str,
    label: &str,
) -> UtsushiResult<Option<&'a str>> {
    object
        .get(field)
        .map(|_| require_uuid7_field(object, field, label))
        .transpose()
}

fn validate_uuid7(value: &str, label: &str) -> UtsushiResult<()> {
    let bytes = value.as_bytes();
    let valid = bytes.len() == 36
        && bytes[8] == b'-'
        && bytes[13] == b'-'
        && bytes[18] == b'-'
        && bytes[23] == b'-'
        && bytes[14] == b'7'
        && matches!(bytes[19], b'8' | b'9' | b'a' | b'b' | b'A' | b'B')
        && bytes
            .iter()
            .enumerate()
            .all(|(index, byte)| matches!(index, 8 | 13 | 18 | 23) || byte.is_ascii_hexdigit());
    if valid {
        Ok(())
    } else {
        Err(format!("{label} must be a UUID7 string").into())
    }
}

pub(super) fn require_one_of_field<'a>(
    object: &'a Map<String, Value>,
    field: &str,
    allowed: &[&str],
    label: &str,
) -> UtsushiResult<&'a str> {
    let value = require_non_blank_field(object, field, label)?;
    if !allowed.contains(&value) {
        return Err(format!("{label} has unsupported value: {value}").into());
    }
    Ok(value)
}

pub(super) fn parse_fidelity_tier_field(
    object: &Map<String, Value>,
    field: &str,
    label: &str,
) -> UtsushiResult<FidelityTier> {
    match require_non_blank_field(object, field, label)? {
        "trace_only" => Ok(FidelityTier::TraceOnly),
        "layout_probe" => Ok(FidelityTier::LayoutProbe),
        "replay_review" => Ok(FidelityTier::ReplayReview),
        "reference_fidelity" => Ok(FidelityTier::ReferenceFidelity),
        value => Err(format!("{label} has unsupported value: {value}").into()),
    }
}

pub(super) fn parse_evidence_tier_field(
    object: &Map<String, Value>,
    field: &str,
    label: &str,
) -> UtsushiResult<EvidenceTier> {
    EvidenceTier::from_str(require_non_blank_field(object, field, label)?)
        .map_err(|error| format!("{label} {error}").into())
}

pub(super) fn required_value_array<'a>(
    object: &'a Map<String, Value>,
    field: &str,
    label: &str,
) -> UtsushiResult<&'a Vec<Value>> {
    object
        .get(field)
        .and_then(Value::as_array)
        .ok_or_else(|| format!("{label} must be an array").into())
}

fn optional_value_array<'a>(
    object: &'a Map<String, Value>,
    field: &str,
    label: &str,
) -> UtsushiResult<&'a [Value]> {
    match object.get(field) {
        Some(value) => value
            .as_array()
            .map(Vec::as_slice)
            .ok_or_else(|| format!("{label} must be an array").into()),
        None => Ok(&[]),
    }
}

pub(super) fn validate_string_array_field(
    object: &Map<String, Value>,
    field: &str,
    label: &str,
) -> UtsushiResult<()> {
    let values = required_value_array(object, field, label)?;
    for (index, value) in values.iter().enumerate() {
        if value.as_str().is_none() {
            return Err(format!("{label}[{index}] must be a string").into());
        }
    }
    Ok(())
}

pub(super) fn require_u64_field(
    object: &Map<String, Value>,
    field: &str,
    label: &str,
) -> UtsushiResult<u64> {
    object
        .get(field)
        .and_then(Value::as_u64)
        .ok_or_else(|| format!("{label} must be a non-negative integer").into())
}

pub(super) fn require_positive_u64_field(
    object: &Map<String, Value>,
    field: &str,
    label: &str,
) -> UtsushiResult<u64> {
    let value = require_u64_field(object, field, label)?;
    if value == 0 {
        return Err(format!("{label} must be positive").into());
    }
    Ok(value)
}
