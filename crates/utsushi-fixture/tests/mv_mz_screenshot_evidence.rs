//! UTSUSHI-065: MV/MZ screenshot-evidence fixture tests.
//!
//! These prove, WITHOUT a live browser, that the fixture run emits runtime
//! trace events and screenshot artifactRefs linked by `bridgeUnitRef` + frame
//! id, that the capture metadata (viewport / device scale / adapter) is
//! recorded, and that the screenshot side accepts a real captured artifact from
//! the UTSUSHI-006 capture path.

use std::path::{Path, PathBuf};

use serde_json::Value;
use utsushi_core::{
    RuntimeArtifactKind, RuntimeArtifactRoot, RuntimeCapturedArtifact,
    validate_runtime_evidence_report_value,
};

use utsushi_fixture::mv_mz_screenshot_evidence::{
    CaptureMetadata, ScreenshotEvidenceRef, build_mv_mz_screenshot_evidence,
    capture_metadata_from_fixture, mv_mz_screenshot_evidence_report,
};

fn collect_artifact_ref_uris(value: &Value, uris: &mut Vec<String>) {
    match value {
        Value::Object(object) => {
            if let Some(artifact_ref) = object.get("artifactRef").and_then(Value::as_object)
                && let Some(uri) = artifact_ref.get("uri").and_then(Value::as_str)
            {
                uris.push(uri.to_string());
            }
            for child in object.values() {
                collect_artifact_ref_uris(child, uris);
            }
        }
        Value::Array(items) => {
            for item in items {
                collect_artifact_ref_uris(item, uris);
            }
        }
        _ => {}
    }
}

fn fixture_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/mvmz_screenshot_evidence")
}

