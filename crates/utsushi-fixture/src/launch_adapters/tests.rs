use super::*;
use std::io::Write;
use std::sync::{
    Mutex, MutexGuard,
    atomic::{AtomicU64, Ordering},
};

static TEST_TEMP_DIR_COUNTER: AtomicU64 = AtomicU64::new(0);
static BROWSER_PROBE_ENV_LOCK: Mutex<()> = Mutex::new(());

fn lock_browser_probe_env() -> MutexGuard<'static, ()> {
    BROWSER_PROBE_ENV_LOCK
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

fn supported_test_chromium_version() -> super::browser_detection::ChromiumVersion {
    super::browser_detection::ChromiumVersion::Parsed {
        major: 124,
        minor: 0,
        patch: 6367,
    }
}

#[cfg(unix)]
fn fake_browser_adapter(fake_browser: PathBuf) -> BrowserLaunchAdapter {
    BrowserLaunchAdapter::with_browser_program_and_version(
        fake_browser,
        supported_test_chromium_version(),
    )
}

fn temp_dir(name: &str) -> PathBuf {
    let nonce = TEST_TEMP_DIR_COUNTER.fetch_add(1, Ordering::Relaxed);
    let dir = env::temp_dir().join(format!(
        "utsushi-launch-adapter-{name}-{}-{nonce}",
        std::process::id()
    ));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).unwrap();
    dir
}

fn write_browser_smoke_fixture(root: &Path) {
    fs::write(
        root.join("source.json"),
        r#"{
  "gameId": "browser-smoke-fixture",
  "title": "Browser Smoke Fixture",
  "sourceLocale": "ja-JP",
  "units": [
{
  "sourceUnitKey": "browser.smoke.001",
  "speaker": "Narrator",
  "textSurface": "dialogue",
  "sourceText": "ブラウザ起動確認。",
  "targetText": "Browser launch confirmed.",
  "protectedSpans": []
}
  ]
}
"#,
    )
    .unwrap();
    fs::write(
        root.join("index.html"),
        "<!doctype html><html><head><meta charset=\"utf-8\"><title>Utsushi Browser Smoke</title></head><body><main>Browser launch confirmed.</main></body></html>\n",
    )
    .unwrap();
}

#[cfg(unix)]
fn fake_browser(root: &Path, body: &str) -> PathBuf {
    use std::os::unix::fs::PermissionsExt;

    let path = root.join("fake-browser.sh");
    let mut file = fs::File::create(&path).unwrap();
    file.write_all(body.as_bytes()).unwrap();
    let mut permissions = file.metadata().unwrap().permissions();
    permissions.set_mode(0o755);
    fs::set_permissions(&path, permissions).unwrap();
    path
}

#[cfg(unix)]
fn shell_quote_path(path: &Path) -> String {
    format!("'{}'", path.to_string_lossy().replace('\'', "'\\''"))
}

#[test]
fn browser_descriptor_reports_launch_capture_capability() {
    let _browser_env = lock_browser_probe_env();
    let adapter = BrowserLaunchAdapter::new();
    let descriptor = adapter.descriptor();

    assert_eq!(descriptor.name, BrowserLaunchAdapter::NAME);
    assert!(descriptor.supports(RuntimeCapability::Trace));
    assert!(descriptor.supports(RuntimeCapability::FrameCapture));
    assert!(descriptor.supports(RuntimeCapability::SmokeValidation));
    assert!(descriptor.uses_approximation(ApproximationTier::LayoutProbe));
    assert_eq!(
        descriptor.capability_contract.capability_class,
        RuntimeCapabilityClass::LaunchCapture
    );
    assert!(
        descriptor
            .capability_contract
            .features
            .iter()
            .any(
                |feature| feature.feature == RuntimePlaybackFeature::Screenshot
                    && feature.status != utsushi_core::RuntimeFeatureStatus::Unsupported
            )
    );
    assert!(
        descriptor
            .capability_contract
            .features
            .iter()
            .any(
                |feature| feature.feature == RuntimePlaybackFeature::InstrumentationHooks
                    && feature.status == utsushi_core::RuntimeFeatureStatus::Partial
                    && feature.evidence_tier_ceiling == Some(EvidenceTier::E2)
            )
    );
    assert!(
        descriptor
            .diagnostics
            .iter()
            .any(|diagnostic| diagnostic.diagnostic_kind == "browser_host_availability")
    );
}

