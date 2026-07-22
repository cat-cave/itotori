use super::*;

pub(super) fn stage_order(stage: ContractStage) -> usize {
    CONTRACT_SCAFFOLD_STAGES
        .iter()
        .position(|candidate| *candidate == stage)
        .unwrap_or(usize::MAX)
}

pub(super) fn run_stage(
    stage: ContractStage,
    body: impl FnOnce() -> StageResult,
) -> ContractStageOutcome {
    match body() {
        Ok(detail) => ContractStageOutcome::passed(stage, detail),
        Err(drift) => ContractStageOutcome::failed(stage, drift),
    }
}

pub(super) fn stage_detect(fixture: &ScaffoldFixture, fixture_dir: &Path) -> StageResult {
    // Encrypted envelope: routes to the encrypted variant with a satisfied
    // crypt profile, and the detector flags the unsupported encrypted variant.
    let encrypted_fixture = Xp3ProfileProofFixture {
        schema_version: "0.1.0".to_string(),
        fixture_id: format!("{}-encrypted-detect", fixture.fixture_id),
        profile_id: "019ed000-0000-7000-8000-000000171001".to_string(),
        archive: Xp3ProfileProofFixtureArchive {
            archive_id: fixture.encrypted_envelope.archive_id.clone(),
            path: fixture.encrypted_envelope.path.clone(),
        },
        expected_classification: Xp3ProfileClassification::Encrypted,
        patch_capability_level: Xp3PatchCapabilityLevel::Unsupported,
        crypt_profile: Some(Xp3ProfileProofFixtureCryptProfile {
            crypt_profile_id: fixture.crypt_profile.crypt_profile_id.clone(),
            key_ref_requirement: Some(Xp3ProfileProofFixtureKeyRefRequirement {
                requirement_id: fixture
                    .crypt_profile
                    .key_ref_requirement
                    .requirement_id
                    .clone(),
                secret_ref: parse_secret_ref(
                    &fixture.crypt_profile.key_ref_requirement.secret_ref,
                )?,
            }),
        }),
    };
    let encrypted_report = xp3_profile_proof(Xp3ProfileProofRequest {
        fixture: &encrypted_fixture,
        fixture_dir,
    })
    .map_err(|error| StageDrift::drift(format!("encrypted detect proof errored: {error}")))?;

    if encrypted_report.classification != Xp3ProfileClassification::Encrypted {
        return Err(StageDrift::drift(format!(
            "encrypted envelope classified as {} (expected encrypted)",
            encrypted_report.classification.as_str()
        )));
    }
    // The descriptor's declared classification must match what the detector
    // actually routes — a mismatch is fixture/contract drift.
    if encrypted_report.classification.as_str()
        != fixture.encrypted_envelope.expected_classification
    {
        return Err(StageDrift::drift(format!(
            "encrypted envelope detector routed {} but the fixture declares {}",
            encrypted_report.classification.as_str(),
            fixture.encrypted_envelope.expected_classification
        )));
    }
    if encrypted_report.crypt_profile.status != Xp3CryptProfileStatus::Satisfied {
        return Err(StageDrift::drift(format!(
            "encrypted envelope crypt profile status is {} (expected satisfied)",
            encrypted_report.crypt_profile.status.as_str()
        )));
    }
    let flags_encrypted = encrypted_report.diagnostics.iter().any(|diagnostic| {
        diagnostic.semantic_code.as_deref()
            == Some(kaifuu_core::SEMANTIC_UNSUPPORTED_VARIANT_ENCRYPTED)
    });
    if !flags_encrypted {
        return Err(StageDrift::drift(
            "detector no longer flags the encrypted variant as unsupported",
        ));
    }

    // Decrypted inner: a real plain XP3 the later stages can patch back.
    let plain_fixture = Xp3ProfileProofFixture {
        schema_version: "0.1.0".to_string(),
        fixture_id: format!("{}-plain-detect", fixture.fixture_id),
        profile_id: "019ed000-0000-7000-8000-000000171002".to_string(),
        archive: Xp3ProfileProofFixtureArchive {
            archive_id: fixture.decrypted_inner.archive_id.clone(),
            path: fixture.decrypted_inner.path.clone(),
        },
        expected_classification: Xp3ProfileClassification::Plain,
        patch_capability_level: Xp3PatchCapabilityLevel::PatchBack,
        crypt_profile: None,
    };
    let plain_report = xp3_profile_proof(Xp3ProfileProofRequest {
        fixture: &plain_fixture,
        fixture_dir,
    })
    .map_err(|error| StageDrift::drift(format!("plain detect proof errored: {error}")))?;
    if plain_report.classification != Xp3ProfileClassification::Plain {
        return Err(StageDrift::drift(format!(
            "decrypted inner classified as {} (expected plain)",
            plain_report.classification.as_str()
        )));
    }
    if plain_report.patch_capability_level != Xp3PatchCapabilityLevel::PatchBack {
        return Err(StageDrift::drift(format!(
            "decrypted inner patch capability is {} (expected patch_back)",
            plain_report.patch_capability_level.as_str()
        )));
    }
    if plain_report.classification.as_str() != fixture.decrypted_inner.expected_classification {
        return Err(StageDrift::drift(format!(
            "decrypted inner detector routed {} but the fixture declares {}",
            plain_report.classification.as_str(),
            fixture.decrypted_inner.expected_classification
        )));
    }

    Ok(format!(
        "envelope=encrypted(crypt_profile=satisfied); inner=plain(patch_back); archive_hash={}",
        plain_report.archive.archive_hash.as_str()
    ))
}

