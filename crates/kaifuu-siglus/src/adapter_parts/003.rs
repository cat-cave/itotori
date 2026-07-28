/// Filesystem-owning patch-back: read the profiled container at `input_path`,
/// apply the translated edits, VERIFY the round-trip, deep-scan for secret
/// leaks, and only then atomically write the patched container to `output_path`
/// (and the redacted report to `report_path`, if given).
/// Reject-before-write ordering (nothing is written until all pass):
/// 1. capability gate (unsupported variant → `Err`, no write),
/// 2. read input,
/// 3. identity round-trip + translated round-trip + verify (in-profile failure →
///    `Err`, no write),
/// 4. reject-on-secret deep scan (leak → `Err`, no write),
/// 5. atomic write of output + report.
pub fn patch_container_file(
    variant: &SiglusSupportedVariant,
    key: &ResolvedSiglusKey,
    kind: SiglusContainerKind,
    input_path: &Path,
    output_path: &Path,
    report_path: Option<&Path>,
    edits: &[SiglusTranslatedEdit],
) -> Result<AdapterPatchReport, AdapterError> {
    // (1) Capability gate BEFORE touching the filesystem.
    variant.ensure_supported()?;

    // (2) Read input.
    let container = std::fs::read(input_path).map_err(|error| AdapterError::Io {
        detail: format!("reading input container: {error}"),
    })?;

    // (3) Identity + translated round-trips + verify (in-memory).
    let (identity, translation, scene_report, gameexe_report, plaintext_probes) = match kind {
        SiglusContainerKind::Scene => {
            let identity = roundtrip_identity_scene(variant, key, &container)?;
            let extraction = extract_scene(variant, key, &container)?;
            let translation = apply_scene_translation(variant, key, &container, edits)?;
            let probes = scene_plaintext_probes(&extraction, edits);
            let report = scene_extraction_report(&extraction)?;
            (identity, translation, Some(report), None, probes)
        }
        SiglusContainerKind::Gameexe => {
            let identity = roundtrip_identity_gameexe(variant, key, &container)?;
            let extraction = extract_gameexe(variant, key, &container)?;
            let translation = apply_gameexe_translation(variant, key, &container, edits)?;
            let probes = gameexe_plaintext_probes(&extraction, edits);
            let report = gameexe_extraction_report(&extraction)?;
            (identity, translation, None, Some(report), probes)
        }
    };

    if !identity.byte_identical {
        return Err(AdapterError::VerifyFailed {
            detail: "identity round-trip was not byte-identical".to_string(),
        });
    }
    if !translation.verified() {
        return Err(AdapterError::VerifyFailed {
            detail: "translated round-trip did not verify (in-scope change or out-of-scope preservation failed)"
                .to_string(),
        });
    }

    // Build the redacted report body.
    let mut report = AdapterPatchReport {
        schema_version: ADAPTER_SCHEMA_VERSION.to_string(),
        capability_id: ADAPTER_CAPABILITY_ID.to_string(),
        source_node_id: ADAPTER_SOURCE_NODE_ID.to_string(),
        engine_family: "siglus".to_string(),
        support_boundary: ADAPTER_SUPPORT_BOUNDARY.to_string(),
        variant_id: variant.variant_id.clone(),
        container_kind: kind.as_str().to_string(),
        secret_ref: key.secret_ref().clone(),
        key_validation: key.validation().clone(),
        key_material_hash: key
            .material_hash()
            .map_err(|error| AdapterError::Internal {
                message: format!("key commitment: {error}"),
            })?,
        key_bytes: u32::try_from(key.key_byte_len()).unwrap_or(u32::MAX),
        key_material_kind: key.material_kind,
        redaction_status: HelperRedactionStatus::Redacted,
        capability: SiglusAdapterCapability::for_variant(variant),
        identity,
        scene_extraction: scene_report,
        gameexe_extraction: gameexe_report,
        translation: TranslatedRoundTripReport {
            in_scope_changes: translation.in_scope_changes.clone(),
            out_of_scope_byte_identical: translation.out_of_scope_byte_identical,
            out_of_scope_record_count: translation.out_of_scope_record_count,
            patched_container_hash: translation.patched_hash.clone(),
            verified: translation.verified(),
        },
        reject_on_secret: RejectOnSecretReport {
            deep_scan_performed: true,
            finding_count: 0,
            plaintext_probes_checked: plaintext_probes.len() as u64,
        },
        status: OperationStatus::Passed,
    };

    // (4) Reject-on-secret deep scan of the ABOUT-TO-BE-WRITTEN artifacts.
    let report_json = report
        .stable_json()
        .map_err(|error| AdapterError::Internal {
            message: format!("report serialization: {error}"),
        })?;
    let findings = scan_for_secret_leak(
        key,
        &translation.patched_bytes,
        &report_json,
        &plaintext_probes,
    );
    if !findings.is_empty() {
        return Err(AdapterError::SecretLeak {
            finding_count: findings.len() as u64,
            first_finding: format!("{}:{}", findings[0].location, findings[0].kind),
        });
    }

    // (5) Atomic writes — output first, then the redacted report.
    atomic_write_bytes(output_path, &translation.patched_bytes).map_err(|error| {
        AdapterError::Io {
            detail: format!("writing patched output: {error}"),
        }
    })?;
    if let Some(report_path) = report_path {
        // Re-serialize post-scan (identical content) and write.
        atomic_write_text(report_path, &report_json).map_err(|error| AdapterError::Io {
            detail: format!("writing report: {error}"),
        })?;
    }

    report.reject_on_secret.finding_count = 0;
    Ok(report)
}

