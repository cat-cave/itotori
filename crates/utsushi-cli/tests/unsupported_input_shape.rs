//! The `utsushi trace` command REFUSES a non-fixture input with
//! a structured `utsushi.unsupported_input_shape` diagnostic on stdout and a
//! non-zero exit, instead of surfacing an opaque `os::Error::NotFound`. A
//! valid fixture input still traces.
//!
//! Fixtures are SYNTHETIC and authored inline in a per-run temp directory —
//! no real game bytes are touched.

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
        "utsushi-u177-{name}-{}-{nonce}",
        std::process::id()
    ));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).unwrap();
    dir
}

fn run_trace(input: &Path, output: &Path) -> std::process::Output {
    Command::new(env!("CARGO_BIN_EXE_utsushi-cli"))
        .arg("trace")
        .arg(input)
        .arg("--output")
        .arg(output)
        .output()
        .expect("failed to run utsushi-cli")
}

#[test]
fn trace_refuses_non_fixture_input_with_typed_diagnostic() {
    // A directory that is NOT a valid fixture (no source.json manifest) — the
    // shape a real game directory would present.
    let dir = temp_dir("non-fixture");
    fs::write(dir.join("Game.exe"), b"not a fixture").unwrap();
    let output = dir.join("out.json");

    let result = run_trace(&dir, &output);

    assert!(
        !result.status.success(),
        "a non-fixture input must exit non-zero",
    );
    assert_eq!(result.status.code(), Some(1), "must exit 1");

    let stdout = String::from_utf8(result.stdout).expect("stdout is utf-8");
    let value: Value =
        serde_json::from_str(stdout.trim()).expect("stdout must be the JSON diagnostic envelope");
    assert_eq!(
        value["diagnostic"]["code"],
        Value::from("utsushi.unsupported_input_shape"),
        "diagnostic must carry the typed code, not a raw NotFound",
    );
    assert_eq!(
        value["diagnostic"]["engine_family"],
        Value::from("fixture"),
        "diagnostic must name the engine family being attempted",
    );
    assert!(
        value["diagnostic"]["detail"].is_string(),
        "diagnostic must carry a helpful detail",
    );

    // The refusal fires BEFORE any output is written.
    assert!(!output.exists(), "no output file on a refused input");

    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn trace_still_traces_a_valid_fixture() {
    let dir = temp_dir("valid-fixture");
    fs::write(
        dir.join("source.json"),
        r#"{
  "gameId": "hello-fixture",
  "title": "Hello Fixture",
  "sourceLocale": "ja-JP",
  "units": [
    {
      "sourceUnitKey": "hello.scene.001.line.001",
      "speaker": "Narrator",
      "textSurface": "dialogue",
      "sourceText": "こんにちは。",
      "targetText": "Hello.",
      "protectedSpans": []
    }
  ]
}
"#,
    )
    .unwrap();
    let output = dir.join("out.json");

    let result = run_trace(&dir, &output);
    assert!(
        result.status.success(),
        "a valid fixture must still trace (no false refusal): {}",
        String::from_utf8_lossy(&result.stderr),
    );
    assert!(output.exists(), "a valid fixture trace writes its output");

    let _ = fs::remove_dir_all(&dir);
}
