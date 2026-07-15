//! Profiled Wolf production extract+patch run pipeline.

use crate::wolf_adapter::{
    WolfAdapterError, WolfAdapterPatchCoordinate, WolfTextPatchRequest, WolfTextTable,
    decode_wolf_text_table, encode_wolf_text_table,
};
use crate::wolf_encrypted_smoke::{
    WOLF_ENCRYPTED_SMOKE_CAPABILITY_ID, WolfEncryptedArchiveKeyExt, WolfPlainMember,
    decrypt_archive_members, pack_encrypted_archive,
};
use crate::wolf_protection_detector::{WOLF_ENGINE_FAMILY, WolfProtectionProfile};
use crate::{
    HelperDiagnosticCode, HelperRedactionStatus, KeyMaterialKind, KeyValidationMethod,
    KeyValidationProof, OperationStatus, ProofHash, sha256_hash_bytes,
};

use super::{
    WOLF_PROFILED_PRODUCTION_CAPABILITY_ID, WOLF_PROFILED_PRODUCTION_CONTAINER,
    WOLF_PROFILED_PRODUCTION_SCHEMA_VERSION, WOLF_PROFILED_PRODUCTION_SUPPORT_BOUNDARY,
    WolfProfiledMemberDelta, WolfProfiledMemberOperation, WolfProfiledNotClaimedReport,
    WolfProfiledOutcome, WolfProfiledPatchReport, WolfProfiledProductionError,
    WolfProfiledProductionRegistry, WolfProfiledProductionReport, WolfProfiledProductionStage,
    WolfProfiledProductionVariant, WolfProfiledVariantReport, table_member_id,
};

pub fn run_wolf_profiled_production(
    registry: &WolfProfiledProductionRegistry,
    source_node_id: &str,
) -> Result<WolfProfiledProductionReport, WolfProfiledProductionError> {
    let mut outcomes = Vec::with_capacity(registry.variants.len());
    let mut claimed_profiles = Vec::new();
    let mut claimed_count = 0u32;
    let mut not_claimed_count = 0u32;

    for variant in &registry.variants {
        if !variant.claimed {
            not_claimed_count += 1;
            outcomes.push(WolfProfiledOutcome::NotClaimed(
                WolfProfiledNotClaimedReport {
                    variant_id: variant.variant_id.clone(),
                    protection_profile: variant.protection_profile,
                    crypto_profile: variant.crypto_profile,
                    helper_workflow: variant.helper_workflow,
                    reason:
                        "profile is not claimed (out of scope beyond the bounded synthetic evidence)"
                            .to_string(),
                },
            ));
            continue;
        }

        let report = run_claimed_variant(registry, variant)?;
        if !claimed_profiles.contains(&variant.protection_profile) {
            claimed_profiles.push(variant.protection_profile);
        }
        claimed_count += 1;
        outcomes.push(WolfProfiledOutcome::Claimed(report));
    }

    let report = WolfProfiledProductionReport {
        schema_version: WOLF_PROFILED_PRODUCTION_SCHEMA_VERSION.to_string(),
        capability_id: WOLF_PROFILED_PRODUCTION_CAPABILITY_ID.to_string(),
        cited_smoke_capability_id: WOLF_ENCRYPTED_SMOKE_CAPABILITY_ID.to_string(),
        source_node_id: source_node_id.to_string(),
        support_boundary: WOLF_PROFILED_PRODUCTION_SUPPORT_BOUNDARY.to_string(),
        registry_id: registry.registry_id.clone(),
        engine_family: WOLF_ENGINE_FAMILY.to_string(),
        container: WOLF_PROFILED_PRODUCTION_CONTAINER.to_string(),
        redaction_status: HelperRedactionStatus::Redacted,
        claimed_profiles,
        claimed_count,
        not_claimed_count,
        outcomes,
        status: OperationStatus::Passed,
    };

    let json = report
        .stable_json()
        .map_err(|error| WolfProfiledProductionError::Internal {
            message: error.to_string(),
        })?;
    if registry.archive_keys.any_key_appears_in(json.as_bytes())
        || registry.resolved_keys.any_key_appears_in(json.as_bytes())
    {
        return Err(WolfProfiledProductionError::Internal {
            message: "refusing to emit a report that leaks raw key material".to_string(),
        });
    }

    Ok(report)
}

