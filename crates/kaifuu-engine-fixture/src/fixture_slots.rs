use super::*;

impl FixtureAdapter {
    pub(super) fn encoded_string_slot_for_unit(
        unit: &Value,
        protected_spans: &[ProtectedSpan],
    ) -> KaifuuResult<Option<EncodedStringSlot>> {
        let Some(slot_value) = unit.get("encodedStringSlot") else {
            return Ok(None);
        };
        let mut slot: EncodedStringSlot = serde_json::from_value(slot_value.clone())?;
        if slot.protected_spans.is_empty() {
            slot.protected_spans = protected_spans
                .iter()
                .filter(|span| !span.raw.is_empty())
                .map(|span| {
                    EncodedStringSlotProtectedSpan::new(span.raw.clone()).with_source_identity(
                        span.span_id.clone(),
                        span.start,
                        span.end,
                    )
                })
                .collect();
        }
        Ok(Some(slot))
    }

    pub(super) fn source_slot_bytes_for_unit(unit: &Value) -> KaifuuResult<Option<Vec<u8>>> {
        unit.get("encodedStringSlot")
            .and_then(|slot| slot.get("sourceBytesHex"))
            .and_then(Value::as_str)
            .map(parse_hex_bytes)
            .transpose()
            .map_err(Into::into)
    }

    pub(super) fn patch_preflight_failures(
        &self,
        source: &Value,
        patch_export: &kaifuu_core::PatchExport,
    ) -> KaifuuResult<Vec<AdapterFailure>> {
        let units = source["units"]
            .as_array()
            .ok_or("fixture source missing units")?;
        let mut source_hashes = BTreeMap::new();
        let mut source_protected_spans = BTreeMap::new();
        let mut encoded_slots = BTreeMap::new();
        let mut seen_source_unit_keys = BTreeSet::new();
        let mut duplicate_source_unit_keys = BTreeSet::new();

        for unit in units {
            let key = require_str(unit, "sourceUnitKey")?;
            let unit_source_text = require_str(unit, "sourceText")?;
            if !seen_source_unit_keys.insert(key.to_string()) {
                duplicate_source_unit_keys.insert(key.to_string());
                continue;
            }
            let protected_spans = Self::protected_spans_for_unit(unit, unit_source_text)?;
            if let Some(slot) = Self::encoded_string_slot_for_unit(unit, &protected_spans)? {
                encoded_slots.insert(
                    key.to_string(),
                    (slot, Self::source_slot_bytes_for_unit(unit)?),
                );
            }
            source_hashes.insert(key.to_string(), content_hash(unit_source_text));
            source_protected_spans.insert(key.to_string(), protected_spans);
        }

        if !duplicate_source_unit_keys.is_empty() {
            let duplicate_keys = duplicate_source_unit_keys
                .into_iter()
                .collect::<Vec<_>>()
                .join(", ");
            return Ok(vec![Self::patch_failure(
                "duplicate_source_unit_key_in_source",
                format!("source.json#{duplicate_keys}"),
                "fixture patching requires source.json units to have unique sourceUnitKey values",
                format!(
                    "Fix duplicate source.json sourceUnitKey values before applying this export: {duplicate_keys}"
                ),
            )]);
        }

        let mut failures = Vec::new();
        let mut entries_by_source_unit_key = BTreeMap::new();
        for entry in &patch_export.entries {
            if entries_by_source_unit_key
                .insert(entry.source_unit_key.as_str(), entry)
                .is_some()
            {
                failures.push(Self::patch_failure(
                    "duplicate_source_unit_key",
                    format!("source.json#{}", entry.source_unit_key),
                    "fixture patching requires at most one patch entry per sourceUnitKey",
                    format!(
                        "Remove duplicate patch entries for sourceUnitKey {} before applying this export",
                        entry.source_unit_key
                    ),
                ));
            }

            let Some(current_hash) = source_hashes.get(&entry.source_unit_key) else {
                failures.push(Self::patch_failure(
                    "unmatched_source_unit_key",
                    format!("source.json#{}", entry.source_unit_key),
                    "fixture patching only updates existing source.json units by sourceUnitKey",
                    format!(
                        "Re-extract the fixture or remove patch entry {} before applying this export",
                        entry.source_unit_key
                    ),
                ));
                continue;
            };

            if current_hash != &entry.source_hash {
                failures.push(Self::patch_failure(
                    "source_hash_mismatch",
                    format!("source.json#{}", entry.source_unit_key),
                    "fixture patching requires PatchExportEntry.sourceHash to match the current sourceText hash",
                    format!(
                        "Re-extract sourceUnitKey {} and regenerate the patch export before applying it",
                        entry.source_unit_key
                    ),
                ));
            }

            let required_spans = source_protected_spans
                .get(&entry.source_unit_key)
                .expect("source hashes and protected spans should have matching keys");
            failures.extend(Self::protected_span_patch_failures(entry, required_spans));

            if let Some((slot, current_slot_bytes)) = encoded_slots.get(&entry.source_unit_key) {
                let report = slot.preflight(
                    &entry.target_text,
                    &entry.protected_span_mappings,
                    current_slot_bytes.as_deref(),
                );
                failures.extend(report.diagnostics.into_iter().map(|diagnostic| {
                    AdapterFailure::encoded_string_slot_preflight(
                        FIXTURE_ADAPTER_ID,
                        "fixture",
                        "plain-json-source",
                        format!(
                            "source.json#{}#{}",
                            entry.source_unit_key, diagnostic.slot_id
                        ),
                        diagnostic,
                    )
                }));
            }
        }

        Ok(failures)
    }

    pub(super) fn explicit_protected_spans_for_unit(
        unit: &Value,
        text: &str,
    ) -> KaifuuResult<Vec<ProtectedSpan>> {
        unit["protectedSpans"]
            .as_array()
            .map_or(&[][..], Vec::as_slice)
            .iter()
            .map(|span| {
                let raw = require_str(span, "raw")?;
                let (start, end) = Self::fixture_span_offsets(
                    text,
                    raw,
                    require_u64(span, "start")?,
                    require_u64(span, "end")?,
                );
                Ok(ProtectedSpan::new(
                    require_str(span, "kind")?,
                    raw,
                    start,
                    end,
                    span["preserveMode"].as_str().unwrap_or(""),
                ))
            })
            .collect()
    }

    pub(super) fn fixture_span_offsets(text: &str, raw: &str, start: u64, end: u64) -> (u64, u64) {
        if Self::span_range_matches(text, raw, start, end) {
            return (start, end);
        }
        let Some(byte_start) = Self::char_offset_to_byte(text, start) else {
            return (start, end);
        };
        let Some(byte_end) = Self::char_offset_to_byte(text, end) else {
            return (start, end);
        };
        if Self::span_range_matches(text, raw, byte_start, byte_end) {
            return (byte_start, byte_end);
        }
        (start, end)
    }

    pub(super) fn span_range_matches(text: &str, raw: &str, start: u64, end: u64) -> bool {
        let Ok(start) = usize::try_from(start) else {
            return false;
        };
        let Ok(end) = usize::try_from(end) else {
            return false;
        };
        start < end
            && end <= text.len()
            && text.is_char_boundary(start)
            && text.is_char_boundary(end)
            && &text[start..end] == raw
    }

    pub(super) fn char_offset_to_byte(text: &str, offset: u64) -> Option<u64> {
        let offset = usize::try_from(offset).ok()?;
        if offset == text.chars().count() {
            return Some(text.len() as u64);
        }
        text.char_indices()
            .nth(offset)
            .map(|(byte_offset, _)| byte_offset as u64)
    }
}
