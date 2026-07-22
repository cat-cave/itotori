#[derive(Debug, Clone)]
struct StubExternalSecretResolver {
    resolution: ExternalSecretResolution,
}

impl ExternalSecretResolver for StubExternalSecretResolver {
    fn resolve_external_secret(
        &self,
        _request: ExternalSecretRequest<'_>,
    ) -> Result<ExternalSecretResolution, KeyResolverError> {
        Ok(self.resolution.clone())
    }
}

fn key_profile_with_secret_ref(secret_ref: &str) -> GameProfile {
    let mut profile = valid_key_profile_value();
    profile["keyRequirements"][0]["secretRef"] = serde_json::json!(secret_ref);
    serde_json::from_value(profile).unwrap()
}

fn assert_key_resolver_error(
    result: Result<Option<Vec<u8>>, KeyResolverError>,
    expected_kind: KeyResolverErrorKind,
    expected_code: SemanticErrorCode,
) {
    let error = result.unwrap_err();
    assert_eq!(error.kind(), expected_kind);
    assert_eq!(error.semantic_code(), expected_code);
    let diagnostic = error.diagnostic();
    assert_eq!(diagnostic.kind, expected_kind);
    assert_eq!(diagnostic.code, expected_code);
    let serialized = serde_json::to_string(&diagnostic).unwrap();
    assert!(!serialized.contains("/tmp"));
    assert!(!serialized.contains("private"));
}

fn public_helper_result_fixture_value(name: &str) -> Value {
    bridge_fixture_value(&format!(
        "fixtures/public/kaifuu-helper-results/{name}.json"
    ))
}

fn invalid_public_helper_result_fixture_value(name: &str) -> Value {
    bridge_fixture_value(&format!(
        "fixtures/public/kaifuu-helper-results/invalid/{name}.json"
    ))
}

fn encrypted_matrix_fixture_value(relative_path: &str) -> Value {
    bridge_fixture_value(&format!(
        "fixtures/public/kaifuu-encrypted-matrix/{relative_path}"
    ))
}

fn public_helper_request_fixture_value(name: &str) -> Value {
    bridge_fixture_value(&format!(
        "fixtures/public/kaifuu-helper-results/helper-request/{name}.json"
    ))
}

fn public_helper_registry_fixture_value(name: &str) -> Value {
    bridge_fixture_value(&format!(
        "fixtures/public/kaifuu-helper-results/helper-registry/{name}.json"
    ))
}

fn public_helper_binary_path(name: &str) -> PathBuf {
    crate::test_manifest_dir()
        .join("../..")
        .join("fixtures/public/kaifuu-helper-results/helper-binaries")
        .join(name)
}

fn fixture_helper_invocation(input: &Value) -> HelperRegistryInvocationRequest<'_> {
    HelperRegistryInvocationRequest {
        helper_id: FIXTURE_HELPER_REGISTRY_ID,
        helper_version: "0.1.0",
        allowlist_entry_id: FIXTURE_HELPER_ALLOWLIST_REF_ID,
        capability: HelperCapability::FixtureInvocation,
        input,
    }
}

fn fixture_helper_key_validation(input: &Value) -> HelperRegistryInvocationRequest<'_> {
    HelperRegistryInvocationRequest {
        helper_id: FIXTURE_HELPER_REGISTRY_ID,
        helper_version: "0.1.0",
        allowlist_entry_id: FIXTURE_HELPER_ALLOWLIST_REF_ID,
        capability: HelperCapability::KeyValidation,
        input,
    }
}

#[test]
fn helper_execution_modes_have_no_external_process_launch_variant() {
    // Regression guard for the deleted external helper-process launch path.
    // No helper execution mode names a real local-process launch: helper key
    // discovery is in-process (StaticParser) or a dry-run descriptor only.
    assert!(
        serde_json::from_value::<HelperResultExecutionMode>(serde_json::json!("localProcess"))
            .is_err(),
        "HelperResultExecutionMode must not accept a real local-process launch mode"
    );
    assert!(
        serde_json::from_value::<HelperExecutionMode>(serde_json::json!("local_process")).is_err(),
        "HelperExecutionMode must not accept a real local-process launch policy"
    );
    // The remaining result modes are in-process or dry-run descriptors only.
    for mode in ["notExecuted", "inProcess", "platformHelper", "remoteHelper"] {
        assert!(
            serde_json::from_value::<HelperResultExecutionMode>(serde_json::json!(mode)).is_ok(),
            "expected descriptor mode {mode} to remain valid"
        );
    }
}

