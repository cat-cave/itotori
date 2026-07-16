use super::*;

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

pub fn validate_patch_result_v02(value: &Value) -> BridgeContractResult<()> {
    let result = as_record(value, "PatchResultV02")?;
    assert_schema_version(result, "PatchResultV02")?;
    assert_required_uuid7(result, "patchResultId", "PatchResultV02.patchResultId")?;
    let patch_export_id =
        assert_required_uuid7(result, "patchExportId", "PatchResultV02.patchExportId")?.to_string();
    assert_required_string(result, "adapterId", "PatchResultV02.adapterId")?;
    let status = assert_required_one_of(
        result,
        "status",
        &["passed", "failed", "incompatible_source"],
        "PatchResultV02.status",
    )?
    .to_string();
    let output_hash = match result.get("outputHash") {
        Some(value) => {
            assert_hash_value(value, "PatchResultV02.outputHash")?;
            Some(
                value
                    .as_str()
                    .expect("checked by assert_hash_value")
                    .to_string(),
            )
        }
        None => None,
    };

    let failures_value = required(result, "failures", "PatchResultV02.failures")?;
    let failures_array = array_value(failures_value, "PatchResultV02.failures")?;
    let mut observed_categories: Vec<String> = Vec::new();
    let mut failure_asset_ids: Vec<String> = Vec::new();
    let mut seen_failure_ids: HashSet<String> = HashSet::new();
    for (index, failure_value) in failures_array.iter().enumerate() {
        let failure_label = format!("PatchResultV02.failures[{index}]");
        let (failure_id, category, asset_id) =
            validate_patch_failure_v02(failure_value, &failure_label)?;
        if !seen_failure_ids.insert(failure_id.clone()) {
            return error(format!(
                "{failure_label}.failureId must not duplicate {failure_id}"
            ));
        }
        observed_categories.push(category);
        failure_asset_ids.push(asset_id);
    }

    let touched_assets = match result.get("touchedAssets") {
        Some(value) => Some(validate_patch_touched_assets_v02(
            value,
            "PatchResultV02.touchedAssets",
        )?),
        None => None,
    };

    let declared_categories = match result.get("failureCategories") {
        Some(value) => {
            let array = array_value(value, "PatchResultV02.failureCategories")?;
            let mut seen = HashSet::new();
            let mut declared = Vec::new();
            for (index, entry) in array.iter().enumerate() {
                let label = format!("PatchResultV02.failureCategories[{index}]");
                let category = string_value(entry, &label)?;
                assert_one_of(category, PATCH_FAILURE_CATEGORIES_V02, &label)?;
                if !seen.insert(category.to_string()) {
                    return error(format!("{label} must not duplicate {category}"));
                }
                declared.push(category.to_string());
            }
            Some(declared)
        }
        None => None,
    };

    let partial_write = match result.get("partialWrite") {
        Some(value) => Some(validate_patch_partial_write_accounting_v02(
            value,
            "PatchResultV02.partialWrite",
        )?),
        None => None,
    };

    let source_compatibility = result.get("sourceCompatibility");
    if let Some(report) = source_compatibility {
        let compatibility_status =
            validate_patch_source_compatibility_v02(report, "PatchResultV02.sourceCompatibility")?;
        let report_record = as_record(report, "PatchResultV02.sourceCompatibility")?;
        let report_patch_export_id = assert_required_uuid7(
            report_record,
            "patchExportId",
            "PatchResultV02.sourceCompatibility.patchExportId",
        )?;
        if report_patch_export_id != patch_export_id {
            return error(
                "PatchResultV02.sourceCompatibility.patchExportId must match PatchResultV02.patchExportId",
            );
        }
        if compatibility_status == "incompatible" && status != "incompatible_source" {
            return error(
                "PatchResultV02.status must be incompatible_source when sourceCompatibility.status is incompatible",
            );
        }
    }
    if status == "incompatible_source" && source_compatibility.is_none() {
        return error("PatchResultV02.sourceCompatibility is required for incompatible_source");
    }
    if status == "incompatible_source" {
        let report = as_record(
            source_compatibility.expect("checked above"),
            "PatchResultV02.sourceCompatibility",
        )?;
        let compatibility_status = assert_required_one_of(
            report,
            "status",
            &["compatible", "incompatible"],
            "PatchResultV02.sourceCompatibility.status",
        )?;
        if compatibility_status != "incompatible" {
            return error(
                "PatchResultV02.sourceCompatibility.status must be incompatible for incompatible_source",
            );
        }
    }

    if status == "passed" {
        let touched = match touched_assets.as_ref() {
            Some(touched) if !touched.is_empty() => touched,
            _ => {
                return error(
                    "PatchResultV02.touchedAssets must include at least one asset when status is passed: kaifuu.patch_result.passed_requires_touched_assets",
                );
            }
        };
        let Some(top_hash) = output_hash.as_ref() else {
            return error(
                "PatchResultV02.outputHash is required when status is passed: kaifuu.patch_result.passed_requires_output_hash",
            );
        };
        if !failures_array.is_empty() {
            return error(
                "PatchResultV02.failures must be empty when status is passed: kaifuu.patch_result.passed_must_have_no_failures",
            );
        }
        if declared_categories.is_some() {
            return error(
                "PatchResultV02.failureCategories must be omitted when status is passed: kaifuu.patch_result.passed_must_omit_failure_categories",
            );
        }
        if partial_write.is_some() {
            return error(
                "PatchResultV02.partialWrite must be omitted when status is passed: kaifuu.patch_result.passed_must_omit_partial_write",
            );
        }
        let rollup = compute_patch_result_output_hash_rollup_v02(touched);
        if rollup.as_str() != top_hash.as_str() {
            return error(format!(
                "PatchResultV02.outputHash must equal rollup of touchedAssets[].outputHash (expected {rollup}): kaifuu.patch_result.output_hash_drift"
            ));
        }
    }

    if status == "failed" || status == "incompatible_source" {
        if failures_array.is_empty() {
            return error(format!(
                "PatchResultV02.failures must include at least one entry when status is {status}: kaifuu.patch_result.non_passed_requires_failures"
            ));
        }
        let Some(declared) = declared_categories.as_ref() else {
            return error(format!(
                "PatchResultV02.failureCategories is required when status is {status}: kaifuu.patch_result.missing_failure_category"
            ));
        };
        let observed_set: HashSet<&str> = observed_categories.iter().map(String::as_str).collect();
        let declared_set: HashSet<&str> = declared.iter().map(String::as_str).collect();
        for observed in &observed_set {
            if !declared_set.contains(observed) {
                return error(format!(
                    "PatchResultV02.failureCategories is missing {observed}: kaifuu.patch_result.missing_failure_category"
                ));
            }
        }
        for declared in &declared_set {
            if !observed_set.contains(declared) {
                return error(format!(
                    "PatchResultV02.failureCategories contains unobserved {declared}: kaifuu.patch_result.unknown_failure_category"
                ));
            }
        }
        if output_hash.is_some() {
            return error(format!(
                "PatchResultV02.outputHash must be omitted when status is {status}"
            ));
        }
        if touched_assets.is_some() {
            return error(format!(
                "PatchResultV02.touchedAssets must be omitted when status is {status}"
            ));
        }
    }

    if status == "incompatible_source" {
        for category in &observed_categories {
            if category != "source_incompatible" {
                return error(
                    "PatchResultV02.failures[*].category must be source_incompatible when status is incompatible_source: kaifuu.patch_result.incompatible_source_category_required",
                );
            }
        }
    }

    if let Some(accounting) = partial_write.as_ref() {
        if status == "passed" {
            return error(
                "PatchResultV02.partialWrite must be omitted when status is passed: kaifuu.patch_result.passed_must_omit_partial_write",
            );
        }
        let attempted_set: HashSet<&str> = accounting
            .attempted_asset_ids
            .iter()
            .map(String::as_str)
            .collect();
        for asset_id in &failure_asset_ids {
            if !attempted_set.contains(asset_id.as_str()) {
                return error(format!(
                    "PatchResultV02.failures asset {asset_id} must appear in partialWrite.attemptedAssetIds: kaifuu.patch_result.silent_partial_write"
                ));
            }
        }
    }

    Ok(())
}

