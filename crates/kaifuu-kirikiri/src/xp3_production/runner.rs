use super::*;

/// Run the production extract+patch over a profiled-variant registry.
/// Each claimed variant is extracted + patched through its declared crypt scheme
/// and required key/helper evidence; a claimed variant that cannot do so aborts
/// the run with a loud [`Xp3ProductionError::ClaimedVariantFailed`]. Unclaimed
/// variants are recorded as explicit out-of-scope rows. The serialized report is
/// deep no-leak-guarded before it is returned.
pub fn run_xp3_production(
    registry: &Xp3ProductionRegistry,
    source_node_id: &str,
) -> Result<Xp3ProductionReport, Xp3ProductionError> {
    let mut outcomes = Vec::with_capacity(registry.variants.len());
    let mut claimed_profiles: Vec<Xp3CryptoProfile> = Vec::new();
    let mut claimed_count = 0u32;
    let mut not_claimed_count = 0u32;
    // The per-variant resolvers (each owning its resolved-key holder) are held
    // only long enough to run the no-leak guard, then dropped (each holder
    // zeroizes on drop).
    let mut resolvers: Vec<FixtureSecretResolver> = Vec::new();

    for variant in &registry.variants {
        if !variant.claimed {
            not_claimed_count += 1;
            outcomes.push(Xp3ProductionOutcome::NotClaimed(
                Xp3ProductionNotClaimedReport {
                    variant_id: variant.variant_id.clone(),
                    crypto_profile: variant.crypto_profile,
                    helper_workflow: variant.helper_workflow,
                    reason:
                        "variant is not claimed by the profile (out of scope; retail beyond the \
                             bounded profiled evidence)"
                            .to_string(),
                },
            ));
            continue;
        }

        let (report, resolver) = run_claimed_variant(variant)?;
        if !claimed_profiles.contains(&variant.crypto_profile) {
            claimed_profiles.push(variant.crypto_profile);
        }
        claimed_count += 1;
        resolvers.push(resolver);
        outcomes.push(Xp3ProductionOutcome::Claimed(report));
    }

    let report = Xp3ProductionReport {
        schema_version: XP3_PRODUCTION_SCHEMA_VERSION.to_string(),
        capability_id: XP3_PRODUCTION_CAPABILITY_ID.to_string(),
        source_node_id: source_node_id.to_string(),
        support_boundary: XP3_PRODUCTION_SUPPORT_BOUNDARY.to_string(),
        registry_id: registry.registry_id.clone(),
        engine_family: XP3_PRODUCTION_ENGINE_FAMILY.to_string(),
        container: XP3_PRODUCTION_CONTAINER.to_string(),
        redaction_status: HelperRedactionStatus::Redacted,
        claimed_profiles,
        claimed_count,
        not_claimed_count,
        outcomes,
        status: OperationStatus::Passed,
    };

    // Runtime no-leak guard: the serialized (redacted) report must never carry
    // any raw key material. The guard scans EVERY key-holding source — confined
    // to the zeroize-on-drop holders — against the serialized report, not just
    // the report's own fields. A hard refusal, not just a test-time check.
    // It covers (a) the resolver-held resolved-key copies for each claimed
    // variant, AND (b) every registry-held holder on EVERY variant in the
    // registry — each variant's ground-truth `archive_key` and its
    // `resolved_key_evidence`, for CLAIMED and UNCLAIMED variants alike. An
    // unclaimed variant never enters a resolver, so without (b) its registry-
    // held archive key could reach the report unguarded.
    let json = report
        .stable_json()
        .map_err(|error| Xp3ProductionError::Internal {
            message: error.to_string(),
        })?;
    let bytes = json.as_bytes();
    let resolver_leak = resolvers
        .iter()
        .any(|resolver| resolver.any_key_appears_in(bytes));
    let registry_leak = registry
        .variants
        .iter()
        .any(|variant| variant.any_key_appears_in(bytes));
    if resolver_leak || registry_leak {
        return Err(Xp3ProductionError::Internal {
            message: "refusing to emit a report that leaks raw key material".to_string(),
        });
    }

    Ok(report)
}