fn temp_dir(name: &str) -> PathBuf {
    use std::time::{SystemTime, UNIX_EPOCH};
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let dir = std::env::temp_dir().join(format!(
        "utsushi-u065-{name}-{}-{nonce}",
        std::process::id()
    ));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

#[test]
fn fixture_report_matches_committed_golden_bytes() {
    let report = mv_mz_screenshot_evidence_report(&fixture_root(), None).unwrap();
    let mut rendered = serde_json::to_string_pretty(&report).unwrap();
    rendered.push('\n');
    let golden = std::fs::read_to_string(fixture_root().join("evidence.golden.json")).unwrap();
    assert_eq!(
        rendered, golden,
        "mvmz screenshot-evidence report drifted from the committed golden; \
         regenerate the golden if the change is intended"
    );
}

#[test]
fn fixture_report_is_envelope_conformant() {
    let report = mv_mz_screenshot_evidence_report(&fixture_root(), None).unwrap();
    validate_runtime_evidence_report_value(&report).unwrap();
    assert_eq!(report["status"], "passed");
    assert_eq!(report["evidenceTier"], "E2");
    assert_eq!(report["fidelityTier"], "layout_probe");
}

#[test]
fn trace_events_link_to_screenshot_artifact_refs_by_bridge_ref_and_frame() {
    let report = mv_mz_screenshot_evidence_report(&fixture_root(), None).unwrap();
    let traces = report["traceEvents"].as_array().unwrap();
    let captures = report["captures"].as_array().unwrap();
    assert_eq!(traces.len(), 3);
    assert_eq!(captures.len(), 3);

    for (trace, capture) in traces.iter().zip(captures.iter()) {
        // map/event command id -> trace id: the trace event carries the MV/MZ
        // command coordinate and its own trace id.
        let mv_ref = &trace["mvCommandRef"];
        assert!(mv_ref["sourceFile"].as_str().unwrap().contains(".json"));
        assert!(matches!(
            mv_ref["containerKind"].as_str().unwrap(),
            "map_event" | "common_event"
        ));
        assert!(mv_ref["containerId"].as_i64().is_some());
        assert!(mv_ref["commandIndex"].as_u64().is_some());
        let trace_id = trace["traceEventId"].as_str().unwrap();

        // trace id -> artifactRef: the capture points back at the trace event
        // it evidences and forward at the screenshot artifactRef.
        assert_eq!(capture["evidencesTraceEventId"].as_str().unwrap(), trace_id);
        let artifact_ref = &capture["artifactRef"];
        assert_eq!(artifact_ref["artifactKind"], "screenshot");
        assert!(
            artifact_ref["uri"]
                .as_str()
                .unwrap()
                .starts_with("artifacts/utsushi/runtime/")
        );

        // The link key: SAME bridgeUnitRef + SAME frame on both sides.
        assert_eq!(trace["bridgeUnitRef"], capture["bridgeUnitRef"]);
        assert_eq!(trace["frame"], capture["frame"]);
        // The MV/MZ command coordinate is mirrored on the capture too.
        assert_eq!(&capture["mvCommandRef"], mv_ref);
    }

    // The capture bridge unit id is the SAME id kaifuu-rpgmaker's decompiler
    // derives for that command (KAIFUU-109 scheme), so the evidence links the
    // real map/event command, not a fixture-local invention.
    assert_eq!(
        captures[0]["bridgeUnitRef"]["sourceUnitKey"],
        "rpgmaker:Map012.json#/events/3/pages/0/list/5/parameters/0"
    );
    assert_eq!(
        captures[0]["bridgeUnitRef"]["bridgeUnitId"],
        "5ce7ce53-c610-743e-b987-f54465e15561"
    );
}

#[test]
fn capture_metadata_records_viewport_device_scale_and_adapter() {
    let report = mv_mz_screenshot_evidence_report(&fixture_root(), None).unwrap();
    let metadata = &report["captureMetadata"];
    assert_eq!(metadata["viewport"]["width"], 816);
    assert_eq!(metadata["viewport"]["height"], 624);
    assert_eq!(metadata["deviceScaleFactor"], 1.0);
    assert_eq!(metadata["adapter"], "utsushi-browser");

    // Each capture repeats the same self-describing metadata.
    for capture in report["captures"].as_array().unwrap() {
        assert_eq!(&capture["captureMetadata"], metadata);
    }
}

#[test]
fn materializes_synthetic_screenshots_into_managed_artifact_root() {
    let work = temp_dir("materialize");
    let artifact_root = work.join("runtime-artifacts");
    let report = mv_mz_screenshot_evidence_report(&fixture_root(), Some(&artifact_root)).unwrap();
    validate_runtime_evidence_report_value(&report).unwrap();

    let root = RuntimeArtifactRoot::new(&artifact_root);
    for capture in report["captures"].as_array().unwrap() {
        let uri = capture["artifactRef"]["uri"].as_str().unwrap();
        let path = root.artifact_path(uri).unwrap();
        assert!(path.starts_with(&artifact_root));
        assert!(
            path.is_file(),
            "screenshot artifact not materialized: {uri}"
        );
        let bytes = std::fs::read(&path).unwrap();
        assert!(
            bytes.starts_with(b"\x89PNG"),
            "synthetic screenshot is a PNG placeholder"
        );
        assert_eq!(
            capture["artifactRef"]["byteSize"].as_u64().unwrap(),
            bytes.len() as u64
        );
    }

    // No raw local filesystem paths leak into the emitted report.
    let serialized = serde_json::to_string(&report).unwrap();
    assert!(!serialized.contains(work.to_string_lossy().as_ref()));
    let _ = std::fs::remove_dir_all(work);
}

#[test]
fn committed_fixture_report_has_no_dangling_screenshot_artifact_refs() {
    let report = mv_mz_screenshot_evidence_report(&fixture_root(), None).unwrap();
    let mut uris = Vec::new();
    collect_artifact_ref_uris(&report, &mut uris);
    uris.sort();
    uris.dedup();
    assert_eq!(uris.len(), 3);

    let root = RuntimeArtifactRoot::new(fixture_root().join("artifact-store"));
    for uri in uris {
        let path = root.artifact_path(&uri).unwrap();
        assert!(
            path.is_file(),
            "screenshot artifactRef must be materialized: {uri}"
        );
    }
}

#[test]
fn attaches_a_real_captured_screenshot_from_the_capture_path() {
    // Simulate the UTSUSHI-006 capture path: a real screenshot artifact
    // persisted to the runtime artifact root. This is what the browser adapter
    // produces on the env-gated Chromium path; here we attach it WITHOUT a live
    // browser to prove the linkage/metadata logic consumes a real artifact.
    let fixture: Value = serde_json::from_str(
        &std::fs::read_to_string(fixture_root().join("commands.json")).unwrap(),
    )
    .unwrap();
    let capture_metadata = capture_metadata_from_fixture(&fixture).unwrap();
    let command_count = fixture["commands"].as_array().unwrap().len();

    let screenshots: Vec<ScreenshotEvidenceRef> = (0..command_count)
        .map(|index| {
            let run_id = "0192b000-0000-7000-8000-000000000001";
            let artifact_id = format!("0192b000-0000-7000-8000-00000000{index:04x}");
            let uri = utsushi_core::runtime_artifact_uri(
                run_id,
                RuntimeArtifactKind::Screenshot,
                &artifact_id,
            )
            .unwrap();
            let captured = RuntimeCapturedArtifact {
                artifact_id,
                artifact_kind: RuntimeArtifactKind::Screenshot,
                uri,
                media_type: Some("image/png".to_string()),
                byte_size: 4096,
                path: PathBuf::from("/dev/null"),
                boundary: None,
            };
            ScreenshotEvidenceRef::from_captured_artifact(&captured).unwrap()
        })
        .collect();

    let report =
        build_mv_mz_screenshot_evidence(&fixture, &screenshots, &capture_metadata).unwrap();
    validate_runtime_evidence_report_value(&report).unwrap();

    let captures = report["captures"].as_array().unwrap();
    assert_eq!(captures.len(), command_count);
    assert_eq!(captures[0]["artifactRef"]["byteSize"], 4096);
    assert!(
        captures[0]["artifactRef"]["uri"]
            .as_str()
            .unwrap()
            .contains("0192b000-0000-7000-8000-000000000001")
    );
    // Still linked to the same bridge unit ref + frame as its trace event.
    assert_eq!(
        report["traceEvents"][0]["bridgeUnitRef"],
        captures[0]["bridgeUnitRef"]
    );
}

#[test]
fn screenshot_ref_rejects_non_screenshot_artifact() {
    let captured = RuntimeCapturedArtifact {
        artifact_id: "0192b000-0000-7000-8000-000000000001".to_string(),
        artifact_kind: RuntimeArtifactKind::Recording,
        uri: "artifacts/utsushi/runtime/0192b000-0000-7000-8000-000000000001/recordings/0192b000-0000-7000-8000-000000000002.webm".to_string(),
        media_type: Some("video/webm".to_string()),
        byte_size: 4096,
        path: PathBuf::from("/dev/null"),
        boundary: None,
    };
    let error = ScreenshotEvidenceRef::from_captured_artifact(&captured).unwrap_err();
    assert!(error.to_string().contains("screenshot"));
}

#[test]
fn capture_metadata_helper_reads_the_fixture_block() {
    let fixture: Value = serde_json::from_str(
        &std::fs::read_to_string(fixture_root().join("commands.json")).unwrap(),
    )
    .unwrap();
    let metadata = capture_metadata_from_fixture(&fixture).unwrap();
    assert_eq!(
        metadata,
        CaptureMetadata {
            viewport_width: 816,
            viewport_height: 624,
            device_scale_factor: 1.0,
            adapter: "utsushi-browser".to_string(),
        }
    );
}
