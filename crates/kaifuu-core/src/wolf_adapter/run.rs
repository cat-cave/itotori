//! Adapter runner: detector + helper-boundary gate, then extract → patch → repack.
//! Composition over the Wolf container/crypto substrate and text-table codec.

use std::path::Path;

use crate::registry::capability::CapabilityLevelStatus;
use crate::wolf_encrypted_smoke::{
    WOLF_ENCRYPTED_SMOKE_REQUIREMENT_ID, WolfEncryptedArchiveKeyExt,
    WolfEncryptedFixtureSecretResolver, WolfPlainMember, decrypt_archive_members,
    pack_encrypted_archive,
};
use crate::wolf_helper_boundary::{
    WolfHelperBoundaryFixture, WolfHelperBoundaryOutcome, run_wolf_helper_boundary,
};
use crate::wolf_protection_detector::{
    WOLF_ENGINE_FAMILY, WolfCapabilityTuple, WolfProtectionDetectorFixture, WolfProtectionProfile,
    derive_wolf_capability_tuple, run_wolf_protection_detector,
};
use crate::{
    HelperRedactionStatus, KeyMaterialKind, OperationStatus, SemanticErrorCode, deterministic_id,
    read_json,
};

use super::{
    WOLF_ADAPTER_CAPABILITY_ID, WOLF_ADAPTER_CITED_SMOKE_CAPABILITY_ID,
    WOLF_ADAPTER_SCHEMA_VERSION, WOLF_ADAPTER_SUPPORT_BOUNDARY, WolfAdapterCapabilityDiagnostic,
    WolfAdapterError, WolfAdapterOutcome, WolfAdapterPatchCoordinate, WolfAdapterTableDigest,
    WolfAdapterTablePatchReport, WolfAdapterTransformLegs, WolfTextPatchRequest, WolfTextTable,
    WolfTextTableAdapterFixture, WolfTextTableAdapterReport, build_verify_proof,
    decode_wolf_text_table, encode_wolf_text_table, proof_hash, read_offset_index, table_member_id,
    verify_round_trip,
};

// The adapter runner (the composition)

/// Run the Wolf text-table adapter over a synthetic fixture: gate on the
/// detector + helper boundary, then extract + patch the text tables through the
/// layered container → crypto → codec → patch-back pipeline. Never panics.
pub fn run_wolf_text_table_adapter(
    fixture: &WolfTextTableAdapterFixture,
) -> Result<WolfTextTableAdapterReport, WolfAdapterError> {
    let detector_report = run_wolf_protection_detector(&WolfProtectionDetectorFixture {
        schema_version: crate::wolf_protection_detector::WOLF_PROTECTION_DETECTOR_SCHEMA_VERSION
            .to_string(),
        detector_set_id: format!("wolf-adapter/{}/detector", fixture.fixture_id),
        source_node_id: fixture.source_node_id.clone(),
        engine_family: fixture.engine_family.clone(),
        entries: vec![fixture.detector.clone()],
    });
    let detector_entry = detector_report
        .entries
        .into_iter()
        .next()
        .expect("single-entry detector fixture yields exactly one entry");
    let protection_profile = detector_entry.profile;

    // Capture the FULL boundary posture — the derived outcome PLUS the boundary's
    // own validation status and findings. The gate consumes all three, so a
    // failed or finding-bearing posture can never be waved through to
    // extract/patch on the strength of its outcome alone.
    let helper_posture = fixture.helper_boundary.as_ref().map(|profile| {
        let report = run_wolf_helper_boundary(&WolfHelperBoundaryFixture {
            schema_version: crate::wolf_helper_boundary::WOLF_HELPER_BOUNDARY_SCHEMA_VERSION
                .to_string(),
            boundary_set_id: format!("wolf-adapter/{}/helper-boundary", fixture.fixture_id),
            source_node_id: fixture.source_node_id.clone(),
            engine_family: fixture.engine_family.clone(),
            profiles: vec![profile.clone()],
        });
        let entry = report
            .entries
            .into_iter()
            .next()
            .expect("single-profile helper-boundary fixture yields exactly one entry");
        HelperBoundaryPosture {
            outcome: entry.outcome,
            status: entry.status,
            finding_count: entry.findings.len(),
        }
    });
    let helper_outcome = helper_posture.as_ref().map(|posture| posture.outcome);

    match classify_gate(
        &fixture.engine_family,
        protection_profile,
        helper_posture.as_ref(),
        detector_entry.status,
    ) {
        None => run_supported(
            fixture,
            protection_profile,
            helper_outcome,
            supported_claimed_support(),
        ),
        Some(diagnostic) => Ok(build_unsupported_report(
            fixture,
            protection_profile,
            helper_outcome,
            diagnostic,
        )),
    }
}

