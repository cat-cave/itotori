//! Integration tests for the engine-port runner template and
//! the sinks-bridge migration.
//!
//! Every behavior test exercises a synthetic port defined inside this
//! file; the test crate has no dependency on `utsushi-fixture`. The
//! synthetic ports exercise positive (`ReferencePort`), drift
//! (`MissingObservePort`, `JumpUndeclaredPort`), ABI mismatch
//! (`UnsupportedAbi`), env-leak (`UnredactedEnvRuntimePort`) and
//! tick-ordering (`OrderingProbePort`) paths.

#[path = "engine_port/test_support.rs"]
mod test_support;

use std::path::Path;

use serde_json::Value;
use tempfile::TempDir;

use test_support::*;

use utsushi_core::{
    CapabilityReason, DriftKind, EnginePort, EnginePortAdapter, EnginePortError, EnvFieldShape,
    EvidenceTier, FidelityTier, LifecycleStage, MomentId, PortCapability, PortEnv, PortRequest,
    PortShutdownStatus, Runner, RunnerCancellation, RuntimeAdapter, RuntimeAdapterDescriptor,
    RuntimeArtifactRoot, RuntimeOperation, RuntimeRequest, port::conformance,
    validate_runtime_evidence_report_value,
};

// Positive port behaviors

#[test]
fn synthetic_port_passes_required_abi_conformance() {
    let (_input_dir, input_root) = build_input_root();
    let (_root_dir, artifact_root) = build_artifact_root();
    let fixture = build_fixture(artifact_root, input_root);

    let report = conformance::run_required_abi(ReferencePort::new, &fixture)
        .expect("reference port passes conformance");

    assert!(report.launched);
    assert_eq!(report.observation_count, 1);
    assert!(report.captured);
    assert!(report.first_shutdown_clean);
    assert!(report.second_shutdown_idempotent);
    assert_eq!(report.jump_outcome, conformance::JumpOutcome::NotDeclared);
    assert!(report.cancellation_observed);
    assert_eq!(report.manifest_id, "utsushi-synthetic-ref");
}

#[test]
fn synthetic_port_launch_observes_cancellation_token() {
    let (_input_dir, input_root) = build_input_root();
    let runner = Runner::new();
    let cancel = RunnerCancellation::new();
    cancel.cancel();

    let mut port = ReferencePort::new();
    let request = PortRequest::new(&input_root, "cancel-run", RuntimeOperation::Trace)
        .with_cancellation(cancel);

    let error = runner
        .run_trace(&mut port, &request)
        .expect_err("cancelled launch must fail");
    match error {
        EnginePortError::Cancelled { stage } => assert_eq!(stage, LifecycleStage::Launch),
        other => panic!("expected Cancelled(Launch), got {other:?}"),
    }
}

#[test]
fn synthetic_port_capture_writes_into_managed_artifact_root() {
    let (_input_dir, input_root) = build_input_root();
    let (_root_dir, artifact_root) = build_artifact_root();
    let runner = Runner::new();
    let mut port = ReferencePort::new();
    let request = PortRequest::new(&input_root, "capture-run", RuntimeOperation::Capture)
        .with_artifact_root(&artifact_root);

    let outcome = runner
        .run_capture(&mut port, &request)
        .expect("capture run succeeds");

    let capture = outcome.capture.expect("capture outcome present");
    let resolved = artifact_root
        .artifact_path(&capture.artifact_uri)
        .expect("artifact uri resolves under managed root");
    assert!(resolved.starts_with(artifact_root.path()));
    assert!(resolved.exists(), "artifact path must exist: {resolved:?}");
}

