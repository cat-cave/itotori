//! End-to-end test for the `utsushi review-package` subcommand.
//!
//! Drives the actual CLI binary against the committed synthetic MV/MZ proof
//! surfaces and asserts (1) the emitted manifest matches the committed golden
//! on a supported host, and (2) an unsupported host (`--no-screenshot`) records
//! a non-silent semantic diagnostic + limitation instead of silently omitting
//! the screenshot surface.

use std::path::{Path, PathBuf};
use std::process::Command;

use serde_json::Value;

fn fixture_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../utsushi-fixture/tests/fixtures/mvmz_review_package")
}

fn run_review_package(extra: &[&str], output: &Path) {
    let root = fixture_root();
    let mut command = Command::new(env!("CARGO_BIN_EXE_utsushi-cli"));
    command
        .arg("review-package")
        .arg("--patch-export")
        .arg(root.join("patch_export.json"))
        .arg("--runtime-evidence")
        .arg(root.join("runtime_evidence.json"))
        .arg("--replay-pack")
        .arg(root.join("replay_pack_trace.json"))
        .arg("--output")
        .arg(output);
    for arg in extra {
        command.arg(arg);
    }
    let status = command.status().expect("failed to run utsushi-cli");
    assert!(status.success(), "review-package command failed");
}

fn temp_output(name: &str) -> PathBuf {
    use std::time::{SystemTime, UNIX_EPOCH};
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    std::env::temp_dir().join(format!(
        "utsushi-u010-{name}-{}-{nonce}.json",
        std::process::id()
    ))
}

#[test]
fn cli_supported_host_emits_committed_golden() {
    let output = temp_output("supported");
    run_review_package(&[], &output);
    let mut rendered = std::fs::read_to_string(&output).unwrap();
    if !rendered.ends_with('\n') {
        rendered.push('\n');
    }
    let golden = std::fs::read_to_string(fixture_root().join("manifest.golden.json")).unwrap();
    assert_eq!(
        rendered, golden,
        "CLI manifest drifted from committed golden"
    );
    let _ = std::fs::remove_file(&output);
}

#[test]
fn cli_unsupported_screenshot_host_records_semantic_diagnostic() {
    let output = temp_output("no-screenshot");
    run_review_package(&["--no-screenshot"], &output);
    let manifest: Value = serde_json::from_str(&std::fs::read_to_string(&output).unwrap()).unwrap();

    assert_eq!(
        manifest["screenshotArtifactRefs"]["availability"],
        "unavailable"
    );
    let diagnostics = manifest["diagnostics"].as_array().unwrap();
    assert!(diagnostics.iter().any(|d| {
        d["semanticCode"] == "utsushi.review_package.screenshot_capture_unsupported"
            && d["semantic"] == true
    }));
    let _ = std::fs::remove_file(&output);
}
