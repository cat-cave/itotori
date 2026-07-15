use serde_json::Value;

use crate::{BridgeContractResult, BridgeContractValidationError};

use super::{
    OBSERVATION_HOOK_EVENT_KINDS, OBSERVATION_HOOK_SCHEMA_VERSION, OBSERVATION_REDACTION_STATUSES,
    RUNTIME_EVIDENCE_TIERS, as_record, assert_literal, assert_maximum_runtime_evidence_tier,
    assert_portable_uri, assert_required_non_negative_integer, assert_required_one_of,
    assert_required_positive_integer, assert_required_rfc3339, assert_required_string,
    assert_string_array, error, is_blank_string, non_blank_string_value, optional_array,
    optional_string, positive_integer_value, required, required_array, string_value,
};

pub(super) fn validate_observation_hook_event(
    value: &Value,
    label: &str,
    report_evidence_tier: &str,
) -> BridgeContractResult<()> {
    let event = as_record(value, label)?;
    assert_literal(
        event,
        "schemaVersion",
        OBSERVATION_HOOK_SCHEMA_VERSION,
        &format!("{label}.schemaVersion"),
    )?;
    assert_required_string(event, "eventId", &format!("{label}.eventId"))?;
    assert_required_rfc3339(event, "observedAt", &format!("{label}.observedAt"))?;
    let event_kind = assert_required_one_of(
        event,
        "eventKind",
        OBSERVATION_HOOK_EVENT_KINDS,
        &format!("{label}.eventKind"),
    )?;
    assert_required_string(
        event,
        "runtimeTargetId",
        &format!("{label}.runtimeTargetId"),
    )?;
    validate_observation_adapter_id(
        required(event, "adapterId", &format!("{label}.adapterId"))?,
        &format!("{label}.adapterId"),
    )?;
    let evidence_tier = assert_required_one_of(
        event,
        "evidenceTier",
        RUNTIME_EVIDENCE_TIERS,
        &format!("{label}.evidenceTier"),
    )?;
    assert_maximum_runtime_evidence_tier(
        evidence_tier,
        report_evidence_tier,
        &format!("{label}.evidenceTier"),
    )?;
    validate_observation_environment(
        required(event, "environment", &format!("{label}.environment"))?,
        &format!("{label}.environment"),
    )?;
    if let Some(source_revision) = event.get("sourceRevision") {
        validate_observation_source_revision(source_revision, &format!("{label}.sourceRevision"))?;
    }
    let bridge_refs = optional_array(event, "bridgeRefs", &format!("{label}.bridgeRefs"))?;
    for (index, bridge_ref) in bridge_refs.iter().enumerate() {
        validate_observation_bridge_ref(bridge_ref, &format!("{label}.bridgeRefs[{index}]"))?;
    }
    validate_observation_redaction_metadata(
        required(event, "redaction", &format!("{label}.redaction"))?,
        &format!("{label}.redaction"),
    )?;
    let payload_kind = validate_observation_hook_payload(
        required(event, "payload", &format!("{label}.payload"))?,
        &format!("{label}.payload"),
    )?;
    if event_kind != payload_kind {
        return error(format!(
            "{label}.eventKind must match {label}.payload.payloadKind"
        ));
    }
    Ok(())
}

pub(super) fn validate_observation_adapter_id(
    value: &Value,
    label: &str,
) -> BridgeContractResult<()> {
    let adapter_id = as_record(value, label)?;
    assert_required_string(adapter_id, "name", &format!("{label}.name"))?;
    assert_required_string(adapter_id, "version", &format!("{label}.version"))?;
    Ok(())
}

pub(super) fn validate_observation_environment(
    value: &Value,
    label: &str,
) -> BridgeContractResult<()> {
    let environment = as_record(value, label)?;
    assert_required_string(environment, "runtime", &format!("{label}.runtime"))?;
    for key in ["engine", "platform", "display", "locale"] {
        if let Some(value) = environment.get(key) {
            string_value(value, &format!("{label}.{key}"))?;
        }
    }
    Ok(())
}

pub(super) fn validate_observation_source_revision(
    value: &Value,
    label: &str,
) -> BridgeContractResult<()> {
    let source_revision = as_record(value, label)?;
    assert_required_string(source_revision, "sourceId", &format!("{label}.sourceId"))?;
    for key in ["revisionId", "contentHash"] {
        if let Some(value) = source_revision.get(key) {
            string_value(value, &format!("{label}.{key}"))?;
        }
    }
    Ok(())
}

