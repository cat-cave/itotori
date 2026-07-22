#[test]
fn helper_key_ref_request_diagnostics_distinguish_boundary_failures() {
    let registry = fixture_helper_registry().unwrap();
    let mut missing = public_helper_request_fixture_value("key-ref-request");
    missing["keyRefs"] = serde_json::json!([]);
    let output = registry
        .invoke(fixture_helper_invocation(&missing))
        .unwrap();
    assert_eq!(output["diagnostic"]["code"], "missing_key");
    assert_eq!(
        output["diagnostic"]["message"],
        SEMANTIC_MISSING_KEY_MATERIAL
    );

    let mut wrong_profile = public_helper_request_fixture_value("key-ref-request");
    wrong_profile["keyRefs"][0]["engineProfileId"] =
        serde_json::json!("019ed000-0000-7000-8000-profile99999");
    let output = registry
        .invoke(fixture_helper_invocation(&wrong_profile))
        .unwrap();
    assert_eq!(output["diagnostic"]["code"], "validation_failed");
    assert_eq!(
        output["diagnostic"]["message"],
        SEMANTIC_KEY_IMPORT_WRONG_ENGINE_PROFILE
    );

    let mut hash_mismatch = public_helper_request_fixture_value("key-ref-request");
    hash_mismatch["keyRefs"][0]["sourceHash"] = serde_json::json!(
        "sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff"
    );
    let output = registry
        .invoke(fixture_helper_invocation(&hash_mismatch))
        .unwrap();
    assert_eq!(output["diagnostic"]["code"], "validation_failed");
    assert_eq!(
        output["diagnostic"]["message"],
        SEMANTIC_KEY_IMPORT_HASH_MISMATCH
    );

    let mut forbidden = public_helper_request_fixture_value("key-ref-request");
    forbidden["keyRefs"][0]["rawKey"] = serde_json::json!("00112233445566778899aabbccddeeff");
    let output = registry
        .invoke(fixture_helper_invocation(&forbidden))
        .unwrap();
    assert_eq!(output["diagnostic"]["code"], "redaction_failure");
    assert_eq!(
        output["diagnostic"]["message"],
        SEMANTIC_FORBIDDEN_PUBLIC_SERIALIZATION
    );
}

#[test]
fn siglus_secondary_key_helper_boundary_fixture_matches_redacted_output() {
    let registry = fixture_helper_registry().unwrap();
    let request = public_helper_request_fixture_value("siglus-secondary-key-request");
    let output = registry
        .invoke(fixture_helper_key_validation(&request))
        .unwrap();
    let expected = bridge_fixture_value(
        "fixtures/public/kaifuu-helper-results/siglus-secondary-key-helper-boundary-success.json",
    );

    assert_eq!(output, expected);
    assert_eq!(
        validate_helper_result_value(&output).status,
        OperationStatus::Passed
    );
    assert_eq!(output["diagnostic"]["code"], "success");
    assert_eq!(output["helper"]["helperId"], FIXTURE_HELPER_REGISTRY_ID);
    assert_eq!(
        output["secretRefs"][0]["requirementId"],
        "siglus-secondary-key"
    );
    assert_eq!(
        output["secretRefs"][0]["secretRef"],
        "local-secret:fixture/siglus/secondary-key-ref"
    );
    assert_eq!(
        output["redaction"]["redactedLogHash"],
        "sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd"
    );

    let serialized_request = serde_json::to_string(&request).unwrap();
    let serialized_output = serde_json::to_string(&output).unwrap();
    for forbidden in [
        "rawKey",
        "keyMaterial",
        "00112233445566778899aabbccddeeff",
        "fixture-only-siglus-secondary-key-v1",
        "decrypted script",
        "/home/",
        "C:\\",
    ] {
        assert!(!serialized_request.contains(forbidden));
        assert!(!serialized_output.contains(forbidden));
    }
}