fn run_claimed_variant(
    registry: &WolfProfiledProductionRegistry,
    variant: &WolfProfiledProductionVariant,
) -> Result<WolfProfiledVariantReport, WolfProfiledProductionError> {
    let id = variant.variant_id.as_str();
    if variant.protection_profile == WolfProtectionProfile::Unknown {
        return Err(WolfProfiledProductionError::claimed(
            id,
            WolfProfiledProductionStage::EvidenceCheck,
            "unknown protection profile cannot be a claimed extract+patch profile",
        ));
    }
    if variant.tables.is_empty() {
        return Err(WolfProfiledProductionError::claimed(
            id,
            WolfProfiledProductionStage::EvidenceCheck,
            "claimed profile declares no text-bearing tables",
        ));
    }

    let archive_key = registry
        .archive_keys
        .resolve(&variant.secret_requirement_id, &variant.secret_ref)
        .map_err(|cause| {
            WolfProfiledProductionError::claimed(id, WolfProfiledProductionStage::KeyResolve, cause)
        })?;
    let source_members = encode_tables_to_members(&variant.tables).map_err(|error| {
        WolfProfiledProductionError::claimed(id, WolfProfiledProductionStage::Patch, error)
    })?;
    let source_archive = pack_encrypted_archive(&source_members, archive_key).map_err(|error| {
        WolfProfiledProductionError::claimed(id, WolfProfiledProductionStage::Patch, error)
    })?;

    check_helper_evidence(variant).map_err(|cause| {
        WolfProfiledProductionError::claimed(id, WolfProfiledProductionStage::EvidenceCheck, cause)
    })?;
    let resolved_key = registry
        .resolved_keys
        .resolve(&variant.secret_requirement_id, &variant.secret_ref)
        .map_err(|cause| {
            WolfProfiledProductionError::claimed(id, WolfProfiledProductionStage::KeyResolve, cause)
        })?;

    let extracted = decrypt_archive_members(&source_archive, resolved_key).map_err(|error| {
        WolfProfiledProductionError::claimed(id, WolfProfiledProductionStage::Extract, error)
    })?;
    let extracted_ids: Vec<String> = extracted
        .iter()
        .map(|member| member.member_id.clone())
        .collect();
    if extracted_ids != variant.expected_member_ids() {
        return Err(WolfProfiledProductionError::claimed(
            id,
            WolfProfiledProductionStage::Extract,
            "extracted member set did not match the declared profile surfaces",
        ));
    }

    let identity_rebuilt = pack_encrypted_archive(&extracted, resolved_key).map_err(|error| {
        WolfProfiledProductionError::claimed(id, WolfProfiledProductionStage::Identity, error)
    })?;
    let identity_byte_identical = identity_rebuilt == source_archive;
    if !identity_byte_identical {
        return Err(WolfProfiledProductionError::claimed(
            id,
            WolfProfiledProductionStage::Identity,
            "identity rebuild diverged from the source archive",
        ));
    }

    let (patched_members, source_cells) =
        apply_patches(&extracted, &variant.patches).map_err(|error| {
            WolfProfiledProductionError::claimed(id, WolfProfiledProductionStage::Patch, error)
        })?;
    if source_cells.is_empty() {
        return Err(WolfProfiledProductionError::claimed(
            id,
            WolfProfiledProductionStage::Patch,
            "claimed profile declared no applicable patch",
        ));
    }
    let rebuilt_archive =
        pack_encrypted_archive(&patched_members, resolved_key).map_err(|error| {
            WolfProfiledProductionError::claimed(id, WolfProfiledProductionStage::Patch, error)
        })?;
    let verified = decrypt_archive_members(&rebuilt_archive, resolved_key).map_err(|error| {
        WolfProfiledProductionError::claimed(id, WolfProfiledProductionStage::Verify, error)
    })?;
    let patch_reports =
        verify_patch_isolation(&extracted, &verified, &variant.patches, &source_cells).map_err(
            |cause| {
                WolfProfiledProductionError::claimed(id, WolfProfiledProductionStage::Verify, cause)
            },
        )?;

    let mut member_deltas = Vec::with_capacity(extracted.len());
    let mut proof_material = Vec::new();
    let mut members_patched = 0u32;
    for source_member in &extracted {
        let target = verified
            .iter()
            .find(|member| member.member_id == source_member.member_id)
            .ok_or_else(|| WolfProfiledProductionError::Internal {
                message: "rebuilt archive dropped a source member".to_string(),
            })?;
        let source_hash = proof_hash(&source_member.plaintext)?;
        let target_hash = proof_hash(&target.plaintext)?;
        let operation = if source_hash == target_hash {
            WolfProfiledMemberOperation::Unchanged
        } else {
            members_patched += 1;
            WolfProfiledMemberOperation::Replace
        };
        proof_material.extend_from_slice(source_member.member_id.as_bytes());
        proof_material.extend_from_slice(source_hash.as_str().as_bytes());
        proof_material.extend_from_slice(target_hash.as_str().as_bytes());
        member_deltas.push(WolfProfiledMemberDelta {
            member_id: source_member.member_id.clone(),
            operation,
            source_plaintext_hash: source_hash,
            target_plaintext_hash: target_hash,
            length_delta: target.plaintext.len() as i64 - source_member.plaintext.len() as i64,
        });
    }

    let members_total = u32::try_from(extracted.len()).unwrap_or(u32::MAX);
    Ok(WolfProfiledVariantReport {
        variant_id: variant.variant_id.clone(),
        protection_profile: variant.protection_profile,
        crypto_profile: variant.crypto_profile,
        helper_workflow: variant.helper_workflow,
        secret_requirement_id: variant.secret_requirement_id.clone(),
        secret_ref: variant.secret_ref.clone(),
        helper_evidence_present: variant.helper_evidence.is_some(),
        key_material_kind: KeyMaterialKind::FixedBytes,
        key_material_hash: resolved_key.material_hash().map_err(|error| {
            WolfProfiledProductionError::claimed(id, WolfProfiledProductionStage::Verify, error)
        })?,
        key_bytes: u32::try_from(resolved_key.byte_len()).unwrap_or(u32::MAX),
        source_archive_hash: proof_hash(&source_archive)?,
        rebuilt_archive_hash: proof_hash(&rebuilt_archive)?,
        identity_byte_identical,
        members_total,
        members_patched,
        members_byte_preserved: members_total.saturating_sub(members_patched),
        member_deltas,
        patch_reports,
        round_trip_proof: KeyValidationProof {
            method: KeyValidationMethod::FixtureRoundTripProof,
            proof_hash: proof_hash(&proof_material)?,
        },
        status: OperationStatus::Passed,
    })
}

