#[test]
fn xp3_profile_proof_command_plain_fixture_passes() {
    let root = temp_dir("xp3-profile-proof-plain");
    let output = root.join("plain-proof.json");
    run_cli(&[
        "xp3",
        "profile-proof",
        "--fixture",
        kirikiri_fixture_path("xp3-profile.json").to_str().unwrap(),
        "--output",
        output.to_str().unwrap(),
    ]);
    let report: serde_json::Value = read_json(&output).unwrap();
    assert_eq!(report["status"], "passed");
    assert_eq!(report["classification"], "plain");
    assert_eq!(report["patchCapabilityLevel"], "patch_back");
    assert_eq!(report["helperRequirement"], "not_required");
    assert_eq!(report["patchWriteAttempted"], false);
    assert_eq!(report["archive"]["archiveId"], "kirikiri-xp3-archive");
    assert_eq!(
        report["fixtureId"],
        "kaifuu-kirikiri-xp3-plain-profile-proof"
    );
    assert_eq!(report["profileId"], "019ed000-0000-7000-8000-000000095001");
    assert_eq!(report["cryptProfile"]["status"], "not_required");
    let serialized = fs::read_to_string(&output).unwrap();
    assert!(!serialized.contains("/home/"));
    assert!(!serialized.contains("C:\\"));
    let _ = fs::remove_dir_all(root);
}

#[test]
fn xp3_plain_smoke_command_passes_and_writes_report() {
    // inventory + deterministic rebuild through the shared
    // reader/writer path; negatives fail before writes citing member ids.
    let root = temp_dir("xp3-plain-smoke");
    let output = root.join("plain-xp3-smoke.json");
    run_cli(&[
        "xp3",
        "plain-smoke",
        "--fixture",
        kirikiri_fixture_path("plain-xp3.json").to_str().unwrap(),
        "--out",
        output.to_str().unwrap(),
    ]);
    let report: serde_json::Value = read_json(&output).unwrap();
    assert_eq!(report["status"], "passed");
    assert_eq!(report["archive"]["memberCount"], 3);
    assert_eq!(report["archive"]["compressedMemberCount"], 1);
    assert_eq!(report["rebuild"]["equivalence"], "byte_identical");
    assert_eq!(report["rebuild"]["byteIdentical"], true);
    assert_eq!(
        report["rebuild"]["outputHash"],
        report["rebuild"]["sourceHash"]
    );
    let negatives = report["negatives"].as_array().unwrap();
    assert_eq!(negatives.len(), 2);
    for negative in negatives {
        assert_eq!(negative["status"], "passed");
        assert_eq!(negative["failedBeforeWrite"], true);
    }
    let flagged = negatives
        .iter()
        .find(|negative| negative["failureKind"] == "unsupported_member_flags")
        .unwrap();
    assert_eq!(flagged["memberId"], "scenario/flagged.ks");
    // No local path leaks into the redacted report.
    let serialized = fs::read_to_string(&output).unwrap();
    assert!(!serialized.contains("/home/"));
    assert!(!serialized.contains("/scratch/"));
    assert!(!serialized.contains(".xp3"));
    let _ = fs::remove_dir_all(root);
}

fn run_xp3_profile_proof_cli(
    fixture: &Path,
    output: &Path,
) -> Result<(), Box<dyn std::error::Error>> {
    run_with_args(
        [
            "xp3",
            "profile-proof",
            "--fixture",
            fixture.to_str().unwrap(),
            "--output",
            output.to_str().unwrap(),
        ]
        .iter()
        .map(std::string::ToString::to_string)
        .collect(),
    )
}

#[test]
fn xp3_profile_proof_command_encrypted_fixture_routes_without_patch_claim() {
    // Acceptance criterion: "Unsupported cases fail before extract or
    // patch claims are made." The CLI exits non-zero on encrypted
    // routing and writes the redacted proof carrying the unsupported
    // capability level.
    let root = temp_dir("xp3-profile-proof-encrypted");
    let output = root.join("encrypted-proof.json");
    let result = run_xp3_profile_proof_cli(
        &kirikiri_fixture_path("xp3-encrypted-profile.json"),
        &output,
    );
    assert!(result.is_err(), "encrypted routing must exit non-zero");
    let report: serde_json::Value = read_json(&output).unwrap();
    assert_eq!(report["status"], "failed");
    assert_eq!(report["classification"], "encrypted");
    assert_eq!(report["patchCapabilityLevel"], "unsupported");
    assert_eq!(report["patchWriteAttempted"], false);
    assert_eq!(report["cryptProfile"]["status"], "satisfied");
    let diagnostics = report["diagnostics"].as_array().unwrap();
    assert!(
        diagnostics
            .iter()
            .any(|diagnostic| diagnostic["code"] == "xp3.encrypted.unsupported")
    );
    assert!(
        report["semanticRemediation"]
            .as_str()
            .unwrap_or_default()
            .contains("encrypted")
    );
    let _ = fs::remove_dir_all(root);
}

