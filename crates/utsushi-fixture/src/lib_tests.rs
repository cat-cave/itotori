use super::*;
use std::time::{SystemTime, UNIX_EPOCH};
use utsushi_core::{
    ApproximationTier, EvidenceTier, FidelityTier, RuntimeAdapterRegistry, RuntimeCapability,
    RuntimeCapabilityClass, RuntimeOperation, RuntimePlaybackFeature,
};

fn temp_game(name: &str) -> std::path::PathBuf {
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let dir = std::env::temp_dir().join(format!(
        "utsushi-fixture-{name}-{}-{nonce}",
        std::process::id()
    ));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).unwrap();
    fs::write(
        dir.join("source.json"),
        r#"{
  "gameId": "hello-fixture",
  "title": "Hello Fixture",
  "sourceLocale": "ja-JP",
  "units": [
    {
      "sourceUnitKey": "hello.scene.001.line.001",
      "speaker": "Narrator",
      "textSurface": "dialogue",
      "sourceText": "こんにちは、{player}。",
      "targetText": "Hello, {player}.",
      "protectedSpans": []
    }
  ]
}
"#,
    )
    .unwrap();
    dir
}

fn collect_report_artifact_uris(value: &Value, uris: &mut Vec<String>) {
    match value {
        Value::Object(object) => {
            if let Some(uri) = object.get("artifactUri").and_then(Value::as_str) {
                uris.push(uri.to_string());
            }
            if let Some(artifact_ref) = object.get("artifactRef").and_then(Value::as_object)
                && let Some(uri) = artifact_ref.get("uri").and_then(Value::as_str)
            {
                uris.push(uri.to_string());
            }
            for child in object.values() {
                collect_report_artifact_uris(child, uris);
            }
        }
        Value::Array(items) => {
            for item in items {
                collect_report_artifact_uris(item, uris);
            }
        }
        _ => {}
    }
}

fn assert_artifact_ref_ids_match_uri_filenames(value: &Value) {
    match value {
        Value::Object(object) => {
            if let Some(artifact_ref) = object.get("artifactRef").and_then(Value::as_object) {
                let artifact_id = artifact_ref
                    .get("artifactId")
                    .and_then(Value::as_str)
                    .expect("artifactRef.artifactId");
                let uri = artifact_ref
                    .get("uri")
                    .and_then(Value::as_str)
                    .expect("artifactRef.uri");
                let relative = utsushi_core::validate_runtime_artifact_uri(uri)
                    .expect("artifactRef.uri must be a managed runtime artifact URI");
                let file_stem = relative
                    .file_stem()
                    .and_then(|stem| stem.to_str())
                    .expect("artifactRef.uri filename stem");
                assert_eq!(
                    artifact_id, file_stem,
                    "artifactRef.artifactId must match artifactRef.uri filename stem for {uri}"
                );
            }
            for child in object.values() {
                assert_artifact_ref_ids_match_uri_filenames(child);
            }
        }
        Value::Array(items) => {
            for item in items {
                assert_artifact_ref_ids_match_uri_filenames(item);
            }
        }
        _ => {}
    }
}

fn assert_report_artifact_links_materialized(report: &Value, artifact_root: &std::path::Path) {
    let mut uris = Vec::new();
    collect_report_artifact_uris(report, &mut uris);
    assert!(!uris.is_empty(), "report must contain artifact links");
    assert_artifact_ref_ids_match_uri_filenames(report);

    let root = utsushi_core::RuntimeArtifactRoot::new(artifact_root);
    for uri in uris {
        let path = root
            .artifact_path(&uri)
            .unwrap_or_else(|error| panic!("artifact uri must resolve: {uri}: {error}"));
        assert!(
            path.is_file(),
            "reported artifact uri must be materialized: {uri} -> {path:?}"
        );
    }
}

