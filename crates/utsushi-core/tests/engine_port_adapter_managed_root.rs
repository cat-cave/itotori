//! Integration coverage for managed-root propagation through the legacy
//! `RuntimeAdapter` bridge.

use std::fs;
use std::path::Path;

use tempfile::TempDir;

use utsushi_core::{
    CaptureOutcome, EnginePort, EnginePortAdapter, EnginePortError, EvidenceTier, FidelityTier,
    LifecycleStage, PortCapability, PortManifest, PortRequest, PortShutdownOutcome,
    REQUIRED_LIFECYCLE_STAGES, RuntimeAdapter, RuntimeArtifactKind, RuntimeArtifactRoot,
    RuntimeRequest, SinkSet, runtime_artifact_uri,
};

#[test]
fn adapter_capture_uses_runtime_request_managed_root() {
    let input_dir = TempDir::new().expect("input tempdir");
    let artifact_dir = TempDir::new().expect("artifact tempdir");
    let managed_root = RuntimeArtifactRoot::new(artifact_dir.path());
    managed_root.prepare().expect("prepare managed root");
    let adapter = EnginePortAdapter::new(CapturePort::inside_root()).expect("adapter builds");
    let request = RuntimeRequest::new(input_dir.path()).with_managed_artifact_root(&managed_root);

    let value = adapter
        .capture(&request)
        .expect("capture through managed root succeeds");
    let artifact_uri = value["captures"][0]["artifactUri"]
        .as_str()
        .expect("capture uri");
    let artifact_path = managed_root
        .artifact_path(artifact_uri)
        .expect("capture uri resolves within supplied root");

    assert!(
        artifact_path.is_file(),
        "capture is written under managed root"
    );
}

#[test]
fn adapter_capture_keeps_legacy_optional_path_root_callers() {
    let input_dir = TempDir::new().expect("input tempdir");
    let artifact_dir = TempDir::new().expect("artifact tempdir");
    let legacy_root: Option<&Path> = Some(artifact_dir.path());
    let mut request = RuntimeRequest::new(input_dir.path());
    if let Some(root) = legacy_root {
        request = request.with_artifact_root(root);
    }
    let adapter = EnginePortAdapter::new(CapturePort::inside_root()).expect("adapter builds");

    let value = adapter
        .capture(&request)
        .expect("legacy optional path capture succeeds");
    let artifact_uri = value["captures"][0]["artifactUri"]
        .as_str()
        .expect("capture uri");
    let artifact_path = RuntimeArtifactRoot::new(artifact_dir.path())
        .artifact_path(artifact_uri)
        .expect("capture uri resolves under legacy root");

    assert!(artifact_path.is_file(), "legacy caller receives a capture");
}

#[test]
fn adapter_rejects_capture_artifact_outside_runtime_request_managed_root() {
    let input_dir = TempDir::new().expect("input tempdir");
    let artifact_dir = TempDir::new().expect("artifact tempdir");
    let managed_root = RuntimeArtifactRoot::new(artifact_dir.path());
    managed_root.prepare().expect("prepare managed root");
    let adapter = EnginePortAdapter::new(CapturePort::outside_root()).expect("adapter builds");
    let request = RuntimeRequest::new(input_dir.path()).with_managed_artifact_root(&managed_root);

    let error = adapter
        .capture(&request)
        .expect_err("outside capture must be rejected");

    assert!(matches!(
        error.downcast_ref::<EnginePortError>(),
        Some(EnginePortError::ArtifactRootViolation { .. })
    ));
}

/// Minimal capture port that can either materialize its artifact through the
/// request root or deliberately report a real path outside that root.
struct CapturePort {
    destination: CaptureDestination,
    sinks: SinkSet,
}

enum CaptureDestination {
    Managed,
    Outside(TempDir),
}

impl CapturePort {
    const MANIFEST: PortManifest = PortManifest {
        id: "synthetic-capture-port",
        name: "Synthetic Capture Port",
        version: "0.0.0",
        abi_version: 1,
        capabilities: &[
            PortCapability::Launch,
            PortCapability::Observe,
            PortCapability::Capture,
            PortCapability::Shutdown,
        ],
        required_methods: REQUIRED_LIFECYCLE_STAGES,
        optional_methods: &[],
        env_schema: &[],
        fidelity_tier_max: FidelityTier::LayoutProbe,
        evidence_tier_max: EvidenceTier::E2,
        limitations: &[],
    };

    fn inside_root() -> Self {
        Self {
            destination: CaptureDestination::Managed,
            sinks: SinkSet::new(),
        }
    }

    fn outside_root() -> Self {
        Self {
            destination: CaptureDestination::Outside(TempDir::new().expect("outside tempdir")),
            sinks: SinkSet::new(),
        }
    }
}

impl EnginePort for CapturePort {
    const MANIFEST: PortManifest = Self::MANIFEST;

    fn launch(&mut self, _request: &PortRequest<'_>) -> Result<(), EnginePortError> {
        Ok(())
    }

    fn observe(&mut self, _request: &PortRequest<'_>) -> Result<(), EnginePortError> {
        Ok(())
    }

    fn sink_set(&self) -> &SinkSet {
        &self.sinks
    }

    fn capture(&mut self, request: &PortRequest<'_>) -> Result<CaptureOutcome, EnginePortError> {
        let root = request
            .artifact_root
            .ok_or(EnginePortError::ArtifactRootMissing {
                stage: LifecycleStage::Capture,
            })?;
        let artifact_uri = runtime_artifact_uri(
            request.run_id,
            RuntimeArtifactKind::Screenshot,
            "0190a000-0000-7000-8000-000000000202",
        )
        .map_err(|error| EnginePortError::Lifecycle {
            stage: LifecycleStage::Capture,
            message: format!("artifact uri build failed: {error}"),
            source: None,
        })?;
        let artifact_path = match &self.destination {
            CaptureDestination::Managed => root.write_bytes(&artifact_uri, b"synthetic capture"),
            CaptureDestination::Outside(directory) => {
                let path = directory.path().join("escaped.png");
                fs::write(&path, b"synthetic escape")
                    .map(|()| path)
                    .map_err(Into::into)
            }
        }
        .map_err(|error| EnginePortError::Lifecycle {
            stage: LifecycleStage::Capture,
            message: format!("capture artifact write failed: {error}"),
            source: None,
        })?;

        Ok(CaptureOutcome::new(artifact_uri).with_path(artifact_path))
    }

    fn shutdown(&mut self) -> Result<PortShutdownOutcome, EnginePortError> {
        Ok(PortShutdownOutcome::clean())
    }
}