pub(super) fn stage_key_resolution(fixture: &ScaffoldFixture, fixture_dir: &Path) -> StageResult {
    let requirement_id = fixture
        .crypt_profile
        .key_ref_requirement
        .requirement_id
        .clone();
    let secret_ref = parse_secret_ref(&fixture.crypt_profile.key_ref_requirement.secret_ref)?;
    let kind = parse_material_kind(&fixture.crypt_profile.key_ref_requirement.material_kind)?;

    // Resolve the fixture-only key from the committed public key manifest.
    let manifest: PublicKeyManifest = read_json(&fixture_dir.join(&fixture.key_manifest_path))
        .map_err(|error| StageDrift::drift(format!("public key manifest unreadable: {error}")))?;
    let key = manifest
        .keys
        .iter()
        .find(|entry| entry.requirement_id == requirement_id)
        .ok_or_else(|| {
            StageDrift::drift(format!(
                "key manifest declares no key for requirement `{requirement_id}`"
            ))
        })?;

    // Seed a fixture-CI secret store and resolve through the published local
    // key resolver — the same contract the rpg-maker / siglus key lanes use.
    let store = InMemoryLocalSecretStore::new().with_secret(
        secret_ref.name(),
        key.public_key_material.as_bytes().to_vec(),
    );
    let resolver = LocalKeyResolver::new(store);
    let requirement = KeyRequirement {
        requirement_id: requirement_id.clone(),
        secret_ref,
        kind,
        bytes: None,
        validation: None,
    };
    let resolved = resolver
        .resolve_requirements(std::slice::from_ref(&requirement), None)
        .map_err(|error| {
            StageDrift::semantic(
                kaifuu_core::SEMANTIC_MISSING_KEY_MATERIAL,
                format!("key resolution failed: {error}"),
            )
        })?;
    let byte_len = resolved
        .get_bytes(&requirement_id)
        .ok_or_else(|| {
            StageDrift::semantic(
                kaifuu_core::SEMANTIC_MISSING_KEY_MATERIAL,
                format!("resolver returned no material for `{requirement_id}`"),
            )
        })?
        .len();
    if byte_len == 0 {
        return Err(StageDrift::semantic(
            kaifuu_core::SEMANTIC_MISSING_KEY_MATERIAL,
            "resolved key material is empty",
        ));
    }

    Ok(format!(
        "resolved requirement `{requirement_id}` (fixture-only key, byte_len={byte_len})"
    ))
}

pub(super) fn stage_extract(
    inner_bytes: &[u8],
    original_dir: &Path,
    patched_dir: &Path,
) -> StageResult {
    // Unpack twice: an immutable original baseline and a working copy the
    // patch stage mutates. Both go through the published unpacker.
    let original = unpack_plain_xp3_to_directory(inner_bytes, original_dir)
        .map_err(writer_drift("extract (original)"))?;
    let working = unpack_plain_xp3_to_directory(inner_bytes, patched_dir)
        .map_err(writer_drift("extract (working copy)"))?;
    if original.entries.is_empty() {
        return Err(StageDrift::drift("extract produced zero entries"));
    }
    if original.entries.len() != working.entries.len() {
        return Err(StageDrift::drift(
            "extract produced inconsistent entry counts across copies",
        ));
    }
    Ok(format!(
        "unpacked {} entr{} to original + working copies",
        original.entries.len(),
        if original.entries.len() == 1 {
            "y"
        } else {
            "ies"
        }
    ))
}

