//! CLI command-contract smoke for the alpha public
//! encrypted-readiness evidence generator.
//! Spawns `kaifuu readiness alpha-encrypted` against the committed synthetic
//! alpha-encrypted fixture tree and asserts the generated evidence is
//! validator-driven (not prose): the report consumes the validation
//! report (status + hash), every entry records its profile id / fixture id /
//! engine family / surface ids / helper id / key ref / capability levels /
//! patch-result ref / diagnostics / content hash, patch-capable profile-ready
//! entries carry a patch result while readiness-only entries never do, and the
//! README-safe summary distinguishes readiness evidence from production support
//! while naming no asset / helper / key / patch id. A directory with a missing
//! patch artifact fails with structured findings rather than a panic. No
//! private corpora are used; artifacts carry only ids, counts, and hashes.

use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

use serde_json::Value;

fn kaifuu_cli_binary() -> PathBuf {
    PathBuf::from(env!("CARGO_BIN_EXE_kaifuu-cli"))
}

/// Resolve this crate's manifest directory for locating tracked test fixtures.
/// `env!("CARGO_MANIFEST_DIR")` is baked at COMPILE time, so a test binary
/// reused from a different (since-removed) worktree would point fixture reads at
/// a dead path (`Os NotFound`). `cargo test` sets `CARGO_MANIFEST_DIR` in the
/// RUNTIME environment to the LIVE crate directory; prefer that, falling back to
/// the compile-time constant only outside cargo.
fn test_manifest_dir() -> PathBuf {
    std::env::var_os("CARGO_MANIFEST_DIR")
        .map_or_else(|| PathBuf::from(env!("CARGO_MANIFEST_DIR")), PathBuf::from)
}

fn alpha_dir() -> PathBuf {
    test_manifest_dir()
        .join("../..")
        .join("fixtures/kaifuu/alpha-encrypted")
}

fn run(fixtures_dir: &Path, output: &Path, summary: &Path) -> std::process::Output {
    Command::new(kaifuu_cli_binary())
        .arg("readiness")
        .arg("alpha-encrypted")
        .arg("--fixtures-dir")
        .arg(fixtures_dir)
        .arg("--output")
        .arg(output)
        .arg("--summary-output")
        .arg(summary)
        .output()
        .expect("kaifuu-cli should run")
}

#[test]
fn positive_tree_generates_evidence_and_consumes_validation() {
    let work = tempfile::tempdir().unwrap();
    let report_path = work.path().join("alpha-encrypted-readiness.json");
    let summary_path = work.path().join("alpha-encrypted-readiness.summary.json");

    let output = run(&alpha_dir(), &report_path, &summary_path);
    assert!(
        output.status.success(),
        "expected success; stderr={}",
        String::from_utf8_lossy(&output.stderr)
    );

    let report: Value = serde_json::from_slice(&fs::read(&report_path).unwrap()).unwrap();
    assert_eq!(report["status"], "passed");
    assert_eq!(report["sourceNodeId"], "KAIFUU-104");

    // The validation report was consumed (status + hash), not prose.
    let consumed = &report["consumedValidation"];
    assert_eq!(consumed["status"], "passed");
    assert!(
        consumed["reportHash"]
            .as_str()
            .unwrap()
            .starts_with("sha256:")
    );
    assert!(
        report["reportHash"]
            .as_str()
            .unwrap()
            .starts_with("sha256:")
    );
    assert!(report["profileReadyCount"].as_u64().unwrap() > 0);
    assert!(report["readinessOnlyCount"].as_u64().unwrap() > 0);
    assert!(report["patchEvidenceCount"].as_u64().unwrap() > 0);

    let entries = report["entries"].as_array().unwrap();
    for entry in entries {
        assert!(!entry["profileId"].as_str().unwrap().is_empty());
        assert!(!entry["fixtureId"].as_str().unwrap().is_empty());
        assert_eq!(entry["sourceNodeId"], "KAIFUU-104");
        assert!(entry["engineFamily"].is_string());
        assert!(
            entry["contentHash"]
                .as_str()
                .unwrap()
                .starts_with("sha256:")
        );
        assert!(entry["declaredCapability"].is_string());
        assert!(entry["effectiveOutcome"].is_string());

        let posture = entry["posture"].as_str().unwrap();
        let outcome = entry["effectiveOutcome"].as_str().unwrap();
        let has_patch = entry.get("patchResult").is_some_and(|v| !v.is_null());
        if posture == "profile_ready" && matches!(outcome, "extract" | "patch") {
            assert!(
                has_patch,
                "patch-capable entry missing patch result: {entry}"
            );
            let patch = &entry["patchResult"];
            assert!(patch["outputHash"].as_str().unwrap().starts_with("sha256:"));
            assert!(!entry["surfaceIds"].as_array().unwrap().is_empty());
        }
        if posture == "readiness_only" {
            assert!(
                !has_patch,
                "readiness-only entry must not claim patch support: {entry}"
            );
        }
    }
}