/// Run one claimed variant's extract → patch round-trip. Returns the per-variant
/// report and the resolver holding the resolved-key holder (so the caller can
/// run the no-leak guard against the serialized report before the holder
/// drops/zeroizes).
fn run_claimed_variant(
    variant: &Xp3ProductionVariant,
) -> Result<(Xp3ProductionVariantReport, FixtureSecretResolver), Xp3ProductionError> {
    let id = variant.variant_id.as_str();
    let scheme = variant.crypto_profile.scheme();

    // (0) Build the synthetic encrypted archive from the fixture ARCHIVE key
    // (ground truth: the bytes that actually enciphered the archive).
    let members: Vec<(String, Vec<u8>)> = variant
        .members
        .iter()
        .map(|(path, text)| (path.clone(), text.as_bytes().to_vec()))
        .collect();
    if members.is_empty() {
        return Err(Xp3ProductionError::claimed(
            id,
            Xp3ProductionStage::EvidenceCheck,
            "variant declares no member surfaces to extract",
        ));
    }
    // The ground-truth archive key is already confined to the variant's holder.
    let source_container = encode_encrypted_xp3(&members, &variant.archive_key, scheme);

    // (1) EVIDENCE CHECK: the required key/helper evidence must be present +
    // adequate. A missing/inadequate leg for a CLAIMED variant is a loud bug.
    let resolved_key = variant.resolved_key_evidence.as_ref().ok_or_else(|| {
        Xp3ProductionError::claimed(
            id,
            Xp3ProductionStage::EvidenceCheck,
            "required key evidence is absent (no resolved key for the declared secret ref)",
        )
    })?;
    check_helper_evidence(variant).map_err(|cause| {
        Xp3ProductionError::claimed(id, Xp3ProductionStage::EvidenceCheck, cause)
    })?;

    // (2) KEY RESOLVE: bind the declared secret ref to the resolved key evidence
    // HOLDER and resolve through the ref (proves the ref path; the material
    // never leaves an [`Xp3CryptKey`]). The archive key never enters the
    // resolver. The resolver owns the resolved-key holder and is returned so
    // the caller can run the no-leak guard before it drops/zeroizes.
    let resolver = FixtureSecretResolver::from_key_refs(vec![(
        variant.secret_ref.as_str().to_string(),
        resolved_key,
    )]);
    let key = resolver
        .resolve(&variant.secret_requirement_id, &variant.secret_ref)
        .map_err(|error| Xp3ProductionError::claimed(id, Xp3ProductionStage::KeyResolve, error))?;

    // (3) EXTRACT: decrypt + integrity-verify every member. A wrong resolved key
    // trips the adlr integrity check → a loud claimed failure.
    let source_members: Vec<(String, Vec<u8>)> = decrypt_members(&source_container, key, scheme)
        .map_err(|error| Xp3ProductionError::claimed(id, Xp3ProductionStage::Extract, error))?
        .into_iter()
        .map(|member| (member.member_id, member.plaintext))
        .collect();

    let extracted_ids: Vec<String> = source_members.iter().map(|(id, _)| id.clone()).collect();
    if extracted_ids != variant.expected_member_ids() {
        return Err(Xp3ProductionError::claimed(
            id,
            Xp3ProductionStage::Extract,
            "extracted member set did not match the declared surfaces",
        ));
    }

    // (4) IDENTITY: rebuild(extract(x)) with no change must be byte-identical.
    let identity_rebuilt = encode_encrypted_xp3(&source_members, key, scheme);
    let identity_byte_identical = identity_rebuilt == source_container;
    if !identity_byte_identical {
        return Err(Xp3ProductionError::claimed(
            id,
            Xp3ProductionStage::Identity,
            "identity rebuild diverged from the source (encode not byte-preserving)",
        ));
    }

    // (5) PATCH: apply the variant's trivial replacement(s) + repack.
    let (patched_members, changed_ids) =
        apply_replacements(&source_members, &patch_manifest(variant))
            .map_err(|error| Xp3ProductionError::claimed(id, Xp3ProductionStage::Patch, error))?;
    if changed_ids.is_empty() {
        return Err(Xp3ProductionError::claimed(
            id,
            Xp3ProductionStage::Patch,
            "variant declared no applicable replacement",
        ));
    }
    let rebuilt_container = encode_encrypted_xp3(&patched_members, key, scheme);

    // (6) VERIFY: re-decrypt the rebuilt container through the SAME ref and prove
    // the patched text is present, the old text gone, and every other member
    // byte-identical.
    let rebuilt_members: Vec<(String, Vec<u8>)> = decrypt_members(&rebuilt_container, key, scheme)
        .map_err(|error| Xp3ProductionError::claimed(id, Xp3ProductionStage::Verify, error))?
        .into_iter()
        .map(|member| (member.member_id, member.plaintext))
        .collect();

    verify_patch_isolation(variant, &source_members, &rebuilt_members)
        .map_err(|cause| Xp3ProductionError::claimed(id, Xp3ProductionStage::Verify, cause))?;

    // (7) Assemble the hash-based per-member deltas + report.
    let mut member_deltas = Vec::with_capacity(source_members.len());
    let mut proof_material = Vec::new();
    let mut members_patched = 0u32;
    for (member_id, source_plain) in &source_members {
        let target_plain = rebuilt_members
            .iter()
            .find(|(id, _)| id == member_id)
            .map(|(_, plain)| plain)
            .ok_or_else(|| Xp3ProductionError::Internal {
                message: "rebuilt member set dropped a source member".to_string(),
            })?;
        let source_hash = proof_hash(source_plain)?;
        let target_hash = proof_hash(target_plain)?;
        let operation = if source_hash.as_str() == target_hash.as_str() {
            Xp3ProductionMemberOperation::Unchanged
        } else {
            members_patched += 1;
            Xp3ProductionMemberOperation::Replace
        };
        proof_material.extend_from_slice(member_id.as_bytes());
        proof_material.extend_from_slice(source_hash.as_str().as_bytes());
        proof_material.extend_from_slice(target_hash.as_str().as_bytes());
        member_deltas.push(Xp3ProductionMemberDelta {
            member_id: member_id.clone(),
            operation,
            source_plaintext_hash: source_hash,
            target_plaintext_hash: target_hash,
            length_delta: target_plain.len() as i64 - source_plain.len() as i64,
        });
    }

    let members_total = u32::try_from(source_members.len()).unwrap_or(u32::MAX);
    let report = Xp3ProductionVariantReport {
        variant_id: variant.variant_id.clone(),
        crypto_profile: variant.crypto_profile,
        surface: variant.surface,
        secret_requirement_id: variant.secret_requirement_id.clone(),
        secret_ref: variant.secret_ref.clone(),
        helper_workflow: variant.helper_workflow,
        helper_evidence_present: variant.helper_evidence.is_some(),
        key_material_kind: KeyMaterialKind::FixedBytes,
        key_material_hash: key
            .material_hash()
            .map_err(|error| Xp3ProductionError::claimed(id, Xp3ProductionStage::Verify, error))?,
        key_bytes: u32::try_from(key.byte_len()).unwrap_or(u32::MAX),
        source_container_hash: proof_hash(&source_container)?,
        rebuilt_container_hash: proof_hash(&rebuilt_container)?,
        identity_byte_identical,
        members_total,
        members_patched,
        members_byte_preserved: members_total.saturating_sub(members_patched),
        members: member_deltas,
        round_trip_proof: KeyValidationProof {
            method: KeyValidationMethod::FixtureRoundTripProof,
            proof_hash: proof_hash(&proof_material)?,
        },
        status: OperationStatus::Passed,
    };

    Ok((report, resolver))
}

