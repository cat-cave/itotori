use super::*;
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