#[test]
fn browser_host_diagnostic_emits_error_severity_when_chromium_absent() {
    let _browser_env = lock_browser_probe_env();
    let root = temp_dir("browser-host-diagnostic");
    let private_missing_browser = root.join("private-browser-bin");
    let adapter = BrowserLaunchAdapter::with_browser_program(private_missing_browser.clone());
    let descriptor = adapter.descriptor();
    let diagnostic = descriptor
        .diagnostics
        .iter()
        .find(|diagnostic| diagnostic.diagnostic_kind == "browser_host_availability")
        .unwrap()
        .to_json();

    assert_eq!(diagnostic["status"], "unavailable");
    assert_eq!(diagnostic["severity"], "error");
    assert_eq!(diagnostic["details"]["hostAvailable"], false);
    assert_eq!(
        diagnostic["details"]["browserSource"],
        "configured_unavailable"
    );
    assert_eq!(
        diagnostic["details"]["requiredFor"],
        json!(["trace", "capture", "smoke_validation"])
    );
    assert_eq!(
        diagnostic["details"]["errorCode"],
        "utsushi.browser.chromium_unavailable"
    );
    let diagnostic_string = serde_json::to_string(&diagnostic).unwrap();
    assert!(!diagnostic_string.contains(root.to_string_lossy().as_ref()));
    assert!(!diagnostic_string.contains(private_missing_browser.to_string_lossy().as_ref()));
    let _ = fs::remove_dir_all(root);
}

#[test]
fn browser_descriptor_capability_contract_marks_browser_launch_as_required_for_mv_mz_alpha() {
    let contract = super::browser_capability_contract();
    let launch_feature = contract
        .features
        .iter()
        .find(|feature| feature.feature == RuntimePlaybackFeature::Launch)
        .expect("Launch feature is present");
    assert!(
        launch_feature
            .description
            .contains("Required for MV/MZ alpha runtime evidence"),
        "Launch feature description must declare alpha requirement: {description}",
        description = launch_feature.description,
    );
    assert!(
        launch_feature
            .limitations
            .iter()
            .any(|limitation| limitation.contains("hard utsushi.browser.chromium_unavailable")),
        "Launch limitations must call out the hard semantic-code outcome: {limitations:?}",
        limitations = launch_feature.limitations,
    );
    assert!(
        contract
            .limitations
            .iter()
            .any(|limitation| { limitation.contains("required for MV/MZ alpha runtime evidence") }),
        "Contract limitations must declare the MV/MZ alpha requirement: {limitations:?}",
        limitations = contract.limitations,
    );
    assert!(
        contract
            .limitations
            .iter()
            .any(|limitation| { limitation.contains("utsushi.browser.* namespace") }),
        "Contract limitations must reference the engine-neutral namespace: {limitations:?}",
        limitations = contract.limitations,
    );
}

#[test]
fn browser_descriptor_omits_when_host_support_exists_optionality_language() {
    let _browser_env = lock_browser_probe_env();
    let adapter = BrowserLaunchAdapter::new();
    let descriptor = adapter.descriptor();
    let serialized = serde_json::to_string(&json!({
        "limitations": descriptor.limitations,
        "capabilityContract": descriptor.capability_contract.to_json(),
    }))
    .unwrap();
    for forbidden in [
        "when host support exists",
        "host-capability dependent",
        "when the host supports",
    ] {
        assert!(
            !serialized.contains(forbidden),
            "descriptor still carries optionality phrase: {forbidden}",
        );
    }
}