#[test]
fn read_source_refuses_non_fixture_input_with_typed_diagnostic() {
    // A directory that is NOT a fixture (no source.json manifest) — the
    // shape a real game directory would present.
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let dir = std::env::temp_dir().join(format!(
        "utsushi-fixture-nonfixture-{}-{nonce}",
        std::process::id()
    ));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).unwrap();
    // A stray non-manifest file, to prove detection is by shape (missing
    // source.json), not merely by an empty directory.
    fs::write(dir.join("Game.exe"), b"not a fixture").unwrap();

    let error = read_source(&dir).expect_err("non-fixture input must be refused");
    let diagnostic = error
        .downcast_ref::<UnsupportedInputShape>()
        .expect("refusal must be a typed UnsupportedInputShape, not a raw NotFound");
    assert_eq!(diagnostic.code(), "utsushi.unsupported_input_shape");
    assert_eq!(diagnostic.engine_family(), FIXTURE_ENGINE_FAMILY);

    let json = diagnostic.to_diagnostic_json();
    assert_eq!(
        json["diagnostic"]["code"],
        Value::from("utsushi.unsupported_input_shape")
    );
    assert_eq!(
        json["diagnostic"]["engine_family"],
        Value::from(FIXTURE_ENGINE_FAMILY)
    );
    assert!(json["diagnostic"]["detail"].is_string());

    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn read_source_refuses_manifest_missing_units_array() {
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let dir = std::env::temp_dir().join(format!(
        "utsushi-fixture-nounits-{}-{nonce}",
        std::process::id()
    ));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).unwrap();
    fs::write(dir.join("source.json"), r#"{"gameId":"x"}"#).unwrap();

    let error = read_source(&dir).expect_err("manifest without units must be refused");
    let diagnostic = error
        .downcast_ref::<UnsupportedInputShape>()
        .expect("refusal must be a typed UnsupportedInputShape");
    assert_eq!(diagnostic.code(), "utsushi.unsupported_input_shape");
    assert_eq!(diagnostic.engine_family(), FIXTURE_ENGINE_FAMILY);

    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn read_source_accepts_valid_fixture() {
    let dir = temp_game("valid-source");
    let source = read_source(&dir).expect("a valid fixture must still be read");
    assert!(source["units"].is_array());
    assert!(first_unit(&source).is_ok());
    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn fixture_descriptor_reports_capabilities_and_limits() {
    let adapter = EnginePortAdapter::new(FixtureEnginePort::new())
        .expect("fixture engine port manifest must be valid");
    let descriptor = adapter.descriptor();

    assert_eq!(descriptor.name, FixtureEnginePort::MANIFEST.id);
    assert_eq!(descriptor.fidelity_tier, FidelityTier::LayoutProbe);
    assert_eq!(descriptor.evidence_tier_ceiling, EvidenceTier::E2);
    assert!(descriptor.supports(RuntimeCapability::Trace));
    assert!(descriptor.supports(RuntimeCapability::FrameCapture));
    assert!(descriptor.supports(RuntimeCapability::SmokeValidation));
    assert!(!descriptor.supports(RuntimeCapability::BranchDiscovery));
    assert!(descriptor.uses_approximation(ApproximationTier::None));
    assert_eq!(
        descriptor.capability_contract.capability_class,
        RuntimeCapabilityClass::LaunchCapture
    );
    assert_eq!(
        descriptor.capability_contract.evidence_tier_ceiling,
        EvidenceTier::E2
    );
    assert!(
        descriptor
            .capability_contract
            .features
            .iter()
            .any(|feature| {
                feature.feature == RuntimePlaybackFeature::Jump
                    && feature.status == utsushi_core::RuntimeFeatureStatus::Unsupported
            })
    );
    assert!(
        descriptor
            .capability_contract
            .features
            .iter()
            .any(|feature| {
                feature.feature == RuntimePlaybackFeature::InstrumentationHooks
                    && feature.status == utsushi_core::RuntimeFeatureStatus::Supported
                    && feature.evidence_tier_ceiling == Some(EvidenceTier::E2)
            })
    );
    assert!(
        descriptor
            .limitations
            .iter()
            .any(|limitation| limitation.contains("Synthetic fixture engine port"))
    );
}

#[test]
fn fixture_adapter_runs_through_registry() {
    let game_dir = temp_game("registry");
    let adapter = EnginePortAdapter::new(FixtureEnginePort::new())
        .expect("fixture engine port manifest must be valid");
    let mut registry = RuntimeAdapterRegistry::new();
    registry.register(&adapter).unwrap();

    let report = registry
        .run(
            FixtureEnginePort::MANIFEST.id,
            RuntimeOperation::Trace,
            &RuntimeRequest::new(&game_dir),
        )
        .unwrap();

    assert_eq!(report["adapterName"], FixtureEnginePort::MANIFEST.id);
    assert_eq!(report["operation"], "trace");
    assert_eq!(report["schemaVersion"], "0.2.0");
    assert_eq!(report["shutdownStatus"], "clean");
    let observations = report["sinkObservations"].as_array().unwrap();
    assert_eq!(observations.len(), 1);
    assert_eq!(observations[0]["sink"], "text_surface");
    let mut artifact_uris = Vec::new();
    collect_report_artifact_uris(&report, &mut artifact_uris);
    assert!(
        artifact_uris.is_empty(),
        "registry trace reports must not contain screenshot/frame artifact refs: {artifact_uris:?}"
    );
    let _ = fs::remove_dir_all(game_dir);
}

#[test]
fn fixture_registry_rejects_unsupported_branch_discovery() {
    let game_dir = temp_game("branch");
    let adapter = EnginePortAdapter::new(FixtureEnginePort::new())
        .expect("fixture engine port manifest must be valid");
    let mut registry = RuntimeAdapterRegistry::new();
    registry.register(&adapter).unwrap();

    let error = registry
        .run(
            FixtureEnginePort::MANIFEST.id,
            RuntimeOperation::BranchDiscovery,
            &RuntimeRequest::new(&game_dir),
        )
        .unwrap_err()
        .to_string();

    assert!(error.contains("does not support branch_discovery"));
    let _ = fs::remove_dir_all(game_dir);
}

#[test]
fn smoke_fixture_serializes_v02_referenced_capture_evidence() {
    let game_dir = temp_game("smoke");
    let artifact_root = game_dir.join("runtime-artifacts");
    let report = smoke_fixture(&game_dir).unwrap();

    assert_eq!(report["schemaVersion"], "0.2.0");
    assert_eq!(report["adapterName"], FixtureEnginePort::MANIFEST.id);
    assert_eq!(report["operation"], "smoke_validation");
    assert_eq!(report["shutdownStatus"], "clean");
    let observations = report["sinkObservations"].as_array().unwrap();
    assert_eq!(observations.len(), 2);
    assert_eq!(observations[0]["sink"], "text_surface");
    assert_eq!(observations[0]["payload"]["text"], "Hello, {player}.");
    assert_eq!(observations[1]["sink"], "frame_artifact");
    assert_eq!(report["captures"].as_array().unwrap().len(), 1);
    let artifact_uri = report["captures"][0]["artifactUri"].as_str().unwrap();
    let artifact_path = utsushi_core::RuntimeArtifactRoot::new(&artifact_root)
        .artifact_path(artifact_uri)
        .unwrap();
    assert!(artifact_path.is_file());
    assert_report_artifact_links_materialized(&report, &artifact_root);
    let _ = fs::remove_dir_all(game_dir);
}

#[test]
fn trace_fixture_serializes_e1_without_capture_claims() {
    let game_dir = temp_game("trace");
    let report = trace_fixture(&game_dir).unwrap();

    assert_eq!(report["schemaVersion"], "0.2.0");
    assert_eq!(report["operation"], "trace");
    assert_eq!(report["shutdownStatus"], "clean");
    assert_eq!(report["captures"].as_array().unwrap().len(), 0);
    let observations = report["sinkObservations"].as_array().unwrap();
    assert_eq!(observations.len(), 1);
    assert_eq!(observations[0]["sink"], "text_surface");
    let mut artifact_uris = Vec::new();
    collect_report_artifact_uris(&report, &mut artifact_uris);
    assert!(
        artifact_uris.is_empty(),
        "trace reports must not contain screenshot/frame artifact refs: {artifact_uris:?}"
    );
    let _ = fs::remove_dir_all(game_dir);
}

#[test]
fn capture_materializes_artifact_under_managed_root_when_requested() {
    let root = temp_game("artifact-root");
    let game_dir = root.join("game");
    fs::create_dir_all(&game_dir).unwrap();
    fs::rename(root.join("source.json"), game_dir.join("source.json")).unwrap();
    let artifact_root = root.join("runtime-artifacts");

    let adapter = EnginePortAdapter::new(FixtureEnginePort::new())
        .expect("fixture engine port manifest must be valid");
    let report = adapter
        .capture(&RuntimeRequest::new(&game_dir).with_artifact_root(&artifact_root))
        .unwrap();
    let uri = report["captures"][0]["artifactUri"].as_str().unwrap();
    let artifact_path = utsushi_core::RuntimeArtifactRoot::new(&artifact_root)
        .artifact_path(uri)
        .unwrap();

    assert!(
        artifact_root
            .join(utsushi_core::RUNTIME_ARTIFACT_ROOT_MARKER)
            .is_file()
    );
    assert!(artifact_path.is_file());
    assert!(artifact_path.starts_with(&artifact_root));
    let contents = fs::read_to_string(artifact_path).unwrap();
    assert!(contents.contains("deterministic screenshot placeholder"));
    assert_report_artifact_links_materialized(&report, &artifact_root);
    let _ = fs::remove_dir_all(root);
}
