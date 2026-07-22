use super::*;

/// Run the private-local validation gate.
pub fn run_xp3_private_local_validation(
    input: Xp3PrivateLocalValidationInput<'_>,
) -> KaifuuResult<Xp3PrivateLocalValidationReport> {
    if let Some(manifest) = input.manifest
        && manifest.schema_version != XP3_PRIVATE_LOCAL_VALIDATION_SCHEMA_VERSION
    {
        return Err(format!(
            "{XP3_PRIVATE_LOCAL_VALIDATION_MARKER}: manifest schemaVersion must be {XP3_PRIVATE_LOCAL_VALIDATION_SCHEMA_VERSION}, got {:?}",
            manifest.schema_version
        )
        .into());
    }

    let claimed_tuple_ids = claimed_tuple_ids(input.registry);
    let (regression, workflow) = run_regression(input.registry, &claimed_tuple_ids);
    let entries = input.manifest.map_or(
        &[] as &[Xp3PrivateLocalValidationManifestEntry],
        |manifest| manifest.entries.as_slice(),
    );

    if entries.is_empty() {
        let mut report = base_report(
            input.validation_id,
            XP3_PRIVATE_LOCAL_VALIDATION_NO_CORPUS_COMMAND,
            Xp3PrivateLocalValidationState::Skipped,
            Some(SEMANTIC_XP3_PRIVATE_LOCAL_VALIDATION_SKIPPED.to_string()),
            Xp3RetailValidationPosture::NotPrivateValidated,
            regression,
        );
        report.redaction_summary = scan_report(&report)?;
        return Ok(report);
    }

    let mut rows = Vec::with_capacity(entries.len());
    let mut diagnostics = Vec::new();
    let mut result_counts = Xp3PrivateLocalValidationStateCounts::default();
    let mut stage_bins = Xp3PrivateLocalValidationStageBins::empty();
    let mut proof_hashes: Vec<ProofHash> = Vec::new();

    for (index, entry) in entries.iter().enumerate() {
        let in_profile = claimed_tuple_ids
            .iter()
            .any(|id| id == &entry.claimed_support_tuple_id);
        let mut stages = normalize_stages(entry)?;
        let stage_failed = stages
            .iter()
            .any(|stage| !matches!(stage.state, Xp3PrivateLocalValidationState::Passed));
        let result = if !in_profile {
            stages.iter_mut().for_each(|stage| {
                stage.state = Xp3PrivateLocalValidationState::OutOfProfile;
            });
            diagnostics.push(Xp3PrivateLocalValidationDiagnostic {
                code: "out_of_profile".to_string(),
                severity: PartialDiagnosticSeverity::P2,
                field: format!("entries[{index}].claimedSupportTupleId"),
                message: format!(
                    "input row names support tuple {} which is outside the declared XP3 claimed profile",
                    entry.claimed_support_tuple_id
                ),
                semantic_code: SEMANTIC_XP3_PRIVATE_LOCAL_VALIDATION_OUT_OF_PROFILE.to_string(),
            });
            Xp3PrivateLocalValidationState::OutOfProfile
        } else if regression.status == OperationStatus::Failed {
            diagnostics.push(Xp3PrivateLocalValidationDiagnostic {
                code: "production_regression_failed".to_string(),
                severity: PartialDiagnosticSeverity::P0,
                field: "regression".to_string(),
                message: "claimed XP3 support tuple is blocked by the production regression runner"
                    .to_string(),
                semantic_code: SEMANTIC_XP3_PRIVATE_LOCAL_VALIDATION_REGRESSION_FAILED.to_string(),
            });
            Xp3PrivateLocalValidationState::Failed
        } else if entry.result == Xp3PrivateLocalValidationState::Failed || stage_failed {
            diagnostics.push(Xp3PrivateLocalValidationDiagnostic {
                code: "claimed_tuple_failed".to_string(),
                severity: PartialDiagnosticSeverity::P0,
                field: format!("entries[{index}]"),
                message: format!(
                    "claimed XP3 support tuple {} failed private-local validation; this is a compatibility bug/regression",
                    entry.claimed_support_tuple_id
                ),
                semantic_code: SEMANTIC_XP3_PRIVATE_LOCAL_VALIDATION_CLAIMED_FAILED.to_string(),
            });
            Xp3PrivateLocalValidationState::Failed
        } else {
            // The last, load-bearing gate: `Passed` (and thus PrivateValidated)
            // is reached ONLY when the entry's declared round-trip proof BINDS to
            // the verified round-trip. The honored value is recomputed from the
            // genuinely-run workflow output for this exact tuple
            // (source + rebuilt container hashes + per-member deltas + round-trip
            // proof) — a label-only / mintable hash is refused, and a workflow
            // that produced no round-trip for this tuple fails loud.
            match honor_round_trip_proof(entry, index, workflow.as_ref(), &mut diagnostics) {
                true => Xp3PrivateLocalValidationState::Passed,
                false => Xp3PrivateLocalValidationState::Failed,
            }
        };

        result_counts.increment(result);
        for stage in &stages {
            stage_bins.increment(stage.stage, stage.state);
        }

        proof_hashes.extend(entry.proof_hashes.iter().cloned());
        proof_hashes.extend(stages.iter().map(|stage| stage.proof_hash.clone()));
        // The verified workflow-bound round-trip proof enters the aggregate proof
        // set ONLY when the entry passed (i.e. the proof was honored). A refused
        // label-only proof never contributes a proof hash.
        let mut row_proof_hashes = entry.proof_hashes.clone();
        if result == Xp3PrivateLocalValidationState::Passed {
            proof_hashes.push(entry.round_trip_proof_hash.clone());
            row_proof_hashes.push(entry.round_trip_proof_hash.clone());
        }
        rows.push(Xp3PrivateLocalValidationRow {
            corpus_id_redacted: entry.corpus_id_redacted.clone(),
            claimed_support_tuple_id: entry.claimed_support_tuple_id.clone(),
            profile_id_redacted: entry.profile_id_redacted.clone(),
            result,
            proof_hashes: row_proof_hashes,
            stages,
        });
    }

    proof_hashes.sort();
    proof_hashes.dedup();

    let claimed_private_inputs = result_counts.passed + result_counts.failed;
    let out_of_profile_inputs = result_counts.out_of_profile;
    let status = if result_counts.failed > 0 {
        Xp3PrivateLocalValidationState::Failed
    } else if result_counts.passed > 0 {
        Xp3PrivateLocalValidationState::Passed
    } else {
        Xp3PrivateLocalValidationState::OutOfProfile
    };
    let retail_validation = match status {
        Xp3PrivateLocalValidationState::Passed => Xp3RetailValidationPosture::PrivateValidated,
        Xp3PrivateLocalValidationState::Failed => {
            Xp3RetailValidationPosture::PrivateValidationFailed
        }
        Xp3PrivateLocalValidationState::OutOfProfile => {
            Xp3RetailValidationPosture::OutOfProfileOnly
        }
        Xp3PrivateLocalValidationState::Skipped => Xp3RetailValidationPosture::NotPrivateValidated,
    };

    let mut report = base_report(
        input.validation_id,
        XP3_PRIVATE_LOCAL_VALIDATION_MANIFEST_COMMAND,
        status,
        None,
        retail_validation,
        regression,
    );
    report.result_counts = result_counts;
    report.stage_bins = stage_bins;
    report.configured_private_inputs = entries.len() as u64;
    report.claimed_private_inputs = claimed_private_inputs;
    report.out_of_profile_inputs = out_of_profile_inputs;
    report.proof_hashes = proof_hashes;
    report.rows = rows;
    report.diagnostics = diagnostics;
    report.redaction_summary = scan_report(&report)?;
    Ok(report)
}