#[derive(Debug, Clone)]
struct PatchTouchedAssetSummary {
    asset_id: String,
    output_hash: String,
}

#[derive(Debug, Clone)]
struct PatchPartialWriteAccountingSummary {
    attempted_asset_ids: Vec<String>,
}

pub fn validate_patch_failure_v02(
    value: &Value,
    label: &str,
) -> BridgeContractResult<(String, String, String)> {
    let failure = as_record(value, label)?;
    let failure_id =
        assert_required_uuid7(failure, "failureId", &format!("{label}.failureId"))?.to_string();
    let category = assert_required_one_of(
        failure,
        "category",
        PATCH_FAILURE_CATEGORIES_V02,
        &format!("{label}.category"),
    )?
    .to_string();
    assert_required_string(
        failure,
        "diagnosticCode",
        &format!("{label}.diagnosticCode"),
    )?;
    assert_required_string(failure, "cause", &format!("{label}.cause"))?;
    let asset_id =
        assert_required_uuid7(failure, "assetId", &format!("{label}.assetId"))?.to_string();
    assert_required_uuid7(failure, "bridgeUnitId", &format!("{label}.bridgeUnitId"))?;
    assert_required_string(failure, "adapterId", &format!("{label}.adapterId"))?;
    assert_required_string(failure, "command", &format!("{label}.command"))?;
    if let Some(entry_id) = failure.get("patchExportEntryId") {
        assert_uuid7_value(entry_id, &format!("{label}.patchExportEntryId"))?;
    }
    if let Some(location) = failure.get("sourceLocation") {
        validate_source_location(location, &format!("{label}.sourceLocation"))?;
    }
    Ok((failure_id, category, asset_id))
}

