//! Recipe-layer `--skip-browser` flag integration tests.
//!
//! These tests drive the compiled `utsushi-cli` binary as a subprocess to
//! verify the operator-visible contract of the explicit recipe-level skip:
//!
//! - `utsushi capabilities --skip-browser` augments the capabilities report
//!   with a typed `runtime_skip_acknowledged` diagnostic and an
//!   `alphaEvidence.status: "not_established"` marker so the report cannot
//!   be consumed as a successful Chromium probe. The browser adapter's own
//!   host-availability diagnostic retains its honest severity (error when
//!   Chromium is absent), so a skip is distinguishable from a real probe.
//! - `utsushi smoke <dir> --adapter utsushi-browser --skip-browser` writes a
//!   skip report (`status: "skipped"`) instead of launching the browser
//!   adapter. The report carries the same typed diagnostic.
//! - `--skip-browser` against a non-browser adapter is a typed error: the
//!   fixture adapter does not advertise the browser-launch capability, so
//!   the recipe refuses to silently degrade.
//! - `--skip-browser` on `trace` is rejected as an unknown flag (the skip
//!   surface is intentionally limited to capabilities + smoke so an alpha
//!   claim cannot quietly lose its evidence path).
//!
//! Fixtures are SYNTHETIC, authored inline in per-run temp directories.

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
        "utsushi-cli-skip-browser-{name}-{}-{nonce}",
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
  "gameId": "skip-browser-fixture",
  "title": "Skip Browser Fixture",
  "sourceLocale": "ja-JP",
  "units": [
    {
      "sourceUnitKey": "skip.browser.001",
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

fn run_cli(args: &[&str]) -> std::process::Output {
    Command::new(env!("CARGO_BIN_EXE_utsushi-cli"))
        .args(args)
        .output()
        .expect("failed to run utsushi-cli")
}

fn assert_no_private_paths(report: &Value, root: &Path, private_path: &Path) {
    let serialized = serde_json::to_string(report).unwrap();
    assert!(
        !serialized.contains(root.to_string_lossy().as_ref()),
        "temp-dir prefix leaked into report JSON",
    );
    assert!(
        !serialized.contains(private_path.to_string_lossy().as_ref()),
        "private adapter path leaked into report JSON",
    );
}

#[test]
fn capabilities_with_skip_browser_emits_runtime_skip_acknowledged_diagnostic() {
    let root = temp_dir("capabilities-skip");
    let output = root.join("capabilities.json");

    let result = run_cli(&[
        "capabilities",
        "--skip-browser",
        "--output",
        &output.display().to_string(),
    ]);
    assert!(
        result.status.success(),
        "capabilities --skip-browser must succeed: {}",
        String::from_utf8_lossy(&result.stderr),
    );

    let report: Value = serde_json::from_str(&fs::read_to_string(&output).unwrap()).unwrap();
    assert_eq!(report["schemaVersion"], "0.1.0");
    assert_eq!(report["status"], "browser_runtime_skipped");
    assert_eq!(report["alphaEvidence"]["status"], "not_established");
    assert_eq!(
        report["alphaEvidence"]["reason"],
        "runtime_skip_acknowledged",
    );

    let skip = report["diagnostics"]
        .as_array()
        .unwrap()
        .iter()
        .find(|diagnostic| diagnostic["diagnosticKind"] == "runtime_skip_acknowledged")
        .expect("top-level runtime_skip_acknowledged diagnostic is required");
    assert_eq!(skip["status"], "skipped");
    assert_eq!(skip["severity"], "warning");
    assert_eq!(
        skip["details"]["errorCode"],
        "utsushi.runtime.skip_acknowledged",
    );
    assert_eq!(skip["details"]["skipFlag"], "--skip-browser");
    assert_eq!(skip["details"]["capability"], "browser_launch");
    assert_eq!(skip["details"]["surface"], "capabilities");
    assert_eq!(skip["details"]["alphaEvidenceEstablished"], false);
    assert_eq!(
        skip["details"]["affectedAdapters"],
        Value::from(["utsushi-browser"]),
    );

    // The browser adapter's own host-availability diagnostic retains its
    // honest severity; the recipe skip does NOT downgrade it. This is the
    // acceptance criterion: the report status under the flag is
    // distinguishable from a successful Chromium probe.
    let adapter_diagnostic = report["runtimeAdapters"]
        .as_array()
        .unwrap()
        .iter()
        .find(|adapter| adapter["adapterName"] == "utsushi-browser")
        .and_then(|adapter| adapter["diagnostics"].as_array())
        .and_then(|diagnostics| {
            diagnostics
                .iter()
                .find(|diagnostic| diagnostic["diagnosticKind"] == "browser_host_availability")
        })
        .expect("browser_host_availability diagnostic is still required");
    assert!(
        adapter_diagnostic["severity"].as_str() == Some("error")
            || adapter_diagnostic["severity"].as_str() == Some("info"),
        "host probe severity is honest: {}",
        adapter_diagnostic["severity"],
    );

    let _ = fs::remove_dir_all(root);
}

#[test]
fn capabilities_without_skip_flag_has_no_recipe_skip_diagnostics() {
    let root = temp_dir("capabilities-no-skip");
    let output = root.join("capabilities.json");

    let result = run_cli(&["capabilities", "--output", &output.display().to_string()]);
    assert!(
        result.status.success(),
        "capabilities must succeed without --skip-browser: {}",
        String::from_utf8_lossy(&result.stderr),
    );

    let report: Value = serde_json::from_str(&fs::read_to_string(&output).unwrap()).unwrap();
    assert!(
        report.get("status").is_none(),
        "a browser skip is never inferred from host unavailability",
    );
    assert!(
        report.get("diagnostics").is_none(),
        "only an explicit --skip-browser emits the recipe acknowledgement",
    );
    assert!(
        report.get("alphaEvidence").is_none(),
        "alpha-evidence marker only appears under an explicit skip",
    );

    let _ = fs::remove_dir_all(root);
}

#[test]
fn smoke_with_skip_browser_writes_skipped_report_for_browser_adapter() {
    let root = temp_dir("smoke-skip-browser");
    let game_dir = root.join("game");
    write_fixture_source(&game_dir);
    let output = root.join("smoke.json");

    let result = run_cli(&[
        "smoke",
        &game_dir.display().to_string(),
        "--adapter",
        "utsushi-browser",
        "--skip-browser",
        "--output",
        &output.display().to_string(),
    ]);
    assert!(
        result.status.success(),
        "smoke --skip-browser against the browser adapter must succeed: {}",
        String::from_utf8_lossy(&result.stderr),
    );

    let report: Value = serde_json::from_str(&fs::read_to_string(&output).unwrap()).unwrap();
    assert_eq!(report["adapterName"], "utsushi-browser");
    assert_eq!(report["operation"], "smoke_validation");
    assert_eq!(report["status"], "skipped");
    assert_eq!(report["alphaEvidence"]["status"], "not_established");

    let skip = &report["diagnostics"][0];
    assert_eq!(skip["diagnosticKind"], "runtime_skip_acknowledged");
    assert_eq!(skip["details"]["surface"], "smoke_validation");
    assert_eq!(
        skip["details"]["errorCode"],
        "utsushi.runtime.skip_acknowledged"
    );
    assert_eq!(
        skip["details"]["affectedAdapters"],
        Value::from(["utsushi-browser"]),
    );

    assert_no_private_paths(&report, &root, &game_dir);
    let _ = fs::remove_dir_all(root);
}

#[test]
fn smoke_with_skip_browser_rejects_non_browser_adapter() {
    let root = temp_dir("smoke-skip-nonbrowser");
    let game_dir = root.join("game");
    write_fixture_source(&game_dir);
    let output = root.join("smoke.json");

    let result = run_cli(&[
        "smoke",
        &game_dir.display().to_string(),
        "--adapter",
        "utsushi-fixture",
        "--skip-browser",
        "--output",
        &output.display().to_string(),
    ]);
    assert!(
        !result.status.success(),
        "--skip-browser against a non-browser adapter must exit non-zero",
    );
    let stderr = String::from_utf8_lossy(&result.stderr);
    assert!(
        stderr.contains("requires an adapter that advertises browser_launch"),
        "stderr must explain the rejection: {stderr}",
    );
    assert!(!output.exists(), "no output file on a rejected skip");

    let _ = fs::remove_dir_all(root);
}

#[test]
fn trace_command_rejects_skip_browser_flag_as_unknown() {
    let root = temp_dir("trace-skip-browser");
    let game_dir = root.join("game");
    write_fixture_source(&game_dir);
    let output = root.join("trace.json");

    let result = run_cli(&[
        "trace",
        &game_dir.display().to_string(),
        "--skip-browser",
        "--output",
        &output.display().to_string(),
    ]);
    assert!(
        !result.status.success(),
        "trace must reject --skip-browser as unknown",
    );
    let stderr = String::from_utf8_lossy(&result.stderr);
    assert!(
        stderr.contains("unknown flag --skip-browser"),
        "stderr must name the unknown flag: {stderr}",
    );
    assert!(!output.exists(), "no output file on a rejected flag");

    let _ = fs::remove_dir_all(root);
}

#[test]
fn capabilities_skip_browser_does_not_leak_private_browser_bin_path() {
    // The recipe-level skip acknowledgement is path-free by construction;
    // a configured browser binary path (e.g. an operator's private
    // UTSUSHI_BROWSER_BIN) must never leak into the top-level skip
    // diagnostic even when the per-adapter diagnostic still carries the
    // honest host probe.
    let root = temp_dir("skip-browser-redaction");
    let private_path = root.join("private-browser-bin");
    let output = root.join("capabilities.json");

    let result = Command::new(env!("CARGO_BIN_EXE_utsushi-cli"))
        .arg("capabilities")
        .arg("--skip-browser")
        .arg("--output")
        .arg(&output)
        .env("UTSUSHI_BROWSER_BIN", &private_path)
        .output()
        .expect("failed to run utsushi-cli");
    assert!(
        result.status.success(),
        "capabilities --skip-browser must succeed even with a broken UTSUSHI_BROWSER_BIN: {}",
        String::from_utf8_lossy(&result.stderr),
    );

    let report: Value = serde_json::from_str(&fs::read_to_string(&output).unwrap()).unwrap();
    assert_no_private_paths(&report, &root, &private_path);

    let _ = fs::remove_dir_all(root);
}