#[test]
fn public_helper_registry_fixtures_validate_semantic_diagnostics() {
    let valid = public_helper_registry_fixture_value("valid-helper");
    let validation = validate_helper_registry_entry_value(&valid);
    assert_eq!(
        validation.status,
        OperationStatus::Passed,
        "{:#?}",
        validation.diagnostics
    );
    let entry: HelperRegistryEntry = serde_json::from_value(valid).unwrap();
    assert_eq!(entry.helper_id, FIXTURE_HELPER_REGISTRY_ID);
    assert_eq!(
        entry.execution_policy.allowlist_ref_id,
        FIXTURE_HELPER_ALLOWLIST_REF_ID
    );
    assert_eq!(
        entry.binary_allowlist.entries[0].sha256_hash,
        sha256_file_ref(&public_helper_binary_path("kaifuu-fixture-helper")).unwrap()
    );

    let invalid_cases = [
        (
            "missing-capability",
            SEMANTIC_HELPER_REGISTRY_MISSING_CAPABILITY,
            "capabilities",
        ),
        (
            "bad-schema-id",
            SEMANTIC_HELPER_REGISTRY_UNSUPPORTED_SCHEMA_ID,
            "inputSchemaId",
        ),
        (
            "bad-schema-id",
            SEMANTIC_HELPER_REGISTRY_INCOMPATIBLE_OUTPUT_SCHEMA,
            "outputSchemaId",
        ),
        (
            "unsupported-redaction-class",
            SEMANTIC_HELPER_REGISTRY_INVALID_REDACTION_CLASS,
            "redactionClass",
        ),
    ];

    for (fixture, expected_code, expected_field) in invalid_cases {
        let validation =
            validate_helper_registry_entry_value(&public_helper_registry_fixture_value(fixture))
                .redacted_for_report();

        assert_eq!(validation.status, OperationStatus::Failed);
        assert!(
            validation.diagnostics.iter().any(|diagnostic| {
                diagnostic.code == expected_code && diagnostic.field == expected_field
            }),
            "missing {expected_code} for {fixture}: {:#?}",
            validation.diagnostics
        );
    }
}

#[test]
fn helper_registry_rejects_arbitrary_command_configuration_fields() {
    let mut value = public_helper_registry_fixture_value("valid-helper");
    value["command"] = serde_json::json!("sh -c helper");
    value["executionPolicy"]["args"] = serde_json::json!(["--dump"]);
    value["binaryAllowlist"]["entries"][0]["env"] =
        serde_json::json!({"SECRET_PATH": "/home/dev/private-game"});

    let validation = validate_helper_registry_entry_value(&value).redacted_for_report();

    assert_eq!(validation.status, OperationStatus::Failed);
    for field in [
        "command",
        "executionPolicy.args",
        "binaryAllowlist.entries.0.env",
    ] {
        assert!(
            validation.diagnostics.iter().any(|diagnostic| {
                diagnostic.code == SEMANTIC_HELPER_REGISTRY_FORBIDDEN_EXECUTION_FIELD
                    && diagnostic.field == field
            }),
            "missing forbidden command diagnostic for {field}: {:#?}",
            validation.diagnostics
        );
    }
    let serialized = serde_json::to_string(&validation).unwrap();
    assert!(!serialized.contains("/home/dev/private-game"));
}

