use super::*;

pub(super) fn generate_entry(
    entry: &Xp3CapabilityProfileFixtureEntry,
    source_node_id: &str,
    fixture_dir: &Path,
    validation_command: &str,
) -> Xp3CapabilityProfileEntryReport {
    let mut evidence = match super::evidence::derive_evidence(entry, fixture_dir) {
        Ok(evidence) => evidence,
        Err(finding) => {
            // An unreadable / malformed evidence input is itself a blocking
            // finding, never an `Err` from the generator.
            return failed_entry(entry, source_node_id, validation_command, finding);
        }
    };

    let mut findings = std::mem::take(&mut evidence.findings);

    // (1) Bad detector evidence: the routed classification must match the
    // variant's required classification.
    validate_detector_evidence(entry, &evidence, &mut findings);

    // (2) Helper requirement mismatch.
    if entry.expected.helper_requirement != evidence.helper_requirement {
        findings.push(finding(
            "xp3.capability.helper_requirement_mismatch",
            PartialDiagnosticSeverity::P0,
            "expected.helperRequirement",
            format!(
                "entry declared helperRequirement {} but evidence derived {}",
                entry.expected.helper_requirement.as_str(),
                evidence.helper_requirement.as_str()
            ),
            SEMANTIC_CAPABILITY_EVIDENCE_MISMATCH,
        ));
    }

    // (3) KeyRef state mismatch (presence + crypt-profile status).
    if entry.expected.key_ref_present != evidence.key_ref_present {
        findings.push(finding(
            "xp3.capability.key_ref_state_mismatch",
            PartialDiagnosticSeverity::P0,
            "expected.keyRefPresent",
            format!(
                "entry declared keyRefPresent={} but evidence derived {}",
                entry.expected.key_ref_present, evidence.key_ref_present
            ),
            SEMANTIC_CAPABILITY_EVIDENCE_MISMATCH,
        ));
    }
    if entry.expected.crypt_profile_status != evidence.crypt_profile_status {
        findings.push(finding(
            "xp3.capability.crypt_profile_status_mismatch",
            PartialDiagnosticSeverity::P0,
            "expected.cryptProfileStatus",
            format!(
                "entry declared cryptProfileStatus {} but evidence derived {}",
                entry.expected.crypt_profile_status.as_str(),
                evidence.crypt_profile_status.as_str()
            ),
            SEMANTIC_CAPABILITY_EVIDENCE_MISMATCH,
        ));
    }

    // (4) Archive hash mismatch.
    if entry.expected.archive_hash.as_str() != evidence.archive_hash.as_str() {
        findings.push(finding(
            "xp3.capability.archive_hash_mismatch",
            PartialDiagnosticSeverity::P0,
            "expected.archiveHash",
            "entry declared archiveHash does not match the hashed archive bytes".to_string(),
            SEMANTIC_CAPABILITY_EVIDENCE_MISMATCH,
        ));
    }
    if entry.expected.entry_count != evidence.entry_count {
        findings.push(finding(
            "xp3.capability.entry_count_mismatch",
            PartialDiagnosticSeverity::P1,
            "expected.entryCount",
            format!(
                "entry declared entryCount {:?} but evidence derived {:?}",
                entry.expected.entry_count, evidence.entry_count
            ),
            SEMANTIC_CAPABILITY_EVIDENCE_MISMATCH,
        ));
    }

    // This is THE mechanical line: support tier is a pure function of the
    // routed classification + derived patch capability, NOT of the declared
    // expectation. A non-plain variant therefore cannot be generated into a
    // claimed tuple no matter what the manifest declares.
    let support_tier = derive_support_tier(evidence.classification, evidence.patch_capability);
    let mut tuple = Xp3CapabilityTuple {
        support_tier,
        classification: evidence.classification,
        patch_capability: evidence.patch_capability,
    };
    // Research / null-container tiers never advertise a patch-back capability.
    if support_tier != Xp3CapabilitySupportTier::Claimed
        && tuple.patch_capability == Xp3PatchCapabilityLevel::PatchBack
    {
        tuple.patch_capability = Xp3PatchCapabilityLevel::Unsupported;
    }

    // (5) Patch-capability-tuple mismatch: the declared tier / patch capability
    // must match the evidence-derived tuple.
    if entry.expected.support_tier != tuple.support_tier
        || entry.expected.patch_capability != tuple.patch_capability
    {
        findings.push(finding(
            "xp3.capability.patch_tuple_mismatch",
            PartialDiagnosticSeverity::P0,
            "expected.supportTier",
            format!(
                "entry declared (tier={}, patch={}) but evidence derived (tier={}, patch={})",
                entry.expected.support_tier.as_str(),
                entry.expected.patch_capability.as_str(),
                tuple.support_tier.as_str(),
                tuple.patch_capability.as_str()
            ),
            SEMANTIC_CAPABILITY_EVIDENCE_MISMATCH,
        ));
    }

    // (6) Mechanical overclaim guard: a non-plain variant that DECLARES a
    // claimed tier or patch-back capability is a hard overclaim, even
    // though the generated tuple already refused it.
    if entry.variant != Xp3CapabilityVariant::PlainXp3
        && entry.variant != Xp3CapabilityVariant::PlaintextKs
        && (entry.expected.support_tier == Xp3CapabilitySupportTier::Claimed
            || entry.expected.patch_capability == Xp3PatchCapabilityLevel::PatchBack)
    {
        findings.push(finding(
            "xp3.capability.encrypted_patch_overclaim",
            PartialDiagnosticSeverity::P0,
            "expected.supportTier",
            format!(
                "variant {} is research-tier only and must not claim patch-back support",
                entry.variant.as_str()
            ),
            SEMANTIC_CAPABILITY_ENCRYPTED_PATCH_OVERCLAIM,
        ));
    }

    let status = if findings
        .iter()
        .any(|finding| finding.severity.is_blocking())
    {
        OperationStatus::Failed
    } else {
        OperationStatus::Passed
    };

    Xp3CapabilityProfileEntryReport {
        entry_id: entry.entry_id.clone(),
        source_node_id: source_node_id.to_string(),
        fixture_id: evidence.fixture_id,
        engine_variant: entry.variant,
        workflow: entry.workflow.clone(),
        archive_profile: Xp3CapabilityArchiveProfile {
            archive_id: evidence.archive_id,
            archive_hash: evidence.archive_hash,
            entry_count: evidence.entry_count,
        },
        key_helper_requirement: Xp3CapabilityKeyHelperRequirement {
            helper_requirement: evidence.helper_requirement,
            crypt_profile_status: evidence.crypt_profile_status,
            key_ref_present: evidence.key_ref_present,
            requirement_id: evidence.requirement_id,
            secret_ref: evidence.secret_ref,
            helper_result_present: evidence.helper_result_present,
        },
        capability_tuple: tuple,
        validation_command: validation_command.to_string(),
        redaction_status: "redacted".to_string(),
        status,
        findings,
    }
}

