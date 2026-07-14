//! The load-bearing MV/MZ **runtime-observation proof**.
//!
//! This module consumes the browser trace-probe output — the
//! runtime evidence report an ACTUAL LAUNCHED Chromium (`--dump-dom`) produced
//! from the public MV/MZ fixture — and decides, under a strict-proof bar
//! whether it genuinely proves **E1 runtime observation**: text + choice events
//! observed from a live post-render DOM, each linked to its bridge unit, source
//! revision, runtime target, adapter, and environment metadata.
//!
//! ## Why a static read cannot satisfy E1
//!
//! E1 means a real launched runtime produced the events. The proof does NOT
//! take that on faith from a self-declared `evidenceTier` field — a forged JSON
//! could claim anything. Instead it cross-checks the trace against the STATIC
//! fixture source bytes:
//!
//! - The public fixture carries its dialogue/choice plaintext ONLY inside a
//!   base64 payload that the page's JavaScript decodes at runtime (see
//!   `tests/fixtures/mvmz_observation/index.html`). None of the observed
//!   plaintext appears in any static file the fixture ships.
//! - Therefore any observed string that IS present verbatim in the static
//!   source could have been lifted by a static read — it fails the crux check
//!   [`CHECK_OBSERVED_TEXT_ABSENT_FROM_STATIC_SOURCE`]. Only strings that exist
//!   *nowhere* in the static inputs could have come from a live render.
//! - Combined with the `observationSource == "live_dom"` marker and the E1
//!   evidence tier, a passing proof means the events materialised at runtime.
//!
//! A trace whose observations are empty (the render produced no instrumentation
//! island), whose `observationSource` is `fixture_declared`, whose evidence tier
//! is not E1, or whose observed text is recoverable from the static source is
//! REJECTED with `runtimeObservationProven: false` and `provenEvidenceTier:
//! "none"`. The E1 claim cannot be forged from a static fixture read.
//!
//! ## What it aggregates
//!
//! ```text
//! runtime trace browser trace probe -> observation + linkage
//! screenshot evidence capture artifactRef -> screenshotEvidence (when supplied)
//! ```

use std::fs;
use std::path::Path;

use serde_json::{Value, json};
use utsushi_core::UtsushiResult;

use crate::mv_mz_screenshot_evidence::deterministic_uuid7;

/// Schema version of the runtime-observation-proof manifest wire shape.
pub const RUNTIME_OBSERVATION_PROOF_SCHEMA_VERSION: &str = "0.1.0";

/// Kind discriminant stamped on every proof manifest.
pub const RUNTIME_OBSERVATION_PROOF_KIND: &str = "utsushi.mvmz.runtime_observation_proof";

/// Namespace the proof mints its deterministic ids under.
const RUNTIME_OBSERVATION_PROOF_UUID_NAMESPACE: &str =
    "utsushi-u102:mvmz-runtime-observation-proof";

/// The runtime observation source marker a genuine live launch stamps on every
/// observation event. Anything else (notably `fixture_declared`) is a static
/// non-runtime read and cannot satisfy E1.
const OBSERVATION_SOURCE_LIVE_DOM: &str = "live_dom";

/// The evidence tier a real launched-runtime observation claims.
const EVIDENCE_TIER_E1: &str = "E1";

// --- Check identifiers (stable, machine-readable) -------------------------

/// The runtime evidence report as a whole claims the E1 evidence tier.
pub const CHECK_TRACE_EVIDENCE_TIER_E1: &str = "trace_evidence_tier_is_e1";
/// The trace carries at least one observation-hook event. An empty observation
/// (render produced no instrumentation island) proves nothing.
pub const CHECK_OBSERVATION_EVENTS_PRESENT: &str = "observation_events_present";
/// Every observation event was observed from the live post-render DOM.
pub const CHECK_OBSERVATION_SOURCE_LIVE_DOM: &str = "observation_source_is_live_runtime";
/// Every observation event carries the E1 evidence tier.
pub const CHECK_OBSERVATION_TIER_E1: &str = "observation_evidence_tier_is_e1";
/// Every observation event links to a bridge unit, source revision, runtime
/// target, adapter, and environment metadata.
pub const CHECK_FULL_LINKAGE_PRESENT: &str = "full_bridge_and_environment_linkage";
/// THE CRUX: no observed string is recoverable from the static fixture source.
pub const CHECK_OBSERVED_TEXT_ABSENT_FROM_STATIC_SOURCE: &str =
    "observed_text_absent_from_static_source";
