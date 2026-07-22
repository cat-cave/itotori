use super::*;

/// Run the full XP3 crypt-chain smoke: detect the container by magic-byte
/// signature, resolve the crypt profile + key through the keyRef, extract +
/// integrity-verify every member, apply the trivial replacement manifest,
/// rebuild + verify against the declared profile + secret requirement id, and
/// emit a redacted delta package. Returns a redactable report whose stage ledger
/// proves every stage ran, in order.
pub fn run_xp3_crypt_chain_smoke_from_fixture(
    fixture: &Xp3CryptFixture,
    manifest: &Xp3PatchManifest,
    fixture_dir: &Path,
) -> Result<Xp3CryptChainReport, Xp3ChainError> {
    // (0) Resolve the source encrypted container bytes in-process (no shell-out).
    let container = resolve_container_bytes(&fixture.container_source, fixture_dir)?;

    // (1) DETECT the engine/container by magic-byte signature.
    let detect = detect_xp3_container(&container, fixture.crypto_profile)?;

    // The crypt scheme is DATA: the declared profile selects the byte transform.
    let scheme = fixture.crypto_profile.scheme();

    // (2) PROFILE/KEY RESOLVE through the keyRef-bound crypt profile.
    let resolver = FixtureSecretResolver::fixture_default();
    let key = resolver.resolve(&fixture.secret_requirement_id, &fixture.secret_ref)?;
    let profile_resolve = Xp3ChainProfileResolveReport {
        secret_requirement_id: fixture.secret_requirement_id.clone(),
        secret_ref: fixture.secret_ref.clone(),
        crypto_profile: fixture.crypto_profile,
        key_material_hash: key.material_hash()?,
        key_bytes: u32::try_from(key.byte_len()).unwrap_or(u32::MAX),
        key_material_kind: KeyMaterialKind::FixedBytes,
        resolved: true,
    };

    // (3) EXTRACT: decrypt + integrity-verify every member (hash-based manifest).
    let extract = decrypt_and_extract(&container, key, scheme)?;
    let extract_manifest: Vec<Xp3CryptMemberDigest> = extract
        .members
        .iter()
        .map(|member| Xp3CryptMemberDigest {
            member_id: member.member_id.clone(),
            plaintext_byte_len: member.plaintext_byte_len,
            plaintext_hash: member.plaintext_hash.clone(),
            adler32: member.adler32.clone(),
        })
        .collect();

    // (4-6) PATCH -> REBUILD -> VERIFY via the proven patch-back path
    // (extract through the declared secret ref, apply the trivial change,
    // repack, re-decrypt + verify against the declared profile + secret
    // requirement id, and prove the identity rebuild is byte-identical).
    let patch_back = run_xp3_patch_smoke_from_fixture(fixture, manifest, fixture_dir)?;

    // (7) DELTA: recompute the source + patched plaintexts and the rebuilt
    // container through the SAME deterministic primitives, then emit a
    // redacted, hash-based delta package (secret refs only).
    let source_pairs: Vec<(String, Vec<u8>)> = decrypt_members(&container, key, scheme)?
        .into_iter()
        .map(|member| (member.member_id, member.plaintext))
        .collect();
    let (patched_pairs, _changed_ids) = apply_replacements(&source_pairs, manifest)?;
    let rebuilt = encode_encrypted_xp3(&patched_pairs, key, scheme);
    let delta = build_delta_evidence(&container, &rebuilt, &source_pairs, &patched_pairs, fixture)?;

    // The stage ledger: every stage ran, in order.
    let stages = build_stage_ledger(&detect, &extract_manifest, &patch_back, &delta);

    let report = Xp3CryptChainReport {
        schema_version: XP3_CHAIN_SCHEMA_VERSION.to_string(),
        capability_id: XP3_CHAIN_CAPABILITY_ID.to_string(),
        source_node_id: XP3_CHAIN_SOURCE_ID.to_string(),
        support_boundary: XP3_CHAIN_SUPPORT_BOUNDARY.to_string(),
        fixture_id: fixture.fixture_id.clone(),
        manifest_id: manifest.manifest_id.clone(),
        engine_family: fixture.engine_family.clone(),
        container: fixture.container.clone(),
        redaction_status: HelperRedactionStatus::Redacted,
        stages,
        detect,
        profile_resolve,
        extract_manifest,
        patch_back,
        delta,
        status: OperationStatus::Passed,
    };

    // Runtime no-leak guard: the serialized (redacted) report must never carry
    // the raw key material, whether verbatim or hex/base64-encoded. Hard
    // refusal, not just a test-time check.
    let json = report
        .stable_json()
        .map_err(|error| Xp3ChainError::Internal {
            message: error.to_string(),
        })?;
    if key.appears_in(json.as_bytes()) {
        return Err(Xp3ChainError::Internal {
            message: "refusing to emit a report that leaks raw key material".to_string(),
        });
    }

    Ok(report)
}