#[test]
fn nwjs_descriptor_advertises_research_tier_status_diagnostic() {
    let adapter = NwjsLaunchAdapter::new();
    let descriptor = adapter.descriptor();

    assert_eq!(descriptor.name, NwjsLaunchAdapter::NAME);
    assert!(descriptor.capabilities.is_empty());
    let research_tier_diagnostics: Vec<_> = descriptor
        .diagnostics
        .iter()
        .filter(|diagnostic| diagnostic.diagnostic_kind == "research_tier_status")
        .collect();
    assert_eq!(
        research_tier_diagnostics.len(),
        1,
        "exactly one research_tier_status diagnostic is required"
    );
    let diagnostic = research_tier_diagnostics[0].to_json();
    assert_eq!(diagnostic["status"], "unsupported");
    assert_eq!(diagnostic["severity"], "info");
    assert_eq!(
        diagnostic["details"]["errorCode"],
        "utsushi.runtime.research_tier_unsupported"
    );
    assert_eq!(diagnostic["details"]["runtimeTier"], "research");
    assert_eq!(
        diagnostic["details"]["supersededBy"],
        BrowserLaunchAdapter::NAME
    );
    assert!(
        descriptor
            .capability_contract
            .features
            .iter()
            .all(|feature| feature.status == utsushi_core::RuntimeFeatureStatus::Unsupported)
    );
}

#[test]
fn nwjs_descriptor_limitations_mark_research_tier_explicitly() {
    let adapter = NwjsLaunchAdapter::new();
    let descriptor = adapter.descriptor();
    let first_limitation = descriptor.limitations.first().expect("limitations present");
    assert!(
        first_limitation.contains("research-tier"),
        "first limitation must mark research-tier explicitly: {first_limitation}",
    );
    assert!(
        first_limitation.contains("not advertised as an alpha capability"),
        "first limitation must call out alpha-capability exclusion: {first_limitation}",
    );
}

#[cfg(unix)]
#[test]
fn browser_smoke_uses_core_harness_and_persists_screenshot_artifact() {
    let _browser_env = lock_browser_probe_env();
    let root = temp_dir("browser-smoke");
    write_browser_smoke_fixture(&root);
    let artifact_root = root.join("runtime-artifacts");
    let observed_screenshot_path = root.join("observed-screenshot-path");
    let observed_screenshot_path_arg = shell_quote_path(&observed_screenshot_path);
    let fake_browser = fake_browser(
        &root,
        &format!(
            r#"#!/bin/sh
set -eu
screenshot=""
for arg in "$@"; do
  case "$arg" in
--screenshot=*) screenshot="${{arg#--screenshot=}}" ;;
  esac
done
if [ -z "$screenshot" ]; then
  exit 64
fi
mkdir -p "$(dirname "$screenshot")"
printf '%s' "$screenshot" > {observed_screenshot_path_arg}
printf '\211PNG\r\n\032\nutsushi fake browser screenshot\n' > "$screenshot"
"#,
        ),
    );
    let adapter = fake_browser_adapter(fake_browser);

    let report = adapter
        .smoke_validate(&RuntimeRequest::new(&root).with_artifact_root(&artifact_root))
        .unwrap();

    assert_eq!(report["adapterName"], BrowserLaunchAdapter::NAME);
    assert_eq!(report["status"], "passed");
    assert_eq!(report["evidenceTier"], "E2");
    assert_eq!(
        report["controlledPlaybackSession"]["requestedOperation"],
        "smoke_validation"
    );
    assert_eq!(report["captures"].as_array().unwrap().len(), 1);
    assert_eq!(report["observationHookEvents"].as_array().unwrap().len(), 2);
    assert!(
        report["runtimeCapabilities"]["features"]
            .as_array()
            .unwrap()
            .iter()
            .any(|feature| {
                feature["feature"] == "instrumentation_hooks"
                    && feature["status"] == "partial"
                    && feature["evidenceTierCeiling"] == "E2"
            })
    );
    assert!(
        report["controlledPlaybackSession"]["featuresUsed"]
            .as_array()
            .unwrap()
            .iter()
            .any(|feature| feature == "instrumentation_hooks")
    );
    assert_eq!(
        report["observationHookEvents"][0]["schemaVersion"],
        FIXTURE_OBSERVATION_HOOK_SCHEMA_LITERAL
    );
    assert_eq!(report["observationHookEvents"][0]["eventKind"], "text");
    assert_eq!(
        report["observationHookEvents"][0]["environment"]["runtime"],
        "browser"
    );
    assert_eq!(report["observationHookEvents"][1]["eventKind"], "frame");
    let artifact_ref = &report["captures"][0]["artifactRef"];
    assert_eq!(artifact_ref["artifactKind"], "screenshot");
    assert_eq!(
        artifact_ref["uri"],
        format!(
            "artifacts/utsushi/runtime/{BROWSER_RUN_ID}/screenshots/{BROWSER_SCREENSHOT_ID}.png"
        )
    );
    assert_eq!(
        report["observationHookEvents"][1]["payload"]["artifactRef"]["uri"],
        artifact_ref["uri"]
    );
    assert!(artifact_ref.get("localPath").is_none());
    assert!(artifact_ref.get("data").is_none());
    assert!(artifact_ref.get("bytes").is_none());
    let artifact_path = utsushi_core::RuntimeArtifactRoot::new(&artifact_root)
        .artifact_path(artifact_ref["uri"].as_str().unwrap())
        .unwrap();
    assert!(artifact_path.starts_with(&artifact_root));
    assert!(artifact_path.is_file());
    assert!(fs::read(&artifact_path).unwrap().starts_with(b"\x89PNG"));
    let browser_screenshot_path =
        PathBuf::from(fs::read_to_string(&observed_screenshot_path).unwrap());
    assert!(browser_screenshot_path.starts_with(&artifact_root));
    assert!(!browser_screenshot_path.exists());
    assert!(!artifact_root.join(".staging").exists());
    let report_string = serde_json::to_string(&report).unwrap();
    assert!(!report_string.contains(root.to_string_lossy().as_ref()));
    let _ = fs::remove_dir_all(root);
}

