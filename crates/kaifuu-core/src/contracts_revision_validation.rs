use super::*;

pub(super) fn validate_source_game_revision(
    value: &Value,
    label: &str,
) -> BridgeContractResult<()> {
    let source_game = as_record(value, label)?;
    assert_required_string(source_game, "gameId", &format!("{label}.gameId"))?;
    assert_required_string(source_game, "gameVersion", &format!("{label}.gameVersion"))?;
    assert_required_string(
        source_game,
        "sourceProfileId",
        &format!("{label}.sourceProfileId"),
    )?;
    validate_source_revision(
        required(
            source_game,
            "sourceProfileRevision",
            &format!("{label}.sourceProfileRevision"),
        )?,
        &format!("{label}.sourceProfileRevision"),
    )
}

pub(super) fn validate_source_revision(value: &Value, label: &str) -> BridgeContractResult<()> {
    let revision = as_record(value, label)?;
    assert_required_uuid7(revision, "revisionId", &format!("{label}.revisionId"))?;
    let revision_kind = assert_required_one_of(
        revision,
        "revisionKind",
        &["content_hash", "source_control", "build", "manual_snapshot"],
        &format!("{label}.revisionKind"),
    )?;
    let value = assert_required_string(revision, "value", &format!("{label}.value"))?;
    if revision_kind == "content_hash" {
        assert_hash(value, &format!("{label}.value"))?;
    }
    if let Some(created_at) = revision.get("createdAt") {
        assert_rfc3339_value(created_at, &format!("{label}.createdAt"))?;
    }
    Ok(())
}

pub(super) fn validate_hash_strategy(value: &Value, label: &str) -> BridgeContractResult<()> {
    let strategy = as_record(value, label)?;
    validate_hash_rule(
        required(strategy, "sourceProfile", &format!("{label}.sourceProfile"))?,
        &format!("{label}.sourceProfile"),
        "source_profile",
        "utf8-lf-json-stable-v1",
        false,
    )?;
    validate_hash_rule(
        required(strategy, "sourceBundle", &format!("{label}.sourceBundle"))?,
        &format!("{label}.sourceBundle"),
        "source_bundle",
        "utf8-lf-json-stable-v1",
        false,
    )?;
    validate_hash_rule(
        required(strategy, "sourceAsset", &format!("{label}.sourceAsset"))?,
        &format!("{label}.sourceAsset"),
        "source_asset",
        "bytes",
        false,
    )?;
    validate_hash_rule(
        required(strategy, "sourceUnit", &format!("{label}.sourceUnit"))?,
        &format!("{label}.sourceUnit"),
        "source_unit",
        "utf8-lf-json-stable-v1",
        true,
    )?;
    validate_hash_rule(
        required(strategy, "patchExport", &format!("{label}.patchExport"))?,
        &format!("{label}.patchExport"),
        "patch_export",
        "utf8-lf-json-stable-v1",
        false,
    )?;
    validate_hash_rule(
        required(strategy, "deltaPackage", &format!("{label}.deltaPackage"))?,
        &format!("{label}.deltaPackage"),
        "delta_package",
        "utf8-lf-json-stable-v1",
        false,
    )
}

fn validate_hash_rule(
    value: &Value,
    label: &str,
    expected_scope: &str,
    expected_normalization: &str,
    require_fields: bool,
) -> BridgeContractResult<()> {
    let rule = as_record(value, label)?;
    assert_literal(rule, "scope", expected_scope, &format!("{label}.scope"))?;
    assert_literal(rule, "algorithm", "sha256", &format!("{label}.algorithm"))?;
    assert_literal(
        rule,
        "normalization",
        expected_normalization,
        &format!("{label}.normalization"),
    )?;
    if let Some(fields) = rule.get("fields") {
        let fields = array_value(fields, &format!("{label}.fields"))?;
        for (index, field) in fields.iter().enumerate() {
            string_value(field, &format!("{label}.fields[{index}]"))?;
        }
        if require_fields && fields.is_empty() {
            return error(format!("{label}.fields must not be empty"));
        }
    } else if require_fields {
        return error(format!("{label}.fields must not be empty"));
    }
    Ok(())
}
