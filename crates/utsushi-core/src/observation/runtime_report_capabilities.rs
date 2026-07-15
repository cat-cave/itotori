use std::collections::HashSet;

use serde_json::Value;

use super::runtime_report::{
    parse_evidence_tier_field, parse_fidelity_tier_field, require_literal, require_non_blank_field,
    require_one_of_field, require_uuid7_field, required_value_array, validate_string_array_field,
    value_object,
};
use crate::{EvidenceTier, FidelityTier, UtsushiResult};

pub(super) fn validate_runtime_capability_contract_value(
    value: &Value,
    label: &str,
    report_fidelity_tier: FidelityTier,
    report_evidence_tier: EvidenceTier,
) -> UtsushiResult<()> {
    let contract = value_object(value, label)?;
    require_literal(
        contract,
        "contractVersion",
        "0.2.0",
        &format!("{label}.contractVersion"),
    )?;
    require_one_of_field(
        contract,
        "capabilityClass",
        &[
            "static_trace",
            "launch_capture",
            "instrumented_runtime",
            "partial_vm",
            "reference_vm",
        ],
        &format!("{label}.capabilityClass"),
    )?;
    let fidelity_tier_ceiling = parse_fidelity_tier_field(
        contract,
        "fidelityTierCeiling",
        &format!("{label}.fidelityTierCeiling"),
    )?;
    let evidence_tier_ceiling = parse_evidence_tier_field(
        contract,
        "evidenceTierCeiling",
        &format!("{label}.evidenceTierCeiling"),
    )?;
    if report_fidelity_tier.rank() > fidelity_tier_ceiling.rank() {
        return Err(
            "RuntimeEvidenceReportV02.fidelityTier exceeds runtimeCapabilities.fidelityTierCeiling"
                .into(),
        );
    }
    if report_evidence_tier > evidence_tier_ceiling {
        return Err(
            "RuntimeEvidenceReportV02.evidenceTier exceeds runtimeCapabilities.evidenceTierCeiling"
                .into(),
        );
    }
    let features = required_value_array(contract, "features", &format!("{label}.features"))?;
    if features.is_empty() {
        return Err(format!("{label}.features must not be empty").into());
    }
    let mut seen = HashSet::new();
    for (index, feature) in features.iter().enumerate() {
        let feature_label = format!("{label}.features[{index}]");
        let feature = value_object(feature, &feature_label)?;
        let name = require_one_of_field(
            feature,
            "feature",
            &[
                "static_trace",
                "launch",
                "text_trace",
                "branch_discovery",
                "frame_capture",
                "jump",
                "snapshot",
                "screenshot",
                "recording",
                "instrumentation_hooks",
                "vm_state_inspection",
                "reference_comparison",
            ],
            &format!("{feature_label}.feature"),
        )?;
        if !seen.insert(name.to_string()) {
            return Err(format!("{feature_label}.feature must be unique").into());
        }
        let status = require_one_of_field(
            feature,
            "status",
            &["supported", "partial", "unsupported"],
            &format!("{feature_label}.status"),
        )?;
        let has_ceiling = feature.get("evidenceTierCeiling").is_some();
        if status == "unsupported" && has_ceiling {
            return Err(format!("{feature_label}.evidenceTierCeiling must be omitted for unsupported runtime features").into());
        }
        if status != "unsupported" && !has_ceiling {
            return Err(format!(
                "{feature_label}.evidenceTierCeiling is required for supported runtime features"
            )
            .into());
        }
        if has_ceiling {
            let feature_ceiling = parse_evidence_tier_field(
                feature,
                "evidenceTierCeiling",
                &format!("{feature_label}.evidenceTierCeiling"),
            )?;
            if feature_ceiling > evidence_tier_ceiling {
                return Err(format!(
                    "{feature_label}.evidenceTierCeiling exceeds contract ceiling"
                )
                .into());
            }
        }
        require_non_blank_field(
            feature,
            "description",
            &format!("{feature_label}.description"),
        )?;
        validate_string_array_field(
            feature,
            "limitations",
            &format!("{feature_label}.limitations"),
        )?;
    }
    validate_string_array_field(contract, "limitations", &format!("{label}.limitations"))?;
    Ok(())
}

