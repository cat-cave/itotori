//! Integration proof: an ACTUAL LAUNCHED browser
//! process emits text + choice observation events AND the broader scene
//! branch runtime event kinds () from the public MV/MZ fixture, and
//! the runtime-observation proof consumes that trace output to
//! render an E1 verdict with full bridge/source-revision/runtime-target/adapter
//! environment linkage.
//!
//! Two lanes:
//! - **Always-run:** a launched fake-browser SUBPROCESS genuinely *renders* the
//!   fixture (decodes the runtime base64 payload exactly as the page JS would)
//!   and emits the observation island on stdout, exactly as real Chromium
//!   `--dump-dom` does. The proof over that live-DOM trace is E1. This proves
//!   the whole launch -> trace -> proof pipeline through a real OS process
//!   WITHOUT requiring Chromium to be installed in the CI sandbox.
//! - **Real-browser gate:** when a browser-lane Chromium is explicitly
//!   provisioned via `UTSUSHI_BROWSER_BIN`, the same pipeline is driven through
//!   REAL headless Chromium for trace AND screenshot capture, and the E1 verdict
//!   with observation events is cross-checked against the committed real-launch
//!   evidence artifacts. This runs in the browser-e2e/oracle lane; the portable
//!   per-PR lane skips honestly (never fakes E1) — an arbitrary PATH Chrome is
//!   not used, since it is unpinned and not reproducible against the goldens.

use std::fs;
use std::path::{Path, PathBuf};

use serde_json::Value;
use utsushi_core::{RuntimeAdapter, RuntimeRequest};
use utsushi_fixture::BrowserLaunchAdapter;
use utsushi_fixture::mvmz_runtime_proof::{
    RuntimeObservationProofInputs, build_mvmz_runtime_observation_proof,
    mvmz_runtime_observation_proof_from_paths, read_static_fixture_source,
};

fn fixture_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/mvmz_observation")
}

fn proof_artifacts_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/mvmz_runtime_proof")
}

fn read_json(path: &Path) -> Value {
    serde_json::from_str(&fs::read_to_string(path).unwrap()).unwrap()
}

fn temp_dir(name: &str) -> PathBuf {
    use std::time::{SystemTime, UNIX_EPOCH};
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let dir = std::env::temp_dir().join(format!(
        "utsushi-u102-{name}-{}-{nonce}",
        std::process::id()
    ));
    fs::create_dir_all(&dir).unwrap();
    dir
}

/// The committed proof verdict is deterministic on a given platform: it embeds
/// none of the volatile launch fields (elapsed ms, screenshot byte size). This
/// lets the real-browser gate cross-check a freshly launched run byte-for-byte.
fn committed_proof() -> Value {
    read_json(&proof_artifacts_dir().join("proof.json"))
}

/// A launched fake browser that genuinely renders the fixture on stdout exactly
/// as real Chromium `--dump-dom` does: it reads the launched `file://`
/// entrypoint, decodes the runtime base64 payload, and emits the observation
/// island. The observed plaintext therefore only exists after a runtime render.
#[cfg(unix)]
const LIVE_DOM_FAKE_BROWSER: &str = r#"#!/bin/sh
set -eu
url=""
for arg in "$@"; do
  case "$arg" in
    file://*) url="$arg" ;;
  esac
done
[ -n "$url" ] || exit 70
path="${url#file://}"
b64=$(sed -n 's|.*type="application/base64">\([A-Za-z0-9+/=]*\)</script>.*|\1|p' "$path")
[ -n "$b64" ] || exit 71
json=$(printf '%s' "$b64" | base64 -d)
printf '<!doctype html><html><body><div id="messageWindow"></div>'
printf '<script id="utsushi-observed-events" type="application/json">'
printf '/*UTSUSHI-OBSERVED-BEGIN*/%s/*UTSUSHI-OBSERVED-END*/' "$json"
printf '</script></body></html>\n'
"#;

#[cfg(unix)]
fn write_fake_browser(dir: &Path, body: &str) -> PathBuf {
    use std::io::Write;
    use std::os::unix::fs::PermissionsExt;
    let path = dir.join("fake-browser.sh");
    let mut file = fs::File::create(&path).unwrap();
    file.write_all(body.as_bytes()).unwrap();
    file.flush().unwrap();
    fs::set_permissions(&path, fs::Permissions::from_mode(0o755)).unwrap();
    path
}

