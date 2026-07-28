fn collect_encrypted_media_assets(
    fixture: &EncryptedMediaProofFixture,
    game_dir_full: Option<&Path>,
    system_json_present: bool,
    system_json_key_present: bool,
    system_json_key_well_formed: bool,
    system_json_key_matches_expected: bool,
    diagnostics: &mut Vec<EncryptedMediaProofDiagnostic>,
) -> Vec<EncryptedMediaProofAsset> {
    // Per-asset routing.
    let mut assets: Vec<EncryptedMediaProofAsset> = Vec::with_capacity(fixture.assets.len());
    for fixture_asset in &fixture.assets {
        let path_validation = validate_encrypted_media_fixture_path(&fixture_asset.path);
        let path_rejected = path_validation.is_err();
        if let Err(message) = path_validation {
            diagnostics.push(EncryptedMediaProofDiagnostic {
                code: "rpgmaker.encrypted_media.asset_path.leaked".to_string(),
                severity: PartialDiagnosticSeverity::P0,
                field: format!("assets[{}].path", fixture_asset.asset_id),
                message,
                semantic_code: Some(SEMANTIC_FORBIDDEN_PUBLIC_SERIALIZATION.to_string()),
                remediation: Some(
                    "asset paths must be relative to the game directory and must not contain absolute roots, drive letters, parent traversal, or home prefixes"
                        .to_string(),
                ),
            });
        }

        let declared_path_for_report = if path_rejected {
            format!("[REDACTED:{SEMANTIC_SECRET_REDACTED}]")
        } else {
            fixture_asset.path.clone()
        };

        let suffix = Path::new(&fixture_asset.path)
            .extension()
            .and_then(|os| os.to_str())
            .unwrap_or("")
            .to_ascii_lowercase();
        let suffix_profile = encrypted_media_suffix_profile(&suffix);

        let asset_full = match (path_rejected, game_dir_full) {
            (false, Some(game_dir)) => Some(game_dir.join(&fixture_asset.path)),
            _ => None,
        };
        let asset_bytes = asset_full.as_deref().and_then(|path| fs::read(path).ok());

        let bytes_for_classify = asset_bytes.as_deref();
        let classification = classify_encrypted_media_asset(suffix_profile, bytes_for_classify);

        // Bytes-classification override is final — the fixture declared
        // classification is only allowed to *match* the byte-level routing.
        // Surface a P1 mismatch diagnostic when the two disagree so
        // fixture authors notice (acceptance criterion: "Encrypted image,
        // audio, and video media variants are detected with exact
        // asset-kind capability levels").
        if !path_rejected
            && classification != fixture_asset.expected_classification
            // MissingAsset / UnknownSuffix are intrinsic byte-routing
            // outcomes; the fixture is never *expected* to declare them
            // in a way that conflicts with their physical state.
            && !matches!(
                classification,
                EncryptedMediaClassification::MissingAsset
                    | EncryptedMediaClassification::UnknownSuffix
            )
        {
            diagnostics.push(EncryptedMediaProofDiagnostic {
                code: "rpgmaker.encrypted_media.classification.mismatch".to_string(),
                severity: PartialDiagnosticSeverity::P1,
                field: format!("assets[{}].expectedClassification", fixture_asset.asset_id),
                message: format!(
                    "fixture declared {} but asset bytes classify as {}",
                    fixture_asset.expected_classification.as_str(),
                    classification.as_str(),
                ),
                semantic_code: Some(SEMANTIC_AMBIGUOUS_ENGINE_VARIANT.to_string()),
                remediation: Some(
                    "regenerate the fixture so the declared classification matches the asset bytes"
                        .to_string(),
                ),
            });
        }

        // For missing-asset / malformed-header cases that the fixture
        // *declared* (e.g. negative fixtures), record the declared
        // classification but keep the byte-level outcome as the routing.
        // No upward re-classification.
        if matches!(classification, EncryptedMediaClassification::MissingAsset) {
            if !path_rejected {
                diagnostics.push(EncryptedMediaProofDiagnostic {
                    code: "rpgmaker.encrypted_media.asset.missing".to_string(),
                    severity: PartialDiagnosticSeverity::P0,
                    field: format!("assets[{}].path", fixture_asset.asset_id),
                    message: format!("asset {} could not be read", fixture_asset.asset_id),
                    semantic_code: Some(SEMANTIC_UNSUPPORTED_VARIANT_ENCRYPTED.to_string()),
                    remediation: Some(
                        "ensure the asset file exists under the game directory before running the proof".to_string(),
                    ),
                });
            }
        } else if matches!(classification, EncryptedMediaClassification::UnknownSuffix) {
            diagnostics.push(EncryptedMediaProofDiagnostic {
                code: "rpgmaker.encrypted_media.suffix.unknown".to_string(),
                severity: PartialDiagnosticSeverity::P1,
                field: format!("assets[{}].path", fixture_asset.asset_id),
                message: format!(
                    "asset suffix .{suffix} has no profiled MV/MZ media mapping"
                ),
                semantic_code: Some(SEMANTIC_UNKNOWN_ENGINE_VARIANT.to_string()),
                remediation: Some(
                    "add a suffix profile before declaring readiness; recognition does not imply a decryption capability claim".to_string(),
                ),
            });
        } else if matches!(
            classification,
            EncryptedMediaClassification::MalformedHeader
        ) {
            diagnostics.push(EncryptedMediaProofDiagnostic {
                code: "rpgmaker.encrypted_media.header.malformed".to_string(),
                severity: PartialDiagnosticSeverity::P0,
                field: format!("assets[{}]", fixture_asset.asset_id),
                message: format!(
                    "asset {} is declared encrypted but does not carry the RPGMV header magic",
                    fixture_asset.asset_id
                ),
                semantic_code: Some(SEMANTIC_UNSUPPORTED_VARIANT_ENCRYPTED.to_string()),
                remediation: Some(
                    "regenerate the encrypted asset so the leading 16 bytes match the RPGMV header magic".to_string(),
                ),
            });
        }

        // Effective asset kind: bytes-routed suffix profile wins. For
        // unknown / missing cases we still surface the *declared* kind so
        // the report carries the fixture author's intent.
        let kind = suffix_profile
            .and_then(|p| p.kind)
            .unwrap_or(fixture_asset.expected_kind);

        // Decryptability / patch-capability / readiness routing for this
        // asset. Encrypted assets force `patch_capability_level =
        // Unsupported` and never claim `key_profile_satisfied` unless the
        // key profile evidence section is fully wired — even then, the
        // status only indicates the *profile* is wired, not that the
        // proof has any decryption capability.
        let (decryptability, key_ref_status, patch_capability_level, readiness) =
            match classification {
                EncryptedMediaClassification::Plaintext => (
                    EncryptedMediaDecryptability::NotApplicable,
                    EncryptedMediaKeyRefStatus::NotRequired,
                    EncryptedMediaPatchCapability::NotClaimed,
                    EncryptedMediaReadiness::PlaintextEvidence,
                ),
                EncryptedMediaClassification::Encrypted => {
                    let key_ref_status = match &fixture.key_profile {
                        Some(profile) => match profile.key_ref_requirement {
                            Some(_) => EncryptedMediaKeyRefStatus::Present,
                            None => EncryptedMediaKeyRefStatus::Missing,
                        },
                        None => EncryptedMediaKeyRefStatus::Missing,
                    };
                    let decryptability = if !system_json_present || !system_json_key_present {
                        EncryptedMediaDecryptability::KeyMissing
                    } else if !system_json_key_well_formed {
                        EncryptedMediaDecryptability::KeyMalformed
                    } else if !system_json_key_matches_expected {
                        EncryptedMediaDecryptability::KeyMismatch
                    } else if matches!(key_ref_status, EncryptedMediaKeyRefStatus::Missing) {
                        EncryptedMediaDecryptability::KeyMissing
                    } else {
                        EncryptedMediaDecryptability::KeyProfileSatisfied
                    };
                    let readiness = if matches!(
                        decryptability,
                        EncryptedMediaDecryptability::KeyProfileSatisfied
                    ) {
                        EncryptedMediaReadiness::Ready
                    } else {
                        EncryptedMediaReadiness::Unsupported
                    };
                    (
                        decryptability,
                        key_ref_status,
                        EncryptedMediaPatchCapability::Unsupported,
                        readiness,
                    )
                }
                EncryptedMediaClassification::MalformedHeader
                | EncryptedMediaClassification::MissingAsset
                | EncryptedMediaClassification::UnknownSuffix => (
                    EncryptedMediaDecryptability::OutOfScope,
                    if matches!(classification, EncryptedMediaClassification::UnknownSuffix) {
                        EncryptedMediaKeyRefStatus::NotRequired
                    } else {
                        match &fixture.key_profile {
                            Some(profile) => match profile.key_ref_requirement {
                                Some(_) => EncryptedMediaKeyRefStatus::Present,
                                None => EncryptedMediaKeyRefStatus::Missing,
                            },
                            None => EncryptedMediaKeyRefStatus::Missing,
                        }
                    },
                    EncryptedMediaPatchCapability::Unsupported,
                    EncryptedMediaReadiness::Unsupported,
                ),
            };

        // Hash the asset's leading bytes for provenance. Missing /
        // unreadable assets get the empty-bytes hash (still a valid
        // ProofHash; the routing diagnostic above makes the asset's
        // failure mode unambiguous).
        let asset_evidence_hash =
            encrypted_media_asset_evidence_hash(asset_bytes.as_deref().unwrap_or(&[]));

        assets.push(EncryptedMediaProofAsset {
            asset_id: fixture_asset.asset_id.clone(),
            declared_path: declared_path_for_report,
            kind,
            classification,
            readiness,
            patch_capability_level,
            key_ref_status,
            decryptability,
            asset_evidence_hash,
            suffix: suffix.clone(),
        });
    }

    assets
}