/// Read a fixture JSON and run the adapter against it.
pub fn run_wolf_text_table_adapter_from_path(
    fixture_path: &Path,
) -> Result<WolfTextTableAdapterReport, WolfAdapterError> {
    let fixture: WolfTextTableAdapterFixture =
        read_json(fixture_path).map_err(|error| WolfAdapterError::Internal {
            message: error.to_string(),
        })?;
    run_wolf_text_table_adapter(&fixture)
}

/// The claimed-support tuple for a cleared gate: identify/inventory/extract/patch
/// are supported (proven by the round-trip); helper/runtime stay out of scope.
fn supported_claimed_support() -> WolfCapabilityTuple {
    WolfCapabilityTuple {
        identify: CapabilityLevelStatus::supported(),
        inventory: CapabilityLevelStatus::supported(),
        extract: CapabilityLevelStatus::supported(),
        patch: CapabilityLevelStatus::supported(),
        helper: CapabilityLevelStatus::unsupported(
            "the static key resolved by ref; no dynamic-key helper applies",
        ),
        runtime: CapabilityLevelStatus::unsupported(
            "Wolf runtime replay is a utsushi-wolf node, not this adapter",
        ),
    }
}

/// The gate-relevant view of the helper boundary: the mechanically
/// derived outcome PLUS whether the boundary evidence is itself trustworthy
/// (it PASSED its own validation and raised no findings). The gate
/// requires the success posture on ALL of these — a `key_resolved` outcome
/// carried by a failed/finding-bearing boundary is refused, so the gate cannot
/// be bypassed by an outcome alone.
struct HelperBoundaryPosture {
    outcome: WolfHelperBoundaryOutcome,
    status: OperationStatus,
    finding_count: usize,
}

impl HelperBoundaryPosture {
    /// True iff the boundary evidence itself is trustworthy: it passed its own
    /// validation and raised no findings. Independent of the outcome.
    fn evidence_is_trustworthy(&self) -> bool {
        self.status == OperationStatus::Passed && self.finding_count == 0
    }
}

/// Decide whether the layered pipeline may run, or emit the unsupported-variant
/// diagnostic with the claimed-support tuple context.
fn classify_gate(
    engine_family: &str,
    protection_profile: WolfProtectionProfile,
    helper_posture: Option<&HelperBoundaryPosture>,
    detector_status: OperationStatus,
) -> Option<WolfAdapterCapabilityDiagnostic> {
    // The detector's own claimed-support tuple is the honest floor for an
    // unsupported variant: it is detector-only (never extract/patch).
    let claimed_support = derive_wolf_capability_tuple(protection_profile);

    if engine_family != WOLF_ENGINE_FAMILY {
        return Some(WolfAdapterCapabilityDiagnostic {
            semantic_code: SemanticErrorCode::UnknownEngineVariant.as_str().to_string(),
            field: "engineFamily".to_string(),
            message: format!(
                "Wolf adapter requires engineFamily={WOLF_ENGINE_FAMILY}, got {engine_family}"
            ),
            claimed_support,
        });
    }
    if detector_status != OperationStatus::Passed {
        return Some(WolfAdapterCapabilityDiagnostic {
            semantic_code: SemanticErrorCode::UnknownEngineVariant.as_str().to_string(),
            field: "detector".to_string(),
            message: "the container's protection detector evidence failed its own validation"
                .to_string(),
            claimed_support,
        });
    }

    match protection_profile {
        WolfProtectionProfile::Protected => match helper_posture {
            None => Some(WolfAdapterCapabilityDiagnostic {
                semantic_code: SemanticErrorCode::MissingKeyProfile.as_str().to_string(),
                field: "helperBoundary".to_string(),
                message: "a protected container needs a keyRef-bound helper-boundary profile; none supplied".to_string(),
                claimed_support,
            }),
            Some(posture) => classify_protected_helper_posture(posture, claimed_support),
        },
        WolfProtectionProfile::HelperRequired => {
            Some(WolfAdapterCapabilityDiagnostic {
                semantic_code: SemanticErrorCode::HelperRequired.as_str().to_string(),
                field: "protectionSignal".to_string(),
                message: "a Wolf \"Pro\" per-game dynamic-key container is not supported by this static-key adapter".to_string(),
                claimed_support,
            })
        }
        WolfProtectionProfile::Plain => Some(WolfAdapterCapabilityDiagnostic {
            semantic_code: SemanticErrorCode::UnsupportedLayeredTransform.as_str().to_string(),
            field: "protectionSignal".to_string(),
            message: "a plain unencrypted container is out of scope for this encrypted text-table adapter".to_string(),
            claimed_support,
        }),
        WolfProtectionProfile::Unknown => {
            Some(WolfAdapterCapabilityDiagnostic {
                semantic_code: SemanticErrorCode::UnsupportedVariantEncrypted.as_str().to_string(),
                field: "protectionSignal".to_string(),
                message: "an unrecognized Wolf protection variant cannot be extracted or patched"
                    .to_string(),
                claimed_support,
            })
        }
    }
}