fn base_report(
    validation_id: &str,
    command: &str,
    status: Xp3PrivateLocalValidationState,
    reason: Option<String>,
    retail_validation: Xp3RetailValidationPosture,
    regression: Xp3PrivateLocalRegressionSummary,
) -> Xp3PrivateLocalValidationReport {
    Xp3PrivateLocalValidationReport {
        schema_version: XP3_PRIVATE_LOCAL_VALIDATION_SCHEMA_VERSION.to_string(),
        validation_id: validation_id.to_string(),
        source_node_id: "xp3-private-local-validation".to_string(),
        command: command.to_string(),
        support_boundary: XP3_PRIVATE_LOCAL_VALIDATION_SUPPORT_BOUNDARY.to_string(),
        status,
        reason,
        alpha_proofs: Xp3PrivateLocalAlphaProofs { retail_validation },
        result_counts: Xp3PrivateLocalValidationStateCounts::default(),
        stage_bins: Xp3PrivateLocalValidationStageBins::empty(),
        configured_private_inputs: 0,
        claimed_private_inputs: 0,
        out_of_profile_inputs: 0,
        proof_hashes: Vec::new(),
        regression,
        rows: Vec::new(),
        diagnostics: Vec::new(),
        redaction_summary: Xp3PrivateLocalValidationRedactionSummary {
            deep_scan_performed: false,
            strings_scanned: 0,
            secret_leak_findings: 0,
            redaction_boundary_ok: false,
            redaction_status: HelperRedactionStatus::Redacted,
        },
    }
}

