#[test]
fn key_helper_validate_command_rejects_static_parser_remote_overclaim() {
    let root = temp_dir("key-helper-static-remote-overclaim-invalid");
    let fixture = root.join("static-remote-overclaim.json");
    let output = root.join("key-helper-report.json");
    let mut value: serde_json::Value = read_json(&public_fixture_path(
        "fixtures/public/kaifuu-helper-results/key-helper/static-parser.json",
    ))
    .unwrap();
    value["capabilityLevel"] = serde_json::json!("remoteWindows");
    value["execution"]["mode"] = serde_json::json!("remoteHelper");
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
            .any(|failure| failure["field"] == "helper"
                && failure["code"] == "invalid_helper_semantics")
    );
}

#[test]
fn helper_registry_validate_command_accepts_public_fixture() {
    let root = temp_dir("helper-registry-valid");
    let output = root.join("helper-registry-report.json");
    let fixture = public_fixture_path(
        "fixtures/public/kaifuu-helper-results/helper-registry/valid-helper.json",
    );

    run_cli(&[
        "helper-registry",
        "validate",
        fixture.to_str().unwrap(),
        "--output",
        output.to_str().unwrap(),
    ]);

    let report: serde_json::Value = read_json(&output).unwrap();
    assert_eq!(report["status"], "passed");
    assert_eq!(report["helperId"], kaifuu_core::FIXTURE_HELPER_REGISTRY_ID);
    assert_eq!(report["diagnostics"].as_array().unwrap().len(), 0);
}

#[test]
fn helper_registry_validate_command_rejects_invalid_fixtures() {
    let cases = [
        (
            "missing-capability",
            kaifuu_core::SEMANTIC_HELPER_REGISTRY_MISSING_CAPABILITY,
        ),
        (
            "bad-schema-id",
            kaifuu_core::SEMANTIC_HELPER_REGISTRY_UNSUPPORTED_SCHEMA_ID,
        ),
        (
            "unsupported-redaction-class",
            kaifuu_core::SEMANTIC_HELPER_REGISTRY_INVALID_REDACTION_CLASS,
        ),
    ];

    for (fixture_name, expected_code) in cases {
        let root = temp_dir(&format!("helper-registry-invalid-{fixture_name}"));
        let output = root.join("helper-registry-report.json");
        let fixture = public_fixture_path(&format!(
            "fixtures/public/kaifuu-helper-results/helper-registry/{fixture_name}.json",
        ));

        let result = run_with_args(vec![
            "helper-registry".to_string(),
            "validate".to_string(),
            fixture.to_str().unwrap().to_string(),
            "--output".to_string(),
            output.to_str().unwrap().to_string(),
        ]);

        assert!(result.is_err());
        let report: serde_json::Value = read_json(&output).unwrap();
        assert_eq!(report["status"], "failed");
        assert!(
            report["diagnostics"]
                .as_array()
                .unwrap()
                .iter()
                .any(|diagnostic| diagnostic["code"] == expected_code)
        );
    }
}

#[test]
fn helper_registry_invoke_fixture_stub_command_uses_registry_boundary() {
    let root = temp_dir("helper-registry-invoke");
    let output = root.join("helper-result.json");

    run_cli(&[
        "helper-registry",
        "invoke-fixture-stub",
        "--output",
        output.to_str().unwrap(),
    ]);

    let result: serde_json::Value = read_json(&output).unwrap();
    assert_eq!(result["fixtureId"], "kaifuu-helper-registry-stub");
    assert_eq!(
        result["helper"]["helperId"],
        kaifuu_core::FIXTURE_HELPER_REGISTRY_ID
    );
    assert_eq!(result["diagnostic"]["code"], "success");
}

