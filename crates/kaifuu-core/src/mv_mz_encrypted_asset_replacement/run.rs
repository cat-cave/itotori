//! Replacement + verify run pipeline for MV/MZ encrypted-asset replacement.

use std::path::Path;

use crate::mv_mz_asset_xor::{
    MvMzAssetKey, RPGMAKER_ASSET_XOR_PREFIX_LEN, decrypt_rpgmaker_asset, encrypt_rpgmaker_asset,
};
use crate::{
    KaifuuResult, KeyValidationMethod, KeyValidationProof, OperationStatus,
    PartialDiagnosticSeverity, ProofHash, RPGMAKER_MV_ENCRYPTED_MEDIA_HEADER, sha256_hash_bytes,
};

use super::{
    FINDING_INTERNAL, FINDING_MISSING_KEY, FINDING_NOT_MEDIA, FINDING_OUTCOME_MISMATCH,
    FINDING_TAMPERED, FINDING_UNSUPPORTED_SURFACE, FINDING_WRONG_KEY,
    MV_MZ_ASSET_REPLACEMENT_SCHEMA_VERSION, MV_MZ_ASSET_REPLACEMENT_SUPPORT_BOUNDARY,
    MvMzAssetReplacementEntry, MvMzAssetReplacementEntryReport, MvMzAssetReplacementFinding,
    MvMzAssetReplacementManifest, MvMzAssetReplacementOutcome, MvMzAssetReplacementPath,
    MvMzAssetReplacementReport, MvMzAssetReplacementScenario, MvMzReplacementProof,
    ReplacementMediaKind, SEMANTIC_REPLACEMENT_MISSING_KEY, SEMANTIC_REPLACEMENT_NOT_MEDIA,
    SEMANTIC_REPLACEMENT_TAMPERED, SEMANTIC_REPLACEMENT_UNSUPPORTED_SURFACE,
    SEMANTIC_REPLACEMENT_WRONG_KEY, SYNTHETIC_KEY_CORRECT, SYNTHETIC_KEY_WRONG,
    replacement_not_media_blob,
};

/// The synthetic key the resolver yields for a scenario, or `None` (missing).
fn resolve_key(scenario: MvMzAssetReplacementScenario) -> Option<MvMzAssetKey> {
    match scenario {
        MvMzAssetReplacementScenario::MissingKey => None,
        MvMzAssetReplacementScenario::WrongKey => {
            Some(MvMzAssetKey::from_bytes(SYNTHETIC_KEY_WRONG))
        }
        _ => Some(MvMzAssetKey::from_bytes(SYNTHETIC_KEY_CORRECT)),
    }
}

/// The synthetic replacement plaintext for a scenario.
fn resolve_replacement(
    scenario: MvMzAssetReplacementScenario,
    media_kind: ReplacementMediaKind,
) -> Vec<u8> {
    match scenario {
        MvMzAssetReplacementScenario::ReplacementNotMedia => replacement_not_media_blob(),
        _ => media_kind.replacement_plaintext(),
    }
}

#[derive(Debug, Clone, Copy)]
pub struct MvMzAssetReplacementRequest<'a> {
    pub manifest: &'a MvMzAssetReplacementManifest,
    /// The manifest file name (no directory), recorded in each entry's
    /// `validationCommand` without leaking a local path.
    pub manifest_file_name: &'a str,
}