/// Convenience wrapper: read the fixture JSON + trivial replacement manifest
/// JSON and run the chain smoke against the fixture's directory.
pub fn run_xp3_crypt_chain_smoke_from_paths(
    fixture_path: &Path,
    manifest_path: &Path,
) -> Result<Xp3CryptChainReport, Xp3ChainError> {
    let fixture: Xp3CryptFixture =
        kaifuu_core::read_json(fixture_path).map_err(|error| Xp3ChainError::Internal {
            message: error.to_string(),
        })?;
    let manifest: Xp3PatchManifest =
        kaifuu_core::read_json(manifest_path).map_err(|error| Xp3ChainError::Internal {
            message: error.to_string(),
        })?;
    let fixture_dir = fixture_path
        .parent()
        .ok_or_else(|| Xp3ChainError::Internal {
            message: "fixture path must have a parent directory".to_string(),
        })?;
    run_xp3_crypt_chain_smoke_from_fixture(&fixture, &manifest, fixture_dir)
}

/// Build the per-member delta entries + package from the source and patched
/// plaintexts and the source / rebuilt encrypted containers.
fn build_delta_evidence(
    source_container: &[u8],
    rebuilt_container: &[u8],
    source_pairs: &[(String, Vec<u8>)],
    patched_pairs: &[(String, Vec<u8>)],
    fixture: &Xp3CryptFixture,
) -> Result<Xp3ChainDeltaEvidence, Xp3ChainError> {
    let mut members = Vec::with_capacity(source_pairs.len());
    let mut members_changed = 0u32;
    let mut members_unchanged = 0u32;
    let mut proof_material = Vec::new();

    for (member_id, source_plain) in source_pairs {
        let target_plain = patched_pairs
            .iter()
            .find(|(id, _)| id == member_id)
            .map(|(_, plain)| plain)
            .ok_or_else(|| Xp3ChainError::Internal {
                message: "patched member set dropped a source member".to_string(),
            })?;
        let source_plaintext_hash = proof_hash(source_plain)?;
        let target_plaintext_hash = proof_hash(target_plain)?;
        let operation = if source_plaintext_hash.as_str() == target_plaintext_hash.as_str() {
            members_unchanged += 1;
            Xp3ChainDeltaOperation::Unchanged
        } else {
            members_changed += 1;
            Xp3ChainDeltaOperation::Replace
        };
        proof_material.extend_from_slice(member_id.as_bytes());
        proof_material.extend_from_slice(source_plaintext_hash.as_str().as_bytes());
        proof_material.extend_from_slice(target_plaintext_hash.as_str().as_bytes());
        members.push(Xp3ChainDeltaMember {
            member_id: member_id.clone(),
            operation,
            source_plaintext_hash,
            source_byte_len: source_plain.len() as u64,
            target_plaintext_hash,
            target_byte_len: target_plain.len() as u64,
            length_delta: target_plain.len() as i64 - source_plain.len() as i64,
        });
    }

    let delta_proof = KeyValidationProof {
        method: KeyValidationMethod::FixtureRoundTripProof,
        proof_hash: proof_hash(&proof_material)?,
    };

    Ok(Xp3ChainDeltaEvidence {
        schema_version: XP3_CHAIN_SCHEMA_VERSION.to_string(),
        delta_package_id: deterministic_id("kaifuu-xp3-crypt-delta", 1),
        format: XP3_CHAIN_DELTA_FORMAT.to_string(),
        secret_requirement_id: fixture.secret_requirement_id.clone(),
        secret_ref: fixture.secret_ref.clone(),
        redaction_status: HelperRedactionStatus::Redacted,
        source_container_hash: proof_hash(source_container)?,
        source_container_bytes: source_container.len() as u64,
        rebuilt_container_hash: proof_hash(rebuilt_container)?,
        rebuilt_container_bytes: rebuilt_container.len() as u64,
        members,
        members_changed,
        members_unchanged,
        delta_proof,
    })
}

/// Build the ordered stage ledger with a short (redactable) detail per stage.
fn build_stage_ledger(
    detect: &Xp3ChainDetectReport,
    extract_manifest: &[Xp3CryptMemberDigest],
    patch_back: &Xp3PatchReport,
    delta: &Xp3ChainDeltaEvidence,
) -> Vec<Xp3ChainStageOutcome> {
    let passed = |stage: Xp3ChainStage, detail: String| Xp3ChainStageOutcome {
        stage,
        status: OperationStatus::Passed,
        detail,
    };
    vec![
        passed(
            Xp3ChainStage::Detect,
            format!(
                "{} container detected by {}",
                detect.container, detect.detected_by
            ),
        ),
        passed(
            Xp3ChainStage::ProfileResolve,
            format!("crypt profile {} key resolved via keyRef", {
                detect.crypto_profile.as_str()
            }),
        ),
        passed(
            Xp3ChainStage::Extract,
            format!("{} members decrypted + integrity-verified", {
                extract_manifest.len()
            }),
        ),
        passed(
            Xp3ChainStage::Patch,
            format!(
                "{} replacement(s) applied",
                patch_back.capability.coverage.replacements_applied
            ),
        ),
        passed(
            Xp3ChainStage::Rebuild,
            format!(
                "repacked (patch-back mode {:?})",
                patch_back.capability.patch_back_mode
            ),
        ),
        passed(
            Xp3ChainStage::Verify,
            format!(
                "re-decrypt verified against declared secret requirement id (byte-identical identity={})",
                patch_back.identity.byte_identical
            ),
        ),
        passed(
            Xp3ChainStage::Delta,
            format!(
                "delta package: {} changed, {} unchanged",
                delta.members_changed, delta.members_unchanged
            ),
        ),
    ]
}