/// ALWAYS-RUN: a launched (fake) browser subprocess renders the fixture, the
/// trace probe observes the live-DOM text + choice events, and the
/// proof renders an E1 verdict with full linkage — no real Chromium
/// required.
#[cfg(unix)]
#[test]
fn launched_browser_process_trace_proves_e1_runtime_observation() {
    let work = temp_dir("fake-launch");
    let fake = write_fake_browser(&work, LIVE_DOM_FAKE_BROWSER);
    let adapter = BrowserLaunchAdapter::with_browser_program(fake);

    // The trace probe LAUNCHES the browser process and observes its live DOM.
    let trace = adapter.trace(&RuntimeRequest::new(&fixture_dir())).unwrap();
    assert_eq!(trace["evidenceTier"], "E1");

    let static_source = read_static_fixture_source(&fixture_dir()).unwrap();
    let proof = build_mvmz_runtime_observation_proof(&RuntimeObservationProofInputs {
        runtime_trace: &trace,
        static_fixture_source: &static_source,
        screenshot_evidence: None,
    })
    .unwrap();

    assert_eq!(
        proof["runtimeObservationProven"], true,
        "a launched-process live-DOM trace must prove E1: {proof}"
    );
    assert_eq!(proof["provenEvidenceTier"], "E1");
    assert_eq!(proof["observation"]["textEventCount"], 2);
    assert_eq!(proof["observation"]["choiceEventCount"], 1);
    // The broader event kinds beyond the text+choice surface.
    assert_eq!(proof["observation"]["sceneEventCount"], 1);
    assert_eq!(proof["observation"]["branchEventCount"], 1);
    assert_eq!(
        proof["observation"]["runtimeTargetId"],
        "fixture:mvmz-observation-fixture"
    );
    assert_eq!(proof["observation"]["adapterId"]["name"], "utsushi-browser");

    // The scene + branch observation events genuinely materialised from the
    // launched render, each with its own live-DOM observationSource.
    let obs = trace["observationHookEvents"].as_array().unwrap();
    assert_eq!(obs.len(), 5, "scene + 2 text + choice + branch observed");
    let scene = obs
        .iter()
        .find(|event| event["eventKind"] == "scene")
        .expect("a scene observation event was observed");
    assert_eq!(scene["observationSource"], "live_dom");
    assert_eq!(
        scene["payload"]["sceneName"],
        "The frost-veiled courtyard at winter dawn."
    );
    let branch = obs
        .iter()
        .find(|event| event["eventKind"] == "branch")
        .expect("a branch observation event was observed");
    assert_eq!(branch["observationSource"], "live_dom");
    assert_eq!(branch["payload"]["taken"], true);
    assert_eq!(
        branch["payload"]["destination"],
        "Scene_Map:winter-path-approach"
    );

    let _ = fs::remove_dir_all(work);
}

/// ALWAYS-RUN: the proof consumes the COMMITTED real-Chromium E1 evidence
/// (runtime trace + screenshot) and renders exactly the committed verdict. This
/// is the regression golden over the genuine launched-runtime output.
#[test]
fn committed_real_launch_evidence_reproduces_the_e1_proof() {
    let trace = read_json(&proof_artifacts_dir().join("runtime-trace.json"));
    let screenshot = read_json(&proof_artifacts_dir().join("screenshot-evidence.json"));
    let static_source = read_static_fixture_source(&fixture_dir()).unwrap();

    let proof = build_mvmz_runtime_observation_proof(&RuntimeObservationProofInputs {
        runtime_trace: &trace,
        static_fixture_source: &static_source,
        screenshot_evidence: Some(&screenshot),
    })
    .unwrap();

    assert_eq!(proof["runtimeObservationProven"], true);
    assert_eq!(proof["provenEvidenceTier"], "E1");
    assert_eq!(proof["screenshotEvidence"]["available"], true);
    assert_eq!(
        proof,
        committed_proof(),
        "proof over committed real-launch evidence must byte-match committed proof.json"
    );
}

/// Resolve a launchable real browser: ONLY an explicitly provisioned
/// `UTSUSHI_BROWSER_BIN` (the pinned dev-shell / browser-lane Chromium). Returns
/// None otherwise, so the gate skips. A generic Chromium that merely happens to
/// be on PATH (e.g. the hosted PR runner's preinstalled google-chrome) is NOT
/// used: it is unpinned and not the browser-lane binary, and auto-launching it
/// in the portable per-PR `just ci` lane false-reds CI (the launch/evidence
/// match is not reproducible against an arbitrary Chrome build). Real-browser
/// proofs belong to the browser-e2e / oracle lane, which sets
/// `UTSUSHI_BROWSER_BIN` via the nix dev-shell.
fn resolve_real_browser() -> Option<PathBuf> {
    let configured = std::env::var_os("UTSUSHI_BROWSER_BIN")?;
    let path = PathBuf::from(&configured);
    path.is_file().then_some(path)
}

