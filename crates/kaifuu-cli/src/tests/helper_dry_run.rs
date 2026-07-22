#[test]
fn helper_result_validate_command_accepts_public_fixture() {
    let root = temp_dir("helper-result-valid");
    let output = root.join("helper-result-report.json");
    let fixture = public_fixture_path("fixtures/public/kaifuu-helper-results/success.json");

    run_cli(&[
        "helper-result",
        "validate",
        fixture.to_str().unwrap(),
        "--output",
        output.to_str().unwrap(),
    ]);

    let report: serde_json::Value = read_json(&output).unwrap();
    assert_eq!(report["status"], "passed");
    assert_eq!(report["fixtureId"], "kaifuu-helper-success");
    assert_eq!(report["failures"].as_array().unwrap().len(), 0);
}

#[test]
fn helper_dry_run_names_five_fields_without_launching_and_matches_fixture() {
    // Public CI: no Wine/Proton, no private assets. The dry-run must resolve
    // the intended command from the synthetic request alone.
    let root = temp_dir("helper-dry-run-wine");
    let output = root.join("resolution.json");
    let request = public_fixture_path(
        "fixtures/public/kaifuu-helper-results/wine-proton/dry-run-wine-request.json",
    );

    run_cli(&[
        "helper",
        "dry-run",
        "--input",
        request.to_str().unwrap(),
        "--out",
        output.to_str().unwrap(),
    ]);

    let resolution: serde_json::Value = read_json(&output).unwrap();
    // (1) helper-binary-id, (2) platform-adapter, (3) intended-command,
    // (4) profile-id, (5) redaction-policy.
    assert_eq!(
        resolution["helperBinaryId"],
        "kaifuu.fixture.wine-local-windows"
    );
    assert_eq!(resolution["platformAdapter"], "wine-local");
    assert_eq!(resolution["intendedCommand"]["programRef"], "wine");
    assert_eq!(
        resolution["profileId"],
        "019ed000-0000-7000-8000-profile00090"
    );
    assert_eq!(
        resolution["redactionPolicy"],
        "redact-raw-logs-and-secret-refs"
    );
    // No launch.
    assert_eq!(resolution["launched"], false);
    assert_eq!(
        resolution["intendedCommand"]["launchesUntrustedCode"],
        false
    );
    // execution object carries no launch command; no raw secret.
    let serialized = fs::read_to_string(&output).unwrap();
    assert!(!serialized.contains("\"command\""));
    assert!(!serialized.contains("\"argv\""));
    assert!(!serialized.contains("\"env\""));

    // The committed resolution fixture must stay semantically identical to
    // the CLI output (formatting is owned by the repo formatter).
    let committed: serde_json::Value = read_json(&public_fixture_path(
        "fixtures/public/kaifuu-helper-results/wine-proton/dry-run-wine-resolution.json",
    ))
    .unwrap();
    assert_eq!(resolution, committed);
}

#[test]
fn helper_dry_run_unavailable_platform_emits_typed_diagnostic() {
    let root = temp_dir("helper-dry-run-unavailable");
    let output = root.join("resolution.json");
    let request = public_fixture_path(
        "fixtures/public/kaifuu-helper-results/wine-proton/dry-run-proton-unavailable-request.json",
    );

    run_cli(&[
        "helper",
        "dry-run",
        "--input",
        request.to_str().unwrap(),
        "--out",
        output.to_str().unwrap(),
    ]);

    let resolution: serde_json::Value = read_json(&output).unwrap();
    assert_eq!(resolution["platformAdapter"], "proton-local");
    assert_eq!(
        resolution["helperResult"]["diagnostic"]["code"],
        "helper_unavailable"
    );
    assert!(
        resolution["helperResult"]["diagnostic"]["message"]
            .as_str()
            .unwrap()
            .contains("kaifuu.helper_unavailable")
    );
    assert_eq!(resolution["launched"], false);

    let committed: serde_json::Value = read_json(&public_fixture_path(
            "fixtures/public/kaifuu-helper-results/wine-proton/dry-run-proton-unavailable-resolution.json",
        ))
        .unwrap();
    assert_eq!(resolution, committed);
}