/// When screenshot evidence is supplied, its artifactRef links to a bridge unit.
pub const CHECK_SCREENSHOT_ARTIFACT_LINKED: &str = "screenshot_artifact_ref_linked";

/// Inputs to the runtime-observation proof.
pub struct RuntimeObservationProofInputs<'a> {
    /// The browser trace-probe output (a runtime evidence report).
    pub runtime_trace: &'a Value,
    /// The concatenated bytes of every STATIC file the public fixture ships.
    /// The crux check confirms no observed string is recoverable from it.
    pub static_fixture_source: &'a str,
    /// The optional screenshot capture evidence (a runtime evidence
    /// report carrying at least one screenshot capture with an `artifactRef`).
    pub screenshot_evidence: Option<&'a Value>,
}

/// One strict-proof check result.
struct Check {
    id: &'static str,
    passed: bool,
    /// Whether this check gates the overall verdict.
    mandatory: bool,
    detail: String,
}

impl Check {
    fn to_json(&self) -> Value {
        json!({
            "checkId": self.id,
            "status": if self.passed { "pass" } else { "fail" },
            "mandatory": self.mandatory,
            "detail": self.detail,
        })
    }
}

/// The observation-hook events of a runtime trace, or an empty slice.
fn observation_events(trace: &Value) -> &[Value] {
    trace
        .get("observationHookEvents")
        .and_then(Value::as_array)
        .map_or(&[][..], Vec::as_slice)
}

/// Collect every runtime-only plaintext string an observation event surfaced:
/// dialogue text, choice prompt/option labels, scene/map display name, and the
/// branch route label/destination. Speakers, unit keys, and structural ids
/// (sceneId, branchId) are deliberately excluded — those legitimately also live
/// in the static source and are not the runtime-only payload the crux check
/// guards. Every collected string exists ONLY in the fixture's runtime base64
/// payload, so its presence in a trace proves a live render produced it.
fn observed_plaintext_strings(trace: &Value) -> Vec<String> {
    let mut strings = Vec::new();
    for event in observation_events(trace) {
        let payload = event.get("payload").unwrap_or(&Value::Null);
        let mut push_nonempty = |value: Option<&str>| {
            if let Some(text) = value
                && !text.is_empty()
            {
                strings.push(text.to_string());
            }
        };
        match event.get("eventKind").and_then(Value::as_str) {
            Some("text") => push_nonempty(payload.get("text").and_then(Value::as_str)),
            Some("choice") => {
                push_nonempty(payload.get("prompt").and_then(Value::as_str));
                if let Some(options) = payload.get("options").and_then(Value::as_array) {
                    for option in options {
                        push_nonempty(option.get("label").and_then(Value::as_str));
                    }
                }
            }
            Some("scene") => push_nonempty(payload.get("sceneName").and_then(Value::as_str)),
            Some("branch") => {
                push_nonempty(payload.get("label").and_then(Value::as_str));
                push_nonempty(payload.get("destination").and_then(Value::as_str));
            }
            _ => {}
        }
    }
    strings
}

/// True when the observation event carries the complete linkage envelope.
fn event_has_full_linkage(event: &Value) -> bool {
    let runtime_target_ok = event
        .get("runtimeTargetId")
        .and_then(Value::as_str)
        .is_some_and(|value| !value.is_empty());
    let adapter_ok = event
        .get("adapterId")
        .and_then(|adapter| adapter.get("name"))
        .and_then(Value::as_str)
        .is_some_and(|value| !value.is_empty());
    let revision_ok = event
        .get("sourceRevision")
        .and_then(|revision| revision.get("sourceId"))
        .and_then(Value::as_str)
        .is_some_and(|value| !value.is_empty());
    let environment_ok = event
        .get("environment")
        .and_then(|environment| environment.get("runtime"))
        .and_then(Value::as_str)
        .is_some_and(|value| !value.is_empty());
    let bridge_ok = event
        .get("bridgeRefs")
        .and_then(Value::as_array)
        .and_then(|refs| refs.first())
        .is_some_and(|bridge| {
            bridge
                .get("bridgeUnitId")
                .and_then(Value::as_str)
                .is_some_and(|value| !value.is_empty())
                && bridge
                    .get("sourceUnitKey")
                    .and_then(Value::as_str)
                    .is_some_and(|value| !value.is_empty())
        });
    runtime_target_ok && adapter_ok && revision_ok && environment_ok && bridge_ok
}

