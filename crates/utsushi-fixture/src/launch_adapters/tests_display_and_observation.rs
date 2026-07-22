use super::*;
#[cfg(all(unix, not(target_os = "macos")))]
#[test]
// reason: this test mutates process env via the unavoidably unsafe
// std::env::{set_var,remove_var} (edition 2024) through a scoped guard to
// exercise the REAL env-reading strict-display probe. Test-only; src stays
// unsafe-free.
#[allow(unsafe_code)]
fn real_strict_display_probe_reads_env_gate_and_emits_display_unavailable() {
    // Exercises the REAL env-backed probe_display path end to end: with the
    // UTSUSHI_STRICT_DISPLAY gate on and no DISPLAY/WAYLAND_DISPLAY, the
    // probe emits DisplayUnavailable; with the gate off (default), the
    // same no-display host is headless-only. Restores prior env on drop.
    struct EnvGuard {
        keys: Vec<(&'static str, Option<std::ffi::OsString>)>,
    }
    impl EnvGuard {
        fn capture(keys: &[&'static str]) -> Self {
            Self {
                keys: keys.iter().map(|key| (*key, env::var_os(key))).collect(),
            }
        }
        fn set(key: &str, value: &str) {
            // SAFETY: deliberate, scoped mutation for a test that restores
            // prior values on drop; documented single-test env scope.
            unsafe {
                env::set_var(key, value);
            }
        }
        fn remove(key: &str) {
            // SAFETY: see EnvGuard::set.
            unsafe {
                env::remove_var(key);
            }
        }
    }
    impl Drop for EnvGuard {
        fn drop(&mut self) {
            for (key, previous) in &self.keys {
                // SAFETY: see EnvGuard::set.
                unsafe {
                    match previous {
                        Some(value) => env::set_var(key, value),
                        None => env::remove_var(key),
                    }
                }
            }
        }
    }

    let _browser_env = lock_browser_probe_env();
    let _guard = EnvGuard::capture(&["UTSUSHI_STRICT_DISPLAY", "DISPLAY", "WAYLAND_DISPLAY"]);
    EnvGuard::remove("DISPLAY");
    EnvGuard::remove("WAYLAND_DISPLAY");

    // Gate off (default): no display surface is NOT an error.
    EnvGuard::remove("UTSUSHI_STRICT_DISPLAY");
    assert_eq!(
        super::browser_detection::probe_display(
            super::browser_detection::BrowserDetectionLabel::Path
        ),
        Ok(super::browser_detection::DisplayProbeOutcome::HeadlessOnly)
    );

    // Gate on: the real probe emits the typed DisplayUnavailable.
    EnvGuard::set("UTSUSHI_STRICT_DISPLAY", "1");
    let reason = super::browser_detection::probe_display(
        super::browser_detection::BrowserDetectionLabel::Path,
    )
    .expect_err("strict gate + no display env must be DisplayUnavailable");
    assert_eq!(
        reason.semantic_code(),
        "utsushi.browser.display_unavailable"
    );
    let harness = super::unavailability_harness_error(RuntimeOperation::SmokeValidation, &reason);
    let semantic = harness
        .details
        .iter()
        .find(|(key, _)| key == "semanticCode")
        .map(|(_, value)| value.as_str());
    assert_eq!(semantic, Some("utsushi.browser.display_unavailable"));

    // Falsey gate value is treated as off.
    EnvGuard::set("UTSUSHI_STRICT_DISPLAY", "0");
    assert_eq!(
        super::browser_detection::probe_display(
            super::browser_detection::BrowserDetectionLabel::Path
        ),
        Ok(super::browser_detection::DisplayProbeOutcome::HeadlessOnly)
    );
}

#[test]
fn chromium_version_parser_accepts_standard_chromium_strings() {
    for (input, expected_major) in [
        ("Chromium 124.0.6367.118 chromium-headless-shell", 124),
        ("Google Chrome 124.0.6367.118 unknown", 124),
        ("Brave Browser 1.65.114 Chromium: 124.0.6367.118", 1),
    ] {
        let parsed =
            super::browser_detection::parse_chromium_version(input).expect("version parses");
        assert_eq!(parsed.major(), Some(expected_major));
    }
}

fn mvmz_observation_fixture_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/mvmz_observation")
}

/// Fake browser that genuinely *renders* the fixture: it reads the launched
/// `file://` entrypoint, decodes the runtime base64 payload exactly as the
/// fixture's JavaScript would, and emits the observation island on stdout
/// (as real Chromium `--dump-dom` does after executing the page). The
/// observed plaintext therefore only comes into existence by transforming
/// the fixture at runtime — it is never read verbatim from the source.
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

/// Fake browser that launches successfully but produces a DOM WITHOUT the
/// instrumentation island (simulating a render where the page JavaScript
/// never populated the observed events). The probe must observe nothing.
#[cfg(unix)]
const NO_ISLAND_FAKE_BROWSER: &str = r#"#!/bin/sh
printf '<!doctype html><html><body><div id="messageWindow">launched without instrumentation</div></body></html>\n'
"#;

#[cfg(unix)]
#[test]
fn browser_trace_observes_live_dom_text_and_choice_events() {
    let _browser_env = lock_browser_probe_env();
    let work = temp_dir("browser-trace-live");
    let fixture = mvmz_observation_fixture_root();
    let fake = fake_browser(&work, LIVE_DOM_FAKE_BROWSER);
    let adapter = fake_browser_adapter(fake);

    let report = adapter.trace(&RuntimeRequest::new(&fixture)).unwrap();

    assert_eq!(report["adapterName"], BrowserLaunchAdapter::NAME);
    assert_eq!(report["status"], "passed");
    assert_eq!(report["evidenceTier"], "E1");

    let events = report["observationHookEvents"].as_array().unwrap();
    let text_events: Vec<&Value> = events.iter().filter(|e| e["eventKind"] == "text").collect();
    let choice_events: Vec<&Value> = events
        .iter()
        .filter(|e| e["eventKind"] == "choice")
        .collect();
    assert_eq!(text_events.len(), 2, "two dialogue lines are observed");
    assert_eq!(choice_events.len(), 1, "one choice is observed");

    // Live text observed from the DOM, NOT the source.json PLACEHOLDER.
    let first = text_events[0];
    assert_eq!(
        first["payload"]["text"],
        "The frost blossoms open at first light."
    );
    assert_eq!(first["payload"]["speaker"], "Yuki");
    assert_eq!(first["payload"]["textSurface"], "dialogue");
    assert_eq!(first["evidenceTier"], "E1");
    assert_eq!(first["observationSource"], "live_dom");
    assert_eq!(
        first["schemaVersion"],
        FIXTURE_OBSERVATION_HOOK_SCHEMA_LITERAL
    );

    // Full linkage: bridge unit, source revision, runtime target, adapter.
    let bridge = &first["bridgeRefs"][0];
    assert_eq!(bridge["sourceUnitKey"], "mvmz.scene1.line1");
    assert!(
        bridge["bridgeUnitId"]
            .as_str()
            .unwrap()
            .starts_with("019ed000-"),
        "text event must link to a bridge unit id: {bridge}"
    );
    assert_eq!(first["runtimeTargetId"], "fixture:mvmz-observation-fixture");
    assert_eq!(first["adapterId"]["name"], BrowserLaunchAdapter::NAME);
    assert_eq!(
        first["sourceRevision"]["sourceId"],
        "mvmz-observation-fixture"
    );

    // Choice linkage + per-option bridge refs.
    let choice = choice_events[0];
    assert_eq!(choice["observationSource"], "live_dom");
    assert_eq!(choice["evidenceTier"], "E1");
    assert_eq!(choice["payload"]["prompt"], "How do you answer Sora?");
    let options = choice["payload"]["options"].as_array().unwrap();
    assert_eq!(options.len(), 2);
    assert_eq!(options[0]["label"], "Follow her into the snow.");
    assert_eq!(options[0]["optionId"], "opt-0");
    assert_eq!(
        options[0]["bridgeRef"]["sourceUnitKey"],
        "mvmz.scene1.choice.opt0"
    );
    assert_eq!(options[1]["label"], "Stay by the warm hearth.");

    // Trace events mirror the observed text and feed the approximation refs.
    let trace_events = report["traceEvents"].as_array().unwrap();
    assert_eq!(trace_events.len(), 2);
    assert_eq!(
        trace_events[0]["observedText"],
        "The frost blossoms open at first light."
    );
    assert_eq!(trace_events[0]["observationSource"], "live_dom");
    assert_eq!(
        report["approximations"][0]["affectedBridgeUnitRefs"]
            .as_array()
            .unwrap()
            .len(),
        2
    );

    // The whole runtime evidence report is envelope-conformant.
    utsushi_core::validate_runtime_evidence_report_value(&report).unwrap();

    let _ = fs::remove_dir_all(work);
}

#[cfg(unix)]
#[test]
fn browser_trace_yields_no_observed_events_without_instrumentation_island() {
    let _browser_env = lock_browser_probe_env();
    let work = temp_dir("browser-trace-empty");
    let fixture = mvmz_observation_fixture_root();
    let fake = fake_browser(&work, NO_ISLAND_FAKE_BROWSER);
    let adapter = fake_browser_adapter(fake);

    let report = adapter.trace(&RuntimeRequest::new(&fixture)).unwrap();

    // Launch succeeded, but the render produced no observed events.
    assert_eq!(report["status"], "passed");
    assert!(
        report["observationHookEvents"]
            .as_array()
            .unwrap()
            .is_empty(),
        "a render without an instrumentation island must observe nothing"
    );
    assert!(report["traceEvents"].as_array().unwrap().is_empty());
    // A render that produced no instrumented DOM carries no runtime
    // evidence at all, so the report is not even contract-conformant:
    // there is nothing for a bypassed/static path to pass off as observed.
    let error = utsushi_core::validate_runtime_evidence_report_value(&report)
        .expect_err("an empty observation must not form a valid evidence report");
    assert!(
        error.to_string().contains("must contain"),
        "unexpected validation error: {error}"
    );

    let _ = fs::remove_dir_all(work);
}

#[test]
fn static_fixture_read_cannot_satisfy_the_runtime_trace_probe() {
    let fixture = mvmz_observation_fixture_root();
    let html = fs::read_to_string(fixture.join("index.html")).unwrap();
    let source = fs::read_to_string(fixture.join("source.json")).unwrap();

    // The observed strings exist only after a runtime render; no static
    // input the probe reads contains them.
    for observed in [
        "The frost blossoms open at first light.",
        "Then let us walk before the town wakes.",
        "How do you answer Sora?",
        "Follow her into the snow.",
        "Stay by the warm hearth.",
    ] {
        assert!(
            !html.contains(observed),
            "static index.html leaked observed text: {observed}"
        );
        assert!(
            !source.contains(observed),
            "source.json leaked observed text: {observed}"
        );
    }

    // Parsing the raw static source directly yields no observed events:
    // only the live post-render DOM carries the island.
    assert!(parse_observed_dom(&html).is_empty());
    assert!(parse_observed_dom(&source).is_empty());
}

#[test]
fn build_observed_events_links_each_event_to_its_bridge_unit_without_a_browser() {
    let _browser_env = lock_browser_probe_env();
    // Unit-level proof of the envelope + parse + linkage logic that does
    // not need a live browser (the CI/oracle exercises real Chromium).
    let source = json!({
        "gameId": "mvmz-observation-fixture",
        "sourceLocale": "ja-JP",
        "units": [
            {"sourceUnitKey": "mvmz.scene1.line1"},
            {"sourceUnitKey": "mvmz.scene1.choice"},
            {"sourceUnitKey": "mvmz.scene1.choice.opt0"},
        ],
    });
    let dom = concat!(
        "<html><body><script>",
        "/*UTSUSHI-OBSERVED-BEGIN*/",
        r#"{"events":[{"kind":"text","unitKey":"mvmz.scene1.line1","speaker":"Yuki","textSurface":"dialogue","text":"Hello."},{"kind":"choice","unitKey":"mvmz.scene1.choice","prompt":"Pick","options":[{"optionId":"opt-0","label":"Go","unitKey":"mvmz.scene1.choice.opt0"}]}]}"#,
        "/*UTSUSHI-OBSERVED-END*/",
        "</script></body></html>"
    );

    let observed = parse_observed_dom(dom);
    assert_eq!(observed.len(), 2);

    let descriptor = BrowserLaunchAdapter::new().descriptor();
    let (trace_events, hook_events) = build_observed_events(&descriptor, &source, &observed);
    assert_eq!(trace_events.len(), 1);
    assert_eq!(hook_events.len(), 2);

    let text = &hook_events[0];
    assert_eq!(text["eventKind"], "text");
    assert_eq!(text["payload"]["text"], "Hello.");
    assert_eq!(text["bridgeRefs"][0]["sourceUnitKey"], "mvmz.scene1.line1");
    assert!(text["bridgeRefs"][0]["bridgeUnitId"].is_string());
    assert_eq!(text["evidenceTier"], "E1");
    assert_eq!(text["observationSource"], "live_dom");
    assert_eq!(text["adapterId"]["name"], BrowserLaunchAdapter::NAME);

    let choice = &hook_events[1];
    assert_eq!(choice["eventKind"], "choice");
    assert_eq!(
        choice["payload"]["options"][0]["bridgeRef"]["sourceUnitKey"],
        "mvmz.scene1.choice.opt0"
    );
}

#[test]
fn parse_observed_dom_returns_empty_for_missing_or_malformed_island() {
    assert!(parse_observed_dom("<html>no island here</html>").is_empty());
    assert!(
        parse_observed_dom("/*UTSUSHI-OBSERVED-BEGIN*/ not json /*UTSUSHI-OBSERVED-END*/")
            .is_empty()
    );
    // Begin marker but no end marker.
    assert!(parse_observed_dom("/*UTSUSHI-OBSERVED-BEGIN*/{\"events\":[]}").is_empty());
    // Well-formed but empty stream.
    assert!(
        parse_observed_dom("/*UTSUSHI-OBSERVED-BEGIN*/{\"events\":[]}/*UTSUSHI-OBSERVED-END*/")
            .is_empty()
    );
}