fn validate_detector_evidence(
    entry: &Xp3CapabilityProfileFixtureEntry,
    evidence: &DerivedEvidence,
    findings: &mut Vec<Xp3CapabilityFinding>,
) {
    match (
        entry.variant.expected_classification(),
        evidence.classification,
    ) {
        // Variants with a fixed required classification.
        (Some(required), Some(actual)) if required != actual => {
            findings.push(finding(
                "xp3.capability.detector_classification_mismatch",
                PartialDiagnosticSeverity::P0,
                "variant",
                format!(
                    "variant {} requires detector classification {} but evidence routed {}",
                    entry.variant.as_str(),
                    required.as_str(),
                    actual.as_str()
                ),
                SEMANTIC_CAPABILITY_EVIDENCE_MISMATCH,
            ));
        }
        // Universal-dump: any non-plain archive is acceptable; a plain one is
        // a mis-route (universal dump is for archives nothing else patches).
        (None, Some(Xp3ProfileClassification::Plain))
            if entry.variant == Xp3CapabilityVariant::UniversalDump =>
        {
            findings.push(finding(
                "xp3.capability.universal_dump_on_plain",
                PartialDiagnosticSeverity::P0,
                "variant",
                "universal_dump must route to a non-plain archive (plain XP3 is the claimed-support concern)"
                    .to_string(),
                SEMANTIC_CAPABILITY_EVIDENCE_MISMATCH,
            ));
        }
        _ => {}
    }

    // The author's declared classification, when present, must also match.
    if let (Some(declared), actual) = (entry.expected.classification, evidence.classification)
        && Some(declared) != actual
    {
        findings.push(finding(
            "xp3.capability.declared_classification_mismatch",
            PartialDiagnosticSeverity::P0,
            "expected.classification",
            format!(
                "entry declared classification {} but evidence routed {}",
                declared.as_str(),
                actual.map_or("none", Xp3ProfileClassification::as_str)
            ),
            SEMANTIC_CAPABILITY_EVIDENCE_MISMATCH,
        ));
    }
}

fn failed_entry(
    entry: &Xp3CapabilityProfileFixtureEntry,
    source_node_id: &str,
    validation_command: &str,
    finding: Xp3CapabilityFinding,
) -> Xp3CapabilityProfileEntryReport {
    // A placeholder archive hash for the empty byte stream so the report is
    // well-formed; the blocking finding + Failed status make it clear no
    // archive evidence was actually inspected.
    let archive_hash = ProofHash::new(sha256_hash_bytes(&[]))
        .unwrap_or_else(|_| unreachable!("empty sha256 is a valid proof hash"));
    Xp3CapabilityProfileEntryReport {
        entry_id: entry.entry_id.clone(),
        source_node_id: source_node_id.to_string(),
        fixture_id: format!("{}-unresolved", entry.entry_id),
        engine_variant: entry.variant,
        workflow: entry.workflow.clone(),
        archive_profile: Xp3CapabilityArchiveProfile {
            archive_id: "unresolved".to_string(),
            archive_hash,
            entry_count: None,
        },
        key_helper_requirement: Xp3CapabilityKeyHelperRequirement {
            helper_requirement: Xp3HelperRequirement::NotRequired,
            crypt_profile_status: Xp3CryptProfileStatus::NotRequired,
            key_ref_present: false,
            requirement_id: None,
            secret_ref: None,
            helper_result_present: entry.helper_result_fixture.is_some(),
        },
        capability_tuple: Xp3CapabilityTuple {
            support_tier: Xp3CapabilitySupportTier::Research,
            classification: None,
            patch_capability: Xp3PatchCapabilityLevel::Unsupported,
        },
        validation_command: validation_command.to_string(),
        redaction_status: "redacted".to_string(),
        status: OperationStatus::Failed,
        findings: vec![finding],
    }
}
