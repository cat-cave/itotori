use super::*;
pub(super) fn fidelity_tiers_match_runtime_schema_evidence_ceilings() {
    assert_eq!(FidelityTier::TraceOnly.evidence_ceiling(), EvidenceTier::E1);
    assert_eq!(
        FidelityTier::LayoutProbe.evidence_ceiling(),
        EvidenceTier::E2
    );
    assert_eq!(
        FidelityTier::ReplayReview.evidence_ceiling(),
        EvidenceTier::E3
    );
    assert_eq!(
        FidelityTier::ReferenceFidelity.evidence_ceiling(),
        EvidenceTier::E4
    );
}

pub(super) fn registry_dispatches_by_adapter_name() {
    let adapter = FakeTraceAdapter;
    let mut registry = RuntimeAdapterRegistry::new();
    registry.register(&adapter).unwrap();

    let input_root = Path::new("fixtures/hello-game");
    let report = registry
        .run(
            "fake-trace",
            RuntimeOperation::Trace,
            &RuntimeRequest::new(input_root),
        )
        .unwrap();

    assert_eq!(report["operation"], "trace");
    assert_eq!(report["inputRoot"], "fixtures/hello-game");
    assert_eq!(registry.descriptors()[0].name, "fake-trace");
}

pub(super) fn registry_rejects_duplicate_adapter_names() {
    let adapter = FakeTraceAdapter;
    let mut registry = RuntimeAdapterRegistry::new();

    registry.register(&adapter).unwrap();
    let error = registry.register(&adapter).unwrap_err().to_string();

    assert!(error.contains("already registered"));
}

pub(super) fn registry_rejects_adapter_evidence_overclaims() {
    let adapter = OverclaimingAdapter;
    let mut registry = RuntimeAdapterRegistry::new();

    let error = registry.register(&adapter).unwrap_err().to_string();

    assert!(error.contains("exceeds"));
}

pub(super) fn capability_contract_serializes_base_unsupported_features() {
    let contract = trace_contract();
    contract.validate().unwrap();

    let value = contract.to_json();

    assert_eq!(value["capabilityClass"], "static_trace");
    assert_eq!(value["evidenceTierCeiling"], "E1");
    assert!(
        value["features"]
            .as_array()
            .unwrap()
            .iter()
            .any(|feature| { feature["feature"] == "jump" && feature["status"] == "unsupported" })
    );
    assert!(
        value["features"].as_array().unwrap().iter().any(|feature| {
            feature["feature"] == "snapshot" && feature["status"] == "unsupported"
        })
    );
    assert!(value["features"].as_array().unwrap().iter().any(|feature| {
        feature["feature"] == "screenshot" && feature["status"] == "unsupported"
    }));
    assert!(value["features"].as_array().unwrap().iter().any(|feature| {
        feature["feature"] == "recording" && feature["status"] == "unsupported"
    }));
}

pub(super) fn capability_classes_map_to_expected_evidence_boundaries() {
    assert_eq!(
        RuntimeCapabilityClass::StaticTrace.evidence_tier_ceiling(),
        EvidenceTier::E1
    );
    assert_eq!(
        RuntimeCapabilityClass::LaunchCapture.evidence_tier_ceiling(),
        EvidenceTier::E2
    );
    assert_eq!(
        RuntimeCapabilityClass::InstrumentedRuntime.evidence_tier_ceiling(),
        EvidenceTier::E3
    );
    assert_eq!(
        RuntimeCapabilityClass::PartialVm.evidence_tier_ceiling(),
        EvidenceTier::E3
    );
    assert_eq!(
        RuntimeCapabilityClass::ReferenceVm.evidence_tier_ceiling(),
        EvidenceTier::E4
    );
}

pub(super) fn registry_fails_closed_for_unsupported_operations() {
    let adapter = FakeTraceAdapter;
    let mut registry = RuntimeAdapterRegistry::new();
    registry.register(&adapter).unwrap();

    let error = registry
        .run(
            "fake-trace",
            RuntimeOperation::Capture,
            &RuntimeRequest::new(Path::new("fixtures/hello-game")),
        )
        .unwrap_err()
        .to_string();

    assert!(error.contains("does not support capture"));
}

