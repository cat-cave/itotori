use super::*;

/// One decrypted member as `(member id, plaintext bytes)`.
type MemberPlaintext = (String, Vec<u8>);

/// Apply the manifest's replacements to the decrypted member plaintexts,
/// returning the patched plaintexts and the count of members changed. Each
/// replacement's `find` must occur exactly once in its target member.
pub(crate) fn apply_replacements(
    members: &[MemberPlaintext],
    manifest: &Xp3PatchManifest,
) -> Result<(Vec<MemberPlaintext>, Vec<String>), Xp3PatchError> {
    let mut patched: Vec<MemberPlaintext> = members.to_vec();
    let mut changed_ids: Vec<String> = Vec::new();
    for replacement in &manifest.replacements {
        let entry = patched
            .iter_mut()
            .find(|(id, _)| id == &replacement.member_id)
            .ok_or_else(|| Xp3PatchError::UnknownMember {
                member_id: replacement.member_id.clone(),
            })?;
        let text = String::from_utf8(entry.1.clone()).map_err(|_| Xp3PatchError::Internal {
            message: "fixture member was not valid utf-8".to_string(),
        })?;
        let occurrences = text.matches(&replacement.find).count();
        if occurrences != 1 {
            return Err(Xp3PatchError::ReplacementNotApplicable {
                member_id: replacement.member_id.clone(),
                occurrences,
            });
        }
        let new_text = text.replacen(&replacement.find, &replacement.replace, 1);
        entry.1 = new_text.into_bytes();
        if !changed_ids.contains(&replacement.member_id) {
            changed_ids.push(replacement.member_id.clone());
        }
    }
    Ok((patched, changed_ids))
}

