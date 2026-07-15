use std::collections::HashSet;

use serde_json::{Map, Value};

use crate::{BridgeContractResult, BridgeContractValidationError};

pub(super) fn assert_string_array(value: &Value, label: &str) -> BridgeContractResult<()> {
    let array = super::array_value(value, label)?;
    for (index, item) in array.iter().enumerate() {
        super::string_value(item, &format!("{label}[{index}]"))?;
    }
    Ok(())
}

pub(super) fn assert_uuid7_array(value: &Value, label: &str) -> BridgeContractResult<Vec<String>> {
    let array = super::array_value(value, label)?;
    let mut ids = Vec::new();
    for (index, item) in array.iter().enumerate() {
        let item = super::string_value(item, &format!("{label}[{index}]"))?;
        super::assert_uuid7(item, &format!("{label}[{index}]"))?;
        ids.push(item.to_string());
    }
    Ok(ids)
}

pub(super) fn assert_string_enum_array(
    value: &Value,
    allowed: &[&str],
    label: &str,
) -> BridgeContractResult<()> {
    let array = super::array_value(value, label)?;
    for (index, item) in array.iter().enumerate() {
        let item = super::string_value(item, &format!("{label}[{index}]"))?;
        super::assert_one_of(item, allowed, &format!("{label}[{index}]"))?;
    }
    Ok(())
}

pub(super) fn assert_known_uuid_refs(
    value: &Value,
    label: &str,
    target_name: &str,
    known_ids: &HashSet<String>,
) -> BridgeContractResult<Vec<String>> {
    let ids = assert_uuid7_array(value, label)?;
    for (index, id) in ids.iter().enumerate() {
        if !known_ids.contains(id) {
            return error(format!(
                "{label}[{index}] must reference an existing {target_name}"
            ));
        }
    }
    Ok(ids)
}

pub(super) fn assert_known_string(
    id: &str,
    label: &str,
    target_name: &str,
    known_ids: &HashSet<String>,
) -> BridgeContractResult<()> {
    if known_ids.contains(id) {
        Ok(())
    } else {
        error(format!("{label} must reference an existing {target_name}"))
    }
}

pub(super) fn assert_exact_string_set(
    values: &HashSet<String>,
    expected_values: &[&str],
    label: &str,
) -> BridgeContractResult<()> {
    for expected in expected_values {
        if !values.contains(*expected) {
            return error(format!("{label} must include {expected}"));
        }
    }
    for value in values {
        if !expected_values.contains(&value.as_str()) {
            return error(format!("{label} contains unsupported value {value}"));
        }
    }
    Ok(())
}

pub(super) fn validate_alpha_proof_artifact_ref(
    value: &Value,
    label: &str,
    expected_kind: &str,
) -> BridgeContractResult<(String, String, String)> {
    let artifact_ref = super::as_record(value, label)?;
    super::assert_record_keys(
        artifact_ref,
        &[
            "artifactId",
            "artifactKind",
            "uri",
            "hash",
            "mediaType",
            "byteSize",
        ],
        label,
    )?;
    super::assert_required_uuid7(artifact_ref, "artifactId", &format!("{label}.artifactId"))?;
    let kind = super::assert_required_one_of(
        artifact_ref,
        "artifactKind",
        super::ALPHA_VERTICAL_PROOF_ARTIFACT_KINDS_V02,
        &format!("{label}.artifactKind"),
    )?;
    if kind != expected_kind {
        return error(format!("{label}.artifactKind must be {expected_kind}"));
    }
    assert_required_public_uri(artifact_ref, "uri", &format!("{label}.uri"))?;
    let uri = super::assert_required_string(artifact_ref, "uri", &format!("{label}.uri"))?;
    let hash = super::assert_required_hash(artifact_ref, "hash", &format!("{label}.hash"))?;
    if let Some(media_type) = artifact_ref.get("mediaType") {
        super::string_value(media_type, &format!("{label}.mediaType"))?;
    }
    if let Some(byte_size) = artifact_ref.get("byteSize") {
        super::positive_integer_value(byte_size, &format!("{label}.byteSize"))?;
    }
    Ok((kind.to_string(), uri.to_string(), hash.to_string()))
}

