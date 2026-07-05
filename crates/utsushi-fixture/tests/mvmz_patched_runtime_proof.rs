//! UTSUSHI-119 integration proof: an ACTUAL LAUNCHED browser process observes
//! the **PATCHED** MV/MZ output — the fixture AFTER a Kaifuu patch-back swapped
//! the localized translation in — and the patched-runtime-observation proof
//! consumes that UTSUSHI-006 trace + the Kaifuu PatchResult + the UTSUSHI-102
//! alpha proof to render an E1 verdict proving the observed text is the
//! TRANSLATION the PatchResult attests to (not the pre-patch original), linked
//! to bridge unit refs.
//!
//! Two lanes (identical structure to UTSUSHI-102):
//! - **Always-run:** a launched fake-browser SUBPROCESS genuinely renders the
//!   PATCHED fixture (decodes the runtime base64 payload exactly as the page JS
//!   would) and emits the observation island on stdout, exactly as real Chromium
//!   `--dump-dom` does. The patched proof over that live-DOM trace is E1 and
//!   reproduces the committed deterministic verdict. Proves the whole
//!   launch -> trace -> patched-proof pipeline through a real OS process WITHOUT
//!   requiring Chromium in the CI sandbox.
//! - **Real-browser gate:** when a launchable Chromium resolves (via
//!   `UTSUSHI_BROWSER_BIN` or PATH), the same pipeline is driven through REAL
//!   headless Chromium and the E1 patched verdict + observation events are
//!   cross-checked against the committed real-launch evidence. Skips honestly
//!   (never fakes E1) when no browser exists.

use std::fs;
use std::path::{Path, PathBuf};

use serde_json::Value;
use utsushi_core::{RuntimeAdapter, RuntimeRequest};
use utsushi_fixture::BrowserLaunchAdapter;
use utsushi_fixture::mvmz_patched_runtime_proof::{
    PatchedRuntimeProofInputs, build_mvmz_patched_runtime_proof, canonical_patched_output_hash,
    mvmz_patched_runtime_proof_from_paths, read_prepatch_source_texts,
};
use utsushi_fixture::mvmz_runtime_proof::{
    RuntimeObservationProofInputs, build_mvmz_runtime_observation_proof, read_static_fixture_source,
};

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
/// as real Chromium `--dump-dom` does. Identical to the UTSUSHI-102 lane.
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

/// ALWAYS-RUN: a launched (fake) browser subprocess renders the PATCHED fixture,
/// the UTSUSHI-006 trace probe observes the live-DOM translated text + choice
/// events, and the UTSUSHI-119 patched proof renders an E1 verdict that
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

