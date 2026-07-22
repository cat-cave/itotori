use super::*;
pub(super) fn in_boundary_hook_write_succeeds_within_fence() {
    let temp = temp_root("harness-fence-inbound");
    let artifact_root = temp.join("runtime-artifacts");
    let plan = RuntimeLaunchCapturePlan::new(
        HARNESS_RUN_ID,
        RuntimeOperation::Capture,
        harness_child_command("tests::harness_child_exits"),
    )
    .with_artifact_root(&artifact_root)
    .with_timeout(Duration::from_secs(5))
    .with_hook_timeout(Duration::from_secs(5))
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
    for artifact in &outcome.artifacts {
        assert!(artifact.path.starts_with(&artifact_root));
        assert!(artifact.path.is_file());
    }
    let _ = fs::remove_dir_all(temp);
}

pub(super) fn panicking_capture_hooks_are_contained_and_cleanup_runtime_process() {
    let plan = RuntimeLaunchCapturePlan::new(
        HARNESS_RUN_ID,
        RuntimeOperation::Capture,
        harness_child_command("tests::harness_child_sleeps"),
    )
    .with_timeout(Duration::from_secs(5))
    .with_hook_timeout(Duration::from_secs(1))
    .with_shutdown_grace(Duration::from_secs(1))
    .with_poll_interval(Duration::from_millis(5));
    let harness = RuntimeLaunchCaptureHarness::new();
    let mut hooks = RuntimeCaptureHooks::new();
    hooks.push(PanickingCaptureHook {
        boundary: RuntimeCaptureBoundary::AfterLaunch,
    });

    let error = harness.run(&plan, &mut hooks).unwrap_err();

    assert_eq!(error.kind, RuntimeHarnessErrorKind::CaptureFailed);
    assert_eq!(error.boundary, Some(RuntimeCaptureBoundary::AfterLaunch));
    assert!(error.message.contains("capture hook panicked"));
    let cleanup = error.cleanup.unwrap();
    assert!(cleanup.attempted);
    assert!(cleanup.completed);
    assert_eq!(cleanup.scope, RuntimeProcessCleanupScope::ProcessTree);
}

pub(super) fn before_terminate_hook_timeout_does_not_delay_cleanup() {
    let plan = RuntimeLaunchCapturePlan::new(
        HARNESS_RUN_ID,
        RuntimeOperation::Capture,
        harness_child_command("tests::harness_child_sleeps"),
    )
    .with_timeout(Duration::from_millis(50))
    .with_hook_timeout(Duration::from_millis(50))
    .with_shutdown_grace(Duration::from_secs(1))
    .with_poll_interval(Duration::from_millis(5));
    let harness = RuntimeLaunchCaptureHarness::new();
    let started = Arc::new(AtomicBool::new(false));
    let mut hooks = RuntimeCaptureHooks::new();
    hooks.push(SleepingCaptureHook {
        boundary: RuntimeCaptureBoundary::BeforeTerminate,
        started: Arc::clone(&started),
        sleep: Duration::from_secs(2),
    });
    let started_at = Instant::now();

    let error = harness.run(&plan, &mut hooks).unwrap_err();

    assert!(started.load(Ordering::SeqCst));
    assert!(started_at.elapsed() < Duration::from_secs(2));
    assert_eq!(error.kind, RuntimeHarnessErrorKind::Timeout);
    assert!(error.details.iter().any(
        |(key, value)| key == "beforeTerminateHookError" && value == "runtime_capture_timeout"
    ));
    let cleanup = error.cleanup.unwrap();
    assert!(cleanup.attempted);
    assert!(cleanup.completed);
    assert_eq!(cleanup.scope, RuntimeProcessCleanupScope::ProcessTree);
}