pub(super) fn validate_alpha_proof_content_hashes(
    value: &Value,
    label: &str,
) -> BridgeContractResult<Vec<(String, String, String)>> {
    let hashes = super::array_value(value, label)?;
    if hashes.is_empty() {
        return error(format!("{label} must contain at least one content hash"));
    }
    let mut entries = Vec::new();
    let mut keys = HashSet::new();
    for (index, hash) in hashes.iter().enumerate() {
        let hash_label = format!("{label}[{index}]");
        let entry = super::as_record(hash, &hash_label)?;
        super::assert_record_keys(entry, &["scope", "contentId", "hash"], &hash_label)?;
        let scope = super::assert_required_one_of(
            entry,
            "scope",
            super::ALPHA_VERTICAL_PROOF_HASH_SCOPES_V02,
            &format!("{hash_label}.scope"),
        )?;
        let content_id =
            super::assert_required_string(entry, "contentId", &format!("{hash_label}.contentId"))?;
        let hash = super::assert_required_hash(entry, "hash", &format!("{hash_label}.hash"))?;
        let key = format!("{scope}\0{content_id}");
        if !keys.insert(key) {
            return error(format!(
                "{hash_label} must be unique by scope and contentId"
            ));
        }
        entries.push((scope.to_string(), content_id.to_string(), hash.to_string()));
    }
    Ok(entries)
}

pub(super) fn assert_alpha_hash_covered(
    hashes: &[(String, String, String)],
    scope: &str,
    content_id: &str,
    hash: &str,
    label: &str,
) -> BridgeContractResult<()> {
    if hashes
        .iter()
        .any(|(candidate_scope, candidate_content_id, candidate_hash)| {
            candidate_scope == scope && candidate_content_id == content_id && candidate_hash == hash
        })
    {
        Ok(())
    } else {
        error(format!(
            "{label} must be represented in AlphaVerticalProofManifestV02.contentHashes"
        ))
    }
}

pub(super) fn assert_alpha_hash_scope_content_id(
    hashes: &[(String, String, String)],
    scope: &str,
    content_id: &str,
    label: &str,
) -> BridgeContractResult<()> {
    if hashes
        .iter()
        .any(|(candidate_scope, candidate_content_id, _candidate_hash)| {
            candidate_scope == scope && candidate_content_id == content_id
        })
    {
        Ok(())
    } else {
        error(format!(
            "{label} must be represented in AlphaVerticalProofManifestV02.contentHashes"
        ))
    }
}

pub(super) fn alpha_hash_scope_for_artifact_kind(kind: &str) -> &str {
    match kind {
        "public_fixture_manifest" => "public_fixture_manifest",
        "bridge_bundle" => "bridge_bundle",
        "patch_export" => "patch_export",
        "patch_result" => "patch_result",
        "delta_package" => "delta_package",
        "runtime_report" => "runtime_report",
        "finding_report" => "finding_report",
        "benchmark_report" => "benchmark_report",
        _ => unreachable!(),
    }
}

pub(super) fn assert_fixture_path_value(value: &Value, label: &str) -> BridgeContractResult<()> {
    let value = super::string_value(value, label)?;
    assert_fixture_path(value, label)
}

pub(super) fn assert_fixture_path(value: &str, label: &str) -> BridgeContractResult<()> {
    if !value.starts_with("./") {
        return error(format!(
            "{label} must be a relative fixture path starting with ./"
        ));
    }
    // reason: this validates an already-normalized relative fixture path against
    // a deliberate literal lowercase `.json` suffix contract (not a filesystem
    // extension probe); a case-insensitive `Path::extension` match would weaken
    // the normalization guarantee and change accepted inputs.
    #[allow(clippy::case_sensitive_file_extension_comparisons)]
    let is_json_suffix = value.ends_with(".json");
    if value.contains("..") || value.contains("//") || !is_json_suffix {
        return error(format!("{label} must be a normalized JSON fixture path"));
    }
    assert_portable_path(value, label)
}

pub(super) fn assert_fixture_path_array(
    value: &Value,
    label: &str,
    require_non_empty: bool,
) -> BridgeContractResult<()> {
    let paths = super::array_value(value, label)?;
    if require_non_empty && paths.is_empty() {
        return error(format!("{label} must contain at least one fixture path"));
    }
    for (index, path) in paths.iter().enumerate() {
        assert_fixture_path_value(path, &format!("{label}[{index}]"))?;
    }
    Ok(())
}

pub(super) fn assert_unique_path(
    paths: &mut HashSet<String>,
    path: &str,
    label: &str,
) -> BridgeContractResult<()> {
    if !paths.insert(path.to_string()) {
        return error(format!(
            "{label}.path must be unique within the contract fixture manifest"
        ));
    }
    Ok(())
}

pub(super) fn assert_command_tokens(value: &Value, label: &str) -> BridgeContractResult<()> {
    let tokens = super::array_value(value, label)?;
    if tokens.is_empty() {
        return error(format!("{label} must contain at least one command token"));
    }
    for (index, token) in tokens.iter().enumerate() {
        super::string_value(token, &format!("{label}[{index}]"))?;
    }
    Ok(())
}

