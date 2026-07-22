use super::*;

/// Compose the Siglus profile proof from the already-run slice outputs.
/// Records detector evidence, key-profile id, parser-profile id, capability
/// level, and a redaction summary. Cross-checks (blocking diagnostics → `Failed`
/// status): the detector must have identified a Siglus profile; the parser and
/// compat slices must not themselves be `Failed`; the declared capability level
/// must not overclaim past the evidence ceiling (`known-key-extract`).
/// FAIL-LOUD: the fully-composed report is deep-scanned; if any raw key, helper
/// dump, private path, or decrypted private text is present the function returns
/// `Err` — no report is returned, so nothing can be persisted.
pub fn compose_siglus_profile_proof(
    input: SiglusProfileProofComposeInput<'_>,
) -> KaifuuResult<SiglusProfileProofReport> {
    let fixture = input.fixture;
    let detection = input.detection;
    let parser = input.parser_boundary;
    let compat = input.compat_entry;

    let mut diagnostics: Vec<SiglusProfileProofDiagnostic> = Vec::new();

    let detector_is_siglus =
        detection.detected && detection.engine_family.as_deref() == Some("siglus");
    if !detector_is_siglus {
        diagnostics.push(SiglusProfileProofDiagnostic {
            code: "detector_mismatch".to_string(),
            severity: PartialDiagnosticSeverity::P1,
            field: "detector".to_string(),
            message: "detector slice did not identify a Siglus profile for the fixture game dir"
                .to_string(),
            semantic_code: SEMANTIC_SIGLUS_PROFILE_PROOF_DETECTOR_MISMATCH.to_string(),
        });
    }
    let detector = SiglusProfileProofDetector {
        adapter_id: detection.adapter_id.clone(),
        detected: detection.detected,
        engine_family: detection.engine_family.clone(),
        detected_variant: detection.detected_variant.clone(),
        evidence: detection
            .evidence
            .iter()
            .map(|evidence| SiglusProfileProofDetectorEvidence {
                path: evidence.path.clone(),
                kind: evidence.kind.clone(),
                status: evidence.status.clone(),
            })
            .collect(),
    };

    if parser.status == OperationStatus::Failed {
        diagnostics.push(SiglusProfileProofDiagnostic {
            code: "parser_boundary_failed".to_string(),
            severity: PartialDiagnosticSeverity::P1,
            field: "parserProfile".to_string(),
            message: "parser-boundary slice reported a failed outcome".to_string(),
            semantic_code: SEMANTIC_SIGLUS_PROFILE_PROOF_SLICE_FAILED.to_string(),
        });
    }
    let scene_hash = parser
        .sources
        .first()
        .map_or_else(zeroed_proof_hash, |source| source.source_hash.clone());
    let parser_profile = SiglusProfileProofParserProfile {
        parser_profile_id: fixture.parser.parser_profile_id.clone(),
        outcome: parser.outcome,
        status: parser.status.clone(),
        patch_write_attempted: parser.patch_write_attempted,
        source_count: parser.sources.len() as u64,
        text_slot_count: parser.text_slots.len() as u64,
        scene_hash,
    };

    // --- Key-profile slice (known-key, extract core NotImplemented)
    let key_refs: Vec<SiglusProfileProofKeyRef> = parser
        .key_refs
        .iter()
        .map(|key_ref| SiglusProfileProofKeyRef {
            requirement_id: key_ref.requirement_id.clone(),
            secret_ref: key_ref.secret_ref.clone(),
            redaction_status: key_ref.redaction_status,
        })
        .collect();
    let key_ref_redaction_status = aggregate_redaction_status(&key_refs);
    let key_profile = SiglusProfileProofKeyProfile {
        key_profile_id: fixture.key_profile.key_profile_id.clone(),
        secret_ref: fixture.key_profile.secret_ref.clone(),
        known_key_only: true,
        extract_core_status: "not_implemented".to_string(),
        key_refs,
    };

    if compat.status == OperationStatus::Failed {
        diagnostics.push(SiglusProfileProofDiagnostic {
            code: "compat_validation_failed".to_string(),
            severity: PartialDiagnosticSeverity::P1,
            field: "compat".to_string(),
            message: "compat-profile validation reported an overclaim / failed tuple".to_string(),
            semantic_code: SEMANTIC_SIGLUS_PROFILE_PROOF_SLICE_FAILED.to_string(),
        });
    }
    let compat_report = SiglusProfileProofCompat {
        profile_or_fixture_id: compat.profile_or_fixture_id.clone(),
        claimed_level: compat.claimed_level,
        patch_back_mode: compat.patch_back_mode,
        honest: compat.status == OperationStatus::Passed,
        status: compat.status.clone(),
        diagnostic_count: compat.diagnostics.len() as u64,
    };

    // The evidence ceiling is derived from the compat entry. Because the Siglus
    // extract/patch core is NotImplemented, patch-back is never a real write mode
    // here, so the ceiling can never exceed `known-key-extract`.
    let ceiling = capability_ceiling_from_compat(compat);
    if fixture.capability_level.claim_rank() > ceiling.claim_rank() {
        diagnostics.push(SiglusProfileProofDiagnostic {
            code: "capability_overclaim".to_string(),
            severity: PartialDiagnosticSeverity::P0,
            field: "capabilityLevel".to_string(),
            message: format!(
                "declared capability level {} overclaims past the evidence ceiling {}",
                fixture.capability_level.as_str(),
                ceiling.as_str()
            ),
            semantic_code: SEMANTIC_SIGLUS_PROFILE_PROOF_CAPABILITY_OVERCLAIM.to_string(),
        });
    }

    let status = if diagnostics
        .iter()
        .any(|diagnostic| diagnostic.severity.is_blocking())
    {
        OperationStatus::Failed
    } else {
        OperationStatus::Passed
    };

    // Assemble the report body WITHOUT the redaction summary, deep-scan it, then
    // attach the summary. The summary carries only counts + a boolean, so it
    // cannot itself hold a secret.
    let mut report = SiglusProfileProofReport {
        schema_version: SIGLUS_PROFILE_PROOF_SCHEMA_VERSION.to_string(),
        fixture_id: fixture.fixture_id.clone(),
        profile_id: fixture.profile_id.clone(),
        status,
        support_boundary: SIGLUS_PROFILE_PROOF_SUPPORT_BOUNDARY.to_string(),
        broad_commercial_claim: false,
        capability_level: fixture.capability_level,
        detector,
        key_profile,
        parser_profile,
        compat: compat_report,
        redaction_summary: SiglusProfileProofRedactionSummary {
            deep_scan_performed: false,
            strings_scanned: 0,
            secret_leak_findings: 0,
            redaction_boundary_ok: false,
            key_ref_redaction_status,
        },
        diagnostics,
    };

    // FAIL-LOUD deep scan (acceptance 2). Scan the raw, un-redacted body so a
    // seeded secret cannot be silently scrubbed and then written.
    let body = serde_json::to_value(&report)
        .map_err(|error| format!("profile-proof serialization: {error}"))?;
    let scan = deep_scan_persisted_artifact(&body);
    if scan.finding_count > 0 {
        return Err(format!(
            "{SEMANTIC_SIGLUS_PROFILE_PROOF_SECRET_LEAK}: refusing to persist a Siglus profile-proof artifact carrying secret-shaped material ({} finding(s), first field: {})",
            scan.finding_count,
            scan.first_field.as_deref().unwrap_or("<unknown>"),
        )
        .into());
    }

    report.redaction_summary = SiglusProfileProofRedactionSummary {
        deep_scan_performed: true,
        strings_scanned: scan.strings_scanned,
        secret_leak_findings: 0,
        redaction_boundary_ok: true,
        key_ref_redaction_status,
    };

    Ok(report)
}

