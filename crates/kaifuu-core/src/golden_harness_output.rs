use super::*;

/// Adapter-neutral preservation signature for a single inventory asset: prefer
/// the on-disk bytes when the asset's declared `path` resolves to a readable
/// file, otherwise fall back to the adapter-reported `source_hash`. Either way
/// the value is sourced from what the adapter itself reports, never from a
/// hard-coded `source.json` assumption.
pub(crate) fn asset_preservation_signature(base_dir: &Path, asset: &AssetInventoryAsset) -> String {
    if let Some(path) = &asset.path
        && let Ok(resolved) = safe_join_relative(base_dir, path)
        && let Ok(bytes) = fs::read(&resolved)
    {
        return format!("bytes:{}", byte_content_hash(&bytes));
    }
    match &asset.source_hash {
        Some(hash) => format!("reportedHash:{hash}"),
        None => format!("noSignature:{}", asset.asset_id),
    }
}

pub(crate) fn report_verify_phase(
    adapter: &dyn EngineAdapter,
    report: &mut GoldenRoundTripReport,
    phase: &str,
    game_dir: &Path,
) {
    match adapter.verify(VerifyRequest { game_dir }) {
        Ok(verify) if verify.status == OperationStatus::Passed => report_passed_phase(
            report,
            phase,
            "adapter verification passed",
            Some("source.json"),
        ),
        Ok(verify) => {
            if verify.failures.is_empty() {
                record_golden_failure(
                    report,
                    GoldenFailure {
                        code: "verify_failed_without_detail".to_string(),
                        phase: phase.to_string(),
                        adapter_id: adapter.id().to_string(),
                        message: "adapter verification failed without detailed failures"
                            .to_string(),
                        asset_ref: Some("source.json".to_string()),
                        source_unit_key: None,
                        support_boundary: None,
                        expected: Some("verify status passed".to_string()),
                        actual: Some("verify status failed".to_string()),
                        required_capability: None,
                    },
                );
            } else {
                for failure in verify
                    .failures
                    .iter()
                    .map(AdapterFailure::redacted_for_report)
                {
                    let asset_ref = failure.asset_ref.clone();
                    record_golden_failure(
                        report,
                        GoldenFailure {
                            code: failure.error_code,
                            phase: phase.to_string(),
                            adapter_id: adapter.id().to_string(),
                            message: golden_diagnostic_summary(
                                failure
                                    .remediation
                                    .as_deref()
                                    .unwrap_or(&failure.support_boundary),
                            ),
                            source_unit_key: source_unit_key_from_asset_ref(asset_ref.as_deref()),
                            asset_ref,
                            support_boundary: Some(golden_diagnostic_summary(
                                &failure.support_boundary,
                            )),
                            expected: Some("verify status passed".to_string()),
                            actual: Some("verify status failed".to_string()),
                            required_capability: None,
                        },
                    );
                }
            }
        }
        Err(error) => record_golden_failure(
            report,
            GoldenFailure {
                code: "verify_error".to_string(),
                phase: phase.to_string(),
                adapter_id: adapter.id().to_string(),
                message: golden_error_summary(&error),
                asset_ref: Some("source.json".to_string()),
                source_unit_key: None,
                support_boundary: None,
                expected: Some("successful verification".to_string()),
                actual: Some("adapter error".to_string()),
                required_capability: None,
            },
        ),
    }
}

pub(crate) fn report_output_equivalence(
    adapter: &dyn EngineAdapter,
    report: &mut GoldenRoundTripReport,
    original_extraction: &ExtractionResult,
    output_dir: &Path,
    phase: &str,
) {
    let patched_extraction = match adapter.extract(ExtractRequest {
        game_dir: output_dir,
    }) {
        Ok(extraction) => extraction,
        Err(error) => {
            record_golden_failure(
                report,
                GoldenFailure {
                    code: "output_equivalence_extract_error".to_string(),
                    phase: phase.to_string(),
                    adapter_id: adapter.id().to_string(),
                    message: golden_error_summary(&error),
                    asset_ref: Some("source.json".to_string()),
                    source_unit_key: None,
                    support_boundary: Some(
                        "output equivalence requires patched output to remain extractable"
                            .to_string(),
                    ),
                    expected: Some("extractable patched output".to_string()),
                    actual: Some("adapter extract error".to_string()),
                    required_capability: None,
                },
            );
            return;
        }
    };

    let expected = unit_signatures(&original_extraction.bridge);
    let actual = unit_signatures(&patched_extraction.bridge);
    if expected == actual {
        report_passed_phase(
            report,
            phase,
            "patched output extracts to the same source unit text and hashes",
            Some("source.json"),
        );
        return;
    }

    for (key, expected_signature) in &expected {
        match actual.get(key) {
            Some(actual_signature) if actual_signature == expected_signature => {}
            Some(_) => record_golden_failure(
                report,
                GoldenFailure {
                    code: "output_unit_mismatch".to_string(),
                    phase: phase.to_string(),
                    adapter_id: adapter.id().to_string(),
                    message: "patched output changed an extracted source unit".to_string(),
                    asset_ref: Some(format!("source.json#{key}")),
                    source_unit_key: Some(key.clone()),
                    support_boundary: Some(
                        "unchanged patch output equivalence requires source units to extract identically"
                            .to_string(),
                    ),
                    expected: original_extraction
                        .bridge
                        .units
                        .iter()
                        .rev()
                        .find(|unit| unit.source_unit_key == *key)
                        .map(unit_signature_summary),
                    actual: patched_extraction
                        .bridge
                        .units
                        .iter()
                        .rev()
                        .find(|unit| unit.source_unit_key == *key)
                        .map(unit_signature_summary),
                                    required_capability: None,
},
            ),
            None => record_golden_failure(
                report,
                GoldenFailure {
                    code: "output_unit_missing".to_string(),
                    phase: phase.to_string(),
                    adapter_id: adapter.id().to_string(),
                    message: "patched output is missing an extracted source unit".to_string(),
                    asset_ref: Some(format!("source.json#{key}")),
                    source_unit_key: Some(key.clone()),
                    support_boundary: Some(
                        "unchanged patch output equivalence requires all source units to remain present"
                            .to_string(),
                    ),
                    expected: original_extraction
                        .bridge
                        .units
                        .iter()
                        .rev()
                        .find(|unit| unit.source_unit_key == *key)
                        .map(unit_signature_summary),
                    actual: None,
                                    required_capability: None,
},
            ),
        }
    }

    for key in actual.keys().filter(|key| !expected.contains_key(*key)) {
        record_golden_failure(
            report,
            GoldenFailure {
                code: "output_unit_unexpected".to_string(),
                phase: phase.to_string(),
                adapter_id: adapter.id().to_string(),
                message: "patched output contains an unexpected extracted source unit".to_string(),
                asset_ref: Some(format!("source.json#{key}")),
                source_unit_key: Some(key.clone()),
                support_boundary: Some(
                    "unchanged patch output equivalence requires no extra source units".to_string(),
                ),
                expected: None,
                actual: patched_extraction
                    .bridge
                    .units
                    .iter()
                    .rev()
                    .find(|unit| unit.source_unit_key == *key)
                    .map(unit_signature_summary),
                required_capability: None,
            },
        );
    }
}

