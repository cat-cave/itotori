#[test]
fn helper_registry_check_binary_reports_allowlist_diagnostics() {
    let fixture = public_fixture_path(
        "fixtures/public/kaifuu-helper-results/helper-registry/valid-helper.json",
    );
    let allowed_binary = public_fixture_path(
        "fixtures/public/kaifuu-helper-results/helper-binaries/kaifuu-fixture-helper",
    );
    let root = temp_dir("helper-registry-check-binary-allowed");
    let output = root.join("helper-binary-report.json");

    run_cli(&[
        "helper-registry",
        "check-binary",
        fixture.to_str().unwrap(),
        "--helper-binary",
        allowed_binary.to_str().unwrap(),
        "--allowlist-entry-id",
        kaifuu_core::FIXTURE_HELPER_ALLOWLIST_REF_ID,
        "--platform",
        "fixture-any",
        "--helper-version",
        "0.1.0",
        "--capability",
        "fixture_invocation",
        "--output",
        output.to_str().unwrap(),
    ]);

    let report: serde_json::Value = read_json(&output).unwrap();
    assert_eq!(report["status"], "passed");
    assert_eq!(report["helperId"], kaifuu_core::FIXTURE_HELPER_REGISTRY_ID);
    assert_eq!(
        report["allowlistEntryId"],
        kaifuu_core::FIXTURE_HELPER_ALLOWLIST_REF_ID
    );
    assert_eq!(
        report["observedHash"],
        "sha256:c1ac7473395cf2fbb823d33c63b5b4810352e3d2c255833498ba4fc4efb29f7c"
    );

    let mismatch_binary = public_fixture_path(
        "fixtures/public/kaifuu-helper-results/helper-binaries/kaifuu-fixture-helper-mismatch",
    );
    let cases = [
        (
            "missing",
            fixture.clone(),
            public_fixture_path(
                "fixtures/public/kaifuu-helper-results/helper-binaries/missing-helper",
            ),
            "fixture-any",
            "0.1.0",
            "fixture_invocation",
            kaifuu_core::SEMANTIC_HELPER_ALLOWLIST_MISSING_BINARY,
        ),
        (
            "mismatched",
            fixture.clone(),
            mismatch_binary,
            "fixture-any",
            "0.1.0",
            "fixture_invocation",
            kaifuu_core::SEMANTIC_HELPER_ALLOWLIST_HASH_MISMATCH,
        ),
        (
            "wrong-platform",
            public_fixture_path(
                "fixtures/public/kaifuu-helper-results/helper-registry/allowlist-wrong-platform.json",
            ),
            allowed_binary.clone(),
            "fixture-any",
            "0.1.0",
            "fixture_invocation",
            kaifuu_core::SEMANTIC_HELPER_ALLOWLIST_WRONG_PLATFORM,
        ),
        (
            "stale-version",
            public_fixture_path(
                "fixtures/public/kaifuu-helper-results/helper-registry/allowlist-stale-version.json",
            ),
            allowed_binary.clone(),
            "fixture-any",
            "0.1.0",
            "fixture_invocation",
            kaifuu_core::SEMANTIC_HELPER_ALLOWLIST_STALE_VERSION,
        ),
        (
            "undeclared-capability",
            public_fixture_path(
                "fixtures/public/kaifuu-helper-results/helper-registry/allowlist-missing-declared-capability.json",
            ),
            allowed_binary.clone(),
            "fixture-any",
            "0.1.0",
            "key_discovery",
            kaifuu_core::SEMANTIC_HELPER_ALLOWLIST_UNDECLARED_CAPABILITY,
        ),
    ];

    for (
        name,
        registry_fixture,
        helper_binary,
        platform,
        helper_version,
        capability,
        expected_code,
    ) in cases
    {
        let root = temp_dir(&format!("helper-registry-check-binary-{name}"));
        let output = root.join("helper-binary-report.json");
        let result = run_with_args(vec![
            "helper-registry".to_string(),
            "check-binary".to_string(),
            registry_fixture.to_str().unwrap().to_string(),
            "--helper-binary".to_string(),
            helper_binary.to_str().unwrap().to_string(),
            "--allowlist-entry-id".to_string(),
            kaifuu_core::FIXTURE_HELPER_ALLOWLIST_REF_ID.to_string(),
            "--platform".to_string(),
            platform.to_string(),
            "--helper-version".to_string(),
            helper_version.to_string(),
            "--capability".to_string(),
            capability.to_string(),
            "--output".to_string(),
            output.to_str().unwrap().to_string(),
        ]);

        assert!(result.is_err(), "{name} unexpectedly passed");
        let report: serde_json::Value = read_json(&output).unwrap();
        assert_eq!(report["status"], "failed");
        assert_eq!(report["helperId"], kaifuu_core::FIXTURE_HELPER_REGISTRY_ID);
        assert_eq!(
            report["allowlistEntryId"],
            kaifuu_core::FIXTURE_HELPER_ALLOWLIST_REF_ID
        );
        assert_eq!(report["platform"], platform);
        if name == "mismatched" {
            let observed_hash = report["observedHash"]
                .as_str()
                .expect("mismatched helper should report top-level observedHash");
            assert!(
                observed_hash.starts_with("sha256:")
                    && observed_hash.len() == 71
                    && observed_hash["sha256:".len()..]
                        .chars()
                        .all(|character| character.is_ascii_hexdigit()
                            && !character.is_ascii_uppercase()),
                "{name}: observedHash is not canonical: {report:#?}"
            );
            assert!(
                report["diagnostics"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .any(|diagnostic| {
                        diagnostic["code"] == expected_code
                            && diagnostic["observedHash"].as_str() == Some(observed_hash)
                    }),
                "{name}: diagnostic did not preserve observedHash: {report:#?}"
            );
        }
        assert!(
            report["diagnostics"]
                .as_array()
                .unwrap()
                .iter()
                .any(|diagnostic| {
                    diagnostic["code"] == expected_code
                        && diagnostic["helperId"] == kaifuu_core::FIXTURE_HELPER_REGISTRY_ID
                        && diagnostic["allowlistEntryId"]
                            == kaifuu_core::FIXTURE_HELPER_ALLOWLIST_REF_ID
                        && diagnostic["platform"] == platform
                        && diagnostic["remediationCode"]
                            .as_str()
                            .is_some_and(|code| !code.is_empty())
                }),
            "{name}: {report:#?}"
        );
    }
}

#[test]
fn helper_result_validate_command_rejects_raw_secret_ref_path_component() {
    let root = temp_dir("helper-result-invalid-path-component");
    let output = root.join("helper-result-report.json");
    let fixture = public_fixture_path(
        "fixtures/public/kaifuu-helper-results/invalid/raw-base64url-path-component-secret-ref.json",
    );

    let result = run_with_args(vec![
        "helper-result".to_string(),
        "validate".to_string(),
        fixture.to_str().unwrap().to_string(),
        "--output".to_string(),
        output.to_str().unwrap().to_string(),
    ]);

    assert!(result.is_err());
    let report: serde_json::Value = read_json(&output).unwrap();
    assert_eq!(report["status"], "failed");
    assert_eq!(
        report["fixtureId"],
        "kaifuu-helper-invalid-encoded-path-component-ref"
    );
    assert!(
        report["failures"]
            .as_array()
            .unwrap()
            .iter()
            .any(|failure| {
                failure["fixtureId"] == "kaifuu-helper-invalid-encoded-path-component-ref"
                    && failure["field"] == "secretRefs.0.secretRef"
            })
    );
    let serialized = fs::read_to_string(&output).unwrap();
    assert!(!serialized.contains("mP9xZpQ2rS7vLj4N8aW_KtYd0hF3uC6b"));
}

#[test]
fn helper_result_validate_command_reports_redacted_field_and_fixture_id() {
    let root = temp_dir("helper-result-invalid");
    let helper_result_path = root.join("helper-result.json");
    let output = root.join("helper-result-report.json");
    fs::write(
        &helper_result_path,
        r#"{
  "schemaVersion": "0.1.0",
  "fixtureId": "kaifuu-helper-invalid-redaction",
  "helperResultId": "helper-result-invalid-redaction",
  "profileId": "019ed000-0000-7000-8000-profile00085",
  "helper": {
    "helperId": "kaifuu.fixture.static-parser",
    "helperVersion": "0.1.0",
    "helperKind": "staticParser"
  },
  "diagnostic": {
    "code": "success",
    "message": "helper output referenced path=/home/dev/private/key.bin"
  },
  "redaction": {
    "status": "redacted",
    "redactedLogHash": "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
  },
  "secretRefs": [
    {
      "requirementId": "siglus-secondary-key",
      "secretRef": "local-secret:fixture/siglus/secondary-key",
      "materialKind": "fixedBytes",
      "bytes": 16
    }
  ],
  "proofHashes": []
}
"#,
    )
    .unwrap();

    let result = run_with_args(vec![
        "helper-result".to_string(),
        "validate".to_string(),
        helper_result_path.to_str().unwrap().to_string(),
        "--output".to_string(),
        output.to_str().unwrap().to_string(),
    ]);

    assert!(result.is_err());
    let report: serde_json::Value = read_json(&output).unwrap();
    assert_eq!(report["status"], "failed");
    assert_eq!(report["fixtureId"], "kaifuu-helper-invalid-redaction");
    assert!(
        report["failures"]
            .as_array()
            .unwrap()
            .iter()
            .any(|failure| {
                failure["fixtureId"] == "kaifuu-helper-invalid-redaction"
                    && failure["field"] == "diagnostic.message"
            })
    );
    let serialized = fs::read_to_string(&output).unwrap();
    assert!(!serialized.contains("/home/dev"));
    assert!(!serialized.contains("key.bin"));
}

