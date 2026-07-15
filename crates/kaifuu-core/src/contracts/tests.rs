use serde_json::{Value, json};

use super::validate_runtime_evidence_report_v02;

fn runtime_evidence_with_observation_hook() -> Value {
    json!({
        "schemaVersion": "0.2.0",
        "runtimeReportId": "019ed003-0000-7000-8000-000000000901",
        "adapterName": "utsushi-contract-test",
        "adapterVersion": "0.2.0",
        "fidelityTier": "trace_only",
        "evidenceTier": "E1",
        "status": "passed",
        "createdAt": "2026-06-17T00:00:00.000Z",
        "traceEvents": [],
        "branchEvents": [],
        "observationHookEvents": [
            {
                "schemaVersion": "0.1.0-alpha",
                "eventId": "obs-0001",
                "observedAt": "2026-06-17T00:00:00.000Z",
                "eventKind": "text",
                "runtimeTargetId": "fixture:runtime-target",
                "adapterId": {
                    "name": "utsushi-contract-test",
                    "version": "0.2.0"
                },
                "evidenceTier": "E1",
                "environment": {
                    "runtime": "browser"
                },
                "bridgeRefs": [
                    {
                        "bridgeUnitId": "019ed001-0000-7000-8000-000000000201",
                        "sourceUnitKey": "script/prologue#line-001"
                    }
                ],
                "redaction": {
                    "status": "not_required"
                },
                "payload": {
                    "payloadKind": "text",
                    "text": "Bonjour, {player}."
                }
            }
        ],
        "captures": [],
        "recordings": [],
        "approximations": [
            {
                "approximationId": "019ed003-0000-7000-8000-000000000902",
                "approximationTier": "deterministic_fixture",
                "scope": "fixture runtime hook",
                "description": "Observation hook evidence comes from a deterministic fixture route.",
                "affectedBridgeUnitRefs": [
                    {
                        "bridgeUnitId": "019ed001-0000-7000-8000-000000000201",
                        "sourceUnitKey": "script/prologue#line-001"
                    }
                ],
                "evidenceTierCeiling": "E1"
            }
        ],
        "validationFindings": [],
        "limitations": [],
        "runtimeCapabilities": {
            "contractVersion": "0.2.0",
            "capabilityClass": "instrumented_runtime",
            "fidelityTierCeiling": "replay_review",
            "evidenceTierCeiling": "E3",
            "features": [
                {
                    "feature": "instrumentation_hooks",
                    "status": "partial",
                    "evidenceTierCeiling": "E1",
                    "description": "Instrumentation covers the deterministic fixture route.",
                    "limitations": ["Only the fixture route is instrumented."]
                }
            ],
            "limitations": ["Not a reference runtime."]
        }
    })
}

#[test]
fn runtime_evidence_accepts_observation_hook_events_with_partial_capability() {
    let report = runtime_evidence_with_observation_hook();

    validate_runtime_evidence_report_v02(&report).unwrap();
}

#[test]
fn runtime_evidence_accepts_observation_hook_events_with_supported_capability() {
    let mut report = runtime_evidence_with_observation_hook();
    report["runtimeCapabilities"]["features"][0]["status"] = json!("supported");

    validate_runtime_evidence_report_v02(&report).unwrap();
}

#[test]
fn runtime_evidence_rejects_observation_hook_events_without_runtime_capabilities() {
    let mut report = runtime_evidence_with_observation_hook();
    report
        .as_object_mut()
        .expect("runtime evidence fixture is an object")
        .remove("runtimeCapabilities");

    let error = validate_runtime_evidence_report_v02(&report)
        .unwrap_err()
        .to_string();
    assert!(
        error.contains("runtimeCapabilities is required when observationHookEvents are present")
    );
}

#[test]
fn runtime_evidence_rejects_observation_hook_events_with_unsupported_capability() {
    let mut report = runtime_evidence_with_observation_hook();
    report["runtimeCapabilities"]["features"][0]["status"] = json!("unsupported");
    report["runtimeCapabilities"]["features"][0]
        .as_object_mut()
        .expect("instrumentation hooks feature is an object")
        .remove("evidenceTierCeiling");

    let error = validate_runtime_evidence_report_v02(&report)
        .unwrap_err()
        .to_string();
    assert!(error.contains("instrumentation_hooks capability"));
}

