use std::fs;
use std::path::PathBuf;

use utsushi_core::port::conformance::{JumpOutcome, run_required_abi};
use utsushi_core::{
    PortEnv, RuntimeAdapter, RuntimeArtifactRoot, RuntimeCapability, RuntimeFeatureStatus,
};
use utsushi_fixture::{FixtureEnginePort, FixtureRuntimeAdapter};

const FIXTURE_SOURCE: &str = r#"{
  "gameId": "fixture-abi",
  "title": "Fixture ABI",
  "sourceLocale": "ja-JP",
  "units": [
    {"sourceUnitKey": "fixture.abi.001", "sourceText": "source line one", "targetText": "First line.", "speaker": "Narrator", "textSurface": "adv"},
    {"sourceUnitKey": "fixture.abi.002", "sourceText": "source line two", "targetText": "Second line.", "speaker": "Narrator", "textSurface": "adv"}
  ]
}
"#;

fn write_fixture_source() -> (tempfile::TempDir, PathBuf) {
    let dir = tempfile::TempDir::new().expect("input tempdir");
    let path = dir.path().to_path_buf();
    fs::write(path.join("source.json"), FIXTURE_SOURCE).expect("write source.json");
    (dir, path)
}

#[test]
fn fixture_engine_port_passes_required_abi_conformance() {
    let (_input_dir, input_root) = write_fixture_source();
    let artifact_dir = tempfile::TempDir::new().expect("artifact tempdir");
    let artifact_root = RuntimeArtifactRoot::new(artifact_dir.path().to_path_buf());
    artifact_root.prepare().expect("prepare artifact root");
    let fixture = utsushi_core::port::conformance::ConformanceFixture {
        input_root,
        artifact_root,
        env: PortEnv::default(),
        run_id: "fixture-abi-run".to_string(),
    };

    let report = run_required_abi::<FixtureEnginePort, _>(FixtureEnginePort::new, &fixture)
        .expect("fixture engine port must pass required ABI conformance");

    assert_eq!(report.manifest_id, FixtureEnginePort::MANIFEST.id);
    assert!(report.launched);
    assert_eq!(
        report.observation_count, 3,
        "two text emissions plus one frame emission should drain"
    );
    assert!(report.captured);
    assert!(report.first_shutdown_clean);
    assert!(report.second_shutdown_idempotent);
    assert_eq!(report.jump_outcome, JumpOutcome::NotDeclared);
    assert!(report.cancellation_observed);
}

#[test]
fn fixture_runtime_adapter_descriptor_derives_from_manifest() {
    let adapter = FixtureRuntimeAdapter::new();
    let descriptor = adapter.descriptor();
    let manifest = FixtureEnginePort::MANIFEST;

    assert_eq!(descriptor.name, manifest.id);
    assert_eq!(descriptor.version, manifest.version);
    assert_eq!(descriptor.fidelity_tier, manifest.fidelity_tier_max);
    assert_eq!(descriptor.evidence_tier_ceiling, manifest.evidence_tier_max);
    assert_eq!(
        descriptor.limitations,
        manifest
            .limitations
            .iter()
            .map(std::string::ToString::to_string)
            .collect::<Vec<_>>()
    );
    assert!(descriptor.supports(RuntimeCapability::Trace));
    assert!(descriptor.supports(RuntimeCapability::FrameCapture));
    assert!(descriptor.supports(RuntimeCapability::SmokeValidation));
    assert!(!descriptor.supports(RuntimeCapability::BranchDiscovery));

    let launch = descriptor
        .capability_contract
        .features
        .iter()
        .find(|feature| feature.feature == utsushi_core::RuntimePlaybackFeature::Launch)
        .expect("launch feature derived from manifest");
    assert_eq!(launch.status, RuntimeFeatureStatus::Supported);
    assert_eq!(
        launch.evidence_tier_ceiling,
        Some(manifest.evidence_tier_max)
    );
}
