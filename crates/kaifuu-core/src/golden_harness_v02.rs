use super::*;

pub(crate) fn report_v02_source_compatibility(
    report: &mut GoldenRoundTripReport,
    adapter_id: &str,
    native_bridge: &BridgeBundle,
    patch_export: &Value,
    source_bridge: Option<&Value>,
) {
    let (bridge_units, source_description) = match source_bridge {
        Some(source_bridge) => (v02_bridge_units_by_key(source_bridge), "source bridge"),
        None => (
            Ok(v02_native_units_by_key(native_bridge)),
            "native adapter extraction",
        ),
    };
    let bridge_units = match bridge_units {
        Ok(units) => units,
        Err(error) => {
            record_golden_failure(
                report,
                GoldenFailure {
                    code: "translated_source_bridge_invalid".to_string(),
                    phase: "translated_source_compatibility".to_string(),
                    adapter_id: adapter_id.to_string(),
                    message: golden_error_summary(&error),
                    asset_ref: None,
                    source_unit_key: None,
                    support_boundary: Some(
                        "v0.2 source compatibility requires source units keyed by sourceUnitKey"
                            .to_string(),
                    ),
                    expected: Some("valid source units".to_string()),
                    actual: Some(format!("invalid {source_description}")),
                    required_capability: None,
                },
            );
            return;
        }
    };

    let Some(entries) = patch_export["entries"].as_array() else {
        record_golden_failure(
            report,
            GoldenFailure {
                code: "translated_patch_entries_missing".to_string(),
                phase: "translated_source_compatibility".to_string(),
                adapter_id: adapter_id.to_string(),
                message: "translated patch export is missing entries".to_string(),
                asset_ref: None,
                source_unit_key: None,
                support_boundary: None,
                expected: Some("entries array".to_string()),
                actual: None,
                required_capability: None,
            },
        );
        return;
    };

    let mut compatible = 0_usize;
    for entry in entries {
        let source_unit_key = entry["sourceUnitKey"].as_str().unwrap_or("");
        let bridge_unit_id = entry["bridgeUnitId"].as_str().unwrap_or("");
        let source_hash = entry["sourceHash"].as_str().unwrap_or("");
        let Some(unit) = bridge_units.get(source_unit_key) else {
            record_golden_failure(
                report,
                GoldenFailure {
                    code: "translated_source_unit_missing".to_string(),
                    phase: "translated_source_compatibility".to_string(),
                    adapter_id: adapter_id.to_string(),
                    message:
                        "translated patch references a source unit absent from the source bridge"
                            .to_string(),
                    asset_ref: Some("source.json".to_string()),
                    source_unit_key: Some(source_unit_key.to_string()),
                    support_boundary: Some(
                        "translated patch sourceUnitKey values must exist in the checked source units"
                            .to_string(),
                    ),
                    expected: Some("source unit".to_string()),
                    actual: None,
                    required_capability: None,
                },
            );
            continue;
        };

        if unit
            .bridge_unit_id
            .as_deref()
            .is_some_and(|expected_bridge_unit_id| expected_bridge_unit_id != bridge_unit_id)
        {
            record_golden_failure(
                report,
                GoldenFailure {
                    code: "translated_bridge_unit_mismatch".to_string(),
                    phase: "translated_source_compatibility".to_string(),
                    adapter_id: adapter_id.to_string(),
                    message: "translated patch bridgeUnitId does not match the source bridge"
                        .to_string(),
                    asset_ref: Some(unit.asset_ref.clone()),
                    source_unit_key: Some(source_unit_key.to_string()),
                    support_boundary: Some(
                        "translated patch entries must reference the source bridge unit they were exported from"
                            .to_string(),
                    ),
                    expected: unit.bridge_unit_id.clone(),
                    actual: Some(bridge_unit_id.to_string()),
                                    required_capability: None,
},
            );
            continue;
        }

        if unit.source_hash != source_hash {
            record_golden_failure(
                report,
                GoldenFailure {
                    code: "translated_source_hash_mismatch".to_string(),
                    phase: "translated_source_compatibility".to_string(),
                    adapter_id: adapter_id.to_string(),
                    message: format!(
                        "translated patch sourceHash does not match the {source_description}"
                    ),
                    asset_ref: Some(unit.asset_ref.clone()),
                    source_unit_key: Some(source_unit_key.to_string()),
                    support_boundary: Some(
                        "translated patch sourceHash must match the checked source before adapter-specific hash translation"
                            .to_string(),
                    ),
                    expected: Some(unit.source_hash.clone()),
                    actual: Some(source_hash.to_string()),
                                    required_capability: None,
},
            );
            continue;
        }

        if !v02_patch_entry_span_mappings_compatible(entry, unit) {
            record_golden_failure(
                report,
                GoldenFailure {
                    code: "translated_protected_span_mapping_mismatch".to_string(),
                    phase: "translated_source_compatibility".to_string(),
                    adapter_id: adapter_id.to_string(),
                    message:
                        "translated patch protectedSpanMappings do not match source bridge spans"
                            .to_string(),
                    asset_ref: Some(unit.asset_ref.clone()),
                    source_unit_key: Some(source_unit_key.to_string()),
                    support_boundary: Some(
                        "translated patch mappings must preserve protected spans with valid source identity"
                            .to_string(),
                    ),
                    expected: Some(
                        "protectedSpanMappings compatible with source bridge".to_string(),
                    ),
                    actual: Some("protected span mapping mismatch".to_string()),
                                    required_capability: None,
},
            );
            continue;
        }

        compatible += 1;
    }

    if report
        .failures
        .iter()
        .any(|failure| failure.phase == "translated_source_compatibility")
    {
        return;
    }

    report_passed_phase(
        report,
        "translated_source_compatibility",
        format!(
            "validated {compatible} translated patch source unit(s) against the {source_description}"
        ),
        None,
    );
}