#[cfg(unix)]
#[test]
fn browser_capture_requires_managed_artifact_root_before_launch() {
    let _browser_env = lock_browser_probe_env();
    let root = temp_dir("browser-root-required");
    write_browser_smoke_fixture(&root);
    let launched_marker = root.join("launched");
    let launched_marker_arg = shell_quote_path(&launched_marker);
    let fake_browser = fake_browser(
        &root,
        &format!(
            r#"#!/bin/sh
set -eu
if [ "$1" = "--version" ]; then
  printf 'Chromium 124.0.6367.118 chromium-headless-shell\n'
  exit 0
fi
printf launched > {launched_marker_arg}
exit 0
"#,
        ),
    );
    let adapter = fake_browser_adapter(fake_browser);

    let error = adapter.capture(&RuntimeRequest::new(&root)).unwrap_err();
    let harness_error = error.downcast_ref::<RuntimeHarnessError>().unwrap();

    assert_eq!(
        harness_error.kind,
        RuntimeHarnessErrorKind::ArtifactStoreUnavailable
    );
    assert_eq!(harness_error.code(), "runtime_artifact_store_unavailable");
    assert!(!launched_marker.exists());
    let _ = fs::remove_dir_all(root);
}

#[cfg(unix)]
#[test]
fn browser_capture_reports_semantic_failure_when_screenshot_is_missing() {
    let _browser_env = lock_browser_probe_env();
    let root = temp_dir("browser-missing-screenshot");
    write_browser_smoke_fixture(&root);
    let artifact_root = root.join("runtime-artifacts");
    let fake_browser = fake_browser(
        &root,
        r"#!/bin/sh
set -eu
exit 0
",
    );
    let adapter = fake_browser_adapter(fake_browser);

    let error = adapter
        .capture(&RuntimeRequest::new(&root).with_artifact_root(&artifact_root))
        .unwrap_err();
    let harness_error = error.downcast_ref::<RuntimeHarnessError>().unwrap();

    assert_eq!(harness_error.kind, RuntimeHarnessErrorKind::CaptureFailed);
    assert_eq!(harness_error.code(), "runtime_capture_failed");
    assert!(harness_error.message.contains("did not produce"));
    assert!(!artifact_root.join(".staging").exists());
    let _ = fs::remove_dir_all(root);
}

