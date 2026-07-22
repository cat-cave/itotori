use super::*;

pub(super) fn runtime_report_json(artifact_uri: &str, variant: FixtureVariant) -> Value {
    let capture_artifact_uri = match variant {
        FixtureVariant::TopLevelCaptureUnmanifested => {
            "artifacts/utsushi/runtime/019ed003-0000-7000-8000-000010000001/screenshots/019ed003-0000-7000-8000-000040000999.png"
        }
        _ => artifact_uri,
    };
    let captures = match variant {
        FixtureVariant::StaticRead => json!([]),
        _ => json!([
            {
                "captureId": "019ed003-0000-7000-8000-000030000001",
                "bridgeUnitRef": {
                    "bridgeUnitId": "019ed000-0000-7000-8000-bridgeun0001",
                    "sourceUnitKey": "reference.capture.001"
                },
                "evidenceTier": "E2",
                "frame": 1,
                "width": 320,
                "height": 180,
                "nonZeroPixels": 57600,
                "artifactRef": artifact_ref_json(capture_artifact_uri)
            }
        ]),
    };
    let features_used = match variant {
        FixtureVariant::StaticRead => json!(["static_trace"]),
        _ => json!([
            "static_trace",
            "text_trace",
            "frame_capture",
            "instrumentation_hooks"
        ]),
    };
    let text = match variant {
        FixtureVariant::UnredactedLocalPath => "/tmp/private/reference-capture",
        _ => "Reference capture ready.",
    };
    let approximations = match variant {
        FixtureVariant::ReportSchemaInvalid => json!([]),
        _ => json!([
            {
                "approximationId": "019ed003-0000-7000-8000-000050000001",
                "approximationTier": "deterministic_fixture",
                "scope": "fixture runtime",
                "description": "Reference capture fixture documents deterministic layout-probe evidence without reference-runtime pixel comparison.",
                "affectedBridgeUnitRefs": [
                    {
                        "bridgeUnitId": "019ed000-0000-7000-8000-bridgeun0001",
                        "sourceUnitKey": "reference.capture.001"
                    }
                ],
                "evidenceTierCeiling": "E2"
            }
        ]),
    };
    let limitations = match variant {
        FixtureVariant::ReportLevelPrivatePath => json!(["Captured at /tmp/private/run"]),
        FixtureVariant::RootPrivatePath => json!(["Captured at /root/private/run"]),
        FixtureVariant::WindowsPrivatePath => json!(["Captured at C:\\Users\\private\\run"]),
        FixtureVariant::EmbeddedUncPrivatePath => {
            json!(["Captured at \\\\server\\share\\game"])
        }
        FixtureVariant::SrvPrivatePath => json!(["Captured at /srv/game"]),
        FixtureVariant::DataPrivatePath => json!(["Captured at /data/game"]),
        FixtureVariant::RunUserPrivatePath => json!(["Captured at /run/user/1000/game"]),
        _ => json!([]),
    };
    let runtime_report_id = match variant {
        FixtureVariant::NonUuidRuntimeReportId => "not-a-uuid-run",
        _ => "019ed003-0000-7000-8000-000010000001",
    };
    json!({
        "schemaVersion": "0.2.0",
        "runtimeReportId": runtime_report_id,
        "sourceLocale": "ja-JP",
        "adapterName": "utsushi-fixture",
        "adapterVersion": "0.0.0",
        "fidelityTier": "layout_probe",
        "evidenceTier": "E2",
        "controlledPlaybackSession": {
            "sessionId": "019ed003-0000-7000-8000-000060000001",
            "adapterName": "utsushi-fixture",
            "adapterVersion": "0.0.0",
            "capabilityClass": "launch_capture",
            "requestedOperation": "capture",
            "status": "passed",
            "fidelityTier": "layout_probe",
            "evidenceTier": "E2",
            "featuresUsed": features_used,
            "limitations": []
        },
        "status": "passed",
        "createdAt": "2026-06-17T00:00:00.000Z",
        "traceEvents": [],
        "observationHookEvents": [
            {
                "schemaVersion": "0.1.0-alpha",
                "eventId": "019ed003-0000-7000-8000-000070000001",
                "observedAt": "2026-06-17T00:00:00.000Z",
                "eventKind": "text",
                "runtimeTargetId": "fixture:reference-capture-public",
                "adapterId": {"name": "utsushi-fixture", "version": "0.0.0"},
                "evidenceTier": "E1",
                "environment": {"runtime": "fixture"},
                "sourceRevision": {
                    "sourceId": "reference-capture-public",
                    "revisionId": "fixture-source-v0.1"
                },
                "bridgeRefs": [
                    {
                        "bridgeUnitId": "019ed000-0000-7000-8000-bridgeun0001",
                        "sourceUnitKey": "reference.capture.001"
                    }
                ],
                "redaction": {"status": "not_required"},
                "payload": {
                    "payloadKind": "text",
                    "text": text
                }
            },
            {
                "schemaVersion": "0.1.0-alpha",
                "eventId": "019ed003-0000-7000-8000-000071000001",
                "observedAt": "2026-06-17T00:00:00.000Z",
                "eventKind": "frame",
                "runtimeTargetId": "fixture:reference-capture-public",
                "adapterId": {"name": "utsushi-fixture", "version": "0.0.0"},
                "evidenceTier": "E2",
                "environment": {"runtime": "fixture"},
                "sourceRevision": {
                    "sourceId": "reference-capture-public",
                    "revisionId": "fixture-source-v0.1"
                },
                "bridgeRefs": [
                    {
                        "bridgeUnitId": "019ed000-0000-7000-8000-bridgeun0001",
                        "sourceUnitKey": "reference.capture.001"
                    }
                ],
                "redaction": {"status": "not_required"},
                "payload": {
                    "payloadKind": "frame",
                    "frame": 1,
                    "width": 320,
                    "height": 180,
                    "artifactRef": artifact_ref_json(artifact_uri)
                }
            }
        ],
        "branchEvents": [],
        "captures": captures,
        "recordings": [],
        "approximations": approximations,
        "validationFindings": [],
        "limitations": limitations
    })
}

fn artifact_ref_json(artifact_uri: &str) -> Value {
    json!({
        "artifactId": "019ed003-0000-7000-8000-000040000001",
        "artifactKind": "screenshot",
        "uri": artifact_uri,
        "mediaType": "text/plain"
    })
}