pub(super) fn validate_controlled_playback_session_value(
    value: &Value,
    adapter_name: &str,
    adapter_version: &str,
    report_fidelity_tier: FidelityTier,
    report_evidence_tier: EvidenceTier,
    report_status: &str,
    runtime_capabilities: Option<&Value>,
) -> UtsushiResult<()> {
    let session = value_object(value, "RuntimeEvidenceReportV02.controlledPlaybackSession")?;
    require_uuid7_field(
        session,
        "sessionId",
        "RuntimeEvidenceReportV02.controlledPlaybackSession.sessionId",
    )?;
    if require_non_blank_field(
        session,
        "adapterName",
        "RuntimeEvidenceReportV02.controlledPlaybackSession.adapterName",
    )? != adapter_name
    {
        return Err("RuntimeEvidenceReportV02.controlledPlaybackSession.adapterName must match RuntimeEvidenceReportV02.adapterName".into());
    }
    if require_non_blank_field(
        session,
        "adapterVersion",
        "RuntimeEvidenceReportV02.controlledPlaybackSession.adapterVersion",
    )? != adapter_version
    {
        return Err("RuntimeEvidenceReportV02.controlledPlaybackSession.adapterVersion must match RuntimeEvidenceReportV02.adapterVersion".into());
    }
    require_one_of_field(
        session,
        "capabilityClass",
        &[
            "static_trace",
            "launch_capture",
            "instrumented_runtime",
            "partial_vm",
            "reference_vm",
        ],
        "RuntimeEvidenceReportV02.controlledPlaybackSession.capabilityClass",
    )?;
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
    )?;
    if require_one_of_field(
        session,
        "status",
        &["passed", "failed"],
        "RuntimeEvidenceReportV02.controlledPlaybackSession.status",
    )? != report_status
    {
        return Err("RuntimeEvidenceReportV02.controlledPlaybackSession.status must match RuntimeEvidenceReportV02.status".into());
    }
    let fidelity_tier = parse_fidelity_tier_field(
        session,
        "fidelityTier",
        "RuntimeEvidenceReportV02.controlledPlaybackSession.fidelityTier",
    )?;
    let evidence_tier = parse_evidence_tier_field(
        session,
        "evidenceTier",
        "RuntimeEvidenceReportV02.controlledPlaybackSession.evidenceTier",
    )?;
    if fidelity_tier.rank() > report_fidelity_tier.rank() {
        return Err("RuntimeEvidenceReportV02.controlledPlaybackSession.fidelityTier must not exceed report fidelityTier".into());
    }
    if evidence_tier > report_evidence_tier {
        return Err("RuntimeEvidenceReportV02.controlledPlaybackSession.evidenceTier must not exceed report evidenceTier".into());
    }
    let features = required_value_array(
        session,
        "featuresUsed",
        "RuntimeEvidenceReportV02.controlledPlaybackSession.featuresUsed",
    )?;
    for (index, feature) in features.iter().enumerate() {
        let feature = feature.as_str().ok_or_else(|| {
            format!("RuntimeEvidenceReportV02.controlledPlaybackSession.featuresUsed[{index}] must be a string")
        })?;
        if !is_runtime_playback_feature(feature) {
            return Err(format!(
                "RuntimeEvidenceReportV02.controlledPlaybackSession.featuresUsed[{index}] has unsupported value: {feature}"
            )
            .into());
        }
        if let Some(runtime_capabilities) = runtime_capabilities {
            validate_runtime_capability_supports_feature_value(
                runtime_capabilities,
                feature,
                "RuntimeEvidenceReportV02.runtimeCapabilities",
            )?;
        }
    }
    validate_string_array_field(
        session,
        "limitations",
        "RuntimeEvidenceReportV02.controlledPlaybackSession.limitations",
    )?;
    Ok(())
}

fn validate_runtime_capability_supports_feature_value(
    value: &Value,
    feature_name: &str,
    label: &str,
) -> UtsushiResult<()> {
    let contract = value_object(value, label)?;
    let features = required_value_array(contract, "features", &format!("{label}.features"))?;
    for feature in features {
        let feature = value_object(feature, &format!("{label}.features[]"))?;
        if feature.get("feature").and_then(Value::as_str) == Some(feature_name) {
            let status = require_one_of_field(
                feature,
                "status",
                &["supported", "partial", "unsupported"],
                &format!("{label}.features[].status"),
            )?;
            if status == "supported" || status == "partial" {
                return Ok(());
            }
        }
    }
    Err(format!("{label} does not support {feature_name} capability").into())
}

pub(super) fn validate_controlled_playback_surface(
    requested_operation: &str,
    has_branch_events: bool,
    has_captures: bool,
    has_recordings: bool,
    has_reference_comparisons: bool,
) -> UtsushiResult<()> {
    match requested_operation {
        "trace" => {
            reject_operation_evidence(requested_operation, has_branch_events, "branch event")?;
            reject_operation_evidence(requested_operation, has_captures, "capture")?;
            reject_operation_evidence(requested_operation, has_recordings, "recording")?;
            reject_operation_evidence(
                requested_operation,
                has_reference_comparisons,
                "reference comparison",
            )?;
        }
        "branch_discovery" => {
            reject_operation_evidence(requested_operation, has_captures, "capture")?;
            reject_operation_evidence(requested_operation, has_recordings, "recording")?;
            reject_operation_evidence(
                requested_operation,
                has_reference_comparisons,
                "reference comparison",
            )?;
        }
        "capture" => {
            reject_operation_evidence(requested_operation, has_branch_events, "branch event")?;
            reject_operation_evidence(requested_operation, has_recordings, "recording")?;
            reject_operation_evidence(
                requested_operation,
                has_reference_comparisons,
                "reference comparison",
            )?;
        }
        "smoke_validation" => {}
        "replay_review" => {
            reject_operation_evidence(requested_operation, has_branch_events, "branch event")?;
            reject_operation_evidence(requested_operation, has_captures, "capture")?;
            reject_operation_evidence(
                requested_operation,
                has_reference_comparisons,
                "reference comparison",
            )?;
        }
        _ => unreachable!("requestedOperation validated before evidence surface check"),
    }
    Ok(())
}

fn reject_operation_evidence(
    requested_operation: &str,
    has_evidence: bool,
    evidence_label: &str,
) -> UtsushiResult<()> {
    if has_evidence {
        return Err(format!(
            "RuntimeEvidenceReportV02.controlledPlaybackSession.requestedOperation {requested_operation} must not carry {evidence_label} evidence"
        )
        .into());
    }
    Ok(())
}

fn is_runtime_playback_feature(value: &str) -> bool {
    matches!(
        value,
        "static_trace"
            | "launch"
            | "text_trace"
            | "branch_discovery"
            | "frame_capture"
            | "jump"
            | "snapshot"
            | "screenshot"
            | "recording"
            | "instrumentation_hooks"
            | "vm_state_inspection"
            | "reference_comparison"
    )
}

// `ObservationErrorPayload` deleted along with the rest of
// the typed observation-hook surface. Error-shaped runtime diagnostics are
// surfaced through `RuntimeAdapterDiagnostic` (already engine-neutral) and
// never flow through a deleted enum variant.