pub use helper_contracts::{
    AdapterHelperRequirementDeclaration, FIXTURE_HELPER_ALLOWLIST_REF_ID,
    FIXTURE_HELPER_REGISTRY_ID, HelperBinaryAllowlist, HelperBinaryAllowlistEntry,
    HelperBinaryLaunchDiagnostic, HelperBinaryLaunchOutcome, HelperBinaryLaunchValidationRequest,
    HelperBinaryLaunchValidationResult, HelperBinarySignatureMetadata, HelperBinaryStagingError,
    HelperCapability, HelperExecutionMode, HelperExecutionPolicy, HelperFilesystemAccess,
    HelperRedactionClass, HelperRegistry, HelperRegistryDiagnostic, HelperRegistryEntry,
    HelperRegistryInvocationRequest, HelperRegistryValidationResult, HelperResultValidationFailure,
    HelperResultValidationResult, StagedHelperBinary, fixture_helper_registry,
    normalize_helper_result_value, parse_helper_capability, stage_and_verify_helper_binary,
    validate_helper_key_ref_request, validate_helper_registry_entry_value,
    validate_helper_result_value,
};
#[cfg(test)]
pub(crate) use helper_contracts::{
    FixtureHelperStubAdapter, HelperExecutableAdapter, stage_helper_binary_no_follow,
    staged_helper_binary_name,
};
pub use semantic_error::SemanticErrorCode;
pub use fs_safety::{
    atomic_write_bytes, atomic_write_text, promote_staged_directory_no_clobber, safe_join_relative,
    validate_safe_relative_path,
};
use fs_safety::{
    ensure_real_directory, path_has_windows_drive_prefix_component, safe_relative_path_parts,
    write_secret_material_no_clobber,
};