pub(super) fn launch_capture_harness_captures_stdout_when_requested() {
    let plan = RuntimeLaunchCapturePlan::new(
        HARNESS_RUN_ID,
        RuntimeOperation::Trace,
        harness_child_command("tests::harness_child_prints_stdout_sentinel"),
    )
    .with_timeout(Duration::from_secs(5))
    .with_shutdown_grace(Duration::from_secs(1))
    .with_stdout_capture(true);
    let harness = RuntimeLaunchCaptureHarness::new();
    let mut hooks = RuntimeCaptureHooks::new();

    let outcome = harness.run(&plan, &mut hooks).unwrap();

    assert!(outcome.exit.success);
    let stdout = outcome
        .stdout
        .expect("stdout must be captured when the plan requests it");
    assert!(
        stdout.contains(HARNESS_STDOUT_SENTINEL),
        "captured stdout should carry the live child output, was: {stdout}"
    );
}

pub(super) fn launch_capture_harness_discards_stdout_by_default() {
    let plan = RuntimeLaunchCapturePlan::new(
        HARNESS_RUN_ID,
        RuntimeOperation::Trace,
        harness_child_command("tests::harness_child_prints_stdout_sentinel"),
    )
    .with_timeout(Duration::from_secs(5))
    .with_shutdown_grace(Duration::from_secs(1));
    let harness = RuntimeLaunchCaptureHarness::new();
    let mut hooks = RuntimeCaptureHooks::new();

    let outcome = harness.run(&plan, &mut hooks).unwrap();

    assert!(outcome.exit.success);
    assert!(
        outcome.stdout.is_none(),
        "stdout must be discarded unless capture is explicitly enabled"
    );
}

pub(super) fn launch_capture_harness_runs_process_and_persists_hook_artifacts() {
    let temp = temp_root("harness-success");
    let artifact_root = temp.join("runtime-artifacts");
    let plan = RuntimeLaunchCapturePlan::new(
        HARNESS_RUN_ID,
        RuntimeOperation::Capture,
        harness_child_command("tests::harness_child_exits"),
    )
    .with_artifact_root(&artifact_root)
    .with_timeout(Duration::from_secs(5))
    .with_shutdown_grace(Duration::from_secs(1));
    let harness = RuntimeLaunchCaptureHarness::new();
    let calls = Arc::new(AtomicUsize::new(0));
    let mut hooks = RuntimeCaptureHooks::new();
    hooks.push(WritingCaptureHook::new(
        RuntimeCaptureBoundary::AfterLaunch,
        Arc::clone(&calls),
    ));

    let outcome = harness.run(&plan, &mut hooks).unwrap();

    assert!(outcome.exit.success);
    assert_eq!(calls.load(Ordering::SeqCst), 1);
    assert_eq!(outcome.artifacts.len(), 2);
    let screenshot = &outcome.artifacts[0];
    assert_eq!(screenshot.artifact_kind, RuntimeArtifactKind::Screenshot);
    assert_eq!(
        screenshot.boundary,
        Some(RuntimeCaptureBoundary::AfterLaunch)
    );
    assert!(screenshot.path.starts_with(&artifact_root));
    assert!(screenshot.path.is_file());
    assert_eq!(
        fs::read(&screenshot.path).unwrap(),
        b"runtime screenshot bytes"
    );
    let frame_capture = &outcome.artifacts[1];
    assert_eq!(
        frame_capture.artifact_kind,
        RuntimeArtifactKind::FrameCapture
    );
    assert!(frame_capture.path.starts_with(&artifact_root));
    assert!(frame_capture.path.is_file());

    let artifact_ref = screenshot.artifact_ref_json();
    assert_eq!(artifact_ref["artifactKind"], "screenshot");
    assert_eq!(
        artifact_ref["uri"],
        format!(
            "{RUNTIME_ARTIFACT_URI_ROOT}/{HARNESS_RUN_ID}/screenshots/{HARNESS_SCREENSHOT_ID}.png"
        )
    );
    assert!(artifact_ref.get("data").is_none());
    assert!(artifact_ref.get("bytes").is_none());
    assert!(artifact_ref.get("localPath").is_none());
    assert!(artifact_root.join(RUNTIME_ARTIFACT_ROOT_MARKER).is_file());
    let _ = fs::remove_dir_all(temp);
}

