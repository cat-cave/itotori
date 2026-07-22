use super::*;
use serde_json::json;
use std::process::Command as StdCommand;
use std::sync::{
    Arc, Mutex,
    atomic::{AtomicBool, AtomicUsize, Ordering},
    mpsc,
};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

struct FakeTraceAdapter;

const HARNESS_RUN_ID: &str = "019ed003-0000-7000-8000-000000001014";
const HARNESS_SCREENSHOT_ID: &str = "019ed003-0000-7000-8000-000000004014";
const HARNESS_FRAME_ID: &str = "019ed003-0000-7000-8000-000000004015";

fn trace_contract() -> RuntimeCapabilityContract {
    RuntimeCapabilityContract::new(
        RuntimeCapabilityClass::StaticTrace,
        FidelityTier::TraceOnly,
        EvidenceTier::E1,
        vec![
            RuntimeFeatureSupport::supported(
                RuntimePlaybackFeature::StaticTrace,
                EvidenceTier::E1,
                "static trace fixture",
            ),
            RuntimeFeatureSupport::supported(
                RuntimePlaybackFeature::TextTrace,
                EvidenceTier::E1,
                "text trace fixture",
            ),
            RuntimeFeatureSupport::unsupported(
                RuntimePlaybackFeature::Jump,
                "jump is not part of the base trace contract",
            ),
            RuntimeFeatureSupport::unsupported(
                RuntimePlaybackFeature::Snapshot,
                "snapshot is not part of the base trace contract",
            ),
            RuntimeFeatureSupport::unsupported(
                RuntimePlaybackFeature::Screenshot,
                "screenshots are not part of the base trace contract",
            ),
            RuntimeFeatureSupport::unsupported(
                RuntimePlaybackFeature::Recording,
                "recording is not part of the base trace contract",
            ),
        ],
        vec!["unit test adapter".to_string()],
    )
}

fn temp_root(name: &str) -> PathBuf {
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let root = std::env::temp_dir().join(format!(
        "utsushi-core-{name}-{}-{nonce}",
        std::process::id()
    ));
    let _ = fs::remove_dir_all(&root);
    fs::create_dir_all(&root).unwrap();
    root
}

fn harness_child_command(test_name: &str) -> RuntimeLaunchCommand {
    RuntimeLaunchCommand::new(std::env::current_exe().unwrap()).args([
        "--exact",
        test_name,
        "--ignored",
        "--nocapture",
    ])
}

fn harness_child_command_with_env(test_name: &str, env: &[(&str, &Path)]) -> RuntimeLaunchCommand {
    let mut command = harness_child_command(test_name);
    for (key, value) in env {
        command = command.env(*key, value.display().to_string());
    }
    command
}

