use super::*;
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