/// Run the full XP3 patch-back smoke: decrypt the fixture through the declared
/// secret ref, prove the identity rebuild is byte-identical, apply the trivial
/// replacement manifest, repack, and verify the patched output against the
/// declared fixture profile + secret requirement id. Returns a redactable
/// report.
pub fn run_xp3_patch_smoke_from_fixture(
    fixture: &Xp3CryptFixture,
    manifest: &Xp3PatchManifest,
    fixture_dir: &Path,
) -> Result<Xp3PatchReport, Xp3PatchError> {
    // The patch-back mode this fixture declares + exercises: a length-changing
    // localization forces a full archive repack.
    let patch_back_mode = PatchBackTransform::RepackArchive;

    // The crypt scheme is DATA: the declared profile selects the byte transform.
    let scheme = fixture.crypto_profile.scheme();

    // (0) Resolve the source container + the declared secret ref → key.
    let source = resolve_container_bytes(&fixture.container_source, fixture_dir)?;
    let resolver = FixtureSecretResolver::fixture_default();
    let key = resolver.resolve(&fixture.secret_requirement_id, &fixture.secret_ref)?;

    // (1) Decrypt + integrity-verify the source members (the path).
    let source_members: Vec<(String, Vec<u8>)> = decrypt_members(&source, key, scheme)?
        .into_iter()
        .map(|member| (member.member_id, member.plaintext))
        .collect();

    // (2) Identity round-trip: re-encipher + repack with NO change must be
    // byte-identical to the source encrypted container.
    let identity_rebuilt = encode_encrypted_xp3(&source_members, key, scheme);
    let byte_identical = identity_rebuilt == source;
    if !byte_identical {
        return Err(Xp3PatchError::IdentityNotBytePreserving);
    }
    let identity = Xp3PatchIdentityReport {
        byte_identical,
        source_hash: proof_hash(&source)?,
        rebuilt_hash: proof_hash(&identity_rebuilt)?,
        source_bytes: source.len() as u64,
        rebuilt_bytes: identity_rebuilt.len() as u64,
    };

    // (3) Apply the trivial replacement manifest + repack (patch-back).
    let (patched_members, changed_ids) = apply_replacements(&source_members, manifest)?;
    let rebuilt = encode_encrypted_xp3(&patched_members, key, scheme);

    // The fixture declares exactly one changed member for the trivial-change
    // proof.
    let patched_member_id =
        changed_ids
            .first()
            .cloned()
            .ok_or_else(|| Xp3PatchError::VerificationFailed {
                detail: "manifest applied no replacements".to_string(),
            })?;

    // (4) VERIFY against the declared secret requirement id: re-open the rebuilt
    // container and decrypt through the DECLARED secret ref. Integrity must
    // pass for every member against its recomputed adlr.
    let rebuilt_key = resolver.resolve(&fixture.secret_requirement_id, &fixture.secret_ref)?;
    let rebuilt_members: Vec<(String, Vec<u8>)> = decrypt_members(&rebuilt, rebuilt_key, scheme)?
        .into_iter()
        .map(|member| (member.member_id, member.plaintext))
        .collect();

    // (5) VERIFY against the declared fixture profile: engine/container/crypto/
    // surface + the declared expected member set.
    let profile_matched = fixture.engine_family == crate::xp3_crypt::XP3_CRYPT_ENGINE_FAMILY
        && fixture.container == crate::xp3_crypt::XP3_CRYPT_CONTAINER
        && rebuilt_members
            .iter()
            .map(|(id, _)| id.as_str())
            .eq(fixture.expected_member_ids.iter().map(String::as_str));
    if !profile_matched {
        return Err(Xp3PatchError::VerificationFailed {
            detail: "rebuilt output did not match the declared fixture profile".to_string(),
        });
    }

    // (6) Trivial-change proof: locate the patched member in source + rebuilt,
    // confirm the new text is present, the old text is gone, and every other
    // member is byte-identical.
    let replacement = manifest
        .replacements
        .iter()
        .find(|r| r.member_id == patched_member_id)
        .ok_or_else(|| Xp3PatchError::Internal {
            message: "changed member has no manifest replacement".to_string(),
        })?;
    let source_member = find_member(&source_members, &patched_member_id)?;
    let rebuilt_member = find_member(&rebuilt_members, &patched_member_id)?;
    let source_text = String::from_utf8_lossy(source_member);
    let rebuilt_text = String::from_utf8_lossy(rebuilt_member);

    let mut other_members_byte_identical = true;
    for (id, source_plain) in &source_members {
        if id == &patched_member_id {
            continue;
        }
        let rebuilt_plain = find_member(&rebuilt_members, id)?;
        if rebuilt_plain != source_plain.as_slice() {
            other_members_byte_identical = false;
        }
    }

    let patch = Xp3PatchChangeReport {
        member_id: patched_member_id.clone(),
        old_present_in_source: source_text.contains(&replacement.find),
        new_present_in_rebuilt: rebuilt_text.contains(&replacement.replace),
        old_absent_in_rebuilt: !rebuilt_text.contains(&replacement.find),
        length_delta: rebuilt_member.len() as i64 - source_member.len() as i64,
        other_members_byte_identical,
    };
    if !(patch.old_present_in_source
        && patch.new_present_in_rebuilt
        && patch.old_absent_in_rebuilt
        && patch.other_members_byte_identical)
    {
        return Err(Xp3PatchError::VerificationFailed {
            detail: "trivial-change proof did not hold (new text / old text / isolation)"
                .to_string(),
        });
    }

    // (7) The verification manifest (hash-based) + a proof over its member
    // commitments.
    let patched_manifest: Vec<Xp3CryptMemberDigest> = rebuilt_members
        .iter()
        .map(|(id, plaintext)| member_digest_from_plaintext(id, plaintext))
        .collect::<Result<Vec<_>, Xp3CryptError>>()?;
    let mut proof_material = Vec::new();
    for digest in &patched_manifest {
        proof_material.extend_from_slice(digest.member_id.as_bytes());
        proof_material.extend_from_slice(digest.plaintext_hash.as_str().as_bytes());
    }
    let verification = Xp3PatchVerification {
        profile_matched,
        secret_requirement_id: fixture.secret_requirement_id.clone(),
        secret_requirement_verified: true,
        patched_manifest,
        verification_proof: KeyValidationProof {
            method: KeyValidationMethod::DecryptHeaderProof,
            proof_hash: proof_hash(&proof_material)?,
        },
    };

    let total_members = u32::try_from(source_members.len()).unwrap_or(u32::MAX);
    let members_patched = u32::try_from(changed_ids.len()).unwrap_or(u32::MAX);
    let coverage = Xp3PatchCoverage {
        total_members,
        members_patched,
        members_byte_preserved: total_members.saturating_sub(members_patched),
        replacements_applied: u32::try_from(manifest.replacements.len()).unwrap_or(u32::MAX),
    };

    let report = Xp3PatchReport {
        schema_version: XP3_PATCH_SCHEMA_VERSION.to_string(),
        capability_id: XP3_PATCH_CAPABILITY_ID.to_string(),
        source_node_id: manifest.source_node_id.clone(),
        support_boundary: XP3_PATCH_SUPPORT_BOUNDARY.to_string(),
        fixture_id: fixture.fixture_id.clone(),
        manifest_id: manifest.manifest_id.clone(),
        engine_family: fixture.engine_family.clone(),
        container: fixture.container.clone(),
        secret_requirement_id: fixture.secret_requirement_id.clone(),
        secret_ref: fixture.secret_ref.clone(),
        redaction_status: HelperRedactionStatus::Redacted,
        capability: Xp3PatchCapability {
            patch_back_mode,
            crypto_profile: fixture.crypto_profile,
            surface: fixture.surface,
            coverage,
        },
        identity,
        patch,
        verification,
        status: OperationStatus::Passed,
    };

    // Runtime no-leak guard: the serialized (redacted) report must never carry
    // the raw key material.
    let json = report
        .stable_json()
        .map_err(|error| Xp3PatchError::Internal {
            message: error.to_string(),
        })?;
    if key.appears_in(json.as_bytes()) {
        return Err(Xp3PatchError::Internal {
            message: "refusing to emit a report that leaks raw key material".to_string(),
        });
    }

    Ok(report)
}