#[test]
fn siglus_secondary_key_helper_boundary_requires_redacted_output_for_success_key_refs() {
    let registry = fixture_helper_registry().unwrap();
    let mut request = public_helper_request_fixture_value("siglus-secondary-key-request");
    let request_object = request.as_object_mut().unwrap();
    request_object.remove("expectedRedactedLogHash");
    request_object.remove("requiredKeyRefs");

    let output = registry
        .invoke(fixture_helper_key_validation(&request))
        .unwrap();

    assert_eq!(output["diagnostic"]["code"], "redaction_failure");
    assert_eq!(
        output["diagnostic"]["message"],
        SEMANTIC_HELPER_REQUEST_MISSING_REDACTED_OUTPUT_EXPECTATION
    );
    assert_eq!(output["redaction"]["status"], "failed");
    assert_eq!(output["secretRefs"], serde_json::json!([]));
    assert_eq!(
        validate_helper_result_value(&output).status,
        OperationStatus::Passed
    );

    let serialized = serde_json::to_string(&output).unwrap();
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
fn siglus_secondary_key_helper_boundary_diagnostics_cover_required_failures() {
    let registry = fixture_helper_registry().unwrap();
    let cases = [
        (
            "siglus-secondary-key-missing-key-ref",
            "missing_key",
            SEMANTIC_MISSING_KEY_MATERIAL,
        ),
        (
            "siglus-secondary-key-wrong-profile",
            "validation_failed",
            SEMANTIC_KEY_IMPORT_WRONG_ENGINE_PROFILE,
        ),
        (
            "siglus-secondary-key-wrong-purpose",
            "validation_failed",
            SEMANTIC_KEY_IMPORT_WRONG_KEY_PURPOSE,
        ),
        (
            "siglus-secondary-key-helper-rejection",
            "validation_failed",
            SEMANTIC_HELPER_REQUEST_WRONG_HELPER,
        ),
        (
            "siglus-secondary-key-redacted-output-mismatch",
            "redaction_failure",
            SEMANTIC_HELPER_REQUEST_REDACTED_OUTPUT_MISMATCH,
        ),
        (
            "siglus-secondary-key-missing-redacted-output-expectation",
            "redaction_failure",
            SEMANTIC_HELPER_REQUEST_MISSING_REDACTED_OUTPUT_EXPECTATION,
        ),
    ];

    for (fixture, expected_code, expected_message) in cases {
        let request = public_helper_request_fixture_value(fixture);
        let output = registry
            .invoke(fixture_helper_key_validation(&request))
            .unwrap();
        assert_eq!(
            output["diagnostic"]["code"], expected_code,
            "{fixture}: {output:#?}"
        );
        assert_eq!(
            output["diagnostic"]["message"], expected_message,
            "{fixture}: {output:#?}"
        );
        assert_eq!(
            validate_helper_result_value(&output).status,
            OperationStatus::Passed,
            "{fixture}: {output:#?}"
        );

        let serialized = serde_json::to_string(&output).unwrap();
        for forbidden in [
            "rawKey",
            "keyMaterial",
            "00112233445566778899aabbccddeeff",
            "decrypted script",
            "/home/",
            "C:\\",
        ] {
            assert!(
                !serialized.contains(forbidden),
                "{fixture} leaked {forbidden}"
            );
        }
    }
}

#[test]
fn siglus_known_key_parser_boundary_smoke_reports_slots_and_redacted_diagnostics() {
    let scene_path =
        repo_fixture_path("fixtures/public/kaifuu-encrypted-matrix/raw/siglus/Scene.pck");
    let gameexe_path =
        repo_fixture_path("fixtures/public/kaifuu-encrypted-matrix/raw/siglus/Gameexe.dat");
    let key_request = public_helper_request_fixture_value("siglus-secondary-key-request");

    let success = run_siglus_known_key_parser_boundary_smoke(SiglusParserBoundarySmokeRequest {
        scene_path: &scene_path,
        gameexe_path: &gameexe_path,
        key_request: Some(&key_request),
        variant: SiglusParserBoundarySmokeVariant::ParserBoundarySuccess,
    })
    .unwrap();
    assert_eq!(success.status, OperationStatus::Passed);
    assert_eq!(
        success.outcome,
        SiglusParserBoundaryOutcome::ParserBoundarySuccess
    );
    assert_eq!(success.profile_id, "019ed000-0000-7000-8000-000000091001");
    assert!(!success.patch_write_attempted);
    assert!(
        success
            .support_boundary
            .contains("does not claim production Siglus")
    );
    assert!(success.sources.iter().any(|source| {
        source.asset_id == "siglus-scene-pck"
            && source.source_hash.as_str()
                == "sha256:9afaac8af2dd96468e97e069cb678ada48a77d9726e8ebebf1ca75e76b65d465"
    }));
    assert!(success.text_slots.iter().any(|slot| {
        slot.text_slot_id == "siglus.synthetic.scene.text.001"
            && slot.byte_span.start_byte == 17
            && slot.byte_span.end_byte == 52
            && slot.source_hash.as_str()
                == "sha256:9afaac8af2dd96468e97e069cb678ada48a77d9726e8ebebf1ca75e76b65d465"
    }));
    assert_eq!(success.key_refs.len(), 1);
    assert_eq!(
        success.key_refs[0].secret_ref.as_str(),
        "local-secret:fixture/siglus/secondary-key-ref"
    );

    let cases = [
        (
            SiglusParserBoundarySmokeVariant::HelperRequired,
            SiglusParserBoundaryOutcome::HelperRequired,
            "helper_required",
            SEMANTIC_HELPER_REQUIRED,
        ),
        (
            SiglusParserBoundarySmokeVariant::MissingKey,
            SiglusParserBoundaryOutcome::MissingKey,
            "missing_key",
            SEMANTIC_MISSING_KEY_MATERIAL,
        ),
        (
            SiglusParserBoundarySmokeVariant::UnsupportedOpcode,
            SiglusParserBoundaryOutcome::UnsupportedOpcode,
            "unsupported_opcode",
            SEMANTIC_SIGLUS_UNSUPPORTED_OPCODE,
        ),
        (
            SiglusParserBoundarySmokeVariant::OutOfProfile,
            SiglusParserBoundaryOutcome::OutOfProfile,
            "out_of_profile",
            SEMANTIC_KEY_IMPORT_WRONG_ENGINE_PROFILE,
        ),
    ];

    for (variant, outcome, code, semantic_code) in cases {
        let report = run_siglus_known_key_parser_boundary_smoke(SiglusParserBoundarySmokeRequest {
            scene_path: &scene_path,
            gameexe_path: &gameexe_path,
            key_request: Some(&key_request),
            variant,
        })
        .unwrap();
        assert_eq!(report.status, OperationStatus::Failed, "{variant:?}");
        assert_eq!(report.outcome, outcome, "{variant:?}");
        assert!(!report.patch_write_attempted, "{variant:?}");
        assert!(report.text_slots.is_empty(), "{variant:?}");
        assert!(report.diagnostics.iter().any(|diagnostic| {
            diagnostic.code == code && diagnostic.semantic_code.as_deref() == Some(semantic_code)
        }));
        if outcome == SiglusParserBoundaryOutcome::UnsupportedOpcode {
            assert!(report.diagnostics.iter().any(|diagnostic| {
                diagnostic.unsupported_opcode.as_deref() == Some("SIGLUS_SYNTH_UNSUPPORTED_7f")
                    && diagnostic
                        .byte_span
                        .as_ref()
                        .is_some_and(|span| span.start_byte == 48 && span.end_byte == 49)
            }));
        }
    }

    let serialized = success.stable_json().unwrap();
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
fn helper_key_ref_request_rejects_requirement_id_only_refs() {
    let registry = fixture_helper_registry().unwrap();
    let mut request = public_helper_request_fixture_value("key-ref-request");
    request["keyRefs"][0] = serde_json::json!({
        "requirementId": "siglus-secondary-key"
    });

    let diagnostics = validate_helper_key_ref_request(&request);
    assert!(
        diagnostics.iter().any(|diagnostic| {
            diagnostic.code == SEMANTIC_MISSING_KEY_MATERIAL
                && diagnostic.field == "keyRefs.0.secretRef"
        }),
        "requirement-id-only keyRef should not satisfy requiredKeyRefs: {diagnostics:#?}"
    );

    let output = registry
        .invoke(fixture_helper_invocation(&request))
        .unwrap();
    assert_eq!(output["diagnostic"]["code"], "missing_key");
    assert_eq!(
        output["diagnostic"]["message"],
        SEMANTIC_MISSING_KEY_MATERIAL
    );
}

#[test]
fn helper_key_ref_request_rejects_required_ref_missing_engine_profile() {
    let registry = fixture_helper_registry().unwrap();
    let mut request = public_helper_request_fixture_value("key-ref-request");
    request["keyRefs"][0]
        .as_object_mut()
        .unwrap()
        .remove("engineProfileId");

    let diagnostics = validate_helper_key_ref_request(&request);
    assert!(
        diagnostics.iter().any(|diagnostic| {
            diagnostic.code == SEMANTIC_KEY_IMPORT_WRONG_ENGINE_PROFILE
                && diagnostic.field == "keyRefs.0.engineProfileId"
        }),
        "required keyRef missing engineProfileId should fail binding: {diagnostics:#?}"
    );

    let output = registry
        .invoke(fixture_helper_invocation(&request))
        .unwrap();
    assert_eq!(output["diagnostic"]["code"], "validation_failed");
    assert_eq!(
        output["diagnostic"]["message"],
        SEMANTIC_KEY_IMPORT_WRONG_ENGINE_PROFILE
    );
}

#[test]
fn helper_key_ref_request_rejects_required_ref_missing_source_hash() {
    let registry = fixture_helper_registry().unwrap();
    let mut request = public_helper_request_fixture_value("key-ref-request");
    request["keyRefs"][0]
        .as_object_mut()
        .unwrap()
        .remove("sourceHash");

    let diagnostics = validate_helper_key_ref_request(&request);
    assert!(
        diagnostics.iter().any(|diagnostic| {
            diagnostic.code == SEMANTIC_KEY_IMPORT_HASH_MISMATCH
                && diagnostic.field == "keyRefs.0.sourceHash"
        }),
        "required keyRef missing sourceHash should fail binding: {diagnostics:#?}"
    );

    let output = registry
        .invoke(fixture_helper_invocation(&request))
        .unwrap();
    assert_eq!(output["diagnostic"]["code"], "validation_failed");
    assert_eq!(
        output["diagnostic"]["message"],
        SEMANTIC_KEY_IMPORT_HASH_MISMATCH
    );
}

#[test]
fn fixture_helper_registry_rejects_missing_capability_and_bad_output() {
    struct BadOutputAdapter;

    impl HelperExecutableAdapter for BadOutputAdapter {
        fn helper_id(&self) -> &'static str {
            FIXTURE_HELPER_REGISTRY_ID
        }

        fn invoke(
            &self,
            _entry: &HelperRegistryEntry,
            _request: HelperRegistryInvocationRequest<'_>,
        ) -> KaifuuResult<Value> {
            Ok(serde_json::json!({"not": "a helper result"}))
        }
    }

    let registry = fixture_helper_registry().unwrap();
    let input = serde_json::json!({"fixture": true});
    let missing_capability = registry.invoke(HelperRegistryInvocationRequest {
        helper_id: FIXTURE_HELPER_REGISTRY_ID,
        helper_version: "0.1.0",
        allowlist_entry_id: FIXTURE_HELPER_ALLOWLIST_REF_ID,
        capability: HelperCapability::KeyDiscovery,
        input: &input,
    });
    assert!(missing_capability.is_err());
    assert!(
        missing_capability
            .unwrap_err()
            .to_string()
            .contains(SEMANTIC_HELPER_REGISTRY_MISSING_CAPABILITY)
    );

    let mut bad_registry = HelperRegistry::new();
    bad_registry
        .register_entry(FixtureHelperStubAdapter::registry_entry())
        .unwrap();
    bad_registry.register_executable(BadOutputAdapter);

    let error = bad_registry
        .invoke(fixture_helper_invocation(&input))
        .unwrap_err()
        .to_string();
    assert!(error.contains(SEMANTIC_HELPER_REGISTRY_INCOMPATIBLE_OUTPUT_SCHEMA));
}
