//! apply-side partial-source guard regression test.
//! introduced the PartialAdapterReport / `partial: true`
//! envelope on extract/profile/verify when an adapter accumulated nonzero
//! evidence but did not reach `detected == true`. The audit
//! P1 finding observed that the documented contract — "apply MUST refuse
//! any envelope whose `partial` field is true" — was documentation-only:
//! apply received a kaifuu-delta DeltaPackage produced by
//! extract→translate→diff and the partial provenance was LOST by the time
//! apply ran.
//! plumbs `sourceProvenance.partial` forward through the delta
//! package. This integration test exercises the end-to-end CLI path:
//! 1. `kaifuu diff <original> <patched> --output <delta> --source-extract
//!    <partial-extract-envelope>` writes a delta package whose
//!    `sourceProvenance.partial` is `true`.
//! 2. `kaifuu apply <game> --patch <delta> --output <out>` exits
//!    NON-ZERO with a typed `PartialSourceRefused` error reported on
//!    stderr, and the output directory is not created.
//!    Real-bytes preferred: the partial extract envelope is the
//!    schema-stable v0.1.0 PartialAdapterReport shape — same shape the
//!    regression test in `partial_extract.rs` already produces
//!    for the synthetic Sweetie HD fixture, so this test piggy-backs on
//!    that established envelope shape.

use std::fs;
use std::path::PathBuf;
use std::process::Command;

fn kaifuu_cli_binary() -> PathBuf {
    let path = PathBuf::from(env!("CARGO_BIN_EXE_kaifuu-cli"));
    assert!(
        path.exists(),
        "kaifuu-cli binary must exist at {}",
        path.display()
    );
    path
}

fn run_cli(args: &[&std::ffi::OsStr]) -> std::process::Output {
    let mut cmd = Command::new(kaifuu_cli_binary());
    for arg in args {
        cmd.arg(arg);
    }
    cmd.output().expect("kaifuu-cli must run")
}

fn write_file(root: &std::path::Path, relative: &str, bytes: &[u8]) {
    let path = root.join(relative);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).expect("create parent");
    }
    fs::write(path, bytes).expect("write file");
}

/// Build a schema-stable v0.1.0 PartialAdapterReport envelope that mirrors
/// the canonical RealLive partial-extract output: SEEN.TXT
/// envelope parses, Gameexe.ini key catalogue mismatches as P2.
fn write_partial_extract_envelope(path: &std::path::Path) {
    let envelope = serde_json::json!({
        "schemaVersion": "0.1.0",
        "reportId": "kaifuu-partial-adapter-kaifuu-238-test",
        "adapterId": "kaifuu-reallive",
        "detected": false,
        "partial": true,
        "command": "extract",
        "evidence": [],
        "diagnostics": [{
            "code": "kaifuu.reallive.partial.gameexe_key_catalogue_mismatch",
            "severity": "P2",
            "message": "Gameexe.ini key catalogue mismatch (synthetic)",
        }],
        "severityCounts": { "p0": 0, "p1": 0, "p2": 1, "p3": 0 },
        "inventory": { "entries": 3, "sources": [] },
    });
    fs::write(path, serde_json::to_string_pretty(&envelope).expect("json"))
        .expect("write envelope");
}

