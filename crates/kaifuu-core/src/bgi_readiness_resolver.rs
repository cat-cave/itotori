use std::path::Path;

use super::*;
use crate::bgi_bytecode_fixture::{
    BGI_BYTECODE_FIXTURE_SCHEMA_VERSION, BgiBytecodeEntryReport, BgiBytecodeFixture,
    run_bgi_bytecode_fixture,
};
use crate::bgi_detector_fixture::{
    BGI_DETECTOR_FIXTURE_SCHEMA_VERSION, BGI_ENGINE_FAMILY, BgiDetectorEntryReport,
    BgiDetectorFixture, run_bgi_detector_fixture,
};
use crate::{KaifuuResult, OperationStatus, ProofHash, read_json};

/// Run the BGI readiness combiner over a fixture set. Each case runs the REAL
/// detector and REAL bytecode parser over its embedded evidence and combines
/// their derived outputs into the achieved level mechanically; the declared
/// expectation is used only to raise findings. Never panics.
pub fn run_bgi_readiness(fixture: &BgiReadinessFixture) -> BgiReadinessReport {
    let mut entries = Vec::with_capacity(fixture.cases.len());
    for case in &fixture.cases {
        entries.push(resolve_case(
            case,
            &fixture.source_node_id,
            &fixture.engine_family,
        ));
    }
    let status = aggregate_status(&entries);
    BgiReadinessReport {
        schema_version: BGI_READINESS_REPORT_SCHEMA_VERSION.to_string(),
        readiness_set_id: fixture.readiness_set_id.clone(),
        source_node_id: fixture.source_node_id.clone(),
        engine_family: fixture.engine_family.clone(),
        support_boundary: BGI_READINESS_SUPPORT_BOUNDARY.to_string(),
        status,
        entries,
    }
}

fn aggregate_status(entries: &[BgiReadinessEntryReport]) -> OperationStatus {
    if entries
        .iter()
        .all(|entry| matches!(entry.status, OperationStatus::Passed))
    {
        OperationStatus::Passed
    } else {
        OperationStatus::Failed
    }
}

