//! UTSUSHI-008: end-to-end test for the `utsushi trace-kag` subcommand.
//!
//! Drives the actual CLI binary against the committed synthetic plaintext KAG
//! fixture and asserts the emitted command trace matches the committed golden
//! byte-for-byte (the golden is pinned in `vite.config.ts` fmt.ignorePatterns).
//! Fixture is synthetic, authored, CC0.

use std::path::{Path, PathBuf};
use std::process::Command;

use serde_json::Value;

fn repo_fixture_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/public/kag-plaintext")
}

fn temp_output(name: &str) -> PathBuf {
    use std::time::{SystemTime, UNIX_EPOCH};
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    std::env::temp_dir().join(format!(
        "utsushi-u008-{name}-{}-{nonce}.json",
        std::process::id()
    ))
}

fn run_trace_kag(script: &Path, output: &Path) -> std::process::Output {
    Command::new(env!("CARGO_BIN_EXE_utsushi-cli"))
        .arg("trace-kag")
        .arg(script)
        .arg("--output")
        .arg(output)
        .output()
        .expect("failed to run utsushi-cli")
}

#[test]
fn cli_emits_committed_golden_trace() {
    let dir = repo_fixture_dir();
    let output = temp_output("main");
    let result = run_trace_kag(&dir.join("main.ks"), &output);
    assert!(
        result.status.success(),
        "trace-kag failed: {}",
        String::from_utf8_lossy(&result.stderr)
    );

    let rendered = std::fs::read_to_string(&output).unwrap();
    let golden = std::fs::read_to_string(dir.join("main.trace.golden.json")).unwrap();
    assert_eq!(
        rendered, golden,
        "trace-kag output drifted from committed golden",
    );

    // Sanity on the trace shape: the golden really carries every required
    // column and the bridge linkage.
    let value: Value = serde_json::from_str(&golden).unwrap();
    assert_eq!(
        value["schemaVersion"],
        Value::from("utsushi-kirikiri-kag-command-trace/0.1.0"),
    );
    assert!(
        value["scope"].as_str().unwrap().contains("plaintext"),
        "golden must carry the honest plaintext-only scope note",
    );
    let rows = value["rows"].as_array().unwrap();
    assert!(
        rows.iter()
            .any(|r| r["kind"] == "label" && r["label"].is_string())
    );
    assert!(
        rows.iter()
            .any(|r| r["kind"] == "macro" && r["macroId"].is_string())
    );
    assert!(
        rows.iter()
            .any(|r| r["kind"] == "jump" && r["jumpTarget"].is_string())
    );
    assert!(rows.iter().any(|r| r["kind"] == "branch"
        && r["branchId"].is_string()
        && r["bridgeRef"]["sourceUnitKey"].is_string()));
    assert!(
        rows.iter()
            .any(|r| r["kind"] == "speaker" && r["bridgeRef"]["bridgeUnitId"].is_string())
    );

    let _ = std::fs::remove_file(&output);
}

#[test]
fn cli_rejects_missing_output_flag() {
    let dir = repo_fixture_dir();
    let result = Command::new(env!("CARGO_BIN_EXE_utsushi-cli"))
        .arg("trace-kag")
        .arg(dir.join("main.ks"))
        .output()
        .expect("failed to run utsushi-cli");
    assert!(!result.status.success(), "must reject a missing --output");
    assert!(
        String::from_utf8_lossy(&result.stderr).contains("--output"),
        "error should mention the missing --output flag",
    );
}

#[test]
fn cli_output_is_deterministic_across_runs() {
    let dir = repo_fixture_dir();
    let out_a = temp_output("det-a");
    let out_b = temp_output("det-b");
    assert!(run_trace_kag(&dir.join("main.ks"), &out_a).status.success());
    assert!(run_trace_kag(&dir.join("main.ks"), &out_b).status.success());
    assert_eq!(
        std::fs::read_to_string(&out_a).unwrap(),
        std::fs::read_to_string(&out_b).unwrap(),
    );
    let _ = std::fs::remove_file(&out_a);
    let _ = std::fs::remove_file(&out_b);
}