/// Classify a `protected` container's helper-boundary posture. The gate is
/// non-bypassable: BEFORE trusting the derived outcome, the boundary evidence
/// itself must be trustworthy (it PASSED its own validation with no
/// findings). A `key_resolved` outcome carried by a failed/finding-bearing
/// boundary is refused with a key-validation diagnostic — it never reaches
/// extract/patch. Only a trustworthy `key_resolved` posture clears the gate.
fn classify_protected_helper_posture(
    posture: &HelperBoundaryPosture,
    claimed_support: WolfCapabilityTuple,
) -> Option<WolfAdapterCapabilityDiagnostic> {
    if !posture.evidence_is_trustworthy() {
        return Some(WolfAdapterCapabilityDiagnostic {
            semantic_code: SemanticErrorCode::KeyValidationFailed.as_str().to_string(),
            field: "helperBoundary".to_string(),
            message: "the helper-boundary evidence failed its own validation or raised blocking findings; extract/patch refused regardless of the reported outcome".to_string(),
            claimed_support,
        });
    }
    match posture.outcome {
        WolfHelperBoundaryOutcome::KeyResolved => None,
        WolfHelperBoundaryOutcome::KeyMissing => Some(WolfAdapterCapabilityDiagnostic {
            semantic_code: SemanticErrorCode::MissingKeyMaterial.as_str().to_string(),
            field: "helperBoundary".to_string(),
            message: "the static container key is not present in the local key store; extract/patch refused".to_string(),
            claimed_support,
        }),
        WolfHelperBoundaryOutcome::HelperRequired
        | WolfHelperBoundaryOutcome::HelperUnavailable => Some(WolfAdapterCapabilityDiagnostic {
            semantic_code: SemanticErrorCode::HelperRequired.as_str().to_string(),
            field: "helperBoundary".to_string(),
            message: "the container key is behind an unrun dynamic-key helper; extract/patch refused".to_string(),
            claimed_support,
        }),
    }
}

