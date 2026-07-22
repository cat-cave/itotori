use super::*;
use crate::{
    AdapterCapabilities, AdapterCapabilityMatrix, CapabilityStatus,
    LayeredAccessCapabilityContract, LayeredAccessOperationContract,
    SEMANTIC_PATCH_TRANSACTION_PROMOTE_FAILED, SEMANTIC_PATCH_TRANSACTION_PROMOTE_ROLLED_BACK,
    SEMANTIC_PATCH_TRANSACTION_STAGED_COLLISION,
    SEMANTIC_PATCH_TRANSACTION_STAGED_VERIFY_ROLLED_BACK,
    SEMANTIC_PATCH_TRANSACTION_STAGED_WRITE_FAILED,
};
use std::path::Path;

const ADAPTER_ID: &str = "kaifuu-fixture";
const PATCH_EXPORT_ID: &str = "0190a000-0000-7000-8000-000000000001";
const BRIDGE_UNIT_ID: &str = "0190a000-0000-7000-8000-000000000002";
const ASSET_ID: &str = "0190a000-0000-7000-8000-000000000003";
const RUN_ID: &str = "run-001";
const COMMAND: &str = "patch.write_string_slot";

/// Patch-transaction tests run inside `kaifuu-core`'s own crate boundary
/// and exercise the access-contract machinery directly; the level matrix
/// is not the subject of these tests, but requires every
/// `AdapterCapabilities` to declare one. Use the explicitly-derived
/// matrix from an empty report vec (every rung Unsupported) so the
/// fixture cannot be mistaken for an adapter that supports
/// inventory/extract/patch from registry-side gates.
fn fixture_matrix() -> AdapterCapabilityMatrix {
    AdapterCapabilityMatrix::derive_from_reports(ADAPTER_ID, &[])
}

fn capabilities_with_identity_patch() -> AdapterCapabilities {
    AdapterCapabilities::new(ADAPTER_ID, vec![], fixture_matrix())
        .with_access_contract(LayeredAccessCapabilityContract::plaintext_identity())
}

fn capabilities_with_no_access_contract() -> AdapterCapabilities {
    AdapterCapabilities::new(ADAPTER_ID, vec![], fixture_matrix())
}

fn capabilities_with_unsupported_patch() -> AdapterCapabilities {
    let mut contract = LayeredAccessCapabilityContract::plaintext_identity();
    contract.patch = LayeredAccessOperationContract {
        status: CapabilityStatus::Unsupported,
        required_capabilities: vec![],
        supported_surfaces: vec![],
        supported_containers: vec![],
        supported_crypto: vec![],
        supported_codecs: vec![],
        supported_patch_back: vec![],
        support_boundary: Some("intentionally unsupported".to_string()),
    };
    AdapterCapabilities::new(ADAPTER_ID, vec![], fixture_matrix()).with_access_contract(contract)
}

fn make_config<'a>(
    output_path: &'a Path,
    expected_source_hash: &'a str,
    expected_output_hash: &'a str,
    expected_payload_len: u64,
    byte_budget: u64,
    required_transforms: &'a [&'a str],
    capabilities: &'a AdapterCapabilities,
) -> PatchTransactionConfig<'a> {
    PatchTransactionConfig {
        adapter_id: ADAPTER_ID,
        patch_export_id: PATCH_EXPORT_ID,
        bridge_unit_id: BRIDGE_UNIT_ID,
        asset_id: ASSET_ID,
        output_path,
        expected_source_hash,
        expected_output_hash,
        expected_payload_len,
        byte_budget,
        required_transforms,
        adapter_capabilities: capabilities,
        command: COMMAND,
        run_id: RUN_ID,
    }
}

fn write_source(path: &Path, bytes: &[u8]) {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).unwrap();
    }
    fs::write(path, bytes).unwrap();
}

fn touched_assets_rollup_for(asset_id: &str, output_hash: &str) -> String {
    let payload = format!("{asset_id}\n{output_hash}\n");
    sha256_hash_bytes(payload.as_bytes())
}

