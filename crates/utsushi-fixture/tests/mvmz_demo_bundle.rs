//! Integration proof: the MV/MZ **embedded playback demo bundle**
//! PACKAGES the committed patched proof + alpha proof
//! patched trace + review manifest
//! screenshot evidence into ONE self-contained descriptor a public playback
//! surface can render — links observed text / choices to bridge unit refs
//! validates the screenshot capture references, and re-checks the packaged proof
//! verdicts, WITHOUT re-deriving any of them.

use std::fs;
use std::path::{Path, PathBuf};

use serde_json::Value;
use utsushi_fixture::mvmz_demo_bundle::{
    CHECK_CAPTURE_REFS_VALIDATED, CHECK_CAPTURES_AGREE_WITH_REVIEW_MANIFEST,
    CHECK_OBSERVATION_COVERS_PROVEN_UNITS, CHECK_OBSERVATION_EVENTS_BRIDGE_LINKED,
    CHECK_PATCHED_PROOF_PROVEN_E1, DEMO_BUNDLE_KIND, DemoBundleInputs, build_mvmz_demo_bundle,
    mvmz_demo_bundle_from_paths,
};

fn fixtures() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures")
}

fn patched_proof_path() -> PathBuf {
    fixtures().join("mvmz_patched_runtime_proof/proof.golden.json")
}

fn alpha_proof_path() -> PathBuf {
    fixtures().join("mvmz_patched_runtime_proof/alpha-proof.json")
}

fn patch_result_path() -> PathBuf {
    fixtures().join("mvmz_patched_runtime_proof/patch-result.json")
}

fn patched_trace_path() -> PathBuf {
    fixtures().join("mvmz_patched_runtime_proof/patched-runtime-trace.json")
}

fn review_manifest_path() -> PathBuf {
    fixtures().join("mvmz_review_package/manifest.golden.json")
}

fn screenshot_evidence_path() -> PathBuf {
    fixtures().join("mvmz_screenshot_evidence/evidence.golden.json")
}

fn bundle_golden_path() -> PathBuf {
    fixtures().join("mvmz_demo_bundle/bundle.golden.json")
}

fn read_json(path: &Path) -> Value {
    serde_json::from_str(&fs::read_to_string(path).unwrap()).unwrap()
}

fn committed_bundle() -> Value {
    read_json(&bundle_golden_path())
}

fn built_bundle() -> Value {
    mvmz_demo_bundle_from_paths(
        &patched_proof_path(),
        &alpha_proof_path(),
        &patch_result_path(),
        &patched_trace_path(),
        &review_manifest_path(),
        &screenshot_evidence_path(),
    )
    .unwrap()
}

fn check_status<'a>(bundle: &'a Value, check_id: &str) -> &'a str {
    bundle["validation"]["checks"]
        .as_array()
        .unwrap()
        .iter()
        .find(|check| check["checkId"] == check_id)
        .unwrap_or_else(|| panic!("missing check {check_id}"))["status"]
        .as_str()
        .unwrap()
}

#[test]
fn demo_bundle_matches_committed_golden_bytes() {
    let bundle = built_bundle();
    let mut rendered = serde_json::to_string_pretty(&bundle).unwrap();
    rendered.push('\n');
    let golden = fs::read_to_string(bundle_golden_path()).unwrap();
    assert_eq!(
        rendered, golden,
        "mvmz demo-bundle drifted from the committed golden; regenerate with \
         UTSUSHI_U134_REGEN=1 if the change is intended"
    );
}