pub(super) fn launch_capture_harness_times_out_and_reaps_child() {
    let plan = RuntimeLaunchCapturePlan::new(
        HARNESS_RUN_ID,
        RuntimeOperation::Capture,
        harness_child_command("tests::harness_child_sleeps"),
    )
    .with_timeout(Duration::from_millis(50))
    .with_shutdown_grace(Duration::from_secs(1))
    .with_poll_interval(Duration::from_millis(5));
    let harness = RuntimeLaunchCaptureHarness::new();
    let started_at = Instant::now();
    let mut hooks = RuntimeCaptureHooks::new();

    let error = harness.run(&plan, &mut hooks).unwrap_err();

    assert!(started_at.elapsed() < Duration::from_secs(3));
    assert_eq!(error.kind, RuntimeHarnessErrorKind::Timeout);
    assert_eq!(error.code(), "runtime_launch_timeout");
    let cleanup = error.cleanup.unwrap();
    assert!(cleanup.attempted);
    assert!(cleanup.completed);
    assert_eq!(cleanup.scope, RuntimeProcessCleanupScope::ProcessTree);
    assert!(error.process_id.is_some());
}

pub(super) fn launch_failures_report_semantic_errors() {
    let temp = temp_root("harness-launch-error");
    let missing_command = temp.join("missing-runtime-command");
    let plan = RuntimeLaunchCapturePlan::new(
        HARNESS_RUN_ID,
        RuntimeOperation::Capture,
        RuntimeLaunchCommand::new(&missing_command),
    );
    let harness = RuntimeLaunchCaptureHarness::new();
    let mut hooks = RuntimeCaptureHooks::new();

    let error = harness.run(&plan, &mut hooks).unwrap_err();

    assert_eq!(error.kind, RuntimeHarnessErrorKind::LaunchFailed);
    let semantic = error.to_json();
    assert_eq!(semantic["errorCode"], "runtime_launch_failed");
    assert_eq!(semantic["operation"], "capture");
    assert!(
        semantic["message"]
            .as_str()
            .unwrap()
            .contains("failed to launch")
    );

    let finding = error.to_validation_finding(
        "019ed003-0000-7000-8000-000000009014",
        "unsupported_runtime_feature",
        "critical",
        EvidenceTier::E1,
    );
    assert_eq!(finding["findingKind"], "unsupported_runtime_feature");
    assert!(
        finding["message"]
            .as_str()
            .unwrap()
            .contains("runtime_launch_failed")
    );
    let _ = fs::remove_dir_all(temp);
}

pub(super) fn capture_hooks_require_managed_artifact_store_boundary() {
    let plan = RuntimeLaunchCapturePlan::new(
        HARNESS_RUN_ID,
        RuntimeOperation::Capture,
        harness_child_command("tests::harness_child_sleeps"),
    )
    .with_timeout(Duration::from_secs(5))
    .with_shutdown_grace(Duration::from_secs(1))
    .with_poll_interval(Duration::from_millis(5));
    let harness = RuntimeLaunchCaptureHarness::new();
    let mut hooks = RuntimeCaptureHooks::new();
    hooks.push(ArtifactRequiredHook);

    let error = harness.run(&plan, &mut hooks).unwrap_err();

    assert_eq!(
        error.kind,
        RuntimeHarnessErrorKind::ArtifactStoreUnavailable
    );
    assert_eq!(error.boundary, Some(RuntimeCaptureBoundary::AfterLaunch));
    let cleanup = error.cleanup.unwrap();
    assert!(cleanup.attempted);
    assert!(cleanup.completed);
    assert_eq!(cleanup.scope, RuntimeProcessCleanupScope::ProcessTree);
    assert_eq!(
        error.to_json()["errorCode"],
        "runtime_artifact_store_unavailable"
    );
}