#[test]
fn patches_then_verifies_a_length_preserving_payload() {
    let dir = tempfile::tempdir().unwrap();
    let output_path = dir.path().join("SEEN.TXT");
    let source = vec![b'A'; 32];
    let target: Vec<u8> = (0..32u8).collect();
    write_source(&output_path, &source);
    let expected_source_hash = sha256_hash_bytes(&source);
    let expected_output_hash = sha256_hash_bytes(&target);
    let capabilities = capabilities_with_identity_patch();
    let required = ["identity"];
    let config = make_config(
        &output_path,
        &expected_source_hash,
        &expected_output_hash,
        target.len() as u64,
        target.len() as u64,
        &required,
        &capabilities,
    );

    let mut transaction = PatchTransaction::new(config);
    let report = transaction.run_preflight().unwrap();
    assert!(
        report.is_clear(),
        "expected clean preflight, got {report:?}"
    );
    transaction.stage(&target).unwrap();
    transaction.verify().unwrap();
    transaction.promote().unwrap();
    assert_eq!(transaction.state(), TransactionState::Promoted);

    let outcome = transaction.into_outcome();
    assert_eq!(outcome.final_state, TransactionState::Promoted);
    assert_eq!(
        fs::read(&output_path).unwrap(),
        target,
        "promote should write target bytes to output_path"
    );
    assert!(
        !dir.path()
            .join(".staging")
            .join(format!("{ASSET_ID}-{RUN_ID}.tmp"))
            .exists(),
        "staging file should be removed after promote"
    );
    assert_eq!(outcome.patch_result_v02["status"], "passed");
    assert!(validate_patch_result_v02(&outcome.patch_result_v02).is_ok());
    let touched = outcome.patch_result_v02["touchedAssets"]
        .as_array()
        .unwrap();
    assert_eq!(touched.len(), 1);
    assert_eq!(
        touched[0]["outputHash"].as_str().unwrap(),
        expected_output_hash
    );
    let expected_rollup = touched_assets_rollup_for(ASSET_ID, &expected_output_hash);
    assert_eq!(
        outcome.patch_result_v02["outputHash"].as_str().unwrap(),
        expected_rollup
    );
}

#[test]
fn outcome_carries_only_the_v02_surface_no_legacy_patch_result() {
    // Regression guard for genaudit1-06 (no-legacy-compat): the transaction
    // outcome must expose ONLY the v0.2 PatchResult surface. The exhaustive
    // destructure below fails to compile if any legacy dual-plumbing field
    // (e.g. the former `legacy_patch_result`) is re-added to the struct.
    let dir = tempfile::tempdir().unwrap();
    let output_path = dir.path().join("SEEN.TXT");
    let source = vec![b'A'; 32];
    write_source(&output_path, &source);
    let target = vec![b'B'; 32];
    let expected_source_hash = sha256_hash_bytes(&source);
    let expected_output_hash = sha256_hash_bytes(&target);
    let capabilities = capabilities_with_identity_patch();
    let required = ["identity"];
    let config = make_config(
        &output_path,
        &expected_source_hash,
        &expected_output_hash,
        32,
        64,
        &required,
        &capabilities,
    );
    let mut transaction = PatchTransaction::new(config);
    transaction.run_preflight().unwrap();
    transaction.stage(&target).unwrap();
    transaction.verify().unwrap();
    transaction.promote().unwrap();

    let outcome = transaction.into_outcome();
    // Exhaustive destructure: adding a field back breaks this line.
    let PatchTransactionOutcome {
        final_state,
        patch_result_v02,
    } = outcome;
    assert_eq!(final_state, TransactionState::Promoted);
    assert_eq!(patch_result_v02["status"], "passed");
    assert!(validate_patch_result_v02(&patch_result_v02).is_ok());
}