pub(super) fn validate_observation_bridge_ref(
    value: &Value,
    label: &str,
) -> BridgeContractResult<()> {
    let bridge_ref = as_record(value, label)?;
    let bridge_unit_id =
        optional_string(bridge_ref, "bridgeUnitId", &format!("{label}.bridgeUnitId"))?;
    let source_unit_key = optional_string(
        bridge_ref,
        "sourceUnitKey",
        &format!("{label}.sourceUnitKey"),
    )?;
    let runtime_object_id = optional_string(
        bridge_ref,
        "runtimeObjectId",
        &format!("{label}.runtimeObjectId"),
    )?;
    if is_blank_string(bridge_unit_id)
        && is_blank_string(source_unit_key)
        && is_blank_string(runtime_object_id)
    {
        return error(format!(
            "{label} must identify a bridge unit, source unit, or runtime object"
        ));
    }
    Ok(())
}

pub(super) fn validate_observation_redaction_metadata(
    value: &Value,
    label: &str,
) -> BridgeContractResult<()> {
    let redaction = as_record(value, label)?;
    let status = assert_required_one_of(
        redaction,
        "status",
        OBSERVATION_REDACTION_STATUSES,
        &format!("{label}.status"),
    )?;
    let rules = optional_array(redaction, "rules", &format!("{label}.rules"))?;
    let redacted_fields = optional_array(
        redaction,
        "redactedFields",
        &format!("{label}.redactedFields"),
    )?;
    for (index, rule) in rules.iter().enumerate() {
        non_blank_string_value(rule, &format!("{label}.rules[{index}]"))?;
    }
    for (index, field) in redacted_fields.iter().enumerate() {
        non_blank_string_value(field, &format!("{label}.redactedFields[{index}]"))?;
    }
    if status == "not_required" && (!rules.is_empty() || !redacted_fields.is_empty()) {
        return error(format!(
            "{label} with status not_required must not declare redaction rules or fields"
        ));
    }
    if status == "redacted" && (rules.is_empty() || redacted_fields.is_empty()) {
        return error(format!(
            "{label} with status redacted must declare rules and redactedFields"
        ));
    }
    Ok(())
}

pub(super) fn validate_observation_hook_payload<'a>(
    value: &'a Value,
    label: &str,
) -> BridgeContractResult<&'a str> {
    let payload = as_record(value, label)?;
    let payload_kind = assert_required_one_of(
        payload,
        "payloadKind",
        OBSERVATION_HOOK_EVENT_KINDS,
        &format!("{label}.payloadKind"),
    )?;
    match payload_kind {
        "text" => {
            assert_required_string(payload, "text", &format!("{label}.text"))?;
            for key in ["speaker", "textSurface"] {
                if let Some(value) = payload.get(key) {
                    string_value(value, &format!("{label}.{key}"))?;
                }
            }
        }
        "choice" => {
            if let Some(prompt) = payload.get("prompt") {
                string_value(prompt, &format!("{label}.prompt"))?;
            }
            let options = required_array(payload, "options", &format!("{label}.options"))?;
            if options.is_empty() {
                return error(format!("{label}.options must include at least one option"));
            }
            for (index, option) in options.iter().enumerate() {
                validate_observation_choice_option(option, &format!("{label}.options[{index}]"))?;
            }
        }
        "branch" => {
            assert_required_string(payload, "branchId", &format!("{label}.branchId"))?;
            for key in ["label", "destination"] {
                if let Some(value) = payload.get(key) {
                    string_value(value, &format!("{label}.{key}"))?;
                }
            }
            if let Some(taken) = payload.get("taken")
                && taken.as_bool().is_none()
            {
                return error(format!("{label}.taken must be a boolean"));
            }
        }
        "scene" => {
            assert_required_string(payload, "sceneId", &format!("{label}.sceneId"))?;
            if let Some(scene_name) = payload.get("sceneName") {
                string_value(scene_name, &format!("{label}.sceneName"))?;
            }
        }
        "frame" => {
            assert_required_non_negative_integer(payload, "frame", &format!("{label}.frame"))?;
            if let Some(width) = payload.get("width") {
                positive_integer_value(width, &format!("{label}.width"))?;
            }
            if let Some(height) = payload.get("height") {
                positive_integer_value(height, &format!("{label}.height"))?;
            }
            if let Some(artifact_ref) = payload.get("artifactRef") {
                validate_observation_artifact_ref(artifact_ref, &format!("{label}.artifactRef"))?;
            }
        }
        "error" => {
            assert_required_string(payload, "errorType", &format!("{label}.errorType"))?;
            assert_required_string(payload, "message", &format!("{label}.message"))?;
            required(payload, "fatal", &format!("{label}.fatal"))?
                .as_bool()
                .ok_or_else(|| {
                    BridgeContractValidationError::new(format!("{label}.fatal must be a boolean"))
                })?;
            if let Some(stack) = payload.get("stack") {
                string_value(stack, &format!("{label}.stack"))?;
            }
        }
        _ => unreachable!("payload kind was validated above"),
    }
    Ok(payload_kind)
}