#[test]
fn helper_binary_allowlist_hash_gate_blocks_before_launch() {
    let valid_value = public_helper_registry_fixture_value("valid-helper");
    let valid_entry: HelperRegistryEntry = serde_json::from_value(valid_value).unwrap();
    let allowed_binary = public_helper_binary_path("kaifuu-fixture-helper");
    let mismatch_binary = public_helper_binary_path("kaifuu-fixture-helper-mismatch");

    let allowed_staging = tempfile::tempdir().unwrap();
    let allowed_outcome = valid_entry.stage_and_validate_binary_launch(
        HelperBinaryLaunchValidationRequest {
            helper_id: FIXTURE_HELPER_REGISTRY_ID,
            allowlist_entry_id: FIXTURE_HELPER_ALLOWLIST_REF_ID,
            executable_path: &allowed_binary,
            platform: "fixture-any",
            helper_version: "0.1.0",
            required_capabilities: &[HelperCapability::FixtureInvocation],
        },
        allowed_staging.path(),
    );
    let allowed = allowed_outcome.validation;
    assert_eq!(allowed.status, OperationStatus::Passed, "{allowed:#?}");
    assert_eq!(
        allowed.observed_hash.as_deref(),
        Some("sha256:c1ac7473395cf2fbb823d33c63b5b4810352e3d2c255833498ba4fc4efb29f7c")
    );
    // The passed launch bound the validated bytes to a trusted staged copy,
    // distinct from the mutable source path.
    let staged = allowed_outcome
        .staged
        .as_ref()
        .expect("passed launch binds a staged execution reference");
    assert_ne!(staged.staged_path(), allowed_binary.as_path());
    assert_eq!(
        staged.staged_hash(),
        "sha256:c1ac7473395cf2fbb823d33c63b5b4810352e3d2c255833498ba4fc4efb29f7c"
    );

    let cases = [
        (
            "missing binary",
            valid_entry.clone(),
            public_helper_binary_path("missing-kaifuu-fixture-helper"),
            "fixture-any",
            "0.1.0",
            &[HelperCapability::FixtureInvocation][..],
            SEMANTIC_HELPER_ALLOWLIST_MISSING_BINARY,
        ),
        (
            "hash mismatch",
            valid_entry.clone(),
            mismatch_binary,
            "fixture-any",
            "0.1.0",
            &[HelperCapability::FixtureInvocation][..],
            SEMANTIC_HELPER_ALLOWLIST_HASH_MISMATCH,
        ),
        (
            "wrong platform",
            serde_json::from_value(public_helper_registry_fixture_value(
                "allowlist-wrong-platform",
            ))
            .unwrap(),
            allowed_binary.clone(),
            "fixture-any",
            "0.1.0",
            &[HelperCapability::FixtureInvocation][..],
            SEMANTIC_HELPER_ALLOWLIST_WRONG_PLATFORM,
        ),
        (
            "stale version",
            serde_json::from_value(public_helper_registry_fixture_value(
                "allowlist-stale-version",
            ))
            .unwrap(),
            allowed_binary.clone(),
            "fixture-any",
            "0.1.0",
            &[HelperCapability::FixtureInvocation][..],
            SEMANTIC_HELPER_ALLOWLIST_STALE_VERSION,
        ),
        (
            "undeclared capability",
            serde_json::from_value(public_helper_registry_fixture_value(
                "allowlist-missing-declared-capability",
            ))
            .unwrap(),
            allowed_binary.clone(),
            "fixture-any",
            "0.1.0",
            &[HelperCapability::KeyDiscovery][..],
            SEMANTIC_HELPER_ALLOWLIST_UNDECLARED_CAPABILITY,
        ),
    ];

    for (
        name,
        entry,
        executable_path,
        platform,
        helper_version,
        required_capabilities,
        expected_code,
    ) in cases
    {
        let case_staging = tempfile::tempdir().unwrap();
        let report = entry
            .stage_and_validate_binary_launch(
                HelperBinaryLaunchValidationRequest {
                    helper_id: FIXTURE_HELPER_REGISTRY_ID,
                    allowlist_entry_id: FIXTURE_HELPER_ALLOWLIST_REF_ID,
                    executable_path: &executable_path,
                    platform,
                    helper_version,
                    required_capabilities,
                },
                case_staging.path(),
            )
            .validation
            .redacted_for_report();
        assert_eq!(
            report.status,
            OperationStatus::Failed,
            "{name}: {report:#?}"
        );
        if name == "hash mismatch" {
            let observed_hash = report
                .observed_hash
                .as_deref()
                .expect("hash mismatch should report the observed helper binary hash");
            assert!(is_sha256_ref(observed_hash), "{name}: {report:#?}");
            assert!(
                report.diagnostics.iter().any(|diagnostic| {
                    diagnostic.code == expected_code
                        && diagnostic.observed_hash.as_deref() == Some(observed_hash)
                }),
                "{name}: diagnostic did not preserve observed hash: {:#?}",
                report.diagnostics
            );
        }
        assert!(
            report.diagnostics.iter().any(|diagnostic| {
                diagnostic.code == expected_code
                    && diagnostic.helper_id == FIXTURE_HELPER_REGISTRY_ID
                    && diagnostic.allowlist_entry_id == FIXTURE_HELPER_ALLOWLIST_REF_ID
                    && diagnostic.platform == platform
                    && !diagnostic.remediation_code.is_empty()
            }),
            "{name}: missing {expected_code}: {:#?}",
            report.diagnostics
        );
    }
}