fn validate_patch_touched_assets_v02(
    value: &Value,
    label: &str,
) -> BridgeContractResult<Vec<PatchTouchedAssetSummary>> {
    let array = array_value(value, label)?;
    let mut summaries = Vec::new();
    let mut seen = HashSet::new();
    for (index, entry) in array.iter().enumerate() {
        let entry_label = format!("{label}[{index}]");
        let asset = as_record(entry, &entry_label)?;
        let asset_id =
            assert_required_uuid7(asset, "assetId", &format!("{entry_label}.assetId"))?.to_string();
        let output_hash =
            assert_required_hash(asset, "outputHash", &format!("{entry_label}.outputHash"))?
                .to_string();
        assert_required_non_negative_integer(
            asset,
            "byteSize",
            &format!("{entry_label}.byteSize"),
        )?;
        if !seen.insert(asset_id.clone()) {
            return error(format!(
                "{entry_label}.assetId must not duplicate {asset_id}"
            ));
        }
        summaries.push(PatchTouchedAssetSummary {
            asset_id,
            output_hash,
        });
    }
    Ok(summaries)
}

pub fn validate_patch_partial_write_accounting_v02_pub(
    value: &Value,
    label: &str,
) -> BridgeContractResult<()> {
    validate_patch_partial_write_accounting_v02(value, label).map(|_| ())
}