pub(super) fn assert_portable_uri(value: &Value, label: &str) -> BridgeContractResult<()> {
    let value = super::string_value(value, label)?;
    assert_portable_path(value, label)?;
    if value.starts_with("data:") || value.starts_with("file:") {
        return error(format!(
            "{label} must reference an artifact, not embed artifact bytes"
        ));
    }
    Ok(())
}

pub(super) fn assert_required_public_uri(
    record: &Map<String, Value>,
    key: &str,
    label: &str,
) -> BridgeContractResult<()> {
    let value = super::required(record, key, label)?;
    assert_portable_uri(value, label)?;
    let value = super::string_value(value, label)?;
    if value.contains("fixtures/private-local/") {
        return error(format!("{label} must not reference fixtures/private-local"));
    }
    Ok(())
}

pub(super) fn assert_portable_path(value: &str, label: &str) -> BridgeContractResult<()> {
    if value.starts_with('/') {
        return error(format!(
            "{label} must be portable and must not be an absolute local path"
        ));
    }
    if value.contains('\\') || value.as_bytes().get(1) == Some(&b':') {
        return error(format!(
            "{label} must use portable forward-slash artifact paths"
        ));
    }
    Ok(())
}

pub(super) fn assert_number_within_tolerance(
    value: f64,
    expected: f64,
    label: &str,
    expectation: &str,
) -> BridgeContractResult<()> {
    if (value - expected).abs() > 0.01 {
        error(format!("{label} must match {expectation}"))
    } else {
        Ok(())
    }
}

pub(super) fn assert_no_confidence_fields(value: &Value, label: &str) -> BridgeContractResult<()> {
    match value {
        Value::Array(items) => {
            for (index, item) in items.iter().enumerate() {
                assert_no_confidence_fields(item, &format!("{label}[{index}]"))?;
            }
        }
        Value::Object(object) => {
            for (key, child) in object {
                if key.to_ascii_lowercase().contains("confidence") {
                    return error(format!(
                        "{label}.{key} is not allowed; record evidence instead of confidence"
                    ));
                }
                assert_no_confidence_fields(child, &format!("{label}.{key}"))?;
            }
        }
        _ => {}
    }
    Ok(())
}

pub(super) fn assert_no_raw_private_or_secret_fields(
    value: &Value,
    label: &str,
) -> BridgeContractResult<()> {
    match value {
        Value::Array(items) => {
            for (index, item) in items.iter().enumerate() {
                assert_no_raw_private_or_secret_fields(item, &format!("{label}[{index}]"))?;
            }
        }
        Value::Object(object) => {
            for (key, child) in object {
                if [
                    "authorization",
                    "apiKey",
                    "api_key",
                    "bearer",
                    "completionText",
                    "completion_text",
                    "password",
                    "privateKey",
                    "private_key",
                    "promptText",
                    "prompt_text",
                    "rawContent",
                    "raw_content",
                    "rawPrivateData",
                    "raw_private_data",
                    "rawText",
                    "raw_text",
                    "requestBody",
                    "request_body",
                    "responseBody",
                    "response_body",
                    "secret",
                ]
                .contains(&key.as_str())
                {
                    return error(format!(
                        "{label}.{key} is not allowed; record ids, hashes, or artifact refs"
                    ));
                }
                assert_no_raw_private_or_secret_fields(child, &format!("{label}.{key}"))?;
            }
        }
        Value::String(value) if value.contains("fixtures/private-local/") => {
            return error(format!("{label} must not reference fixtures/private-local"));
        }
        _ => {}
    }
    Ok(())
}

pub(super) fn assert_no_mutable_event_bucket_fields(
    value: &Value,
    label: &str,
) -> BridgeContractResult<()> {
    match value {
        Value::Array(items) => {
            for (index, item) in items.iter().enumerate() {
                assert_no_mutable_event_bucket_fields(item, &format!("{label}[{index}]"))?;
            }
        }
        Value::Object(object) => {
            for (key, child) in object {
                if ["status", "currentStatus", "updatedAt", "deletedAt"].contains(&key.as_str()) {
                    return error(format!(
                        "{label}.{key} is not allowed on append-only events"
                    ));
                }
                assert_no_mutable_event_bucket_fields(child, &format!("{label}.{key}"))?;
            }
        }
        _ => {}
    }
    Ok(())
}

pub(super) fn error<T>(message: impl Into<String>) -> BridgeContractResult<T> {
    Err(BridgeContractValidationError::new(message))
}