fn build_unsupported_report(
    fixture: &WolfTextTableAdapterFixture,
    protection_profile: WolfProtectionProfile,
    helper_outcome: Option<WolfHelperBoundaryOutcome>,
    diagnostic: WolfAdapterCapabilityDiagnostic,
) -> WolfTextTableAdapterReport {
    let claimed_support = diagnostic.claimed_support.clone();
    WolfTextTableAdapterReport {
        schema_version: WOLF_ADAPTER_SCHEMA_VERSION.to_string(),
        capability_id: WOLF_ADAPTER_CAPABILITY_ID.to_string(),
        source_node_id: fixture.source_node_id.clone(),
        support_boundary: WOLF_ADAPTER_SUPPORT_BOUNDARY.to_string(),
        cited_smoke_capability_id: WOLF_ADAPTER_CITED_SMOKE_CAPABILITY_ID.to_string(),
        fixture_id: fixture.fixture_id.clone(),
        engine_family: fixture.engine_family.clone(),
        outcome: WolfAdapterOutcome::Unsupported,
        protection_profile,
        helper_outcome,
        claimed_support,
        transform_legs: WolfAdapterTransformLegs::canonical(),
        secret_requirement_id: WOLF_ENCRYPTED_SMOKE_REQUIREMENT_ID.to_string(),
        secret_ref: fixture.secret_ref.clone(),
        key_material_hash: None,
        key_bytes: None,
        key_material_kind: KeyMaterialKind::FixedBytes,
        redaction_status: HelperRedactionStatus::Redacted,
        source_archive_hash: None,
        rebuilt_archive_hash: None,
        extract_manifest: Vec::new(),
        patch_reports: Vec::new(),
        unchanged_tables_verified: 0,
        verify_proof: None,
        capability_diagnostics: vec![diagnostic],
        delta_package_id: deterministic_id("kaifuu-wolf-adapter-delta", 12),
        status: OperationStatus::Passed,
    }
}

/// Drive the full extract → patch → repack → verify round-trip for a cleared gate.
fn run_supported(
    fixture: &WolfTextTableAdapterFixture,
    protection_profile: WolfProtectionProfile,
    helper_outcome: Option<WolfHelperBoundaryOutcome>,
    claimed_support: WolfCapabilityTuple,
) -> Result<WolfTextTableAdapterReport, WolfAdapterError> {
    // Resolve the container key BY REF (crypto layer). The key never
    // leaves the resolver's zeroize-on-drop holder.
    let resolver = WolfEncryptedFixtureSecretResolver::fixture_default();
    let key = resolver.resolve(WOLF_ENCRYPTED_SMOKE_REQUIREMENT_ID, &fixture.secret_ref)?;
    let key_material_hash = key.material_hash()?;
    let key_bytes = u32::try_from(key.byte_len()).unwrap_or(u32::MAX);

    // Layer 1+2: build the synthetic encrypted source container (
    // container+crypto), packing each text table's binary layout as a member.
    let source_members = encode_tables_to_members(&fixture.tables)?;
    let source_archive = pack_encrypted_archive(&source_members, key)?;
    let source_archive_hash = proof_hash(&source_archive)?;

    // Layer 1+2 (inverse): decrypt + extract the members.
    let extracted = decrypt_archive_members(&source_archive, key)?;

    // Layer 3: decode each member's Shift-JIS text table + build the manifest.
    let mut extract_manifest = Vec::with_capacity(extracted.len());
    for member in &extracted {
        let table = decode_wolf_text_table(&member.plaintext)?;
        extract_manifest.push(WolfAdapterTableDigest {
            table_name: table.table_name.clone(),
            record_count: table.records.len() as u32,
            field_count: table.field_count,
            text_cell_count: table.cell_count() as u32,
            member_hash: proof_hash(&member.plaintext)?,
            member_byte_len: member.plaintext.len() as u64,
        });
    }

    // Layer 3+4: apply the configured patches, re-encode, and record per-table
    // deterministic patch reports.
    let (patched_members, patch_reports) = apply_patches(&extracted, &fixture.patches)?;

    // Layer 1+2 (repack): re-encrypt + repack through the same container layer.
    let rebuilt_archive = pack_encrypted_archive(&patched_members, key)?;
    let rebuilt_archive_hash = proof_hash(&rebuilt_archive)?;

    // Verify: re-decrypt + re-decode and confirm the patched text is present and
    // every unchanged table is byte-identical.
    let verified = decrypt_archive_members(&rebuilt_archive, key)?;
    let (patch_reports, unchanged_tables_verified) =
        verify_round_trip(&extracted, &verified, &fixture.patches, patch_reports)?;
    let verify_proof = build_verify_proof(&verified)?;

    let report = WolfTextTableAdapterReport {
        schema_version: WOLF_ADAPTER_SCHEMA_VERSION.to_string(),
        capability_id: WOLF_ADAPTER_CAPABILITY_ID.to_string(),
        source_node_id: fixture.source_node_id.clone(),
        support_boundary: WOLF_ADAPTER_SUPPORT_BOUNDARY.to_string(),
        cited_smoke_capability_id: WOLF_ADAPTER_CITED_SMOKE_CAPABILITY_ID.to_string(),
        fixture_id: fixture.fixture_id.clone(),
        engine_family: fixture.engine_family.clone(),
        outcome: WolfAdapterOutcome::Supported,
        protection_profile,
        helper_outcome,
        claimed_support,
        transform_legs: WolfAdapterTransformLegs::canonical(),
        secret_requirement_id: WOLF_ENCRYPTED_SMOKE_REQUIREMENT_ID.to_string(),
        secret_ref: fixture.secret_ref.clone(),
        key_material_hash: Some(key_material_hash),
        key_bytes: Some(key_bytes),
        key_material_kind: KeyMaterialKind::FixedBytes,
        redaction_status: HelperRedactionStatus::Redacted,
        source_archive_hash: Some(source_archive_hash),
        rebuilt_archive_hash: Some(rebuilt_archive_hash),
        extract_manifest,
        patch_reports,
        unchanged_tables_verified,
        verify_proof: Some(verify_proof),
        capability_diagnostics: Vec::new(),
        delta_package_id: deterministic_id("kaifuu-wolf-adapter-delta", 12),
        status: OperationStatus::Passed,
    };

    // No-leak guard: the emitted report must never carry the raw key.
    let json = report
        .stable_json()
        .map_err(|error| WolfAdapterError::Internal {
            message: error.to_string(),
        })?;
    if key.appears_in(json.as_bytes()) {
        return Err(WolfAdapterError::Internal {
            message: "refusing to emit a report that leaks raw key material".to_string(),
        });
    }
    Ok(report)
}

