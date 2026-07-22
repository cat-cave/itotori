use super::*;

fn fixture_dir() -> PathBuf {
    crate::test_manifest_dir()
        .join("../..")
        .join("fixtures/public/kaifuu-encrypted-xp3-contract-scaffold")
}

fn fixture_descriptor() -> PathBuf {
    fixture_dir().join("contract-scaffold.fixture.json")
}

fn copy_dir_recursive(source: &Path, dest: &Path) {
    fs::create_dir_all(dest).unwrap();
    for entry in fs::read_dir(source).unwrap() {
        let entry = entry.unwrap();
        let target = dest.join(entry.file_name());
        if entry.file_type().unwrap().is_dir() {
            copy_dir_recursive(&entry.path(), &target);
        } else {
            fs::copy(entry.path(), &target).unwrap();
        }
    }
}

#[test]
fn stage_count_matches_contract() {
    // Compile-time half of the drift guard: the canonical stage list must
    // enumerate exactly the six contract stages, in order.
    assert_eq!(CONTRACT_SCAFFOLD_STAGES.len(), 6);
    assert_eq!(
        CONTRACT_SCAFFOLD_STAGES,
        &[
            ContractStage::Detect,
            ContractStage::KeyResolution,
            ContractStage::Extract,
            ContractStage::Patch,
            ContractStage::Verify,
            ContractStage::DeltaApply,
        ]
    );
}

#[test]
fn rejects_fixture_that_disclaims_the_not_retail_readiness_invariant() {
    let staging = tempfile::tempdir().unwrap();
    let fixture_root = staging.path().join("fixture");
    copy_dir_recursive(&fixture_dir(), &fixture_root);

    // Flip the integrity flag to false in the copied descriptor; the
    // harness must refuse it rather than emit a contradictory report.
    let descriptor = fixture_root.join("contract-scaffold.fixture.json");
    let mut value: serde_json::Value =
        serde_json::from_slice(&fs::read(&descriptor).unwrap()).unwrap();
    value["notRetailReadinessClaim"] = serde_json::Value::Bool(false);
    fs::write(&descriptor, serde_json::to_vec_pretty(&value).unwrap()).unwrap();

    let work = tempfile::tempdir().unwrap();
    let result = run_encrypted_xp3_contract_scaffold(&descriptor, &work.path().join("run"));
    assert!(
        result.is_err(),
        "fixture asserting notRetailReadinessClaim:false must be rejected"
    );
}

#[test]
fn full_contract_surface_passes_end_to_end() {
    let work = tempfile::tempdir().unwrap();
    let report =
        run_encrypted_xp3_contract_scaffold(&fixture_descriptor(), &work.path().join("run"))
            .expect("harness should not error environmentally");

    assert_eq!(
        report.status,
        OperationStatus::Passed,
        "stages: {:?}",
        report.stages
    );
    assert!(report.not_retail_readiness_claim);
    assert_eq!(
        report.disclaimer,
        ENCRYPTED_XP3_CONTRACT_SCAFFOLD_DISCLAIMER
    );
    assert!(
        report.disclaimer.to_lowercase().contains("not")
            && report.disclaimer.to_lowercase().contains("readiness"),
        "disclaimer must disclaim readiness"
    );

    // Every canonical stage ran exactly once and passed.
    assert_eq!(report.stages.len(), CONTRACT_SCAFFOLD_STAGES.len());
    for stage in CONTRACT_SCAFFOLD_STAGES {
        let outcome = report
            .stage(*stage)
            .unwrap_or_else(|| panic!("stage {} missing", stage.as_str()));
        assert_eq!(
            outcome.status,
            ContractStageStatus::Passed,
            "stage {} failed: {}",
            stage.as_str(),
            outcome.detail
        );
        assert!(outcome.semantic_code.is_none());
    }
}

#[test]
fn contract_drift_fails_with_semantic_diagnostic_not_panic() {
    // Induce drift by corrupting the decrypted inner archive into
    // encrypted bytes. The extract stage must fail with the existing
    // semantic capability code — never a panic or opaque error.
    let tmp = tempfile::tempdir().unwrap();
    let drifted = tmp.path().join("fixture");
    copy_dir_recursive(&fixture_dir(), &drifted);
    let envelope = fs::read(drifted.join("encrypted-envelope.xp3")).unwrap();
    fs::write(drifted.join("decrypted-inner.xp3"), &envelope).unwrap();

    let report = run_encrypted_xp3_contract_scaffold(
        &drifted.join("contract-scaffold.fixture.json"),
        &tmp.path().join("run"),
    )
    .expect("harness must return a structured report, not error, on drift");

    assert_eq!(report.status, OperationStatus::Failed);
    // The disclaimer is still present even when the contract drifts.
    assert_eq!(
        report.disclaimer,
        ENCRYPTED_XP3_CONTRACT_SCAFFOLD_DISCLAIMER
    );
    // The extract stage carries the existing encrypted-variant semantic
    // code.
    let extract = report.stage(ContractStage::Extract).unwrap();
    assert_eq!(extract.status, ContractStageStatus::Failed);
    assert_eq!(
        extract.semantic_code.as_deref(),
        Some(kaifuu_core::SEMANTIC_UNSUPPORTED_VARIANT_ENCRYPTED)
    );
    // Every failed stage carries a non-empty semantic code (no opaque
    // failures).
    for outcome in &report.stages {
        if outcome.status == ContractStageStatus::Failed {
            assert!(
                outcome
                    .semantic_code
                    .as_deref()
                    .is_some_and(|c| !c.is_empty()),
                "failed stage {} lacks a semantic code",
                outcome.stage.as_str()
            );
        }
    }
}

#[test]
fn missing_descriptor_is_an_environmental_error() {
    let work = tempfile::tempdir().unwrap();
    let result = run_encrypted_xp3_contract_scaffold(
        Path::new("/nonexistent/contract-scaffold.fixture.json"),
        &work.path().join("run"),
    );
    assert!(result.is_err());
}
