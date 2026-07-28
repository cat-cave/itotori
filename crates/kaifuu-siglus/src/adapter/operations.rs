use super::*;

// Pure Scene operations

/// Extract a profiled `Scene` container with the consumed resolved key.
pub fn extract_scene(
    variant: &SiglusSupportedVariant,
    key: &ResolvedSiglusKey,
    container: &[u8],
) -> Result<SiglusSceneExtraction, AdapterError> {
    variant.ensure_supported()?;
    let profile = variant.internal_profile(key);
    extract_scene_with(&profile, container, key.material())
        .map_err(|error| AdapterError::from_scene(&variant.variant_id, error))
}

/// Identity round-trip for a `Scene`: re-emit the unedited container and prove
/// it is byte-identical to the input.
pub fn roundtrip_identity_scene(
    variant: &SiglusSupportedVariant,
    key: &ResolvedSiglusKey,
    container: &[u8],
) -> Result<IdentityRoundTrip, AdapterError> {
    variant.ensure_supported()?;
    let profile = variant.internal_profile(key);
    let layout = read_scene_record_layout(&profile, container)
        .map_err(|error| AdapterError::from_scene(&variant.variant_id, error))?;
    let reemitted = reemit_scene_records(&layout);
    identity_result(container, &reemitted)
}

/// Apply translated edits to a `Scene` and prove the round-trip: every edited
/// unit decodes to the new text, and every out-of-scope record survives
/// byte-identical. An in-profile failure is [`AdapterError::VerifyFailed`].
pub fn apply_scene_translation(
    variant: &SiglusSupportedVariant,
    key: &ResolvedSiglusKey,
    container: &[u8],
    edits: &[SiglusTranslatedEdit],
) -> Result<TranslatedRoundTrip, AdapterError> {
    variant.ensure_supported()?;
    if edits.is_empty() {
        return Err(AdapterError::VerifyFailed {
            detail: "translated round-trip requires at least one edit".to_string(),
        });
    }
    let profile = variant.internal_profile(key);
    let material = key.material();

    // Original byte-exact record layout (still-encrypted).
    let original = read_scene_record_layout(&profile, container)
        .map_err(|error| AdapterError::from_scene(&variant.variant_id, error))?;

    // Apply every edit, evolving the container.
    let mut current = container.to_vec();
    let mut edited_indices: BTreeSet<u32> = BTreeSet::new();
    let mut in_scope_changes = Vec::with_capacity(edits.len());
    for edit in edits {
        let target_index = parse_source_unit_index(&edit.target_key)
            .map_err(|error| AdapterError::from_scene(&variant.variant_id, error))?;
        edited_indices.insert(target_index);
        current = patch_scene_unit_with(
            &profile,
            &current,
            &edit.target_key,
            &edit.translated_text,
            material,
        )
        .map_err(|error| AdapterError::from_scene(&variant.variant_id, error))?;
        in_scope_changes.push(InScopeChange {
            target_key: edit.target_key.clone(),
            changed: false, // filled after verification below
            translated_text_hash: hash_text(&edit.translated_text)?,
        });
    }

    // Verify in-scope: re-extract and confirm each edited unit decodes to the
    // requested translation and differs from the original.
    let original_text = extract_scene_with(&profile, container, material)
        .map_err(|error| AdapterError::from_scene(&variant.variant_id, error))?;
    let patched_text = extract_scene_with(&profile, &current, material)
        .map_err(|error| AdapterError::from_scene(&variant.variant_id, error))?;
    for (edit, change) in edits.iter().zip(in_scope_changes.iter_mut()) {
        let target_index = parse_source_unit_index(&edit.target_key)
            .map_err(|error| AdapterError::from_scene(&variant.variant_id, error))?;
        let before = original_text
            .units
            .iter()
            .find(|unit| unit.unit_index == target_index);
        let after = patched_text
            .units
            .iter()
            .find(|unit| unit.unit_index == target_index);
        change.changed = matches!((before, after), (Some(before), Some(after))
            if after.text == edit.translated_text && before.text != edit.translated_text);
        if !change.changed {
            return Err(AdapterError::VerifyFailed {
                detail: format!("edit {} did not apply in scope", edit.target_key),
            });
        }
    }

    // Verify out-of-scope byte-identity at record granularity.
    let patched_layout = read_scene_record_layout(&profile, &current)
        .map_err(|error| AdapterError::from_scene(&variant.variant_id, error))?;
    let out_of_scope_byte_identical =
        out_of_scope_scene_preserved(&original, &patched_layout, &edited_indices)?;
    let out_of_scope_record_count = original
        .records
        .iter()
        .filter(|(index, _)| !edited_indices.contains(index))
        .count() as u64;

    Ok(TranslatedRoundTrip {
        patched_hash: hash_bytes(&current)?,
        patched_bytes: current,
        in_scope_changes,
        out_of_scope_byte_identical,
        out_of_scope_record_count,
    })
}