fn check_helper_evidence(variant: &WolfProfiledProductionVariant) -> Result<(), String> {
    if !variant.helper_workflow.requires_helper() {
        return Ok(());
    }
    let helper = variant.helper_evidence.as_ref().ok_or_else(|| {
        format!(
            "helper workflow {} requires helper evidence but none was supplied",
            variant.helper_workflow.as_str()
        )
    })?;
    let validation = helper.validate();
    if validation.status == OperationStatus::Failed {
        let failure_codes = validation
            .failures
            .iter()
            .map(|failure| format!("{}:{}", failure.field, failure.code))
            .collect::<Vec<_>>()
            .join(", ");
        return Err(format!(
            "helper result failed HelperResult validation ({} failure(s): {failure_codes})",
            validation.failures.len(),
        ));
    }
    if helper.diagnostic.code != HelperDiagnosticCode::Success {
        return Err(format!(
            "helper result diagnostic is {:?}, not a resolved key",
            helper.diagnostic.code
        ));
    }
    let exact_ref = helper.secret_refs.iter().any(|secret| {
        secret.requirement_id == variant.secret_requirement_id
            && secret.secret_ref == variant.secret_ref
    });
    if !exact_ref {
        return Err(
            "helper result does not bind the variant requirement to the exact SecretRef"
                .to_string(),
        );
    }
    if helper.capability_level < variant.helper_workflow.minimum_capability() {
        return Err(format!(
            "helper capability level {:?} is below the {:?} required by workflow {}",
            helper.capability_level,
            variant.helper_workflow.minimum_capability(),
            variant.helper_workflow.as_str()
        ));
    }
    Ok(())
}

fn encode_tables_to_members(
    tables: &[WolfTextTable],
) -> Result<Vec<WolfPlainMember>, WolfAdapterError> {
    tables
        .iter()
        .map(|table| {
            Ok(WolfPlainMember {
                member_id: table_member_id(&table.table_name),
                plaintext: encode_wolf_text_table(table)?,
            })
        })
        .collect()
}

#[derive(Debug, Clone)]
struct SourceCell {
    table_name: String,
    coordinate: WolfAdapterPatchCoordinate,
    old_text: String,
}

