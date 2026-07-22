use super::*;

fn fixture_dir() -> std::path::PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/mvmz_patched_observation")
}

/// A live-DOM E1 patched trace shaped exactly as `BrowserLaunchAdapter::trace`
/// emits it over the patched fixture: two translated text events + one
/// translated choice event, every event carrying the full linkage envelope
/// and `observationSource = live_dom`. The observed plaintext is the
/// TRANSLATION, present only in the fixture's runtime base64 payload.
fn patched_live_dom_trace() -> Value {
    let linkage = |unit_key: &str, bridge: &str| {
        json!({
            "runtimeTargetId": "fixture:mvmz-patched-fixture",
            "adapterId": {"name": "utsushi-browser", "version": "0.0.0"},
            "sourceRevision": {"sourceId": "mvmz-patched-fixture", "revisionId": "fixture-source-v0.1"},
            "environment": {"runtime": "browser", "engine": "browser-smoke-fixture", "platform": "linux"},
            "bridgeRefs": [{"bridgeUnitId": bridge, "sourceUnitKey": unit_key}],
            "observationSource": "live_dom",
            "evidenceTier": "E1",
        })
    };
    let mut text1 = linkage("mvmz.scene1.line1", "019ed000-0000-7000-8000-bridgeun0001");
    text1["eventKind"] = json!("text");
    text1["payload"] = json!({"payloadKind": "text", "text": "The lighthouse keeps watch over the quiet cove.", "speaker": "Mira"});
    let mut text2 = linkage("mvmz.scene1.line2", "019ed000-0000-7000-8000-bridgeun0002");
    text2["eventKind"] = json!("text");
    text2["payload"] =
        json!({"payloadKind": "text", "text": "Let us signal the passing ship.", "speaker": "Kai"});
    let mut choice = linkage("mvmz.scene1.choice", "019ed000-0000-7000-8000-bridgeun0003");
    choice["eventKind"] = json!("choice");
    choice["payload"] = json!({
        "payloadKind": "choice",
        "prompt": "What will you do?",
        "options": [
            {"optionId": "opt-0", "label": "Raise the lantern high.", "bridgeRef": {"bridgeUnitId": "019ed000-0000-7000-8000-bridgeun0004", "sourceUnitKey": "mvmz.scene1.choice.opt0"}},
            {"optionId": "opt-1", "label": "Wait in the darkness.", "bridgeRef": {"bridgeUnitId": "019ed000-0000-7000-8000-bridgeun0005", "sourceUnitKey": "mvmz.scene1.choice.opt1"}}
        ]
    });
    json!({
        "runtimeReportId": "019ed050-0000-7000-8000-000000001000",
        "adapterName": "utsushi-browser",
        "evidenceTier": "E1",
        "status": "passed",
        "observationHookEvents": [text1, text2, choice],
        "traceEvents": [],
    })
}

fn patch_result_for(trace: &Value) -> Value {
    let hash = canonical_patched_output_hash(&observed_translated_units(trace));
    json!({
        "schemaVersion": "0.2.0",
        "patchResultId": "019ed060-0000-7000-8000-000000000001",
        "patchExportId": "019ed060-0000-7000-8000-0000000000a1",
        "status": "passed",
        "outputHash": hash,
        "failures": [],
    })
}

/// A minimal proven E1 alpha proof manifest with the same three
/// top-level bridge units the patched trace covers.
fn alpha_proof() -> Value {
    json!({
        "proofKind": RUNTIME_OBSERVATION_PROOF_KIND,
        "proofId": "cac432af-03e2-7aa5-955b-bc1d66a3629a",
        "runtimeObservationProven": true,
        "provenEvidenceTier": "E1",
        "observation": {
            "observedBridgeUnitIds": [
                "019ed000-0000-7000-8000-bridgeun0001",
                "019ed000-0000-7000-8000-bridgeun0002",
                "019ed000-0000-7000-8000-bridgeun0003"
            ]
        }
    })
}

fn source_map() -> BTreeMap<String, String> {
    read_prepatch_source_texts(&fixture_dir()).unwrap()
}

