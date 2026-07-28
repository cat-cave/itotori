use super::*;

// Renderer.

/// Compose the redacted XP3 private-local summary from the operator's helper +
/// support-tuple + patch inputs.
/// The summary carries only safe metadata (profile ids, secret **requirement**
/// ids, proof hashes, capability levels, statuses, counts, diagnostics). The
/// status is `Failed` iff any helper result fails validation, any
/// support tuple overclaims, or any XP3 patch summary reports a
/// failed round-trip.
/// FAIL-LOUD: the composed body is deep-scanned; if any raw key, private path,
/// decrypted/story text, screenshot filename, retail byte blob, or raw helper
/// dump is present, this returns `Err` and nothing is returned to persist.
pub fn render_xp3_private_local_summary(
    input: Xp3PrivateLocalSummaryInput<'_>,
) -> KaifuuResult<Xp3PrivateLocalSummary> {
    let mut diagnostics: Vec<Xp3PrivateLocalSummaryDiagnostic> = Vec::new();
    let mut redaction_statuses: Vec<HelperRedactionStatus> = Vec::new();

    let mut helper_rows: Vec<Xp3HelperResultRow> = Vec::with_capacity(input.helper_results.len());
    for helper in input.helper_results {
        let validation = helper.validate();
        if validation.status == OperationStatus::Failed {
            diagnostics.push(Xp3PrivateLocalSummaryDiagnostic {
                code: "helper_result_invalid".to_string(),
                severity: PartialDiagnosticSeverity::P1,
                field: "helperRows".to_string(),
                message: format!(
                    "helper result {} failed  validation with {} failure(s)",
                    helper.helper_result_id,
                    validation.failures.len()
                ),
                semantic_code: SEMANTIC_XP3_PRIVATE_LOCAL_SUMMARY_HELPER_INVALID.to_string(),
            });
        }
        redaction_statuses.push(helper.redaction.status);
        helper_rows.push(Xp3HelperResultRow {
            helper_result_id: helper.helper_result_id.clone(),
            profile_id: helper.profile_id.clone(),
            capability_level: helper.capability_level,
            diagnostic_code: helper.diagnostic.code,
            redaction_status: helper.redaction.status,
            secret_requirement_ids: helper
                .secret_refs
                .iter()
                .map(|secret| secret.requirement_id.clone())
                .collect(),
            redacted_log_hash: helper.redaction.redacted_log_hash.clone(),
            proof_hashes: helper
                .proof_hashes
                .iter()
                .map(|proof| proof.proof_hash.clone())
                .collect(),
            validation_status: validation.status,
        });
    }

    let mut support_rows: Vec<Xp3SupportTupleRow> = Vec::with_capacity(input.support_tuples.len());
    let mut honest_tuple_count = 0u64;
    let mut overclaim_tuple_count = 0u64;
    for tuple in input.support_tuples {
        let entry = validate_claimed_support_tuple(tuple);
        if entry.is_honest() {
            honest_tuple_count += 1;
        } else {
            overclaim_tuple_count += 1;
            diagnostics.push(Xp3PrivateLocalSummaryDiagnostic {
                code: "support_tuple_overclaim".to_string(),
                severity: PartialDiagnosticSeverity::P0,
                field: "supportRows".to_string(),
                message: format!(
                    "support tuple {} overclaims or failed  validation",
                    entry.profile_or_fixture_id
                ),
                semantic_code: SEMANTIC_XP3_PRIVATE_LOCAL_SUMMARY_TUPLE_OVERCLAIM.to_string(),
            });
        }
        support_rows.push(support_tuple_row(&entry));
    }

    let mut patch_rows: Vec<Xp3PatchSummaryRow> = Vec::with_capacity(input.patch_reports.len());
    for report in input.patch_reports {
        if report.status == OperationStatus::Failed {
            diagnostics.push(Xp3PrivateLocalSummaryDiagnostic {
                code: "patch_summary_failed".to_string(),
                severity: PartialDiagnosticSeverity::P1,
                field: "patchRows".to_string(),
                message: format!(
                    "XP3 patch-back summary {} reported a failed round-trip",
                    report.fixture_id
                ),
                semantic_code: SEMANTIC_XP3_PRIVATE_LOCAL_SUMMARY_PATCH_FAILED.to_string(),
            });
        }
        redaction_statuses.push(report.redaction_status);
        patch_rows.push(Xp3PatchSummaryRow {
            fixture_id: report.fixture_id.clone(),
            patch_back_mode: report.capability.patch_back_mode,
            secret_requirement_id: report.secret_requirement_id.clone(),
            redaction_status: report.redaction_status,
            total_members: report.capability.coverage.total_members,
            members_patched: report.capability.coverage.members_patched,
            members_byte_preserved: report.capability.coverage.members_byte_preserved,
            identity_byte_identical: report.identity.byte_identical,
            identity_source_hash: report.identity.source_hash.clone(),
            identity_rebuilt_hash: report.identity.rebuilt_hash.clone(),
            verification_proof_hash: report.verification.verification_proof.proof_hash.clone(),
            secret_requirement_verified: report.verification.secret_requirement_verified,
            status: report.status.clone(),
        });
    }

    // Distinct capability levels (ascending), a safe aggregate.
    let mut capability_levels: Vec<HelperCapabilityLevel> =
        helper_rows.iter().map(|row| row.capability_level).collect();
    capability_levels.sort();
    capability_levels.dedup();

    let aggregate_redaction_status = aggregate_redaction_status(&redaction_statuses);

    let status = if diagnostics
        .iter()
        .any(|diagnostic| diagnostic.severity.is_blocking())
    {
        OperationStatus::Failed
    } else {
        OperationStatus::Passed
    };

    // Assemble the body with a placeholder redaction summary (it carries only
    // counts + a boolean, so it cannot itself hold a secret), deep-scan the raw
    // body, then attach the real redaction summary.
    let mut summary = Xp3PrivateLocalSummary {
        schema_version: XP3_PRIVATE_LOCAL_SUMMARY_SCHEMA_VERSION.to_string(),
        summary_id: input.summary_id.to_string(),
        support_boundary: XP3_PRIVATE_LOCAL_SUMMARY_SUPPORT_BOUNDARY.to_string(),
        status,
        helper_result_count: helper_rows.len() as u64,
        support_tuple_count: support_rows.len() as u64,
        patch_summary_count: patch_rows.len() as u64,
        honest_tuple_count,
        overclaim_tuple_count,
        capability_levels,
        helper_rows,
        support_rows,
        patch_rows,
        redaction_summary: Xp3PrivateLocalRedactionSummary {
            deep_scan_performed: false,
            strings_scanned: 0,
            secret_leak_findings: 0,
            redaction_boundary_ok: false,
            aggregate_redaction_status,
        },
        diagnostics,
    };

    // FAIL-LOUD deep scan (reject story text, screenshots, retail bytes, raw
    // helper output, raw keys, private paths). Scan the RAW body so a seeded
    // secret cannot be silently scrubbed and then written.
    let body = serde_json::to_value(&summary).map_err(|error| -> Box<dyn std::error::Error> {
        format!("{XP3_PRIVATE_LOCAL_SUMMARY_MARKER}: summary serialization: {error}").into()
    })?;
    let scan = deep_scan_persisted_artifact(&body);
    if scan.finding_count > 0 {
        return Err(format!(
            "{SEMANTIC_XP3_PRIVATE_LOCAL_SUMMARY_SECRET_LEAK}: refusing to return an XP3 private-local summary carrying secret-shaped material ({} finding(s), first field: {})",
            scan.finding_count,
            scan.first_field.as_deref().unwrap_or("<unknown>"),
        )
        .into());
    }

    summary.redaction_summary = Xp3PrivateLocalRedactionSummary {
        deep_scan_performed: true,
        strings_scanned: scan.strings_scanned,
        secret_leak_findings: 0,
        redaction_boundary_ok: true,
        aggregate_redaction_status,
    };

    Ok(summary)
}