pub(super) fn after_launch_hook_timeout_cleans_up_runtime_process() {
    let plan = RuntimeLaunchCapturePlan::new(
        HARNESS_RUN_ID,
        RuntimeOperation::Capture,
        harness_child_command("tests::harness_child_sleeps"),
    )
    .with_timeout(Duration::from_secs(5))
    .with_hook_timeout(Duration::from_millis(50))
    .with_shutdown_grace(Duration::from_secs(1))
    .with_poll_interval(Duration::from_millis(5));
    let harness = RuntimeLaunchCaptureHarness::new();
    let started = Arc::new(AtomicBool::new(false));
    let mut hooks = RuntimeCaptureHooks::new();
    hooks.push(SleepingCaptureHook {
        boundary: RuntimeCaptureBoundary::AfterLaunch,
        started: Arc::clone(&started),
        sleep: Duration::from_secs(2),
    });
    let started_at = Instant::now();

    let error = harness.run(&plan, &mut hooks).unwrap_err();

    assert!(started.load(Ordering::SeqCst));
    assert!(started_at.elapsed() < Duration::from_secs(2));
    assert_eq!(error.kind, RuntimeHarnessErrorKind::CaptureTimeout);
    assert_eq!(error.boundary, Some(RuntimeCaptureBoundary::AfterLaunch));
    assert_eq!(error.code(), "runtime_capture_timeout");
    let cleanup = error.cleanup.unwrap();
    assert!(cleanup.attempted);
    assert!(cleanup.completed);
    assert_eq!(cleanup.scope, RuntimeProcessCleanupScope::ProcessTree);
}

// a hook that times out during launch-capture leaves a detached
// worker thread running that still holds a clone of the managed artifact
// store. This test proves that once the capture boundary closes, a late
// write from that worker is REFUSED by the write fence (managed artifact
// state unchanged), while the timeout diagnostic still names the boundary.
pub(super) fn timed_out_hook_write_is_fenced_after_capture_boundary() {
    let temp = temp_root("harness-fence-late");
    let artifact_root = temp.join("runtime-artifacts");
    let plan = RuntimeLaunchCapturePlan::new(
        HARNESS_RUN_ID,
        RuntimeOperation::Capture,
        harness_child_command("tests::harness_child_sleeps"),
    )
    .with_artifact_root(&artifact_root)
    .with_timeout(Duration::from_secs(5))
    .with_hook_timeout(Duration::from_millis(50))
    .with_shutdown_grace(Duration::from_secs(1))
    .with_poll_interval(Duration::from_millis(5));
    let harness = RuntimeLaunchCaptureHarness::new();
    let started = Arc::new(AtomicBool::new(false));
    let late_write: Arc<Mutex<Option<Result<PathBuf, String>>>> = Arc::new(Mutex::new(None));
    let (proceed_tx, proceed_rx) = mpsc::channel();
    let mut hooks = RuntimeCaptureHooks::new();
    hooks.push(LateWritingCaptureHook {
        boundary: RuntimeCaptureBoundary::AfterLaunch,
        started: Arc::clone(&started),
        proceed: proceed_rx,
        late_write: Arc::clone(&late_write),
    });

    // The hook blocks (never receives `proceed`) so the harness times it out
    // and `launch-capture` returns.
    let error = harness.run(&plan, &mut hooks).unwrap_err();

    // (3) The timeout diagnostic still identifies the capture boundary and
    // is distinct from the fenced-late-write refusal below.
    assert!(started.load(Ordering::SeqCst));
    assert_eq!(error.kind, RuntimeHarnessErrorKind::CaptureTimeout);
    assert_eq!(error.code(), "runtime_capture_timeout");
    assert_eq!(error.boundary, Some(RuntimeCaptureBoundary::AfterLaunch));

    // launch-capture has returned; release the detached worker so it now
    // attempts a managed-artifact write strictly after the capture boundary.
    proceed_tx.send(()).unwrap();

    // The late write is refused with a code distinct from the timeout.
    match wait_for_late_write(&late_write, Duration::from_secs(5)) {
        Some(Err(code)) => assert_eq!(code, "runtime_capture_boundary_closed"),
        other => panic!("expected fenced late write to be refused, got {other:?}"),
    }

    // Crux + mutation proof: managed artifact state is unchanged. Without the
    // fence check in `write_artifact`, this file would have been created by
    // the detached worker and this assertion would fail.
    let leaked = artifact_root
        .join(HARNESS_RUN_ID)
        .join("screenshots")
        .join(format!("{HARNESS_SCREENSHOT_ID}.png"));
    assert!(
        !leaked.exists(),
        "fenced late write must not create a managed artifact: {}",
        leaked.display()
    );

    let _ = fs::remove_dir_all(temp);
}

// the fence must not disturb the normal path — a write made
// while the capture window is still valid (fence open) succeeds and persists.