fn validate_patch_partial_write_accounting_v02(
    value: &Value,
    label: &str,
) -> BridgeContractResult<PatchPartialWriteAccountingSummary> {
    let accounting = as_record(value, label)?;
    let attempted = collect_unique_uuid7_array(
        required(
            accounting,
            "attemptedAssetIds",
            &format!("{label}.attemptedAssetIds"),
        )?,
        &format!("{label}.attemptedAssetIds"),
    )?;
    let written = collect_unique_uuid7_array(
        required(
            accounting,
            "writtenAssetIds",
            &format!("{label}.writtenAssetIds"),
        )?,
        &format!("{label}.writtenAssetIds"),
    )?;
    let skipped = collect_unique_uuid7_array(
        required(
            accounting,
            "skippedAssetIds",
            &format!("{label}.skippedAssetIds"),
        )?,
        &format!("{label}.skippedAssetIds"),
    )?;
    let disposition = assert_required_one_of(
        accounting,
        "disposition",
        PATCH_PARTIAL_WRITE_DISPOSITIONS_V02,
        &format!("{label}.disposition"),
    )?
    .to_string();
    let rollback_diagnostic = match accounting.get("rollbackDiagnosticCode") {
        Some(value) => {
            let v = string_value(value, &format!("{label}.rollbackDiagnosticCode"))?;
            Some(v.to_string())
        }
        None => None,
    };

    let attempted_set: HashSet<&str> = attempted.iter().map(String::as_str).collect();
    let written_set: HashSet<&str> = written.iter().map(String::as_str).collect();
    let skipped_set: HashSet<&str> = skipped.iter().map(String::as_str).collect();
    if written_set.len() + skipped_set.len() != attempted_set.len() {
        return error(format!(
            "{label}.attemptedAssetIds must equal disjoint union of writtenAssetIds and skippedAssetIds: kaifuu.patch_result.silent_partial_write"
        ));
    }
    for id in &written_set {
        if skipped_set.contains(id) {
            return error(format!(
                "{label}.writtenAssetIds must not overlap skippedAssetIds: kaifuu.patch_result.silent_partial_write"
            ));
        }
        if !attempted_set.contains(id) {
            return error(format!(
                "{label}.attemptedAssetIds must equal disjoint union of writtenAssetIds and skippedAssetIds: kaifuu.patch_result.silent_partial_write"
            ));
        }
    }
    for id in &skipped_set {
        if !attempted_set.contains(id) {
            return error(format!(
                "{label}.attemptedAssetIds must equal disjoint union of writtenAssetIds and skippedAssetIds: kaifuu.patch_result.silent_partial_write"
            ));
        }
    }

    if disposition == "retained_partial" {
        if rollback_diagnostic.is_some() {
            return error(format!(
                "{label}.rollbackDiagnosticCode must be omitted when disposition is retained_partial"
            ));
        }
    } else if rollback_diagnostic.is_none() {
        return error(format!(
            "{label}.rollbackDiagnosticCode is required when disposition is {disposition}: kaifuu.patch_result.rollback_diagnostic_required"
        ));
    }

    Ok(PatchPartialWriteAccountingSummary {
        attempted_asset_ids: attempted,
    })
}

fn collect_unique_uuid7_array(value: &Value, label: &str) -> BridgeContractResult<Vec<String>> {
    let array = array_value(value, label)?;
    let mut seen = HashSet::new();
    let mut ids = Vec::new();
    for (index, item) in array.iter().enumerate() {
        let entry_label = format!("{label}[{index}]");
        let id = string_value(item, &entry_label)?;
        assert_uuid7(id, &entry_label)?;
        if !seen.insert(id.to_string()) {
            return error(format!("{entry_label} must not duplicate {id}"));
        }
        ids.push(id.to_string());
    }
    Ok(ids)
}

fn compute_patch_result_output_hash_rollup_v02(
    touched_assets: &[PatchTouchedAssetSummary],
) -> String {
    use sha2::{Digest, Sha256};
    use std::fmt::Write as _;
    let mut sorted: Vec<&PatchTouchedAssetSummary> = touched_assets.iter().collect();
    sorted.sort_by(|a, b| a.asset_id.cmp(&b.asset_id));
    let payload: String = sorted.iter().fold(String::new(), |mut acc, asset| {
        let _ = write!(acc, "{}\n{}\n", asset.asset_id, asset.output_hash);
        acc
    });
    let mut hasher = Sha256::new();
    hasher.update(payload.as_bytes());
    let digest = hasher.finalize();
    let mut hex = String::with_capacity(64);
    for byte in digest {
        let _ = write!(hex, "{byte:02x}");
    }
    format!("sha256:{hex}")
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