#[test]
fn helper_registry_invoke_fixture_stub_accepts_siglus_key_validation_request() {
    let root = temp_dir("helper-registry-invoke-siglus-request");
    let output = root.join("helper-result.json");
    let request = public_fixture_path(
        "fixtures/public/kaifuu-helper-results/helper-request/siglus-secondary-key-request.json",
    );

    run_cli(&[
        "helper-registry",
        "invoke-fixture-stub",
        "--input",
        request.to_str().unwrap(),
        "--output",
        output.to_str().unwrap(),
    ]);

    let result: serde_json::Value = read_json(&output).unwrap();
    let expected: serde_json::Value = read_json(&public_fixture_path(
        "fixtures/public/kaifuu-helper-results/siglus-secondary-key-helper-boundary-success.json",
    ))
    .unwrap();
    assert_eq!(result, expected);
    assert_eq!(
        result["helper"]["helperId"],
        kaifuu_core::FIXTURE_HELPER_REGISTRY_ID
    );
    assert_eq!(result["diagnostic"]["code"], "success");
    let serialized = fs::read_to_string(&output).unwrap();
    for forbidden in [
        "rawKey",
        "keyMaterial",
        "00112233445566778899aabbccddeeff",
        "decrypted script",
        "/home/",
        "C:\\",
    ] {
        assert!(!serialized.contains(forbidden), "leaked {forbidden}");
    }
}

#[test]
fn helper_registry_invoke_fixture_stub_reports_siglus_rejected_helper_with_registered_override() {
    let root = temp_dir("helper-registry-invoke-siglus-rejected-helper");
    let output = root.join("helper-result.json");
    let request = public_fixture_path(
        "fixtures/public/kaifuu-helper-results/helper-request/siglus-secondary-key-helper-rejection.json",
    );

    run_cli(&[
        "helper-registry",
        "invoke-fixture-stub",
        "--input",
        request.to_str().unwrap(),
        "--helper-id",
        kaifuu_core::FIXTURE_HELPER_REGISTRY_ID,
        "--output",
        output.to_str().unwrap(),
    ]);

    let result: serde_json::Value = read_json(&output).unwrap();
    assert_eq!(result["diagnostic"]["code"], "validation_failed");
    assert_eq!(
        result["diagnostic"]["message"],
        kaifuu_core::SEMANTIC_HELPER_REQUEST_WRONG_HELPER
    );
    assert_eq!(
        result["helper"]["helperId"],
        kaifuu_core::FIXTURE_HELPER_REGISTRY_ID
    );
    assert_eq!(
        kaifuu_core::validate_helper_result_value(&result).status,
        kaifuu_core::OperationStatus::Passed
    );

    // Parity with the core boundary suite: the structured rejection
    // diagnostic must stay public-safe even though the request fixture
    // names a helper id the registry does not recognize.
    let serialized = fs::read_to_string(&output).unwrap();
    for forbidden in [
        "rawKey",
        "keyMaterial",
        "00112233445566778899aabbccddeeff",
        "decrypted script",
        "/home/",
        "C:\\",
    ] {
        assert!(!serialized.contains(forbidden), "leaked {forbidden}");
    }
}

#[test]
fn helper_registry_invoke_fixture_stub_fails_closed_for_unregistered_request_helper() {
    let root = temp_dir("helper-registry-invoke-unregistered-helper");
    let output = root.join("helper-result.json");
    let request = public_fixture_path(
        "fixtures/public/kaifuu-helper-results/helper-request/siglus-secondary-key-helper-rejection.json",
    );

    let error = run_with_args(vec![
        "helper-registry".to_string(),
        "invoke-fixture-stub".to_string(),
        "--input".to_string(),
        request.display().to_string(),
        "--output".to_string(),
        output.display().to_string(),
    ])
    .unwrap_err();

    assert!(
        error
            .to_string()
            .contains(kaifuu_core::SEMANTIC_HELPER_UNAVAILABLE)
    );
    assert!(!output.exists());
}

