//! Decrypt + re-encrypt runner for MV/MZ encrypted images.
//! Synthetic entry resolution, process_entry pipeline, and report finalize.

use std::path::Path;

use crate::mv_mz_asset_xor::{MvMzAssetKey, decrypt_rpgmaker_asset, encrypt_rpgmaker_asset};
use crate::{
    CodecTransform, KaifuuResult, KeyValidationMethod, KeyValidationProof, OperationStatus,
    PartialDiagnosticSeverity, ProofHash, sha256_hash_bytes,
};

use super::{
    FINDING_INTERNAL, FINDING_MISSING_KEY, FINDING_OUTCOME_MISMATCH, FINDING_UNSUPPORTED_SURFACE,
    FINDING_UNSUPPORTED_VARIANT, FINDING_WRONG_KEY, ImageAssetKey,
    MV_MZ_ENCRYPTED_IMAGE_SCHEMA_VERSION, MV_MZ_ENCRYPTED_IMAGE_SUPPORT_BOUNDARY,
    MvMzEncryptedImageEntryReport, MvMzEncryptedImageFinding, MvMzEncryptedImageFixture,
    MvMzEncryptedImageFixtureEntry, MvMzEncryptedImageOutcome, MvMzEncryptedImagePath,
    MvMzEncryptedImageReport, MvMzEncryptedImageScenario, MvMzImageRoundTripProof,
    SEMANTIC_MV_MZ_IMAGE_MISSING_KEY, SEMANTIC_MV_MZ_IMAGE_UNSUPPORTED_SURFACE,
    SEMANTIC_MV_MZ_IMAGE_UNSUPPORTED_VARIANT, SEMANTIC_MV_MZ_IMAGE_WRONG_KEY,
    SYNTHETIC_KEY_CORRECT, SYNTHETIC_KEY_WRONG, SYNTHETIC_PNG, encrypt_synthetic_image, is_png,
};

/// The synthetic byte inputs the stub materialises for an entry.
struct ResolvedEntryInputs {
    /// The encrypted asset bytes (always present — even failing scenarios have
    /// asset bytes; only the key / surface routing differs).
    encrypted: Vec<u8>,
    /// The candidate decrypt key, or `None` for the missing-key scenario.
    key: Option<ImageAssetKey>,
}

fn resolve_entry_inputs(scenario: MvMzEncryptedImageScenario) -> ResolvedEntryInputs {
    match scenario {
        MvMzEncryptedImageScenario::Valid | MvMzEncryptedImageScenario::UnsupportedSurface => {
            ResolvedEntryInputs {
                encrypted: encrypt_synthetic_image(SYNTHETIC_KEY_CORRECT),
                key: Some(MvMzAssetKey::from_bytes(SYNTHETIC_KEY_CORRECT)),
            }
        }
        MvMzEncryptedImageScenario::WrongKey => ResolvedEntryInputs {
            encrypted: encrypt_synthetic_image(SYNTHETIC_KEY_CORRECT),
            key: Some(MvMzAssetKey::from_bytes(SYNTHETIC_KEY_WRONG)),
        },
        MvMzEncryptedImageScenario::MissingKey => ResolvedEntryInputs {
            encrypted: encrypt_synthetic_image(SYNTHETIC_KEY_CORRECT),
            key: None,
        },
        MvMzEncryptedImageScenario::UnsupportedVariant => ResolvedEntryInputs {
            // Plaintext PNG with NO RPGMV header — not a valid encrypted image.
            encrypted: SYNTHETIC_PNG.to_vec(),
            key: Some(MvMzAssetKey::from_bytes(SYNTHETIC_KEY_CORRECT)),
        },
    }
}

#[derive(Debug, Clone, Copy)]
pub struct MvMzEncryptedImageRequest<'a> {
    pub fixture: &'a MvMzEncryptedImageFixture,
    /// The manifest file name (no directory), recorded in each entry's
    /// `validationCommand` without leaking a local path.
    pub fixture_file_name: &'a str,
}