#[cfg(unix)]
pub(super) fn timeout_cleanup_terminates_runtime_process_tree() {
    let temp = temp_root("process-tree");
    let heartbeat_path = temp.join("grandchild-heartbeat");
    let pid_path = temp.join("grandchild.pid");
    let plan = RuntimeLaunchCapturePlan::new(
        HARNESS_RUN_ID,
        RuntimeOperation::Capture,
        harness_child_command_with_env(
            "tests::harness_child_spawns_grandchild",
            &[
                ("UTSUSHI_TEST_GRANDCHILD_HEARTBEAT", &heartbeat_path),
                ("UTSUSHI_TEST_GRANDCHILD_PID", &pid_path),
            ],
        ),
    )
    .with_timeout(Duration::from_millis(250))
    .with_shutdown_grace(Duration::from_secs(1))
    .with_poll_interval(Duration::from_millis(5));
    let harness = RuntimeLaunchCaptureHarness::new();
    let mut hooks = RuntimeCaptureHooks::new();

    let error = harness.run(&plan, &mut hooks).unwrap_err();

    assert_eq!(error.kind, RuntimeHarnessErrorKind::Timeout);
    let cleanup = error.cleanup.unwrap();
    assert!(cleanup.attempted);
    assert!(cleanup.completed);
    assert_eq!(cleanup.scope, RuntimeProcessCleanupScope::ProcessTree);
    assert!(pid_path.is_file(), "grandchild should have started");
    assert!(
        heartbeat_path.is_file(),
        "grandchild should have written at least one heartbeat"
    );
    let heartbeat_after_cleanup = fs::read_to_string(&heartbeat_path).unwrap();
    std::thread::sleep(Duration::from_millis(150));
    assert_eq!(
        fs::read_to_string(&heartbeat_path).unwrap(),
        heartbeat_after_cleanup,
        "grandchild heartbeat changed after process-tree cleanup"
    );
    let _ = fs::remove_dir_all(temp);
}

#[cfg(unix)]
pub(super) fn nonzero_exit_cleanup_terminates_runtime_process_tree() {
    let temp = temp_root("nonzero-process-tree");
    let heartbeat_path = temp.join("grandchild-heartbeat");
    let pid_path = temp.join("grandchild.pid");
    let plan = RuntimeLaunchCapturePlan::new(
        HARNESS_RUN_ID,
        RuntimeOperation::Capture,
        harness_child_command_with_env(
            "tests::harness_child_spawns_grandchild_then_fails",
            &[
                ("UTSUSHI_TEST_GRANDCHILD_HEARTBEAT", &heartbeat_path),
                ("UTSUSHI_TEST_GRANDCHILD_PID", &pid_path),
            ],
        ),
    )
    .with_timeout(Duration::from_secs(5))
    .with_shutdown_grace(Duration::from_secs(1))
    .with_poll_interval(Duration::from_millis(5));
    let harness = RuntimeLaunchCaptureHarness::new();
    let mut hooks = RuntimeCaptureHooks::new();

    let error = harness.run(&plan, &mut hooks).unwrap_err();

    assert_eq!(error.kind, RuntimeHarnessErrorKind::ProcessFailed);
    assert_eq!(error.code(), "runtime_process_failed");
    assert!(
        error
            .details
            .iter()
            .any(|(key, value)| { key == "exitCode" && value == "42" })
    );
    let cleanup = error.cleanup.unwrap();
    assert!(cleanup.attempted);
    assert!(cleanup.completed);
    assert_eq!(cleanup.scope, RuntimeProcessCleanupScope::ProcessTree);
    assert!(pid_path.is_file(), "grandchild should have started");
    assert!(
        heartbeat_path.is_file(),
        "grandchild should have written at least one heartbeat"
    );
    let heartbeat_after_cleanup = fs::read_to_string(&heartbeat_path).unwrap();
    std::thread::sleep(Duration::from_millis(150));
    assert_eq!(
        fs::read_to_string(&heartbeat_path).unwrap(),
        heartbeat_after_cleanup,
        "grandchild heartbeat changed after non-zero process cleanup"
    );
    let _ = fs::remove_dir_all(temp);
}

