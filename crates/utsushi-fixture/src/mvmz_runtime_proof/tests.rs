use super::*;

/// The real fixture directory.
fn fixture_dir() -> std::path::PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/mvmz_observation")
}

/// A live-DOM E1 trace shaped exactly as `BrowserLaunchAdapter::trace`
/// emits it: one scene event + two text events + one choice event + one
/// branch event, every event carrying the full linkage envelope and
/// `observationSource = live_dom`. The observed plaintext deliberately
/// matches the fixture's runtime-only base64 payload (absent from the
/// static source).
fn live_dom_trace() -> Value {
    let linkage = |unit_key: &str| {
        json!({
            "runtimeTargetId": "fixture:mvmz-observation-fixture",
            "adapterId": {"name": "utsushi-browser", "version": "0.0.0"},
            "sourceRevision": {"sourceId": "mvmz-observation-fixture", "revisionId": "fixture-source-v0.1"},
            "environment": {"runtime": "browser", "engine": "browser-smoke-fixture", "platform": "linux"},
            "bridgeRefs": [{"bridgeUnitId": "019ed000-0000-7000-8000-bridgeun0001", "sourceUnitKey": unit_key}],
            "observationSource": OBSERVATION_SOURCE_LIVE_DOM,
            "evidenceTier": EVIDENCE_TIER_E1,
        })
    };
    let mut scene = linkage("mvmz.scene1.scene");
    scene["eventKind"] = json!("scene");
    scene["payload"] = json!({"payloadKind": "scene", "sceneId": "Scene_Map:0031", "sceneName": "The frost-veiled courtyard at winter dawn."});
    let mut text1 = linkage("mvmz.scene1.line1");
    text1["eventKind"] = json!("text");
    text1["payload"] = json!({"payloadKind": "text", "text": "The frost blossoms open at first light.", "speaker": "Yuki"});
    let mut text2 = linkage("mvmz.scene1.line2");
    text2["eventKind"] = json!("text");
    text2["payload"] = json!({"payloadKind": "text", "text": "Then let us walk before the town wakes.", "speaker": "Sora"});
    let mut choice = linkage("mvmz.scene1.choice");
    choice["eventKind"] = json!("choice");
    choice["payload"] = json!({
        "payloadKind": "choice",
        "prompt": "How do you answer Sora?",
        "options": [
            {"optionId": "opt-0", "label": "Follow her into the snow."},
            {"optionId": "opt-1", "label": "Stay by the warm hearth."}
        ]
    });
    let mut branch = linkage("mvmz.scene1.branch");
    branch["eventKind"] = json!("branch");
    branch["payload"] = json!({
        "payloadKind": "branch",
        "branchId": "branch-0031",
        "label": "The snow-walk route opens beyond the gate.",
        "destination": "Scene_Map:winter-path-approach",
        "taken": true
    });
    json!({
        "runtimeReportId": "019ed050-0000-7000-8000-000000001000",
        "adapterName": "utsushi-browser",
        "evidenceTier": EVIDENCE_TIER_E1,
        "status": "passed",
        "observationHookEvents": [scene, text1, text2, choice, branch],
        "traceEvents": [],
    })
}