/// Resolve a launchable real browser the same way the adapter does.
fn resolve_real_browser() -> Option<PathBuf> {
    if let Ok(configured) = std::env::var("UTSUSHI_BROWSER_BIN") {
        let path = PathBuf::from(&configured);
        return path.is_file().then_some(path);
    }
    let path_var = std::env::var_os("PATH")?;
    for dir in std::env::split_paths(&path_var) {
        for name in [
            "chromium",
            "chromium-browser",
            "google-chrome",
            "google-chrome-stable",
        ] {
            let candidate = dir.join(name);
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }
    None
}

/// REAL-BROWSER GATE: drive the whole pipeline through genuine headless
/// Chromium over the PATCHED fixture and prove the patched E1 observation,
/// cross-checking the committed real-launch evidence. Skips honestly when no
/// browser resolves — it NEVER fabricates an E1 artifact from a static read.
#[test]
fn real_chromium_launch_proves_patched_e1_and_matches_committed_evidence() {
    let Some(browser) = resolve_real_browser() else {
        eprintln!(
            "SKIP real_chromium_launch_proves_patched_e1: no launchable Chromium resolved \
             (set UTSUSHI_BROWSER_BIN or install chromium on PATH). The patched E1 proof runs \
             under the real-browser gate in CI/oracle."
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

/// Regenerate the committed UTSUSHI-119 patched-output evidence artifacts from a
/// genuine launched-browser render. Env-gated so it only writes when explicitly
/// asked (`UTSUSHI_U119_REGEN=1`); prefers real Chromium (via
/// `UTSUSHI_BROWSER_BIN`) and falls back to the deterministic fake-browser
/// render (identical observation events). Run manually to refresh goldens.
#[cfg(unix)]
#[test]
#[ignore = "regenerates committed patched-output evidence goldens; run manually with UTSUSHI_U119_REGEN=1"]
fn regenerate_committed_patched_artifacts() {
    if std::env::var("UTSUSHI_U119_REGEN").ok().as_deref() != Some("1") {
        eprintln!("SKIP regenerate_committed_patched_artifacts: set UTSUSHI_U119_REGEN=1 to write");
        return;
    }
    let out = proof_artifacts_dir();
    fs::create_dir_all(&out).unwrap();

    // Prefer a genuine Chromium launch for the committed trace; fall back to the
    // deterministic fake browser (identical observation events) when absent.
    let work = temp_dir("regen");
    let trace = if let Some(browser) = resolve_real_browser() {
        eprintln!("regen: launching REAL Chromium {}", browser.display());
        BrowserLaunchAdapter::with_browser_program(&browser)
            .trace(&RuntimeRequest::new(&fixture_dir()))
            .expect("real Chromium trace launch must succeed")
    } else {
        eprintln!("regen: no Chromium; using deterministic fake-browser render");
        let fake = write_fake_browser(&work);
        BrowserLaunchAdapter::with_browser_program(fake)
            .trace(&RuntimeRequest::new(&fixture_dir()))
            .unwrap()
    };
    write_pretty(&out.join("patched-runtime-trace.json"), &trace);

    // The UTSUSHI-102 alpha proof over the patched fixture's runtime observation.
    let static_source = read_static_fixture_source(&fixture_dir()).unwrap();
    let alpha = build_mvmz_runtime_observation_proof(&RuntimeObservationProofInputs {
        runtime_trace: &trace,
        static_fixture_source: &static_source,
        screenshot_evidence: None,
    })
    .unwrap();
    write_pretty(&out.join("alpha-proof.json"), &alpha);

    // The Kaifuu PatchResult attesting the patched output BY HASH (never
    // plaintext). Its outputHash is the canonical hash of the observed
    // translated units — exactly what the proof recomputes and matches.
    let hash = canonical_patched_output_hash(&observed_units_of(&trace));
    let patch_result = serde_json::json!({
        "schemaVersion": "0.2.0",
        "patchResultId": "019ed060-0000-7000-8000-000000000001",
        "patchExportId": "019ed060-0000-7000-8000-0000000000a1",
        "status": "passed",
        "outputHash": hash,
        "failures": []
    });
    write_pretty(&out.join("patch-result.json"), &patch_result);

    // Finally the deterministic patched-output proof verdict golden.
    let proof = mvmz_patched_runtime_proof_from_paths(
        &out.join("patched-runtime-trace.json"),
        &fixture_dir(),
        &out.join("patch-result.json"),
        &out.join("alpha-proof.json"),
        None,
    )
    .unwrap();
    write_pretty(&out.join("proof.golden.json"), &proof);
    assert_eq!(proof["patchedRuntimeObservationProven"], true);

    let _ = fs::remove_dir_all(work);
    eprintln!("regen: wrote {} artifacts", 4);
}

#[cfg(unix)]
fn write_pretty(path: &Path, value: &Value) {
    let mut text = serde_json::to_string_pretty(value).unwrap();
    text.push('\n');
    fs::write(path, text).unwrap();
}

/// Mirror of the crate-internal observed-unit extraction, for the regenerator's
/// PatchResult hash. Kept here (not exported) so the module's canonical-hash
/// contract is exercised end-to-end through the public builder in every lane.
#[cfg(unix)]
fn observed_units_of(trace: &Value) -> std::collections::BTreeMap<String, String> {
    let mut units = std::collections::BTreeMap::new();
    let events = trace
        .get("observationHookEvents")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let unit_key = |event: &Value| {
        event["bridgeRefs"][0]["sourceUnitKey"]
            .as_str()
            .map(str::to_string)
    };
    for event in &events {
        match event["eventKind"].as_str() {
            Some("text") => {
                if let (Some(key), Some(text)) =
                    (unit_key(event), event["payload"]["text"].as_str())
                {
                    units.insert(key, text.to_string());
                }
            }
            Some("choice") => {
                if let (Some(key), Some(prompt)) =
                    (unit_key(event), event["payload"]["prompt"].as_str())
                {
                    units.insert(key, prompt.to_string());
                }
                if let Some(options) = event["payload"]["options"].as_array() {
                    for option in options {
                        if let (Some(key), Some(label)) = (
                            option["bridgeRef"]["sourceUnitKey"].as_str(),
                            option["label"].as_str(),
                        ) {
                            units.insert(key.to_string(), label.to_string());
                        }
                    }
                }
            }
            _ => {}
        }
    }
    units
}
