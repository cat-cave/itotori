//! UTSUSHI-010: MV/MZ play-test evidence manifest tests.
//!
//! These prove that the manifest aggregates the merged MV/MZ proof surfaces —
//! patch artifacts, UTSUSHI-006 + UTSUSHI-033 runtime trace evidence, and
//! UTSUSHI-065 screenshot artifact refs — that it names LIMITATIONS, exports
//! standalone (no annotation / no feedback import), and that unsupported host
//! capabilities surface as
//! non-silent SEMANTIC diagnostics + recorded limitations.

use std::path::{Path, PathBuf};

use serde_json::Value;

use utsushi_fixture::mv_mz_review_package::{
    HostCapabilities, ReviewPackageInputs, build_mv_mz_review_package_manifest,
    mv_mz_review_package_manifest_from_paths,
};

fn fixture_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/mvmz_review_package")
}

fn patch_export_path() -> PathBuf {
    fixture_root().join("patch_export.json")
}

fn runtime_evidence_path() -> PathBuf {
    fixture_root().join("runtime_evidence.json")
}

fn replay_pack_path() -> PathBuf {
    fixture_root().join("replay_pack_trace.json")
}

fn read_json(path: &Path) -> Value {
    serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
}

fn supported_host_manifest() -> Value {
    mv_mz_review_package_manifest_from_paths(
        &patch_export_path(),
        &runtime_evidence_path(),
        Some(&replay_pack_path()),
        HostCapabilities::supported(),
    )
    .unwrap()
}

#[test]
fn manifest_matches_committed_golden_bytes() {
    let manifest = supported_host_manifest();
    let mut rendered = serde_json::to_string_pretty(&manifest).unwrap();
    rendered.push('\n');
    let golden = std::fs::read_to_string(fixture_root().join("manifest.golden.json")).unwrap();
    assert_eq!(
        rendered, golden,
        "mvmz review-package manifest drifted from the committed golden; \
         regenerate the golden if the change is intended"
    );
}

#[test]
fn manifest_names_all_required_surfaces() {
    let manifest = supported_host_manifest();

    // Patch artifacts: named by export id, locales, entry count, content hash.
    let patch_artifacts = manifest["patchArtifacts"].as_array().unwrap();
    assert_eq!(patch_artifacts.len(), 1);
    let patch = &patch_artifacts[0];
    assert_eq!(
        patch["patchExportId"],
        "0192b010-0000-7000-8000-0000000000a1"
    );
    assert_eq!(patch["entryCount"], 3);
    assert!(
        patch["contentHash"]
            .as_str()
            .unwrap()
            .starts_with("sha256:")
    );

    // Runtime trace evidence: UTSUSHI-006 observation + UTSUSHI-033 replay pack.
    let trace = &manifest["runtimeTraceEvidence"];
    assert_eq!(trace["observation"]["source"], "UTSUSHI-006");
    assert_eq!(trace["observation"]["traceEventCount"], 3);
    assert_eq!(trace["observation"]["observationHookEventCount"], 3);
    assert_eq!(trace["replayPack"]["source"], "UTSUSHI-033");
    assert_eq!(trace["replayPack"]["available"], true);
    assert_eq!(trace["replayPack"]["linkedEventCount"], 2);

    // Screenshot artifact refs: present WHEN AVAILABLE, linked to trace events.
    let screenshots = &manifest["screenshotArtifactRefs"];
    assert_eq!(screenshots["availability"], "available");
    let refs = screenshots["refs"].as_array().unwrap();
    assert_eq!(refs.len(), 3);
    assert_eq!(refs[0]["artifactRef"]["artifactKind"], "screenshot");
    assert!(refs[0]["evidencesTraceEventId"].is_string());
    assert!(refs[0]["bridgeUnitRef"]["bridgeUnitId"].is_string());

    // Limitations: a non-empty honest-limits list.
    assert!(!manifest["limitations"].as_array().unwrap().is_empty());

    // Evidence packages describe proof surfaces only; they do not advertise
    // per-unit workflow actions or a feedback-routing protocol.
    assert!(
        manifest
            .as_object()
            .unwrap()
            .keys()
            .all(|key| !key.ends_with("Actions"))
    );
}