#[cfg(unix)]
#[test]
fn browser_capture_does_not_promote_stale_staging_screenshot() {
    let _browser_env = lock_browser_probe_env();
    let root = temp_dir("browser-stale-screenshot");
    write_browser_smoke_fixture(&root);
    let artifact_root = root.join("runtime-artifacts");
    let stale_path = RuntimeArtifactRoot::new(&artifact_root)
        .prepare_staging_file(BROWSER_RUN_ID, BROWSER_SCREENSHOT_ID, "png")
        .unwrap();
    fs::write(&stale_path, b"\x89PNG\r\n\x1a\nstale screenshot bytes\n").unwrap();
    let fake_browser = fake_browser(
        &root,
        r"#!/bin/sh
set -eu
exit 0
",
    );
    let adapter = fake_browser_adapter(fake_browser);

    let error = adapter
        .capture(&RuntimeRequest::new(&root).with_artifact_root(&artifact_root))
        .unwrap_err();
    let harness_error = error.downcast_ref::<RuntimeHarnessError>().unwrap();

    // CaptureFailed (no PNG) or LaunchFailed (spawn refused): no promotion.
    assert!(
        matches!(
            harness_error.kind,
            RuntimeHarnessErrorKind::CaptureFailed | RuntimeHarnessErrorKind::LaunchFailed
        ),
        "expected CaptureFailed|LaunchFailed, got {:?}",
        harness_error.kind
    );
    let artifact_uri = utsushi_core::runtime_artifact_uri(
        BROWSER_RUN_ID,
        RuntimeArtifactKind::Screenshot,
        BROWSER_SCREENSHOT_ID,
    )
    .unwrap();
    let artifact_path = RuntimeArtifactRoot::new(&artifact_root)
        .artifact_path(&artifact_uri)
        .unwrap();
    assert!(!artifact_path.exists());
    assert!(!artifact_root.join(".staging").exists());
    let _ = fs::remove_dir_all(root);
}

#[test]
fn browser_run_returns_chromium_unavailable_kind_when_binary_missing() {
    let _browser_env = lock_browser_probe_env();
    let root = temp_dir("browser-binary-missing");
    write_browser_smoke_fixture(&root);
    let artifact_root = root.join("runtime-artifacts");
    let bogus = root.join("does-not-exist-browser");
    let adapter = BrowserLaunchAdapter::with_browser_program(bogus.clone());

    let error = adapter
        .smoke_validate(&RuntimeRequest::new(&root).with_artifact_root(&artifact_root))
        .unwrap_err();
    let harness_error = error.downcast_ref::<RuntimeHarnessError>().unwrap();

    assert_eq!(
        harness_error.kind,
        RuntimeHarnessErrorKind::ChromiumUnavailable
    );
    assert_eq!(harness_error.code(), "runtime_browser_chromium_unavailable");
    let semantic = harness_error
        .details
        .iter()
        .find(|(key, _)| key == "semanticCode")
        .map(|(_, value)| value.as_str());
    assert_eq!(semantic, Some("utsushi.browser.chromium_unavailable"));
    let error_string = serde_json::to_string(&harness_error.to_json()).unwrap();
    assert!(!error_string.contains(bogus.to_string_lossy().as_ref()));
    let _ = fs::remove_dir_all(root);
}