/// Prove every out-of-scope `Scene` record is byte-identical and only edited
/// records changed. A structural drift (reorder / count / header change) is an
/// in-profile bug → [`AdapterError::VerifyFailed`].
fn out_of_scope_scene_preserved(
    original: &crate::known_key_smoke::SceneRecordLayout,
    patched: &crate::known_key_smoke::SceneRecordLayout,
    edited_indices: &BTreeSet<u32>,
) -> Result<bool, AdapterError> {
    if original.scene_id != patched.scene_id || original.compression != patched.compression {
        return Err(AdapterError::VerifyFailed {
            detail: "scene header changed across patch".to_string(),
        });
    }
    if original.records.len() != patched.records.len() {
        return Err(AdapterError::VerifyFailed {
            detail: "scene record count changed across patch".to_string(),
        });
    }
    for ((original_index, original_bytes), (patched_index, patched_bytes)) in
        original.records.iter().zip(patched.records.iter())
    {
        if original_index != patched_index {
            return Err(AdapterError::VerifyFailed {
                detail: "scene records reordered across patch".to_string(),
            });
        }
        let edited = edited_indices.contains(original_index);
        if edited {
            if original_bytes == patched_bytes {
                return Err(AdapterError::VerifyFailed {
                    detail: format!("edited unit {original_index} did not change bytes"),
                });
            }
        } else if original_bytes != patched_bytes {
            return Ok(false);
        }
    }
    Ok(true)
}

// Pure Gameexe operations

/// Extract a profiled `Gameexe` container with the consumed resolved key.
pub fn extract_gameexe(
    variant: &SiglusSupportedVariant,
    key: &ResolvedSiglusKey,
    container: &[u8],
) -> Result<SiglusGameexeExtraction, AdapterError> {
    variant.ensure_supported()?;
    let profile = variant.internal_profile(key);
    extract_gameexe_with(&profile, container, key.material())
        .map_err(|error| AdapterError::from_scene(&variant.variant_id, error))
}

/// Identity round-trip for a `Gameexe` container (byte-identical re-emit).
pub fn roundtrip_identity_gameexe(
    variant: &SiglusSupportedVariant,
    key: &ResolvedSiglusKey,
    container: &[u8],
) -> Result<IdentityRoundTrip, AdapterError> {
    variant.ensure_supported()?;
    let profile = variant.internal_profile(key);
    let layout = read_gameexe_record_layout(&profile, container)
        .map_err(|error| AdapterError::from_scene(&variant.variant_id, error))?;
    let reemitted = reemit_gameexe_records(&layout);
    identity_result(container, &reemitted)
}

