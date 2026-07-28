//! Encrypted-media readiness proof routing.

use super::*;

/// Run the encrypted-media readiness proof.
/// Routing rules (acceptance criteria):
/// - Encrypted image / audio / video media variants are detected with
///   exact asset-kind capability levels — per-asset `kind` and
///   `classification` are set from the bytes, not the fixture.
/// - Missing or wrong keys return semantic diagnostics before decrypted
///   bytes are persisted (the proof never decrypts; `decryptedBytesPersisted`
///   is always `false`).
/// - Readiness output never claims dialogue extraction or script patch
///   support based only on media-key detection (`scriptCapabilityClaimed`
///   is always `false`; `patchCapabilityLevel` is never `patch_back` or
///   `extract` — for encrypted assets it is forced to `Unsupported`, for
///   plaintext it is `NotClaimed`).
/// - Public fixtures use synthetic media and public test keys only —
///   absolute / traversal / home paths are rejected up front and never
///   appear in the report.
pub fn encrypted_media_proof(
    request: EncryptedMediaProofRequest<'_>,
) -> KaifuuResult<EncryptedMediaProofReport> {
    let fixture = request.fixture;
    let mut diagnostics: Vec<EncryptedMediaProofDiagnostic> = Vec::new();

    let game_dir_validated = match validate_encrypted_media_fixture_path(&fixture.game_dir) {
        Ok(_) => true,
        Err(message) => {
            diagnostics.push(EncryptedMediaProofDiagnostic {
                code: "rpgmaker.encrypted_media.game_dir.leaked".to_string(),
                severity: PartialDiagnosticSeverity::P0,
                field: "gameDir".to_string(),
                message,
                semantic_code: Some(SEMANTIC_FORBIDDEN_PUBLIC_SERIALIZATION.to_string()),
                remediation: Some(
                    "gameDir must be relative to the fixture file and must not contain absolute roots, drive letters, parent traversal, or home prefixes"
                        .to_string(),
                ),
            });
            false
        }
    };

    let game_dir_full = if game_dir_validated {
        Some(request.fixture_dir.join(&fixture.game_dir))
    } else {
        None
    };

    // Read System.json once so per-asset routing can branch on the
    // shared key profile evidence.
    let system_json = game_dir_full
        .as_deref()
        .and_then(read_encrypted_media_system_json);
    let system_json_present = system_json.is_some();
    let system_json_key_present = system_json
        .as_ref()
        .is_some_and(|sj| sj.encryption_key_present);
    let system_json_key_well_formed = system_json
        .as_ref()
        .is_some_and(|sj| sj.encryption_key_well_formed);
    let system_json_proof_hash = system_json.as_ref().and_then(|sj| sj.proof_hash.clone());
    let system_json_key_hash = system_json
        .as_ref()
        .and_then(|sj| sj.encryption_key_hash.clone());
    let expected_system_json_key_hash = fixture
        .key_profile
        .as_ref()
        .and_then(|profile| profile.expected_system_json_key_hash.clone());
    let system_json_key_matches_expected = match (
        expected_system_json_key_hash.as_ref(),
        system_json_key_hash.as_ref(),
    ) {
        (Some(expected), Some(actual)) => expected == actual,
        _ => true,
    };
    let has_encrypted_images_flag = system_json.as_ref().and_then(|sj| sj.has_encrypted_images);
    let has_encrypted_audio_flag = system_json.as_ref().and_then(|sj| sj.has_encrypted_audio);

    let any_encrypted_declared = fixture.assets.iter().any(|asset| {
        matches!(
            asset.expected_classification,
            EncryptedMediaClassification::Encrypted
        )
    });

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

        let asset_full = match (path_rejected, game_dir_full.as_deref()) {
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

    // Per-asset key-profile mismatch surfacing: System.json says
    // `hasEncryptedImages: false` but the fixture declared encrypted
    // images (or vice versa). Surfaced as P1 readiness diagnostics so a
    // fixture-authoring drift is noticed before patch claims spread.
    let declared_image_encrypted = fixture.assets.iter().any(|asset| {
        asset.expected_kind == EncryptedMediaAssetKind::Image
            && asset.expected_classification == EncryptedMediaClassification::Encrypted
    });
    let declared_audio_encrypted = fixture.assets.iter().any(|asset| {
        asset.expected_kind == EncryptedMediaAssetKind::Audio
            && asset.expected_classification == EncryptedMediaClassification::Encrypted
    });
    if let (Some(false), true) = (has_encrypted_images_flag, declared_image_encrypted) {
        diagnostics.push(EncryptedMediaProofDiagnostic {
            code: "rpgmaker.encrypted_media.system_json.images_flag_mismatch".to_string(),
            severity: PartialDiagnosticSeverity::P1,
            field: "data/System.json.hasEncryptedImages".to_string(),
            message:
                "fixture declared encrypted images but data/System.json hasEncryptedImages is false"
                    .to_string(),
            semantic_code: Some(SEMANTIC_AMBIGUOUS_ENGINE_VARIANT.to_string()),
            remediation: Some(
                "align data/System.json hasEncryptedImages with the declared media surface"
                    .to_string(),
            ),
        });
    }
    if let (Some(false), true) = (has_encrypted_audio_flag, declared_audio_encrypted) {
        diagnostics.push(EncryptedMediaProofDiagnostic {
            code: "rpgmaker.encrypted_media.system_json.audio_flag_mismatch".to_string(),
            severity: PartialDiagnosticSeverity::P1,
            field: "data/System.json.hasEncryptedAudio".to_string(),
            message:
                "fixture declared encrypted audio but data/System.json hasEncryptedAudio is false"
                    .to_string(),
            semantic_code: Some(SEMANTIC_AMBIGUOUS_ENGINE_VARIANT.to_string()),
            remediation: Some(
                "align data/System.json hasEncryptedAudio with the declared media surface"
                    .to_string(),
            ),
        });
    }

    // Key-profile section + cross-cutting routing diagnostics.
    let key_profile_status = match (&fixture.key_profile, any_encrypted_declared) {
        (Some(profile), _) => {
            let recognized =
                RPG_MAKER_MV_MZ_RECOGNIZED_KEY_PROFILE_IDS.contains(&profile.profile_id.as_str());
            if !recognized {
                diagnostics.push(EncryptedMediaProofDiagnostic {
                    code: "rpgmaker.encrypted_media.key_profile.unknown".to_string(),
                    severity: PartialDiagnosticSeverity::P0,
                    field: "keyProfile.profileId".to_string(),
                    message: format!(
                        "key profile id {} is not in the recognised RPG Maker MV/MZ vocabulary",
                        profile.profile_id
                    ),
                    semantic_code: Some(SEMANTIC_UNKNOWN_ENGINE_VARIANT.to_string()),
                    remediation: Some(
                        "use a recognised KAIFUU key-profile id; recognition does not imply a decryption capability claim".to_string(),
                    ),
                });
            }
            if profile.key_ref_requirement.is_none() {
                diagnostics.push(EncryptedMediaProofDiagnostic {
                    code: "rpgmaker.encrypted_media.key_profile.missing_key_ref".to_string(),
                    severity: PartialDiagnosticSeverity::P0,
                    field: "keyProfile.keyRefRequirement".to_string(),
                    message: "encrypted-media fixtures must declare a keyRef requirement"
                        .to_string(),
                    semantic_code: Some(SEMANTIC_MISSING_KEY_PROFILE.to_string()),
                    remediation: Some(
                        "add a keyRefRequirement entry with requirementId and secretRef"
                            .to_string(),
                    ),
                });
            }
            EncryptedMediaKeyRefStatus::Present
        }
        (None, true) => {
            diagnostics.push(EncryptedMediaProofDiagnostic {
                code: "rpgmaker.encrypted_media.key_profile.missing".to_string(),
                severity: PartialDiagnosticSeverity::P0,
                field: "keyProfile".to_string(),
                message: "fixture declares encrypted media but supplies no keyProfile".to_string(),
                semantic_code: Some(SEMANTIC_MISSING_KEY_PROFILE.to_string()),
                remediation: Some(
                    "add a keyProfile entry with profileId and keyRefRequirement".to_string(),
                ),
            });
            EncryptedMediaKeyRefStatus::Missing
        }
        (None, false) => EncryptedMediaKeyRefStatus::NotRequired,
    };

    if any_encrypted_declared && !system_json_present {
        diagnostics.push(EncryptedMediaProofDiagnostic {
            code: "rpgmaker.encrypted_media.system_json.missing".to_string(),
            severity: PartialDiagnosticSeverity::P0,
            field: "gameDir".to_string(),
            message: "encrypted-media readiness requires data/System.json evidence under the game directory".to_string(),
            semantic_code: Some(SEMANTIC_MISSING_KEY_PROFILE.to_string()),
            remediation: Some(
                "stage a data/System.json file with encryptionKey + hasEncryptedImages / hasEncryptedAudio flags under the game directory".to_string(),
            ),
        });
    } else if any_encrypted_declared && system_json_present && !system_json_key_present {
        diagnostics.push(EncryptedMediaProofDiagnostic {
            code: "rpgmaker.encrypted_media.system_json.key_missing".to_string(),
            severity: PartialDiagnosticSeverity::P0,
            field: "data/System.json.encryptionKey".to_string(),
            message: "data/System.json has no encryptionKey value".to_string(),
            semantic_code: Some(SEMANTIC_MISSING_KEY_MATERIAL.to_string()),
            remediation: Some(
                "populate data/System.json.encryptionKey with a fixture-safe 32-char lowercase hex value".to_string(),
            ),
        });
    } else if any_encrypted_declared
        && system_json_present
        && system_json_key_present
        && !system_json_key_well_formed
    {
        diagnostics.push(EncryptedMediaProofDiagnostic {
            code: "rpgmaker.encrypted_media.system_json.key_malformed".to_string(),
            severity: PartialDiagnosticSeverity::P0,
            field: "data/System.json.encryptionKey".to_string(),
            message: "data/System.json.encryptionKey is not a 32-char lowercase hex value"
                .to_string(),
            semantic_code: Some(SEMANTIC_KEY_VALIDATION_FAILED.to_string()),
            remediation: Some(
                "regenerate data/System.json.encryptionKey as a 32-char lowercase hex string"
                    .to_string(),
            ),
        });
    } else if any_encrypted_declared
        && system_json_present
        && system_json_key_present
        && system_json_key_well_formed
        && !system_json_key_matches_expected
    {
        diagnostics.push(EncryptedMediaProofDiagnostic {
            code: "rpgmaker.encrypted_media.system_json.key_mismatch".to_string(),
            severity: PartialDiagnosticSeverity::P0,
            field: "data/System.json.encryptionKey".to_string(),
            message:
                "data/System.json.encryptionKey hash does not match the fixture key-profile evidence"
                    .to_string(),
            semantic_code: Some(SEMANTIC_KEY_VALIDATION_FAILED.to_string()),
            remediation: Some(
                "align the fixture-safe System.json key with expectedSystemJsonKeyHash; raw keys must not be serialized"
                    .to_string(),
            ),
        });
    }

    Ok(finalize_encrypted_media_report(
        EncryptedMediaReportFinalizeInput {
            fixture,
            assets,
            diagnostics,
            key_profile_status,
            system_json_proof_hash,
            system_json_present,
            system_json_key_present,
            system_json_key_well_formed,
            expected_system_json_key_hash,
            system_json_key_hash,
            has_encrypted_images_flag,
            has_encrypted_audio_flag,
        },
    ))
}
