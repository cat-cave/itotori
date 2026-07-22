use super::*;

#[test]
fn rolls_back_staged_payload_when_verify_hash_mismatches() {
    let dir = tempfile::tempdir().unwrap();
    let output_path = dir.path().join("SEEN.TXT");
    let source = vec![b'A'; 32];
    write_source(&output_path, &source);
    let expected_source_hash = sha256_hash_bytes(&source);
    let intended = vec![b'B'; 32];
    let expected_output_hash = sha256_hash_bytes(&intended);
    // Stage a payload that does not hash to expected_output_hash.
    let mut bad_payload = intended.clone();
    bad_payload[0] ^= 0xff;
    let capabilities = capabilities_with_identity_patch();
    let required = ["identity"];
    let config = make_config(
        &output_path,
        &expected_source_hash,
        &expected_output_hash,
        32,
        32,
        &required,
        &capabilities,
    );
    let mut transaction = PatchTransaction::new(config);
    transaction.run_preflight().unwrap();
    transaction.stage(&bad_payload).unwrap();
    transaction.verify().unwrap();
    assert_eq!(transaction.state(), TransactionState::VerifyFailed);

    let staged_path = dir
        .path()
        .join(".staging")
        .join(format!("{ASSET_ID}-{RUN_ID}.tmp"));
    assert!(
        !staged_path.exists(),
        "verify should remove the staged file"
    );
    assert_eq!(
        fs::read(&output_path).unwrap(),
        source,
        "output path must still hold the original source bytes"
    );
    let outcome = transaction.into_outcome();
    let failures = outcome.patch_result_v02["failures"].as_array().unwrap();
    assert!(
        failures
            .iter()
            .any(|f| f["category"] == "output_hash_mismatch")
    );
    let partial = &outcome.patch_result_v02["partialWrite"];
    assert_eq!(partial["disposition"], "rolled_back");
    assert_eq!(
        partial["rollbackDiagnosticCode"].as_str().unwrap(),
        SEMANTIC_PATCH_TRANSACTION_STAGED_VERIFY_ROLLED_BACK
    );
    assert!(validate_patch_result_v02(&outcome.patch_result_v02).is_ok());
}

#[test]
fn rejects_staged_payload_whose_length_differs_from_preflight() {
    // A payload whose actual length differs from the preflighted
    // expected_payload_len must fail closed: the staged file is never
    // written and a fatal relocation diagnostic is recorded, instead
    // of silently staging an unvalidated payload.
    let dir = tempfile::tempdir().unwrap();
    let output_path = dir.path().join("SEEN.TXT");
    let source = vec![b'A'; 32];
    write_source(&output_path, &source);
    let expected_source_hash = sha256_hash_bytes(&source);
    let intended = vec![b'B'; 32];
    let expected_output_hash = sha256_hash_bytes(&intended);
    let capabilities = capabilities_with_identity_patch();
    let required = ["identity"];
    let config = make_config(
        &output_path,
        &expected_source_hash,
        &expected_output_hash,
        32,
        32,
        &required,
        &capabilities,
    );
    let mut transaction = PatchTransaction::new(config);
    let report = transaction.run_preflight().unwrap();
    assert!(
        report.is_clear(),
        "expected clean preflight, got {report:?}"
    );
    // Stage a payload one byte longer than the preflighted length.
    let oversized = vec![b'B'; 33];
    transaction.stage(&oversized).unwrap();
    // Stage-time invariant failure: no rename was ever attempted, so this
    // is a StageFailed (distinct from a promote-time PromoteFailed).
    assert_eq!(transaction.state(), TransactionState::StageFailed);
    let staged_path = dir
        .path()
        .join(".staging")
        .join(format!("{ASSET_ID}-{RUN_ID}.tmp"));
    assert!(
        !staged_path.exists(),
        "mismatched payload must never be written to the staging file"
    );
    assert_eq!(
        fs::read(&output_path).unwrap(),
        source,
        "output path must still hold the original source bytes"
    );
    let outcome = transaction.into_outcome();
    let failures = outcome.patch_result_v02["failures"].as_array().unwrap();
    let codes: Vec<&str> = failures
        .iter()
        .map(|f| f["diagnosticCode"].as_str().unwrap())
        .collect();
    assert!(codes.contains(&SEMANTIC_PATCH_TRANSACTION_RELOCATION_UNSUPPORTED));
    assert!(validate_patch_result_v02(&outcome.patch_result_v02).is_ok());
}

