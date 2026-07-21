//! Siglus static-key discovery pipeline: resolve inputs, analyse, validate, finalize.

use std::path::Path;

use crate::{
    HelperKind, HelperRedactionStatus, HelperResultExecutionMode, KaifuuResult, KeyMaterialKind,
    KeyValidationProof, OperationStatus, PartialDiagnosticSeverity, ProofHash,
    SEMANTIC_KEY_VALIDATION_FAILED, SEMANTIC_PROTECTED_EXECUTABLE_UNSUPPORTED,
    redact_for_log_or_report, sha256_hash_bytes,
};

use super::{
    FINDING_HELPER_MISMATCH, FINDING_INPUT_MISSING, FINDING_INPUT_UNREADABLE,
    FINDING_KEY_REGION_NOT_FOUND, FINDING_OUTCOME_MISMATCH, FINDING_PROTECTED_EXECUTABLE,
    FINDING_UNSUPPORTED_PACKER, FINDING_VALIDATION_FAILED,
    SEMANTIC_SIGLUS_STATIC_KEY_HELPER_MISMATCH, SEMANTIC_SIGLUS_STATIC_KEY_REGION_NOT_FOUND,
    SEMANTIC_SIGLUS_STATIC_KEY_UNSUPPORTED_PACKER, SIGLUS_STATIC_KEY_SCHEMA_VERSION,
    SIGLUS_STATIC_KEY_SUPPORT_BOUNDARY, SiglusStaticKeyCapability, SiglusStaticKeyDeclaredHelper,
    SiglusStaticKeyEntryReport, SiglusStaticKeyFinding, SiglusStaticKeyFixtureEntry,
    SiglusStaticKeyOutcome, SiglusStaticKeyRef, SiglusStaticKeyReport, SiglusStaticKeyRequest,
    SiglusStaticKeyStubScenario, StaticAnalysisError, StaticKeyCandidate,
    analyze_siglus_executable, build_siglus_static_key_stub, validate_candidate_against_gameexe,
};

/// Run Siglus static-key discovery for every entry in the manifest. Each entry
/// is statically analysed in-process, and any recovered candidate is validated
/// against `Gameexe.dat` **before** a consumable key-ref is published. Returns
/// `Err` only on an environmental failure; evidence / validation problems
/// surface as per-entry structured findings with a `Failed` status.
pub fn discover_siglus_static_key(
    request: SiglusStaticKeyRequest<'_>,
) -> KaifuuResult<SiglusStaticKeyReport> {
    let fixture = request.fixture;
    let validation_command = format!(
        "kaifuu siglus static-key --fixture {}",
        sanitize_file_name(request.fixture_file_name)
    );
    let mut entries = Vec::with_capacity(fixture.entries.len());
    for entry in &fixture.entries {
        entries.push(discover_entry(
            entry,
            &fixture.source_node_id,
            &fixture.capability_id,
            request.fixture_dir,
            &validation_command,
        ));
    }

    let validation_ran = entries.iter().any(|entry| {
        matches!(
            entry.outcome,
            SiglusStaticKeyOutcome::Validated | SiglusStaticKeyOutcome::ValidationFailed
        )
    });
    let capability = SiglusStaticKeyCapability::in_process(
        &fixture.capability_id,
        &fixture.engine_family,
        validation_ran,
    );

    let status = if entries
        .iter()
        .all(|entry| entry.status == OperationStatus::Passed)
    {
        OperationStatus::Passed
    } else {
        OperationStatus::Failed
    };

    Ok(SiglusStaticKeyReport {
        schema_version: SIGLUS_STATIC_KEY_SCHEMA_VERSION.to_string(),
        capability_id: fixture.capability_id.clone(),
        source_node_id: fixture.source_node_id.clone(),
        engine_family: fixture.engine_family.clone(),
        support_boundary: SIGLUS_STATIC_KEY_SUPPORT_BOUNDARY.to_string(),
        capability,
        status,
        entries,
    })
}