fn claimed_tuple_ids(registry: &Xp3ProductionRegistry) -> Vec<String> {
    let mut ids: Vec<String> = registry
        .variants
        .iter()
        .filter(|variant| variant.claimed)
        .map(|variant| variant.variant_id.clone())
        .collect();
    ids.sort();
    ids
}

/// Run the production extract-patch-verify workflow ONCE and return
/// both the summary and the workflow report (when it ran). The report is the
/// source of truth every claimed entry's round-trip proof binds to: a claimed
/// entry can only reach `Passed` when its declared `roundTripProofHash` equals
/// the workflow-bound value recomputed from THIS report's real round-trip output.
/// If the workflow itself did not pass, `None` is returned and no entry can honor
/// a proof — the top rungs stay unreached (fail-loud, never a silent skip).
fn run_regression(
    registry: &Xp3ProductionRegistry,
    claimed_tuple_ids: &[String],
) -> (
    Xp3PrivateLocalRegressionSummary,
    Option<Xp3ProductionReport>,
) {
    match run_xp3_production(registry, "xp3-private-local-validation") {
        Ok(report) => {
            let production_report_hash = report
                .stable_json()
                .ok()
                .and_then(|json| proof_hash(json.as_bytes()).ok());
            let round_tripped_ids: Vec<&str> = report
                .outcomes
                .iter()
                .filter_map(|outcome| match outcome {
                    Xp3ProductionOutcome::Claimed(claimed) => Some(claimed.variant_id.as_str()),
                    Xp3ProductionOutcome::NotClaimed(_) => None,
                })
                .collect();
            let status = if claimed_tuple_ids
                .iter()
                .all(|id| round_tripped_ids.contains(&id.as_str()))
                && report.status == OperationStatus::Passed
            {
                OperationStatus::Passed
            } else {
                OperationStatus::Failed
            };
            let summary = Xp3PrivateLocalRegressionSummary {
                runner: "kaifuu.kirikiri.xp3_production".to_string(),
                source_node_id: "xp3-production".to_string(),
                claimed_support_tuple_ids: claimed_tuple_ids.to_vec(),
                production_report_hash,
                status: status.clone(),
                diagnostic: if status == OperationStatus::Passed {
                    None
                } else {
                    Some("production runner did not round-trip every claimed tuple".to_string())
                },
            };
            // The workflow report is threaded for round-trip binding ONLY when it
            // genuinely passed; a failed workflow yields no verifiable proof.
            let workflow = (status == OperationStatus::Passed).then_some(report);
            (summary, workflow)
        }
        Err(error) => (
            Xp3PrivateLocalRegressionSummary {
                runner: "kaifuu.kirikiri.xp3_production".to_string(),
                source_node_id: "xp3-production".to_string(),
                claimed_support_tuple_ids: claimed_tuple_ids.to_vec(),
                production_report_hash: None,
                status: OperationStatus::Failed,
                diagnostic: Some(redact_production_error(&error)),
            },
            None,
        ),
    }
}

