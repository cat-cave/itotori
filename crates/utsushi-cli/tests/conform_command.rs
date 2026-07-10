use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{SystemTime, UNIX_EPOCH};

use serde_json::Value;

fn temp_dir(name: &str) -> PathBuf {
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let dir = std::env::temp_dir().join(format!(
        "utsushi-cli-conform-e2e-{name}-{}-{nonce}",
        std::process::id()
    ));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).unwrap();
    dir
}

fn write_fixture_source(game_dir: &Path) {
    fs::create_dir_all(game_dir).unwrap();
    fs::write(
        game_dir.join("source.json"),
        r#"{
  "gameId": "conform-fixture",
  "title": "Conform Fixture",
  "sourceLocale": "ja-JP",
  "units": [
    {
      "sourceUnitKey": "conform.scene.001.line.001",
      "speaker": "Narrator",
      "textSurface": "dialogue",
      "sourceText": "確認。",
      "targetText": "Confirmed.",
      "protectedSpans": []
    }
  ]
}
"#,
    )
    .unwrap();
}

/// Independently prepared expectation for a one-unit fixture after
/// `run_trace`: the golden baseline and the live port must both report
/// these inspectable counters. The E2E asserts the CLI result derives from
/// that contract rather than a harness-fabricated sentinel.
const EXPECTED_UNITS: u64 = 1;

#[test]
fn conform_command_emits_pass_when_live_port_matches_golden_fixture_state() {
    let root = temp_dir("runner-result-pass");
    let game_dir = root.join("game");
    write_fixture_source(&game_dir);
    let output = root.join("result.json");

    // Sanity: the independently prepared expected post-trace state for this
    // fixture is non-empty and uses the real fixture-port contract paths.
    let expected = utsushi_fixture::FixturePortInspectState::expected_post_trace(EXPECTED_UNITS);
    assert_eq!(expected.units_loaded, EXPECTED_UNITS);
    assert_eq!(expected.lines_emitted, EXPECTED_UNITS);
    assert_eq!(expected.lifecycle, "drained");
    assert!(expected.shut_down);
    let expected_tree = expected.to_state_tree().expect("golden tree");
    assert!(
        expected_tree
            .get(&utsushi_core::StatePath::parse("port.units_loaded").unwrap())
            .is_some(),
        "expected independent golden to expose port.units_loaded"
    );

    let result = Command::new(env!("CARGO_BIN_EXE_utsushi-cli"))
        .arg("conform")
        .arg(&game_dir)
        .arg("--adapter")
        .arg("utsushi-fixture")
        .arg("--output")
        .arg(&output)
        .output()
        .expect("failed to run utsushi-cli");

    assert!(
        result.status.success(),
        "conform command failed: {}",
        String::from_utf8_lossy(&result.stderr)
    );
    assert!(output.is_file(), "conform command writes output JSON");

    let value: Value = serde_json::from_str(&fs::read_to_string(&output).unwrap()).unwrap();
    assert_eq!(value["schemaVersion"], "0.2.0-alpha");
    assert_eq!(value["adapterId"], "utsushi-fixture");
    assert_eq!(value["profileId"], "snapshot-restore");
    // Matching golden vs live fixture-port state must PASS — do not assert a
    // predetermined failure the harness itself created.
    assert_eq!(
        value["outcome"]["kind"], "pass",
        "live port after Runner must match independently prepared golden: {value}"
    );
    assert_eq!(value["outcome"]["evidenceTier"], "E1");
    assert_eq!(value["evidence"][0]["artifactKind"], "statePath");
    let evidence_path = value["evidence"][0]["path"]
        .as_str()
        .expect("evidence path string");
    assert!(
        evidence_path.starts_with("port.") || evidence_path.starts_with("metadata."),
        "evidence must quote a real fixture-port state path, got {evidence_path}"
    );
    assert_ne!(
        evidence_path, "port.observation_count",
        "must not use the old fabricated sentinel path"
    );

    let recorded_at = value["recordedAt"]
        .as_str()
        .expect("recordedAt must be present");
    assert!(
        recorded_at.contains('T') && recorded_at.ends_with('Z'),
        "recordedAt must be a real RFC3339 Z instant, got {recorded_at}"
    );
    assert_ne!(
        recorded_at, "2026-07-09T00:00:00Z",
        "recordedAt must not be the old fixed constant"
    );

    let _ = fs::remove_dir_all(root);
}
