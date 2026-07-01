//! End-to-end runtime-evidence test: drive [`UtsushiRpgmakerMvPort`]
//! through the `utsushi-core` runner against a synthetic MZ project and
//! assert the observed text stream, the capture artifact, and the
//! [`Inspectable`] snapshot are real (not placeholder) outputs.
//!
//! The MV `www/data/` layout is exercised by the ABI conformance test;
//! this test exercises the MZ `data/` layout, so both layouts the port
//! resolves are covered.

use std::fs;
use std::path::Path;

use utsushi_core::port::runner::Runner;
use utsushi_core::substrate::{EnginePort, Inspectable, PortRequest, StateValue};
use utsushi_core::{RuntimeArtifactRoot, RuntimeOperation};

use utsushi_rpgmaker_mv::UtsushiRpgmakerMvPort;

/// Write a minimal but real synthetic MZ project (`data/`, no `www/`).
/// Clean-room invented text; no game bytes.
fn write_synthetic_mz_project(input_root: &Path) {
    let data = input_root.join("data");
    fs::create_dir_all(&data).expect("create data");
    fs::write(
        data.join("Map002.json"),
        r#"{
            "events": [
                null,
                { "id": 1, "pages": [
                    { "list": [
                        { "code": 101, "indent": 0, "parameters": ["", 0, 0, 2, "Captain"] },
                        { "code": 401, "indent": 0, "parameters": ["Set a course for the harbor."] },
                        { "code": 401, "indent": 0, "parameters": ["We sail at dawn."] },
                        { "code": 102, "indent": 0, "parameters": [["Aye", "Not yet"], 1] },
                        { "code": 0, "indent": 0, "parameters": [] }
                    ] }
                ] }
            ]
        }"#,
    )
    .expect("write Map002.json");
}

fn run_capture_against_project(
    input_root: &Path,
    artifact_root: &RuntimeArtifactRoot,
    run_id: &str,
) -> utsushi_core::port::runner::RunnerOutcome {
    let runner = Runner::new();
    let mut port = UtsushiRpgmakerMvPort::new();
    let request = PortRequest::new(input_root, run_id, RuntimeOperation::Capture)
        .with_artifact_root(artifact_root);
    runner
        .run_capture(&mut port, &request)
        .expect("capture run succeeds against synthetic MZ project")
}

#[test]
fn mz_run_emits_real_text_stream_capture_and_snapshot() {
    let temp = tempfile::tempdir().expect("tempdir");
    let input_root = temp.path().join("project");
    write_synthetic_mz_project(&input_root);
    let artifact_root = RuntimeArtifactRoot::new(temp.path().join("artifacts"));
    artifact_root.prepare().expect("prepare artifact root");

    let outcome =
        run_capture_against_project(&input_root, &artifact_root, "rpgmaker-mv-mz-evidence-0001");

    // ---- Observed text stream is real -------------------------------------
    let lines: Vec<&utsushi_core::TextLine> = outcome
        .observations
        .iter()
        .flat_map(|observation| observation.text.iter())
        .collect();
    // 2 dialogue lines + 2 choice options.
    assert_eq!(lines.len(), 4);
    assert_eq!(lines[0].text, "Set a course for the harbor.");
    assert_eq!(lines[0].speaker.as_deref(), Some("Captain"));
    assert_eq!(lines[0].text_surface.as_deref(), Some("event_text"));
    assert_eq!(lines[1].text, "We sail at dawn.");
    assert_eq!(lines[2].text, "Aye");
    assert_eq!(lines[2].text_surface.as_deref(), Some("choice"));
    assert_eq!(lines[3].text, "Not yet");
    // The MZ layout addresses assets under the `game` package.
    assert_eq!(
        lines[0]
            .source_asset
            .as_ref()
            .map(utsushi_core::AssetId::as_str),
        Some("vfs://game/data/Map002.json")
    );

    // ---- Capture artifact is materialised under the managed root ----------
    let capture = outcome.capture.expect("capture outcome present");
    let path = capture.artifact_path.expect("capture wrote a path");
    assert!(path.starts_with(artifact_root.path()), "artifact contained");
    let raw = fs::read_to_string(&path).expect("read capture artifact");
    let doc: serde_json::Value = serde_json::from_str(&raw).expect("artifact is valid JSON");
    assert_eq!(doc["portId"], "utsushi-rpgmaker-mv");
    assert_eq!(doc["layout"], "mz");
    assert_eq!(doc["lineCount"], 4);
    assert_eq!(doc["lines"].as_array().expect("lines array").len(), 4);
    assert_eq!(doc["lines"][0]["text"], "Set a course for the harbor.");
    assert_eq!(doc["lines"][0]["speaker"], "Captain");
}