/// Run the decrypt + re-encrypt path for every entry. Each entry resolves its
/// synthetic inputs in-process; a re-encrypted patch artifact (round-trip
/// proof) is published **only** after the candidate key decrypts the asset to a
/// valid PNG and the re-encryption reproduces the source bytes. Returns `Err`
/// only on an internal failure; evidence problems are per-entry findings.
pub fn run_mv_mz_encrypted_image(
    request: MvMzEncryptedImageRequest<'_>,
) -> KaifuuResult<MvMzEncryptedImageReport> {
    let fixture = request.fixture;
    let validation_command = format!(
        "kaifuu rpgmaker encrypted-image --fixture {}",
        sanitize_file_name(request.fixture_file_name)
    );
    let path = MvMzEncryptedImagePath::canonical()?;

    let mut entries = Vec::with_capacity(fixture.entries.len());
    for entry in &fixture.entries {
        entries.push(process_entry(
            entry,
            &fixture.source_node_id,
            &fixture.path_id,
            &validation_command,
        )?);
    }

    let status = if entries
        .iter()
        .all(|entry| entry.status == OperationStatus::Passed)
    {
        OperationStatus::Passed
    } else {
        OperationStatus::Failed
    };

    Ok(MvMzEncryptedImageReport {
        schema_version: MV_MZ_ENCRYPTED_IMAGE_SCHEMA_VERSION.to_string(),
        path_id: fixture.path_id.clone(),
        source_node_id: fixture.source_node_id.clone(),
        engine_family: fixture.engine_family.clone(),
        support_boundary: MV_MZ_ENCRYPTED_IMAGE_SUPPORT_BOUNDARY.to_string(),
        path,
        status,
        entries,
    })
}

fn process_entry(
    entry: &MvMzEncryptedImageFixtureEntry,
    source_node_id: &str,
    path_id: &str,
    validation_command: &str,
) -> KaifuuResult<MvMzEncryptedImageEntryReport> {
    let mut findings = Vec::new();

    // (0) Unsupported surface short-circuits BEFORE any byte is touched: audio
    // and JSON surfaces are outside this image-only path.
    if entry.surface_codec != CodecTransform::PngImage {
        findings.push(finding(
            FINDING_UNSUPPORTED_SURFACE,
            "surfaceCodec",
            format!(
                "surface codec {:?} is not an image surface; audio and JSON surfaces are outside this path",
                entry.surface_codec
            ),
            SEMANTIC_MV_MZ_IMAGE_UNSUPPORTED_SURFACE,
        ));
        return Ok(finalize_entry(
            entry,
            source_node_id,
            path_id,
            validation_command,
            MvMzEncryptedImageOutcome::UnsupportedSurface,
            None,
            findings,
        ));
    }

    let ResolvedEntryInputs { encrypted, key } = resolve_entry_inputs(entry.scenario);

    // (1) Missing key: no decryption attempted, no patch write.
    let Some(key) = key else {
        findings.push(finding(
            FINDING_MISSING_KEY,
            "secretRef",
            "no asset key was resolvable for the secret requirement; no decryption attempted"
                .to_string(),
            SEMANTIC_MV_MZ_IMAGE_MISSING_KEY,
        ));
        return Ok(finalize_entry(
            entry,
            source_node_id,
            path_id,
            validation_command,
            MvMzEncryptedImageOutcome::MissingKey,
            None,
            findings,
        ));
    };

    // (2) Decrypt — a non-RPGMV-header asset is an unsupported variant.
    let plaintext = match decrypt_rpgmaker_asset(&encrypted, &key) {
        Ok(plaintext) => plaintext,
        Err(error) => {
            findings.push(finding(
                FINDING_UNSUPPORTED_VARIANT,
                "asset",
                format!("asset is not a well-formed RPGMV-header encrypted image: {error:?}"),
                SEMANTIC_MV_MZ_IMAGE_UNSUPPORTED_VARIANT,
            ));
            return Ok(finalize_entry(
                entry,
                source_node_id,
                path_id,
                validation_command,
                MvMzEncryptedImageOutcome::UnsupportedVariant,
                None,
                findings,
            ));
        }
    };

    // (3) Wrong-key gate: a correctly-decrypted RPG Maker image is a PNG. A
    // decrypt that does not yield the PNG signature is a wrong key — fail
    // BEFORE re-encrypting (no patch write).
    if !is_png(&plaintext) {
        findings.push(finding(
            FINDING_WRONG_KEY,
            "secretRef",
            "candidate key did not decrypt the asset to a valid PNG; no re-encryption performed"
                .to_string(),
            SEMANTIC_MV_MZ_IMAGE_WRONG_KEY,
        ));
        return Ok(finalize_entry(
            entry,
            source_node_id,
            path_id,
            validation_command,
            MvMzEncryptedImageOutcome::WrongKey,
            None,
            findings,
        ));
    }

    // (4) Re-encrypt (the patch write) and prove byte-correctness.
    let reencrypted = encrypt_rpgmaker_asset(&plaintext, &key);
    let encrypted_source_hash = ProofHash::new(sha256_hash_bytes(&encrypted))?;
    let reencrypted_hash = ProofHash::new(sha256_hash_bytes(&reencrypted))?;
    let byte_correct = reencrypted == encrypted;
    let proof = MvMzImageRoundTripProof {
        requirement_id: entry.requirement_id.clone(),
        secret_ref: entry.secret_ref.clone(),
        surface_id: entry.surface.surface_id(),
        encrypted_source_hash,
        decrypted_plaintext_hash: ProofHash::new(sha256_hash_bytes(&plaintext))?,
        reencrypted_hash: reencrypted_hash.clone(),
        byte_correct_round_trip: byte_correct,
        key_material_hash: key.material_hash()?,
        key_bytes: u32::try_from(key.byte_len()).unwrap_or(u32::MAX),
        validation: KeyValidationProof {
            method: KeyValidationMethod::FixtureRoundTripProof,
            proof_hash: reencrypted_hash,
        },
        redaction_status: crate::HelperRedactionStatus::Redacted,
    };

    // A round trip that is not byte-correct is an internal failure (the XOR
    // scheme must be involutive); never publish a non-byte-correct proof.
    if !byte_correct {
        findings.push(finding(
            FINDING_INTERNAL,
            "reencrypted",
            "re-encryption did not reproduce the source bytes (round-trip not byte-correct)"
                .to_string(),
            SEMANTIC_MV_MZ_IMAGE_UNSUPPORTED_VARIANT,
        ));
        return Ok(finalize_entry(
            entry,
            source_node_id,
            path_id,
            validation_command,
            MvMzEncryptedImageOutcome::UnsupportedVariant,
            None,
            findings,
        ));
    }

    Ok(finalize_entry(
        entry,
        source_node_id,
        path_id,
        validation_command,
        MvMzEncryptedImageOutcome::RoundTripped,
        Some(proof),
        findings,
    ))
}