#[test]
fn xp3_profile_proof_command_helper_required_fixture_routes_without_patch_claim() {
    let root = temp_dir("xp3-profile-proof-helper-required");
    let output = root.join("helper-required-proof.json");
    let result = run_xp3_profile_proof_cli(
        &kirikiri_fixture_path("xp3-helper-required-profile.json"),
        &output,
    );
    assert!(
        result.is_err(),
        "helper-required routing must exit non-zero"
    );
    let report: serde_json::Value = read_json(&output).unwrap();
    assert_eq!(report["status"], "failed");
    assert_eq!(report["classification"], "helper_required");
    assert_eq!(report["patchCapabilityLevel"], "unsupported");
    assert_eq!(report["helperRequirement"], "required");
    let diagnostics = report["diagnostics"].as_array().unwrap();
    assert!(
        diagnostics
            .iter()
            .any(|diagnostic| diagnostic["code"] == "xp3.helper_required")
    );
    let _ = fs::remove_dir_all(root);
}

#[test]
fn xp3_profile_proof_command_protected_executable_fixture_routes_without_patch_claim() {
    let root = temp_dir("xp3-profile-proof-protected-executable");
    let output = root.join("protected-executable-proof.json");
    let result = run_xp3_profile_proof_cli(
        &kirikiri_fixture_path("xp3-protected-executable-profile.json"),
        &output,
    );
    assert!(
        result.is_err(),
        "protected-executable routing must exit non-zero"
    );
    let report: serde_json::Value = read_json(&output).unwrap();
    assert_eq!(report["status"], "failed");
    assert_eq!(report["classification"], "unsupported_protected_executable");
    assert_eq!(report["patchCapabilityLevel"], "unsupported");
    let diagnostics = report["diagnostics"].as_array().unwrap();
    assert!(
        diagnostics
            .iter()
            .any(|diagnostic| diagnostic["code"] == "xp3.unsupported_protected_executable")
    );
    let _ = fs::remove_dir_all(root);
}

#[test]
fn xp3_profile_proof_command_missing_crypt_profile_fails_and_writes_report() {
    let root = temp_dir("xp3-profile-proof-missing-crypt-cli");
    let output = root.join("missing-crypt-proof.json");
    let result = run_xp3_profile_proof_cli(
        &kirikiri_fixture_path("negative/xp3-missing-crypt-profile.json"),
        &output,
    );
    assert!(result.is_err(), "missing-crypt-profile must exit non-zero");
    let report: serde_json::Value = read_json(&output).unwrap();
    assert_eq!(report["status"], "failed");
    assert_eq!(report["cryptProfile"]["status"], "missing");
    assert!(
        report["diagnostics"]
            .as_array()
            .unwrap()
            .iter()
            .any(|diagnostic| diagnostic["code"] == "xp3.crypt_profile.missing")
    );
    let _ = fs::remove_dir_all(root);
}

#[test]
fn xp3_profile_proof_command_unknown_encryption_plugin_fails_and_writes_report() {
    let root = temp_dir("xp3-profile-proof-unknown-plugin-cli");
    let output = root.join("unknown-plugin-proof.json");
    let result = run_xp3_profile_proof_cli(
        &kirikiri_fixture_path("negative/xp3-unknown-encryption-plugin.json"),
        &output,
    );
    assert!(result.is_err(), "unknown-plugin must exit non-zero");
    let report: serde_json::Value = read_json(&output).unwrap();
    assert_eq!(report["status"], "failed");
    assert_eq!(report["cryptProfile"]["status"], "unknown_plugin");
    assert!(
        report["diagnostics"]
            .as_array()
            .unwrap()
            .iter()
            .any(|diagnostic| diagnostic["code"] == "xp3.crypt_profile.unknown_plugin")
    );
    let _ = fs::remove_dir_all(root);
}

#[test]
fn xp3_profile_proof_command_leaked_archive_path_fails_and_redacts_path() {
    let root = temp_dir("xp3-profile-proof-leaked-path-cli");
    let output = root.join("leaked-path-proof.json");
    let result = run_xp3_profile_proof_cli(
        &kirikiri_fixture_path("negative/xp3-leaked-archive-path.json"),
        &output,
    );
    assert!(result.is_err(), "leaked archive path must exit non-zero");
    let serialized = fs::read_to_string(&output).unwrap();
    let report: serde_json::Value = serde_json::from_str(&serialized).unwrap();
    assert_eq!(report["status"], "failed");
    assert!(
        report["diagnostics"]
            .as_array()
            .unwrap()
            .iter()
            .any(|diagnostic| diagnostic["code"] == "xp3.archive_path.leaked")
    );
    // The literal leaked path must not survive into the report.
    assert!(
        !serialized.contains("/home/local-user/private/data.xp3"),
        "leaked path survived into report: {serialized}"
    );
    let _ = fs::remove_dir_all(root);
}