#[test]
fn rolls_back_when_promote_rename_fails() {
    let dir = tempfile::tempdir().unwrap();
    let output_path = dir.path().join("SEEN.TXT");
    let source = vec![b'A'; 32];
    write_source(&output_path, &source);
    let expected_source_hash = sha256_hash_bytes(&source);
    let target = vec![b'B'; 32];
    let expected_output_hash = sha256_hash_bytes(&target);
    let capabilities = capabilities_with_identity_patch();
    let required = ["identity"];
    let config = make_config(
        &output_path,
        &expected_source_hash,
        &expected_output_hash,
        32,
        32,
        &required,
        &capabilities,
    );
    let mut transaction = PatchTransaction::new(config);
    transaction.run_preflight().unwrap();
    transaction.stage(&target).unwrap();
    transaction.verify().unwrap();
    // Replace output_path with a non-empty directory to force a rename
    // failure: POSIX `rename` cannot replace a non-empty directory with
    // a regular file.
    fs::remove_file(&output_path).unwrap();
    fs::create_dir(&output_path).unwrap();
    fs::write(output_path.join("guard.bin"), b"guard").unwrap();
    transaction.promote().unwrap();
    assert_eq!(transaction.state(), TransactionState::PromoteFailed);
    let staged_path = dir
        .path()
        .join(".staging")
        .join(format!("{ASSET_ID}-{RUN_ID}.tmp"));
    assert!(
        !staged_path.exists(),
        "promote failure should remove staged file"
    );
    let outcome = transaction.into_outcome();
    let codes: Vec<&str> = outcome.patch_result_v02["failures"]
        .as_array()
        .unwrap()
        .iter()
        .map(|f| f["diagnosticCode"].as_str().unwrap())
        .collect();
    assert!(codes.contains(&SEMANTIC_PATCH_TRANSACTION_PROMOTE_FAILED));
    let partial = &outcome.patch_result_v02["partialWrite"];
    assert_eq!(partial["disposition"], "rolled_back");
    assert_eq!(
        partial["rollbackDiagnosticCode"].as_str().unwrap(),
        SEMANTIC_PATCH_TRANSACTION_PROMOTE_ROLLED_BACK
    );
    assert!(validate_patch_result_v02(&outcome.patch_result_v02).is_ok());
}

#[test]
fn cancels_after_stage_and_cleans_up_staging() {
    let dir = tempfile::tempdir().unwrap();
    let output_path = dir.path().join("SEEN.TXT");
    let source = vec![b'A'; 32];
    write_source(&output_path, &source);
    let expected_source_hash = sha256_hash_bytes(&source);
    let target = vec![b'B'; 32];
    let expected_output_hash = sha256_hash_bytes(&target);
    let capabilities = capabilities_with_identity_patch();
    let required = ["identity"];
    let config = make_config(
        &output_path,
        &expected_source_hash,
        &expected_output_hash,
        32,
        32,
        &required,
        &capabilities,
    );
    let mut transaction = PatchTransaction::new(config);
    transaction.run_preflight().unwrap();
    transaction.stage(&target).unwrap();
    transaction.cancel().unwrap();
    assert_eq!(transaction.state(), TransactionState::Cancelled);
    let staged_path = dir
        .path()
        .join(".staging")
        .join(format!("{ASSET_ID}-{RUN_ID}.tmp"));
    assert!(!staged_path.exists());
    assert_eq!(fs::read(&output_path).unwrap(), source);
    let outcome = transaction.into_outcome();
    let partial = &outcome.patch_result_v02["partialWrite"];
    assert_eq!(partial["disposition"], "cleaned_up");
    assert!(validate_patch_result_v02(&outcome.patch_result_v02).is_ok());
}