fn wait_for_path(path: &Path, timeout: Duration) -> bool {
    let started_at = Instant::now();
    while started_at.elapsed() < timeout {
        if path.exists() {
            return true;
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    path.exists()
}

// poll the out-of-band slot the detached hook worker records
// its (fenced) write outcome into.
fn wait_for_late_write(
    slot: &Arc<Mutex<Option<Result<PathBuf, String>>>>,
    timeout: Duration,
) -> Option<Result<PathBuf, String>> {
    let started_at = Instant::now();
    loop {
        if let Some(value) = slot.lock().unwrap().clone() {
            return Some(value);
        }
        if started_at.elapsed() > timeout {
            return None;
        }
        std::thread::sleep(Duration::from_millis(10));
    }
}

// tests that exercised the deleted typed
// `deleted-hook-envelope` envelope (round-trip, schema-version
// redaction rejection on the typed shape) have been removed. The
// wire-shape envelope's per-field validation is now tested only by
// the independent `kaifuu-core::contracts::validate_runtime_evidence_report_v02`
// suite, and the `RuntimeEvidenceReportV02` integration validator
// (`validate_runtime_evidence_report_value`) is exercised in the
// `utsushi-fixture` reference-corpus path. The substrate-side sink
// contracts (text / frame / audio) carry their own per-payload
// validators with dedicated tests in `crates/utsushi-core/src/sink/*`.

#[path = "tests/artifact_store.rs"]
mod artifact_store;
#[path = "tests/harness_cleanup.rs"]
mod harness_cleanup;
#[path = "tests/harness_execution.rs"]
mod harness_execution;
#[path = "tests/validation_and_support.rs"]
mod validation_and_support;

use validation_and_support::{
    ArtifactRequiredHook, FailingCaptureHook, HARNESS_STDOUT_SENTINEL, LateWritingCaptureHook,
    OverclaimingAdapter, PanickingCaptureHook, SleepingCaptureHook, WritingCaptureHook,
};

#[test]
fn evidence_report_observation_event_rejects_tier_above_report_ceiling() {
    validation_and_support::evidence_report_observation_event_rejects_tier_above_report_ceiling();
}

#[test]
fn rfc3339_instant_parity_matrix_matches_observation_hook_validator() {
    validation_and_support::rfc3339_instant_parity_matrix_matches_observation_hook_validator();
}

#[test]
#[ignore = "child-process harness entry point; spawned by a parent harness test, not run standalone"]
fn harness_child_exits() {
    validation_and_support::harness_child_exits();
}

#[test]
#[ignore = "child-process harness entry point; spawned by a parent harness test, not run standalone"]
fn harness_child_prints_stdout_sentinel() {
    validation_and_support::harness_child_prints_stdout_sentinel();
}

#[test]
#[ignore = "child-process harness entry point; spawned by a parent harness test, not run standalone"]
fn harness_child_sleeps() {
    validation_and_support::harness_child_sleeps();
}

#[test]
#[ignore = "child-process harness entry point; spawned by a parent harness test, not run standalone"]
fn harness_child_spawns_grandchild() {
    validation_and_support::harness_child_spawns_grandchild();
}

#[test]
#[ignore = "child-process harness entry point; spawned by a parent harness test, not run standalone"]
fn harness_child_spawns_grandchild_then_fails() {
    validation_and_support::harness_child_spawns_grandchild_then_fails();
}

#[test]
#[ignore = "child-process harness entry point; spawned by a parent harness test, not run standalone"]
fn harness_grandchild_heartbeats() {
    validation_and_support::harness_grandchild_heartbeats();
}

#[test]
fn fidelity_tiers_match_runtime_schema_evidence_ceilings() {
    harness_execution::fidelity_tiers_match_runtime_schema_evidence_ceilings();
}

#[test]
fn registry_dispatches_by_adapter_name() {
    harness_execution::registry_dispatches_by_adapter_name();
}

#[test]
fn registry_rejects_duplicate_adapter_names() {
    harness_execution::registry_rejects_duplicate_adapter_names();
}

#[test]
fn registry_rejects_adapter_evidence_overclaims() {
    harness_execution::registry_rejects_adapter_evidence_overclaims();
}

#[test]
fn capability_contract_serializes_base_unsupported_features() {
    harness_execution::capability_contract_serializes_base_unsupported_features();
}

#[test]
fn capability_classes_map_to_expected_evidence_boundaries() {
    harness_execution::capability_classes_map_to_expected_evidence_boundaries();
}

#[test]
fn registry_fails_closed_for_unsupported_operations() {
    harness_execution::registry_fails_closed_for_unsupported_operations();
}

#[test]
fn launch_capture_harness_captures_stdout_when_requested() {
    harness_execution::launch_capture_harness_captures_stdout_when_requested();
}

#[test]
fn launch_capture_harness_discards_stdout_by_default() {
    harness_execution::launch_capture_harness_discards_stdout_by_default();
}

#[test]
fn launch_capture_harness_runs_process_and_persists_hook_artifacts() {
    harness_execution::launch_capture_harness_runs_process_and_persists_hook_artifacts();
}

#[test]
fn launch_capture_harness_times_out_and_reaps_child() {
    harness_execution::launch_capture_harness_times_out_and_reaps_child();
}

#[test]
fn launch_failures_report_semantic_errors() {
    harness_execution::launch_failures_report_semantic_errors();
}

#[test]
fn capture_hooks_require_managed_artifact_store_boundary() {
    harness_execution::capture_hooks_require_managed_artifact_store_boundary();
}

#[test]
fn after_launch_hook_timeout_cleans_up_runtime_process() {
    harness_execution::after_launch_hook_timeout_cleans_up_runtime_process();
}

#[test]
fn timed_out_hook_write_is_fenced_after_capture_boundary() {
    harness_execution::timed_out_hook_write_is_fenced_after_capture_boundary();
}

#[test]
fn in_boundary_hook_write_succeeds_within_fence() {
    harness_cleanup::in_boundary_hook_write_succeeds_within_fence();
}

#[test]
fn panicking_capture_hooks_are_contained_and_cleanup_runtime_process() {
    harness_cleanup::panicking_capture_hooks_are_contained_and_cleanup_runtime_process();
}

#[test]
fn before_terminate_hook_timeout_does_not_delay_cleanup() {
    harness_cleanup::before_terminate_hook_timeout_does_not_delay_cleanup();
}

#[cfg(unix)]
#[test]
fn timeout_cleanup_terminates_runtime_process_tree() {
    harness_cleanup::timeout_cleanup_terminates_runtime_process_tree();
}

#[cfg(unix)]
#[test]
fn nonzero_exit_cleanup_terminates_runtime_process_tree() {
    harness_cleanup::nonzero_exit_cleanup_terminates_runtime_process_tree();
}

#[cfg(unix)]
#[test]
fn nonzero_exit_after_exit_hook_failure_cleans_process_tree_before_returning() {
    harness_cleanup::nonzero_exit_after_exit_hook_failure_cleans_process_tree_before_returning();
}

#[test]
fn successful_exit_after_exit_hook_failure_reports_process_exit_diagnostics() {
    harness_cleanup::successful_exit_after_exit_hook_failure_reports_process_exit_diagnostics();
}

#[cfg(not(unix))]
#[test]
fn launch_capture_harness_fails_closed_without_process_tree_cleanup_support() {
    harness_cleanup::launch_capture_harness_fails_closed_without_process_tree_cleanup_support();
}

#[test]
fn runtime_artifact_names_are_deterministic_and_managed() {
    artifact_store::runtime_artifact_names_are_deterministic_and_managed();
}

#[test]
fn runtime_artifact_paths_reject_traversal_and_external_uris() {
    artifact_store::runtime_artifact_paths_reject_traversal_and_external_uris();
}

#[test]
fn runtime_artifact_root_maps_uris_inside_managed_root() {
    artifact_store::runtime_artifact_root_maps_uris_inside_managed_root();
}

#[test]
fn runtime_artifact_cleanup_requires_marker_and_keeps_other_roots() {
    artifact_store::runtime_artifact_cleanup_requires_marker_and_keeps_other_roots();
}

#[test]
fn runtime_artifact_prepare_refuses_non_empty_unmarked_roots() {
    artifact_store::runtime_artifact_prepare_refuses_non_empty_unmarked_roots();
}

#[test]
fn runtime_artifact_cleanup_refuses_marked_source_roots() {
    artifact_store::runtime_artifact_cleanup_refuses_marked_source_roots();
}

#[cfg(unix)]
#[test]
fn runtime_artifact_write_rejects_symlink_parent_components() {
    artifact_store::runtime_artifact_write_rejects_symlink_parent_components();
}

#[cfg(unix)]
#[test]
fn runtime_artifact_write_rejects_symlink_destinations() {
    artifact_store::runtime_artifact_write_rejects_symlink_destinations();
}

#[cfg(unix)]
#[test]
fn runtime_artifact_write_cannot_escape_via_concurrent_symlink_swap() {
    artifact_store::runtime_artifact_write_cannot_escape_via_concurrent_symlink_swap();
}

#[cfg(unix)]
#[test]
fn write_bytes_over_soft_byte_budget_surfaces_budget_exhausted_on_real_path() {
    artifact_store::write_bytes_over_soft_byte_budget_surfaces_budget_exhausted_on_real_path();
}

#[cfg(unix)]
#[test]
fn write_bytes_without_soft_byte_budget_never_rejects_for_budget() {
    artifact_store::write_bytes_without_soft_byte_budget_never_rejects_for_budget();
}

#[cfg(unix)]
#[test]
fn runtime_artifact_cleanup_does_not_follow_symlink_out_of_root() {
    artifact_store::runtime_artifact_cleanup_does_not_follow_symlink_out_of_root();
}