/// Run the replacement + verify path for every manifest entry. A consumable
/// patch (verified proof) is published only after the key commitment matches,
/// the replacement is valid media, and every verify check passes.
pub fn run_mv_mz_asset_replacement(
    request: MvMzAssetReplacementRequest<'_>,
) -> KaifuuResult<MvMzAssetReplacementReport> {
    let manifest = request.manifest;
    let validation_command = format!(
        "kaifuu rpgmaker asset-replacement --manifest {}",
        sanitize_file_name(request.manifest_file_name)
    );
    let path = MvMzAssetReplacementPath::canonical()?;

    let mut entries = Vec::with_capacity(manifest.entries.len());
    for entry in &manifest.entries {
        entries.push(process_entry(
            entry,
            &manifest.source_node_id,
            &manifest.path_id,
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

    Ok(MvMzAssetReplacementReport {
        schema_version: MV_MZ_ASSET_REPLACEMENT_SCHEMA_VERSION.to_string(),
        path_id: manifest.path_id.clone(),
        source_node_id: manifest.source_node_id.clone(),
        engine_family: manifest.engine_family.clone(),
        support_boundary: MV_MZ_ASSET_REPLACEMENT_SUPPORT_BOUNDARY.to_string(),
        path,
        status,
        entries,
    })
}

fn process_entry(
    entry: &MvMzAssetReplacementEntry,
    source_node_id: &str,
    path_id: &str,
    validation_command: &str,
) -> KaifuuResult<MvMzAssetReplacementEntryReport> {
    let mut findings = Vec::new();

    // (0) The surface codec must match the media kind.
    if entry.surface_codec != entry.media_kind.codec() {
        findings.push(finding(
            FINDING_UNSUPPORTED_SURFACE,
            "surfaceCodec",
            format!(
                "surface codec {:?} does not match media kind {}",
                entry.surface_codec,
                entry.media_kind.as_str()
            ),
            SEMANTIC_REPLACEMENT_UNSUPPORTED_SURFACE,
        ));
        return Ok(finalize_entry(
            entry,
            source_node_id,
            path_id,
            validation_command,
            MvMzAssetReplacementOutcome::UnsupportedSurface,
            None,
            findings,
        ));
    }

    // (1) Resolve the key from the secret ref.
    let Some(key) = resolve_key(entry.scenario) else {
        findings.push(finding(
            FINDING_MISSING_KEY,
            "secretRef",
            "no asset key was resolvable for the secret requirement; no patch produced".to_string(),
            SEMANTIC_REPLACEMENT_MISSING_KEY,
        ));
        return Ok(finalize_entry(
            entry,
            source_node_id,
            path_id,
            validation_command,
            MvMzAssetReplacementOutcome::MissingKey,
            None,
            findings,
        ));
    };

    // (2) Key-commitment gate (credential posture): the resolved key's sha256
    // must match the declared commitment. A mismatch is a wrong key.
    let key_material_hash = key.material_hash()?;
    if key_material_hash.as_str() != entry.key_commitment_sha256 {
        findings.push(finding(
            FINDING_WRONG_KEY,
            "keyCommitmentSha256",
            "resolved key sha256 does not match the declared key commitment; no patch produced"
                .to_string(),
            SEMANTIC_REPLACEMENT_WRONG_KEY,
        ));
        return Ok(finalize_entry(
            entry,
            source_node_id,
            path_id,
            validation_command,
            MvMzAssetReplacementOutcome::WrongKeyRejected,
            None,
            findings,
        ));
    }

    // (3) The replacement plaintext must be valid media of the declared kind.
    let replacement = resolve_replacement(entry.scenario, entry.media_kind);
    if !entry.media_kind.is_valid_media(&replacement) {
        findings.push(finding(
            FINDING_NOT_MEDIA,
            "replacement",
            format!(
                "replacement plaintext does not carry the {} media signature",
                entry.media_kind.as_str()
            ),
            SEMANTIC_REPLACEMENT_NOT_MEDIA,
        ));
        return Ok(finalize_entry(
            entry,
            source_node_id,
            path_id,
            validation_command,
            MvMzAssetReplacementOutcome::ReplacementNotMedia,
            None,
            findings,
        ));
    }

    // (4) The original in-game encrypted asset (encrypted with the same key).
    let original_encrypted = encrypt_rpgmaker_asset(&entry.media_kind.original_plaintext(), &key);

    // (5) Produce the patched asset by encrypting the replacement. For the
    // tamper scenario, corrupt one body byte AFTER production.
    let mut patched = encrypt_rpgmaker_asset(&replacement, &key);
    if entry.scenario == MvMzAssetReplacementScenario::Tampered {
        // Flip a byte beyond the 16-byte XOR prefix so the header stays intact
        // but decrypt no longer recovers the replacement.
        let tamper_index = RPGMAKER_MV_ENCRYPTED_MEDIA_HEADER.len() + RPGMAKER_ASSET_XOR_PREFIX_LEN;
        if let Some(byte) = patched.get_mut(tamper_index) {
            *byte ^= 0xff;
        }
    }

    // (6) Verify the patch.
    let decrypted = match decrypt_rpgmaker_asset(&patched, &key) {
        Ok(decrypted) => decrypted,
        Err(error) => {
            // A produced patch must always carry the header; failing here is a
            // tamper of the header region (or an internal fault).
            findings.push(finding(
                FINDING_TAMPERED,
                "patched",
                format!("patched asset no longer decrypts: {error:?}"),
                SEMANTIC_REPLACEMENT_TAMPERED,
            ));
            return Ok(finalize_entry(
                entry,
                source_node_id,
                path_id,
                validation_command,
                MvMzAssetReplacementOutcome::TamperRejected,
                None,
                findings,
            ));
        }
    };

    let decrypt_matches_replacement = decrypted == replacement;
    if !decrypt_matches_replacement {
        // Tampered patch: decrypt no longer recovers the replacement — reject.
        findings.push(finding(
            FINDING_TAMPERED,
            "patched",
            "patched asset was corrupted; decrypt no longer recovers the replacement".to_string(),
            SEMANTIC_REPLACEMENT_TAMPERED,
        ));
        return Ok(finalize_entry(
            entry,
            source_node_id,
            path_id,
            validation_command,
            MvMzAssetReplacementOutcome::TamperRejected,
            None,
            findings,
        ));
    }

    let header_len = RPGMAKER_MV_ENCRYPTED_MEDIA_HEADER.len();
    let header_correct =
        patched.len() >= header_len && &patched[..header_len] == RPGMAKER_MV_ENCRYPTED_MEDIA_HEADER;
    // Non-replaced tail: bytes beyond the 16-byte XOR prefix are stored verbatim.
    let tail_start = RPGMAKER_ASSET_XOR_PREFIX_LEN.min(replacement.len());
    let tail_bytes_correct = decrypted.len() == replacement.len()
        && decrypted[tail_start..] == replacement[tail_start..];
    let differs_from_original = patched != original_encrypted;
    let replacement_plaintext_hash = ProofHash::new(sha256_hash_bytes(&replacement))?;
    let matches_declared_commitment =
        replacement_plaintext_hash.as_str() == entry.replacement_sha256;

    let all_checks = header_correct
        && tail_bytes_correct
        && differs_from_original
        && matches_declared_commitment;

    // An internal fault (the involutive XOR / verify invariants must hold for a
    // valid entry) flips the entry red — never publish an unverified patch.
    if !all_checks {
        findings.push(finding(
            FINDING_INTERNAL,
            "verify",
            format!(
                "verify failed: header_correct={header_correct} tail_bytes_correct={tail_bytes_correct} differs_from_original={differs_from_original} matches_declared_commitment={matches_declared_commitment}"
            ),
            SEMANTIC_REPLACEMENT_TAMPERED,
        ));
        return Ok(finalize_entry(
            entry,
            source_node_id,
            path_id,
            validation_command,
            MvMzAssetReplacementOutcome::Replaced,
            None,
            findings,
        ));
    }

    let decrypted_patched_hash = ProofHash::new(sha256_hash_bytes(&decrypted))?;
    let proof = MvMzReplacementProof {
        requirement_id: entry.requirement_id.clone(),
        secret_ref: entry.secret_ref.clone(),
        surface_id: entry.surface_id.clone(),
        media_kind: entry.media_kind,
        original_encrypted_hash: ProofHash::new(sha256_hash_bytes(&original_encrypted))?,
        replacement_plaintext_hash,
        patched_encrypted_hash: ProofHash::new(sha256_hash_bytes(&patched))?,
        decrypted_patched_hash: decrypted_patched_hash.clone(),
        decrypt_matches_replacement,
        header_correct,
        tail_bytes_correct,
        differs_from_original,
        matches_declared_commitment,
        key_commitment_matches: true,
        key_material_hash,
        key_bytes: u32::try_from(key.byte_len()).unwrap_or(u32::MAX),
        validation: KeyValidationProof {
            method: KeyValidationMethod::KnownPlaintextProof,
            proof_hash: decrypted_patched_hash,
        },
        redaction_status: crate::HelperRedactionStatus::Redacted,
    };

    Ok(finalize_entry(
        entry,
        source_node_id,
        path_id,
        validation_command,
        MvMzAssetReplacementOutcome::Replaced,
        Some(proof),
        findings,
    ))
}

// reason: single cohesive entry-finalize over distinct MV/MZ fields; a params struct would only relocate the arity.
#[allow(clippy::too_many_arguments)]
fn finalize_entry(
    entry: &MvMzAssetReplacementEntry,
    source_node_id: &str,
    path_id: &str,
    validation_command: &str,
    outcome: MvMzAssetReplacementOutcome,
    proof: Option<MvMzReplacementProof>,
    mut findings: Vec<MvMzAssetReplacementFinding>,
) -> MvMzAssetReplacementEntryReport {
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
            SEMANTIC_REPLACEMENT_TAMPERED,
        ));
    }

    let replaced = outcome == MvMzAssetReplacementOutcome::Replaced;
    // Belt-and-braces: a proof may exist ONLY for a replaced outcome.
    let proof = if replaced { proof } else { None };

    let status = if outcome_matches && !findings.iter().any(|finding| forces_failure(&finding.code))
    {
        OperationStatus::Passed
    } else {
        OperationStatus::Failed
    };

    MvMzAssetReplacementEntryReport {
        entry_id: entry.entry_id.clone(),
        source_node_id: source_node_id.to_string(),
        path_id: path_id.to_string(),
        surface_id: entry.surface_id.clone(),
        media_kind: entry.media_kind,
        scenario: entry.scenario,
        outcome,
        replaced: replaced && proof.is_some(),
        proof,
        validation_command: validation_command.to_string(),
        redaction_status: "redacted".to_string(),
        status,
        findings,
    }
}

/// Findings that flip an entry red regardless of the declared expectation.
fn forces_failure(code: &str) -> bool {
    matches!(code, FINDING_OUTCOME_MISMATCH | FINDING_INTERNAL)
}

fn finding(
    code: &str,
    field: &str,
    message: String,
    semantic_code: &str,
) -> MvMzAssetReplacementFinding {
    MvMzAssetReplacementFinding {
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
        .map_or_else(|| "asset-replacement.json".to_string(), ToString::to_string)
}