#[cfg(unix)]
pub(super) fn nonzero_exit_after_exit_hook_failure_cleans_process_tree_before_returning() {
    let temp = temp_root("nonzero-after-exit-hook-process-tree");
    let heartbeat_path = temp.join("grandchild-heartbeat");
    let pid_path = temp.join("grandchild.pid");
    let plan = RuntimeLaunchCapturePlan::new(
        HARNESS_RUN_ID,
        RuntimeOperation::Capture,
        harness_child_command_with_env(
            "tests::harness_child_spawns_grandchild_then_fails",
            &[
                ("UTSUSHI_TEST_GRANDCHILD_HEARTBEAT", &heartbeat_path),
                ("UTSUSHI_TEST_GRANDCHILD_PID", &pid_path),
            ],
        ),
    )
    .with_timeout(Duration::from_secs(5))
    .with_shutdown_grace(Duration::from_secs(1))
    .with_poll_interval(Duration::from_millis(5));
    let harness = RuntimeLaunchCaptureHarness::new();
    let mut hooks = RuntimeCaptureHooks::new();
    hooks.push(FailingCaptureHook {
        boundary: RuntimeCaptureBoundary::AfterExit,
    });

    let error = harness.run(&plan, &mut hooks).unwrap_err();

    assert_eq!(error.kind, RuntimeHarnessErrorKind::CaptureFailed);
    assert_eq!(error.code(), "runtime_capture_failed");
    assert_eq!(error.boundary, Some(RuntimeCaptureBoundary::AfterExit));
    assert!(
        error
            .message
            .contains("intentional after-exit hook failure")
    );
    assert!(
        error
            .details
            .iter()
            .any(|(key, value)| key == "processFailure" && value == "runtime_process_failed")
    );
    assert!(
        error
            .details
            .iter()
            .any(|(key, value)| key == "exitCode" && value == "42")
    );
    let cleanup = error.cleanup.unwrap();
    assert!(cleanup.attempted);
    assert!(cleanup.completed);
    assert_eq!(cleanup.scope, RuntimeProcessCleanupScope::ProcessTree);
    assert!(pid_path.is_file(), "grandchild should have started");
    assert!(
        heartbeat_path.is_file(),
        "grandchild should have written at least one heartbeat"
    );
    let heartbeat_after_cleanup = fs::read_to_string(&heartbeat_path).unwrap();
    std::thread::sleep(Duration::from_millis(150));
    assert_eq!(
        fs::read_to_string(&heartbeat_path).unwrap(),
        heartbeat_after_cleanup,
        "grandchild heartbeat changed after after-exit hook/process cleanup"
    );
    let _ = fs::remove_dir_all(temp);
}

pub(super) fn successful_exit_after_exit_hook_failure_reports_process_exit_diagnostics() {
    let plan = RuntimeLaunchCapturePlan::new(
        HARNESS_RUN_ID,
        RuntimeOperation::Capture,
        harness_child_command("tests::harness_child_exits"),
    )
    .with_timeout(Duration::from_secs(5))
    .with_hook_timeout(Duration::from_secs(1));
    let harness = RuntimeLaunchCaptureHarness::new();
    let mut hooks = RuntimeCaptureHooks::new();
    hooks.push(FailingCaptureHook {
        boundary: RuntimeCaptureBoundary::AfterExit,
    });

    let error = harness.run(&plan, &mut hooks).unwrap_err();

    assert_eq!(error.kind, RuntimeHarnessErrorKind::CaptureFailed);
    assert_eq!(error.boundary, Some(RuntimeCaptureBoundary::AfterExit));
    assert!(
        error
            .details
            .iter()
            .any(|(key, value)| key == "processExit" && value == "success")
    );
    assert!(
        error
            .details
            .iter()
            .any(|(key, value)| key == "processExitSuccess" && value == "true")
    );
    let diagnostic = error.to_json();
    assert_eq!(diagnostic["boundary"], "after_exit");
    assert_eq!(diagnostic["details"]["processExit"], "success");
    assert_eq!(diagnostic["details"]["processExitSuccess"], "true");
}

#[cfg(not(unix))]
pub(super) fn launch_capture_harness_fails_closed_without_process_tree_cleanup_support() {
    let plan = RuntimeLaunchCapturePlan::new(
        HARNESS_RUN_ID,
        RuntimeOperation::Capture,
        harness_child_command("tests::harness_child_exits"),
    );
    let harness = RuntimeLaunchCaptureHarness::new();
    let mut hooks = RuntimeCaptureHooks::new();

    let error = harness.run(&plan, &mut hooks).unwrap_err();

    assert_eq!(error.kind, RuntimeHarnessErrorKind::InvalidPlan);
    assert!(
        error
            .message
            .contains("process-tree cleanup is unsupported")
    );
    assert!(
        error
            .details
            .iter()
            .any(|(key, value)| key == "cleanupScope" && value == "process_tree")
    );
}
