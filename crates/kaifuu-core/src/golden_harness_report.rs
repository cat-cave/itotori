use super::*;

pub(crate) fn record_adapter_failures(
    report: &mut GoldenRoundTripReport,
    adapter_id: &str,
    phase: &str,
    patch_result: &PatchResult,
) {
    if patch_result.failures.is_empty() {
        record_golden_failure(
            report,
            GoldenFailure {
                code: "patch_failed_without_detail".to_string(),
                phase: phase.to_string(),
                adapter_id: adapter_id.to_string(),
                message: "adapter returned failed patch status without detailed failures"
                    .to_string(),
                asset_ref: None,
                source_unit_key: None,
                support_boundary: None,
                expected: Some("patch status passed".to_string()),
                actual: Some("patch status failed".to_string()),
                required_capability: None,
            },
        );
        return;
    }

    for failure in patch_result
        .failures
        .iter()
        .map(AdapterFailure::redacted_for_report)
    {
        let asset_ref = failure.asset_ref.clone();
        record_golden_failure(
            report,
            GoldenFailure {
                code: failure.error_code.clone(),
                phase: phase.to_string(),
                adapter_id: adapter_id.to_string(),
                message: golden_diagnostic_summary(
                    failure
                        .remediation
                        .as_deref()
                        .unwrap_or(&failure.support_boundary),
                ),
                source_unit_key: source_unit_key_from_asset_ref(asset_ref.as_deref()),
                asset_ref,
                support_boundary: Some(golden_diagnostic_summary(&failure.support_boundary)),
                expected: Some("patch status passed".to_string()),
                actual: Some("patch status failed".to_string()),
                required_capability: None,
            },
        );
    }
}

pub(crate) fn report_byte_equivalence(
    adapter: &dyn EngineAdapter,
    report: &mut GoldenRoundTripReport,
    game_dir: &Path,
    output_dir: &Path,
    mode: &GoldenByteEquivalenceMode,
) {
    match mode {
        GoldenByteEquivalenceMode::AssertInventory => {
            report_inventory_asset_preservation(adapter, report, game_dir, output_dir);
        }
        GoldenByteEquivalenceMode::Unsupported { support_boundary } => {
            report.phases.push(GoldenPhaseReport {
                phase: "byte_equivalence".to_string(),
                status: GoldenAssertionStatus::Skipped,
                details: "byte-identical round-trip is not claimed for this adapter".to_string(),
                asset_ref: Some("source.json".to_string()),
                source_unit_key: None,
                support_boundary: Some(support_boundary.clone()),
                expected: None,
                actual: None,
                required_capability: None,
            });
        }
        GoldenByteEquivalenceMode::AssertSourceJson => {
            let original_path = game_dir.join("source.json");
            let patched_path = output_dir.join("source.json");
            match (fs::read(&original_path), fs::read(&patched_path)) {
                (Ok(original), Ok(patched)) if original == patched => report_passed_phase(
                    report,
                    "byte_equivalence",
                    "source.json bytes are identical after unchanged patch",
                    Some("source.json"),
                ),
                (Ok(original), Ok(patched)) => record_golden_failure(
                    report,
                    GoldenFailure {
                        code: "byte_equivalence_mismatch".to_string(),
                        phase: "byte_equivalence".to_string(),
                        adapter_id: report.adapter_id.clone(),
                        message: "source.json bytes changed after unchanged patch".to_string(),
                        asset_ref: Some("source.json".to_string()),
                        source_unit_key: None,
                        support_boundary: Some(
                            "byte-identical mode requires unchanged patch output to match the input bytes"
                                .to_string(),
                        ),
                        expected: Some(byte_content_hash(&original)),
                        actual: Some(byte_content_hash(&patched)),
                                            required_capability: None,
},
                ),
                (original, patched) => record_golden_failure(
                    report,
                    GoldenFailure {
                        code: "byte_equivalence_io_error".to_string(),
                        phase: "byte_equivalence".to_string(),
                        adapter_id: report.adapter_id.clone(),
                        message: format!(
                            "could not read source.json for byte comparison: original={}, patched={}",
                            original
                                .err()
                                .map(golden_error_summary)
                                .unwrap_or_default(),
                            patched
                                .err()
                                .map(golden_error_summary)
                                .unwrap_or_default()
                        ),
                        asset_ref: Some("source.json".to_string()),
                        source_unit_key: None,
                        support_boundary: Some(
                            "byte-identical mode requires source.json to exist before and after patching"
                                .to_string(),
                        ),
                        expected: Some("readable source.json input and output".to_string()),
                        actual: Some("missing or unreadable source.json".to_string()),
                                            required_capability: None,
},
                ),
            }
        }
    }
}

