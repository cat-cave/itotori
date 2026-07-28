use super::*;

/// Run the full XP3-crypt smoke from a fixture manifest: resolve the container,
/// resolve the valid secret ref → key, decrypt + extract + verify integrity,
/// then prove the wrong-key and missing-key failure modes are typed errors.
/// Returns a redactable report.
pub fn run_xp3_crypt_smoke_from_fixture(
    fixture: &Xp3CryptFixture,
    fixture_dir: &Path,
) -> Result<Xp3CryptReport, Xp3CryptError> {
    // Declared field sanity: the fixture must match this profile's engine /
    // container, or it is not a valid input for this smoke.
    if fixture.engine_family != XP3_CRYPT_ENGINE_FAMILY {
        return Err(Xp3CryptError::ExpectationMismatch {
            detail: format!(
                "engine_family {} is not {XP3_CRYPT_ENGINE_FAMILY}",
                fixture.engine_family
            ),
        });
    }
    if fixture.container != XP3_CRYPT_CONTAINER {
        return Err(Xp3CryptError::ExpectationMismatch {
            detail: format!(
                "container {} is not {XP3_CRYPT_CONTAINER}",
                fixture.container
            ),
        });
    }

    let container = resolve_container_bytes(&fixture.container_source, fixture_dir)?;
    let container_hash = ProofHash::new(sha256_hash_bytes(&container))
        .map_err(|message| Xp3CryptError::Internal { message })?;

    let resolver = FixtureSecretResolver::fixture_default();

    // The crypt scheme is DATA: the declared profile selects the byte transform.
    let scheme = fixture.crypto_profile.scheme();

    // (1) Valid secret ref → key → decrypt + extract + verify integrity.
    let key = resolver.resolve(&fixture.secret_requirement_id, &fixture.secret_ref)?;
    let manifest = decrypt_and_extract(&container, key, scheme)?;

    // Declared expectation: the decrypted member set matches.
    let extracted_ids: Vec<&str> = manifest
        .members
        .iter()
        .map(|member| member.member_id.as_str())
        .collect();
    if extracted_ids != fixture.expected_member_ids {
        return Err(Xp3CryptError::ExpectationMismatch {
            detail: "extracted member set did not match declared expected_member_ids".to_string(),
        });
    }

    // (2) Wrong-key probe: a resolvable-but-wrong ref must trip the integrity
    // check with a typed error citing the first member.
    let wrong_ref = SecretRef::new(XP3_CRYPT_WRONG_SECRET_REF)
        .map_err(|message| Xp3CryptError::Internal { message })?;
    let wrong_key = resolver.resolve(&fixture.secret_requirement_id, &wrong_ref)?;
    let wrong_key_report = match decrypt_and_extract(&container, wrong_key, scheme) {
        Err(Xp3CryptError::IntegrityCheckFailed { member_id }) => Xp3CryptWrongKeyReport {
            attempted_secret_ref: wrong_ref,
            typed_error: true,
            diagnostic_code: format!("{XP3_CRYPT_MARKER}.integrity_check_failed"),
            member_id: Some(member_id),
        },
        Err(other) => {
            return Err(Xp3CryptError::ExpectationMismatch {
                detail: format!("wrong key produced the wrong error: {other}"),
            });
        }
        Ok(_) => {
            return Err(Xp3CryptError::ExpectationMismatch {
                detail: "wrong key was silently accepted".to_string(),
            });
        }
    };

    // (3) Missing-key probe: an unknown ref must fail resolution with a typed
    // error, before any decrypt.
    let missing_ref = SecretRef::new(XP3_CRYPT_MISSING_SECRET_REF)
        .map_err(|message| Xp3CryptError::Internal { message })?;
    let missing_key_report = match resolver.resolve(&fixture.secret_requirement_id, &missing_ref) {
        Err(Xp3CryptError::MissingSecret { requirement_id, .. }) => Xp3CryptMissingKeyReport {
            attempted_requirement_id: requirement_id,
            typed_error: true,
            diagnostic_code: format!("{XP3_CRYPT_MARKER}.missing_secret"),
        },
        Err(other) => {
            return Err(Xp3CryptError::ExpectationMismatch {
                detail: format!("missing key produced the wrong error: {other}"),
            });
        }
        Ok(_) => {
            return Err(Xp3CryptError::ExpectationMismatch {
                detail: "missing key ref resolved to material".to_string(),
            });
        }
    };

    // (4) Assemble the report (counts + one-way commitments only).
    let manifest_digests: Vec<Xp3CryptMemberDigest> = manifest
        .members
        .iter()
        .map(|member| Xp3CryptMemberDigest {
            member_id: member.member_id.clone(),
            plaintext_byte_len: member.plaintext_byte_len,
            plaintext_hash: member.plaintext_hash.clone(),
            adler32: member.adler32.clone(),
        })
        .collect();

    // decrypt proof: a hash over the concatenated member plaintext commitments
    // (proves the decrypt produced this exact manifest).
    let mut proof_material = Vec::new();
    for member in &manifest.members {
        proof_material.extend_from_slice(member.member_id.as_bytes());
        proof_material.extend_from_slice(member.plaintext_hash.as_str().as_bytes());
    }
    let decrypt_proof = KeyValidationProof {
        method: KeyValidationMethod::DecryptHeaderProof,
        proof_hash: ProofHash::new(sha256_hash_bytes(&proof_material))
            .map_err(|message| Xp3CryptError::Internal { message })?,
    };

    let report = Xp3CryptReport {
        schema_version: XP3_CRYPT_SCHEMA_VERSION.to_string(),
        capability_id: XP3_CRYPT_CAPABILITY_ID.to_string(),
        source_node_id: fixture.source_node_id.clone(),
        support_boundary: XP3_CRYPT_SUPPORT_BOUNDARY.to_string(),
        fixture_id: fixture.fixture_id.clone(),
        engine_family: fixture.engine_family.clone(),
        container: fixture.container.clone(),
        crypto_profile: fixture.crypto_profile,
        codec: fixture.codec,
        surface: fixture.surface,
        secret_requirement_id: fixture.secret_requirement_id.clone(),
        secret_ref: fixture.secret_ref.clone(),
        key_material_hash: key.material_hash()?,
        key_bytes: u32::try_from(key.byte_len()).unwrap_or(u32::MAX),
        key_material_kind: KeyMaterialKind::FixedBytes,
        redaction_status: HelperRedactionStatus::Redacted,
        container_hash,
        manifest: manifest_digests,
        decrypt_proof,
        wrong_key: wrong_key_report,
        missing_key: missing_key_report,
        status: OperationStatus::Passed,
    };

    // Runtime no-leak guard: the serialized (redacted) report must never carry
    // the raw key material. This is a hard refusal, not just a test-time check.
    let json = report
        .stable_json()
        .map_err(|error| Xp3CryptError::Internal {
            message: error.to_string(),
        })?;
    if key.appears_in(json.as_bytes()) || wrong_key.appears_in(json.as_bytes()) {
        return Err(Xp3CryptError::Internal {
            message: "refusing to emit a report that leaks raw key material".to_string(),
        });
    }

    Ok(report)
}

/// Convenience wrapper: read the fixture JSON at `fixture_path` and run the
/// smoke against the fixture's directory.
pub fn run_xp3_crypt_smoke_from_path(fixture_path: &Path) -> Result<Xp3CryptReport, Xp3CryptError> {
    let fixture: Xp3CryptFixture =
        read_json(fixture_path).map_err(|error| Xp3CryptError::Internal {
            message: error.to_string(),
        })?;
    let fixture_dir = fixture_path
        .parent()
        .ok_or_else(|| Xp3CryptError::Internal {
            message: "fixture path must have a parent directory".to_string(),
        })?;
    run_xp3_crypt_smoke_from_fixture(&fixture, fixture_dir)
}
