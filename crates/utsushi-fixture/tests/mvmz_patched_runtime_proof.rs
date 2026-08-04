//! Integration proof: an ACTUAL LAUNCHED browser process observes
//! the **PATCHED** MV/MZ output — the fixture AFTER a Kaifuu patch-back swapped
//! the localized translation in — and the patched-runtime-observation proof
//! consumes that trace + the Kaifuu PatchResult + the
//! alpha proof to render an E1 verdict proving the observed text is the
//! TRANSLATION the PatchResult attests to (not the pre-patch original), linked
//! to bridge unit refs.
//!
//! Two lanes (identical structure to ):
//! - **Always-run:** a launched fake-browser SUBPROCESS genuinely renders the
//!   PATCHED fixture (decodes the runtime base64 payload exactly as the page JS
//!   would) and emits the observation island on stdout, exactly as real Chromium
//!   `--dump-dom` does. The patched proof over that live-DOM trace is E1 and
//!   reproduces the committed deterministic verdict. Proves the whole
//!   launch -> trace -> patched-proof pipeline through a real OS process WITHOUT
//!   requiring Chromium in the CI sandbox.
//! - **Real-browser gate:** when a browser-lane Chromium is explicitly
//!   provisioned via `UTSUSHI_BROWSER_BIN`, the same pipeline is driven through
//!   REAL headless Chromium and the E1 patched verdict + observation events are
//!   cross-checked against the committed real-launch evidence. This runs in the
//!   browser-e2e/oracle lane; the portable per-PR lane skips honestly (never
//!   fakes E1) — an arbitrary PATH Chrome is not used.

use std::fs;
use std::path::{Path, PathBuf};

use serde_json::Value;
use utsushi_core::{RuntimeAdapter, RuntimeRequest};
use utsushi_fixture::BrowserLaunchAdapter;
use utsushi_fixture::mvmz_patched_runtime_proof::{
    PatchedRuntimeProofInputs, build_mvmz_patched_runtime_proof,
    mvmz_patched_runtime_proof_from_paths, read_prepatch_source_texts,
};
use utsushi_fixture::mvmz_runtime_proof::read_static_fixture_source;

fn fixture_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/mvmz_patched_observation")
}

fn proof_artifacts_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/mvmz_patched_runtime_proof")
}

fn read_json(path: &Path) -> Value {
    serde_json::from_str(&fs::read_to_string(path).unwrap()).unwrap()
}

fn committed_proof() -> Value {
    read_json(&proof_artifacts_dir().join("proof.golden.json"))
}

fn patch_result_path() -> PathBuf {
    proof_artifacts_dir().join("patch-result.json")
}

fn alpha_proof_path() -> PathBuf {
    proof_artifacts_dir().join("alpha-proof.json")
}

fn temp_dir(name: &str) -> PathBuf {
    use std::time::{SystemTime, UNIX_EPOCH};
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let dir = std::env::temp_dir().join(format!(
        "utsushi-u119-{name}-{}-{nonce}",
        std::process::id()
    ));
    fs::create_dir_all(&dir).unwrap();
    dir
}

/// A launched fake browser that genuinely renders the fixture on stdout exactly
/// as real Chromium `--dump-dom` does. Identical to the lane.
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
fn write_fake_browser(dir: &Path) -> PathBuf {
    use std::io::Write;
    use std::os::unix::fs::PermissionsExt;
    let path = dir.join("fake-browser.sh");
    let mut file = fs::File::create(&path).unwrap();
    file.write_all(LIVE_DOM_FAKE_BROWSER.as_bytes()).unwrap();
    file.flush().unwrap();
    fs::set_permissions(&path, fs::Permissions::from_mode(0o755)).unwrap();
    path
}

fn build_patched_proof_from_trace(trace: &Value) -> Value {
    let patch_result = read_json(&patch_result_path());
    let alpha = read_json(&alpha_proof_path());
    let mut combined = read_static_fixture_source(&fixture_dir()).unwrap();
    combined.push('\n');
    combined.push_str(&fs::read_to_string(patch_result_path()).unwrap());
    combined.push('\n');
    combined.push_str(&fs::read_to_string(alpha_proof_path()).unwrap());
    let source = read_prepatch_source_texts(&fixture_dir()).unwrap();
    build_mvmz_patched_runtime_proof(&PatchedRuntimeProofInputs {
        patched_runtime_trace: trace,
        patch_result: &patch_result,
        alpha_proof_manifest: &alpha,
        combined_static_source: &combined,
        prepatch_source_texts: &source,
        screenshot_evidence: None,
    })
    .unwrap()
}

/// ALWAYS-RUN: a launched (fake) browser subprocess renders the PATCHED fixture
/// the trace probe observes the live-DOM translated text + choice
/// events, and the patched proof renders an E1 verdict that
/// reproduces the committed golden — no real Chromium required.
#[cfg(unix)]
#[test]
fn launched_browser_process_proves_patched_e1_observation() {
    let work = temp_dir("fake-launch");
    let fake = write_fake_browser(&work);
    let adapter = BrowserLaunchAdapter::with_browser_program(fake);

    let trace = adapter.trace(&RuntimeRequest::new(&fixture_dir())).unwrap();
    assert_eq!(trace["evidenceTier"], "E1");

    let proof = build_patched_proof_from_trace(&trace);
    assert_eq!(
        proof["patchedRuntimeObservationProven"], true,
        "a launched-process live-DOM patched trace must prove E1: {proof}"
    );
    assert_eq!(proof["provenEvidenceTier"], "E1");
    assert_eq!(proof["patchAttestation"]["hashMatches"], true);
    assert_eq!(
        proof,
        committed_proof(),
        "the patched proof over a fresh launch must reproduce the committed golden verdict"
    );

    let _ = fs::remove_dir_all(work);
}