#[test]
fn synthetic_port_capture_without_artifact_root_is_rejected() {
    let (_input_dir, input_root) = build_input_root();
    let runner = Runner::new();
    let mut port = ReferencePort::new();
    // No `.with_artifact_root(...)`: capture containment cannot be enforced
    // so the runner must reject the request up front rather than silently
    // skipping the containment guard.
    let request = PortRequest::new(&input_root, "capture-run", RuntimeOperation::Capture);

    let error = runner
        .run_capture(&mut port, &request)
        .expect_err("capture without a managed artifact root must be rejected");
    match error {
        EnginePortError::ArtifactRootMissing { stage } => {
            assert_eq!(stage, LifecycleStage::Capture);
        }
        other => panic!("expected ArtifactRootMissing(Capture), got {other:?}"),
    }
}

#[test]
fn synthetic_port_shutdown_is_idempotent() {
    let mut port = ReferencePort::new();
    let first = port.shutdown().expect("first shutdown ok");
    let second = port.shutdown().expect("second shutdown ok");
    assert_eq!(first.status, PortShutdownStatus::Clean);
    assert_eq!(second.status, PortShutdownStatus::AlreadyShutDown);
}

#[test]
fn synthetic_port_jump_returns_capability_unsupported_when_not_declared() {
    let (_input_dir, input_root) = build_input_root();
    let runner = Runner::new();
    let mut port = ReferencePort::new();
    let request = PortRequest::new(&input_root, "jump-run", RuntimeOperation::Trace);

    let error = runner
        .run_jump(&mut port, &request, &MomentId::synthetic())
        .expect_err("undeclared jump must fail");
    match error {
        EnginePortError::CapabilityUnsupported { capability, reason } => {
            assert_eq!(capability, PortCapability::Jump);
            // The runner-level rejection uses NotYetSupported because
            // the capability is missing from the manifest entirely.
            assert!(matches!(
                reason,
                CapabilityReason::NotYetSupported | CapabilityReason::DefaultUnimplemented,
            ));
        }
        other => panic!("expected CapabilityUnsupported, got {other:?}"),
    }
}

// Tick ordering invariant ()

#[test]
fn runner_tick_drains_sinks_in_text_then_frame_then_audio_order() {
    let (_input_dir, input_root) = build_input_root();
    let runner = Runner::new();
    let mut port = OrderingProbePort::new();
    let recorder = port.recorder();
    let request = PortRequest::new(&input_root, "order-run", RuntimeOperation::Trace);

    let observation = runner.tick(&mut port, &request).expect("tick succeeds");
    assert_eq!(observation.text.len(), 1);
    assert_eq!(observation.frames.len(), 1);
    assert_eq!(observation.audio.len(), 1);

    let samples = recorder.snapshot();
    assert_eq!(
        samples,
        vec![
            DrainSample::Text("text-1".to_string()),
            DrainSample::Frame("frame-1".to_string()),
            DrainSample::Audio("audio-1".to_string()),
        ],
        "Runner::tick must drain in text -> frame -> audio order; got: {samples:?}"
    );
}

// Missing-method / drift

#[test]
fn port_with_unimplemented_observe_fails_conformance_with_drift_diagnostic() {
    let (_input_dir, input_root) = build_input_root();
    let (_root_dir, artifact_root) = build_artifact_root();
    let fixture = build_fixture(artifact_root, input_root);

    let outcome = conformance::run_required_abi(MissingObservePort::new, &fixture);
    let error = outcome.expect_err("missing-observe port must fail conformance");
    match error {
        EnginePortError::CapabilityUnsupported { capability, .. } => {
            assert_eq!(capability, PortCapability::Observe);
        }
        other => panic!("expected CapabilityUnsupported(Observe), got {other:?}"),
    }
}

