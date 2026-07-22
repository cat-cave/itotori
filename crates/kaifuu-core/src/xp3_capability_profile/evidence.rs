use super::*;

/// Derive the evidence for one entry from its detector / helper / archive
/// inputs. Returns `Err(finding)` only when an input is structurally
/// unusable; routing-level problems are accumulated into `findings`.
pub(super) fn derive_evidence(
    entry: &Xp3CapabilityProfileFixtureEntry,
    fixture_dir: &Path,
) -> Result<DerivedEvidence, Xp3CapabilityFinding> {
    if entry.variant.carries_archive() {
        derive_archive_evidence(entry, fixture_dir)
    } else {
        derive_plaintext_ks_evidence(entry, fixture_dir)
    }
}

fn derive_archive_evidence(
    entry: &Xp3CapabilityProfileFixtureEntry,
    fixture_dir: &Path,
) -> Result<DerivedEvidence, Xp3CapabilityFinding> {
    let detector_rel = entry.detector_fixture.as_deref().ok_or_else(|| {
        finding(
            "xp3.capability.detector_fixture_missing",
            PartialDiagnosticSeverity::P0,
            "detectorFixture",
            format!(
                "variant {} requires a detectorFixture",
                entry.variant.as_str()
            ),
            SEMANTIC_CAPABILITY_EVIDENCE_MISMATCH,
        )
    })?;
    let detector_path = fixture_dir.join(detector_rel);
    let detector_dir = detector_path
        .parent()
        .ok_or_else(|| {
            finding(
                "xp3.capability.detector_fixture_path",
                PartialDiagnosticSeverity::P0,
                "detectorFixture",
                "detectorFixture path must have a parent directory".to_string(),
                SEMANTIC_CAPABILITY_EVIDENCE_MISMATCH,
            )
        })?
        .to_path_buf();
    let proof_fixture: Xp3ProfileProofFixture = read_json(&detector_path).map_err(|error| {
        finding(
            "xp3.capability.detector_fixture_unreadable",
            PartialDiagnosticSeverity::P0,
            "detectorFixture",
            format!(
                "detector fixture could not be read: {}",
                redact_for_log_or_report(&error.to_string())
            ),
            SEMANTIC_CAPABILITY_EVIDENCE_MISMATCH,
        )
    })?;

    let proof = xp3_profile_proof(Xp3ProfileProofRequest {
        fixture: &proof_fixture,
        fixture_dir: &detector_dir,
    })
    .map_err(|error| {
        finding(
            "xp3.capability.detector_proof_errored",
            PartialDiagnosticSeverity::P0,
            "detectorFixture",
            format!(
                "detector proof errored: {}",
                redact_for_log_or_report(&error.to_string())
            ),
            SEMANTIC_CAPABILITY_EVIDENCE_MISMATCH,
        )
    })?;

    let mut findings = Vec::new();
    // The detector proof legitimately reports a `Failed` status for the
    // research-tier variants — the P1 routing diagnostic (encrypted /
    // helper-required / protected-executable) is exactly the detector flagging
    // the variant as unsupported. A `Failed` status is only *bad* detector
    // evidence for the claimed-support concern: a plain archive must produce a
    // clean detector proof, or its patch-back claim is unfounded.
    if entry.variant.expected_classification() == Some(Xp3ProfileClassification::Plain)
        && proof.status == OperationStatus::Failed
    {
        findings.push(finding(
            "xp3.capability.detector_evidence_failed",
            PartialDiagnosticSeverity::P0,
            "detectorFixture",
            "plain XP3 detector proof reported a failed status (bad detector evidence)".to_string(),
            SEMANTIC_CAPABILITY_EVIDENCE_MISMATCH,
        ));
    }

    // Helper-result evidence (optional): corroborates the helper requirement
    // and keyRef state.
    let helper_result_present = entry.helper_result_fixture.is_some();
    if let Some(helper_rel) = entry.helper_result_fixture.as_deref() {
        let helper_path = fixture_dir.join(helper_rel);
        match read_json::<HelperResult>(&helper_path) {
            Ok(helper) => {
                cross_check_helper_evidence(entry, &proof, &helper, &mut findings);
            }
            Err(error) => findings.push(finding(
                "xp3.capability.helper_result_unreadable",
                PartialDiagnosticSeverity::P0,
                "helperResultFixture",
                format!(
                    "helper result could not be read: {}",
                    redact_for_log_or_report(&error.to_string())
                ),
                SEMANTIC_CAPABILITY_EVIDENCE_MISMATCH,
            )),
        }
    }

    Ok(DerivedEvidence {
        fixture_id: proof.fixture_id,
        classification: Some(proof.classification),
        patch_capability: proof.patch_capability_level,
        helper_requirement: proof.helper_requirement,
        crypt_profile_status: proof.crypt_profile.status,
        key_ref_present: proof.crypt_profile.key_ref_requirement_present,
        requirement_id: proof.crypt_profile.requirement_id,
        secret_ref: proof.crypt_profile.secret_ref,
        archive_id: proof.archive.archive_id,
        archive_hash: proof.archive.archive_hash,
        entry_count: proof.archive.entry_count,
        helper_result_present,
        findings,
    })
}