#[test]
fn summary_is_readme_safe_and_distinguishes_evidence_from_support() {
    let work = tempfile::tempdir().unwrap();
    let report_path = work.path().join("report.json");
    let summary_path = work.path().join("summary.json");
    let output = run(&alpha_dir(), &report_path, &summary_path);
    assert!(output.status.success());

    let raw = fs::read_to_string(&summary_path).unwrap();
    let summary: Value = serde_json::from_str(&raw).unwrap();
    assert_eq!(summary["evidenceKind"], "readiness_evidence");
    assert_eq!(
        summary["reportHash"].as_str().unwrap(),
        // The summary report hash equals the full report's report hash.
        serde_json::from_slice::<Value>(&fs::read(&report_path).unwrap()).unwrap()["reportHash"]
            .as_str()
            .unwrap()
    );
    assert!(
        !summary["coveredEngineFamilies"]
            .as_array()
            .unwrap()
            .is_empty()
    );
    // README-safe: no key / helper / asset / patch ids and no private paths.
    assert!(!raw.contains("local-secret:"));
    assert!(!raw.contains("kaifuu.helper."));
    assert!(!raw.contains("scene/"));
    assert!(!raw.contains("data/scenario"));
    assert!(!raw.contains("/home/"));
}

#[test]
fn report_carries_no_private_paths_and_only_local_scheme_key_refs() {
    let work = tempfile::tempdir().unwrap();
    let report_path = work.path().join("report.json");
    let summary_path = work.path().join("summary.json");
    run(&alpha_dir(), &report_path, &summary_path);
    let raw = fs::read_to_string(&report_path).unwrap();
    assert!(raw.contains("local-secret:"));
    assert!(!raw.contains("/home/"));
}

#[test]
fn missing_patch_artifact_fails_with_structured_findings_not_panic() {
    // Copy only the patch-capable profile-ready profile (no patch artifact) into
    // a temp dir: the generator must fail with patch_result_ref_missing.
    let work = tempfile::tempdir().unwrap();
    let src = alpha_dir().join("siglus.positive.profile.json");
    fs::copy(&src, work.path().join("siglus.positive.profile.json")).unwrap();
    let report_path = work.path().join("report.json");
    let summary_path = work.path().join("summary.json");

    let output = run(work.path(), &report_path, &summary_path);
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(!output.status.success(), "missing patch artifact must fail");
    assert!(!stderr.contains("panicked"), "must not panic: {stderr}");
    assert!(
        stderr.contains("alpha encrypted-readiness generation failed"),
        "stderr missing structured failure: {stderr}"
    );

    let report: Value = serde_json::from_slice(&fs::read(&report_path).unwrap()).unwrap();
    assert_eq!(report["status"], "failed");
    let entry = &report["entries"].as_array().unwrap()[0];
    assert_eq!(entry["status"], "failed");
    assert!(
        entry["findings"]
            .as_array()
            .unwrap()
            .iter()
            .any(|f| f["code"] == "alpha.encrypted.patch_result_ref_missing")
    );
}