/// Check the variant's required helper evidence is present and adequate. Only
/// helper-gated workflows require a helper result; when one is required it must
/// reference the EXACT `variant.secret_ref` (bound to the variant's requirement
/// id), carry a non-blocking diagnostic (a resolved key, not
/// `missing_key`/`helper_required`/etc.), pass validation, and meet
/// the workflow's minimum capability level. A helper result for the right
/// requirement id but a DIFFERENT secret ref does NOT satisfy the gate.
fn check_helper_evidence(variant: &Xp3ProductionVariant) -> Result<(), String> {
    if !variant.helper_workflow.requires_helper() {
        return Ok(());
    }
    let helper = variant.helper_evidence.as_ref().ok_or_else(|| {
        format!(
            "helper workflow {} requires a helper result but none was supplied",
            variant.helper_workflow.as_str()
        )
    })?;

    let validation = helper.validate();
    if validation.status == OperationStatus::Failed {
        return Err(format!(
            "helper result failed validation ({} failure(s))",
            validation.failures.len()
        ));
    }

    if helper.diagnostic.code != HelperDiagnosticCode::Success {
        return Err(format!(
            "helper result diagnostic is {:?}, not a resolved key (required evidence not satisfied)",
            helper.diagnostic.code
        ));
    }

    // Bind the helper evidence to the EXACT secret ref the variant will resolve
    // its key through — not merely to the requirement id. A helper result for the
    // right requirement id but a WRONG ref must NOT satisfy the helper-gated path
    // (the key bytes are resolved independently through `variant.secret_ref`, so
    // a mismatched helper ref is evidence for the wrong secret).
    let binds_secret_ref = helper.secret_refs.iter().any(|secret| {
        secret.requirement_id == variant.secret_requirement_id
            && secret.secret_ref == variant.secret_ref
    });
    if !binds_secret_ref {
        return Err(format!(
            "helper result carries no secretRef bound to the variant's requirement id + secret ref \
             {} (a helper result for a different ref does not satisfy the gate)",
            variant.secret_ref.as_str()
        ));
    }

    let minimum = minimum_capability(variant.helper_workflow);
    if helper.capability_level < minimum {
        return Err(format!(
            "helper capability level {:?} is below the {:?} required by workflow {}",
            helper.capability_level,
            minimum,
            variant.helper_workflow.as_str()
        ));
    }
    Ok(())
}