pub(crate) fn unit_signatures(bridge: &BridgeBundle) -> BTreeMap<String, String> {
    bridge
        .units
        .iter()
        .map(|unit| {
            (
                unit.source_unit_key.clone(),
                format!("{}:{}", unit.source_hash, unit.source_text),
            )
        })
        .collect()
}

pub(crate) fn unit_signature_summary(unit: &BridgeUnit) -> String {
    format!(
        "sourceHash={}; sourceText={}",
        unit.source_hash,
        RedactedContentSummary::from_text(&unit.source_text)
    )
}

pub(crate) fn report_translated_patch(
    adapter: &dyn EngineAdapter,
    report: &mut GoldenRoundTripReport,
    extraction: &ExtractionResult,
    game_dir: &Path,
    work_dir: &Path,
    patch_export_value: &Value,
    translated_source_bridge: Option<&Value>,
) -> KaifuuResult<()> {
    if patch_export_value["schemaVersion"].as_str() == Some(BRIDGE_SCHEMA_VERSION_V02) {
        match contracts::validate_patch_export_v02(patch_export_value) {
            Ok(()) => report_passed_phase(
                report,
                "translated_patch_contract",
                "translated v0.2 patch export passed contract validation",
                None,
            ),
            Err(error) => {
                record_golden_failure(
                    report,
                    GoldenFailure {
                        code: "translated_patch_contract_invalid".to_string(),
                        phase: "translated_patch_contract".to_string(),
                        adapter_id: adapter.id().to_string(),
                        message: golden_error_summary(&error),
                        asset_ref: None,
                        source_unit_key: None,
                        support_boundary: Some(
                            "translated public fixture patches must satisfy PatchExportV02"
                                .to_string(),
                        ),
                        expected: Some("valid PatchExportV02".to_string()),
                        actual: Some("invalid patch export".to_string()),
                        required_capability: None,
                    },
                );
                return Ok(());
            }
        }
        report_v02_source_compatibility(
            report,
            adapter.id(),
            &extraction.bridge,
            patch_export_value,
            translated_source_bridge,
        );
    }

    if report
        .failures
        .iter()
        .any(|failure| failure.phase == "translated_source_compatibility")
    {
        return Ok(());
    }

    let patch_export = match patch_export_for_adapter(patch_export_value, &extraction.bridge) {
        Ok(patch_export) => patch_export,
        Err(error) => {
            record_golden_failure(
                report,
                GoldenFailure {
                    code: "translated_patch_conversion_failed".to_string(),
                    phase: "translated_patch_conversion".to_string(),
                    adapter_id: adapter.id().to_string(),
                    message: golden_error_summary(&error),
                    asset_ref: None,
                    source_unit_key: None,
                    support_boundary: Some(
                        "translated patch conversion requires every sourceUnitKey to exist in the current extraction"
                            .to_string(),
                    ),
                    expected: Some("convertible patch export".to_string()),
                    actual: Some("conversion error".to_string()),
                                    required_capability: None,
},
            );
            return Ok(());
        }
    };

    report_passed_phase(
        report,
        "translated_patch_conversion",
        "translated patch export converted to the adapter patch contract",
        None,
    );

    let Some(output_dir) = run_golden_patch_phase(GoldenPatchPhaseArgs {
        adapter,
        report,
        phase: "translated_patch",
        game_dir,
        work_dir,
        work_child: "translated-patch",
        patch_export: &patch_export,
        success_details: "translated patch applied successfully",
        patch_error_code: "translated_patch_error",
        patch_expected: "successful translated patch",
    })?
    else {
        return Ok(());
    };

    report_translated_target_equivalence(report, adapter.id(), &patch_export, &output_dir);
    report_verify_phase(adapter, report, "translated_verify", &output_dir);
    Ok(())
}
