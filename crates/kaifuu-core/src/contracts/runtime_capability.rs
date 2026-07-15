use std::collections::HashSet;

use serde_json::{Map, Value};

use crate::{BRIDGE_SCHEMA_VERSION_V02, BridgeContractResult};

use super::{
    RUNTIME_CAPABILITY_CLASSES, RUNTIME_EVIDENCE_TIERS, RUNTIME_FEATURE_STATUSES,
    RUNTIME_FIDELITY_TIERS, RUNTIME_PLAYBACK_FEATURES, RUNTIME_REQUESTED_OPERATIONS, as_record,
    assert_literal, assert_one_of, assert_required_one_of, assert_required_string,
    assert_required_uuid7, assert_string_array, error, required, required_array, string_field,
    string_value,
};

pub(super) fn assert_runtime_evidence_tier_within_fidelity(
    evidence_tier: &str,
    fidelity_tier: &str,
) -> BridgeContractResult<()> {
    let maximum = match fidelity_tier {
        "trace_only" => "E1",
        "layout_probe" => "E2",
        "replay_review" => "E3",
        "reference_fidelity" => "E4",
        _ => "E0",
    };
    if runtime_evidence_tier_rank(evidence_tier) > runtime_evidence_tier_rank(maximum) {
        return error(format!(
            "RuntimeEvidenceReportV02.evidenceTier must not exceed {maximum} for the declared fidelityTier"
        ));
    }
    Ok(())
}

pub(super) fn validate_runtime_capability_contract(
    value: &Value,
    label: &str,
    report_fidelity_tier: &str,
    report_evidence_tier: &str,
) -> BridgeContractResult<()> {
    let contract = as_record(value, label)?;
    assert_literal(
        contract,
        "contractVersion",
        BRIDGE_SCHEMA_VERSION_V02,
        &format!("{label}.contractVersion"),
    )?;
    let capability_class = assert_required_one_of(
        contract,
        "capabilityClass",
        RUNTIME_CAPABILITY_CLASSES,
        &format!("{label}.capabilityClass"),
    )?;
    let fidelity_tier_ceiling = assert_required_one_of(
        contract,
        "fidelityTierCeiling",
        RUNTIME_FIDELITY_TIERS,
        &format!("{label}.fidelityTierCeiling"),
    )?;
    let evidence_tier_ceiling = assert_required_one_of(
        contract,
        "evidenceTierCeiling",
        RUNTIME_EVIDENCE_TIERS,
        &format!("{label}.evidenceTierCeiling"),
    )?;
    assert_runtime_capability_class_ceiling(
        capability_class,
        fidelity_tier_ceiling,
        evidence_tier_ceiling,
        label,
    )?;
    assert_runtime_evidence_tier_within_fidelity(evidence_tier_ceiling, fidelity_tier_ceiling)?;
    assert_maximum_runtime_fidelity_tier(
        report_fidelity_tier,
        fidelity_tier_ceiling,
        "RuntimeEvidenceReportV02.fidelityTier",
    )?;
    assert_maximum_runtime_evidence_tier(
        report_evidence_tier,
        evidence_tier_ceiling,
        "RuntimeEvidenceReportV02.evidenceTier",
    )?;

    let features = required_array(contract, "features", &format!("{label}.features"))?;
    if features.is_empty() {
        return error(format!(
            "{label}.features must include at least one runtime feature declaration"
        ));
    }
    let mut seen_features = HashSet::new();
    for (index, feature) in features.iter().enumerate() {
        let feature_label = format!("{label}.features[{index}]");
        let feature = validate_runtime_feature_support(feature, &feature_label)?;
        let feature_name = string_field(feature, "feature")?;
        if !seen_features.insert(feature_name.to_string()) {
            return error(format!(
                "{feature_label}.feature must be unique within runtime capability contract"
            ));
        }
        if let Some(feature_ceiling) = feature.get("evidenceTierCeiling") {
            let feature_ceiling = string_value(
                feature_ceiling,
                &format!("{feature_label}.evidenceTierCeiling"),
            )?;
            assert_maximum_runtime_evidence_tier(
                feature_ceiling,
                evidence_tier_ceiling,
                &format!("{feature_label}.evidenceTierCeiling"),
            )?;
        }
    }
    assert_string_array(
        required(contract, "limitations", &format!("{label}.limitations"))?,
        &format!("{label}.limitations"),
    )?;
    Ok(())
}

