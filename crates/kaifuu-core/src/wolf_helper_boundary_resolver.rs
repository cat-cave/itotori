use super::*;

// The resolver (the local-only helper-boundary builder)

const WOLF_HELPER_BOUNDARY_REDACTED_LOG_HASH: &str =
    "sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd";

/// Build the local-only [`HelperResult`] for a keyRef-bound Wolf
/// helper-boundary profile. The key is resolved BY REF: the returned result
/// carries the secret ref (requirement id + local-scheme ref) and — only when
/// the key resolved — a validation proof hash. It never runs the helper and
/// never emits raw key material.
pub fn resolve_wolf_helper_boundary(profile: &WolfHelperBoundaryProfile) -> HelperResult {
    let kind = profile.boundary_kind;
    let outcome = derive_wolf_helper_boundary_outcome(kind, profile.locally_available);

    // The validation proof is present ONLY when the key resolved locally. It is
    // a sha256 hash over a synthetic proof label — never key bytes.
    let validation = outcome.recovered_key().then(|| KeyValidationProof {
        method: KeyValidationMethod::ArchiveIndexProof,
        proof_hash: ProofHash::new(sha256_hash_bytes(
            format!(
                "wolf-helper-boundary/{}/{}/archive-index-proof",
                profile.profile_id, profile.key_requirement.requirement_id
            )
            .as_bytes(),
        ))
        .expect("sha256_hash_bytes yields a valid sha256 ref"),
    });

    // The secret is ALWAYS carried by ref — never the key bytes. A resolved key
    // additionally carries its validation proof.
    let secret_ref = HelperResultSecretRef {
        requirement_id: profile.key_requirement.requirement_id.clone(),
        secret_ref: profile.key_requirement.key_ref.clone(),
        material_kind: profile.key_requirement.material_kind,
        bytes: None,
        validation: validation.clone(),
    };

    let proof_hashes = validation.clone().into_iter().collect::<Vec<_>>();

    let message = match outcome {
        WolfHelperBoundaryOutcome::KeyResolved => format!(
            "static Wolf archive key resolved locally by ref for requirement {}; no untrusted code was launched",
            profile.key_requirement.requirement_id
        ),
        WolfHelperBoundaryOutcome::KeyMissing => format!(
            "{}: static Wolf archive key requirement {} is not present in the local key store",
            crate::SEMANTIC_MISSING_KEY_MATERIAL,
            profile.key_requirement.requirement_id
        ),
        WolfHelperBoundaryOutcome::HelperRequired => format!(
            "{}: the Wolf \"Pro\" per-game dynamic key for requirement {} must be recovered by the local dynamic-key helper; the boundary resolved the plan without launching",
            crate::SEMANTIC_HELPER_REQUIRED,
            profile.key_requirement.requirement_id
        ),
        WolfHelperBoundaryOutcome::HelperUnavailable => format!(
            "{}: the local Wolf dynamic-key helper platform is unavailable; requirement {} cannot be recovered on this runner",
            crate::SEMANTIC_HELPER_UNAVAILABLE,
            profile.key_requirement.requirement_id
        ),
    };

    HelperResult {
        schema_version: HELPER_RESULT_SCHEMA_VERSION.to_string(),
        fixture_id: profile.fixture_id.clone(),
        helper_result_id: format!("helper-result-{}", profile.profile_id),
        profile_id: profile.profile_id.clone(),
        helper: HelperProvenance {
            helper_id: format!("kaifuu.fixture.wolf-{}", kind.as_str().replace('_', "-")),
            helper_version: "0.1.0".to_string(),
            helper_kind: kind.helper_kind(),
        },
        capability_level: kind.capability_level(),
        execution: HelperExecutionSummary {
            mode: kind.execution_mode(),
            platform: kind.execution_platform().to_string(),
            bounded: true,
            timeout_ms: kind.timeout_ms(),
            // The boundary never runs the helper — durationMs 0 proves it.
            duration_ms: Some(0),
            network_access: false,
            filesystem_access: kind.filesystem_access(),
        },
        diagnostic: HelperDiagnostic {
            code: outcome.diagnostic_code(),
            message,
        },
        redaction: HelperRedaction {
            status: HelperRedactionStatus::Redacted,
            redacted_log_hash: ProofHash::new(WOLF_HELPER_BOUNDARY_REDACTED_LOG_HASH)
                .expect("fixture redacted-log hash is a valid sha256 ref"),
        },
        secret_refs: vec![secret_ref],
        proof_hashes,
    }
}