#[test]
fn port_with_non_idempotent_shutdown_fails_conformance_with_typed_error() {
    let (_input_dir, input_root) = build_input_root();
    let (_root_dir, artifact_root) = build_artifact_root();
    let fixture = build_fixture(artifact_root, input_root);

    let outcome = conformance::run_required_abi(NonIdempotentShutdownPort::new, &fixture);
    let error = outcome.expect_err("non-idempotent shutdown must fail conformance");
    match error {
        EnginePortError::ShutdownNotIdempotent { first, second } => {
            assert_eq!(first, PortShutdownStatus::Clean);
            // The port reported Clean on the second call instead of the
            // required AlreadyShutDown.
            assert_eq!(second, PortShutdownStatus::Clean);
        }
        other => panic!("expected ShutdownNotIdempotent, got {other:?}"),
    }
}

#[test]
fn port_overriding_jump_without_declaring_capability_fails_drift_check() {
    let (_input_dir, input_root) = build_input_root();
    let (_root_dir, artifact_root) = build_artifact_root();
    let fixture = build_fixture(artifact_root, input_root);

    let outcome = conformance::run_required_abi(JumpUndeclaredPort::new, &fixture);
    let error = outcome.expect_err("undeclared jump impl must trip drift check");
    match error {
        EnginePortError::ManifestCapabilityDrift { capability, kind } => {
            assert_eq!(capability, PortCapability::Jump);
            assert_eq!(kind, DriftKind::UnclaimedImplementation);
        }
        other => panic!("expected ManifestCapabilityDrift, got {other:?}"),
    }
}

#[test]
fn port_declaring_jump_capability_runs_jump_against_synthetic_moment() {
    let (_input_dir, input_root) = build_input_root();
    let (_root_dir, artifact_root) = build_artifact_root();
    let fixture = build_fixture(artifact_root, input_root);

    let report = conformance::run_required_abi(JumpCapablePort::new, &fixture)
        .expect("jump-capable port passes conformance");
    assert_eq!(report.jump_outcome, conformance::JumpOutcome::Honoured);
}

// Version mismatch

#[test]
fn port_with_unsupported_abi_version_fails_runner_validate_manifest() {
    let runner = Runner::new();
    let error = runner
        .validate_manifest(&UNSUPPORTED_ABI_MANIFEST)
        .expect_err("abi 99 must be rejected");
    match error {
        EnginePortError::AbiVersionUnsupported {
            declared,
            supported,
        } => {
            assert_eq!(declared, 99);
            assert_eq!(supported, Runner::SUPPORTED_ABI_VERSIONS);
        }
        other => panic!("expected AbiVersionUnsupported, got {other:?}"),
    }
}

// Env-leak rejection

#[test]
fn port_with_path_shape_env_schema_fails_manifest_validate() {
    let error = ENV_PATH_FORBIDDEN_MANIFEST
        .validate()
        .expect_err("forbidden env shape must reject");
    match error {
        EnginePortError::EnvSchemaForbidsPath { key, shape } => {
            assert_eq!(key, "UTSUSHI_PORT_DIR");
            assert_eq!(shape, EnvFieldShape::Path);
        }
        other => panic!("expected EnvSchemaForbidsPath, got {other:?}"),
    }
}

#[test]
fn port_with_runtime_env_value_matching_local_path_filter_fails_launch() {
    let (_input_dir, input_root) = build_input_root();
    let (_root_dir, artifact_root) = build_artifact_root();
    let runner = Runner::new();
    let mut env = PortEnv::new();
    env.insert("UTSUSHI_RUN_TOKEN", "/home/operator/private/leak");

    let mut port = UnredactedEnvRuntimePort::new();
    let request = PortRequest::new(&input_root, "env-leak", RuntimeOperation::Trace)
        .with_artifact_root(&artifact_root)
        .with_env(env);

    let error = runner
        .run_trace(&mut port, &request)
        .expect_err("leaky env value must reject");
    match error {
        EnginePortError::EnvUnredacted { key, rule } => {
            assert_eq!(key, "UTSUSHI_RUN_TOKEN");
            assert_eq!(rule, "looks_like_local_path");
        }
        other => panic!("expected EnvUnredacted, got {other:?}"),
    }
}