#[test]
fn partial_apply_refuses_delta_built_from_partial_source_extract() {
    let work = tempfile::Builder::new()
        .prefix("kaifuu-238-partial-apply-refuses")
        .tempdir()
        .expect("tempdir");
    let root = work.path();

    // Source ("original") and translated ("patched") trees: the diff is
    // a trivial replace of source.json. The bytes themselves are not the
    // point — the apply refusal must fire BEFORE any byte-level work.
    let original = root.join("original");
    let patched = root.join("patched");
    write_file(&original, "source.json", br#"{"units":[]}"#);
    write_file(
        &patched,
        "source.json",
        br#"{"units":[{"targetText":"Hello"}]}"#,
    );

    // Partial extract envelope: schema-stable v0.1.0 PartialAdapterReport.
    let extract_envelope = root.join("extract-envelope.json");
    write_partial_extract_envelope(&extract_envelope);

    // Diff with --source-extract carries `partial: true` into the package.
    let delta_path = root.join("partial-source.kaifuu");
    let diff_output = run_cli(&[
        std::ffi::OsStr::new("diff"),
        original.as_os_str(),
        patched.as_os_str(),
        std::ffi::OsStr::new("--output"),
        delta_path.as_os_str(),
        std::ffi::OsStr::new("--source-extract"),
        extract_envelope.as_os_str(),
    ]);
    assert!(
        diff_output.status.success(),
        "kaifuu diff must succeed (the refusal is at apply, not diff); status={:?}\nstdout={}\nstderr={}",
        diff_output.status,
        String::from_utf8_lossy(&diff_output.stdout),
        String::from_utf8_lossy(&diff_output.stderr),
    );
    let delta: serde_json::Value =
        serde_json::from_slice(&fs::read(&delta_path).expect("read delta")).expect("parse delta");
    assert_eq!(
        delta["sourceProvenance"]["partial"], true,
        "delta package must carry sourceProvenance.partial = true"
    );
    assert_eq!(delta["schemaVersion"], "0.3.0");
    assert_eq!(
        delta["sourceProvenance"]["adapterId"], "kaifuu-reallive",
        "delta package must forward the partial report adapterId"
    );

    // Apply must refuse non-zero, no output directory written.
    let output_dir = root.join("applied-output");
    let apply_output = run_cli(&[
        std::ffi::OsStr::new("apply"),
        original.as_os_str(),
        std::ffi::OsStr::new("--patch"),
        delta_path.as_os_str(),
        std::ffi::OsStr::new("--output"),
        output_dir.as_os_str(),
    ]);
    assert!(
        !apply_output.status.success(),
        "kaifuu apply must exit non-zero on partial source; status={:?}\nstdout={}\nstderr={}",
        apply_output.status,
        String::from_utf8_lossy(&apply_output.stdout),
        String::from_utf8_lossy(&apply_output.stderr),
    );
    let stderr = String::from_utf8_lossy(&apply_output.stderr);
    assert!(
        stderr.contains("kaifuu.delta.partial_source_refused"),
        "stderr must surface the typed PartialSourceRefused code; got: {stderr}"
    );
    assert!(
        !output_dir.exists(),
        "apply must not create the output directory when refusing the package"
    );
}

#[test]
fn partial_apply_accepts_delta_built_from_complete_source_extract() {
    // Complement: the same diff/apply round trip succeeds when no
    // --source-extract is provided. This guards against accidentally
    // marking every delta as partial.
    let work = tempfile::Builder::new()
        .prefix("kaifuu-238-partial-apply-accepts-complete")
        .tempdir()
        .expect("tempdir");
    let root = work.path();

    let original = root.join("original");
    let patched = root.join("patched");
    write_file(&original, "source.json", br#"{"units":[]}"#);
    write_file(
        &patched,
        "source.json",
        br#"{"units":[{"targetText":"Hello"}]}"#,
    );

    let delta_path = root.join("complete-source.kaifuu");
    let diff_output = run_cli(&[
        std::ffi::OsStr::new("diff"),
        original.as_os_str(),
        patched.as_os_str(),
        std::ffi::OsStr::new("--output"),
        delta_path.as_os_str(),
    ]);
    assert!(diff_output.status.success(), "diff must succeed");

    let delta: serde_json::Value =
        serde_json::from_slice(&fs::read(&delta_path).expect("read delta")).expect("parse delta");
    assert_eq!(delta["sourceProvenance"]["partial"], false);

    let output_dir = root.join("applied-output");
    let apply_output = run_cli(&[
        std::ffi::OsStr::new("apply"),
        original.as_os_str(),
        std::ffi::OsStr::new("--patch"),
        delta_path.as_os_str(),
        std::ffi::OsStr::new("--output"),
        output_dir.as_os_str(),
    ]);
    assert!(
        apply_output.status.success(),
        "apply must succeed for complete source provenance; status={:?}\nstderr={}",
        apply_output.status,
        String::from_utf8_lossy(&apply_output.stderr),
    );
    assert!(
        output_dir.join("source.json").exists(),
        "apply must materialize the patched source.json"
    );
}