fn discover_entry(
    entry: &SiglusStaticKeyFixtureEntry,
    source_node_id: &str,
    capability_id: &str,
    fixture_dir: &Path,
    validation_command: &str,
) -> SiglusStaticKeyEntryReport {
    let mut findings = Vec::new();

    // (0) Helper-provenance mismatch short-circuits BEFORE any analysis: kaifuu
    // will not consume a key offered by a shelled-out or non-static helper.
    if let Some(declared) = entry.declared_helper.as_ref()
        && let Some(finding) = check_helper_provenance(declared)
    {
        findings.push(finding);
        return finalize_entry(
            entry,
            source_node_id,
            capability_id,
            validation_command,
            SiglusStaticKeyOutcome::HelperMismatch,
            None,
            findings,
        );
    }

    // (1) Resolve the synthetic stub OR scoped local bytes, in-process.
    let ResolvedInputs {
        input_kind,
        executable: executable_bytes,
        gameexe: gameexe_bytes,
    } = match resolve_inputs(entry, fixture_dir) {
        Ok(resolved) => resolved,
        Err(finding) => {
            findings.push(finding);
            return finalize_entry(
                entry,
                source_node_id,
                capability_id,
                validation_command,
                SiglusStaticKeyOutcome::KeyRegionNotFound,
                None,
                findings,
            );
        }
    };

    // (2) Static analysis: refuse packers / protected binaries; recover the
    // candidate. Every failure is a structured finding.
    let candidate = match analyze_siglus_executable(&executable_bytes) {
        Ok(candidate) => candidate,
        Err(error) => {
            let (outcome, finding) = analysis_finding(error);
            findings.push(finding);
            return finalize_entry(
                entry,
                source_node_id,
                capability_id,
                validation_command,
                outcome,
                Some(&input_kind),
                findings,
            );
        }
    };

    // (3) Validate-before-consume: only a candidate that reproduces the
    // `Gameexe.dat` known-plaintext header may be published.
    let proof = match validate_candidate_against_gameexe(&candidate, &gameexe_bytes) {
        Ok(Some(proof)) => proof,
        Ok(None) => {
            findings.push(finding(
                FINDING_VALIDATION_FAILED,
                PartialDiagnosticSeverity::P0,
                "gameexe",
                "recovered candidate did not reproduce the Gameexe.dat known-plaintext header"
                    .to_string(),
                SEMANTIC_KEY_VALIDATION_FAILED,
            ));
            return finalize_entry_with_input(
                entry,
                source_node_id,
                capability_id,
                validation_command,
                SiglusStaticKeyOutcome::ValidationFailed,
                &input_kind,
                None,
                findings,
            );
        }
        Err(error) => {
            findings.push(internal_finding("validation", &error.to_string()));
            return finalize_entry_with_input(
                entry,
                source_node_id,
                capability_id,
                validation_command,
                SiglusStaticKeyOutcome::ValidationFailed,
                &input_kind,
                None,
                findings,
            );
        }
    };

    // Validated: publish the structured key-ref (secret-ref + proof hashes
    // only). The raw key is dropped (zeroized) at the end of this scope.
    let key_ref = match build_key_ref(entry, &candidate, &gameexe_bytes, proof) {
        Ok(key_ref) => key_ref,
        Err(error) => {
            findings.push(internal_finding("keyRef", &error.to_string()));
            return finalize_entry_with_input(
                entry,
                source_node_id,
                capability_id,
                validation_command,
                SiglusStaticKeyOutcome::ValidationFailed,
                &input_kind,
                None,
                findings,
            );
        }
    };

    finalize_entry_with_input(
        entry,
        source_node_id,
        capability_id,
        validation_command,
        SiglusStaticKeyOutcome::Validated,
        &input_kind,
        Some(key_ref),
        findings,
    )
}

/// The resolved byte inputs for one entry, plus the redaction-safe label of
/// where they came from (`stub:<scenario>` or `local-helper`).
struct ResolvedInputs {
    input_kind: String,
    executable: Vec<u8>,
    gameexe: Vec<u8>,
}

fn resolve_inputs(
    entry: &SiglusStaticKeyFixtureEntry,
    fixture_dir: &Path,
) -> Result<ResolvedInputs, SiglusStaticKeyFinding> {
    match (entry.stub, entry.executable.as_deref(), entry.gameexe.as_deref()) {
        (Some(scenario), None, None) => {
            let stub = build_siglus_static_key_stub(scenario);
            Ok(ResolvedInputs {
                input_kind: format!("stub:{}", scenario_str(scenario)),
                executable: stub.executable,
                gameexe: stub.gameexe,
            })
        }
        (None, Some(executable_rel), Some(gameexe_rel)) => {
            let executable = read_local_input(fixture_dir, executable_rel, "executable")?;
            let gameexe = read_local_input(fixture_dir, gameexe_rel, "gameexe")?;
            Ok(ResolvedInputs {
                input_kind: "local-helper".to_string(),
                executable,
                gameexe,
            })
        }
        _ => Err(finding(
            FINDING_INPUT_MISSING,
            PartialDiagnosticSeverity::P0,
            "stub",
            "entry must specify exactly a `stub` scenario OR both `executable` and `gameexe` local paths"
                .to_string(),
            SEMANTIC_SIGLUS_STATIC_KEY_REGION_NOT_FOUND,
        )),
    }
}