#[test]
fn engine_port_error_for_unredacted_env_path_does_not_include_path_in_display() {
    let leak_path = "/home/operator/private/leak";
    let error = EnginePortError::EnvUnredacted {
        key: "UTSUSHI_RUN_TOKEN",
        rule: "looks_like_local_path",
    };
    let rendered = format!("{error}");
    assert!(
        !rendered.contains(leak_path),
        "rendered error must not include the leaked path: {rendered}"
    );
    assert!(
        !utsushi_core::looks_like_local_path(&rendered),
        "rendered diagnostic must not look like a local path: {rendered}"
    );
}

#[test]
fn runtime_request_debug_does_not_leak_cancellation_or_replay_log() {
    let input_root = Path::new("/tmp-source-only-name-no-real-traversal");
    let cancellation = RunnerCancellation::new();
    let request = RuntimeRequest::new(input_root).with_cancellation(cancellation);
    let rendered = format!("{request:?}");
    assert!(rendered.contains("RuntimeRequest"));
    assert!(rendered.contains("cancellation"));
    // Debug must NOT print the inner Arc pointer or any state derived
    // from it; it must show the static label only.
    assert!(rendered.contains("RunnerCancellation"));
    assert!(!rendered.contains("Arc { strong:"));
}

// EnginePortAdapter bridge onto the RuntimeAdapter surface

#[test]
fn engine_port_adapter_descriptor_reflects_manifest_id_and_version() {
    let adapter = EnginePortAdapter::new(ReferencePort::new()).expect("adapter builds");
    let descriptor: RuntimeAdapterDescriptor = adapter.descriptor();
    assert_eq!(descriptor.name, "utsushi-synthetic-ref");
    assert_eq!(descriptor.version, "0.0.0");
    assert_eq!(descriptor.fidelity_tier, FidelityTier::LayoutProbe);
    assert_eq!(descriptor.evidence_tier_ceiling, EvidenceTier::E2);
    assert!(
        descriptor
            .limitations
            .iter()
            .any(|line| line.contains("Synthetic test-only port"))
    );
}

#[test]
fn engine_port_adapter_trace_runs_lifecycle_and_returns_sink_shaped_observations() {
    let (_input_dir, input_root) = build_input_root();
    let adapter = EnginePortAdapter::new(ReferencePort::new()).expect("adapter builds");
    let request = RuntimeRequest::new(&input_root);
    let value: Value = adapter.trace(&request).expect("trace via adapter");
    assert_eq!(value["adapterName"], "utsushi-synthetic-ref");
    assert_eq!(value["adapterVersion"], "0.0.0");
    assert_eq!(value["schemaVersion"], "0.2.0");
    assert_eq!(value["operation"], "trace");
    validate_runtime_evidence_report_value(&value)
        .expect("adapter trace report must satisfy RuntimeEvidenceReportV02");
    assert_eq!(
        value["runtimeReportId"],
        "0190a000-0000-7000-8000-000000000001"
    );
    assert_eq!(value["fidelityTier"], "layout_probe");
    assert_eq!(value["evidenceTier"], "E1");
    assert_eq!(
        value["traceEvents"].as_array().expect("trace events").len(),
        0
    );
    assert_eq!(
        value["branchEvents"]
            .as_array()
            .expect("branch events")
            .len(),
        0
    );
    assert_eq!(value["captures"].as_array().expect("captures").len(), 0);
    assert_eq!(
        value["observationHookEvents"]
            .as_array()
            .expect("observationHookEvents")
            .len(),
        1
    );
    // the adapter's wire shape is now `sinkObservations` —
    // a sink-shaped array — rather than the deleted hook envelope. At
    // least the text emission the reference port pushes during observe
    // must surface here.
    let observations = value["sinkObservations"]
        .as_array()
        .expect("sinkObservations array");
    assert!(
        observations
            .iter()
            .any(|entry| entry["sink"] == "text_surface")
    );
    assert_eq!(value["shutdownStatus"], "clean");
}