fn resolve_case(
    case: &BgiReadinessCase,
    source_node_id: &str,
    engine_family: &str,
) -> BgiReadinessEntryReport {
    let mut findings: Vec<BgiReadinessFinding> = Vec::new();

    if engine_family != BGI_ENGINE_FAMILY {
        findings.push(BgiReadinessFinding {
            code: "bgi.readiness.wrong_engine_family".to_string(),
            field: "engineFamily".to_string(),
            message: format!(
                "BGI readiness requires engineFamily={BGI_ENGINE_FAMILY}, got {engine_family}"
            ),
        });
    }

    // The embedded record keeps its provenance node (its tuple proof
    // hash binds the source node); this readiness node CONSUMES that evidence.
    let detector_entry: Option<BgiDetectorEntryReport> = case.detector.as_ref().map(|entry| {
        let report = run_bgi_detector_fixture(&BgiDetectorFixture {
            schema_version: BGI_DETECTOR_FIXTURE_SCHEMA_VERSION.to_string(),
            detector_set_id: format!("bgi-readiness/{}/detector", case.case_id),
            source_node_id: BGI_READINESS_DETECTOR_PROVENANCE_NODE.to_string(),
            engine_family: engine_family.to_string(),
            entries: vec![entry.clone()],
        });
        report
            .entries
            .into_iter()
            .next()
            .expect("single-entry detector fixture yields exactly one entry")
    });
    let detector_failed = detector_entry
        .as_ref()
        .is_some_and(|entry| entry.status != OperationStatus::Passed);
    if detector_failed {
        findings.push(BgiReadinessFinding {
            code: "bgi.readiness.detector_evidence_failed".to_string(),
            field: "detector".to_string(),
            message: "the embedded detector record failed its own validation".to_string(),
        });
    }
    // A failed detector profile is auditable through `detector`, but it cannot
    // open the container gate or contribute to the achieved level.
    let container_profile = detector_entry
        .as_ref()
        .filter(|entry| entry.status == OperationStatus::Passed)
        .map(|entry| entry.profile);

    let bytecode_entry: Option<BgiBytecodeEntryReport> = case.bytecode.as_ref().map(|entry| {
        let report = run_bgi_bytecode_fixture(&BgiBytecodeFixture {
            schema_version: BGI_BYTECODE_FIXTURE_SCHEMA_VERSION.to_string(),
            profile_set_id: format!("bgi-readiness/{}/bytecode", case.case_id),
            source_node_id: BGI_READINESS_BYTECODE_PROVENANCE_NODE.to_string(),
            engine_family: engine_family.to_string(),
            entries: vec![entry.clone()],
        });
        report
            .entries
            .into_iter()
            .next()
            .expect("single-entry bytecode fixture yields exactly one entry")
    });
    if let Some(entry) = &bytecode_entry
        && entry.status != OperationStatus::Passed
    {
        findings.push(BgiReadinessFinding {
            code: "bgi.readiness.bytecode_evidence_failed".to_string(),
            field: "bytecode".to_string(),
            message: "the embedded bytecode profile failed its own validation".to_string(),
        });
    }
    // Inventory is proven ONLY when the parser passed AND actually enumerated at
    // least one string-reference surface — a failed or empty parse proves nothing.
    let inventory_surface_count = bytecode_entry
        .as_ref()
        .filter(|entry| entry.status == OperationStatus::Passed)
        .map_or(0, |entry| entry.string_references.len());
    let inventory_proven = inventory_surface_count > 0;

    let extract_proven = honor_proof(
        case.extract_proof.as_ref(),
        BgiReadinessArtifactKind::SyntheticExtractFixture,
        "extractProof",
        &mut findings,
    );
    let mut patch_proven = honor_proof(
        case.patch_proof.as_ref(),
        BgiReadinessArtifactKind::SyntheticPatchFixture,
        "patchProof",
        &mut findings,
    );
    // Patch-back cannot be proven without extraction.
    if patch_proven && !extract_proven {
        findings.push(BgiReadinessFinding {
            code: "bgi.readiness.patch_without_extract".to_string(),
            field: "patchProof".to_string(),
            message: "a patch proof requires a matching extract proof (cannot patch back what cannot be extracted)".to_string(),
        });
        patch_proven = false;
    }
    // Patch readiness also requires a VERIFIED bytecode extract-to-patch
    // round-trip: non-empty patch_reports whose patched text + untouched bytes
    // actually verified. A bare synthetic patchProof hash alone is not enough.
    let bytecode_patch_verified = bytecode_entry.as_ref().is_some_and(|entry| {
        entry.status == OperationStatus::Passed
            && !entry.patch_reports.is_empty()
            && entry
                .patch_reports
                .iter()
                .all(|report| report.patched_text_verified && report.untouched_bytes_identical)
    });
    if patch_proven && !bytecode_patch_verified {
        findings.push(BgiReadinessFinding {
            code: "bgi.readiness.bytecode_patch_proof_missing".to_string(),
            field: "bytecode.patchCases".to_string(),
            message: "a patch readiness level requires a verified bytecode extract-to-patch round-trip (non-empty verified patch_reports from the embedded bytecode profile)".to_string(),
        });
        patch_proven = false;
    }

    let evidence = BgiReadinessEvidence {
        container_profile,
        detector_failed,
        inventory_proven,
        extract_proven,
        patch_proven,
    };
    let readiness_level = derive_bgi_readiness_level(&evidence);

    // Honesty guard (defensive; structurally impossible): the extract/patch rungs
    // must be backed by an honored proof.
    if readiness_level.claims_extraction() && !extract_proven {
        findings.push(BgiReadinessFinding {
            code: "bgi.readiness.overclaimed_extraction".to_string(),
            field: "readinessLevel".to_string(),
            message: format!(
                "level {} claims extraction without an honored synthetic extract proof",
                readiness_level.as_str()
            ),
        });
    }

    // Declared-vs-derived expectation.
    if case.expected_level != readiness_level {
        findings.push(BgiReadinessFinding {
            code: "bgi.readiness.level_mismatch".to_string(),
            field: "expectedLevel".to_string(),
            message: format!(
                "case declared level {} but the combiner derived {}",
                case.expected_level.as_str(),
                readiness_level.as_str()
            ),
        });
    }

    // Assemble the auditable proof hashes.
    let mut proof_hashes: Vec<ProofHash> = Vec::new();
    if let Some(entry) = &detector_entry {
        proof_hashes.extend(entry.proof_hashes.iter().cloned());
    }
    if let Some(entry) = &bytecode_entry {
        proof_hashes.extend(entry.proof_hashes.iter().cloned());
    }
    if extract_proven && let Some(proof) = &case.extract_proof {
        proof_hashes.push(proof.proof_hash.clone());
    }
    if patch_proven && let Some(proof) = &case.patch_proof {
        proof_hashes.push(proof.proof_hash.clone());
    }

    let claim_basis = build_claim_basis(&evidence, inventory_surface_count, readiness_level);

    let status = if findings.is_empty() {
        OperationStatus::Passed
    } else {
        OperationStatus::Failed
    };

    BgiReadinessEntryReport {
        fixture_id: case.fixture_id.clone(),
        source_node_id: source_node_id.to_string(),
        engine_family: engine_family.to_string(),
        case_id: case.case_id.clone(),
        container_profile,
        inventory_surface_count,
        readiness_level,
        claim_basis,
        proof_hashes,
        detector: detector_entry,
        bytecode: bytecode_entry,
        status,
        findings,
    }
}