#[test]
fn offset_map_validate_command_accepts_valid_fixture() {
    let root = temp_dir("offset-map-valid");
    let output = root.join("offset-map-report.json");
    let fixture = core_fixture_path("fixtures/offset-map/shift-jis.json");

    run_cli(&[
        "offset-map",
        "validate",
        fixture.to_str().unwrap(),
        "--output",
        output.to_str().unwrap(),
    ]);

    let report: serde_json::Value = read_json(&output).unwrap();
    assert_eq!(report["status"], "passed");
    assert_eq!(report["diagnostics"].as_array().unwrap().len(), 0);
}

#[test]
fn offset_map_validate_command_writes_semantic_diagnostics() {
    let root = temp_dir("offset-map-invalid");
    let input = root.join("invalid-offset-map.json");
    let output = root.join("offset-map-report.json");
    fs::write(
        &input,
        r#"{
  "sourceFileId": "script.ks",
  "encoding": "utf_8",
  "sourceLength": 6,
  "decodedTextLength": 6,
  "patchedLength": 6,
  "segments": [
    {
      "sourceBytes": { "start": 0, "end": 4 },
      "decodedText": { "start": 0, "end": 4 },
      "patchedBytes": { "start": 0, "end": 4 }
    },
    {
      "sourceBytes": { "start": 3, "end": 8 },
      "decodedText": { "start": 4, "end": 6 },
      "patchedBytes": { "start": 4, "end": 6 }
    }
  ]
}
"#,
    )
    .unwrap();

    let error = run_cli_with_registry_result(
        &[
            "offset-map",
            "validate",
            input.to_str().unwrap(),
            "--output",
            output.to_str().unwrap(),
        ],
        &engine_registry(),
    )
    .expect_err("invalid offset map should fail");
    let error = error.to_string();
    assert!(
        error.contains("kaifuu.missing_source_revision_id"),
        "{error}"
    );
    assert!(error.contains("kaifuu.overlapping_spans"), "{error}");
    assert!(
        error.contains("kaifuu.out_of_range_source_range"),
        "{error}"
    );

    let report: serde_json::Value = read_json(&output).unwrap();
    let codes = report["diagnostics"]
        .as_array()
        .unwrap()
        .iter()
        .map(|diagnostic| diagnostic["code"].as_str().unwrap())
        .collect::<Vec<_>>();
    assert!(codes.contains(&"kaifuu.missing_source_revision_id"));
    assert!(codes.contains(&"kaifuu.overlapping_spans"));
    assert!(codes.contains(&"kaifuu.out_of_range_source_range"));
}