fn combined() -> String {
    // The observed TRANSLATION must be absent from the concatenated static
    // inputs. The alpha proof + patch result carry no plaintext translation.
    let mut s = read_static_fixture_source(&fixture_dir()).unwrap();
    s.push_str(&serde_json::to_string(&patch_result_for(&patched_live_dom_trace())).unwrap());
    s.push_str(&serde_json::to_string(&alpha_proof()).unwrap());
    s
}

fn check_status<'a>(proof: &'a Value, check_id: &str) -> &'a str {
    proof["checks"]
        .as_array()
        .unwrap()
        .iter()
        .find(|check| check["checkId"] == check_id)
        .unwrap_or_else(|| panic!("missing check {check_id}"))["status"]
        .as_str()
        .unwrap()
}

#[test]
fn patched_live_dom_trace_proves_patched_e1_observation() {
    let trace = patched_live_dom_trace();
    let patch_result = patch_result_for(&trace);
    let alpha = alpha_proof();
    let source = source_map();
    let combined = combined();
    let proof = build_mvmz_patched_runtime_proof(&PatchedRuntimeProofInputs {
        patched_runtime_trace: &trace,
        patch_result: &patch_result,
        alpha_proof_manifest: &alpha,
        combined_static_source: &combined,
        prepatch_source_texts: &source,
        screenshot_evidence: None,
    })
    .unwrap();

    assert_eq!(proof["patchedRuntimeObservationProven"], true, "{proof}");
    assert_eq!(proof["provenEvidenceTier"], "E1");
    assert_eq!(proof["proofKind"], PATCHED_RUNTIME_PROOF_KIND);
    assert_eq!(proof["patchAttestation"]["hashMatches"], true);
    for check_id in [
        CHECK_BASE_RUNTIME_OBSERVATION_PROVEN_E1,
        CHECK_PATCH_RESULT_STATUS_PASSED,
        CHECK_PATCHED_OUTPUT_MATCHES_PATCH_RESULT_HASH,
        CHECK_OBSERVED_IS_TRANSLATION_NOT_PREPATCH_SOURCE,
        CHECK_ALPHA_PROOF_BASELINE_E1,
        CHECK_PATCHED_UNITS_MATCH_ALPHA_PROOF_UNITS,
    ] {
        assert_eq!(check_status(&proof, check_id), "pass", "check {check_id}");
    }
    // The observed translation is what was attested — line1 is the English
    // translation, not the Japanese source.
    assert_eq!(
        proof["patchAttestation"]["translatedUnitKeys"]
            .as_array()
            .unwrap()
            .len(),
        5
    );
}

#[test]
fn wrong_patch_result_hash_is_rejected() {
    // The observation is a genuine live-DOM render, but the PatchResult
    // attests a DIFFERENT output. The provenance crux rejects it: the
    // observed content is not the attested patch.
    let trace = patched_live_dom_trace();
    let mut patch_result = patch_result_for(&trace);
    patch_result["outputHash"] = json!("sha256:deadbeef");
    let alpha = alpha_proof();
    let source = source_map();
    let combined = combined();
    let proof = build_mvmz_patched_runtime_proof(&PatchedRuntimeProofInputs {
        patched_runtime_trace: &trace,
        patch_result: &patch_result,
        alpha_proof_manifest: &alpha,
        combined_static_source: &combined,
        prepatch_source_texts: &source,
        screenshot_evidence: None,
    })
    .unwrap();
    assert_eq!(proof["patchedRuntimeObservationProven"], false);
    assert_eq!(proof["provenEvidenceTier"], "none");
    assert_eq!(
        check_status(&proof, CHECK_PATCHED_OUTPUT_MATCHES_PATCH_RESULT_HASH),
        "fail"
    );
}