#[test]
fn rejects_payload_that_exceeds_byte_budget_before_any_write() {
    let dir = tempfile::tempdir().unwrap();
    let output_path = dir.path().join("SEEN.TXT");
    let source = vec![b'A'; 32];
    write_source(&output_path, &source);
    let expected_source_hash = sha256_hash_bytes(&source);
    // Provide a syntactically valid sha256 placeholder for the output.
    let expected_output_hash = "sha256:".to_string() + &"0".repeat(64);
    let capabilities = capabilities_with_identity_patch();
    let required = ["identity"];
    let config = make_config(
        &output_path,
        &expected_source_hash,
        &expected_output_hash,
        32,
        16,
        &required,
        &capabilities,
    );
    let mut transaction = PatchTransaction::new(config);
    let report = transaction.run_preflight().unwrap();
    assert!(!report.is_clear());
    assert_eq!(transaction.state(), TransactionState::PreflightFailed);
    // Staging dir should not exist — no writes happened.
    assert!(
        !dir.path().join(".staging").exists(),
        "preflight must not create the staging directory"
    );
    // Output untouched.
    assert_eq!(fs::read(&output_path).unwrap(), source);

    let outcome = transaction.into_outcome();
    assert_eq!(outcome.final_state, TransactionState::PreflightFailed);
    assert_eq!(outcome.patch_result_v02["status"], "failed");
    let failures = outcome.patch_result_v02["failures"].as_array().unwrap();
    let codes: Vec<&str> = failures
        .iter()
        .map(|f| f["diagnosticCode"].as_str().unwrap())
        .collect();
    assert!(codes.contains(&SEMANTIC_PATCH_TRANSACTION_BYTE_BUDGET_EXCEEDED));
    let categories: Vec<&str> = failures
        .iter()
        .map(|f| f["category"].as_str().unwrap())
        .collect();
    assert!(categories.contains(&"patch_write_failed"));
    let partial = &outcome.patch_result_v02["partialWrite"];
    assert_eq!(partial["disposition"], "rolled_back");
    assert!(partial["writtenAssetIds"].as_array().unwrap().is_empty());
    assert!(validate_patch_result_v02(&outcome.patch_result_v02).is_ok());
}

#[test]
fn rejects_when_source_bytes_drifted_from_expected_hash() {
    let dir = tempfile::tempdir().unwrap();
    let output_path = dir.path().join("SEEN.TXT");
    let source = vec![b'A'; 32];
    write_source(&output_path, &source);
    let expected_source_hash = "sha256:".to_string() + &"b".repeat(64);
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
    assert_eq!(transaction.state(), TransactionState::PreflightFailed);
    let outcome = transaction.into_outcome();
    let categories: Vec<&str> = outcome.patch_result_v02["failures"]
        .as_array()
        .unwrap()
        .iter()
        .map(|f| f["category"].as_str().unwrap())
        .collect();
    assert!(categories.contains(&"source_incompatible"));
    assert!(validate_patch_result_v02(&outcome.patch_result_v02).is_ok());
}

#[test]
fn rejects_when_source_file_missing() {
    let dir = tempfile::tempdir().unwrap();
    let output_path = dir.path().join("missing.bin");
    let expected_source_hash = "sha256:".to_string() + &"a".repeat(64);
    let expected_output_hash = "sha256:".to_string() + &"b".repeat(64);
    let capabilities = capabilities_with_identity_patch();
    let required = ["identity"];
    let config = make_config(
        &output_path,
        &expected_source_hash,
        &expected_output_hash,
        16,
        32,
        &required,
        &capabilities,
    );
    let mut transaction = PatchTransaction::new(config);
    transaction.run_preflight().unwrap();
    assert_eq!(transaction.state(), TransactionState::PreflightFailed);
    let outcome = transaction.into_outcome();
    let categories: Vec<&str> = outcome.patch_result_v02["failures"]
        .as_array()
        .unwrap()
        .iter()
        .map(|f| f["category"].as_str().unwrap())
        .collect();
    assert!(categories.contains(&"asset_missing"));
    assert!(validate_patch_result_v02(&outcome.patch_result_v02).is_ok());
}

#[test]
fn rejects_when_required_transform_is_not_declared_by_the_adapter() {
    let dir = tempfile::tempdir().unwrap();
    let output_path = dir.path().join("SEEN.TXT");
    let source = vec![b'A'; 16];
    write_source(&output_path, &source);
    let expected_source_hash = sha256_hash_bytes(&source);
    let target = vec![b'B'; 16];
    let expected_output_hash = sha256_hash_bytes(&target);
    let capabilities = capabilities_with_no_access_contract();
    let required = ["non_existent_transform"];
    let config = make_config(
        &output_path,
        &expected_source_hash,
        &expected_output_hash,
        16,
        32,
        &required,
        &capabilities,
    );
    let mut transaction = PatchTransaction::new(config);
    transaction.run_preflight().unwrap();
    let outcome = transaction.into_outcome();
    let categories: Vec<&str> = outcome.patch_result_v02["failures"]
        .as_array()
        .unwrap()
        .iter()
        .map(|f| f["category"].as_str().unwrap())
        .collect();
    assert!(categories.contains(&"adapter_unsupported"));
    assert!(validate_patch_result_v02(&outcome.patch_result_v02).is_ok());
}

