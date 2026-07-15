use std::path::PathBuf;

use super::*;

fn manifest_dir() -> PathBuf {
    crate::test_manifest_dir()
        .join("../..")
        .join("fixtures/kaifuu/kirikiri")
}

fn load_fixture() -> Xp3CapabilityProfileFixture {
    let path = manifest_dir().join("xp3-capability-profile.json");
    read_json(&path).expect("capability-profile manifest must parse")
}

fn generate(fixture: &Xp3CapabilityProfileFixture) -> Xp3CapabilityProfileReport {
    generate_xp3_capability_profile(Xp3CapabilityProfileRequest {
        fixture,
        fixture_dir: &manifest_dir(),
        fixture_file_name: "xp3-capability-profile.json",
    })
    .expect("generation must not error environmentally")
}

fn entry_mut<'a>(
    fixture: &'a mut Xp3CapabilityProfileFixture,
    entry_id: &str,
) -> &'a mut Xp3CapabilityProfileFixtureEntry {
    fixture
        .entries
        .iter_mut()
        .find(|entry| entry.entry_id == entry_id)
        .expect("entry must exist")
}

fn has_finding(report: &Xp3CapabilityProfileReport, entry_id: &str, code: &str) -> bool {
    report
        .entry(entry_id)
        .is_some_and(|entry| entry.findings.iter().any(|finding| finding.code == code))
}

#[test]
fn capability_profile_generated_from_evidence_passes() {
    let fixture = load_fixture();
    let report = generate(&fixture);
    assert_eq!(
        report.status,
        OperationStatus::Passed,
        "{:?}",
        report.entries
    );
    assert_eq!(report.entries.len(), 6);
    for entry in &report.entries {
        assert_eq!(
            entry.status,
            OperationStatus::Passed,
            "entry {} failed: {:?}",
            entry.entry_id,
            entry.findings
        );
        // Every entry records the full acceptance tuple of provenance.
        assert_eq!(entry.source_node_id, fixture.source_node_id);
        assert!(!entry.fixture_id.is_empty());
        assert!(
            entry
                .validation_command
                .starts_with("kaifuu xp3 capability-profile --fixture")
        );
        assert_eq!(entry.redaction_status, "redacted");
    }
}

#[test]
fn plain_is_the_only_claimed_tier_and_ks_is_null_container() {
    let fixture = load_fixture();
    let report = generate(&fixture);

    let plain = report.entry("plain-xp3").unwrap();
    assert_eq!(
        plain.capability_tuple.support_tier,
        Xp3CapabilitySupportTier::Claimed
    );
    assert_eq!(
        plain.capability_tuple.patch_capability,
        Xp3PatchCapabilityLevel::PatchBack
    );

    // The.ks null container is its OWN tier — never the commercial baseline
    // (which is the claimed plain-XP3 tier).
    let ks = report.entry("plaintext-ks-null-container").unwrap();
    assert_eq!(
        ks.capability_tuple.support_tier,
        Xp3CapabilitySupportTier::NullContainer
    );
    assert_ne!(
        ks.capability_tuple.support_tier,
        Xp3CapabilitySupportTier::Claimed
    );

    // Every non-plain archive variant is research-tier with no patch claim.
    for entry_id in [
        "encrypted-xp3",
        "helper-required-xp3",
        "protected-executable",
        "universal-dump",
    ] {
        let entry = report.entry(entry_id).unwrap();
        assert_eq!(
            entry.capability_tuple.support_tier,
            Xp3CapabilitySupportTier::Research,
            "{entry_id} must be research-tier"
        );
        assert_ne!(
            entry.capability_tuple.patch_capability,
            Xp3PatchCapabilityLevel::PatchBack,
            "{entry_id} must not claim patch-back"
        );
    }
}

#[test]
fn encrypted_variant_can_never_be_claimed() {
    // Pure mechanical rule: no non-plain classification, under any patch
    // capability, can ever reach the Claimed tier.
    for classification in [
        Xp3ProfileClassification::Encrypted,
        Xp3ProfileClassification::Compressed,
        Xp3ProfileClassification::HelperRequired,
        Xp3ProfileClassification::UnsupportedProtectedExecutable,
    ] {
        for patch in [
            Xp3PatchCapabilityLevel::Detect,
            Xp3PatchCapabilityLevel::Extract,
            Xp3PatchCapabilityLevel::PatchBack,
            Xp3PatchCapabilityLevel::Unsupported,
        ] {
            assert_ne!(
                derive_support_tier(Some(classification), patch),
                Xp3CapabilitySupportTier::Claimed,
                "{} + {} must never be claimed",
                classification.as_str(),
                patch.as_str()
            );
        }
    }
    // Only plain + patch_back yields Claimed.
    assert_eq!(
        derive_support_tier(
            Some(Xp3ProfileClassification::Plain),
            Xp3PatchCapabilityLevel::PatchBack
        ),
        Xp3CapabilitySupportTier::Claimed
    );
    // Plain without patch_back does not.
    assert_eq!(
        derive_support_tier(
            Some(Xp3ProfileClassification::Plain),
            Xp3PatchCapabilityLevel::Detect
        ),
        Xp3CapabilitySupportTier::Research
    );
    assert_eq!(
        derive_support_tier(None, Xp3PatchCapabilityLevel::Detect),
        Xp3CapabilitySupportTier::NullContainer
    );
}

