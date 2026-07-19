//! Process-level contract coverage for importing an RPG Maker fixture key.
//!
//! The key hex is derived at runtime from the recorded public-fixture byte
//! sequence. It is deliberately not stored in a fixture, snapshot, assertion
//! message, or command diagnostic.

use std::path::{Path, PathBuf};
use std::process::{Command, Output};

use serde_json::Value;

const SECRET_REF: &str = "local-secret:fixture/rpg-maker/asset-key";
const REQUIREMENT_ID: &str = "rpg-maker-mv-mz-asset-key";

fn kaifuu_cli_binary() -> PathBuf {
    PathBuf::from(env!("CARGO_BIN_EXE_kaifuu-cli"))
}

fn workspace_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..")
}

fn fixture_game_dir() -> PathBuf {
    workspace_root().join("fixtures/public/kaifuu-encrypted-matrix/raw/rpg-maker")
}

fn fixture_image_asset() -> PathBuf {
    fixture_game_dir().join("img/pictures/title.rpgmvp")
}

fn recorded_fixture_key_hex() -> String {
    use std::fmt::Write;
    let mut s = String::new();
    for byte in 0_u8..16 {
        write!(s, "{:02x}", byte.saturating_mul(17)).unwrap();
    }
    s
}

fn invalid_fixture_key_hex() -> String {
    std::iter::repeat_n("ff", 16).collect()
}

fn import_key(secret_store: &Path, report_path: &Path, key_hex: &str) -> Output {
    Command::new(kaifuu_cli_binary())
        .arg("key")
        .arg("import")
        .arg("--secret-store")
        .arg(secret_store)
        .arg("--secret-ref")
        .arg(SECRET_REF)
        .arg("--purpose")
        .arg(REQUIREMENT_ID)
        .arg("--engine-profile-id")
        .arg("rpg-maker-mv-mz-fixture")
        .arg("--key-hex")
        .arg(key_hex)
        .arg("--output")
        .arg(report_path)
        .output()
        .expect("spawn key import CLI")
}

fn validate_fixture_key(secret_store: &Path, report_path: &Path) -> Output {
    let game_dir = fixture_game_dir();
    Command::new(kaifuu_cli_binary())
        .arg("rpg-maker")
        .arg("validate-fixture-key")
        .arg("--game-dir")
        .arg(&game_dir)
        .arg("--image-asset")
        .arg(fixture_image_asset())
        .arg("--secret-store")
        .arg(secret_store)
        .arg("--secret-ref")
        .arg(SECRET_REF)
        .arg("--requirement-id")
        .arg(REQUIREMENT_ID)
        .arg("--output")
        .arg(report_path)
        .output()
        .expect("spawn fixture-key validation CLI")
}

fn read_json(path: &Path) -> Value {
    serde_json::from_slice(&std::fs::read(path).expect("read CLI report"))
        .expect("CLI report is valid JSON")
}

fn assert_no_raw_key_material(text: &str, raw_keys: &[&str]) {
    for raw_key in raw_keys {
        assert!(!text.contains(raw_key), "raw key material leaked");
    }
}

fn assert_report_and_process_are_redacted(report_path: &Path, output: &Output, raw_keys: &[&str]) {
    let report = std::fs::read_to_string(report_path).expect("read report text");
    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    for text in [&report, stdout.as_ref(), stderr.as_ref()] {
        assert_no_raw_key_material(text, raw_keys);
        assert!(!text.contains("fixture-only-rpg-maker-asset-key-v1"));
    }
}

fn assert_public_fixture_outputs_are_redacted(raw_keys: &[&str]) {
    for relative_path in [
        "fixtures/public/kaifuu-encrypted-matrix/raw/rpg-maker/www/data/System.json",
        "fixtures/public/kaifuu-encrypted-matrix/keys/public-fixture-key-manifest.json",
        "fixtures/public/kaifuu-encrypted-matrix/expected/rpg-maker-mv-mz-key-validation-success-v0.1.json",
    ] {
        assert_no_raw_key_material(
            &String::from_utf8_lossy(
                &std::fs::read(workspace_root().join(relative_path))
                    .expect("read public fixture output"),
            ),
            raw_keys,
        );
    }
}

#[test]
fn imported_fixture_key_validates_against_encrypted_image_evidence() {
    let work = tempfile::tempdir().expect("temp work directory");
    let secret_store = work.path().join("secret-store");
    let import_report = work.path().join("import.json");
    let validation_report = work.path().join("validation.json");
    let valid_key = recorded_fixture_key_hex();

    let imported = import_key(&secret_store, &import_report, &valid_key);
    assert!(imported.status.success(), "key import CLI must succeed");
    let import = read_json(&import_report);
    assert_eq!(import["redactionStatus"], "redacted");
    assert_eq!(import["materialBytes"], 16);
    assert_report_and_process_are_redacted(&import_report, &imported, &[&valid_key]);

    let validated = validate_fixture_key(&secret_store, &validation_report);
    assert!(
        validated.status.success(),
        "fixture-key validation CLI must succeed"
    );
    let validation = read_json(&validation_report);
    assert_eq!(validation["status"], "passed");
    assert_eq!(validation["records"][0]["surface"], "image_asset");
    assert_eq!(validation["records"][0]["codec"], "png_image");
    assert_eq!(validation["records"][0]["diagnosticResult"], "success");
    assert_report_and_process_are_redacted(&validation_report, &validated, &[&valid_key]);
    assert_public_fixture_outputs_are_redacted(&[&valid_key]);
}

#[test]
fn invalid_imported_fixture_key_fails_closed_with_redacted_output() {
    let work = tempfile::tempdir().expect("temp work directory");
    let secret_store = work.path().join("secret-store");
    let import_report = work.path().join("invalid-import.json");
    let validation_report = work.path().join("invalid-validation.json");
    let valid_key = recorded_fixture_key_hex();
    let invalid_key = invalid_fixture_key_hex();

    let imported = import_key(&secret_store, &import_report, &invalid_key);
    assert!(
        imported.status.success(),
        "key import CLI must accept the local key material"
    );
    assert_report_and_process_are_redacted(&import_report, &imported, &[&valid_key, &invalid_key]);

    let validated = validate_fixture_key(&secret_store, &validation_report);
    assert!(
        !validated.status.success(),
        "invalid imported key must fail closed"
    );
    let validation = read_json(&validation_report);
    assert_eq!(validation["status"], "failed");
    assert_eq!(validation["records"][0]["diagnosticResult"], "bad_key");
    assert_eq!(
        validation["diagnostics"][0]["semanticCode"],
        "kaifuu.key_validation_failed"
    );
    assert!(
        String::from_utf8_lossy(&validated.stderr)
            .contains("RPG Maker MV/MZ key validation failed")
    );
    assert_report_and_process_are_redacted(
        &validation_report,
        &validated,
        &[&valid_key, &invalid_key],
    );
    assert_public_fixture_outputs_are_redacted(&[&valid_key, &invalid_key]);
}