#[test]
fn bundle_is_valid_and_packages_the_proof_links() {
    let bundle = built_bundle();
    assert_eq!(bundle["bundleKind"], DEMO_BUNDLE_KIND);
    assert_eq!(bundle["bundleValid"], true, "{bundle}");
    assert_eq!(bundle["provenEvidenceTier"], "E1");

    // The playback surface is public + not a live game.
    assert_eq!(
        bundle["playbackSurface"]["surfaceKind"],
        "patched_mvmz_fixture"
    );
    assert_eq!(bundle["playbackSurface"]["live"], false);
    assert_eq!(bundle["playbackSurface"]["public"], true);

    // Proof links reference the artifacts by id/verdict.
    let links = &bundle["proofLinks"];
    assert_eq!(links["patchedRuntimeProof"]["source"], "UTSUSHI-119");
    assert_eq!(
        links["patchedRuntimeProof"]["patchedRuntimeObservationProven"],
        true
    );
    assert_eq!(links["patchedRuntimeProof"]["provenEvidenceTier"], "E1");
    assert_eq!(links["alphaProof"]["source"], "UTSUSHI-102");
    assert_eq!(links["alphaProof"]["runtimeObservationProven"], true);
    assert_eq!(links["screenshotEvidence"]["source"], "UTSUSHI-065");
    assert_eq!(bundle["reviewManifest"]["source"], "UTSUSHI-010");

    // The packaged patched-proof id is the committed 119 proof id (packaging
    // not re-derivation).
    let committed_119 = read_json(&patched_proof_path());
    assert_eq!(
        links["patchedRuntimeProof"]["proofId"],
        committed_119["proofId"]
    );
    assert_eq!(
        links["patchedRuntimeProof"]["patchResultOutputHash"],
        committed_119["patchAttestation"]["patchResultOutputHash"]
    );
}

#[test]
fn observation_envelope_links_text_and_choices_to_bridge_units() {
    let bundle = built_bundle();
    let events = bundle["observationEnvelope"]["events"].as_array().unwrap();
    // Two dialogue lines + one choice, exactly as the patched trace observed.
    assert_eq!(events.len(), 3);

    let text_events: Vec<&Value> = events.iter().filter(|e| e["eventKind"] == "text").collect();
    assert_eq!(text_events.len(), 2);
    for event in &text_events {
        assert!(event["bridgeUnitRef"]["bridgeUnitId"].is_string());
        assert!(event["bridgeUnitRef"]["sourceUnitKey"].is_string());
        assert!(!event["text"].as_str().unwrap().is_empty());
    }
    // The observed TRANSLATION (not the pre-patch Japanese source) is carried.
    assert_eq!(
        text_events[0]["text"],
        "The lighthouse keeps watch over the quiet cove."
    );
    assert_eq!(text_events[0]["speaker"], "Mira");

    let choice = events.iter().find(|e| e["eventKind"] == "choice").unwrap();
    assert_eq!(choice["prompt"], "What will you do?");
    let options = choice["options"].as_array().unwrap();
    assert_eq!(options.len(), 2);
    for option in options {
        assert!(option["bridgeUnitRef"]["bridgeUnitId"].is_string());
        assert!(!option["label"].as_str().unwrap().is_empty());
    }

    assert_eq!(
        check_status(&bundle, CHECK_OBSERVATION_EVENTS_BRIDGE_LINKED),
        "pass"
    );
    assert_eq!(
        check_status(&bundle, CHECK_OBSERVATION_COVERS_PROVEN_UNITS),
        "pass"
    );
}

#[test]
fn capture_refs_are_validated_and_agree_with_the_review_manifest() {
    let bundle = built_bundle();
    let refs = bundle["captureRefs"]["refs"].as_array().unwrap();
    assert_eq!(bundle["captureRefs"]["availability"], "available");
    assert_eq!(refs.len(), 3);
    for capture in refs {
        assert_eq!(capture["validated"], true);
        // The artifactRef resolves to a managed runtime URI + a content-addressed
        // ref hash + a bridge unit ref + the trace event it evidences.
        assert!(
            capture["artifactRef"]["uri"]
                .as_str()
                .unwrap()
                .starts_with("artifacts/utsushi/runtime/")
        );
        assert!(capture["refHash"].as_str().unwrap().starts_with("sha256:"));
        assert!(capture["bridgeUnitRef"]["bridgeUnitId"].is_string());
        assert!(capture["evidencesTraceEventId"].is_string());
        assert_eq!(capture["validation"]["uriManaged"], true);
    }
    assert_eq!(check_status(&bundle, CHECK_CAPTURE_REFS_VALIDATED), "pass");
    assert_eq!(
        check_status(&bundle, CHECK_CAPTURES_AGREE_WITH_REVIEW_MANIFEST),
        "pass"
    );
}

