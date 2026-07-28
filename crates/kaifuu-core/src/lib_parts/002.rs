
pub use bridge_v02_model::*;
pub use bridge_v02_context::*;
pub use bridge_v02_validation::*;
#[rustfmt::skip]
pub(crate) use bridge_v02_validation::{ assert_localization_policy_v02, assert_source_location_v02, assert_surface_context_v02, };
pub use patch_report_model::*;
pub use asset_patch_capability::*;
pub use operation_result_model::*;
pub use layered_access_preflight::*;
#[rustfmt::skip]
pub(crate) use layered_access_transforms::remediation_for_layered_stage;
pub use adapter_failures::*;
#[rustfmt::skip]
pub(crate) use report_redaction::{ as_record, assert_byte_range_v02, assert_equals, assert_hash_string_v02, assert_known_asset_id, assert_non_empty, assert_non_negative_integer_value, assert_one_of, assert_optional_value_string, assert_optional_value_uuid7, assert_pixel_region_v02, assert_required_boolean, assert_required_pixel_region_v02, assert_required_string, assert_required_uuid7, assert_required_value_string, assert_required_value_uuid7, assert_revision_hash_matches_v02, assert_schema_version_v02, assert_surface_kind, assert_uuid7, assert_value_byte_range, assert_value_one_of, assert_value_string, assert_value_string_array, };
pub use redacted_content_summary::*;
pub use plain_xp3_writer_model::*;
pub use plain_xp3_reader::*;
pub use plain_xp3_directory::*;
#[rustfmt::skip]
pub(crate) use plain_xp3_directory::{ checked_end, has_legacy_xp3_encrypted_marker, hash_xp3_segments, parse_xp3_file_chunk, read_chunk_name, read_le_u64, };
pub use json_io::*;
pub use golden_harness_run::*;
#[rustfmt::skip]
pub(crate) use golden_harness_run::{ GoldenPatchPhaseArgs, golden_diagnostic_summary, golden_error_summary, record_golden_failure, report_passed_phase, run_golden_patch_phase, };
#[rustfmt::skip]
pub(crate) use golden_harness_report::{ record_adapter_failures, report_byte_equivalence, };
#[rustfmt::skip]
pub(crate) use golden_harness_output::{ asset_preservation_signature, report_output_equivalence, report_translated_patch, report_verify_phase, };
#[rustfmt::skip]
pub(crate) use golden_harness_v02::{ patch_export_for_adapter, report_v02_source_compatibility, };
#[cfg(test)]
#[rustfmt::skip]
pub(crate) use golden_harness_v02::{ v02_bridge_units_by_key, v02_patch_entry_span_mappings_compatible, };
pub use golden_harness_translation::*;
#[rustfmt::skip]
pub(crate) use golden_harness_translation::{ finalize_golden_report, report_translated_target_equivalence, source_unit_key_from_asset_ref, };

#[cfg(test)]
use profile_validation::validate_capability_report;
#[rustfmt::skip]
pub(crate) use profile_validation::{ is_bcp47_like_locale, validate_profile_relative_path, };
pub use profile_validation::{GameProfile, validate_profile_value};

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

    let assets = collect_encrypted_media_assets(
        fixture,
        game_dir_full.as_deref(),
        system_json_present,
        system_json_key_present,
        system_json_key_well_formed,
        system_json_key_matches_expected,
        &mut diagnostics,
    );

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

    // Aggregate readiness: `Ready` requires *all* encrypted assets to
    // be `Ready` and no blocking diagnostics. Plaintext-only fixtures
    // resolve to `PlaintextEvidence`. Anything else routes to
    // `Unsupported`.
    let has_blocking_diagnostic = diagnostics
        .iter()
        .any(|diagnostic| diagnostic.severity.is_blocking());
    let aggregate_readiness = if has_blocking_diagnostic || assets.is_empty() {
        EncryptedMediaReadiness::Unsupported
    } else if assets
        .iter()
        .all(|asset| matches!(asset.readiness, EncryptedMediaReadiness::PlaintextEvidence))
    {
        EncryptedMediaReadiness::PlaintextEvidence
    } else if assets.iter().all(|asset| {
        matches!(
            asset.readiness,
            EncryptedMediaReadiness::Ready | EncryptedMediaReadiness::PlaintextEvidence
        )
    }) && assets
        .iter()
        .any(|asset| matches!(asset.readiness, EncryptedMediaReadiness::Ready))
    {
        EncryptedMediaReadiness::Ready
    } else {
        EncryptedMediaReadiness::Unsupported
    };

    let key_profile_id = fixture
        .key_profile
        .as_ref()
        .map(|profile| profile.profile_id.clone());
    let requirement_id = fixture
        .key_profile
        .as_ref()
        .and_then(|profile| profile.key_ref_requirement.as_ref())
        .map(|requirement| requirement.requirement_id.clone());
    let secret_ref = fixture
        .key_profile
        .as_ref()
        .and_then(|profile| profile.key_ref_requirement.as_ref())
        .map(|requirement| requirement.secret_ref.clone());

    let semantic_remediation = if matches!(aggregate_readiness, EncryptedMediaReadiness::Ready) {
        Some(
            "encrypted-media readiness reports profile wiring only;  makes no decryption, extraction, script-patch, or dialogue-extraction capability claim".to_string(),
        )
    } else if matches!(
        aggregate_readiness,
        EncryptedMediaReadiness::PlaintextEvidence
    ) {
        Some(
            "plaintext media surfaced as evidence only; no patch capability is claimed".to_string(),
        )
    } else {
        Some(
            "encrypted-media routing diagnostics fired;  makes no decryption, extraction, script-patch, or dialogue-extraction capability claim".to_string(),
        )
    };

    let status = if has_blocking_diagnostic {
        OperationStatus::Failed
    } else {
        OperationStatus::Passed
    };

    Ok(EncryptedMediaProofReport {
        schema_version: ENCRYPTED_MEDIA_PROOF_SCHEMA_VERSION.to_string(),
        fixture_id: fixture.fixture_id.clone(),
        profile_id: fixture.profile_id.clone(),
        status,
        support_boundary: ENCRYPTED_MEDIA_PROOF_SUPPORT_BOUNDARY.to_string(),
        readiness: aggregate_readiness,
        patch_capability_level: if matches!(
            aggregate_readiness,
            EncryptedMediaReadiness::PlaintextEvidence
        ) {
            EncryptedMediaPatchCapability::NotClaimed
        } else {
            EncryptedMediaPatchCapability::Unsupported
        },
        // Acceptance criterion: "Readiness output never claims dialogue
        // extraction or script patch support based only on media-key
        // detection." Hardcoded false; this is the load-bearing
        // separation between media routing and script capability.
        script_capability_claimed: false,
        // Acceptance criterion: "Missing or wrong keys return semantic
        // diagnostics before decrypted bytes are persisted." The proof
        // never decrypts; this flag is hardcoded false so downstream
        // auditors can confirm the proof did not persist decrypted
        // bytes.
        decrypted_bytes_persisted: false,
        assets,
        key_profile: EncryptedMediaProofKeyProfile {
            status: key_profile_status,
            key_profile_id,
            requirement_id,
            secret_ref,
            system_json_proof_hash,
            system_json_present,
            system_json_key_present,
            system_json_key_well_formed,
            expected_system_json_key_hash,
            system_json_key_hash,
            has_encrypted_images_flag,
            has_encrypted_audio_flag,
        },
        diagnostics,
        semantic_remediation,
    })
}