/// Build the MV/MZ runtime-observation proof manifest.
///
/// Runs every strict-proof check over the consumed trace and
/// (when supplied) the screenshot evidence, then emits a manifest
/// whose `runtimeObservationProven` verdict is `true` iff every mandatory check
/// passes. A trace that a static fixture read could have produced fails the
/// crux check and is rejected with `provenEvidenceTier: "none"`.
pub fn build_mvmz_runtime_observation_proof(
    inputs: &RuntimeObservationProofInputs,
) -> UtsushiResult<Value> {
    let trace = inputs.runtime_trace;
    let events = observation_events(trace);
    let mut checks: Vec<Check> = Vec::new();
    let mut limitations: Vec<String> = Vec::new();

    // 1. The report as a whole claims E1.
    let report_tier = trace.get("evidenceTier").and_then(Value::as_str);
    checks.push(Check {
        id: CHECK_TRACE_EVIDENCE_TIER_E1,
        passed: report_tier == Some(EVIDENCE_TIER_E1),
        mandatory: true,
        detail: format!(
            "runtime evidence report evidenceTier = {}; expected {EVIDENCE_TIER_E1}",
            report_tier.unwrap_or("<absent>")
        ),
    });

    // 2. There is at least one observation event.
    checks.push(Check {
        id: CHECK_OBSERVATION_EVENTS_PRESENT,
        passed: !events.is_empty(),
        mandatory: true,
        detail: format!(
            "{} observation-hook event(s); a launch that produced no instrumentation island \
             observes nothing and proves nothing",
            events.len()
        ),
    });

    // 3. Every observation event was observed from the live post-render DOM.
    let non_live: Vec<&str> = events
        .iter()
        .filter_map(|event| event.get("observationSource").and_then(Value::as_str))
        .filter(|source| *source != OBSERVATION_SOURCE_LIVE_DOM)
        .collect();
    let all_declared_live = !events.is_empty()
        && events.iter().all(|event| {
            event.get("observationSource").and_then(Value::as_str)
                == Some(OBSERVATION_SOURCE_LIVE_DOM)
        });
    checks.push(Check {
        id: CHECK_OBSERVATION_SOURCE_LIVE_DOM,
        passed: all_declared_live,
        mandatory: true,
        detail: if non_live.is_empty() && !events.is_empty() {
            format!(
                "all {} event(s) observationSource = {OBSERVATION_SOURCE_LIVE_DOM}",
                events.len()
            )
        } else {
            format!(
                "{} event(s) declared a non-live observationSource (e.g. fixture_declared); \
                 only {OBSERVATION_SOURCE_LIVE_DOM} events are live-runtime observations",
                non_live.len()
            )
        },
    });

    // 4. Every observation event carries the E1 evidence tier.
    let all_events_e1 = !events.is_empty()
        && events.iter().all(|event| {
            event.get("evidenceTier").and_then(Value::as_str) == Some(EVIDENCE_TIER_E1)
        });
    checks.push(Check {
        id: CHECK_OBSERVATION_TIER_E1,
        passed: all_events_e1,
        mandatory: true,
        detail: format!(
            "every observation event must carry evidenceTier {EVIDENCE_TIER_E1} ({} event(s) checked)",
            events.len()
        ),
    });

    // 5. Every observation event carries the full linkage envelope.
    let unlinked = events
        .iter()
        .filter(|event| !event_has_full_linkage(event))
        .count();
    checks.push(Check {
        id: CHECK_FULL_LINKAGE_PRESENT,
        passed: !events.is_empty() && unlinked == 0,
        mandatory: true,
        detail: format!(
            "{unlinked} of {} event(s) missing bridge-unit / source-revision / runtime-target / \
             adapter / environment linkage",
            events.len()
        ),
    });

    // 6. THE CRUX: no observed string is recoverable from the static source.
    let observed_strings = observed_plaintext_strings(trace);
    let leaked: Vec<&String> = observed_strings
        .iter()
        .filter(|observed| inputs.static_fixture_source.contains(observed.as_str()))
        .collect();
    checks.push(Check {
        id: CHECK_OBSERVED_TEXT_ABSENT_FROM_STATIC_SOURCE,
        passed: !observed_strings.is_empty() && leaked.is_empty(),
        mandatory: true,
        detail: if observed_strings.is_empty() {
            "no observed plaintext to test; a proof with nothing observed cannot claim E1"
                .to_string()
        } else if leaked.is_empty() {
            format!(
                "all {} observed string(s) are absent from the static fixture source; they could \
                 only have materialised from a live runtime render",
                observed_strings.len()
            )
        } else {
            format!(
                "{} observed string(s) are recoverable verbatim from the static fixture source; a \
                 static read could have forged them — E1 not satisfied",
                leaked.len()
            )
        },
    });

    // 7. Screenshot evidence ( artifactRef linkage), when supplied.
    let screenshot_section = if let Some(evidence) = inputs.screenshot_evidence {
        let (section, check) = screenshot_evidence_section(evidence);
        checks.push(check);
        section
    } else {
        limitations.push(
            "No UTSUSHI-065 screenshot evidence supplied; the proof rests on the E1 text + \
             choice observation trace alone."
                .to_string(),
        );
        json!({ "available": false })
    };

    let mandatory_pass = checks
        .iter()
        .filter(|check| check.mandatory)
        .all(|check| check.passed);

    let count_event_kind = |kind: &str| {
        events
            .iter()
            .filter(|event| event.get("eventKind").and_then(Value::as_str) == Some(kind))
            .count()
    };
    let text_event_count = count_event_kind("text");
    let choice_event_count = count_event_kind("choice");
    let scene_event_count = count_event_kind("scene");
    let branch_event_count = count_event_kind("branch");
    let observed_bridge_unit_ids: Vec<Value> = events
        .iter()
        .filter_map(|event| {
            event
                .get("bridgeRefs")
                .and_then(Value::as_array)
                .and_then(|refs| refs.first())
                .and_then(|bridge| bridge.get("bridgeUnitId"))
                .cloned()
        })
        .collect();

    let first_event = events.first();
    let runtime_report_id = trace
        .get("runtimeReportId")
        .and_then(Value::as_str)
        .unwrap_or("");
    let adapter_name = trace
        .get("adapterName")
        .and_then(Value::as_str)
        .unwrap_or("");

    let proof_id = deterministic_uuid7(
        RUNTIME_OBSERVATION_PROOF_UUID_NAMESPACE,
        &format!("proof-{runtime_report_id}-{adapter_name}"),
    );

    limitations.push(
        "Runtime-observation proof is an evidence VERDICT over a consumed UTSUSHI-006 trace: it \
         re-derives the E1-vs-static distinction from the static fixture bytes and does not embed \
         raw game bytes or pixels."
            .to_string(),
    );

    Ok(json!({
        "schemaVersion": RUNTIME_OBSERVATION_PROOF_SCHEMA_VERSION,
        "proofKind": RUNTIME_OBSERVATION_PROOF_KIND,
        "proofId": proof_id,
        "engine": "rpg_maker_mv_mz",
        "runtimeObservationProven": mandatory_pass,
        "provenEvidenceTier": if mandatory_pass { EVIDENCE_TIER_E1 } else { "none" },
        "consumes": {
            "runtimeTraceSource": "UTSUSHI-006",
            "runtimeReportId": runtime_report_id,
            "adapterName": adapter_name,
            "reportEvidenceTier": trace.get("evidenceTier").cloned().unwrap_or(Value::Null),
        },
        "observation": {
            "textEventCount": text_event_count,
            "choiceEventCount": choice_event_count,
            "sceneEventCount": scene_event_count,
            "branchEventCount": branch_event_count,
            "observedBridgeUnitIds": observed_bridge_unit_ids,
            "runtimeTargetId": first_event.and_then(|e| e.get("runtimeTargetId")).cloned().unwrap_or(Value::Null),
            "adapterId": first_event.and_then(|e| e.get("adapterId")).cloned().unwrap_or(Value::Null),
            "sourceRevision": first_event.and_then(|e| e.get("sourceRevision")).cloned().unwrap_or(Value::Null),
            "environment": first_event.and_then(|e| e.get("environment")).cloned().unwrap_or(Value::Null),
        },
        "screenshotEvidence": screenshot_section,
        "checks": checks.iter().map(Check::to_json).collect::<Vec<_>>(),
        "limitations": limitations,
    }))
}