#[test]
fn offset_map_validate_command_rejects_detached_decoded_source_axes() {
    let root = temp_dir("offset-map-detached");
    let input = root.join("detached-offset-map.json");
    let output = root.join("offset-map-report.json");
    fs::write(
        &input,
        r#"{
  "sourceFileId": "script.ks",
  "sourceRevisionId": "rev-detached-001",
  "encoding": "utf_8",
  "sourceLength": 4,
  "decodedTextLength": 4,
  "patchedLength": 4,
  "segments": [
    {
      "sourceBytes": { "start": 0, "end": 0 },
      "decodedText": { "start": 0, "end": 4 },
      "patchedBytes": { "start": 0, "end": 4 }
    }
  ]
}
"#,
    )
    .unwrap();

    let error = run_cli_with_registry_result(
        &[
            "offset-map",
            "validate",
            input.to_str().unwrap(),
            "--output",
            output.to_str().unwrap(),
        ],
        &engine_registry(),
    )
    .expect_err("detached offset map should fail");
    let error = error.to_string();
    assert!(error.contains("kaifuu.detached_offset_segment"), "{error}");

    let report: serde_json::Value = read_json(&output).unwrap();
    let codes = report["diagnostics"]
        .as_array()
        .unwrap()
        .iter()
        .map(|diagnostic| diagnostic["code"].as_str().unwrap())
        .collect::<Vec<_>>();
    assert!(codes.contains(&"kaifuu.detached_offset_segment"));
}