#[test]
fn manifest_export_needs_no_annotation_or_feedback_import() {
    // Build the manifest from ONLY the three evidence surfaces — patch export,
    // runtime evidence report, replay-pack trace — with no annotation handling
    // and no feedback import in sight. The property is structural: the builder
    // has no annotation/feedback parameter, so a manifest always exports
    // standalone.
    let patch_export = read_json(&patch_export_path());
    let runtime_evidence_report = read_json(&runtime_evidence_path());
    let replay_pack_trace = read_json(&replay_pack_path());

    let manifest = build_mv_mz_review_package_manifest(&ReviewPackageInputs {
        patch_export: &patch_export,
        runtime_evidence_report: &runtime_evidence_report,
        replay_pack_trace: Some(&replay_pack_trace),
        host: HostCapabilities::supported(),
    })
    .unwrap();

    // The manifest carries no imported annotation / feedback payload or
    // workflow action surface.
    let serialized = serde_json::to_string(&manifest).unwrap();
    assert!(!serialized.contains("annotation"));
    assert!(!serialized.contains("workflowAction"));
}

#[test]
fn unsupported_screenshot_host_produces_semantic_diagnostic_and_limitation() {
    let manifest = mv_mz_review_package_manifest_from_paths(
        &patch_export_path(),
        &runtime_evidence_path(),
        Some(&replay_pack_path()),
        HostCapabilities {
            browser_available: true,
            screenshot_capture: false,
        },
    )
    .unwrap();

    // Screenshot evidence is recorded as unavailable — NOT silently omitted.
    let screenshots = &manifest["screenshotArtifactRefs"];
    assert_eq!(screenshots["availability"], "unavailable");
    assert!(screenshots["reason"].is_string());
    assert!(screenshots["refs"].as_array().unwrap().is_empty());

    // A machine-readable semantic diagnostic fired.
    let diagnostics = manifest["diagnostics"].as_array().unwrap();
    let screenshot_diag = diagnostics
        .iter()
        .find(|d| d["surface"] == "screenshot_artifact_refs")
        .expect("expected a screenshot-surface diagnostic");
    assert_eq!(
        screenshot_diag["semanticCode"],
        "utsushi.review_package.screenshot_capture_unsupported"
    );
    assert_eq!(screenshot_diag["severity"], "warning");
    assert_eq!(screenshot_diag["semantic"], true);

    // And a matching limitation was recorded.
    let limitations: Vec<&str> = manifest["limitations"]
        .as_array()
        .unwrap()
        .iter()
        .map(|l| l.as_str().unwrap())
        .collect();
    assert!(
        limitations
            .iter()
            .any(|l| l.contains("Screenshot evidence unavailable"))
    );
}

#[test]
fn unavailable_browser_forces_screenshot_unavailable() {
    let manifest = mv_mz_review_package_manifest_from_paths(
        &patch_export_path(),
        &runtime_evidence_path(),
        Some(&replay_pack_path()),
        HostCapabilities {
            browser_available: false,
            screenshot_capture: false,
        },
    )
    .unwrap();

    assert_eq!(
        manifest["screenshotArtifactRefs"]["availability"],
        "unavailable"
    );
    let diagnostics = manifest["diagnostics"].as_array().unwrap();
    assert!(diagnostics.iter().any(|d| {
        d["semanticCode"] == "utsushi.review_package.browser_unavailable"
            && d["severity"] == "warning"
    }));
}

#[test]
fn claimed_screenshot_capture_but_no_captures_is_error_diagnostic() {
    // A host that ADVERTISES screenshot capture but whose runtime report has no
    // captures is a contradiction that must not silently pass.
    let patch_export = read_json(&patch_export_path());
    let mut runtime_evidence_report = read_json(&runtime_evidence_path());
    runtime_evidence_report["captures"] = Value::Array(vec![]);

    let manifest = build_mv_mz_review_package_manifest(&ReviewPackageInputs {
        patch_export: &patch_export,
        runtime_evidence_report: &runtime_evidence_report,
        replay_pack_trace: None,
        host: HostCapabilities::supported(),
    })
    .unwrap();

    assert_eq!(
        manifest["screenshotArtifactRefs"]["availability"],
        "unavailable"
    );
    let diagnostics = manifest["diagnostics"].as_array().unwrap();
    assert!(diagnostics.iter().any(|d| {
        d["semanticCode"] == "utsushi.review_package.screenshot_evidence_missing"
            && d["severity"] == "error"
    }));
}

#[test]
fn absent_replay_pack_is_recorded_not_silent() {
    let manifest = mv_mz_review_package_manifest_from_paths(
        &patch_export_path(),
        &runtime_evidence_path(),
        None,
        HostCapabilities::supported(),
    )
    .unwrap();

    assert_eq!(
        manifest["runtimeTraceEvidence"]["replayPack"]["available"],
        false
    );
    let diagnostics = manifest["diagnostics"].as_array().unwrap();
    assert!(
        diagnostics
            .iter()
            .any(|d| { d["semanticCode"] == "utsushi.review_package.replay_pack_absent" })
    );
}