/// Extract the screenshot artifactRef linkage from a capture
/// evidence report and produce both the manifest section and the gating check.
fn screenshot_evidence_section(evidence: &Value) -> (Value, Check) {
    let captures = evidence
        .get("captures")
        .and_then(Value::as_array)
        .map_or(&[][..], Vec::as_slice);

    let refs: Vec<Value> = captures
        .iter()
        .filter_map(|capture| {
            let artifact_ref = capture.get("artifactRef")?;
            if artifact_ref.is_null() {
                return None;
            }
            Some(json!({
                "artifactRef": artifact_ref.clone(),
                "bridgeUnitRef": capture.get("bridgeUnitRef").cloned().unwrap_or(Value::Null),
                "frame": capture.get("frame").cloned().unwrap_or(Value::Null),
                "evidenceTier": capture.get("evidenceTier").cloned().unwrap_or(Value::Null),
            }))
        })
        .collect();

    let linked = refs.iter().all(|reference| {
        reference["artifactRef"]
            .get("uri")
            .and_then(Value::as_str)
            .is_some_and(|uri| !uri.is_empty())
            && reference["bridgeUnitRef"]
                .get("bridgeUnitId")
                .and_then(Value::as_str)
                .is_some_and(|value| !value.is_empty())
    });
    let passed = !refs.is_empty() && linked;

    let section = json!({
        "available": passed,
        "source": "UTSUSHI-065",
        "artifactRefs": refs,
    });
    let check = Check {
        id: CHECK_SCREENSHOT_ARTIFACT_LINKED,
        passed,
        mandatory: true,
        detail: format!(
            "{} screenshot capture artifactRef(s) each linked to a bridge unit (UTSUSHI-065)",
            refs.len()
        ),
    };
    (section, check)
}