#[test]
fn helper_registry_invoke_fixture_stub_rejects_siglus_request_missing_redaction_expectation() {
    let root = temp_dir("helper-registry-invoke-siglus-request-missing-redaction");
    let input = root.join("helper-request.json");
    let output = root.join("helper-result.json");
    let mut request: serde_json::Value = read_json(&public_fixture_path(
        "fixtures/public/kaifuu-helper-results/helper-request/siglus-secondary-key-request.json",
    ))
    .unwrap();
    request
        .as_object_mut()
        .unwrap()
        .remove("expectedRedactedLogHash");
    fs::write(&input, serde_json::to_string_pretty(&request).unwrap()).unwrap();

    run_cli(&[
        "helper-registry",
        "invoke-fixture-stub",
        "--input",
        input.to_str().unwrap(),
        "--output",
        output.to_str().unwrap(),
    ]);

    let result: serde_json::Value = read_json(&output).unwrap();
    assert_eq!(result["diagnostic"]["code"], "redaction_failure");
    assert_eq!(
        result["diagnostic"]["message"],
        kaifuu_core::SEMANTIC_HELPER_REQUEST_MISSING_REDACTED_OUTPUT_EXPECTATION
    );
    assert_eq!(result["redaction"]["status"], "failed");
    assert_eq!(result["secretRefs"], serde_json::json!([]));
    let serialized = fs::read_to_string(&output).unwrap();
    for forbidden in [
        "rawKey",
        "keyMaterial",
        "00112233445566778899aabbccddeeff",
        "fixture-only-siglus-secondary-key-v1",
        "decrypted script",
        "/home/",
        "C:\\",
    ] {
        assert!(!serialized.contains(forbidden), "leaked {forbidden}");
    }
}

#[test]
fn helper_registry_invoke_fixture_stub_rejects_siglus_key_refs_without_redaction_expectation() {
    let root = temp_dir("helper-registry-invoke-siglus-request-no-required-redaction");
    let input = root.join("helper-request.json");
    let output = root.join("helper-result.json");
    let mut request: serde_json::Value = read_json(&public_fixture_path(
        "fixtures/public/kaifuu-helper-results/helper-request/siglus-secondary-key-request.json",
    ))
    .unwrap();
    let request_object = request.as_object_mut().unwrap();
    request_object.remove("expectedRedactedLogHash");
    request_object.remove("requiredKeyRefs");
    fs::write(&input, serde_json::to_string_pretty(&request).unwrap()).unwrap();

    run_cli(&[
        "helper-registry",
        "invoke-fixture-stub",
        "--input",
        input.to_str().unwrap(),
        "--output",
        output.to_str().unwrap(),
    ]);

    let result: serde_json::Value = read_json(&output).unwrap();
    assert_eq!(result["diagnostic"]["code"], "redaction_failure");
    assert_eq!(
        result["diagnostic"]["message"],
        kaifuu_core::SEMANTIC_HELPER_REQUEST_MISSING_REDACTED_OUTPUT_EXPECTATION
    );
    assert_eq!(result["redaction"]["status"], "failed");
    assert_eq!(result["secretRefs"], serde_json::json!([]));
    let serialized = fs::read_to_string(&output).unwrap();
    for forbidden in [
        "rawKey",
        "keyMaterial",
        "00112233445566778899aabbccddeeff",
        "fixture-only-siglus-secondary-key-v1",
        "decrypted script",
        "/home/",
        "C:\\",
    ] {
        assert!(!serialized.contains(forbidden), "leaked {forbidden}");
    }
}