#[test]
fn observing_prepatch_source_is_not_a_patched_observation() {
    // STRICT-PROOF NEGATIVE CONTROL: a trace that "observes" the pre-patch
    // Japanese source text (the untranslated original) is not a patched
    // observation. It fails the post-patch crux AND the base
    // absent-from-static crux (the source text lives in source.json).
    let mut trace = patched_live_dom_trace();
    trace["observationHookEvents"][0]["payload"]["text"] =
        json!("灯台は静かな入り江を見守り続ける。");
    // Re-point the PatchResult hash so ONLY the post-patch / static checks
    // are what reject it (isolate the crux under test).
    let patch_result = patch_result_for(&trace);
    let alpha = alpha_proof();
    let source = source_map();
    let combined = combined();
    let proof = build_mvmz_patched_runtime_proof(&PatchedRuntimeProofInputs {
        patched_runtime_trace: &trace,
        patch_result: &patch_result,
        alpha_proof_manifest: &alpha,
        combined_static_source: &combined,
        prepatch_source_texts: &source,
        screenshot_evidence: None,
    })
    .unwrap();
    assert_eq!(proof["patchedRuntimeObservationProven"], false);
    assert_eq!(
        check_status(&proof, CHECK_OBSERVED_IS_TRANSLATION_NOT_PREPATCH_SOURCE),
        "fail"
    );
    // And the base E1 crux also rejects it: the source text is recoverable
    // from source.json (a static read).
    assert_eq!(
        check_status(&proof, CHECK_BASE_RUNTIME_OBSERVATION_PROVEN_E1),
        "fail"
    );
}

#[test]
fn static_read_of_placeholder_target_cannot_forge_patched_e1() {
    // An attacker lifts the declared PLACEHOLDER targetText out of
    // source.json and relabels it as a live_dom E1 observation. It is
    // present in the static source, so the base absent-from-static crux
    // rejects the forged patched E1.
    let mut trace = patched_live_dom_trace();
    trace["observationHookEvents"][0]["payload"]["text"] = json!(
        "PLACEHOLDER line1 -- the PATCHED translation is observed from the live DOM, not this field."
    );
    let patch_result = patch_result_for(&trace);
    let alpha = alpha_proof();
    let source = source_map();
    let combined = combined();
    let proof = build_mvmz_patched_runtime_proof(&PatchedRuntimeProofInputs {
        patched_runtime_trace: &trace,
        patch_result: &patch_result,
        alpha_proof_manifest: &alpha,
        combined_static_source: &combined,
        prepatch_source_texts: &source,
        screenshot_evidence: None,
    })
    .unwrap();
    assert_eq!(proof["patchedRuntimeObservationProven"], false);
    assert_eq!(
        check_status(&proof, CHECK_BASE_RUNTIME_OBSERVATION_PROVEN_E1),
        "fail"
    );
}

#[test]
fn unproven_alpha_proof_is_rejected() {
    let trace = patched_live_dom_trace();
    let patch_result = patch_result_for(&trace);
    let mut alpha = alpha_proof();
    alpha["runtimeObservationProven"] = json!(false);
    alpha["provenEvidenceTier"] = json!("none");
    let source = source_map();
    let combined = combined();
    let proof = build_mvmz_patched_runtime_proof(&PatchedRuntimeProofInputs {
        patched_runtime_trace: &trace,
        patch_result: &patch_result,
        alpha_proof_manifest: &alpha,
        combined_static_source: &combined,
        prepatch_source_texts: &source,
        screenshot_evidence: None,
    })
    .unwrap();
    assert_eq!(proof["patchedRuntimeObservationProven"], false);
    assert_eq!(check_status(&proof, CHECK_ALPHA_PROOF_BASELINE_E1), "fail");
}

#[test]
fn read_static_fixture_source_excludes_the_patched_translation() {
    // Sanity: the patched fixture's static bytes carry NONE of the observed
    // translation (only its base64 encoding + the PLACEHOLDER target).
    let static_source = read_static_fixture_source(&fixture_dir()).unwrap();
    for observed in [
        "The lighthouse keeps watch over the quiet cove.",
        "Let us signal the passing ship.",
        "What will you do?",
        "Raise the lantern high.",
        "Wait in the darkness.",
    ] {
        assert!(
            !static_source.contains(observed),
            "static patched fixture source leaked the translation: {observed}"
        );
    }
}