#[test]
fn declaring_a_patch_claim_on_an_encrypted_variant_is_a_blocking_overclaim() {
    let mut fixture = load_fixture();
    let entry = entry_mut(&mut fixture, "encrypted-xp3");
    entry.expected.support_tier = Xp3CapabilitySupportTier::Claimed;
    entry.expected.patch_capability = Xp3PatchCapabilityLevel::PatchBack;
    let report = generate(&fixture);

    assert_eq!(report.status, OperationStatus::Failed);
    assert!(has_finding(
        &report,
        "encrypted-xp3",
        "xp3.capability.encrypted_patch_overclaim"
    ));
    // Crucially: the GENERATED tuple still refuses the claim — the manifest
    // cannot talk the variant into a claimed patch capability.
    let entry = report.entry("encrypted-xp3").unwrap();
    assert_eq!(
        entry.capability_tuple.support_tier,
        Xp3CapabilitySupportTier::Research
    );
    assert_ne!(
        entry.capability_tuple.patch_capability,
        Xp3PatchCapabilityLevel::PatchBack
    );
}

#[test]
fn validator_fails_on_bad_detector_evidence() {
    let mut fixture = load_fixture();
    // Point the plain entry's detector evidence at the encrypted archive.
    entry_mut(&mut fixture, "plain-xp3").detector_fixture =
        Some("xp3-encrypted-profile.json".to_string());
    let report = generate(&fixture);

    assert_eq!(report.status, OperationStatus::Failed);
    assert!(has_finding(
        &report,
        "plain-xp3",
        "xp3.capability.detector_classification_mismatch"
    ));
}

#[test]
fn validator_fails_on_helper_requirement_mismatch() {
    let mut fixture = load_fixture();
    entry_mut(&mut fixture, "encrypted-xp3")
        .expected
        .helper_requirement = Xp3HelperRequirement::Required;
    let report = generate(&fixture);

    assert_eq!(report.status, OperationStatus::Failed);
    assert!(has_finding(
        &report,
        "encrypted-xp3",
        "xp3.capability.helper_requirement_mismatch"
    ));
}

#[test]
fn validator_fails_on_key_ref_state_mismatch() {
    let mut fixture = load_fixture();
    entry_mut(&mut fixture, "encrypted-xp3")
        .expected
        .key_ref_present = false;
    let report = generate(&fixture);

    assert_eq!(report.status, OperationStatus::Failed);
    assert!(has_finding(
        &report,
        "encrypted-xp3",
        "xp3.capability.key_ref_state_mismatch"
    ));
}

#[test]
fn validator_fails_on_archive_hash_mismatch() {
    let mut fixture = load_fixture();
    entry_mut(&mut fixture, "plain-xp3").expected.archive_hash =
        ProofHash::new(format!("sha256:{}", "0".repeat(64))).unwrap();
    let report = generate(&fixture);

    assert_eq!(report.status, OperationStatus::Failed);
    assert!(has_finding(
        &report,
        "plain-xp3",
        "xp3.capability.archive_hash_mismatch"
    ));
}

#[test]
fn validator_fails_on_patch_capability_tuple_mismatch() {
    let mut fixture = load_fixture();
    let entry = entry_mut(&mut fixture, "plain-xp3");
    entry.expected.patch_capability = Xp3PatchCapabilityLevel::Unsupported;
    let report = generate(&fixture);

    assert_eq!(report.status, OperationStatus::Failed);
    assert!(has_finding(
        &report,
        "plain-xp3",
        "xp3.capability.patch_tuple_mismatch"
    ));
}

#[test]
fn report_redacts_secrets_and_never_carries_raw_bytes() {
    let mut fixture = load_fixture();
    // A profile id carrying a private local path must be scrubbed (the
    // "local paths" redaction concern from the acceptance).
    fixture.capability_profile_id = "/home/trevor/private/game/leak.xp3".to_string();
    let report = generate(&fixture);
    let json = report.stable_json().expect("stable json");

    // The redaction sentinel replaced the path-bearing id.
    assert!(json.contains("[REDACTED:"));
    assert!(!json.contains("/home/trevor/private/game/leak.xp3"));

    // The raw.ks source text never appears — only its hash and counts do.
    let ks_bytes = std::fs::read(manifest_dir().join("plain-script.ks")).unwrap();
    let ks_text = String::from_utf8_lossy(&ks_bytes);
    for line in ks_text.lines().filter(|line| line.len() > 8) {
        assert!(
            !json.contains(line.trim()),
            "raw .ks source line leaked into the report: {line}"
        );
    }
    // The.ks evidence is present as a hash, not bytes.
    assert!(json.contains(&sha256_hash_bytes(&ks_bytes)));
}

#[test]
fn missing_detector_evidence_is_a_blocking_finding_not_a_panic() {
    let mut fixture = load_fixture();
    entry_mut(&mut fixture, "plain-xp3").detector_fixture = None;
    let report = generate(&fixture);

    assert_eq!(report.status, OperationStatus::Failed);
    assert!(has_finding(
        &report,
        "plain-xp3",
        "xp3.capability.detector_fixture_missing"
    ));
}