fn read_local_input(
    fixture_dir: &Path,
    rel: &str,
    field: &str,
) -> Result<Vec<u8>, SiglusStaticKeyFinding> {
    std::fs::read(fixture_dir.join(rel)).map_err(|error| {
        finding(
            FINDING_INPUT_UNREADABLE,
            PartialDiagnosticSeverity::P0,
            field,
            format!(
                "local {field} input could not be read: {}",
                redact_for_log_or_report(&error.to_string())
            ),
            SEMANTIC_SIGLUS_STATIC_KEY_REGION_NOT_FOUND,
        )
    })
}

fn check_helper_provenance(
    declared: &SiglusStaticKeyDeclaredHelper,
) -> Option<SiglusStaticKeyFinding> {
    let in_process = declared.helper_kind == HelperKind::StaticParser
        && declared.execution_mode == HelperResultExecutionMode::InProcess;
    if in_process {
        None
    } else {
        Some(finding(
            FINDING_HELPER_MISMATCH,
            PartialDiagnosticSeverity::P0,
            "declaredHelper",
            format!(
                "local helper must be the in-process static parser; got kind={:?} mode={:?}",
                declared.helper_kind, declared.execution_mode
            ),
            SEMANTIC_SIGLUS_STATIC_KEY_HELPER_MISMATCH,
        ))
    }
}

fn analysis_finding(
    error: StaticAnalysisError,
) -> (SiglusStaticKeyOutcome, SiglusStaticKeyFinding) {
    match error {
        StaticAnalysisError::UnsupportedPacker => (
            SiglusStaticKeyOutcome::UnsupportedPacker,
            finding(
                FINDING_UNSUPPORTED_PACKER,
                PartialDiagnosticSeverity::P0,
                "executable",
                "executable is wrapped by a packer kaifuu cannot statically analyse".to_string(),
                SEMANTIC_SIGLUS_STATIC_KEY_UNSUPPORTED_PACKER,
            ),
        ),
        StaticAnalysisError::ProtectedExecutable => (
            SiglusStaticKeyOutcome::ProtectedExecutable,
            finding(
                FINDING_PROTECTED_EXECUTABLE,
                PartialDiagnosticSeverity::P0,
                "executable",
                "executable is protected; static key analysis is refused".to_string(),
                SEMANTIC_PROTECTED_EXECUTABLE_UNSUPPORTED,
            ),
        ),
        StaticAnalysisError::KeyRegionNotFound => (
            SiglusStaticKeyOutcome::KeyRegionNotFound,
            finding(
                FINDING_KEY_REGION_NOT_FOUND,
                PartialDiagnosticSeverity::P0,
                "executable",
                "no static key region could be located in the executable".to_string(),
                SEMANTIC_SIGLUS_STATIC_KEY_REGION_NOT_FOUND,
            ),
        ),
    }
}

fn build_key_ref(
    entry: &SiglusStaticKeyFixtureEntry,
    candidate: &StaticKeyCandidate,
    gameexe_bytes: &[u8],
    validation: KeyValidationProof,
) -> KaifuuResult<SiglusStaticKeyRef> {
    Ok(SiglusStaticKeyRef {
        requirement_id: entry.requirement_id.clone(),
        secret_ref: entry.secret_ref.clone(),
        key_purpose: entry.key_purpose.clone(),
        engine_profile_id: entry.engine_profile_id.clone(),
        source_hash: ProofHash::new(sha256_hash_bytes(gameexe_bytes))?,
        material_hash: candidate.material_hash()?,
        material_kind: KeyMaterialKind::FixedBytes,
        bytes: u32::try_from(candidate.byte_len()).unwrap_or(u32::MAX),
        validation,
        redaction_status: HelperRedactionStatus::Redacted,
    })
}

// reason: single cohesive entry-finalize over distinct Siglus key fields; a params struct would only relocate the arity.
#[allow(clippy::too_many_arguments)]
fn finalize_entry(
    entry: &SiglusStaticKeyFixtureEntry,
    source_node_id: &str,
    capability_id: &str,
    validation_command: &str,
    outcome: SiglusStaticKeyOutcome,
    input_kind: Option<&str>,
    findings: Vec<SiglusStaticKeyFinding>,
) -> SiglusStaticKeyEntryReport {
    finalize_entry_with_input(
        entry,
        source_node_id,
        capability_id,
        validation_command,
        outcome,
        input_kind.unwrap_or("unresolved"),
        None,
        findings,
    )
}

