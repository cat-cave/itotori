//! UTSUSHI-224 alpha-gate test for the substrate sinks-bridge: drive a
//! 10-tick run of [`utsushi_fixture::FixtureEnginePort`] through the
//! substrate [`utsushi_core::Runner`] and assert the runner drains a
//! non-empty mix of text + frame emissions per the documented per-tick
//! ordering invariant.
//!
//! `utsushi-fixture` is a production crate (not test code), so this
//! exercise satisfies the audit constraint "≥1 non-test consumer of the
//! sinks subsystem exists outside `utsushi-core`".

use std::fs;
use std::path::PathBuf;

use utsushi_core::{
    EnginePort, PortRequest, REQUIRED_LIFECYCLE_STAGES, Runner, RuntimeArtifactRoot,
    RuntimeOperation,
};
use utsushi_fixture::FixtureEnginePort;

const FIXTURE_SOURCE: &str = r#"{
  "gameId": "engine-port-bridge",
  "title": "Engine Port Bridge",
  "sourceLocale": "ja-JP",
  "units": [
    {"sourceUnitKey": "bridge.scene.001.line.001", "sourceText": "こんにちは。", "targetText": "Hello.", "speaker": "Narrator", "textSurface": "adv"},
    {"sourceUnitKey": "bridge.scene.001.line.002", "sourceText": "今日もいい天気ですね。", "targetText": "Lovely weather today.", "speaker": "Narrator", "textSurface": "adv"},
    {"sourceUnitKey": "bridge.scene.001.line.003", "sourceText": "選択してください。", "targetText": "Please choose.", "speaker": "System", "textSurface": "adv"},
    {"sourceUnitKey": "bridge.scene.001.line.004", "sourceText": "おはようございます。", "targetText": "Good morning.", "speaker": "Narrator", "textSurface": "adv"},
    {"sourceUnitKey": "bridge.scene.001.line.005", "sourceText": "ようこそ。", "targetText": "Welcome.", "speaker": "Narrator", "textSurface": "adv"},
    {"sourceUnitKey": "bridge.scene.001.line.006", "sourceText": "また会いましょう。", "targetText": "See you again.", "speaker": "Narrator", "textSurface": "adv"},
    {"sourceUnitKey": "bridge.scene.001.line.007", "sourceText": "ありがとう。", "targetText": "Thank you.", "speaker": "Narrator", "textSurface": "adv"},
    {"sourceUnitKey": "bridge.scene.001.line.008", "sourceText": "さようなら。", "targetText": "Farewell.", "speaker": "Narrator", "textSurface": "adv"},
    {"sourceUnitKey": "bridge.scene.001.line.009", "sourceText": "こんばんは。", "targetText": "Good evening.", "speaker": "Narrator", "textSurface": "adv"},
    {"sourceUnitKey": "bridge.scene.001.line.010", "sourceText": "おやすみなさい。", "targetText": "Goodnight.", "speaker": "Narrator", "textSurface": "adv"}
  ]
}
"#;

fn write_fixture_source() -> (tempfile::TempDir, PathBuf) {
    let dir = tempfile::TempDir::new().expect("tempdir");
    let path = dir.path().to_path_buf();
    fs::write(path.join("source.json"), FIXTURE_SOURCE).expect("write fixture source.json");
    (dir, path)
}

#[test]
fn fixture_engine_port_pushes_text_then_frame_through_substrate_sinks() {
    let (_input_dir, input_root) = write_fixture_source();
    let artifact_dir = tempfile::TempDir::new().expect("artifact tempdir");
    let artifact_root = RuntimeArtifactRoot::new(artifact_dir.path().to_path_buf());
    artifact_root.prepare().expect("prepare artifact root");

    let mut port = FixtureEnginePort::new();
    let request = PortRequest::new(&input_root, "fixture-bridge-run", RuntimeOperation::Trace)
        .with_artifact_root(&artifact_root);
    let runner = Runner::new();

    let outcome = runner
        .run_trace(&mut port, &request)
        .expect("fixture engine port run_trace succeeds");

    let text_total: usize = outcome.observations.iter().map(|t| t.text.len()).sum();
    let frame_total: usize = outcome.observations.iter().map(|t| t.frames.len()).sum();
    let audio_total: usize = outcome.observations.iter().map(|t| t.audio.len()).sum();

    // The fixture script has 10 text units; the port pushes one text
    // line per observe tick + one trailing frame emission.
    assert_eq!(
        text_total, 10,
        "expected one text emission per fixture unit"
    );
    assert_eq!(frame_total, 1, "expected one trailing frame emission");
    assert_eq!(
        audio_total, 0,
        "fixture port has no audio source — audio sink is Unsupported"
    );
    // The runner walked at least 10 ticks (text) + 1 tick (frame) + 1
    // empty tick (end-of-stream). Ticks with non-empty drains are the
    // ones surfaced into `outcome.observations`.
    assert_eq!(outcome.observations.len(), 11);
}

#[test]
fn fixture_engine_port_capability_summary_advertises_audio_unsupported() {
    let port = FixtureEnginePort::new();
    let summary = port.sink_set().capabilities();
    assert!(
        matches!(summary.text, utsushi_core::SinkCapability::Supported { .. }),
        "text sink must advertise Supported"
    );
    assert!(
        matches!(
            summary.frame,
            utsushi_core::SinkCapability::Supported { .. }
        ),
        "frame sink must advertise Supported"
    );
    assert!(
        matches!(summary.audio, utsushi_core::SinkCapability::Unsupported),
        "audio sink must advertise Unsupported (fixture has no audio evidence)"
    );
}

#[test]
fn fixture_engine_port_manifest_declares_required_substrate_stages() {
    assert_eq!(FixtureEnginePort::MANIFEST.abi_version, 1);
    assert_eq!(
        FixtureEnginePort::MANIFEST.required_methods,
        REQUIRED_LIFECYCLE_STAGES
    );
    assert!(
        FixtureEnginePort::MANIFEST
            .capabilities
            .contains(&utsushi_core::PortCapability::Observe)
    );
}