pub(super) fn stage_patch(
    fixture: &ScaffoldFixture,
    inner_bytes: &[u8],
    patched_dir: &Path,
) -> StageResult {
    let replacement = fixture.patch.replacement_utf8.as_bytes();
    let manifest =
        replace_plain_xp3_entry_payload(patched_dir, &fixture.patch.entry_path, replacement)
            .map_err(writer_drift("patch (replace entry)"))?;
    if !manifest
        .entries
        .iter()
        .any(|entry| entry.path == fixture.patch.entry_path)
    {
        return Err(StageDrift::drift(format!(
            "patched entry `{}` vanished from the manifest",
            fixture.patch.entry_path
        )));
    }
    let patched_archive =
        pack_plain_xp3_from_directory(patched_dir).map_err(writer_drift("patch (repack)"))?;
    if patched_archive == inner_bytes {
        return Err(StageDrift::drift(
            "patched archive is byte-identical to the source — the patch had no effect",
        ));
    }
    Ok(format!(
        "replaced `{}` and repacked ({} source bytes -> {} patched bytes)",
        fixture.patch.entry_path,
        inner_bytes.len(),
        patched_archive.len()
    ))
}

pub(super) fn stage_verify(
    fixture: &ScaffoldFixture,
    inner_bytes: &[u8],
    patched_dir: &Path,
) -> StageResult {
    // Determinism: the source archive must re-encode byte-identically.
    let source_archive =
        read_plain_xp3_archive(inner_bytes).map_err(writer_drift("verify (read source)"))?;
    let reencoded = encode_xp3(&source_archive).map_err(writer_drift("verify (encode source)"))?;
    if reencoded != inner_bytes {
        return Err(StageDrift::drift(
            "source archive did not re-encode byte-identically (determinism violation)",
        ));
    }

    // Round-trip: the patched archive must re-read and carry the new payload.
    let patched_archive = pack_plain_xp3_from_directory(patched_dir)
        .map_err(writer_drift("verify (repack patched)"))?;
    let patched =
        read_plain_xp3_archive(&patched_archive).map_err(writer_drift("verify (read patched)"))?;
    let patched_entry = patched
        .entries
        .iter()
        .find(|entry| entry.path == fixture.patch.entry_path)
        .ok_or_else(|| {
            StageDrift::drift(format!(
                "verify could not find patched entry `{}`",
                fixture.patch.entry_path
            ))
        })?;
    if patched_entry.payload != fixture.patch.replacement_utf8.as_bytes() {
        return Err(StageDrift::drift(
            "verify found the patched entry payload did not match the replacement",
        ));
    }
    Ok(format!(
        "source re-encode byte-identical; patched entry `{}` carries the replacement",
        fixture.patch.entry_path
    ))
}

pub(super) fn stage_delta_apply(
    original_dir: &Path,
    patched_dir: &Path,
    work_dir: &Path,
) -> StageResult {
    let delta = create_delta(original_dir, patched_dir, SourceProvenance::complete())
        .map_err(|error| StageDrift::drift(format!("create_delta failed: {error}")))?;
    let delta_path = work_dir.join("contract-scaffold.delta.json");
    fs::write(&delta_path, format!("{delta:#}"))
        .map_err(|error| StageDrift::drift(format!("could not persist delta package: {error}")))?;

    let applied_dir = work_dir.join("applied");
    apply_delta(original_dir, &delta_path, &applied_dir)
        .map_err(|error| StageDrift::drift(format!("apply_delta failed: {error}")))?;

    // The applied directory must repack to the exact patched archive bytes.
    let applied_archive = pack_plain_xp3_from_directory(&applied_dir)
        .map_err(writer_drift("delta_apply (repack applied)"))?;
    let patched_archive = pack_plain_xp3_from_directory(patched_dir)
        .map_err(writer_drift("delta_apply (repack patched)"))?;
    if applied_archive != patched_archive {
        return Err(StageDrift::drift(
            "delta-applied archive did not match the patched archive (round-trip violation)",
        ));
    }
    Ok(format!(
        "delta applied; repacked {} bytes match the patched archive",
        applied_archive.len()
    ))
}

fn writer_drift(
    context: &'static str,
) -> impl FnOnce(kaifuu_core::PlainXp3WriterError) -> StageDrift {
    move |error| StageDrift::semantic(error.semantic_code(), format!("{context}: {error}"))
}

fn parse_secret_ref(value: &str) -> Result<SecretRef, StageDrift> {
    SecretRef::new(value.to_string())
        .map_err(|error| StageDrift::drift(format!("malformed secretRef: {error}")))
}

fn parse_material_kind(value: &str) -> Result<KeyMaterialKind, StageDrift> {
    serde_json::from_value::<KeyMaterialKind>(serde_json::Value::String(value.to_string()))
        .map_err(|error| StageDrift::drift(format!("unknown materialKind `{value}`: {error}")))
}

pub(super) fn read_json<T: serde::de::DeserializeOwned>(path: &Path) -> KaifuuResult<T> {
    let bytes = fs::read(path).map_err(|error| format!("read {}: {error}", path.display()))?;
    Ok(serde_json::from_slice(&bytes)?)
}