#[test]
fn rejects_double_promote_with_state_machine_misuse_error() {
    let dir = tempfile::tempdir().unwrap();
    let output_path = dir.path().join("SEEN.TXT");
    let source = vec![b'A'; 16];
    let target = vec![b'B'; 16];
    write_source(&output_path, &source);
    let expected_source_hash = sha256_hash_bytes(&source);
    let expected_output_hash = sha256_hash_bytes(&target);
    let capabilities = capabilities_with_identity_patch();
    let required = ["identity"];
    let config = make_config(
        &output_path,
        &expected_source_hash,
        &expected_output_hash,
        16,
        16,
        &required,
        &capabilities,
    );
    let mut transaction = PatchTransaction::new(config);
    transaction.run_preflight().unwrap();
    transaction.stage(&target).unwrap();
    transaction.verify().unwrap();
    transaction.promote().unwrap();
    let err = transaction.promote().unwrap_err();
    assert!(matches!(
        err,
        PatchTransactionError::StateMachineMisuse {
            method: "promote",
            state: TransactionState::Promoted
        }
    ));
}

#[test]
fn rejects_a_second_stage_when_the_same_run_id_is_already_staged() {
    let dir = tempfile::tempdir().unwrap();
    let output_path = dir.path().join("SEEN.TXT");
    let source = vec![b'A'; 16];
    let target = vec![b'B'; 16];
    write_source(&output_path, &source);
    let expected_source_hash = sha256_hash_bytes(&source);
    let expected_output_hash = sha256_hash_bytes(&target);
    let capabilities = capabilities_with_identity_patch();
    let required = ["identity"];
    // Pre-create the staging file out-of-band to simulate a concurrent run.
    let staging_dir = dir.path().join(".staging");
    fs::create_dir_all(&staging_dir).unwrap();
    let existing = staging_dir.join(format!("{ASSET_ID}-{RUN_ID}.tmp"));
    fs::write(&existing, b"squatter").unwrap();

    let config = make_config(
        &output_path,
        &expected_source_hash,
        &expected_output_hash,
        16,
        16,
        &required,
        &capabilities,
    );
    let mut transaction = PatchTransaction::new(config);
    transaction.run_preflight().unwrap();
    transaction.stage(&target).unwrap();
    // Stage-time collision failure: no rename was attempted → StageFailed.
    assert_eq!(transaction.state(), TransactionState::StageFailed);
    // Squatter file is preserved — we did not remove it (we never owned it).
    assert!(existing.exists());
    let outcome = transaction.into_outcome();
    let codes: Vec<&str> = outcome.patch_result_v02["failures"]
        .as_array()
        .unwrap()
        .iter()
        .map(|f| f["diagnosticCode"].as_str().unwrap())
        .collect();
    assert!(codes.contains(&SEMANTIC_PATCH_TRANSACTION_STAGED_COLLISION));
    assert!(validate_patch_result_v02(&outcome.patch_result_v02).is_ok());
}