#[test]
fn helper_dry_run_rejects_raw_secret_material() {
    let root = temp_dir("helper-dry-run-raw-secret");
    let output = root.join("resolution.json");
    let request = public_fixture_path(
        "fixtures/public/kaifuu-helper-results/wine-proton/invalid/dry-run-raw-secret-request.json",
    );

    let result = run_with_args(vec![
        "helper".to_string(),
        "dry-run".to_string(),
        "--input".to_string(),
        request.to_str().unwrap().to_string(),
        "--out".to_string(),
        output.to_str().unwrap().to_string(),
    ]);

    assert!(result.is_err());
    let message = result.unwrap_err().to_string();
    assert!(message.contains("kaifuu.wine_proton.dry_run.secret_leak"));
    // The failing resolution must not be persisted at all.
    assert!(!output.exists());
}

#[test]
fn helper_dry_run_rejects_execution_config_flags() {
    let root = temp_dir("helper-dry-run-exec-flag");
    let output = root.join("resolution.json");
    let request = public_fixture_path(
        "fixtures/public/kaifuu-helper-results/wine-proton/dry-run-wine-request.json",
    );

    let result = run_with_args(vec![
        "helper".to_string(),
        "dry-run".to_string(),
        "--input".to_string(),
        request.to_str().unwrap().to_string(),
        "--out".to_string(),
        output.to_str().unwrap().to_string(),
        "--command".to_string(),
        "wine game.exe".to_string(),
    ]);

    assert!(result.is_err());
}

#[test]
fn native_windows_dry_run_records_six_fields_without_launching_and_matches_fixture() {
    // Public CI: non-Windows runner, no private assets. The dry-run must
    // resolve the intended command from the synthetic request alone.
    let root = temp_dir("helper-dry-run-native-windows");
    let output = root.join("resolution.json");
    let request = public_fixture_path(
        "fixtures/public/kaifuu-helper-results/native-windows/dry-run-native-windows-request.json",
    );

    run_cli(&[
        "helper",
        "dry-run",
        "--platform",
        "native-windows",
        "--input",
        request.to_str().unwrap(),
        "--out",
        output.to_str().unwrap(),
    ]);

    let resolution: serde_json::Value = read_json(&output).unwrap();
    // (1) platform-adapter, (2) helper-binary-id, (3) command-argv + quoted
    // command line, (4) working-directory-policy, (5) profile-id,
    // (6) redaction-policy.
    assert_eq!(resolution["platformAdapterId"], "native-windows");
    assert_eq!(resolution["platformAdapter"], "native-windows-local");
    assert_eq!(
        resolution["helperBinaryId"],
        "kaifuu.fixture.native-windows-local"
    );
    assert_eq!(
        resolution["intendedCommand"]["programRef"],
        "native-windows-helper"
    );
    assert!(
        resolution["intendedCommand"]["argumentTemplate"]
            .as_array()
            .unwrap()
            .iter()
            .any(|token| token == "--dry-run")
    );
    assert_eq!(
        resolution["intendedCommand"]["quotingRules"],
        "CommandLineToArgvW"
    );
    assert!(
        resolution["intendedCommand"]["commandLine"]
            .as_str()
            .unwrap()
            .starts_with("native-windows-helper --platform native-windows-local")
    );
    assert_eq!(
        resolution["intendedCommand"]["workingDirectoryPolicy"],
        "sandboxed-read-only-game-copy"
    );
    assert_eq!(
        resolution["profileId"],
        "019ed000-0000-7000-8000-profile00129"
    );
    assert_eq!(
        resolution["redactionPolicy"],
        "redact-raw-logs-and-secret-refs"
    );
    // No launch.
    assert_eq!(resolution["launched"], false);
    assert_eq!(
        resolution["intendedCommand"]["launchesUntrustedCode"],
        false
    );
    // The execution object carries no launch command; the quoted
    // descriptor lives under `commandLine`, not `command`/`argv`/`env`.
    let serialized = fs::read_to_string(&output).unwrap();
    assert!(!serialized.contains("\"command\""));
    assert!(!serialized.contains("\"argv\""));
    assert!(!serialized.contains("\"env\""));

    // The committed resolution fixture must stay semantically identical to
    // the CLI output.
    let committed: serde_json::Value = read_json(&public_fixture_path(
            "fixtures/public/kaifuu-helper-results/native-windows/dry-run-native-windows-resolution.json",
        ))
        .unwrap();
    assert_eq!(resolution, committed);
}