// reason: single cohesive entry-finalize over distinct Siglus key fields; a params struct would only relocate the arity.
#[allow(clippy::too_many_arguments)]
fn finalize_entry_with_input(
    entry: &SiglusStaticKeyFixtureEntry,
    source_node_id: &str,
    capability_id: &str,
    validation_command: &str,
    outcome: SiglusStaticKeyOutcome,
    input_kind: &str,
    key_ref: Option<SiglusStaticKeyRef>,
    mut findings: Vec<SiglusStaticKeyFinding>,
) -> SiglusStaticKeyEntryReport {
    // Validator: the evidence-derived outcome must match the declared
    // expectation. A diagnosis-class outcome (unsupported packer, protected
    // executable, helper mismatch, missing key region, validation failure) is a
    // structured finding but is NOT an adapter failure when it is exactly what
    // the entry expected — the adapter behaved correctly. Only an outcome
    // *mismatch* or an environmental / internal finding flips the entry red.
    let outcome_matches = entry.expected == outcome;
    if !outcome_matches {
        findings.push(finding(
            FINDING_OUTCOME_MISMATCH,
            PartialDiagnosticSeverity::P0,
            "expected",
            format!(
                "entry declared outcome {} but evidence derived {}",
                entry.expected.as_str(),
                outcome.as_str()
            ),
            SEMANTIC_KEY_VALIDATION_FAILED,
        ));
    }

    let validated = outcome == SiglusStaticKeyOutcome::Validated;
    // Belt-and-braces: a key-ref may exist ONLY for a validated outcome.
    let key_ref = if validated { key_ref } else { None };

    let status = if outcome_matches && !findings.iter().any(|finding| forces_failure(&finding.code))
    {
        OperationStatus::Passed
    } else {
        OperationStatus::Failed
    };

    SiglusStaticKeyEntryReport {
        entry_id: entry.entry_id.clone(),
        source_node_id: source_node_id.to_string(),
        capability_id: capability_id.to_string(),
        input_kind: input_kind.to_string(),
        outcome,
        validated: validated && key_ref.is_some(),
        key_ref,
        validation_command: validation_command.to_string(),
        redaction_status: "redacted".to_string(),
        status,
        findings,
    }
}

/// Environmental / internal findings that flip an entry red regardless of the
/// declared expectation. Diagnosis-class findings (the expected semantic
/// outcomes) are deliberately excluded — a correctly-diagnosed unsupported
/// packer is a passing conformance entry.
fn forces_failure(code: &str) -> bool {
    matches!(
        code,
        FINDING_OUTCOME_MISMATCH
            | FINDING_INPUT_MISSING
            | FINDING_INPUT_UNREADABLE
            | "siglus.static_key.internal"
    )
}

fn scenario_str(scenario: SiglusStaticKeyStubScenario) -> &'static str {
    match scenario {
        SiglusStaticKeyStubScenario::Valid => "valid",
        SiglusStaticKeyStubScenario::WrongKey => "wrong_key",
        SiglusStaticKeyStubScenario::UnsupportedPacker => "unsupported_packer",
        SiglusStaticKeyStubScenario::ProtectedExecutable => "protected_executable",
        SiglusStaticKeyStubScenario::KeyRegionMissing => "key_region_missing",
    }
}

fn finding(
    code: &str,
    severity: PartialDiagnosticSeverity,
    field: &str,
    message: String,
    semantic_code: &str,
) -> SiglusStaticKeyFinding {
    SiglusStaticKeyFinding {
        code: code.to_string(),
        severity,
        field: field.to_string(),
        message,
        semantic_code: Some(semantic_code.to_string()),
    }
}

fn internal_finding(context: &str, error: &str) -> SiglusStaticKeyFinding {
    finding(
        "siglus.static_key.internal",
        PartialDiagnosticSeverity::P0,
        context,
        redact_for_log_or_report(error),
        SEMANTIC_KEY_VALIDATION_FAILED,
    )
}

/// Keep only the file-name component of a declared manifest name so the recorded
/// validation command can never echo a local directory path.
fn sanitize_file_name(name: &str) -> String {
    Path::new(name)
        .file_name()
        .and_then(|component| component.to_str())
        .map_or_else(|| "siglus-static-key.json".to_string(), ToString::to_string)
}