#[test]
fn engine_port_adapter_branch_discovery_rejects_with_typed_redacted_diagnostic() {
    let (_input_dir, input_root) = build_input_root();
    let adapter = EnginePortAdapter::new(ReferencePort::new()).expect("adapter builds");
    let request = RuntimeRequest::new(&input_root);

    let error = adapter
        .discover_branches(&request)
        .expect_err("engine-port adapters do not implement branch discovery");
    match error.downcast_ref::<EnginePortError>() {
        Some(EnginePortError::AdapterOperationUnsupported {
            operation: RuntimeOperation::BranchDiscovery,
        }) => {}
        Some(other) => panic!("expected branch-discovery adapter diagnostic, got {other:?}"),
        None => panic!("expected EnginePortError, got {error}"),
    }

    let rendered = format!("{error}");
    assert!(rendered.contains("branch_discovery"));
    assert!(
        !utsushi_core::looks_like_local_path(&rendered),
        "rendered diagnostic must not look like a local path: {rendered}"
    );
}

#[test]
fn engine_port_adapter_capture_hydrates_managed_artifact_root_from_raw_path() {
    // Regression guard for genaudit1-03: the bridge must hydrate the
    // managed artifact root from the `RuntimeRequest`'s raw `&Path` so a
    // capture through the `RuntimeAdapter` surface actually contains and
    // writes its artifact — not fail closed with `ArtifactRootMissing`.
    let (_input_dir, input_root) = build_input_root();
    let artifact_dir = TempDir::new().expect("artifact tempdir");
    let adapter = EnginePortAdapter::new(ReferencePort::new()).expect("adapter builds");
    // The caller hands the adapter only a raw, unprepared `&Path`; the
    // bridge is responsible for wrapping it into a managed root and
    // preparing it, exactly like every other RuntimeAdapter implementation.
    let request = RuntimeRequest::new(&input_root).with_artifact_root(artifact_dir.path());

    let value: Value = adapter
        .capture(&request)
        .expect("capture via adapter succeeds");
    assert_eq!(value["operation"], "capture");
    validate_runtime_evidence_report_value(&value)
        .expect("adapter capture report must satisfy RuntimeEvidenceReportV02");
    assert_eq!(value["evidenceTier"], "E2");
    let captures = value["captures"].as_array().expect("captures array");
    let artifact_uri = captures
        .first()
        .and_then(|capture| capture["artifactUri"].as_str())
        .expect("capture artifact uri present");
    let artifact_ref = &captures[0]["artifactRef"];
    assert_eq!(artifact_ref["uri"].as_str().unwrap(), artifact_uri);
    assert_eq!(
        artifact_ref["artifactId"].as_str().unwrap(),
        "0190a000-0000-7000-8000-000000000201"
    );

    let resolved = RuntimeArtifactRoot::new(artifact_dir.path())
        .artifact_path(artifact_uri)
        .expect("artifact uri resolves under managed root");
    assert!(resolved.starts_with(artifact_dir.path()));
    assert!(
        resolved.exists(),
        "bridge must have written the capture artifact: {resolved:?}"
    );
}

#[test]
fn engine_port_adapter_capture_without_artifact_root_fails_closed() {
    // The bridge keeps the fail-closed guarantee: a capture with no
    // artifact root cannot enforce containment, so the runner rejects it
    // with `ArtifactRootMissing` rather than writing unmanaged output.
    let (_input_dir, input_root) = build_input_root();
    let adapter = EnginePortAdapter::new(ReferencePort::new()).expect("adapter builds");
    let request = RuntimeRequest::new(&input_root);

    let error = adapter
        .capture(&request)
        .expect_err("capture without a managed artifact root must fail closed");
    let rendered = format!("{error}");
    assert!(
        rendered.contains("artifact root"),
        "expected an artifact-root-missing failure, got: {rendered}"
    );
}