// Profiled fixture builders (encode with a resolved key — no retail bytes)

/// Build a profiled `Scene` container by masking each unit's UTF-16LE text with
/// the resolved key. Fixture support: the bytes it produces round-trip through
/// the adapter's own reader (proving the codec is symmetric); no retail bytes.
pub fn build_profiled_scene_container(
    key: &ResolvedSiglusKey,
    scene_id: u32,
    units: &[(u32, &str)],
) -> Vec<u8> {
    let records = units
        .iter()
        .map(|(unit_index, text)| (*unit_index, key.material().xor_cycle(&utf16le_encode(text))))
        .collect();
    reemit_scene_records(&SceneRecordLayout {
        scene_id,
        compression: SiglusKnownKeyCompression::Uncompressed,
        records,
    })
}

/// Build a profiled `Gameexe` container by masking each key/value with the
/// resolved key.
pub fn build_profiled_gameexe_container(
    key: &ResolvedSiglusKey,
    entries: &[(&str, &str)],
) -> Vec<u8> {
    let records = entries
        .iter()
        .map(|(config_key, value)| {
            (
                key.material().xor_cycle(&utf16le_encode(config_key)),
                key.material().xor_cycle(&utf16le_encode(value)),
            )
        })
        .collect();
    reemit_gameexe_records(&GameexeRecordLayout {
        compression: SiglusKnownKeyCompression::Uncompressed,
        records,
    })
}

// Helpers

fn identity_result(input: &[u8], reemitted: &[u8]) -> Result<IdentityRoundTrip, AdapterError> {
    Ok(IdentityRoundTrip {
        byte_identical: input == reemitted,
        input_hash: hash_bytes(input)?,
        reemitted_hash: hash_bytes(reemitted)?,
    })
}

fn hash_bytes(bytes: &[u8]) -> Result<ProofHash, AdapterError> {
    ProofHash::new(sha256_hash_bytes(bytes)).map_err(|message| AdapterError::Internal { message })
}

fn hash_text(text: &str) -> Result<ProofHash, AdapterError> {
    hash_bytes(&utf16le_encode(text))
}

fn scene_plaintext_probes(
    extraction: &SiglusSceneExtraction,
    edits: &[SiglusTranslatedEdit],
) -> Vec<String> {
    let mut probes: Vec<String> = extraction
        .units
        .iter()
        .map(|unit| unit.text.clone())
        .collect();
    probes.extend(edits.iter().map(|edit| edit.translated_text.clone()));
    probes
}

fn gameexe_plaintext_probes(
    extraction: &SiglusGameexeExtraction,
    edits: &[SiglusTranslatedEdit],
) -> Vec<String> {
    let mut probes: Vec<String> = extraction
        .entries
        .iter()
        .map(|entry| entry.value.clone())
        .collect();
    probes.extend(edits.iter().map(|edit| edit.translated_text.clone()));
    probes
}

fn scene_extraction_report(
    extraction: &SiglusSceneExtraction,
) -> Result<SceneExtractionReport, AdapterError> {
    let mut units = Vec::with_capacity(extraction.units.len());
    for unit in &extraction.units {
        let text_bytes = utf16le_encode(&unit.text);
        units.push(SceneUnitDigest {
            source_unit_key: unit.source_unit_key.clone(),
            text_byte_len: u32::try_from(text_bytes.len()).unwrap_or(u32::MAX),
            text_hash: hash_bytes(&text_bytes)?,
        });
    }
    Ok(SceneExtractionReport {
        scene_id: extraction.scene_id,
        unit_count: u32::try_from(extraction.units.len()).unwrap_or(u32::MAX),
        units,
    })
}

fn gameexe_extraction_report(
    extraction: &SiglusGameexeExtraction,
) -> Result<GameexeExtractionReport, AdapterError> {
    let mut entries = Vec::with_capacity(extraction.entries.len());
    for entry in &extraction.entries {
        let value_bytes = utf16le_encode(&entry.value);
        entries.push(GameexeEntryDigest {
            key: entry.key.clone(),
            value_byte_len: u32::try_from(value_bytes.len()).unwrap_or(u32::MAX),
            value_hash: hash_bytes(&value_bytes)?,
        });
    }
    Ok(GameexeExtractionReport {
        entry_count: u32::try_from(extraction.entries.len()).unwrap_or(u32::MAX),
        entries,
    })
}