/// REAL-BROWSER GATE: drive the whole pipeline through genuine headless
/// Chromium (trace + screenshot capture) and prove E1, cross-checking the
/// committed real-launch evidence. Skips honestly when no browser resolves —
/// it NEVER fabricates an E1 artifact from a static read.
#[test]
fn real_chromium_launch_proves_e1_and_matches_committed_evidence() {
    let Some(browser) = resolve_real_browser() else {
        eprintln!(
            "SKIP real_chromium_launch_proves_e1: no browser-lane Chromium provisioned \
             (set UTSUSHI_BROWSER_BIN). This browser proof runs in the browser-e2e/oracle lane; \
             the portable per-PR `just ci` lane skips it — an arbitrary PATH Chrome is not used."
        );
        return;
    };
    eprintln!(
        "real_chromium_launch_proves_e1: launching {}",
        browser.display()
    );

    let adapter = BrowserLaunchAdapter::with_browser_program(&browser);
    let artifacts = temp_dir("real-chromium-artifacts");

    // trace probe through real Chromium --dump-dom.
    let trace = adapter
        .trace(&RuntimeRequest::new(&fixture_dir()))
        .expect("real Chromium trace launch must succeed when a browser resolved");
    assert_eq!(trace["evidenceTier"], "E1");

    // screenshot capture through real Chromium --screenshot.
    let capture = adapter
        .capture(&RuntimeRequest::new(&fixture_dir()).with_artifact_root(&artifacts))
        .expect("real Chromium screenshot capture must succeed when a browser resolved");

    let static_source = read_static_fixture_source(&fixture_dir()).unwrap();
    let proof = build_mvmz_runtime_observation_proof(&RuntimeObservationProofInputs {
        runtime_trace: &trace,
        static_fixture_source: &static_source,
        screenshot_evidence: Some(&capture),
    })
    .unwrap();

    assert_eq!(
        proof["runtimeObservationProven"], true,
        "real Chromium launch must prove E1"
    );
    assert_eq!(proof["provenEvidenceTier"], "E1");
    assert_eq!(proof["screenshotEvidence"]["available"], true);

    // The freshly launched run reproduces the committed deterministic verdict.
    assert_eq!(
        proof,
        committed_proof(),
        "a fresh real-Chromium launch must reproduce the committed E1 proof verdict"
    );

    // And the freshly observed events match the committed real-launch trace
    // (the observed strings + linkage are deterministic; only launch timing is
    // not, which the proof verdict already excludes).
    let committed_trace = read_json(&proof_artifacts_dir().join("runtime-trace.json"));
    assert_eq!(
        trace["observationHookEvents"], committed_trace["observationHookEvents"],
        "fresh real-Chromium observation events must match the committed real-launch trace"
    );

    let _ = fs::remove_dir_all(artifacts);
}

/// STRICT-PROOF via the IO shell: the file-path entrypoint the CLI uses rejects
/// a trace a static read could have produced. Here a "trace" built from the
/// static source.json declared text (relabelled as live_dom E1) is fed through
/// the same shell + fixture dir the real proof uses, and is rejected.
#[test]
fn from_paths_rejects_a_static_read_forged_trace() {
    let work = temp_dir("forged-trace");
    // Lift the declared placeholder text straight out of the static source.
    let source_json = read_json(&fixture_dir().join("source.json"));
    let declared = source_json["units"][0]["targetText"].as_str().unwrap();
    let forged = serde_json::json!({
        "runtimeReportId": "forged-0001",
        "adapterName": "utsushi-browser",
        "evidenceTier": "E1",
        "observationHookEvents": [{
            "eventKind": "text",
            "runtimeTargetId": "fixture:mvmz-observation-fixture",
            "adapterId": {"name": "utsushi-browser", "version": "0.0.0"},
            "sourceRevision": {"sourceId": "mvmz-observation-fixture", "revisionId": "x"},
            "environment": {"runtime": "browser"},
            "bridgeRefs": [{"bridgeUnitId": "019ed000-0000-7000-8000-bridgeun0001", "sourceUnitKey": "mvmz.scene1.line1"}],
            "observationSource": "live_dom",
            "evidenceTier": "E1",
            "payload": {"payloadKind": "text", "text": declared}
        }],
        "traceEvents": []
    });
    let forged_path = work.join("forged-trace.json");
    fs::write(&forged_path, serde_json::to_string(&forged).unwrap()).unwrap();

    let proof =
        mvmz_runtime_observation_proof_from_paths(&forged_path, &fixture_dir(), None).unwrap();
    assert_eq!(
        proof["runtimeObservationProven"], false,
        "a trace built from static declared text must not satisfy E1"
    );
    assert_eq!(proof["provenEvidenceTier"], "none");

    let _ = fs::remove_dir_all(work);
}
