fn process_entry(
    entry: &MvMzEncryptedAudioFixtureEntry,
    source_node_id: &str,
    path_id: &str,
    validation_command: &str,
) -> KaifuuResult<MvMzEncryptedAudioEntryReport> {
    let mut findings = Vec::new();

    // (0) Unsupported surface short-circuits BEFORE any byte is touched: image
    // and JSON surfaces are outside this audio-only path.
    if entry.surface_codec != CodecTransform::OggAudio {
        findings.push(finding(
            FINDING_UNSUPPORTED_SURFACE,
            "surfaceCodec",
            format!(
                "surface codec {:?} is not an OGG audio surface; image and JSON surfaces are outside this path",
                entry.surface_codec
            ),
            SEMANTIC_MV_MZ_AUDIO_UNSUPPORTED_SURFACE,
        ));
        return Ok(finalize_entry(
            entry,
            source_node_id,
            path_id,
            validation_command,
            MvMzEncryptedAudioOutcome::UnsupportedSurface,
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
            SEMANTIC_MV_MZ_AUDIO_MISSING_KEY,
        ));
        return Ok(finalize_entry(
            entry,
            source_node_id,
            path_id,
            validation_command,
            MvMzEncryptedAudioOutcome::MissingKey,
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
                format!("asset is not a well-formed RPGMV-header encrypted audio asset: {error:?}"),
                SEMANTIC_MV_MZ_AUDIO_UNSUPPORTED_VARIANT,
            ));
            return Ok(finalize_entry(
                entry,
                source_node_id,
                path_id,
                validation_command,
                MvMzEncryptedAudioOutcome::UnsupportedVariant,
                None,
                findings,
            ));
        }
    };

    // (3) Wrong-key gate: a correctly-decrypted RPG Maker audio asset is an OGG.
    // A decrypt that does not yield the OGG capture pattern is a wrong key —
    // fail BEFORE re-encrypting (no patch write).
    if !is_ogg(&plaintext) {
        findings.push(finding(
            FINDING_WRONG_KEY,
            "secretRef",
            "candidate key did not decrypt the asset to a valid OGG; no re-encryption performed"
                .to_string(),
            SEMANTIC_MV_MZ_AUDIO_WRONG_KEY,
        ));
        return Ok(finalize_entry(
            entry,
            source_node_id,
            path_id,
            validation_command,
            MvMzEncryptedAudioOutcome::WrongKey,
            None,
            findings,
        ));
    }

    // (4) Re-encrypt (the patch write) and prove byte-correctness.
    let reencrypted = encrypt_rpgmaker_asset(&plaintext, &key);
    let encrypted_source_hash = ProofHash::new(sha256_hash_bytes(&encrypted))?;
    let reencrypted_hash = ProofHash::new(sha256_hash_bytes(&reencrypted))?;
    let byte_correct = reencrypted == encrypted;
    let proof = MvMzAudioRoundTripProof {
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
            SEMANTIC_MV_MZ_AUDIO_UNSUPPORTED_VARIANT,
        ));
        return Ok(finalize_entry(
            entry,
            source_node_id,
            path_id,
            validation_command,
            MvMzEncryptedAudioOutcome::UnsupportedVariant,
            None,
            findings,
        ));
    }

    Ok(finalize_entry(
        entry,
        source_node_id,
        path_id,
        validation_command,
        MvMzEncryptedAudioOutcome::RoundTripped,
        Some(proof),
        findings,
    ))
}

// reason: single cohesive entry-finalize over distinct MV/MZ header fields; a params struct would only relocate the arity.
#[allow(clippy::too_many_arguments)]
fn finalize_entry(
    entry: &MvMzEncryptedAudioFixtureEntry,
    source_node_id: &str,
    path_id: &str,
    validation_command: &str,
    outcome: MvMzEncryptedAudioOutcome,
    proof: Option<MvMzAudioRoundTripProof>,
    mut findings: Vec<MvMzEncryptedAudioFinding>,
) -> MvMzEncryptedAudioEntryReport {
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
            SEMANTIC_MV_MZ_AUDIO_UNSUPPORTED_VARIANT,
        ));
    }

    let round_tripped = outcome == MvMzEncryptedAudioOutcome::RoundTripped;
    // Belt-and-braces: a proof may exist ONLY for a round-tripped outcome.
    let proof = if round_tripped { proof } else { None };

    let status = if outcome_matches && !findings.iter().any(|finding| forces_failure(&finding.code))
    {
        OperationStatus::Passed
    } else {
        OperationStatus::Failed
    };

    MvMzEncryptedAudioEntryReport {
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
) -> MvMzEncryptedAudioFinding {
    MvMzEncryptedAudioFinding {
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
        .map_or_else(|| "encrypted-audio.json".to_string(), ToString::to_string)
}