fn minimum_capability(workflow: Xp3HelperWorkflow) -> HelperCapabilityLevel {
    match workflow {
        Xp3HelperWorkflow::None | Xp3HelperWorkflow::KnownKeyImport => {
            HelperCapabilityLevel::LocalKeyImport
        }
        Xp3HelperWorkflow::ManualKeyEntry => HelperCapabilityLevel::ManualEntry,
    }
}

/// Build the trivial-replacement patch manifest for a variant (its declared
/// replacements) so it can reuse the proven [`apply_replacements`] path.
fn patch_manifest(variant: &Xp3ProductionVariant) -> crate::xp3_patch::Xp3PatchManifest {
    crate::xp3_patch::Xp3PatchManifest {
        schema_version: crate::xp3_patch::XP3_PATCH_SCHEMA_VERSION.to_string(),
        manifest_id: format!("{}-production-patch", variant.variant_id),
        source_node_id: "xp3-production".to_string(),
        replacements: variant.replacements.clone(),
    }
}

/// Prove the patch was applied and isolated: each replacement's new text is
/// present + old text absent in the rebuilt member, and every member the
/// manifest did not touch is byte-identical across the rebuild.
fn verify_patch_isolation(
    variant: &Xp3ProductionVariant,
    source_members: &[(String, Vec<u8>)],
    rebuilt_members: &[(String, Vec<u8>)],
) -> Result<(), String> {
    let patched_ids: Vec<&str> = variant
        .replacements
        .iter()
        .map(|replacement| replacement.member_id.as_str())
        .collect();

    for replacement in &variant.replacements {
        let rebuilt = find_member(rebuilt_members, &replacement.member_id).ok_or_else(|| {
            format!(
                "patched member {} missing from rebuild",
                replacement.member_id
            )
        })?;
        let rebuilt_text = String::from_utf8_lossy(rebuilt);
        if !rebuilt_text.contains(&replacement.replace) {
            return Err(format!(
                "patched member {} does not carry the new text",
                replacement.member_id
            ));
        }
        if rebuilt_text.contains(&replacement.find) {
            return Err(format!(
                "patched member {} still carries the old text",
                replacement.member_id
            ));
        }
    }

    for (member_id, source_plain) in source_members {
        if patched_ids.contains(&member_id.as_str()) {
            continue;
        }
        let rebuilt = find_member(rebuilt_members, member_id)
            .ok_or_else(|| format!("member {member_id} missing from rebuild"))?;
        if rebuilt != source_plain.as_slice() {
            return Err(format!(
                "unpatched member {member_id} was not byte-identical across the rebuild"
            ));
        }
    }
    Ok(())
}

fn find_member<'a>(members: &'a [(String, Vec<u8>)], member_id: &str) -> Option<&'a [u8]> {
    members
        .iter()
        .find(|(id, _)| id == member_id)
        .map(|(_, bytes)| bytes.as_slice())
}

fn proof_hash(bytes: &[u8]) -> Result<ProofHash, Xp3ProductionError> {
    ProofHash::new(sha256_hash_bytes(bytes))
        .map_err(|message| Xp3ProductionError::Internal { message })
}