/// A screenshot capture evidence report shaped as
/// `BrowserLaunchAdapter::capture` emits it.
fn screenshot_evidence() -> Value {
    json!({
        "evidenceTier": "E2",
        "captures": [{
            "captureId": "019ed050-0000-7000-8000-000000003000",
            "bridgeUnitRef": {"bridgeUnitId": "019ed000-0000-7000-8000-bridgeun0001", "sourceUnitKey": "mvmz.scene1.line1"},
            "evidenceTier": "E2",
            "frame": 1,
            "artifactRef": {
                "artifactId": "019ed050-0000-7000-8000-000000004000",
                "artifactKind": "screenshot",
                "uri": "artifacts/utsushi/runtime/019ed050-0000-7000-8000-000000001000/screenshots/019ed050-0000-7000-8000-000000004000.png",
                "mediaType": "image/png"
            }
        }]
    })
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
fn live_dom_trace_with_screenshot_proves_e1_runtime_observation() {
    let static_source = read_static_fixture_source(&fixture_dir()).unwrap();
    let screenshot = screenshot_evidence();
    let proof = build_mvmz_runtime_observation_proof(&RuntimeObservationProofInputs {
        runtime_trace: &live_dom_trace(),
        static_fixture_source: &static_source,
        screenshot_evidence: Some(&screenshot),
    })
    .unwrap();

    assert_eq!(proof["runtimeObservationProven"], true);
    assert_eq!(proof["provenEvidenceTier"], "E1");
    assert_eq!(proof["proofKind"], RUNTIME_OBSERVATION_PROOF_KIND);
    assert_eq!(
        proof["consumes"]["runtimeTraceSource"],
        RUNTIME_TRACE_SOURCE_ID
    );

    // Every mandatory check passed.
    for check_id in [
        CHECK_TRACE_EVIDENCE_TIER_E1,
        CHECK_OBSERVATION_EVENTS_PRESENT,
        CHECK_OBSERVATION_SOURCE_LIVE_DOM,
        CHECK_OBSERVATION_TIER_E1,
        CHECK_FULL_LINKAGE_PRESENT,
        CHECK_OBSERVED_TEXT_ABSENT_FROM_STATIC_SOURCE,
        CHECK_SCREENSHOT_ARTIFACT_LINKED,
    ] {
        assert_eq!(check_status(&proof, check_id), "pass", "check {check_id}");
    }

    // Observation linkage surfaced — text + choice AND the broader
    // scene + branch event kinds (beyond the surface).
    assert_eq!(proof["observation"]["textEventCount"], 2);
    assert_eq!(proof["observation"]["choiceEventCount"], 1);
    assert_eq!(proof["observation"]["sceneEventCount"], 1);
    assert_eq!(proof["observation"]["branchEventCount"], 1);
    assert_eq!(
        proof["observation"]["runtimeTargetId"],
        "fixture:mvmz-observation-fixture"
    );
    assert_eq!(proof["observation"]["adapterId"]["name"], "utsushi-browser");
    assert_eq!(
        proof["observation"]["sourceRevision"]["sourceId"],
        "mvmz-observation-fixture"
    );
    assert_eq!(proof["observation"]["environment"]["runtime"], "browser");
    assert_eq!(
        proof["observation"]["observedBridgeUnitIds"]
            .as_array()
            .unwrap()
            .len(),
        5
    );

    // Screenshot artifactRef linkage ().
    assert_eq!(proof["screenshotEvidence"]["available"], true);
    assert_eq!(
        proof["screenshotEvidence"]["source"],
        SCREENSHOT_EVIDENCE_SOURCE_ID
    );
    let art = &proof["screenshotEvidence"]["artifactRefs"][0];
    assert_eq!(art["artifactRef"]["artifactKind"], "screenshot");
    assert_eq!(art["bridgeUnitRef"]["sourceUnitKey"], "mvmz.scene1.line1");
}

#[test]
fn static_read_of_declared_text_cannot_forge_e1() {
    // STRICT-PROOF NEGATIVE CONTROL: an attacker builds a "trace" by reading
    // the static source.json's declared targetText and re-labelling it as a
    // live_dom E1 observation. The declared placeholder text IS present in
    // the static source, so the crux check rejects the forged E1 even though
    // every self-declared field claims E1/live_dom.
    let static_source = read_static_fixture_source(&fixture_dir()).unwrap();
    assert!(
        static_source.contains("PLACEHOLDER line1"),
        "the declared static text must be present in the static source"
    );

    let forged = json!({
        "runtimeReportId": "forged-0001",
        "adapterName": "utsushi-browser",
        "evidenceTier": EVIDENCE_TIER_E1,
        "observationHookEvents": [{
            "eventKind": "text",
            "runtimeTargetId": "fixture:mvmz-observation-fixture",
            "adapterId": {"name": "utsushi-browser", "version": "0.0.0"},
            "sourceRevision": {"sourceId": "mvmz-observation-fixture", "revisionId": "x"},
            "environment": {"runtime": "browser"},
            "bridgeRefs": [{"bridgeUnitId": "019ed000-0000-7000-8000-bridgeun0001", "sourceUnitKey": "mvmz.scene1.line1"}],
            "observationSource": OBSERVATION_SOURCE_LIVE_DOM,
            "evidenceTier": EVIDENCE_TIER_E1,
            "payload": {"payloadKind": "text", "text": "PLACEHOLDER line1 -- authoritative text is observed from the live DOM, not this field."}
        }],
        "traceEvents": [],
    });

    let proof = build_mvmz_runtime_observation_proof(&RuntimeObservationProofInputs {
        runtime_trace: &forged,
        static_fixture_source: &static_source,
        screenshot_evidence: None,
    })
    .unwrap();

    assert_eq!(
        proof["runtimeObservationProven"], false,
        "a static read of declared text must not satisfy E1"
    );
    assert_eq!(proof["provenEvidenceTier"], "none");
    assert_eq!(
        check_status(&proof, CHECK_OBSERVED_TEXT_ABSENT_FROM_STATIC_SOURCE),
        "fail",
        "the crux check must reject text recoverable from the static source"
    );
}

#[test]
fn empty_observation_cannot_satisfy_e1() {
    // A launch that produced no instrumentation island observes nothing;
    // there is nothing for a bypassed path to pass off as E1.
    let static_source = read_static_fixture_source(&fixture_dir()).unwrap();
    let empty = json!({
        "runtimeReportId": "empty-0001",
        "adapterName": "utsushi-browser",
        "evidenceTier": EVIDENCE_TIER_E1,
        "observationHookEvents": [],
        "traceEvents": [],
    });
    let proof = build_mvmz_runtime_observation_proof(&RuntimeObservationProofInputs {
        runtime_trace: &empty,
        static_fixture_source: &static_source,
        screenshot_evidence: None,
    })
    .unwrap();
    assert_eq!(proof["runtimeObservationProven"], false);
    assert_eq!(proof["provenEvidenceTier"], "none");
    assert_eq!(
        check_status(&proof, CHECK_OBSERVATION_EVENTS_PRESENT),
        "fail"
    );
}

#[test]
fn fixture_declared_observation_source_cannot_satisfy_e1() {
    // Even with runtime-only text, an event that admits it was NOT observed
    // from the live DOM (observationSource = fixture_declared) is not a
    // runtime observation and cannot satisfy E1.
    let static_source = read_static_fixture_source(&fixture_dir()).unwrap();
    let mut trace = live_dom_trace();
    trace["observationHookEvents"][0]["observationSource"] = json!("fixture_declared");
    let proof = build_mvmz_runtime_observation_proof(&RuntimeObservationProofInputs {
        runtime_trace: &trace,
        static_fixture_source: &static_source,
        screenshot_evidence: None,
    })
    .unwrap();
    assert_eq!(proof["runtimeObservationProven"], false);
    assert_eq!(
        check_status(&proof, CHECK_OBSERVATION_SOURCE_LIVE_DOM),
        "fail"
    );
}

#[test]
fn missing_linkage_cannot_satisfy_e1() {
    let static_source = read_static_fixture_source(&fixture_dir()).unwrap();
    let mut trace = live_dom_trace();
    // Strip the bridge linkage from one event.
    trace["observationHookEvents"][1]
        .as_object_mut()
        .unwrap()
        .remove("bridgeRefs");
    let proof = build_mvmz_runtime_observation_proof(&RuntimeObservationProofInputs {
        runtime_trace: &trace,
        static_fixture_source: &static_source,
        screenshot_evidence: None,
    })
    .unwrap();
    assert_eq!(proof["runtimeObservationProven"], false);
    assert_eq!(check_status(&proof, CHECK_FULL_LINKAGE_PRESENT), "fail");
}

#[test]
fn read_static_fixture_source_excludes_observed_plaintext() {
    // Sanity: the real fixture's static bytes carry NONE of the observed
    // dialogue/choice plaintext.
    let static_source = read_static_fixture_source(&fixture_dir()).unwrap();
    for observed in [
        "The frost blossoms open at first light.",
        "Then let us walk before the town wakes.",
        "How do you answer Sora?",
        "Follow her into the snow.",
        "Stay by the warm hearth.",
        // The broader scene + branch runtime-only strings must also be
        // absent from the static source (static read cannot forge them).
        "The frost-veiled courtyard at winter dawn.",
        "The snow-walk route opens beyond the gate.",
        "Scene_Map:winter-path-approach",
    ] {
        assert!(
            !static_source.contains(observed),
            "static fixture source leaked observed text: {observed}"
        );
    }
}