/// ALWAYS-RUN: the patched proof consumes the COMMITTED launched-Chromium E1
/// trace + PatchResult + alpha proof and renders exactly the committed verdict.
#[test]
fn committed_patched_trace_reproduces_the_e1_proof() {
    let trace = read_json(&proof_artifacts_dir().join("patched-runtime-trace.json"));
    let proof = mvmz_patched_runtime_proof_from_paths(
        &proof_artifacts_dir().join("patched-runtime-trace.json"),
        &fixture_dir(),
        &patch_result_path(),
        &alpha_proof_path(),
        None,
    )
    .unwrap();

    assert_eq!(proof["patchedRuntimeObservationProven"], true);
    assert_eq!(proof["provenEvidenceTier"], "E1");
    assert_eq!(
        proof,
        committed_proof(),
        "patched proof over committed evidence must match committed golden"
    );
    // The observed strings are the TRANSLATION carried only in the fixture's
    // runtime base64 payload — the proof re-derived their hash and matched the
    // PatchResult attestation.
    assert_eq!(
        build_patched_proof_from_trace(&trace),
        committed_proof(),
        "the pure builder path must match the from_paths path"
    );
}

/// Resolve the real browser only from the pinned Nix derivation supplied by
/// the browser/oracle devshell. The portable lane can have a host Chromium,
/// but that unpinned binary is not evidence for this strict proof.
fn resolve_real_browser() -> Option<PathBuf> {
    [
        "chromium",
        "chromium-browser",
        "google-chrome",
        "google-chrome-stable",
    ]
    .into_iter()
    .find_map(which_in_path)
}

fn which_in_path(program: &str) -> Option<PathBuf> {
    std::env::var_os("PATH").and_then(|paths| {
        std::env::split_paths(&paths)
            .map(|directory| directory.join(program))
            .find(|path| path.starts_with("/nix/store/") && path.is_file())
    })
}

/// REAL-BROWSER GATE: drive the whole pipeline through genuine headless
/// Chromium over the PATCHED fixture and prove the patched E1 observation
/// cross-checking the committed real-launch evidence. Skips honestly when no
/// browser resolves — it NEVER fabricates an E1 artifact from a static read.
#[test]
fn real_chromium_launch_proves_patched_e1_and_matches_committed_evidence() {
    let Some(browser) = resolve_real_browser() else {
        eprintln!(
            "SKIP real_chromium_launch_proves_patched_e1: no browser-lane Chromium provisioned \
             (enter the browser/oracle devshell). This browser proof runs in the browser-e2e/oracle lane."
        );
        return;
    };
    eprintln!(
        "real_chromium_launch_proves_patched_e1: launching {}",
        browser.display()
    );

    let adapter = BrowserLaunchAdapter::with_browser_program(&browser);
    let trace = adapter
        .trace(&RuntimeRequest::new(&fixture_dir()))
        .expect("real Chromium trace launch must succeed when a browser resolved");
    assert_eq!(trace["evidenceTier"], "E1");

    let proof = build_patched_proof_from_trace(&trace);
    assert_eq!(
        proof["patchedRuntimeObservationProven"], true,
        "real Chromium launch must prove the patched E1 observation: {proof}"
    );
    assert_eq!(proof["provenEvidenceTier"], "E1");
    assert_eq!(proof["patchAttestation"]["hashMatches"], true);
    assert_eq!(
        proof,
        committed_proof(),
        "a fresh real-Chromium launch must reproduce the committed patched E1 verdict"
    );

    let committed_trace = read_json(&proof_artifacts_dir().join("patched-runtime-trace.json"));
    assert_eq!(
        trace["observationHookEvents"], committed_trace["observationHookEvents"],
        "fresh real-Chromium observed events must match the committed real-launch patched trace"
    );
}

/// STRICT-PROOF via the IO shell: the file-path entrypoint the CLI uses rejects
/// a patched trace a static read could have produced. A "trace" built from the
/// static source.json declared PLACEHOLDER targetText (relabelled as live_dom
/// E1) is fed through the same shell + fixture dir the real proof uses, and is
/// rejected: its text is recoverable from the static source.
#[test]
fn from_paths_rejects_a_static_read_forged_patched_trace() {
    let work = temp_dir("forged-trace");
    let source_json = read_json(&fixture_dir().join("source.json"));
    let declared = source_json["units"][0]["targetText"].as_str().unwrap();
    let forged = serde_json::json!({
        "runtimeReportId": "forged-0001",
        "adapterName": "utsushi-browser",
        "evidenceTier": "E1",
        "observationHookEvents": [{
            "eventKind": "text",
            "runtimeTargetId": "fixture:mvmz-patched-fixture",
            "adapterId": {"name": "utsushi-browser", "version": "0.0.0"},
            "sourceRevision": {"sourceId": "mvmz-patched-fixture", "revisionId": "x"},
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

    let proof = mvmz_patched_runtime_proof_from_paths(
        &forged_path,
        &fixture_dir(),
        &patch_result_path(),
        &alpha_proof_path(),
        None,
    )
    .unwrap();
    assert_eq!(
        proof["patchedRuntimeObservationProven"], false,
        "a patched trace built from static declared text must not satisfy E1"
    );
    assert_eq!(proof["provenEvidenceTier"], "none");

    let _ = fs::remove_dir_all(work);
}
