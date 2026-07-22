use super::*;

#[path = "patch_result.rs"]
mod patch_result;
pub use patch_result::{
    validate_patch_failure_v02, validate_patch_partial_write_accounting_v02_pub,
    validate_patch_result_v02,
};

pub fn validate_patch_export_v02(value: &Value) -> BridgeContractResult<()> {
    let patch = as_record(value, "PatchExportV02")?;
    assert_schema_version(patch, "PatchExportV02")?;
    assert_required_uuid7(patch, "patchExportId", "PatchExportV02.patchExportId")?;
    assert_required_uuid7(patch, "sourceBridgeId", "PatchExportV02.sourceBridgeId")?;
    validate_source_game_revision(
        required(patch, "sourceGame", "PatchExportV02.sourceGame")?,
        "PatchExportV02.sourceGame",
    )?;
    let source_bundle_hash =
        assert_required_hash(patch, "sourceBundleHash", "PatchExportV02.sourceBundleHash")?;
    validate_source_revision(
        required(
            patch,
            "sourceBundleRevision",
            "PatchExportV02.sourceBundleRevision",
        )?,
        "PatchExportV02.sourceBundleRevision",
    )?;
    assert_revision_hash_matches(
        required(
            patch,
            "sourceBundleRevision",
            "PatchExportV02.sourceBundleRevision",
        )?,
        source_bundle_hash,
        "PatchExportV02.sourceBundleRevision",
    )?;
    assert_required_string(patch, "sourceLocale", "PatchExportV02.sourceLocale")?;
    assert_required_string(patch, "targetLocale", "PatchExportV02.targetLocale")?;
    validate_hash_strategy(
        required(patch, "hashStrategy", "PatchExportV02.hashStrategy")?,
        "PatchExportV02.hashStrategy",
    )?;
    if let Some(hash) = patch.get("patchExportHash") {
        assert_hash_value(hash, "PatchExportV02.patchExportHash")?;
    }
    if let Some(generated_at) = patch.get("generatedAt") {
        assert_rfc3339_value(generated_at, "PatchExportV02.generatedAt")?;
    }

    let entries = required_array(patch, "entries", "PatchExportV02.entries")?;
    let mut entry_keys = HashSet::new();
    for (index, entry) in entries.iter().enumerate() {
        let label = format!("PatchExportV02.entries[{index}]");
        let entry = as_record(entry, &label)?;
        assert_required_uuid7(entry, "entryId", &format!("{label}.entryId"))?;
        let bridge_unit_id =
            assert_required_uuid7(entry, "bridgeUnitId", &format!("{label}.bridgeUnitId"))?;
        let source_unit_key =
            assert_required_string(entry, "sourceUnitKey", &format!("{label}.sourceUnitKey"))?;
        assert_required_hash(entry, "sourceHash", &format!("{label}.sourceHash"))?;
        validate_source_revision(
            required(entry, "sourceRevision", &format!("{label}.sourceRevision"))?,
            &format!("{label}.sourceRevision"),
        )?;
        assert_required_string(entry, "targetText", &format!("{label}.targetText"))?;
        let mappings = required_array(
            entry,
            "protectedSpanMappings",
            &format!("{label}.protectedSpanMappings"),
        )?;
        // v0.2 source identities (`sourceSpanId`) must be unique
        // within an entry (strict identity). Legacy raw-only spans carry no
        // identity and are intentionally NOT tracked here, so duplicate `raw`
        // stays compatibility-preserving. See the doc comment above.
        let mut seen_source_span_ids: HashSet<&str> = HashSet::new();
        for (mapping_index, mapping) in mappings.iter().enumerate() {
            let mapping_label = format!("{label}.protectedSpanMappings[{mapping_index}]");
            let mapping = as_record(mapping, &mapping_label)?;
            assert_required_string(mapping, "raw", &format!("{mapping_label}.raw"))?;
            if let Some(source_span_id) = mapping.get("sourceSpanId") {
                assert_uuid7_value(source_span_id, &format!("{mapping_label}.sourceSpanId"))?;
                let source_span_id = source_span_id
                    .as_str()
                    .expect("sourceSpanId validated as a string by assert_uuid7_value");
                if !seen_source_span_ids.insert(source_span_id) {
                    return error(format!(
                        "{mapping_label}.sourceSpanId duplicates an earlier protected-span source identity within {label}: kaifuu.patch_export.duplicate_source_span_identity"
                    ));
                }
            }
            let source_start = mapping
                .get("sourceStartByte")
                .map(|value| {
                    non_negative_integer_value(value, &format!("{mapping_label}.sourceStartByte"))
                })
                .transpose()?;
            let source_end = mapping
                .get("sourceEndByte")
                .map(|value| {
                    non_negative_integer_value(value, &format!("{mapping_label}.sourceEndByte"))
                })
                .transpose()?;
            if source_start.is_some() != source_end.is_some() {
                return error(format!(
                    "{mapping_label}.sourceStartByte and {mapping_label}.sourceEndByte must be provided together"
                ));
            }
            if let (Some(source_start), Some(source_end)) = (source_start, source_end)
                && source_end <= source_start
            {
                return error(format!(
                    "{mapping_label}.sourceEndByte must be greater than {mapping_label}.sourceStartByte"
                ));
            }
            let start = assert_required_non_negative_integer(
                mapping,
                "targetStart",
                &format!("{mapping_label}.targetStart"),
            )?;
            let end = assert_required_non_negative_integer(
                mapping,
                "targetEnd",
                &format!("{mapping_label}.targetEnd"),
            )?;
            if end <= start {
                return error(format!(
                    "{mapping_label}.targetEnd must be greater than {mapping_label}.targetStart"
                ));
            }
        }
        let entry_key = format!("{bridge_unit_id}\0{source_unit_key}");
        if !entry_keys.insert(entry_key) {
            return error(format!(
                "{label} must be unique by bridgeUnitId and sourceUnitKey"
            ));
        }
    }
    Ok(())
}

