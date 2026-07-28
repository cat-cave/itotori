//! Wolf readiness combiner and proof validation.

use super::*;

// The resolver (the combiner)

/// Run the Wolf readiness combiner over a fixture set. Each case runs the REAL
/// detector and REAL helper-boundary subsystems over its embedded evidence and
/// combines their derived outputs into the achieved level mechanically; the
/// declared expectation is used only to raise findings. Never panics.
pub fn run_wolf_readiness(fixture: &WolfReadinessFixture) -> WolfReadinessReport {
    // Genuinely run the extract-patch-verify smoke ONCE. Its
    // per-variant round-trip output is the source of truth the `extract`/`patch`
    // rungs bind to. If the smoke does not pass (e.g. a broken profiled fixture),
    // NO case can honor an extract/patch proof and the top rungs stay unreached —
    // readiness never claims `patch-proven` without a verified smoke.
    let smoke = run_wolf_extract_patch_verify_smoke(&fixture.source_node_id).ok();
    let mut entries = Vec::with_capacity(fixture.cases.len());
    for case in &fixture.cases {
        entries.push(resolve_case(
            case,
            &fixture.source_node_id,
            &fixture.engine_family,
            smoke.as_ref(),
        ));
    }
    let status = aggregate_status(&entries);
    WolfReadinessReport {
        schema_version: WOLF_READINESS_REPORT_SCHEMA_VERSION.to_string(),
        readiness_set_id: fixture.readiness_set_id.clone(),
        source_node_id: fixture.source_node_id.clone(),
        engine_family: fixture.engine_family.clone(),
        support_boundary: WOLF_READINESS_SUPPORT_BOUNDARY.to_string(),
        status,
        entries,
    }
}

fn aggregate_status(entries: &[WolfReadinessEntryReport]) -> OperationStatus {
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
    case: &WolfReadinessCase,
    source_node_id: &str,
    engine_family: &str,
    smoke: Option<&WolfExtractPatchVerifySmokeReport>,
) -> WolfReadinessEntryReport {
    let mut findings: Vec<WolfReadinessFinding> = Vec::new();

    if engine_family != WOLF_ENGINE_FAMILY {
        findings.push(WolfReadinessFinding {
            code: "wolf.readiness.wrong_engine_family".to_string(),
            field: "engineFamily".to_string(),
            message: format!(
                "Wolf readiness requires engineFamily={WOLF_ENGINE_FAMILY}, got {engine_family}"
            ),
        });
    }

    let detector_report = run_wolf_protection_detector(&WolfProtectionDetectorFixture {
        schema_version: crate::wolf_protection_detector::WOLF_PROTECTION_DETECTOR_SCHEMA_VERSION
            .to_string(),
        detector_set_id: format!("wolf-readiness/{}/detector", case.case_id),
        source_node_id: source_node_id.to_string(),
        engine_family: engine_family.to_string(),
        entries: vec![case.detector.clone()],
    });
    let detector_entry = detector_report
        .entries
        .into_iter()
        .next()
        .expect("single-entry detector fixture yields exactly one entry");
    if detector_entry.status != OperationStatus::Passed {
        findings.push(WolfReadinessFinding {
            code: "wolf.readiness.detector_evidence_failed".to_string(),
            field: "detector".to_string(),
            message: "the embedded detector record failed its own validation".to_string(),
        });
    }
    let protection_profile = detector_entry.profile;

    let helper_entry: Option<WolfHelperBoundaryEntryReport> = case.helper_boundary.as_ref().map(
        |profile: &WolfHelperBoundaryProfile| {
            let report = run_wolf_helper_boundary(&WolfHelperBoundaryFixture {
                schema_version: crate::wolf_helper_boundary::WOLF_HELPER_BOUNDARY_SCHEMA_VERSION
                    .to_string(),
                boundary_set_id: format!("wolf-readiness/{}/helper-boundary", case.case_id),
                source_node_id: source_node_id.to_string(),
                engine_family: engine_family.to_string(),
                profiles: vec![profile.clone()],
            });
            report
                .entries
                .into_iter()
                .next()
                .expect("single-profile helper-boundary fixture yields exactly one entry")
        },
    );
    if let Some(entry) = &helper_entry
        && entry.status != OperationStatus::Passed
    {
        findings.push(WolfReadinessFinding {
            code: "wolf.readiness.helper_boundary_evidence_failed".to_string(),
            field: "helperBoundary".to_string(),
            message: "the embedded helper-boundary profile failed its own validation".to_string(),
        });
    }
    let helper_outcome = helper_entry.as_ref().map(|entry| entry.outcome);

    // A keyRef-bound profile (protected / helper-required) whose case supplied a
    // helper boundary must serve the MATCHING protection profile — otherwise the
    // two evidence halves disagree about what archive we are looking at.
    if let Some(entry) = &helper_entry
        && entry.protection_profile != protection_profile
    {
        findings.push(WolfReadinessFinding {
            code: "wolf.readiness.evidence_profile_mismatch".to_string(),
            field: "helperBoundary.boundaryKind".to_string(),
            message: format!(
                "detector classified {} but the helper boundary serves {}",
                protection_profile.as_str(),
                entry.protection_profile.as_str()
            ),
        });
    }

    // A proof is honored ONLY when its declared hash matches the SMOKE-BOUND
    // canonical value from a genuinely-run round-trip. If the smoke
    // itself did not pass, no proof is honored and a declared proof is a loud
    // finding — the readiness `patch` rung cannot be reached without a verified
    // smoke.
    let extract_proven = honor_proof(
        case.extract_proof.as_ref(),
        WolfReadinessArtifactKind::SyntheticExtractFixture,
        "extractProof",
        smoke,
        &mut findings,
    );
    let mut patch_proven = honor_proof(
        case.patch_proof.as_ref(),
        WolfReadinessArtifactKind::SyntheticPatchFixture,
        "patchProof",
        smoke,
        &mut findings,
    );
    // Patch-back cannot be proven without extraction.
    if patch_proven && !extract_proven {
        findings.push(WolfReadinessFinding {
            code: "wolf.readiness.patch_without_extract".to_string(),
            field: "patchProof".to_string(),
            message: "a patch proof requires a matching extract proof (cannot patch back what cannot be extracted)".to_string(),
        });
        patch_proven = false;
    }

    let evidence = WolfReadinessEvidence {
        protection_profile,
        helper_outcome,
        extract_proven,
        patch_proven,
    };
    let readiness_level = derive_wolf_readiness_level(&evidence);

    // Honesty guard (defensive; structurally impossible): the extract/patch
    // rungs must be backed by an honored proof.
    if readiness_level.claims_extraction() && !extract_proven {
        findings.push(WolfReadinessFinding {
            code: "wolf.readiness.overclaimed_extraction".to_string(),
            field: "readinessLevel".to_string(),
            message: format!(
                "level {} claims extraction without an honored synthetic extract proof",
                readiness_level.as_str()
            ),
        });
    }

    // Declared-vs-derived expectation.
    if case.expected_level != readiness_level {
        findings.push(WolfReadinessFinding {
            code: "wolf.readiness.level_mismatch".to_string(),
            field: "expectedLevel".to_string(),
            message: format!(
                "case declared level {} but the combiner derived {}",
                case.expected_level.as_str(),
                readiness_level.as_str()
            ),
        });
    }

    // Assemble the auditable proof hashes + secret requirement ids.
    let mut proof_hashes: Vec<ProofHash> = Vec::new();
    let mut secret_requirement_ids: Vec<String> = Vec::new();
    if let Some(entry) = &helper_entry {
        proof_hashes.extend(
            entry
                .proof_hashes
                .iter()
                .map(|proof| proof.proof_hash.clone()),
        );
        secret_requirement_ids.extend(entry.secret_requirement_ids.iter().cloned());
    }
    if extract_proven && let Some(proof) = &case.extract_proof {
        proof_hashes.push(proof.proof_hash.clone());
    }
    if patch_proven && let Some(proof) = &case.patch_proof {
        proof_hashes.push(proof.proof_hash.clone());
    }

    let claim_basis = build_claim_basis(&evidence, readiness_level);

    let status = if findings.is_empty() {
        OperationStatus::Passed
    } else {
        OperationStatus::Failed
    };

    WolfReadinessEntryReport {
        fixture_id: case.fixture_id.clone(),
        source_node_id: source_node_id.to_string(),
        engine_family: engine_family.to_string(),
        case_id: case.case_id.clone(),
        protection_profile,
        helper_outcome,
        readiness_level,
        claim_basis,
        secret_requirement_ids,
        proof_hashes,
        detector: detector_entry,
        helper_boundary: helper_entry,
        status,
        findings,
    }
}