pub(super) fn validate_runtime_feature_support<'a>(
    value: &'a Value,
    label: &str,
) -> BridgeContractResult<&'a Map<String, Value>> {
    let feature = as_record(value, label)?;
    assert_required_one_of(
        feature,
        "feature",
        RUNTIME_PLAYBACK_FEATURES,
        &format!("{label}.feature"),
    )?;
    let status = assert_required_one_of(
        feature,
        "status",
        RUNTIME_FEATURE_STATUSES,
        &format!("{label}.status"),
    )?;
    if let Some(evidence_tier_ceiling) = feature.get("evidenceTierCeiling") {
        let evidence_tier_ceiling = string_value(
            evidence_tier_ceiling,
            &format!("{label}.evidenceTierCeiling"),
        )?;
        assert_one_of(
            evidence_tier_ceiling,
            RUNTIME_EVIDENCE_TIERS,
            &format!("{label}.evidenceTierCeiling"),
        )?;
    }
    if status == "unsupported" && feature.get("evidenceTierCeiling").is_some() {
        return error(format!(
            "{label}.evidenceTierCeiling must be omitted for unsupported runtime features"
        ));
    }
    if status != "unsupported" && feature.get("evidenceTierCeiling").is_none() {
        return error(format!(
            "{label}.evidenceTierCeiling is required for supported runtime features"
        ));
    }
    assert_required_string(feature, "description", &format!("{label}.description"))?;
    assert_string_array(
        required(feature, "limitations", &format!("{label}.limitations"))?,
        &format!("{label}.limitations"),
    )?;
    Ok(feature)
}

pub(super) fn validate_controlled_playback_session(
    value: &Value,
    label: &str,
    report: &Map<String, Value>,
    report_fidelity_tier: &str,
    report_evidence_tier: &str,
    report_status: &str,
) -> BridgeContractResult<()> {
    let session = as_record(value, label)?;
    assert_required_uuid7(session, "sessionId", &format!("{label}.sessionId"))?;
    let adapter_name =
        assert_required_string(session, "adapterName", &format!("{label}.adapterName"))?;
    if adapter_name != string_field(report, "adapterName")? {
        return error(format!(
            "{label}.adapterName must match RuntimeEvidenceReportV02.adapterName"
        ));
    }
    let adapter_version = assert_required_string(
        session,
        "adapterVersion",
        &format!("{label}.adapterVersion"),
    )?;
    if adapter_version != string_field(report, "adapterVersion")? {
        return error(format!(
            "{label}.adapterVersion must match RuntimeEvidenceReportV02.adapterVersion"
        ));
    }
    let capability_class = assert_required_one_of(
        session,
        "capabilityClass",
        RUNTIME_CAPABILITY_CLASSES,
        &format!("{label}.capabilityClass"),
    )?;
    assert_required_one_of(
        session,
        "requestedOperation",
        RUNTIME_REQUESTED_OPERATIONS,
        &format!("{label}.requestedOperation"),
    )?;
    let status = assert_required_one_of(
        session,
        "status",
        &["passed", "failed"],
        &format!("{label}.status"),
    )?;
    if status != report_status {
        return error(format!(
            "{label}.status must match RuntimeEvidenceReportV02.status"
        ));
    }
    let fidelity_tier = assert_required_one_of(
        session,
        "fidelityTier",
        RUNTIME_FIDELITY_TIERS,
        &format!("{label}.fidelityTier"),
    )?;
    let evidence_tier = assert_required_one_of(
        session,
        "evidenceTier",
        RUNTIME_EVIDENCE_TIERS,
        &format!("{label}.evidenceTier"),
    )?;
    assert_runtime_evidence_tier_within_fidelity(evidence_tier, fidelity_tier)?;
    assert_maximum_runtime_fidelity_tier(
        fidelity_tier,
        report_fidelity_tier,
        &format!("{label}.fidelityTier"),
    )?;
    assert_maximum_runtime_evidence_tier(
        evidence_tier,
        report_evidence_tier,
        &format!("{label}.evidenceTier"),
    )?;

    let features_used = required_array(session, "featuresUsed", &format!("{label}.featuresUsed"))?;
    for (index, feature) in features_used.iter().enumerate() {
        let feature = string_value(feature, &format!("{label}.featuresUsed[{index}]"))?;
        assert_one_of(
            feature,
            RUNTIME_PLAYBACK_FEATURES,
            &format!("{label}.featuresUsed[{index}]"),
        )?;
        if let Some(runtime_capabilities) = report.get("runtimeCapabilities") {
            validate_runtime_capability_supports_feature(
                runtime_capabilities,
                feature,
                "RuntimeEvidenceReportV02.runtimeCapabilities",
            )?;
        }
    }
    if let Some(runtime_capabilities) = report.get("runtimeCapabilities") {
        let runtime_capabilities = as_record(
            runtime_capabilities,
            "RuntimeEvidenceReportV02.runtimeCapabilities",
        )?;
        if capability_class != string_field(runtime_capabilities, "capabilityClass")? {
            return error(format!(
                "{label}.capabilityClass must match runtimeCapabilities.capabilityClass"
            ));
        }
    }
    assert_string_array(
        required(session, "limitations", &format!("{label}.limitations"))?,
        &format!("{label}.limitations"),
    )?;
    Ok(())
}