/// Apply translated edits to a `Gameexe` container and prove the round-trip:
/// each edited value decodes to the new text and every other entry survives
/// byte-identical.
pub fn apply_gameexe_translation(
    variant: &SiglusSupportedVariant,
    key: &ResolvedSiglusKey,
    container: &[u8],
    edits: &[SiglusTranslatedEdit],
) -> Result<TranslatedRoundTrip, AdapterError> {
    variant.ensure_supported()?;
    if edits.is_empty() {
        return Err(AdapterError::VerifyFailed {
            detail: "translated round-trip requires at least one edit".to_string(),
        });
    }
    let profile = variant.internal_profile(key);
    let material = key.material();

    let original = read_gameexe_record_layout(&profile, container)
        .map_err(|error| AdapterError::from_scene(&variant.variant_id, error))?;

    let mut current = container.to_vec();
    let mut edited_keys: BTreeSet<String> = BTreeSet::new();
    let mut in_scope_changes = Vec::with_capacity(edits.len());
    for edit in edits {
        edited_keys.insert(edit.target_key.clone());
        current = patch_gameexe_value_with(
            &profile,
            &current,
            &edit.target_key,
            &edit.translated_text,
            material,
        )
        .map_err(|error| AdapterError::from_scene(&variant.variant_id, error))?;
        in_scope_changes.push(InScopeChange {
            target_key: edit.target_key.clone(),
            changed: false,
            translated_text_hash: hash_text(&edit.translated_text)?,
        });
    }

    // In-scope verify.
    let original_text = extract_gameexe_with(&profile, container, material)
        .map_err(|error| AdapterError::from_scene(&variant.variant_id, error))?;
    let patched_text = extract_gameexe_with(&profile, &current, material)
        .map_err(|error| AdapterError::from_scene(&variant.variant_id, error))?;
    for (edit, change) in edits.iter().zip(in_scope_changes.iter_mut()) {
        let before = original_text
            .entries
            .iter()
            .find(|entry| entry.key == edit.target_key);
        let after = patched_text
            .entries
            .iter()
            .find(|entry| entry.key == edit.target_key);
        change.changed = matches!((before, after), (Some(before), Some(after))
            if after.value == edit.translated_text && before.value != edit.translated_text);
        if !change.changed {
            return Err(AdapterError::VerifyFailed {
                detail: format!("gameexe edit {} did not apply in scope", edit.target_key),
            });
        }
    }

    // Out-of-scope byte-identity: match entries by decoded key.
    let patched_layout = read_gameexe_record_layout(&profile, &current)
        .map_err(|error| AdapterError::from_scene(&variant.variant_id, error))?;
    if original.records.len() != patched_layout.records.len() {
        return Err(AdapterError::VerifyFailed {
            detail: "gameexe entry count changed across patch".to_string(),
        });
    }
    let mut out_of_scope_byte_identical = true;
    let mut out_of_scope_record_count = 0u64;
    for ((original_key_bytes, original_value_bytes), (patched_key_bytes, patched_value_bytes)) in
        original.records.iter().zip(patched_layout.records.iter())
    {
        if original_key_bytes != patched_key_bytes {
            return Err(AdapterError::VerifyFailed {
                detail: "gameexe entry key bytes changed across patch".to_string(),
            });
        }
        let decoded_key = original_text
            .entries
            .iter()
            .find(|entry| material.xor_cycle(original_key_bytes) == utf16le_encode(&entry.key))
            .map(|entry| entry.key.clone());
        let edited = decoded_key
            .as_deref()
            .is_some_and(|key| edited_keys.contains(key));
        if edited {
            if original_value_bytes == patched_value_bytes {
                return Err(AdapterError::VerifyFailed {
                    detail: "edited gameexe value did not change bytes".to_string(),
                });
            }
        } else {
            out_of_scope_record_count += 1;
            if original_value_bytes != patched_value_bytes {
                out_of_scope_byte_identical = false;
            }
        }
    }

    Ok(TranslatedRoundTrip {
        patched_hash: hash_bytes(&current)?,
        patched_bytes: current,
        in_scope_changes,
        out_of_scope_byte_identical,
        out_of_scope_record_count,
    })
}