#[test]
fn tampered_capture_uri_fails_validation() {
    // A capture whose artifactRef URI is not a managed runtime URI must not
    // validate — the bundle refuses to surface an unmanaged (possibly
    // host-path / data:) artifact reference.
    let mut evidence = read_json(&screenshot_evidence_path());
    evidence["captures"][0]["artifactRef"]["uri"] =
        Value::String("file:///home/trevor/secret.png".to_string());

    let bundle = build_mvmz_demo_bundle(&DemoBundleInputs {
        patched_runtime_proof: &read_json(&patched_proof_path()),
        alpha_proof: &read_json(&alpha_proof_path()),
        patch_result: &read_json(&patch_result_path()),
        patched_runtime_trace: &read_json(&patched_trace_path()),
        review_manifest: &read_json(&review_manifest_path()),
        screenshot_evidence: &evidence,
    })
    .unwrap();

    assert_eq!(bundle["bundleValid"], false);
    assert_eq!(check_status(&bundle, CHECK_CAPTURE_REFS_VALIDATED), "fail");
    assert_eq!(bundle["captureRefs"]["refs"][0]["validated"], false);
    assert_eq!(
        bundle["captureRefs"]["refs"][0]["validation"]["uriManaged"],
        false
    );
}

#[test]
fn unproven_patched_proof_invalidates_the_bundle() {
    // The bundle packages proof VERDICTS; if the packaged 119 proof is not a
    // proven E1 patched proof, the bundle is not valid. (Packaging, not
    // re-deriving: the verdict is READ from the committed artifact.)
    let mut proof = read_json(&patched_proof_path());
    proof["patchedRuntimeObservationProven"] = Value::Bool(false);
    proof["provenEvidenceTier"] = Value::String("none".to_string());

    let bundle = build_mvmz_demo_bundle(&DemoBundleInputs {
        patched_runtime_proof: &proof,
        alpha_proof: &read_json(&alpha_proof_path()),
        patch_result: &read_json(&patch_result_path()),
        patched_runtime_trace: &read_json(&patched_trace_path()),
        review_manifest: &read_json(&review_manifest_path()),
        screenshot_evidence: &read_json(&screenshot_evidence_path()),
    })
    .unwrap();

    assert_eq!(bundle["bundleValid"], false);
    assert_eq!(bundle["provenEvidenceTier"], "none");
    assert_eq!(check_status(&bundle, CHECK_PATCHED_PROOF_PROVEN_E1), "fail");
}

/// Regenerate the committed demo-bundle golden from the committed
/// upstream artifacts. Env-gated so it only writes when explicitly asked.
#[test]
#[ignore = "regenerates the committed demo-bundle golden; run manually with UTSUSHI_U134_REGEN=1"]
fn regenerate_committed_demo_bundle_golden() {
    if std::env::var("UTSUSHI_U134_REGEN").ok().as_deref() != Some("1") {
        eprintln!(
            "SKIP regenerate_committed_demo_bundle_golden: set UTSUSHI_U134_REGEN=1 to write"
        );
        return;
    }
    let bundle = built_bundle();
    assert_eq!(
        bundle["bundleValid"], true,
        "refusing to write an invalid golden"
    );
    let out = bundle_golden_path();
    fs::create_dir_all(out.parent().unwrap()).unwrap();
    let mut text = serde_json::to_string_pretty(&bundle).unwrap();
    text.push('\n');
    fs::write(&out, text).unwrap();
    eprintln!("regen: wrote {}", out.display());

    // Sanity: the freshly-written golden round-trips to the built bundle.
    assert_eq!(committed_bundle(), bundle);
}