/// Validate an optional artifact proof and return whether it is HONORED (present
/// AND valid). An invalid (fabricated-hash / wrong-kind) proof is a finding and
/// is NOT honored — the rung it would unlock stays unclaimed.
fn honor_proof(
    proof: Option<&BgiReadinessArtifactProof>,
    expected: BgiReadinessArtifactKind,
    field: &str,
    findings: &mut Vec<BgiReadinessFinding>,
) -> bool {
    let Some(proof) = proof else {
        return false;
    };
    if proof.artifact_id.trim().is_empty() {
        findings.push(BgiReadinessFinding {
            code: "bgi.readiness.artifact_id_missing".to_string(),
            field: field.to_string(),
            message: "an extract/patch proof is missing a non-empty artifactId".to_string(),
        });
        return false;
    }
    if !proof.is_valid_for(expected) {
        findings.push(BgiReadinessFinding {
            code: "bgi.readiness.artifact_proof_invalid".to_string(),
            field: field.to_string(),
            message: format!(
                "the {} proof hash does not match the canonical recomputation (or wrong kind)",
                expected.as_str()
            ),
        });
        return false;
    }
    true
}

fn build_claim_basis(
    evidence: &BgiReadinessEvidence,
    inventory_surface_count: usize,
    level: BgiReadinessLevel,
) -> String {
    let detector = if evidence.detector_failed {
        "container detector did not pass validation".to_string()
    } else {
        match evidence.container_profile {
            Some(profile) => format!("detector classified {}", profile.as_str()),
            None => "no container record (pure scenario-bytecode artifact)".to_string(),
        }
    };
    let inventory = if evidence.inventory_proven {
        format!(
            "; bytecode parser enumerated {inventory_surface_count} string-reference surface(s)"
        )
    } else {
        String::new()
    };
    let proofs = match (evidence.extract_proven, evidence.patch_proven) {
        (true, true) => {
            "; synthetic extract + patch fixtures proven with verified bytecode extract-to-patch"
        }
        (true, false) => "; synthetic extract fixture proven",
        _ => "",
    };
    format!(
        "achieved {}: {}{}{}",
        level.as_str(),
        detector,
        inventory,
        proofs
    )
}

/// Load a BGI readiness fixture set from disk.
pub fn read_bgi_readiness_fixture(path: &Path) -> KaifuuResult<BgiReadinessFixture> {
    read_json(path)
}