fn derive_plaintext_ks_evidence(
    entry: &Xp3CapabilityProfileFixtureEntry,
    fixture_dir: &Path,
) -> Result<DerivedEvidence, Xp3CapabilityFinding> {
    let source_rel = entry.plaintext_source.as_deref().ok_or_else(|| {
        finding(
            "xp3.capability.plaintext_source_missing",
            PartialDiagnosticSeverity::P0,
            "plaintextSource",
            "plaintext_ks variant requires a plaintextSource".to_string(),
            SEMANTIC_CAPABILITY_EVIDENCE_MISMATCH,
        )
    })?;
    let source_path = fixture_dir.join(source_rel);
    let bytes = std::fs::read(&source_path).map_err(|error| {
        finding(
            "xp3.capability.plaintext_source_unreadable",
            PartialDiagnosticSeverity::P0,
            "plaintextSource",
            format!(
                "plaintext source could not be read: {}",
                redact_for_log_or_report(&error.to_string())
            ),
            SEMANTIC_CAPABILITY_EVIDENCE_MISMATCH,
        )
    })?;

    let mut findings = Vec::new();
    // A null container is plaintext — it must NOT carry the XP3 archive magic.
    // If it does, the entry is mis-classified (it is really an archive, not the
    // null-container baseline).
    if bytes.starts_with(b"XP3") {
        findings.push(finding(
            "xp3.capability.plaintext_is_archive",
            PartialDiagnosticSeverity::P0,
            "plaintextSource",
            "plaintext_ks source carries XP3 archive magic; it is not a null container".to_string(),
            SEMANTIC_CAPABILITY_EVIDENCE_MISMATCH,
        ));
    }

    let archive_hash = ProofHash::new(sha256_hash_bytes(&bytes))
        .map_err(|error| internal_finding("plaintext hash", &error))?;

    Ok(DerivedEvidence {
        fixture_id: format!("{}-null-container", entry.entry_id),
        // None classification => derive_support_tier yields NullContainer.
        classification: None,
        // The null container is plaintext; we detect it but do not advance a
        // patch-back claim (that claim belongs to plain XP3 archives only).
        patch_capability: Xp3PatchCapabilityLevel::Detect,
        helper_requirement: Xp3HelperRequirement::NotRequired,
        crypt_profile_status: Xp3CryptProfileStatus::NotRequired,
        key_ref_present: false,
        requirement_id: None,
        secret_ref: None,
        archive_id: "kirikiri-ks-null-container".to_string(),
        archive_hash,
        entry_count: None,
        helper_result_present: false,
        findings,
    })
}

/// Cross-check a helper result against the detector evidence: a
/// helper-required archive must carry a helper-required diagnostic, and the
/// helper's keyRef requirement id must match the crypt-profile requirement id.
fn cross_check_helper_evidence(
    entry: &Xp3CapabilityProfileFixtureEntry,
    proof: &crate::Xp3ProfileProofReport,
    helper: &HelperResult,
    findings: &mut Vec<Xp3CapabilityFinding>,
) {
    if entry.variant == Xp3CapabilityVariant::HelperRequiredXp3
        && helper.diagnostic.code != HelperDiagnosticCode::HelperRequired
    {
        findings.push(finding(
            "xp3.capability.helper_diagnostic_mismatch",
            PartialDiagnosticSeverity::P0,
            "helperResultFixture",
            "helper-required variant must reference a helper result whose diagnostic is helper_required"
                .to_string(),
            SEMANTIC_CAPABILITY_EVIDENCE_MISMATCH,
        ));
    }
    if let Some(requirement_id) = proof.crypt_profile.requirement_id.as_deref() {
        let matches = helper
            .secret_refs
            .iter()
            .any(|secret| secret.requirement_id == requirement_id);
        if !matches {
            findings.push(finding(
                "xp3.capability.helper_requirement_id_mismatch",
                PartialDiagnosticSeverity::P0,
                "helperResultFixture",
                "helper result declares no secretRef matching the crypt-profile requirement id"
                    .to_string(),
                SEMANTIC_CAPABILITY_EVIDENCE_MISMATCH,
            ));
        }
    }
}