#[cfg(unix)]
#[test]
// reason: this test mutates process env via the unavoidably unsafe
// std::env::{set_var,remove_var} (edition 2024) through a scoped EnvGuard.
// Test-only; src stays unsafe-free.
#[allow(unsafe_code)]
fn browser_run_returns_chromium_unavailable_when_env_browser_bin_broken() {
    // Scoped env guard: this test sets UTSUSHI_BROWSER_BIN to a bogus
    // path, asserts the typed semantic outcome, and restores the
    // previous env value on drop. Tests that read browser probe env take
    // BROWSER_PROBE_ENV_LOCK so this scoped mutation cannot leak across
    // parallel test execution.
    struct EnvGuard {
        previous: Option<std::ffi::OsString>,
    }
    impl EnvGuard {
        fn set(value: &str) -> Self {
            let previous = env::var_os("UTSUSHI_BROWSER_BIN");
            // SAFETY: This is a deliberate, scoped mutation for a test
            // that does not run concurrently with other UTSUSHI_BROWSER_BIN
            // consumers.
            unsafe {
                env::set_var("UTSUSHI_BROWSER_BIN", value);
            }
            Self { previous }
        }
    }
    impl Drop for EnvGuard {
        fn drop(&mut self) {
            // SAFETY: see EnvGuard::set.
            unsafe {
                match &self.previous {
                    Some(value) => env::set_var("UTSUSHI_BROWSER_BIN", value),
                    None => env::remove_var("UTSUSHI_BROWSER_BIN"),
                }
            }
        }
    }

    let _browser_env = lock_browser_probe_env();
    let root = temp_dir("browser-env-broken");
    write_browser_smoke_fixture(&root);
    let artifact_root = root.join("runtime-artifacts");
    let bogus = root.join("env-pointed-missing-browser");
    let _guard = EnvGuard::set(bogus.to_string_lossy().as_ref());
    let adapter = BrowserLaunchAdapter::new();

    let error = adapter
        .smoke_validate(&RuntimeRequest::new(&root).with_artifact_root(&artifact_root))
        .unwrap_err();
    let harness_error = error.downcast_ref::<RuntimeHarnessError>().unwrap();

    assert_eq!(
        harness_error.kind,
        RuntimeHarnessErrorKind::ChromiumUnavailable
    );
    let semantic = harness_error
        .details
        .iter()
        .find(|(key, _)| key == "semanticCode")
        .map(|(_, value)| value.as_str());
    assert_eq!(semantic, Some("utsushi.browser.chromium_unavailable"));
    let source = harness_error
        .details
        .iter()
        .find(|(key, _)| key == "browserSource")
        .map(|(_, value)| value.as_str());
    assert_eq!(source, Some("environment_unavailable"));
    let _ = fs::remove_dir_all(root);
}

#[cfg(unix)]
#[test]
fn browser_run_returns_chromium_version_mismatch_when_version_too_old() {
    let _browser_env = lock_browser_probe_env();
    let root = temp_dir("browser-version-too-old");
    write_browser_smoke_fixture(&root);
    let artifact_root = root.join("runtime-artifacts");
    // Deterministic too-old version (major 50 < floor 100) via probe override —
    // avoids flaky real `--version` shell-outs under CI concurrency. Fake
    // browser prints a newer version so a regression to shell-out would fail.
    let fake_browser = fake_browser(
        &root,
        r#"#!/bin/sh
set -eu
if [ "$1" = "--version" ]; then
  printf 'Chromium 124.0.6367.118 chromium-headless-shell\n'
  exit 0
fi
exit 0
"#,
    );
    let adapter = BrowserLaunchAdapter::with_browser_program_and_version(
        fake_browser,
        super::browser_detection::ChromiumVersion::Parsed {
            major: 50,
            minor: 0,
            patch: 2661,
        },
    );

    let error = adapter
        .smoke_validate(&RuntimeRequest::new(&root).with_artifact_root(&artifact_root))
        .unwrap_err();
    let harness_error = error.downcast_ref::<RuntimeHarnessError>().unwrap();

    assert_eq!(
        harness_error.kind,
        RuntimeHarnessErrorKind::ChromiumVersionMismatch
    );
    assert_eq!(
        harness_error.code(),
        "runtime_browser_chromium_version_mismatch"
    );
    let semantic = harness_error
        .details
        .iter()
        .find(|(key, _)| key == "semanticCode")
        .map(|(_, value)| value.as_str());
    assert_eq!(semantic, Some("utsushi.browser.chromium_version_mismatch"));
    let detected = harness_error
        .details
        .iter()
        .find(|(key, _)| key == "chromiumVersionDetected")
        .map(|(_, value)| value.as_str());
    assert_eq!(detected, Some("50.0.2661"));
    let _ = fs::remove_dir_all(root);
}