/// Read every regular file the fixture directory ships and concatenate their
/// bytes (lossy UTF-8). This is the STATIC source the crux check confirms the
/// observed plaintext is absent from.
pub fn read_static_fixture_source(fixture_dir: &Path) -> UtsushiResult<String> {
    let mut names: Vec<_> = fs::read_dir(fixture_dir)?
        .filter_map(Result::ok)
        .filter(|entry| entry.file_type().is_ok_and(|kind| kind.is_file()))
        .map(|entry| entry.path())
        .collect();
    // Deterministic order so the concatenation is stable.
    names.sort();
    let mut combined = String::new();
    for path in names {
        let bytes = fs::read(&path)?;
        combined.push_str(&String::from_utf8_lossy(&bytes));
        combined.push('\n');
    }
    Ok(combined)
}

/// Read the proof inputs from files and build the manifest.
///
/// The IO shell the CLI uses: it reads the runtime trace, the static
/// fixture source, and the optional screenshot evidence, then
/// delegates to the pure [`build_mvmz_runtime_observation_proof`].
pub fn mvmz_runtime_observation_proof_from_paths(
    runtime_trace_path: &Path,
    fixture_dir: &Path,
    screenshot_evidence_path: Option<&Path>,
) -> UtsushiResult<Value> {
    let runtime_trace: Value = serde_json::from_str(&fs::read_to_string(runtime_trace_path)?)?;
    let static_fixture_source = read_static_fixture_source(fixture_dir)?;
    let screenshot_evidence: Option<Value> = match screenshot_evidence_path {
        Some(path) => Some(serde_json::from_str(&fs::read_to_string(path)?)?),
        None => None,
    };

    build_mvmz_runtime_observation_proof(&RuntimeObservationProofInputs {
        runtime_trace: &runtime_trace,
        static_fixture_source: &static_fixture_source,
        screenshot_evidence: screenshot_evidence.as_ref(),
    })
}

#[cfg(test)]
mod tests {
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
        assert_eq!(proof["consumes"]["runtimeTraceSource"], "UTSUSHI-006");

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
        assert_eq!(proof["screenshotEvidence"]["source"], "UTSUSHI-065");
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
}