pub(super) fn validate_controlled_playback_session_evidence_surface(
    requested_operation: &str,
    has_branch_events: bool,
    has_captures: bool,
    has_recordings: bool,
    has_reference_comparisons: bool,
    label: &str,
) -> BridgeContractResult<()> {
    match requested_operation {
        "trace" => {
            reject_controlled_playback_operation_evidence(
                requested_operation,
                has_branch_events,
                "branch event",
                label,
            )?;
            reject_controlled_playback_operation_evidence(
                requested_operation,
                has_captures,
                "capture",
                label,
            )?;
            reject_controlled_playback_operation_evidence(
                requested_operation,
                has_recordings,
                "recording",
                label,
            )?;
            reject_controlled_playback_operation_evidence(
                requested_operation,
                has_reference_comparisons,
                "reference comparison",
                label,
            )?;
        }
        "branch_discovery" => {
            reject_controlled_playback_operation_evidence(
                requested_operation,
                has_captures,
                "capture",
                label,
            )?;
            reject_controlled_playback_operation_evidence(
                requested_operation,
                has_recordings,
                "recording",
                label,
            )?;
            reject_controlled_playback_operation_evidence(
                requested_operation,
                has_reference_comparisons,
                "reference comparison",
                label,
            )?;
        }
        "capture" => {
            reject_controlled_playback_operation_evidence(
                requested_operation,
                has_branch_events,
                "branch event",
                label,
            )?;
            reject_controlled_playback_operation_evidence(
                requested_operation,
                has_recordings,
                "recording",
                label,
            )?;
            reject_controlled_playback_operation_evidence(
                requested_operation,
                has_reference_comparisons,
                "reference comparison",
                label,
            )?;
        }
        "smoke_validation" => {}
        _ => unreachable!("controlled playback requestedOperation was already validated"),
    }
    Ok(())
}

pub(super) fn reject_controlled_playback_operation_evidence(
    requested_operation: &str,
    has_evidence: bool,
    evidence_label: &str,
    label: &str,
) -> BridgeContractResult<()> {
    if has_evidence {
        return error(format!(
            "{label} {requested_operation} must not carry {evidence_label} evidence"
        ));
    }
    Ok(())
}

pub(super) fn validate_runtime_capability_supports_feature(
    value: &Value,
    required_feature: &str,
    label: &str,
) -> BridgeContractResult<()> {
    let contract = as_record(value, label)?;
    let features = required_array(contract, "features", &format!("{label}.features"))?;
    for feature in features {
        let feature = as_record(feature, &format!("{label}.features[]"))?;
        if string_field(feature, "feature")? == required_feature
            && string_field(feature, "status")? != "unsupported"
        {
            return Ok(());
        }
    }
    error(format!(
        "{label} must advertise supported or partial {required_feature} capability"
    ))
}

pub(super) fn assert_runtime_capability_class_ceiling(
    capability_class: &str,
    fidelity_tier_ceiling: &str,
    evidence_tier_ceiling: &str,
    label: &str,
) -> BridgeContractResult<()> {
    let (fidelity_ceiling, evidence_ceiling) = match capability_class {
        "launch_capture" => ("layout_probe", "E2"),
        "instrumented_runtime" | "partial_vm" => ("replay_review", "E3"),
        "reference_vm" => ("reference_fidelity", "E4"),
        // "static_trace" and any unrecognized class get the most conservative ceiling.
        _ => ("trace_only", "E1"),
    };
    assert_maximum_runtime_fidelity_tier(
        fidelity_tier_ceiling,
        fidelity_ceiling,
        &format!("{label}.fidelityTierCeiling"),
    )?;
    assert_maximum_runtime_evidence_tier(
        evidence_tier_ceiling,
        evidence_ceiling,
        &format!("{label}.evidenceTierCeiling"),
    )
}

pub(super) fn assert_maximum_runtime_fidelity_tier(
    actual: &str,
    maximum: &str,
    label: &str,
) -> BridgeContractResult<()> {
    if runtime_fidelity_tier_rank(actual) > runtime_fidelity_tier_rank(maximum) {
        return error(format!(
            "{label} must not exceed {maximum} for the declared runtime capability"
        ));
    }
    Ok(())
}

pub(super) fn assert_minimum_runtime_evidence_tier(
    actual: &str,
    minimum: &str,
    label: &str,
) -> BridgeContractResult<()> {
    if runtime_evidence_tier_rank(actual) < runtime_evidence_tier_rank(minimum) {
        return error(format!("{label} must be at least {minimum}"));
    }
    Ok(())
}

pub(super) fn assert_maximum_runtime_evidence_tier(
    actual: &str,
    maximum: &str,
    label: &str,
) -> BridgeContractResult<()> {
    if runtime_evidence_tier_rank(actual) > runtime_evidence_tier_rank(maximum) {
        return error(format!(
            "{label} must not exceed {maximum} for the declared fidelityTier"
        ));
    }
    Ok(())
}

pub(super) fn runtime_evidence_tier_rank(tier: &str) -> usize {
    RUNTIME_EVIDENCE_TIERS
        .iter()
        .position(|candidate| *candidate == tier)
        .unwrap_or(0)
}

pub(super) fn runtime_fidelity_tier_rank(tier: &str) -> usize {
    RUNTIME_FIDELITY_TIERS
        .iter()
        .position(|candidate| *candidate == tier)
        .unwrap_or(0)
}