/// a stage-time write failure (no rename ever attempted) must
/// terminate in `StageFailed`, distinct from the promote-time rename
/// failure state (`PromoteFailed`). The two are safe-to-retry vs
/// verify-passed-but-swap-failed and must be tellable apart via
/// `outcome.final_state`.
#[test]
fn stage_write_failure_and_promote_rename_failure_terminate_in_distinct_states() {
    let capabilities = capabilities_with_identity_patch();
    let required = ["identity"];

    // --- Stage-time write failure: block the staging directory so the
    // staged bytes can never be written and no rename is attempted. ---
    let stage_dir = tempfile::tempdir().unwrap();
    let stage_output = stage_dir.path().join("SEEN.TXT");
    let source = vec![b'A'; 32];
    write_source(&stage_output, &source);
    let stage_source_hash = sha256_hash_bytes(&source);
    let target = vec![b'B'; 32];
    let stage_output_hash = sha256_hash_bytes(&target);
    // Occupy `<output_dir>/.staging` with a regular file so `create_dir_all`
    fs::write(stage_dir.path().join(".staging"), b"blocker").unwrap();
    let stage_config = make_config(
        &stage_output,
        &stage_source_hash,
        &stage_output_hash,
        32,
        32,
        &required,
        &capabilities,
    );
    let mut stage_txn = PatchTransaction::new(stage_config);
    stage_txn.run_preflight().unwrap();
    stage_txn.stage(&target).unwrap();
    assert_eq!(
        stage_txn.state(),
        TransactionState::StageFailed,
        "a stage-time write failure must terminate in StageFailed"
    );
    let stage_outcome = stage_txn.into_outcome();
    assert_eq!(stage_outcome.final_state, TransactionState::StageFailed);
    // Output bytes untouched; nothing was promoted.
    assert_eq!(fs::read(&stage_output).unwrap(), source);
    let stage_codes: Vec<&str> = stage_outcome.patch_result_v02["failures"]
        .as_array()
        .unwrap()
        .iter()
        .map(|f| f["diagnosticCode"].as_str().unwrap())
        .collect();
    assert!(stage_codes.contains(&SEMANTIC_PATCH_TRANSACTION_STAGED_WRITE_FAILED));
    let stage_partial = &stage_outcome.patch_result_v02["partialWrite"];
    assert_eq!(stage_partial["disposition"], "rolled_back");
    assert_eq!(
        stage_partial["rollbackDiagnosticCode"].as_str().unwrap(),
        SEMANTIC_PATCH_TRANSACTION_STAGED_WRITE_FAILED
    );
    assert!(validate_patch_result_v02(&stage_outcome.patch_result_v02).is_ok());

    // --- Promote-time rename failure: stage + verify succeed, but the
    // atomic rename onto output_path fails. ---
    let promote_dir = tempfile::tempdir().unwrap();
    let promote_output = promote_dir.path().join("SEEN.TXT");
    write_source(&promote_output, &source);
    let promote_config = make_config(
        &promote_output,
        &stage_source_hash,
        &stage_output_hash,
        32,
        32,
        &required,
        &capabilities,
    );
    let mut promote_txn = PatchTransaction::new(promote_config);
    promote_txn.run_preflight().unwrap();
    promote_txn.stage(&target).unwrap();
    promote_txn.verify().unwrap();
    // Replace output_path with a non-empty directory so the rename fails.
    fs::remove_file(&promote_output).unwrap();
    fs::create_dir(&promote_output).unwrap();
    fs::write(promote_output.join("guard.bin"), b"guard").unwrap();
    promote_txn.promote().unwrap();
    assert_eq!(
        promote_txn.state(),
        TransactionState::PromoteFailed,
        "a promote-time rename failure must terminate in PromoteFailed"
    );
    let promote_outcome = promote_txn.into_outcome();
    assert_eq!(promote_outcome.final_state, TransactionState::PromoteFailed);
    let promote_partial = &promote_outcome.patch_result_v02["partialWrite"];
    assert_eq!(
        promote_partial["rollbackDiagnosticCode"].as_str().unwrap(),
        SEMANTIC_PATCH_TRANSACTION_PROMOTE_ROLLED_BACK
    );
    assert!(validate_patch_result_v02(&promote_outcome.patch_result_v02).is_ok());

    // The crux: the two failure modes are DISTINGUISHABLE via final_state.
    assert_ne!(
        stage_outcome.final_state, promote_outcome.final_state,
        "stage-time and promote-time failures must be distinct states"
    );
}

#[test]
fn cancel_before_preflight_emits_valid_failed_result() {
    let dir = tempfile::tempdir().unwrap();
    let output_path = dir.path().join("SEEN.TXT");
    write_source(&output_path, b"x");
    let source_hash = sha256_hash_bytes(b"x");
    let output_hash = sha256_hash_bytes(b"y");
    let capabilities = capabilities_with_identity_patch();
    let required = ["identity"];
    let config = make_config(
        &output_path,
        &source_hash,
        &output_hash,
        1,
        1,
        &required,
        &capabilities,
    );
    let mut transaction = PatchTransaction::new(config);
    transaction.cancel().unwrap();
    let outcome = transaction.into_outcome();
    assert_eq!(outcome.final_state, TransactionState::Cancelled);
    assert!(validate_patch_result_v02(&outcome.patch_result_v02).is_ok());
}