fn apply_patches(
    extracted: &[WolfPlainMember],
    patches: &[WolfTextPatchRequest],
) -> Result<(Vec<WolfPlainMember>, Vec<SourceCell>), WolfAdapterError> {
    let mut patched_members = Vec::with_capacity(extracted.len());
    let mut source_cells = Vec::new();

    for member in extracted {
        let mut table = decode_wolf_text_table(&member.plaintext)?;
        let member_patches: Vec<&WolfTextPatchRequest> = patches
            .iter()
            .filter(|patch| table_member_id(&patch.table_name) == member.member_id)
            .collect();
        if member_patches.is_empty() {
            patched_members.push(member.clone());
            continue;
        }
        for patch in member_patches {
            let record = table
                .records
                .get_mut(patch.record_index as usize)
                .ok_or_else(|| WolfAdapterError::PatchTargetMissing {
                    detail: format!(
                        "record {} out of range for table {}",
                        patch.record_index, patch.table_name
                    ),
                })?;
            let cell = record.get_mut(patch.field_index as usize).ok_or_else(|| {
                WolfAdapterError::PatchTargetMissing {
                    detail: format!(
                        "field {} out of range for table {}",
                        patch.field_index, patch.table_name
                    ),
                }
            })?;
            source_cells.push(SourceCell {
                table_name: patch.table_name.clone(),
                coordinate: WolfAdapterPatchCoordinate {
                    record_index: patch.record_index,
                    field_index: patch.field_index,
                },
                old_text: cell.clone(),
            });
            cell.clone_from(&patch.new_text);
        }
        patched_members.push(WolfPlainMember {
            member_id: member.member_id.clone(),
            plaintext: encode_wolf_text_table(&table)?,
        });
    }

    Ok((patched_members, source_cells))
}

fn verify_patch_isolation(
    source: &[WolfPlainMember],
    verified: &[WolfPlainMember],
    patches: &[WolfTextPatchRequest],
    source_cells: &[SourceCell],
) -> Result<Vec<WolfProfiledPatchReport>, String> {
    let patched_ids: std::collections::BTreeSet<String> = patches
        .iter()
        .map(|patch| table_member_id(&patch.table_name))
        .collect();
    let mut reports = Vec::new();

    for patch in patches {
        let member_id = table_member_id(&patch.table_name);
        let source_member = find_member(source, &member_id)
            .ok_or_else(|| format!("source patched table {} missing", patch.table_name))?;
        let verified_member = find_member(verified, &member_id)
            .ok_or_else(|| format!("verified patched table {} missing", patch.table_name))?;
        let table = decode_wolf_text_table(&verified_member.plaintext)
            .map_err(|error| error.to_string())?;
        let actual = table
            .records
            .get(patch.record_index as usize)
            .and_then(|record| record.get(patch.field_index as usize))
            .ok_or_else(|| format!("patched coordinate missing in table {}", patch.table_name))?;
        let old = source_cells
            .iter()
            .find(|cell| {
                cell.table_name == patch.table_name
                    && cell.coordinate.record_index == patch.record_index
                    && cell.coordinate.field_index == patch.field_index
            })
            .ok_or_else(|| format!("source cell missing for table {}", patch.table_name))?;
        let patched_text_verified = actual == &patch.new_text;
        let old_text_absent = !flattened_table_text(&table).contains(&old.old_text);
        if !patched_text_verified || !old_text_absent {
            return Err(format!(
                "patched table {} did not verify new text present and old text gone",
                patch.table_name
            ));
        }
        reports.push(WolfProfiledPatchReport {
            table_name: patch.table_name.clone(),
            coordinates: vec![WolfAdapterPatchCoordinate {
                record_index: patch.record_index,
                field_index: patch.field_index,
            }],
            source_member_hash: proof_hash(&source_member.plaintext).map_err(|e| e.to_string())?,
            patched_member_hash: proof_hash(&verified_member.plaintext)
                .map_err(|e| e.to_string())?,
            patched_text_verified,
            old_text_absent,
        });
    }

    for source_member in source {
        if patched_ids.contains(&source_member.member_id) {
            continue;
        }
        let verified_member = find_member(verified, &source_member.member_id)
            .ok_or_else(|| format!("verified archive dropped {}", source_member.member_id))?;
        if verified_member.plaintext != source_member.plaintext {
            return Err(format!(
                "unpatched member {} was not byte-identical",
                source_member.member_id
            ));
        }
    }
    Ok(reports)
}

fn find_member<'a>(members: &'a [WolfPlainMember], member_id: &str) -> Option<&'a WolfPlainMember> {
    members.iter().find(|member| member.member_id == member_id)
}

fn flattened_table_text(table: &WolfTextTable) -> String {
    table
        .records
        .iter()
        .flat_map(|record| record.iter())
        .fold(String::new(), |mut acc, cell| {
            acc.push_str(cell);
            acc.push('\n');
            acc
        })
}

fn proof_hash(bytes: &[u8]) -> Result<ProofHash, WolfProfiledProductionError> {
    ProofHash::new(sha256_hash_bytes(bytes))
        .map_err(|message| WolfProfiledProductionError::Internal { message })
}