#[cfg(unix)]
#[test]
fn browser_descriptor_does_not_invoke_browser_launch_during_version_probe() {
    let _browser_env = lock_browser_probe_env();
    let root = temp_dir("browser-probe-only-version");
    let launch_marker = root.join("launched-non-version");
    let launch_marker_arg = shell_quote_path(&launch_marker);
    let fake_browser = fake_browser(
        &root,
        &format!(
            r#"#!/bin/sh
set -eu
if [ "$1" = "--version" ]; then
  printf 'Chromium 124.0.6367.118 chromium-headless-shell\n'
  exit 0
fi
printf launched > {launch_marker_arg}
exit 0
"#,
        ),
    );
    let adapter = BrowserLaunchAdapter::with_browser_program(fake_browser);
    for _ in 0..3 {
        let _ = adapter.descriptor();
    }
    assert!(
        !launch_marker.exists(),
        "descriptor() must only invoke --version on the configured browser"
    );
    let _ = fs::remove_dir_all(root);
}

#[cfg(unix)]
#[test]
fn browser_descriptor_version_probe_is_bounded_by_timeout() {
    let _browser_env = lock_browser_probe_env();
    let root = temp_dir("browser-probe-sleep");
    let fake_browser = fake_browser(
        &root,
        r#"#!/bin/sh
set -eu
if [ "$1" = "--version" ]; then
  sleep 60
fi
exit 0
"#,
    );
    let adapter = BrowserLaunchAdapter::with_browser_program(fake_browser);

    let started = std::time::Instant::now();
    let descriptor = adapter.descriptor();
    let elapsed = started.elapsed();
    assert!(
        elapsed < std::time::Duration::from_secs(5),
        "descriptor() must complete under the bounded probe timeout, took {elapsed:?}",
    );
    let diagnostic = descriptor
        .diagnostics
        .iter()
        .find(|diagnostic| diagnostic.diagnostic_kind == "browser_host_availability")
        .unwrap()
        .to_json();
    // A wedged --version leaves the version Unknown, which still passes
    // the major-version floor (only mismatches < CHROMIUM_MIN_SUPPORTED_MAJOR
    // are rejected); the diagnostic must therefore report available with
    // chromiumVersion == "unknown" so operators can audit the probe.
    assert_eq!(diagnostic["status"], "available");
    assert_eq!(diagnostic["details"]["chromiumVersion"], "unknown");
    let _ = fs::remove_dir_all(root);
}

#[test]
fn nwjs_trace_returns_research_tier_unsupported_semantic_code() {
    let root = temp_dir("nwjs-trace-research");
    let adapter = NwjsLaunchAdapter::new();
    let error = adapter.trace(&RuntimeRequest::new(&root)).unwrap_err();
    let harness_error = error.downcast_ref::<RuntimeHarnessError>().unwrap();
    assert_eq!(
        harness_error.kind,
        RuntimeHarnessErrorKind::ResearchTierUnsupported
    );
    assert_eq!(harness_error.code(), "runtime_research_tier_unsupported");
    let semantic = harness_error
        .details
        .iter()
        .find(|(key, _)| key == "semanticCode")
        .map(|(_, value)| value.as_str());
    assert_eq!(semantic, Some("utsushi.runtime.research_tier_unsupported"));
    let _ = fs::remove_dir_all(root);
}

#[test]
fn nwjs_capture_and_smoke_validate_return_research_tier_unsupported() {
    let root = temp_dir("nwjs-capture-research");
    let adapter = NwjsLaunchAdapter::new();
    for op_error in [
        adapter.capture(&RuntimeRequest::new(&root)).unwrap_err(),
        adapter
            .smoke_validate(&RuntimeRequest::new(&root))
            .unwrap_err(),
    ] {
        let harness_error = op_error.downcast_ref::<RuntimeHarnessError>().unwrap();
        assert_eq!(
            harness_error.kind,
            RuntimeHarnessErrorKind::ResearchTierUnsupported
        );
        let semantic = harness_error
            .details
            .iter()
            .find(|(key, _)| key == "semanticCode")
            .map(|(_, value)| value.as_str());
        assert_eq!(semantic, Some("utsushi.runtime.research_tier_unsupported"));
    }
    let _ = fs::remove_dir_all(root);
}