#[test]
fn native_windows_dry_run_unavailable_platform_emits_typed_diagnostic() {
    // Non-Windows public CI: availability is a synthetic request field, so
    // "unavailable" yields a typed helper_unavailable diagnostic, not a
    // platform-absence failure.
    let root = temp_dir("helper-dry-run-native-windows-unavailable");
    let output = root.join("resolution.json");
    let request = public_fixture_path(
        "fixtures/public/kaifuu-helper-results/native-windows/dry-run-native-windows-unavailable-request.json",
    );

    run_cli(&[
        "helper",
        "dry-run",
        "--platform",
        "native-windows",
        "--input",
        request.to_str().unwrap(),
        "--out",
        output.to_str().unwrap(),
    ]);

    let resolution: serde_json::Value = read_json(&output).unwrap();
    assert_eq!(resolution["platformAdapterId"], "native-windows");
    assert_eq!(
        resolution["helperResult"]["diagnostic"]["code"],
        "helper_unavailable"
    );
    assert!(
        resolution["helperResult"]["diagnostic"]["message"]
            .as_str()
            .unwrap()
            .contains("kaifuu.helper_unavailable")
    );
    assert_eq!(resolution["launched"], false);

    let committed: serde_json::Value = read_json(&public_fixture_path(
            "fixtures/public/kaifuu-helper-results/native-windows/dry-run-native-windows-unavailable-resolution.json",
        ))
        .unwrap();
    assert_eq!(resolution, committed);
}

#[test]
fn native_windows_dry_run_rejects_raw_secret_material() {
    let root = temp_dir("helper-dry-run-native-windows-raw-secret");
    let output = root.join("resolution.json");
    let request = public_fixture_path(
        "fixtures/public/kaifuu-helper-results/native-windows/invalid/dry-run-native-windows-raw-secret-request.json",
    );

    let result = run_with_args(vec![
        "helper".to_string(),
        "dry-run".to_string(),
        "--platform".to_string(),
        "native-windows".to_string(),
        "--input".to_string(),
        request.to_str().unwrap().to_string(),
        "--out".to_string(),
        output.to_str().unwrap().to_string(),
    ]);

    assert!(result.is_err());
    let message = result.unwrap_err().to_string();
    assert!(message.contains("kaifuu.native_windows.dry_run.secret_leak"));
    // The failing resolution must not be persisted at all.
    assert!(!output.exists());
}

#[test]
fn native_windows_dry_run_rejects_execution_config_flags() {
    let root = temp_dir("helper-dry-run-native-windows-exec-flag");
    let output = root.join("resolution.json");
    let request = public_fixture_path(
        "fixtures/public/kaifuu-helper-results/native-windows/dry-run-native-windows-request.json",
    );

    let result = run_with_args(vec![
        "helper".to_string(),
        "dry-run".to_string(),
        "--platform".to_string(),
        "native-windows".to_string(),
        "--input".to_string(),
        request.to_str().unwrap().to_string(),
        "--out".to_string(),
        output.to_str().unwrap().to_string(),
        "--argv".to_string(),
        "game.exe".to_string(),
    ]);

    assert!(result.is_err());
}

#[test]
fn native_windows_quoting_fixture_matches_committed_and_round_trips() {
    let root = temp_dir("helper-quoting-fixture");
    let output = root.join("quoting-fixture.json");

    run_cli(&[
        "helper",
        "quoting-fixture",
        "--out",
        output.to_str().unwrap(),
    ]);

    let fixture: serde_json::Value = read_json(&output).unwrap();
    assert_eq!(fixture["quotingRules"], "CommandLineToArgvW");
    assert_eq!(fixture["launchesUntrustedCode"], false);

    // Cross-check a couple of adversarial cases against the CommandLineToArgvW
    // rules (space, embedded quote, backslash-before-quote).
    let cases = fixture["cases"].as_array().unwrap();
    let quoted_for = |raw: &str| -> String {
        cases
            .iter()
            .find(|case| case["raw"] == raw)
            .and_then(|case| case["quoted"].as_str())
            .unwrap()
            .to_string()
    };
    assert_eq!(quoted_for("arg with spaces"), "\"arg with spaces\"");
    assert_eq!(
        quoted_for("bs before quote\\\""),
        "\"bs before quote\\\\\\\"\""
    );

    let committed: serde_json::Value = read_json(&public_fixture_path(
        "fixtures/public/kaifuu-helper-results/native-windows/quoting-fixture.json",
    ))
    .unwrap();
    assert_eq!(fixture, committed);
}