#[test]
fn runtime_evidence_rejects_invalid_observation_observed_at() {
    let mut report = runtime_evidence_with_observation_hook();
    report["observationHookEvents"][0]["observedAt"] = json!("2026-02-30T00:00:00.000Z");

    let error = validate_runtime_evidence_report_v02(&report)
        .unwrap_err()
        .to_string();
    assert!(error.contains("observationHookEvents[0].observedAt"));
}

#[test]
fn runtime_evidence_rejects_blank_observation_redaction_rules() {
    let mut report = runtime_evidence_with_observation_hook();
    report["observationHookEvents"][0]["redaction"] = json!({
        "status": "redacted",
        "rules": [" "],
        "redactedFields": ["payload.text"]
    });

    let error = validate_runtime_evidence_report_v02(&report)
        .unwrap_err()
        .to_string();
    assert!(error.contains("observationHookEvents[0].redaction.rules[0]"));
}

#[test]
fn runtime_evidence_rejects_observation_payload_kind_mismatch() {
    let mut report = runtime_evidence_with_observation_hook();
    report["observationHookEvents"][0]["eventKind"] = json!("error");

    let error = validate_runtime_evidence_report_v02(&report)
        .unwrap_err()
        .to_string();
    assert!(error.contains("eventKind must match"));
}

use super::validate_patch_result_v02;

fn passed_patch_result_fixture() -> Value {
    // Rollup of the two touched assets below.
    json!({
        "schemaVersion": "0.2.0",
        "patchResultId": "019ed001-0000-7000-8000-000000000950",
        "patchExportId": "019ed001-0000-7000-8000-000000000901",
        "adapterId": "kaifuu-reallive",
        "status": "passed",
        "outputHash": "sha256:da95500381246b4466b73a2dd6fc2610ad5ecea58719c2e9d28c4805ac24c83d",
        "touchedAssets": [
            {
                "assetId": "019ed001-0000-7000-8000-000000000810",
                "outputHash": "sha256:fa01799c693dbf37732740572dde0106c2d67bed57a5955528687642896968e1",
                "byteSize": 64
            },
            {
                "assetId": "019ed001-0000-7000-8000-000000000811",
                "outputHash": "sha256:8566707ead9fabf49905b018e40ab4772e166d6f0c6e126ebdb5e6af7a7258ca",
                "byteSize": 72
            }
        ],
        "failures": []
    })
}

#[test]
fn patch_result_v02_accepts_passed_fixture_with_matching_rollup() {
    validate_patch_result_v02(&passed_patch_result_fixture()).unwrap();
}

#[test]
fn patch_result_v02_rejects_passed_without_output_hash() {
    let mut fixture = passed_patch_result_fixture();
    fixture.as_object_mut().unwrap().remove("outputHash");
    let error = validate_patch_result_v02(&fixture).unwrap_err().to_string();
    assert!(
        error.contains("kaifuu.patch_result.passed_requires_output_hash"),
        "{error}"
    );
}

#[test]
fn patch_result_v02_rejects_passed_without_touched_assets() {
    let mut fixture = passed_patch_result_fixture();
    fixture.as_object_mut().unwrap().remove("touchedAssets");
    let error = validate_patch_result_v02(&fixture).unwrap_err().to_string();
    assert!(
        error.contains("kaifuu.patch_result.passed_requires_touched_assets"),
        "{error}"
    );
}

#[test]
fn patch_result_v02_rejects_output_hash_drift() {
    let mut fixture = passed_patch_result_fixture();
    fixture["outputHash"] =
        json!("sha256:0000000000000000000000000000000000000000000000000000000000000000");
    let error = validate_patch_result_v02(&fixture).unwrap_err().to_string();
    assert!(
        error.contains("kaifuu.patch_result.output_hash_drift"),
        "{error}"
    );
}

