use super::*;

pub(crate) fn report_translated_target_equivalence(
    report: &mut GoldenRoundTripReport,
    adapter_id: &str,
    patch_export: &PatchExport,
    output_dir: &Path,
) {
    let output_path = output_dir.join("source.json");
    let source: Value = match read_json(&output_path) {
        Ok(source) => source,
        Err(error) => {
            record_golden_failure(
                report,
                GoldenFailure {
                    code: "translated_target_read_error".to_string(),
                    phase: "translated_target_equivalence".to_string(),
                    adapter_id: adapter_id.to_string(),
                    message: golden_error_summary(&error),
                    asset_ref: Some("source.json".to_string()),
                    source_unit_key: None,
                    support_boundary: Some(
                        "translated target equivalence requires fixture JSON output with targetText fields"
                            .to_string(),
                    ),
                    expected: Some("readable patched source.json".to_string()),
                    actual: Some("read error".to_string()),
                                    required_capability: None,
},
            );
            return;
        }
    };

    let Some(units) = source["units"].as_array() else {
        record_golden_failure(
            report,
            GoldenFailure {
                code: "translated_target_units_missing".to_string(),
                phase: "translated_target_equivalence".to_string(),
                adapter_id: adapter_id.to_string(),
                message: "translated patch output is missing a units array".to_string(),
                asset_ref: Some("source.json".to_string()),
                source_unit_key: None,
                support_boundary: Some(
                    "translated target equivalence requires fixture JSON output with units"
                        .to_string(),
                ),
                expected: Some("units array".to_string()),
                actual: None,
                required_capability: None,
            },
        );
        return;
    };

    let targets_by_key = units
        .iter()
        .filter_map(|unit| {
            Some((
                unit["sourceUnitKey"].as_str()?.to_string(),
                unit["targetText"].as_str().map(str::to_string),
            ))
        })
        .collect::<BTreeMap<_, _>>();

    let mut matched = 0_usize;
    for entry in &patch_export.entries {
        match targets_by_key.get(&entry.source_unit_key) {
            Some(Some(actual)) if actual == &entry.target_text => {
                matched += 1;
            }
            Some(Some(actual)) => record_golden_failure(
                report,
                GoldenFailure {
                    code: "translated_target_text_mismatch".to_string(),
                    phase: "translated_target_equivalence".to_string(),
                    adapter_id: adapter_id.to_string(),
                    message: "translated patch output targetText does not match the patch export"
                        .to_string(),
                    asset_ref: Some(format!("source.json#{}", entry.source_unit_key)),
                    source_unit_key: Some(entry.source_unit_key.clone()),
                    support_boundary: Some(
                        "translated patch target equivalence requires each targetText to be written exactly"
                            .to_string(),
                    ),
                    expected: Some(
                        RedactedContentSummary::from_text(&entry.target_text).to_string(),
                    ),
                    actual: Some(RedactedContentSummary::from_text(actual).to_string()),
                                    required_capability: None,
},
            ),
            Some(None) => record_golden_failure(
                report,
                GoldenFailure {
                    code: "translated_target_text_missing".to_string(),
                    phase: "translated_target_equivalence".to_string(),
                    adapter_id: adapter_id.to_string(),
                    message: "translated patch output unit is missing targetText".to_string(),
                    asset_ref: Some(format!("source.json#{}", entry.source_unit_key)),
                    source_unit_key: Some(entry.source_unit_key.clone()),
                    support_boundary: Some(
                        "translated patch target equivalence requires each patched unit to contain targetText"
                            .to_string(),
                    ),
                    expected: Some(
                        RedactedContentSummary::from_text(&entry.target_text).to_string(),
                    ),
                    actual: None,
                                    required_capability: None,
},
            ),
            None => record_golden_failure(
                report,
                GoldenFailure {
                    code: "translated_target_unit_missing".to_string(),
                    phase: "translated_target_equivalence".to_string(),
                    adapter_id: adapter_id.to_string(),
                    message: "translated patch output is missing a patched source unit".to_string(),
                    asset_ref: Some(format!("source.json#{}", entry.source_unit_key)),
                    source_unit_key: Some(entry.source_unit_key.clone()),
                    support_boundary: Some(
                        "translated patch target equivalence requires every patch entry sourceUnitKey to be present"
                            .to_string(),
                    ),
                    expected: Some(
                        RedactedContentSummary::from_text(&entry.target_text).to_string(),
                    ),
                    actual: None,
                                    required_capability: None,
},
            ),
        }
    }

    if report
        .failures
        .iter()
        .any(|failure| failure.phase == "translated_target_equivalence")
    {
        return;
    }

    report_passed_phase(
        report,
        "translated_target_equivalence",
        format!("verified {matched} translated targetText value(s) in source.json"),
        Some("source.json"),
    );
}

pub(crate) fn source_unit_key_from_asset_ref(asset_ref: Option<&str>) -> Option<String> {
    let (_, source_unit_key) = asset_ref?.split_once('#')?;
    (!source_unit_key.is_empty()).then(|| source_unit_key.to_string())
}

pub(crate) fn finalize_golden_report(mut report: GoldenRoundTripReport) -> GoldenRoundTripReport {
    report.status = if report.failures.is_empty() {
        OperationStatus::Passed
    } else {
        OperationStatus::Failed
    };
    report
}

pub fn require_str<'a>(value: &'a Value, key: &str) -> KaifuuResult<&'a str> {
    value[key]
        .as_str()
        .ok_or_else(|| format!("missing string field {key}").into())
}

pub fn require_u64(value: &Value, key: &str) -> KaifuuResult<u64> {
    value[key]
        .as_u64()
        .ok_or_else(|| format!("missing u64 field {key}").into())
}