/// Validate an optional artifact proof and return whether it is HONORED (present
/// AND valid). An invalid (fabricated-hash / wrong-kind) proof is a finding and
/// is NOT honored — the rung it would unlock stays unclaimed.
fn honor_proof(
    proof: Option<&WolfReadinessArtifactProof>,
    expected: WolfReadinessArtifactKind,
    field: &str,
    smoke: Option<&WolfExtractPatchVerifySmokeReport>,
    findings: &mut Vec<WolfReadinessFinding>,
) -> bool {
    let Some(proof) = proof else {
        return false;
    };
    if proof.artifact_id.trim().is_empty() {
        findings.push(WolfReadinessFinding {
            code: "wolf.readiness.artifact_id_missing".to_string(),
            field: field.to_string(),
            message: "an extract/patch proof is missing a non-empty artifactId".to_string(),
        });
        return false;
    }
    // The extract/patch rungs GATE on a genuinely-run smoke. If the smoke did
    // not pass, a declared proof cannot be honored — fail loud, never silent.
    let Some(smoke) = smoke else {
        findings.push(WolfReadinessFinding {
            code: "wolf.readiness.smoke_not_proven".to_string(),
            field: field.to_string(),
            message: format!(
                "the {} rung requires a passing  extract-patch-verify smoke, but the smoke did not pass",
                expected.as_str()
            ),
        });
        return false;
    };
    if !proof.is_valid_for(expected, smoke) {
        findings.push(WolfReadinessFinding {
            code: "wolf.readiness.artifact_proof_invalid".to_string(),
            field: field.to_string(),
            message: format!(
                "the {} proof hash does not match the smoke-bound canonical value (label-only/fabricated/wrong-kind proof, not backed by a genuinely-run round-trip)",
                expected.as_str()
            ),
        });
        return false;
    }
    true
}

fn build_claim_basis(evidence: &WolfReadinessEvidence, level: WolfReadinessLevel) -> String {
    let detector = format!(
        "detector classified {}",
        evidence.protection_profile.as_str()
    );
    let helper = match evidence.helper_outcome {
        Some(outcome) => format!("; helper boundary reported {}", outcome.as_str()),
        None => String::new(),
    };
    let proofs = match (evidence.extract_proven, evidence.patch_proven) {
        (true, true) => "; synthetic extract + patch fixtures proven",
        (true, false) => "; synthetic extract fixture proven",
        _ => "",
    };
    format!(
        "achieved {}: {}{}{}",
        level.as_str(),
        detector,
        helper,
        proofs
    )
}