/// Derive the honest capability ceiling from the validated compat entry.
fn capability_ceiling_from_compat(
    compat: &ClaimedSupportEntryReport,
) -> SiglusProfileCapabilityLevel {
    // An overclaimed / failed tuple grants no capability beyond detection.
    if compat.status != OperationStatus::Passed {
        return SiglusProfileCapabilityLevel::DetectOnly;
    }
    match compat.claimed_level {
        ClaimedSupportLevel::Identify | ClaimedSupportLevel::Inventory => {
            SiglusProfileCapabilityLevel::DetectOnly
        }
        // Extract with a real patch-back write mode would be patch-verify, but the
        // Siglus core has no real patch-back, so extract caps at known-key-extract.
        ClaimedSupportLevel::Extract => SiglusProfileCapabilityLevel::KnownKeyExtract,
        ClaimedSupportLevel::Patch | ClaimedSupportLevel::Helper | ClaimedSupportLevel::Runtime => {
            if is_real_patch_back(compat.patch_back_mode) {
                SiglusProfileCapabilityLevel::KnownKeyPatchVerify
            } else {
                SiglusProfileCapabilityLevel::KnownKeyExtract
            }
        }
    }
}

/// The `sha256:` of the empty input. Used only as an unreachable fallback when
/// the parser slice reports no sources (it always reports Scene.pck + Gameexe.dat).
fn zeroed_proof_hash() -> ProofHash {
    ProofHash::new(
        "sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855".to_string(),
    )
    .expect("static empty-input sha256 ref is valid")
}

fn aggregate_redaction_status(key_refs: &[SiglusProfileProofKeyRef]) -> HelperRedactionStatus {
    if key_refs
        .iter()
        .any(|key_ref| key_ref.redaction_status == HelperRedactionStatus::Failed)
    {
        HelperRedactionStatus::Failed
    } else if key_refs
        .iter()
        .any(|key_ref| key_ref.redaction_status == HelperRedactionStatus::Redacted)
    {
        HelperRedactionStatus::Redacted
    } else {
        HelperRedactionStatus::NotRequired
    }
}

/// Result of the fail-loud deep scan.
struct DeepScanResult {
    strings_scanned: u64,
    finding_count: u64,
    first_field: Option<String>,
}

/// Deep-scan a to-be-persisted artifact for secret-shaped material.
/// Combines two boundaries: the canonical field-name-gated
/// [`validate_secret_redaction_boundary`] (catches forbidden field NAMES such as
/// `helperDump` / `rawKey`) and a full-string value scan (catches any raw key,
/// local absolute path, forbidden private payload, or private filename in ANY
/// field, via [`redact_for_log_or_report`]).
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