/// Resolve one profile into its full entry report, validating the derived
/// helper result against the schema and the declared expectation.
fn resolve_entry(
    profile: &WolfHelperBoundaryProfile,
    source_node_id: &str,
    engine_family: &str,
) -> WolfHelperBoundaryEntryReport {
    let mut findings: Vec<WolfHelperBoundaryFinding> = Vec::new();

    if engine_family != WOLF_ENGINE_FAMILY {
        findings.push(WolfHelperBoundaryFinding {
            code: "wolf.helper_boundary.wrong_engine_family".to_string(),
            field: "engineFamily".to_string(),
            message: format!(
                "Wolf helper boundary requires engineFamily={WOLF_ENGINE_FAMILY}, got {engine_family}"
            ),
        });
    }
    if profile.key_requirement.requirement_id.trim().is_empty() {
        findings.push(WolfHelperBoundaryFinding {
            code: "wolf.helper_boundary.requirement_id_missing".to_string(),
            field: "keyRequirement.requirementId".to_string(),
            message: "keyRef-bound profile is missing a non-empty requirementId".to_string(),
        });
    }
    // The secret ref must be a LOCAL scheme — a keyRef-bound Wolf profile is
    // resolved from the local key store, never a remote/prompt scheme.
    if profile.key_requirement.key_ref.scheme() != crate::SecretRefScheme::LocalSecret {
        findings.push(WolfHelperBoundaryFinding {
            code: "wolf.helper_boundary.non_local_secret_ref".to_string(),
            field: "keyRequirement.keyRef".to_string(),
            message: "Wolf helper-boundary key refs must be resolved from the local key store"
                .to_string(),
        });
    }

    let outcome =
        derive_wolf_helper_boundary_outcome(profile.boundary_kind, profile.locally_available);
    if profile.expected_outcome != outcome {
        findings.push(WolfHelperBoundaryFinding {
            code: "wolf.helper_boundary.outcome_mismatch".to_string(),
            field: "expectedOutcome".to_string(),
            message: format!(
                "profile declared outcome {} but the boundary derived {}",
                profile.expected_outcome.as_str(),
                outcome.as_str()
            ),
        });
    }

    let helper_result = resolve_wolf_helper_boundary(profile);

    // THE conformance gate: the derived helper result must pass
    // schema validation.
    let helper_value =
        serde_json::to_value(&helper_result).expect("helper result serializes to JSON");
    let validation = validate_helper_result_value(&helper_value);
    if validation.status != OperationStatus::Passed {
        for failure in &validation.failures {
            findings.push(WolfHelperBoundaryFinding {
                code: format!("wolf.helper_boundary.kaifuu_085.{}", failure.code),
                field: failure.field.clone(),
                message: failure.message.clone(),
            });
        }
    }

    let status = if findings.is_empty() {
        OperationStatus::Passed
    } else {
        OperationStatus::Failed
    };

    WolfHelperBoundaryEntryReport {
        fixture_id: profile.fixture_id.clone(),
        source_node_id: source_node_id.to_string(),
        engine_family: engine_family.to_string(),
        profile_id: profile.profile_id.clone(),
        boundary_kind: profile.boundary_kind,
        protection_profile: profile.boundary_kind.protection_profile(),
        outcome,
        secret_requirement_ids: helper_result
            .secret_refs
            .iter()
            .map(|secret| secret.requirement_id.clone())
            .collect(),
        proof_hashes: helper_result.proof_hashes.clone(),
        helper_result,
        status,
        findings,
    }
}

/// Run the Wolf helper-boundary resolver over a fixture set. Every profile is
/// resolved into a local-only helper result mechanically; the
/// declared expectation is used only to raise findings. Never panics.
pub fn run_wolf_helper_boundary(fixture: &WolfHelperBoundaryFixture) -> WolfHelperBoundaryReport {
    let mut entries = Vec::with_capacity(fixture.profiles.len());
    for profile in &fixture.profiles {
        entries.push(resolve_entry(
            profile,
            &fixture.source_node_id,
            &fixture.engine_family,
        ));
    }
    let status = if entries
        .iter()
        .all(|entry| matches!(entry.status, OperationStatus::Passed))
    {
        OperationStatus::Passed
    } else {
        OperationStatus::Failed
    };
    WolfHelperBoundaryReport {
        schema_version: WOLF_HELPER_BOUNDARY_REPORT_SCHEMA_VERSION.to_string(),
        boundary_set_id: fixture.boundary_set_id.clone(),
        source_node_id: fixture.source_node_id.clone(),
        engine_family: fixture.engine_family.clone(),
        support_boundary: WOLF_HELPER_BOUNDARY_SUPPORT_BOUNDARY.to_string(),
        status,
        entries,
    }
}

/// Load a Wolf helper-boundary fixture set from disk.
pub fn read_wolf_helper_boundary_fixture(path: &Path) -> KaifuuResult<WolfHelperBoundaryFixture> {
    read_json(path)
}
