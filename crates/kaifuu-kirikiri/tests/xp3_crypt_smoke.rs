//! KAIFUU-100 — integration smoke: run the profiled XP3-crypt fixture from the
//! committed JSON manifest and prove the full decrypt/extract path plus the
//! wrong-key / missing-key typed-error and no-key-leak guarantees.

use std::path::PathBuf;

use kaifuu_core::OperationStatus;
use kaifuu_kirikiri::xp3_crypt::{
    XP3_CRYPT_CONTAINER, XP3_CRYPT_ENGINE_FAMILY, XP3_CRYPT_REQUIREMENT_ID,
    XP3_CRYPT_VALID_SECRET_REF, run_xp3_crypt_smoke_from_path,
};

fn fixture_path() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .join("fixtures/kaifuu/kirikiri/xp3-crypt.json")
}

#[test]
fn committed_fixture_decrypts_extracts_and_declares_all_fields() {
    let report = run_xp3_crypt_smoke_from_path(&fixture_path()).expect("fixture smoke runs");

    assert_eq!(report.status, OperationStatus::Passed);

    // The fixture declares every required field.
    assert_eq!(report.engine_family, XP3_CRYPT_ENGINE_FAMILY);
    assert_eq!(report.container, XP3_CRYPT_CONTAINER);
    assert_eq!(report.secret_requirement_id, XP3_CRYPT_REQUIREMENT_ID);
    assert_eq!(report.secret_ref.as_str(), XP3_CRYPT_VALID_SECRET_REF);

    // A valid secret ref decrypts + extracts the members (hash-based manifest).
    assert_eq!(report.manifest.len(), 2);
    let ids: Vec<&str> = report
        .manifest
        .iter()
        .map(|member| member.member_id.as_str())
        .collect();
    assert_eq!(ids, vec!["scenario/intro.ks", "system/config.txt"]);

    // Wrong-key and missing-key are typed errors.
    assert!(report.wrong_key.typed_error);
    assert!(
        report
            .wrong_key
            .diagnostic_code
            .contains("integrity_check_failed")
    );
    assert!(report.missing_key.typed_error);
    assert!(
        report
            .missing_key
            .diagnostic_code
            .contains("missing_secret")
    );
}

#[test]
fn committed_fixture_report_leaks_no_key_or_plaintext() {
    let report = run_xp3_crypt_smoke_from_path(&fixture_path()).expect("fixture smoke runs");
    let json = report.stable_json().expect("stable json");

    // Secret-ref is disclosed (safe); the resolved key material is only a
    // one-way commitment — the raw key never appears.
    assert!(json.contains("local-secret:kaifuu-kirikiri-crypt-fixture-key"));
    assert!(!json.contains("K100-XP3-XORKEY1"));
    assert!(!json.contains("K100-XP3-WRONGKY"));

    // No local fixture path leaks into the report.
    assert!(!json.contains("/scratch/"));
    assert!(!json.contains(env!("CARGO_MANIFEST_DIR")));
}