fn support_tuple_row(entry: &ClaimedSupportEntryReport) -> Xp3SupportTupleRow {
    let mut evidence_proof_hashes: Vec<ProofHash> = Vec::new();
    for leg in [
        entry.evidence.extraction.as_ref(),
        entry.evidence.validation.as_ref(),
        entry.evidence.patch_back.as_ref(),
        entry.evidence.runtime.as_ref(),
    ]
    .into_iter()
    .flatten()
    {
        evidence_proof_hashes.push(leg.proof_hash.clone());
    }
    Xp3SupportTupleRow {
        profile_or_fixture_id: entry.profile_or_fixture_id.clone(),
        engine_family: entry.engine_family,
        engine_variant: entry.engine_variant.clone(),
        claimed_level: entry.claimed_level,
        patch_back_mode: entry.patch_back_mode,
        secret_requirement_ids: entry
            .secret_requirement_ids
            .iter()
            .map(|requirement| requirement.requirement_id.clone())
            .collect(),
        evidence_proof_hashes,
        honest: entry.is_honest(),
        status: entry.status.clone(),
        diagnostic_count: entry.diagnostics.len() as u64,
    }
}

fn aggregate_redaction_status(statuses: &[HelperRedactionStatus]) -> HelperRedactionStatus {
    if statuses.contains(&HelperRedactionStatus::Failed) {
        HelperRedactionStatus::Failed
    } else if statuses.contains(&HelperRedactionStatus::Redacted) {
        HelperRedactionStatus::Redacted
    } else {
        HelperRedactionStatus::NotRequired
    }
}

// Fail-loud deep scan (mirrors the profile-proof scan).

struct DeepScanResult {
    strings_scanned: u64,
    finding_count: u64,
    first_field: Option<String>,
}

/// Combine the field-name-gated [`validate_secret_redaction_boundary`] (catches
/// forbidden field NAMES such as `helperDump` / `rawKey` / `decryptedText`) with
/// a full-string value scan (catches any raw key, local absolute path, forbidden
/// private payload — helper dumps, decrypted/story text — or private/spoiler
/// filename in ANY field, via [`redact_for_log_or_report`]).
fn deep_scan_persisted_artifact(value: &Value) -> DeepScanResult {
    let mut strings_scanned = 0u64;
    let mut findings: Vec<String> = Vec::new();
    scan_strings(value, "$", &mut strings_scanned, &mut findings);
    for finding in validate_secret_redaction_boundary(value) {
        findings.push(finding.field);
    }
    let first_field = findings.first().cloned();
    DeepScanResult {
        strings_scanned,
        finding_count: findings.len() as u64,
        first_field,
    }
}

fn scan_strings(value: &Value, field: &str, strings_scanned: &mut u64, findings: &mut Vec<String>) {
    match value {
        Value::String(text) => {
            *strings_scanned += 1;
            if redact_for_log_or_report(text) != *text {
                findings.push(field.to_string());
            }
        }
        Value::Array(items) => {
            for (index, item) in items.iter().enumerate() {
                scan_strings(item, &format!("{field}.{index}"), strings_scanned, findings);
            }
        }
        Value::Object(object) => {
            for (key, child) in object {
                let child_field = if field == "$" {
                    key.clone()
                } else {
                    format!("{field}.{key}")
                };
                scan_strings(child, &child_field, strings_scanned, findings);
            }
        }
        _ => {}
    }
}

// Synthetic builders (public, reproducible — the source of truth for the
// committed fixtures + the public-safe summary).