#[test]
fn inspectable_snapshot_reflects_playback_cursor() {
    let temp = tempfile::tempdir().expect("tempdir");
    let input_root = temp.path().join("project");
    write_synthetic_mz_project(&input_root);

    let mut port = UtsushiRpgmakerMvPort::new();
    let request = PortRequest::new(
        &input_root,
        "rpgmaker-mv-snapshot-0001",
        RuntimeOperation::Trace,
    );

    // Before launch: cursor is unlaunched.
    let before = port.inspect_state().expect("inspect before launch");
    before.validate().expect("pre-launch tree validates");
    assert!(matches!(
        before.get(&path("port.data_layout")),
        Some(StateValue::String { value }) if value == "unlaunched"
    ));

    port.launch(&request).expect("launch synthetic MZ project");

    // After launch: layout resolved, lines counted, none emitted yet.
    let after = port.inspect_state().expect("inspect after launch");
    after.validate().expect("post-launch tree validates");
    assert!(matches!(
        after.get(&path("port.data_layout")),
        Some(StateValue::String { value }) if value == "mz"
    ));
    assert!(matches!(
        after.get(&path("port.lines_total")),
        Some(StateValue::Uint { value }) if *value == 4
    ));
    assert!(matches!(
        after.get(&path("port.lines_emitted")),
        Some(StateValue::Uint { value }) if *value == 0
    ));

    // Drain the whole observation stream, then snapshot again.
    loop {
        port.observe(&request).expect("observe tick");
        if port.sinks().sink_set().drain_text().is_empty() {
            break;
        }
    }
    let drained = port.inspect_state().expect("inspect after drain");
    assert!(matches!(
        drained.get(&path("port.lines_emitted")),
        Some(StateValue::Uint { value }) if *value == 4
    ));
    assert_eq!(port.lines_emitted(), 4);
    assert_eq!(
        drained.get(&path("metadata.adapter_name")),
        Some(&StateValue::String {
            value: "utsushi-rpgmaker-mv".to_string()
        })
    );
}

#[test]
fn observation_stream_is_deterministic_across_runs() {
    let temp = tempfile::tempdir().expect("tempdir");
    let input_root = temp.path().join("project");
    write_synthetic_mz_project(&input_root);
    let artifact_root = RuntimeArtifactRoot::new(temp.path().join("artifacts"));
    artifact_root.prepare().expect("prepare artifact root");

    let collect = |run_id: &str| -> Vec<String> {
        run_capture_against_project(&input_root, &artifact_root, run_id)
            .observations
            .iter()
            .flat_map(|observation| observation.text.iter().map(|line| line.text.clone()))
            .collect()
    };

    let first = collect("rpgmaker-mv-determinism-a");
    let second = collect("rpgmaker-mv-determinism-b");
    assert_eq!(first, second, "text stream must be deterministic");
    assert!(!first.is_empty());
}

fn path(raw: &str) -> utsushi_core::substrate::StatePath {
    utsushi_core::substrate::StatePath::parse(raw).expect("valid state path")
}