// reason: single cohesive entry-finalize over distinct MV/MZ header fields; a params struct would only relocate the arity.
#[allow(clippy::too_many_arguments)]
fn finalize_entry(
    entry: &MvMzEncryptedImageFixtureEntry,
    source_node_id: &str,
    path_id: &str,
    validation_command: &str,
    outcome: MvMzEncryptedImageOutcome,
    proof: Option<MvMzImageRoundTripProof>,
    mut findings: Vec<MvMzEncryptedImageFinding>,
) -> MvMzEncryptedImageEntryReport {
    // Validator: the evidence-derived outcome must match the declared
    // expectation. A correctly-diagnosed failure (wrong-key, missing-key,
    // unsupported surface / variant) is a structured finding but a PASSING
    // conformance entry — the path behaved correctly. Only an outcome mismatch
    // or an internal finding flips the entry red.
    let outcome_matches = entry.expected == outcome;
    if !outcome_matches {
        findings.push(finding(
            FINDING_OUTCOME_MISMATCH,
            "expected",
            format!(
                "entry declared outcome {} but evidence derived {}",
                entry.expected.as_str(),
                outcome.as_str()
            ),
            SEMANTIC_MV_MZ_IMAGE_UNSUPPORTED_VARIANT,
        ));
    }

    let round_tripped = outcome == MvMzEncryptedImageOutcome::RoundTripped;
    // Belt-and-braces: a proof may exist ONLY for a round-tripped outcome.
    let proof = if round_tripped { proof } else { None };

    let status = if outcome_matches && !findings.iter().any(|finding| forces_failure(&finding.code))
    {
        OperationStatus::Passed
    } else {
        OperationStatus::Failed
    };

    MvMzEncryptedImageEntryReport {
        entry_id: entry.entry_id.clone(),
        source_node_id: source_node_id.to_string(),
        path_id: path_id.to_string(),
        surface_id: entry.surface.surface_id(),
        scenario: entry.scenario,
        outcome,
        round_tripped: round_tripped && proof.is_some(),
        proof,
        validation_command: validation_command.to_string(),
        redaction_status: "redacted".to_string(),
        status,
        findings,
    }
}

/// Internal findings that flip an entry red regardless of the declared
/// expectation. Diagnosis-class findings (the expected semantic outcomes) are
/// excluded — a correctly-diagnosed wrong key is a passing conformance entry.
fn forces_failure(code: &str) -> bool {
    matches!(code, FINDING_OUTCOME_MISMATCH | FINDING_INTERNAL)
}

fn finding(
    code: &str,
    field: &str,
    message: String,
    semantic_code: &str,
) -> MvMzEncryptedImageFinding {
    MvMzEncryptedImageFinding {
        code: code.to_string(),
        severity: PartialDiagnosticSeverity::P0,
        field: field.to_string(),
        message,
        semantic_code: Some(semantic_code.to_string()),
    }
}

/// Keep only the file-name component of a declared manifest name so the recorded
/// validation command can never echo a local directory path.
fn sanitize_file_name(name: &str) -> String {
    Path::new(name)
        .file_name()
        .and_then(|component| component.to_str())
        .map_or_else(|| "encrypted-image.json".to_string(), ToString::to_string)
}