#[derive(Debug, Clone)]
pub(crate) struct V02BridgeUnitSummary {
    bridge_unit_id: Option<String>,
    source_hash: String,
    asset_ref: String,
    spans: Vec<V02SourceSpanSummary>,
}

#[derive(Debug, Clone)]
pub(crate) struct V02SourceSpanSummary {
    span_id: Option<String>,
    raw: String,
    start_byte: u64,
    end_byte: u64,
}

pub(crate) fn v02_bridge_units_by_key(
    source_bridge: &Value,
) -> KaifuuResult<BTreeMap<String, V02BridgeUnitSummary>> {
    let bridge = BridgeBundleV02::validate_json(source_bridge)?;
    let mut units_by_key = BTreeMap::new();
    for unit in bridge.units {
        let key = unit.source_unit_key.clone();
        let asset_ref = unit
            .source_asset_ref
            .asset_key
            .clone()
            .unwrap_or_else(|| unit.source_asset_ref.asset_id.clone());
        units_by_key.insert(
            key.clone(),
            V02BridgeUnitSummary {
                bridge_unit_id: Some(unit.bridge_unit_id),
                source_hash: unit.source_hash,
                asset_ref: format!("{asset_ref}#{key}"),
                spans: unit
                    .spans
                    .into_iter()
                    .map(|span| V02SourceSpanSummary {
                        span_id: Some(span.span_id),
                        raw: span.raw,
                        start_byte: span.start_byte,
                        end_byte: span.end_byte,
                    })
                    .collect(),
            },
        );
    }
    Ok(units_by_key)
}

/// Recompute the canonical v0.2 source hash from the text emitted by a native
/// adapter. This is the same `sha256:` UTF-8 source-text representation native
/// v0.2 bridge producers place in `LocalizationUnitV02.sourceHash`.
pub(crate) fn canonical_v02_native_source_hash(source_text: &str) -> String {
    sha256_hash_bytes(source_text.as_bytes())
}

pub(crate) fn v02_native_units_by_key(
    bridge: &BridgeBundle,
) -> BTreeMap<String, V02BridgeUnitSummary> {
    let mut units_by_key = BTreeMap::new();
    for unit in &bridge.units {
        let key = unit.source_unit_key.clone();
        units_by_key.insert(
            key.clone(),
            V02BridgeUnitSummary {
                // A native v0.1 adapter may use a local bridge-unit id scheme.
                // The sourceUnitKey + canonical source hash are the stable v0.2
                // compatibility identity; patch conversion later remaps to the
                // fresh native bridge-unit id used by that adapter.
                bridge_unit_id: None,
                source_hash: canonical_v02_native_source_hash(&unit.source_text),
                asset_ref: format!("{}#{key}", unit.patch_ref.asset_id),
                spans: unit
                    .protected_spans
                    .iter()
                    .map(|span| V02SourceSpanSummary {
                        span_id: span.span_id.clone(),
                        raw: span.raw.clone(),
                        start_byte: span.start,
                        end_byte: span.end,
                    })
                    .collect(),
            },
        );
    }
    units_by_key
}