#[test]
fn patch_result_v02_rejects_failed_without_failure_categories() {
    let fixture = json!({
        "schemaVersion": "0.2.0",
        "patchResultId": "019ed001-0000-7000-8000-000000000951",
        "patchExportId": "019ed001-0000-7000-8000-000000000901",
        "adapterId": "kaifuu-reallive",
        "status": "failed",
        "failures": [
            {
                "failureId": "019ed001-0000-7000-8000-000000000a01",
                "category": "patch_write_failed",
                "diagnosticCode": "kaifuu.reallive.patchback_offset_overflow",
                "cause": "offset overflow",
                "assetId": "019ed001-0000-7000-8000-000000000810",
                "bridgeUnitId": "019ed001-0000-7000-8000-000000000201",
                "adapterId": "kaifuu-reallive",
                "command": "patch.write_string_slot"
            }
        ]
    });
    let error = validate_patch_result_v02(&fixture).unwrap_err().to_string();
    assert!(
        error.contains("kaifuu.patch_result.missing_failure_category"),
        "{error}"
    );
}

#[test]
fn patch_result_v02_rejects_silent_partial_write_attempted_mismatch() {
    let fixture = json!({
        "schemaVersion": "0.2.0",
        "patchResultId": "019ed001-0000-7000-8000-000000000952",
        "patchExportId": "019ed001-0000-7000-8000-000000000901",
        "adapterId": "kaifuu-reallive",
        "status": "failed",
        "failures": [
            {
                "failureId": "019ed001-0000-7000-8000-000000000a02",
                "category": "patch_write_failed",
                "diagnosticCode": "kaifuu.reallive.patchback_offset_overflow",
                "cause": "offset overflow",
                "assetId": "019ed001-0000-7000-8000-000000000810",
                "bridgeUnitId": "019ed001-0000-7000-8000-000000000201",
                "adapterId": "kaifuu-reallive",
                "command": "patch.write_string_slot"
            }
        ],
        "failureCategories": ["patch_write_failed"],
        "partialWrite": {
            "attemptedAssetIds": [
                "019ed001-0000-7000-8000-000000000810",
                "019ed001-0000-7000-8000-000000000811"
            ],
            "writtenAssetIds": ["019ed001-0000-7000-8000-000000000810"],
            "skippedAssetIds": [],
            "disposition": "rolled_back",
            "rollbackDiagnosticCode": "kaifuu.reallive.rollback_complete"
        }
    });
    let error = validate_patch_result_v02(&fixture).unwrap_err().to_string();
    assert!(
        error.contains("kaifuu.patch_result.silent_partial_write"),
        "{error}"
    );
}

#[test]
fn patch_result_v02_rejects_rolled_back_without_rollback_diagnostic() {
    let fixture = json!({
        "schemaVersion": "0.2.0",
        "patchResultId": "019ed001-0000-7000-8000-000000000953",
        "patchExportId": "019ed001-0000-7000-8000-000000000901",
        "adapterId": "kaifuu-reallive",
        "status": "failed",
        "failures": [
            {
                "failureId": "019ed001-0000-7000-8000-000000000a03",
                "category": "patch_write_failed",
                "diagnosticCode": "kaifuu.reallive.patchback_offset_overflow",
                "cause": "offset overflow",
                "assetId": "019ed001-0000-7000-8000-000000000810",
                "bridgeUnitId": "019ed001-0000-7000-8000-000000000201",
                "adapterId": "kaifuu-reallive",
                "command": "patch.write_string_slot"
            }
        ],
        "failureCategories": ["patch_write_failed"],
        "partialWrite": {
            "attemptedAssetIds": ["019ed001-0000-7000-8000-000000000810"],
            "writtenAssetIds": [],
            "skippedAssetIds": ["019ed001-0000-7000-8000-000000000810"],
            "disposition": "rolled_back"
        }
    });
    let error = validate_patch_result_v02(&fixture).unwrap_err().to_string();
    assert!(
        error.contains("kaifuu.patch_result.rollback_diagnostic_required"),
        "{error}"
    );
}