/// Convenience wrapper: read the fixture JSON + manifest JSON and run the smoke.
pub fn run_xp3_patch_smoke_from_paths(
    fixture_path: &Path,
    manifest_path: &Path,
) -> Result<Xp3PatchReport, Xp3PatchError> {
    let fixture: Xp3CryptFixture =
        kaifuu_core::read_json(fixture_path).map_err(|error| Xp3PatchError::Internal {
            message: error.to_string(),
        })?;
    let manifest: Xp3PatchManifest =
        kaifuu_core::read_json(manifest_path).map_err(|error| Xp3PatchError::Internal {
            message: error.to_string(),
        })?;
    let fixture_dir = fixture_path
        .parent()
        .ok_or_else(|| Xp3PatchError::Internal {
            message: "fixture path must have a parent directory".to_string(),
        })?;
    run_xp3_patch_smoke_from_fixture(&fixture, &manifest, fixture_dir)
}

fn find_member<'a>(
    members: &'a [(String, Vec<u8>)],
    member_id: &str,
) -> Result<&'a [u8], Xp3PatchError> {
    members
        .iter()
        .find(|(id, _)| id == member_id)
        .map(|(_, bytes)| bytes.as_slice())
        .ok_or_else(|| Xp3PatchError::UnknownMember {
            member_id: member_id.to_string(),
        })
}

fn proof_hash(bytes: &[u8]) -> Result<ProofHash, Xp3PatchError> {
    ProofHash::new(sha256_hash_bytes(bytes)).map_err(|message| Xp3PatchError::Internal { message })
}