#[test]
fn rejects_when_patch_operation_contract_is_unsupported() {
    let dir = tempfile::tempdir().unwrap();
    let output_path = dir.path().join("SEEN.TXT");
    let source = vec![b'A'; 16];
    write_source(&output_path, &source);
    let expected_source_hash = sha256_hash_bytes(&source);
    let target = vec![b'B'; 16];
    let expected_output_hash = sha256_hash_bytes(&target);
    let capabilities = capabilities_with_unsupported_patch();
    let required = ["identity"];
    let config = make_config(
        &output_path,
        &expected_source_hash,
        &expected_output_hash,
        16,
        32,
        &required,
        &capabilities,
    );
    let mut transaction = PatchTransaction::new(config);
    transaction.run_preflight().unwrap();
    let outcome = transaction.into_outcome();
    let codes: Vec<&str> = outcome.patch_result_v02["failures"]
        .as_array()
        .unwrap()
        .iter()
        .map(|f| f["diagnosticCode"].as_str().unwrap())
        .collect();
    assert!(codes.contains(&SEMANTIC_UNSUPPORTED_LAYERED_TRANSFORM));
}

#[test]
fn rejects_non_length_preserving_relocation() {
    let dir = tempfile::tempdir().unwrap();
    let output_path = dir.path().join("SEEN.TXT");
    let source = vec![b'A'; 32];
    write_source(&output_path, &source);
    let expected_source_hash = sha256_hash_bytes(&source);
    // expected_payload_len 24!= source.len 32 → relocation rejection.
    let target = vec![b'B'; 24];
    let expected_output_hash = sha256_hash_bytes(&target);
    let capabilities = capabilities_with_identity_patch();
    let required = ["identity"];
    let config = make_config(
        &output_path,
        &expected_source_hash,
        &expected_output_hash,
        24,
        32,
        &required,
        &capabilities,
    );
    let mut transaction = PatchTransaction::new(config);
    transaction.run_preflight().unwrap();
    let outcome = transaction.into_outcome();
    let codes: Vec<&str> = outcome.patch_result_v02["failures"]
        .as_array()
        .unwrap()
        .iter()
        .map(|f| f["diagnosticCode"].as_str().unwrap())
        .collect();
    assert!(codes.contains(&SEMANTIC_PATCH_TRANSACTION_RELOCATION_UNSUPPORTED));
    let categories: Vec<&str> = outcome.patch_result_v02["failures"]
        .as_array()
        .unwrap()
        .iter()
        .map(|f| f["category"].as_str().unwrap())
        .collect();
    assert!(categories.contains(&"adapter_unsupported"));
    assert!(validate_patch_result_v02(&outcome.patch_result_v02).is_ok());
}

#[test]
fn rejects_malformed_expected_output_hash() {
    let dir = tempfile::tempdir().unwrap();
    let output_path = dir.path().join("SEEN.TXT");
    let source = vec![b'A'; 16];
    write_source(&output_path, &source);
    let expected_source_hash = sha256_hash_bytes(&source);
    let bad_hash = "not-a-hash";
    let capabilities = capabilities_with_identity_patch();
    let required = ["identity"];
    let config = make_config(
        &output_path,
        &expected_source_hash,
        bad_hash,
        16,
        32,
        &required,
        &capabilities,
    );
    let mut transaction = PatchTransaction::new(config);
    transaction.run_preflight().unwrap();
    let outcome = transaction.into_outcome();
    let codes: Vec<&str> = outcome.patch_result_v02["failures"]
        .as_array()
        .unwrap()
        .iter()
        .map(|f| f["diagnosticCode"].as_str().unwrap())
        .collect();
    assert!(codes.contains(&SEMANTIC_PATCH_TRANSACTION_EXPECTED_OUTPUT_HASH_MALFORMED));
    assert!(validate_patch_result_v02(&outcome.patch_result_v02).is_ok());
}

#[path = "tests/lifecycle.rs"]
mod lifecycle;
