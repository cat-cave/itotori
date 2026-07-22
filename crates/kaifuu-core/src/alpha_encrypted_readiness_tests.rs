use super::*;
use std::path::PathBuf;

fn fixtures_dir() -> PathBuf {
    crate::test_manifest_dir()
        .join("../..")
        .join("fixtures/kaifuu/alpha-encrypted")
}

fn generate() -> AlphaEncryptedReadinessReport {
    generate_alpha_encrypted_readiness(&fixtures_dir())
        .expect("generation runs without environmental error")
}

#[test]
fn positive_dir_is_green_and_consumes_validation() {
    let report = generate();
    assert_eq!(
        report.status,
        OperationStatus::Passed,
        "failed entries: {:?}",
        report
            .entries
            .iter()
            .filter(|e| e.status == OperationStatus::Failed)
            .map(|e| (e.profile_id.clone(), e.findings.clone()))
            .collect::<Vec<_>>(),
    );
    // The validation report was consumed (status + hash).
    assert_eq!(report.consumed_validation.status, OperationStatus::Passed);
    assert!(
        report
            .consumed_validation
            .report_hash
            .as_str()
            .starts_with("sha256:")
    );
    assert_eq!(
        report.consumed_validation.profile_count,
        report.profile_count
    );
    // Both postures populate and the counts are consistent.
    assert!(report.profile_ready_count > 0);
    assert!(report.readiness_only_count > 0);
    assert_eq!(
        report.profile_ready_count + report.readiness_only_count,
        report.profile_count
    );
    // At least one patch-capable entry carries patch evidence.
    assert!(report.patch_evidence_count > 0);
    assert!(report.report_hash.as_str().starts_with("sha256:"));
}

#[test]
fn every_entry_names_the_acceptance_tuple() {
    let report = generate();
    for entry in &report.entries {
        assert!(!entry.profile_id.is_empty());
        assert!(!entry.fixture_id.is_empty());
        assert_eq!(entry.source_node_id, ALPHA_ENCRYPTED_SOURCE_NODE_ID);
        assert!(entry.content_hash.as_str().starts_with("sha256:"));
        // Posture/outcome and patch-result presence are mechanically tied.
        match entry.posture {
            PackedReadinessPosture::ProfileReady
                if requires_patch_evidence(entry.effective_outcome) =>
            {
                let patch = entry
                    .patch_result
                    .as_ref()
                    .expect("patch-capable profile-ready entry carries a patch result");
                assert!(patch.output_hash.as_str().starts_with("sha256:"));
                assert!(!entry.surface_ids.is_empty());
            }
            PackedReadinessPosture::ReadinessOnly => {
                assert!(
                    entry.patch_result.is_none(),
                    "readiness-only entry must not carry a patch result: {}",
                    entry.profile_id
                );
            }
            PackedReadinessPosture::ProfileReady => {}
        }
    }
}

#[test]
fn summary_is_readme_safe() {
    let report = generate();
    let summary = report.summary();
    assert_eq!(summary.evidence_kind, "readiness_evidence");
    assert_eq!(summary.report_hash, report.report_hash);
    let json = summary.stable_json().unwrap();
    // The summary names no asset / helper / key / patch id and no paths.
    assert!(!json.contains("local-secret:"));
    assert!(!json.contains("kaifuu.helper."));
    assert!(!json.contains("scene/"));
    assert!(!json.contains("/home/"));
    assert!(json.contains("readiness_evidence"));
    assert!(!summary.covered_engine_families.is_empty());
}

#[test]
fn report_redacts_private_paths_and_carries_no_raw_keys() {
    let report = generate();
    let json = report.stable_json().unwrap();
    assert!(!json.contains("/home/"));
    // Key references are local-scheme refs, never raw key bytes.
    for entry in &report.entries {
        if let Some(secret) = &entry.key_ref {
            assert!(secret.as_str().starts_with("local-secret:"));
        }
    }
}

fn base_validation_entry() -> PackedReadinessEntryReport {
    // Reuse the validator over a single real profile.
    let dir = fixtures_dir();
    let report = validate_packed_engine_readiness_dir(&dir).unwrap();
    report
        .entries
        .iter()
        .find(|e| e.posture == PackedReadinessPosture::ProfileReady)
        .cloned()
        .expect("a profile-ready entry exists")
}

#[test]
fn patch_capable_profile_ready_without_artifact_fails() {
    let entry = base_validation_entry();
    assert!(requires_patch_evidence(entry.effective_outcome));
    let built = build_entry(&entry, None, &[]);
    assert_eq!(built.status, OperationStatus::Failed);
    assert!(
        built
            .findings
            .iter()
            .any(|f| f.code == "alpha.encrypted.patch_result_ref_missing")
    );
}

#[test]
fn readiness_only_with_patch_artifact_fails() {
    let dir = fixtures_dir();
    let report = validate_packed_engine_readiness_dir(&dir).unwrap();
    let readiness_only = report
        .entries
        .iter()
        .find(|e| e.posture == PackedReadinessPosture::ReadinessOnly)
        .cloned()
        .expect("a readiness-only entry exists");
    let artifact = AlphaEncryptedPatchArtifact {
        schema_version: ALPHA_ENCRYPTED_PATCH_ARTIFACT_SCHEMA_VERSION.to_string(),
        patch_result_id: "patch/should-not-exist".to_string(),
        profile_id: readiness_only.profile_id.clone(),
        source_node_id: ALPHA_ENCRYPTED_SOURCE_NODE_ID.to_string(),
        status: OperationStatus::Passed,
        patch_back: readiness_only.transform_stack.patch_back,
        touched_assets: vec!["scene/000.ss".to_string()],
        output_hash: ProofHash::new(sha256_hash_bytes(b"synthetic")).unwrap(),
    };
    let built = build_entry(&readiness_only, None, std::slice::from_ref(&artifact));
    assert_eq!(built.status, OperationStatus::Failed);
    assert!(
        built
            .findings
            .iter()
            .any(|f| f.code == "alpha.encrypted.readiness_only_claims_patch")
    );
}

#[test]
fn empty_dir_reports_missing_inputs() {
    // A per-test tempdir (unique, auto-cleaned on drop) — never a shared or
    // fixed temp path, so this test is self-contained and cannot race with
    // any other.
    let tmp = tempfile::tempdir().unwrap();
    let report = generate_alpha_encrypted_readiness(tmp.path()).unwrap();
    assert_eq!(report.status, OperationStatus::Failed);
    assert!(
        report
            .findings
            .iter()
            .any(|f| f.code == "alpha.encrypted.fixture_inputs_missing")
    );
}

#[test]
fn report_round_trips() {
    let report = generate();
    let json = report.stable_json().unwrap();
    assert!(json.ends_with('\n'));
    let parsed: AlphaEncryptedReadinessReport = serde_json::from_str(&json).unwrap();
    assert_eq!(parsed.status, report.status);
    assert_eq!(parsed.report_hash, report.report_hash);
    assert_eq!(parsed.entries.len(), report.entries.len());
}