fn encode_tables_to_members(
    tables: &[WolfTextTable],
) -> Result<Vec<WolfPlainMember>, WolfAdapterError> {
    tables
        .iter()
        .map(|table| {
            Ok(WolfPlainMember {
                member_id: table.member_id(),
                plaintext: encode_wolf_text_table(table)?,
            })
        })
        .collect()
}

/// Apply the configured patch requests to the extracted members, returning the
/// patched members and a per-table deterministic patch report (pre-verification).
fn apply_patches(
    extracted: &[WolfPlainMember],
    patches: &[WolfTextPatchRequest],
) -> Result<(Vec<WolfPlainMember>, Vec<WolfAdapterTablePatchReport>), WolfAdapterError> {
    let mut patched_members = Vec::with_capacity(extracted.len());
    let mut reports: Vec<WolfAdapterTablePatchReport> = Vec::new();

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

        let mut coordinates = Vec::with_capacity(member_patches.len());
        for patch in &member_patches {
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
            cell.clone_from(&patch.new_text);
            coordinates.push(WolfAdapterPatchCoordinate {
                record_index: patch.record_index,
                field_index: patch.field_index,
            });
        }

        let patched_bytes = encode_wolf_text_table(&table)?;
        // `layout_changed` proves EXACTLY the offset-table rewrite it claims: the
        // (offset,len) string-table index differs after repack (a downstream
        // offset shifted or a cell length changed). A same-length patch that only
        // swaps blob bytes in place changes the member (hashes differ) but NOT the
        // layout — this stays honestly false for it.
        let layout_changed =
            read_offset_index(&member.plaintext)? != read_offset_index(&patched_bytes)?;
        reports.push(WolfAdapterTablePatchReport {
            table_name: table.table_name.clone(),
            coordinates,
            source_member_hash: proof_hash(&member.plaintext)?,
            patched_member_hash: proof_hash(&patched_bytes)?,
            source_member_byte_len: member.plaintext.len() as u64,
            patched_member_byte_len: patched_bytes.len() as u64,
            layout_changed,
            // Filled in during verification.
            patched_text_verified: false,
        });
        patched_members.push(WolfPlainMember {
            member_id: member.member_id.clone(),
            plaintext: patched_bytes,
        });
    }

    Ok((patched_members, reports))
}