/// multi-game validation — exercise the proof against real
/// KiriKiri XP3 bytes when optional corpus roots are configured.
/// Following the "multi-game validation" memory rule and
/// the spec's `KiriKiri research-only anchor; no vendored decryption
/// code` load-bearing rule: this test reads, classifies, and emits
/// the redacted proof; it never decrypts, never extracts, and never
/// claims patch-back on archives whose index cannot be inventoried by
/// the plain reader.
/// The test no-ops when `ITOTORI_REAL_GAME_ROOT_KIRIKIRI_PLAIN`
/// and `ITOTORI_REAL_GAME_ROOT_KIRIKIRI_ENCRYPTED` are unset; public
/// CI is satisfied by the synthetic fixtures above.
#[test]
fn xp3_profile_proof_command_real_bytes_kirikiri_corpus_when_available() {
    // Two optional real KiriKiri game roots. Both wear the XP3 plain
    // magic, but the plain inventory reader only handles
    // flag=0 (plain index encoding) and rejects everything else as
    // UnsupportedEncrypted. In practice these games carry compressed
    // or encrypted directories, so the proof routes them to the
    // `Encrypted` taxonomy and refuses to claim patch_back. This is
    // the load-bearing protection: real KiriKiri bytes never silently
    // produce a patch_back capability claim.
    let real_cases: &[(&str, &str)] = &[
        (
            "ITOTORI_REAL_GAME_ROOT_KIRIKIRI_PLAIN",
            "kaifuu-real-kirikiri-plain-corpus",
        ),
        (
            "ITOTORI_REAL_GAME_ROOT_KIRIKIRI_ENCRYPTED",
            "kaifuu-real-kirikiri-encrypted-corpus",
        ),
    ];

    let mut exercised = 0u32;
    for (env_var, fixture_id) in real_cases {
        let Some(game_root) = std::env::var_os(env_var) else {
            continue;
        };
        let archive = PathBuf::from(game_root).join("data.xp3");
        assert!(
            archive.is_file(),
            "{env_var} must point to a KiriKiri game root containing data.xp3"
        );
        exercised += 1;

        let root = temp_dir(&format!("xp3-real-bytes-{fixture_id}"));
        // Materialize the fixture next to a symlink pointing at the
        // real archive — the proof's path validator rejects absolute
        // paths so we must hand it a relative archive reference.
        let archive_link = root.join("archive.xp3");
        std::os::unix::fs::symlink(&archive, &archive_link).unwrap();
        let fixture_path = root.join("fixture.json");
        let fixture_body = serde_json::json!({
            "schemaVersion": "0.1.0",
            "fixtureId": fixture_id,
            "profileId": "019ed000-0000-7000-8000-000000095001",
            "archive": {
                "archiveId": "kirikiri-xp3-archive",
                "path": "archive.xp3",
            },
            "expectedClassification": "plain",
            "patchCapabilityLevel": "patch_back",
        });
        fs::write(&fixture_path, fixture_body.to_string()).unwrap();

        let output = root.join("real-bytes-proof.json");
        // We accept Err from the CLI here — the proof exits non-zero
        // when the plain inventory cannot be read and the fixture
        // overclaimed patch_back. We assert from the report contents.
        let _ = run_xp3_profile_proof_cli(&fixture_path, &output);

        let report: serde_json::Value = read_json(&output).unwrap();
        // The proof must never claim patch-back on a real-bytes
        // archive whose index the reader cannot inventory.
        assert_ne!(
            report["patchCapabilityLevel"], "patch_back",
            "configured real-bytes archive must never claim patch_back"
        );
        // Patch-write attempted is always false — the proof never
        // writes patched bytes.
        assert_eq!(report["patchWriteAttempted"], false);
        // The archive hash is computed regardless of classification.
        let archive_hash = report["archive"]["archiveHash"].as_str().unwrap();
        assert!(archive_hash.starts_with("sha256:"));

        // The absolute path must not be echoed in the report.
        let serialized = fs::read_to_string(&output).unwrap();
        if let Some(archive_path) = archive.to_str() {
            assert!(
                !serialized.contains(archive_path),
                "configured real-bytes archive path leaked into report"
            );
        }

        let _ = fs::remove_dir_all(root);
    }

    // Public CI without the optional corpus is fine — the synthetic
    // tests cover correctness; this test only adds *additional* signal
    // when real bytes are available. Logging via println! makes the
    // exercised count visible in `cargo test -- --nocapture`.
    println!("XP3 profile real-bytes corpus exercised {exercised} game(s)");
}

// Plain XP3 deterministic writer CLI tests