#[test]
fn patch_result_v02_accepts_retained_partial_without_rollback_diagnostic() {
    let fixture = json!({
        "schemaVersion": "0.2.0",
        "patchResultId": "019ed001-0000-7000-8000-000000000954",
        "patchExportId": "019ed001-0000-7000-8000-000000000901",
        "adapterId": "kaifuu-reallive",
        "status": "failed",
        "failures": [
            {
                "failureId": "019ed001-0000-7000-8000-000000000a04",
                "category": "patch_write_failed",
                "diagnosticCode": "kaifuu.reallive.patchback_offset_overflow",
                "cause": "mid-write corruption could not be rolled back",
                "assetId": "019ed001-0000-7000-8000-000000000810",
                "bridgeUnitId": "019ed001-0000-7000-8000-000000000201",
                "adapterId": "kaifuu-reallive",
                "command": "patch.write_string_slot"
            }
        ],
        "failureCategories": ["patch_write_failed"],
        "partialWrite": {
            "attemptedAssetIds": ["019ed001-0000-7000-8000-000000000810"],
            "writtenAssetIds": ["019ed001-0000-7000-8000-000000000810"],
            "skippedAssetIds": [],
            "disposition": "retained_partial"
        }
    });
    validate_patch_result_v02(&fixture).unwrap();
}

#[test]
fn patch_result_v02_rejects_incompatible_source_non_source_failure_category() {
    let fixture = json!({
        "schemaVersion": "0.2.0",
        "patchResultId": "019ed001-0000-7000-8000-000000000955",
        "patchExportId": "019ed001-0000-7000-8000-000000000901",
        "adapterId": "kaifuu-reallive",
        "status": "incompatible_source",
        "failures": [
            {
                "failureId": "019ed001-0000-7000-8000-000000000a05",
                "category": "patch_write_failed",
                "diagnosticCode": "kaifuu.reallive.patchback_offset_overflow",
                "cause": "wrong category",
                "assetId": "019ed001-0000-7000-8000-000000000810",
                "bridgeUnitId": "019ed001-0000-7000-8000-000000000201",
                "adapterId": "kaifuu-reallive",
                "command": "patch.write_string_slot"
            }
        ],
        "failureCategories": ["patch_write_failed"],
        "sourceCompatibility": {
            "schemaVersion": "0.2.0",
            "patchExportId": "019ed001-0000-7000-8000-000000000901",
            "sourceBridgeId": "019ed001-0000-7000-8000-000000000001",
            "status": "incompatible",
            "expectedSourceBundleHash": "sha256:fd8dc24ee34b959fbd2beb9af53af65f5a376da5cb392bf4ef7246aff8804647",
            "actualSourceBundleHash": "sha256:530752517d6fe6af8505a362c5da79a034a16bb1c73b9c3b4c2e5bd5c2a2c060",
            "sourceBundleHashMatches": false,
            "compatibleUnits": [],
            "incompatibleUnits": [
                {
                    "entryId": "019ed001-0000-7000-8000-000000000910",
                    "bridgeUnitId": "019ed001-0000-7000-8000-000000000201",
                    "sourceUnitKey": "script/prologue#line-001",
                    "status": "incompatible",
                    "expectedSourceHash": "sha256:fa01799c693dbf37732740572dde0106c2d67bed57a5955528687642896968e1",
                    "actualSourceHash": "sha256:ee738430dc6b47e520cbf9de9a54130e50671aa69dfd4d05bc447a9cbb980ea3",
                    "reason": "source_hash_mismatch"
                }
            ]
        }
    });
    let error = validate_patch_result_v02(&fixture).unwrap_err().to_string();
    assert!(
        error.contains("kaifuu.patch_result.incompatible_source_category_required"),
        "{error}"
    );
}

#[test]
fn patch_result_v02_rejects_passed_with_failures() {
    let mut fixture = passed_patch_result_fixture();
    fixture["failures"] = json!([
        {
            "failureId": "019ed001-0000-7000-8000-000000000a06",
            "category": "patch_write_failed",
            "diagnosticCode": "kaifuu.reallive.patchback_offset_overflow",
            "cause": "spurious",
            "assetId": "019ed001-0000-7000-8000-000000000810",
            "bridgeUnitId": "019ed001-0000-7000-8000-000000000201",
            "adapterId": "kaifuu-reallive",
            "command": "patch.write_string_slot"
        }
    ]);
    let error = validate_patch_result_v02(&fixture).unwrap_err().to_string();
    assert!(
        error.contains("kaifuu.patch_result.passed_must_have_no_failures"),
        "{error}"
    );
}