pub(crate) fn v02_patch_entry_span_mappings_compatible(
    entry: &Value,
    unit: &V02BridgeUnitSummary,
) -> bool {
    let Some(target_text) = entry["targetText"].as_str() else {
        return false;
    };
    let Ok(mappings) =
        serde_json::from_value::<Vec<ProtectedSpanMapping>>(entry["protectedSpanMappings"].clone())
    else {
        return false;
    };

    let mut required_spans = BTreeMap::<&str, Vec<&V02SourceSpanSummary>>::new();
    for span in &unit.spans {
        required_spans
            .entry(span.raw.as_str())
            .or_default()
            .push(span);
    }

    let mut target_ranges_by_raw = BTreeMap::<&str, BTreeSet<(u64, u64)>>::new();
    let mut matched_source_identities = BTreeSet::<String>::new();
    for mapping in &mappings {
        if !mapping.matches_target_text(target_text) {
            return false;
        }

        // Fail closed: a mapping whose `raw` has no corresponding source
        // span is bogus. The final coverage loop only checks that required
        // source spans are covered, so accepting an extra mapping here would
        // let a patch carrying spans that reference non-existent source spans
        // pass the compatibility gate.
        let Some(source_spans) = required_spans.get(mapping.raw.as_str()) else {
            return false;
        };

        let duplicate_raw = source_spans.len() > 1;
        if duplicate_raw && !mapping.has_source_identity() {
            return false;
        }

        if mapping.has_source_identity() {
            let Some(source_span) = source_spans.iter().find(|source_span| {
                mapping.matches_source_span(
                    &source_span.raw,
                    Some(source_span.start_byte),
                    Some(source_span.end_byte),
                    source_span.span_id.as_deref(),
                )
            }) else {
                return false;
            };
            let Some(span_id) = source_span.span_id.as_deref() else {
                return false;
            };
            let source_identity_key = format!(
                "{}:{}:{}",
                span_id, source_span.start_byte, source_span.end_byte
            );
            if !matched_source_identities.insert(source_identity_key) {
                return false;
            }
        }

        target_ranges_by_raw
            .entry(mapping.raw.as_str())
            .or_default()
            .insert((mapping.target_start, mapping.target_end));
    }

    for (raw, source_spans) in required_spans {
        if target_ranges_by_raw.get(raw).map_or(0, BTreeSet::len) < source_spans.len() {
            return false;
        }
    }

    true
}

pub(crate) fn patch_export_for_adapter(
    value: &Value,
    bridge: &BridgeBundle,
) -> KaifuuResult<PatchExport> {
    if value["schemaVersion"].as_str() != Some(BRIDGE_SCHEMA_VERSION_V02) {
        return PatchExport::from_value(value);
    }

    let units_by_key = bridge
        .units
        .iter()
        .map(|unit| (unit.source_unit_key.as_str(), unit))
        .collect::<BTreeMap<_, _>>();
    let entries = value["entries"]
        .as_array()
        .ok_or("translated patch export missing entries")?
        .iter()
        .map(|entry| {
            let source_unit_key = require_str(entry, "sourceUnitKey")?;
            let source_unit = units_by_key.get(source_unit_key).ok_or_else(|| {
                format!(
                    "translated patch entry {source_unit_key} is missing from current extraction"
                )
            })?;
            Ok(PatchExportEntry {
                bridge_unit_id: source_unit.bridge_unit_id.clone(),
                source_unit_key: source_unit_key.to_string(),
                source_hash: source_unit.source_hash.clone(),
                target_text: require_str(entry, "targetText")?.to_string(),
                protected_span_mappings: serde_json::from_value(
                    entry["protectedSpanMappings"].clone(),
                )?,
            })
        })
        .collect::<KaifuuResult<Vec<_>>>()?;

    Ok(PatchExport {
        patch_export_id: require_str(value, "patchExportId")?.to_string(),
        source_locale: require_str(value, "sourceLocale")?.to_string(),
        target_locale: require_str(value, "targetLocale")?.to_string(),
        entries,
    })
}