pub(super) fn validate_observation_choice_option(
    value: &Value,
    label: &str,
) -> BridgeContractResult<()> {
    let option = as_record(value, label)?;
    assert_required_string(option, "optionId", &format!("{label}.optionId"))?;
    assert_required_string(option, "label", &format!("{label}.label"))?;
    if let Some(bridge_ref) = option.get("bridgeRef") {
        validate_observation_bridge_ref(bridge_ref, &format!("{label}.bridgeRef"))?;
    }
    Ok(())
}

pub(super) fn validate_observation_artifact_ref(
    value: &Value,
    label: &str,
) -> BridgeContractResult<()> {
    let artifact_ref = as_record(value, label)?;
    assert_required_string(artifact_ref, "artifactId", &format!("{label}.artifactId"))?;
    assert_required_string(
        artifact_ref,
        "artifactKind",
        &format!("{label}.artifactKind"),
    )?;
    assert_portable_uri(
        required(artifact_ref, "uri", &format!("{label}.uri"))?,
        &format!("{label}.uri"),
    )?;
    if let Some(media_type) = artifact_ref.get("mediaType") {
        string_value(media_type, &format!("{label}.mediaType"))?;
    }
    Ok(())
}

pub(super) fn validate_runtime_expectation(value: &Value, label: &str) -> BridgeContractResult<()> {
    let expectation = as_record(value, label)?;
    assert_required_one_of(
        expectation,
        "expectationKind",
        &[
            "trace_text",
            "layout_probe",
            "screenshot_region",
            "metadata_only",
        ],
        &format!("{label}.expectationKind"),
    )?;
    if let Some(region) = expectation.get("region") {
        validate_pixel_region(region, &format!("{label}.region"))?;
    }
    if let Some(trace_key) = expectation.get("traceKey") {
        string_value(trace_key, &format!("{label}.traceKey"))?;
    }
    Ok(())
}

pub(super) fn validate_source_location(value: &Value, label: &str) -> BridgeContractResult<()> {
    let location = as_record(value, label)?;
    if let Some(container_key) = location.get("containerKey") {
        string_value(container_key, &format!("{label}.containerKey"))?;
    }
    if let Some(entry_path) = location.get("entryPath") {
        assert_string_array(entry_path, &format!("{label}.entryPath"))?;
    }
    if let Some(range) = location.get("range") {
        let range = as_record(range, &format!("{label}.range"))?;
        let start = assert_required_non_negative_integer(
            range,
            "startByte",
            &format!("{label}.range.startByte"),
        )?;
        let end = assert_required_non_negative_integer(
            range,
            "endByte",
            &format!("{label}.range.endByte"),
        )?;
        if end <= start {
            return error(format!(
                "{label}.range.endByte must be greater than {label}.range.startByte"
            ));
        }
    }
    if let Some(region) = location.get("region") {
        validate_pixel_region(region, &format!("{label}.region"))?;
    }
    Ok(())
}

pub(super) fn validate_pixel_region(value: &Value, label: &str) -> BridgeContractResult<()> {
    let region = as_record(value, label)?;
    assert_required_non_negative_integer(region, "x", &format!("{label}.x"))?;
    assert_required_non_negative_integer(region, "y", &format!("{label}.y"))?;
    assert_required_positive_integer(region, "width", &format!("{label}.width"))?;
    assert_required_positive_integer(region, "height", &format!("{label}.height"))?;
    Ok(())
}