pub fn validate_patch_source_compatibility_v02(
    value: &Value,
    label: &str,
) -> BridgeContractResult<String> {
    validate_patch_source_compatibility_report_v02(value, label)
}

fn validate_patch_source_compatibility_report_v02(
    value: &Value,
    label: &str,
) -> BridgeContractResult<String> {
    let report = as_record(value, label)?;
    assert_schema_version(report, label)?;
    assert_required_uuid7(report, "patchExportId", &format!("{label}.patchExportId"))?;
    assert_required_uuid7(report, "sourceBridgeId", &format!("{label}.sourceBridgeId"))?;
    let status = assert_required_one_of(
        report,
        "status",
        &["compatible", "incompatible"],
        &format!("{label}.status"),
    )?;
    let expected_hash = assert_required_hash(
        report,
        "expectedSourceBundleHash",
        &format!("{label}.expectedSourceBundleHash"),
    )?;
    let actual_hash = assert_required_hash(
        report,
        "actualSourceBundleHash",
        &format!("{label}.actualSourceBundleHash"),
    )?;
    let matches = assert_required_bool(
        report,
        "sourceBundleHashMatches",
        &format!("{label}.sourceBundleHashMatches"),
    )?;
    if matches != (expected_hash == actual_hash) {
        return error(format!(
            "{label}.sourceBundleHashMatches must match source bundle hashes"
        ));
    }
    let compatible_units = required_array(
        report,
        "compatibleUnits",
        &format!("{label}.compatibleUnits"),
    )?;
    for (index, unit) in compatible_units.iter().enumerate() {
        let unit_label = format!("{label}.compatibleUnits[{index}]");
        let unit_status = validate_unit_source_compatibility(unit, &unit_label)?;
        if unit_status != "compatible" {
            return error(format!("{unit_label}.status must be compatible"));
        }
    }
    let incompatible_units = required_array(
        report,
        "incompatibleUnits",
        &format!("{label}.incompatibleUnits"),
    )?;
    for (index, unit) in incompatible_units.iter().enumerate() {
        let unit_label = format!("{label}.incompatibleUnits[{index}]");
        let unit_status = validate_unit_source_compatibility(unit, &unit_label)?;
        if unit_status != "incompatible" {
            return error(format!("{unit_label}.status must be incompatible"));
        }
    }
    if status == "compatible" && !incompatible_units.is_empty() {
        return error(format!(
            "{label}.status cannot be compatible with incompatibleUnits"
        ));
    }
    if status == "incompatible" && incompatible_units.is_empty() {
        return error(format!(
            "{label}.status cannot be incompatible with empty incompatibleUnits"
        ));
    }
    Ok(status.to_string())
}

fn validate_unit_source_compatibility(value: &Value, label: &str) -> BridgeContractResult<String> {
    let unit = as_record(value, label)?;
    assert_required_uuid7(unit, "entryId", &format!("{label}.entryId"))?;
    let bridge_unit_id =
        assert_required_uuid7(unit, "bridgeUnitId", &format!("{label}.bridgeUnitId"))?;
    let actual_bridge_unit_id = match unit.get("actualBridgeUnitId") {
        Some(value) => {
            let value = string_value(value, &format!("{label}.actualBridgeUnitId"))?;
            assert_uuid7(value, &format!("{label}.actualBridgeUnitId"))?;
            Some(value)
        }
        None => None,
    };
    assert_required_string(unit, "sourceUnitKey", &format!("{label}.sourceUnitKey"))?;
    let status = assert_required_one_of(
        unit,
        "status",
        &["compatible", "incompatible"],
        &format!("{label}.status"),
    )?;
    assert_required_hash(
        unit,
        "expectedSourceHash",
        &format!("{label}.expectedSourceHash"),
    )?;
    if let Some(actual_hash) = unit.get("actualSourceHash") {
        assert_hash_value(actual_hash, &format!("{label}.actualSourceHash"))?;
    }
    let reason = if let Some(reason) = unit.get("reason") {
        let reason = string_value(reason, &format!("{label}.reason"))?;
        assert_one_of(
            reason,
            &[
                "source_hash_mismatch",
                "missing_source_unit",
                "duplicate_source_unit_key",
                "bridge_unit_id_mismatch",
            ],
            &format!("{label}.reason"),
        )?;
        Some(reason)
    } else {
        None
    };
    if status == "incompatible" && reason.is_none() {
        return error(format!("{label}.reason is required for incompatible units"));
    }
    if status == "compatible" && reason.is_some() {
        return error(format!(
            "{label}.reason is only valid for incompatible units"
        ));
    }
    if reason == Some("bridge_unit_id_mismatch") && actual_bridge_unit_id.is_none() {
        return error(format!(
            "{label}.actualBridgeUnitId is required for bridge_unit_id_mismatch"
        ));
    }
    if reason != Some("bridge_unit_id_mismatch") && actual_bridge_unit_id.is_some() {
        return error(format!(
            "{label}.actualBridgeUnitId is only valid for bridge_unit_id_mismatch"
        ));
    }
    if actual_bridge_unit_id == Some(bridge_unit_id) {
        return error(format!(
            "{label}.actualBridgeUnitId must differ from {label}.bridgeUnitId"
        ));
    }
    Ok(status.to_string())
}