#[test]
fn key_import_command_writes_local_secret_and_hash_only_report() {
    let root = temp_dir("key-import-command");
    let secret_store = root.join("secrets.local");
    let output = root.join("key-import-report.json");

    run_cli(&[
        "key",
        "import",
        "--secret-store",
        secret_store.to_str().unwrap(),
        "--secret-ref",
        "local-secret:fixture/siglus/manual-secondary-key",
        "--purpose",
        "siglus-secondary-key",
        "--engine-profile-id",
        "019ed000-0000-7000-8000-profile00087",
        "--source-hash",
        "sha256:2222222222222222222222222222222222222222222222222222222222222222",
        "--key-hex",
        "000102030405060708090a0b0c0d0e0f",
        "--output",
        output.to_str().unwrap(),
    ]);

    let report: serde_json::Value = read_json(&output).unwrap();
    assert_eq!(
        report["secretRef"],
        "local-secret:fixture/siglus/manual-secondary-key"
    );
    assert_eq!(report["keyPurpose"], "siglus-secondary-key");
    assert_eq!(
        report["engineProfileId"],
        "019ed000-0000-7000-8000-profile00087"
    );
    assert_eq!(report["redactionStatus"], "redacted");
    assert_eq!(report["materialBytes"], 16);
    assert!(
        report["materialHash"]
            .as_str()
            .unwrap()
            .starts_with("sha256:")
    );
    assert_eq!(
        fs::read(secret_store.join("fixture/siglus/manual-secondary-key")).unwrap(),
        (0_u8..16).collect::<Vec<_>>()
    );
    let serialized = fs::read_to_string(&output).unwrap();
    assert!(!serialized.contains("000102030405060708090a0b0c0d0e0f"));
    assert!(!serialized.contains("rawKey"));
    assert!(!serialized.contains("keyMaterial"));
}

#[test]
fn key_import_usage_steers_away_from_command_line_hex_key() {
    // the key-import usage text must not advertise `--key-hex`
    // as the primary manual-entry path (a hex key on the command line leaks
    // into shell history + the process list). It must recommend the
    // shell-history-safe `--key-file` path, warn about the hex hazard, and
    // retain the hash-only report explanation.
    let err = run_with_args(vec!["key".to_string(), "not-a-subcommand".to_string()])
        .expect_err("unknown key subcommand must surface the usage text");
    let usage = err.to_string();

    // `--key-file` is the advertised/primary path and appears before the
    // discouraged `--key-hex` option.
    let key_file_at = usage
        .find("--key-file")
        .expect("usage must mention --key-file");
    let key_hex_at = usage
        .find("--key-hex")
        .expect("usage must still document --key-hex");
    assert!(
        key_file_at < key_hex_at,
        "--key-file must be advertised before --key-hex; usage: {usage}"
    );

    // The required-argument slot advertises --key-file, not a
    // `(--key-hex|...)` primary choice.
    assert!(
        usage.contains("--engine-profile-id <id> --key-file <path>"),
        "usage must advertise --key-file as the primary key input; usage: {usage}"
    );
    assert!(
        !usage.contains("(--key-hex <hex>|--key-file <path>)"),
        "usage must not advertise --key-hex as a primary manual-entry path; usage: {usage}"
    );

    // The safe method is recommended and the shell-history hazard is called
    // out.
    assert!(
        usage.contains("recommended"),
        "usage must recommend the shell-history-safe path; usage: {usage}"
    );
    assert!(
        usage.contains("shell history"),
        "usage must warn about shell-history exposure; usage: {usage}"
    );
    assert!(
        usage.contains("process list"),
        "usage must warn about process-list exposure; usage: {usage}"
    );
    assert!(
        usage.contains("DISCOURAGED"),
        "usage must mark --key-hex as discouraged; usage: {usage}"
    );

    // The hash-only report explanation is retained.
    assert!(
        usage.contains("sha256 hash"),
        "usage must retain the hash-only report explanation; usage: {usage}"
    );

    // The missing-material error also steers toward the safe path.
    let empty: Vec<String> = Vec::new();
    let material_err = import_key_material_from_args(&empty)
        .expect_err("missing key material must error with guidance");
    let material_msg = material_err.to_string();
    let file_at = material_msg
        .find("--key-file")
        .expect("error must mention --key-file");
    let hex_at = material_msg
        .find("--key-hex")
        .expect("error must mention --key-hex");
    assert!(
        file_at < hex_at,
        "missing-material error must lead with --key-file: {material_msg}"
    );
}