/// Honor an in-profile claimed entry's declared round-trip proof. Returns `true`
/// (the entry reaches `Passed`) ONLY when the workflow genuinely round-tripped
/// this tuple AND the entry's declared `roundTripProofHash` equals the
/// workflow-bound canonical value recomputed from that real round-trip output.
/// - A workflow that produced no round-trip for the tuple is a LOUD failure
///   ([`SEMANTIC_XP3_PRIVATE_LOCAL_VALIDATION_WORKFLOW_UNPROVEN`]); never a silent
///   skip — the tuple cannot reach `patch-proven` without a verified round-trip.
/// - A declared hash that does not match the workflow-bound value is a label-only
///   mintable / fabricated proof and is refused
///   ([`SEMANTIC_XP3_PRIVATE_LOCAL_VALIDATION_UNVERIFIED_PROOF`]).
fn honor_round_trip_proof(
    entry: &Xp3PrivateLocalValidationManifestEntry,
    index: usize,
    workflow: Option<&Xp3ProductionReport>,
    diagnostics: &mut Vec<Xp3PrivateLocalValidationDiagnostic>,
) -> bool {
    let Some(workflow) = workflow else {
        diagnostics.push(Xp3PrivateLocalValidationDiagnostic {
            code: "workflow_round_trip_unproven".to_string(),
            severity: PartialDiagnosticSeverity::P0,
            field: "regression".to_string(),
            message: format!(
                "claimed XP3 support tuple {} cannot be patch-proven: the extract-patch-verify workflow did not produce a passing round-trip to bind the proof to",
                entry.claimed_support_tuple_id
            ),
            semantic_code: SEMANTIC_XP3_PRIVATE_LOCAL_VALIDATION_WORKFLOW_UNPROVEN.to_string(),
        });
        return false;
    };
    let Some(canonical) = canonical_xp3_round_trip_proof_hash_from_workflow(
        workflow,
        &entry.claimed_support_tuple_id,
    ) else {
        diagnostics.push(Xp3PrivateLocalValidationDiagnostic {
            code: "workflow_round_trip_unproven".to_string(),
            severity: PartialDiagnosticSeverity::P0,
            field: format!("entries[{index}].claimedSupportTupleId"),
            message: format!(
                "the workflow round-tripped no output for claimed tuple {}, so no verified round-trip proof can back it",
                entry.claimed_support_tuple_id
            ),
            semantic_code: SEMANTIC_XP3_PRIVATE_LOCAL_VALIDATION_WORKFLOW_UNPROVEN.to_string(),
        });
        return false;
    };
    if entry.round_trip_proof_hash != canonical {
        diagnostics.push(Xp3PrivateLocalValidationDiagnostic {
            code: "unverified_round_trip_proof".to_string(),
            severity: PartialDiagnosticSeverity::P0,
            field: format!("entries[{index}].roundTripProofHash"),
            message: format!(
                "claimed XP3 support tuple {} declared a round-trip proof hash that is NOT the workflow-bound value from the real extract-patch-verify round-trip (label-only / mintable / fabricated proof, refused)",
                entry.claimed_support_tuple_id
            ),
            semantic_code: SEMANTIC_XP3_PRIVATE_LOCAL_VALIDATION_UNVERIFIED_PROOF.to_string(),
        });
        return false;
    }
    true
}

fn redact_production_error(error: &Xp3ProductionError) -> String {
    redact_for_log_or_report(&error.to_string())
}

fn normalize_stages(
    entry: &Xp3PrivateLocalValidationManifestEntry,
) -> KaifuuResult<Vec<Xp3PrivateLocalValidationStageOutcome>> {
    let mut stages = Vec::with_capacity(Xp3PrivateLocalValidationStage::ordered().len());
    for stage in Xp3PrivateLocalValidationStage::ordered() {
        let Some(outcome) = entry
            .stages
            .iter()
            .find(|candidate| candidate.stage == stage)
        else {
            return Err(format!(
                "{XP3_PRIVATE_LOCAL_VALIDATION_MARKER}: entry {} missing stage {}",
                entry.claimed_support_tuple_id,
                stage.as_key()
            )
            .into());
        };
        if outcome.state == Xp3PrivateLocalValidationState::Skipped {
            return Err(format!(
                "{XP3_PRIVATE_LOCAL_VALIDATION_MARKER}: configured entry {} cannot mark stage {} skipped",
                entry.claimed_support_tuple_id,
                stage.as_key()
            )
            .into());
        }
        stages.push(outcome.clone());
    }
    Ok(stages)
}