#[test]
fn helper_binary_allowlist_diagnostic_observed_hash_redaction_keeps_only_canonical_hashes() {
    for unsafe_hash in [
        "sha256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        "00112233445566778899aabbccddeeff",
        "/home/dev/game/private-helper",
        "C:\\Games\\SecretRoute\\helper.exe",
    ] {
        let diagnostic = HelperBinaryLaunchDiagnostic {
            helper_id: FIXTURE_HELPER_REGISTRY_ID.to_string(),
            allowlist_entry_id: FIXTURE_HELPER_ALLOWLIST_REF_ID.to_string(),
            code: SEMANTIC_HELPER_ALLOWLIST_HASH_MISMATCH.to_string(),
            field: "sha256Hash".to_string(),
            observed_hash: Some(unsafe_hash.to_string()),
            platform: "fixture-any".to_string(),
            remediation_code: "reinstall_helper_binary".to_string(),
            message: "helper binary hash does not match the allowlist entry".to_string(),
        }
        .redacted_for_report();

        assert_eq!(
            diagnostic.observed_hash.as_deref(),
            Some("[REDACTED:kaifuu.secret_redacted]"),
            "{unsafe_hash} should be redacted"
        );
    }
}

#[test]
fn fixture_helper_is_discovered_and_invoked_through_registry_boundary() {
    let registry = fixture_helper_registry().unwrap();
    let helpers = registry.entries_for_capability(HelperCapability::FixtureInvocation);
    assert_eq!(helpers.len(), 1);
    assert_eq!(helpers[0].helper_id, FIXTURE_HELPER_REGISTRY_ID);
    assert!(registry.get(FIXTURE_HELPER_REGISTRY_ID).is_some());

    let input = serde_json::json!({"fixture": true});
    let output = registry.invoke(fixture_helper_invocation(&input)).unwrap();

    assert_eq!(
        validate_helper_result_value(&output).status,
        OperationStatus::Passed
    );
    assert_eq!(output["helper"]["helperId"], FIXTURE_HELPER_REGISTRY_ID);
    assert_eq!(output["diagnostic"]["code"], "success");
}

#[test]
fn fixture_helper_invocation_requires_registered_version_and_allowlist_ref() {
    let registry = fixture_helper_registry().unwrap();
    let input = serde_json::json!({"fixture": true});

    let stale_version = registry
        .invoke(HelperRegistryInvocationRequest {
            helper_id: FIXTURE_HELPER_REGISTRY_ID,
            helper_version: "9.9.9",
            allowlist_entry_id: FIXTURE_HELPER_ALLOWLIST_REF_ID,
            capability: HelperCapability::FixtureInvocation,
            input: &input,
        })
        .unwrap_err()
        .to_string();
    assert!(stale_version.contains(SEMANTIC_HELPER_ALLOWLIST_STALE_VERSION));

    let wrong_allowlist = registry
        .invoke(HelperRegistryInvocationRequest {
            helper_id: FIXTURE_HELPER_REGISTRY_ID,
            helper_version: "0.1.0",
            allowlist_entry_id: "unknown-helper-allowlist",
            capability: HelperCapability::FixtureInvocation,
            input: &input,
        })
        .unwrap_err()
        .to_string();
    assert!(wrong_allowlist.contains(SEMANTIC_HELPER_ALLOWLIST_MISSING_ENTRY));
}

#[test]
fn helper_key_ref_request_passes_refs_without_serializing_material() {
    let registry = fixture_helper_registry().unwrap();
    let request = public_helper_request_fixture_value("key-ref-request");

    let output = registry
        .invoke(fixture_helper_invocation(&request))
        .unwrap();

    assert_eq!(output["diagnostic"]["code"], "success");
    assert_eq!(
        output["secretRefs"][0]["secretRef"],
        "local-secret:fixture/siglus/manual-secondary-key"
    );
    let serialized_request = serde_json::to_string(&request).unwrap();
    let serialized_output = serde_json::to_string(&output).unwrap();
    for forbidden in [
        "rawKey",
        "keyMaterial",
        "00112233445566778899aabbccddeeff",
        "decrypted script",
        "/home/dev",
    ] {
        assert!(!serialized_request.contains(forbidden));
        assert!(!serialized_output.contains(forbidden));
    }
}