#[test]
fn key_helper_validate_command_writes_normalized_helper_result_contract() {
    let root = temp_dir("key-helper-valid");
    let output = root.join("normalized-helper-result.json");
    let fixture =
        public_fixture_path("fixtures/public/kaifuu-helper-results/key-helper/manual-entry.json");

    run_cli(&[
        "key-helper",
        "validate",
        "--fixture",
        fixture.to_str().unwrap(),
        "--output",
        output.to_str().unwrap(),
    ]);

    let result: serde_json::Value = read_json(&output).unwrap();
    assert_eq!(result["fixtureId"], "kaifuu-key-helper-manual-entry");
    assert_eq!(result["helper"]["helperKind"], "manualKeyEntry");
    assert_eq!(result["capabilityLevel"], "manualEntry");
    assert_eq!(result["execution"]["mode"], "notExecuted");
    assert_eq!(result["execution"]["bounded"], true);
    let serialized = fs::read_to_string(&output).unwrap();
    assert!(!serialized.contains("rawKey"));
    assert!(!serialized.contains("keyMaterial"));
    assert!(!serialized.contains("command"));
}

#[test]
fn key_helper_validate_command_rejects_arbitrary_command_metadata() {
    let root = temp_dir("key-helper-invalid");
    let output = root.join("key-helper-report.json");
    let fixture = public_fixture_path(
        "fixtures/public/kaifuu-helper-results/invalid/execution-command-field.json",
    );

    let result = run_with_args(vec![
        "key-helper".to_string(),
        "validate".to_string(),
        "--fixture".to_string(),
        fixture.to_str().unwrap().to_string(),
        "--output".to_string(),
        output.to_str().unwrap().to_string(),
    ]);

    assert!(result.is_err());
    let report: serde_json::Value = read_json(&output).unwrap();
    assert_eq!(report["status"], "failed");
    assert!(
        report["failures"]
            .as_array()
            .unwrap()
            .iter()
            .any(|failure| failure["field"] == "execution.command"
                && failure["code"] == "forbidden_helper_execution_field")
    );
    let serialized = fs::read_to_string(&output).unwrap();
    assert!(!serialized.contains("fixture-helper --dump"));
}

#[test]
fn key_helper_validate_command_rejects_top_level_command_metadata() {
    let root = temp_dir("key-helper-top-level-command-invalid");
    let fixture = root.join("top-level-command.json");
    let output = root.join("key-helper-report.json");
    let mut value: serde_json::Value = read_json(&public_fixture_path(
        "fixtures/public/kaifuu-helper-results/key-helper/static-parser.json",
    ))
    .unwrap();
    value.as_object_mut().unwrap().insert(
        "command".to_string(),
        serde_json::json!("fixture-helper --dump-private-state"),
    );
    write_json(&fixture, &value).unwrap();

    let result = run_with_args(vec![
        "key-helper".to_string(),
        "validate".to_string(),
        "--fixture".to_string(),
        fixture.to_str().unwrap().to_string(),
        "--output".to_string(),
        output.to_str().unwrap().to_string(),
    ]);

    assert!(result.is_err());
    let report: serde_json::Value = read_json(&output).unwrap();
    assert_eq!(report["status"], "failed");
    assert!(
        report["failures"]
            .as_array()
            .unwrap()
            .iter()
            .any(|failure| failure["field"] == "command"
                && failure["code"] == "forbidden_helper_metadata_field")
    );
    let serialized = fs::read_to_string(&output).unwrap();
    assert!(!serialized.contains("dump-private-state"));
}