#[test]
fn reserved_display_unavailable_reason_carries_typed_semantic_code() {
    // Wiring smoke for the DisplayUnavailable variant: pins the semantic
    // code, harness error kind, and detail-attachment contract that the
    // real strict-display probe () relies on. Uses the
    // deterministic force_display_unavailable constructor so the contract
    // is asserted without depending on host display env.
    let reason = super::browser_detection::force_display_unavailable();
    assert_eq!(
        reason.semantic_code(),
        "utsushi.browser.display_unavailable"
    );
    assert_eq!(
        reason.harness_error_kind(),
        RuntimeHarnessErrorKind::ChromiumDisplayUnavailable
    );
    let harness = super::unavailability_harness_error(RuntimeOperation::SmokeValidation, &reason);
    let semantic = harness
        .details
        .iter()
        .find(|(key, _)| key == "semanticCode")
        .map(|(_, value)| value.as_str());
    assert_eq!(semantic, Some("utsushi.browser.display_unavailable"));
    let probe = harness
        .details
        .iter()
        .find(|(key, _)| key == "displayProbe")
        .map(|(_, value)| value.as_str());
    assert_eq!(probe, Some("unavailable_strict"));
}

#[test]
fn strict_display_policy_gate_off_default_is_headless_only() {
    // Gate OFF (default): a missing display surface is NOT an error, so
    // the headless launch path is unchanged. Uses the pure
    // policy fn so the default is asserted deterministically regardless
    // of host env, on every platform.
    for platform_uses_display_env in [true, false] {
        let outcome = super::browser_detection::evaluate_display(
            false, // strict gate off
            false, // no display surface
            platform_uses_display_env,
            super::browser_detection::BrowserDetectionLabel::Path,
            "linux",
        );
        assert_eq!(
            outcome,
            Ok(super::browser_detection::DisplayProbeOutcome::HeadlessOnly)
        );
    }
    // A present surface is always usable, gate on or off.
    for strict in [true, false] {
        let outcome = super::browser_detection::evaluate_display(
            strict,
            true, // display present
            true,
            super::browser_detection::BrowserDetectionLabel::Path,
            "linux",
        );
        assert_eq!(
            outcome,
            Ok(super::browser_detection::DisplayProbeOutcome::PresentEnv)
        );
    }
}

#[test]
fn strict_display_policy_gate_on_no_surface_emits_display_unavailable() {
    // Gate ON + no display surface on an env-convention platform -> hard
    // DisplayUnavailable carrying the typed semantic code. On a native-
    // window platform (macOS/Windows) the env signal is inapplicable, so
    // the same inputs stay PresentEnv rather than false-positive.
    let unavailable = super::browser_detection::evaluate_display(
        true,  // strict gate on
        false, // no display surface
        true,  // env-convention platform (Linux/BSD)
        super::browser_detection::BrowserDetectionLabel::Path,
        "linux",
    );
    let reason = unavailable.expect_err("strict + no surface must be an error");
    assert_eq!(
        reason.semantic_code(),
        "utsushi.browser.display_unavailable"
    );
    assert_eq!(
        reason.harness_error_kind(),
        RuntimeHarnessErrorKind::ChromiumDisplayUnavailable
    );
    let harness = super::unavailability_harness_error(RuntimeOperation::SmokeValidation, &reason);
    let semantic = harness
        .details
        .iter()
        .find(|(key, _)| key == "semanticCode")
        .map(|(_, value)| value.as_str());
    assert_eq!(semantic, Some("utsushi.browser.display_unavailable"));
    let probe = harness
        .details
        .iter()
        .find(|(key, _)| key == "displayProbe")
        .map(|(_, value)| value.as_str());
    assert_eq!(probe, Some("unavailable_strict"));

    // Native-window platform: same strict/no-surface inputs stay present.
    let native = super::browser_detection::evaluate_display(
        true,
        false,
        false, // native-window platform (macOS/Windows)
        super::browser_detection::BrowserDetectionLabel::Path,
        "macos",
    );
    assert_eq!(
        native,
        Ok(super::browser_detection::DisplayProbeOutcome::PresentEnv)
    );
}

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