/// adapter-neutral asset-preservation phase.
/// Instead of reading a hard-coded `source.json`, this re-runs the adapter's
/// own `asset_inventory` on both the input and the unchanged-patch output and
/// drives assertions off the adapter's INVENTORY + CAPABILITY reports:
/// * For every surface the adapter reports as capability-unsupported
///   ([`derive_asset_preservation_claims`]), it records a TYPED capability-aware
///   diagnostic (`asset_capability_diagnostic`, carrying the required
///   `Capability`) — proving an unsupported asset surfaces a structured
///   diagnostic rather than a silent skip.
/// * Because the adapter declares it cannot edit those assets, an identity
///   round-trip MUST preserve them: the harness compares each backing asset's
///   preservation signature (on-disk bytes when the asset path resolves to a
///   file, otherwise the adapter-reported `source_hash`) between input and
///   output and fails on any mutation, missing, or unexpected asset.
///   This makes no assumption about a `source.json` file or on-disk layout, so it
///   works for an adapter whose inventory names assets under any scheme.
pub(crate) fn report_inventory_asset_preservation(
    adapter: &dyn EngineAdapter,
    report: &mut GoldenRoundTripReport,
    game_dir: &Path,
    output_dir: &Path,
) {
    let original = match adapter.asset_inventory(AssetInventoryRequest { game_dir }) {
        Ok(manifest) => manifest,
        Err(error) => {
            record_golden_failure(
                report,
                GoldenFailure {
                    code: "inventory_asset_preservation_input_error".to_string(),
                    phase: "inventory_asset_preservation".to_string(),
                    adapter_id: adapter.id().to_string(),
                    message: golden_error_summary(&error),
                    asset_ref: None,
                    source_unit_key: None,
                    support_boundary: Some(
                        "adapter-neutral asset preservation requires the adapter to report an asset inventory for the input"
                            .to_string(),
                    ),
                    expected: Some("asset inventory for input".to_string()),
                    actual: Some("adapter inventory error".to_string()),
                    required_capability: Some(Capability::AssetInventory),
                },
            );
            return;
        }
    };
    let patched = match adapter.asset_inventory(AssetInventoryRequest {
        game_dir: output_dir,
    }) {
        Ok(manifest) => manifest,
        Err(error) => {
            record_golden_failure(
                report,
                GoldenFailure {
                    code: "inventory_asset_preservation_output_error".to_string(),
                    phase: "inventory_asset_preservation".to_string(),
                    adapter_id: adapter.id().to_string(),
                    message: golden_error_summary(&error),
                    asset_ref: None,
                    source_unit_key: None,
                    support_boundary: Some(
                        "adapter-neutral asset preservation requires the unchanged-patch output to remain inventoriable"
                            .to_string(),
                    ),
                    expected: Some("asset inventory for patched output".to_string()),
                    actual: Some("adapter inventory error".to_string()),
                    required_capability: Some(Capability::AssetInventory),
                },
            );
            return;
        }
    };

    let original_assets: BTreeMap<&str, &AssetInventoryAsset> = original
        .assets
        .iter()
        .map(|asset| (asset.asset_id.as_str(), asset))
        .collect();
    let patched_assets: BTreeMap<&str, &AssetInventoryAsset> = patched
        .assets
        .iter()
        .map(|asset| (asset.asset_id.as_str(), asset))
        .collect();

    let claims = derive_asset_preservation_claims(&original);
    let mut preserved = 0usize;
    let mut had_failure = false;

    for claim in &claims {
        // Record the capability-aware unsupported-asset diagnostic (typed).
        report.phases.push(GoldenPhaseReport {
            phase: "asset_capability_diagnostic".to_string(),
            status: GoldenAssertionStatus::Skipped,
            details: format!(
                "adapter reports asset surface {} as capability-unsupported ({:?}); underlying asset must be preserved unchanged",
                claim.surface_id, claim.required_capability
            ),
            asset_ref: Some(claim.asset_ref.clone()),
            source_unit_key: None,
            support_boundary: Some(claim.support_boundary.clone()),
            expected: None,
            actual: None,
            required_capability: Some(claim.required_capability.clone()),
        });

        let Some(original_asset) = original_assets.get(claim.asset_id.as_str()) else {
            had_failure = true;
            record_golden_failure(
                report,
                GoldenFailure {
                    code: "inventory_asset_missing_in_input".to_string(),
                    phase: "inventory_asset_preservation".to_string(),
                    adapter_id: adapter.id().to_string(),
                    message: format!(
                        "surface {} references asset {} that the input inventory does not list",
                        claim.surface_id, claim.asset_ref
                    ),
                    asset_ref: Some(claim.asset_ref.clone()),
                    source_unit_key: None,
                    support_boundary: Some(claim.support_boundary.clone()),
                    expected: Some("asset present in input inventory".to_string()),
                    actual: Some("asset absent".to_string()),
                    required_capability: Some(claim.required_capability.clone()),
                },
            );
            continue;
        };
        let Some(patched_asset) = patched_assets.get(claim.asset_id.as_str()) else {
            had_failure = true;
            record_golden_failure(
                report,
                GoldenFailure {
                    code: "inventory_asset_missing_after_patch".to_string(),
                    phase: "inventory_asset_preservation".to_string(),
                    adapter_id: adapter.id().to_string(),
                    message: format!(
                        "capability-unsupported asset {} disappeared from the inventory after an unchanged patch",
                        claim.asset_ref
                    ),
                    asset_ref: Some(claim.asset_ref.clone()),
                    source_unit_key: None,
                    support_boundary: Some(claim.support_boundary.clone()),
                    expected: Some("asset preserved in patched inventory".to_string()),
                    actual: Some("asset absent after patch".to_string()),
                    required_capability: Some(claim.required_capability.clone()),
                },
            );
            continue;
        };

        let expected_signature = asset_preservation_signature(game_dir, original_asset);
        let actual_signature = asset_preservation_signature(output_dir, patched_asset);
        if expected_signature == actual_signature {
            preserved += 1;
        } else {
            had_failure = true;
            record_golden_failure(
                report,
                GoldenFailure {
                    code: "inventory_unsupported_asset_mutated".to_string(),
                    phase: "inventory_asset_preservation".to_string(),
                    adapter_id: adapter.id().to_string(),
                    message: format!(
                        "capability-unsupported asset {} changed after an unchanged patch even though the adapter cannot edit it",
                        claim.asset_ref
                    ),
                    asset_ref: Some(claim.asset_ref.clone()),
                    source_unit_key: None,
                    support_boundary: Some(claim.support_boundary.clone()),
                    expected: Some(expected_signature),
                    actual: Some(actual_signature),
                    required_capability: Some(claim.required_capability.clone()),
                },
            );
        }
    }

    if had_failure {
        return;
    }

    let details = if claims.is_empty() {
        "adapter inventory reports no capability-unsupported assets to preserve".to_string()
    } else {
        format!(
            "{preserved} capability-unsupported asset(s) preserved across the unchanged patch, driven by adapter inventory + capability reports",
        )
    };
    report.phases.push(GoldenPhaseReport {
        phase: "inventory_asset_preservation".to_string(),
        status: GoldenAssertionStatus::Passed,
        details,
        asset_ref: None,
        source_unit_key: None,
        support_boundary: None,
        expected: None,
        actual: None,
        required_capability: None,
    });
}
