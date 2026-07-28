//! Adapter round-trip verification helpers.

use super::*;

/// Verify the rebuilt archive: patched cells decode to the requested text and
/// unchanged tables are byte-identical. Returns the finalized patch reports and
/// the count of unchanged tables verified.
pub(super) fn verify_round_trip(
    source: &[WolfPlainMember],
    verified: &[WolfPlainMember],
    patches: &[WolfTextPatchRequest],
    mut patch_reports: Vec<WolfAdapterTablePatchReport>,
) -> Result<(Vec<WolfAdapterTablePatchReport>, u32), WolfAdapterError> {
    let patched_member_ids: std::collections::BTreeSet<String> = patches
        .iter()
        .map(|patch| table_member_id(&patch.table_name))
        .collect();

    // Every patched table's cells must decode to the requested new text.
    for report in &mut patch_reports {
        let member_id = table_member_id(&report.table_name);
        let member = verified
            .iter()
            .find(|member| member.member_id == member_id)
            .ok_or_else(|| WolfAdapterError::Internal {
                message: "verified archive dropped a patched table".to_string(),
            })?;
        let table = decode_wolf_text_table(&member.plaintext)?;
        let mut all_ok = true;
        for coordinate in &report.coordinates {
            let expected = patches
                .iter()
                .find(|patch| {
                    table_member_id(&patch.table_name) == member_id
                        && patch.record_index == coordinate.record_index
                        && patch.field_index == coordinate.field_index
                })
                .map(|patch| patch.new_text.as_str());
            let actual = table
                .records
                .get(coordinate.record_index as usize)
                .and_then(|record| record.get(coordinate.field_index as usize))
                .map(String::as_str);
            if expected != actual {
                all_ok = false;
            }
        }
        report.patched_text_verified = all_ok;
        if !all_ok {
            return Err(WolfAdapterError::Internal {
                message: "a patched cell did not decode to its requested text after repack"
                    .to_string(),
            });
        }
    }

    // Every unchanged table must be byte-identical after repack.
    let mut unchanged_tables_verified = 0u32;
    for source_member in source {
        if patched_member_ids.contains(&source_member.member_id) {
            continue;
        }
        let verified_member = verified
            .iter()
            .find(|member| member.member_id == source_member.member_id)
            .ok_or_else(|| WolfAdapterError::Internal {
                message: "verified archive dropped an unchanged table".to_string(),
            })?;
        if verified_member.plaintext != source_member.plaintext {
            return Err(WolfAdapterError::Internal {
                message: "an unchanged table was not byte-identical after repack".to_string(),
            });
        }
        unchanged_tables_verified += 1;
    }

    Ok((patch_reports, unchanged_tables_verified))
}

pub(super) fn build_verify_proof(
    verified: &[WolfPlainMember],
) -> Result<KeyValidationProof, WolfAdapterError> {
    let mut proof_material = Vec::new();
    for member in verified {
        proof_material.extend_from_slice(member.member_id.as_bytes());
        proof_material.extend_from_slice(proof_hash(&member.plaintext)?.as_str().as_bytes());
    }
    Ok(KeyValidationProof {
        method: KeyValidationMethod::FixtureRoundTripProof,
        proof_hash: proof_hash(&proof_material)?,
    })
}

/// The container member id a table name packs into (kept in sync with
/// [`WolfTextTable::member_id`]).
pub(super) fn table_member_id(table_name: &str) -> String {
    format!("Data/{table_name}.wolftable")
}

pub(super) fn proof_hash(bytes: &[u8]) -> Result<ProofHash, WolfAdapterError> {
    ProofHash::new(sha256_hash_bytes(bytes))
        .map_err(|message| WolfAdapterError::Internal { message })
}
