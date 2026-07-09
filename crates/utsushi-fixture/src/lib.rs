use std::fmt;
use std::fs;
use std::path::Path;

use serde_json::{Value, json};
use utsushi_core::{
    EnginePortAdapter, RuntimeAdapter, RuntimeAdapterDescriptor, RuntimeRequest, UtsushiResult,
};

pub mod engine_port;
pub mod jump_targets;
mod launch_adapters;
pub mod mv_mz_review_package;
pub mod mv_mz_screenshot_evidence;
pub mod mvmz_demo_bundle;
pub mod mvmz_patched_runtime_proof;
pub mod mvmz_runtime_proof;
mod reference_corpus;

pub use engine_port::{
    FIXTURE_OBSERVATION_HOOK_SCHEMA_VERSION, FixtureEnginePort, FixtureFrameSink,
    FixtureObservationSinks, FixtureTextSink,
};
pub use jump_targets::{
    BridgeUnitIndex, InMemoryBridgeUnitIndex, JUMP_TARGET_SCHEMA_VERSION, JumpTargetError,
    JumpTargetFixture, JumpTargetSet,
};
pub use launch_adapters::{BrowserLaunchAdapter, NwjsLaunchAdapter};
pub use reference_corpus::{ReferenceCaptureValidationReport, validate_reference_capture_corpus};

/// Schema-version literal used inside observation-hook envelope JSON
/// emitted by the fixture adapters. Kept as a local constant so the
/// fixture wire shape continues to advertise the `0.1.0-alpha` value
/// `kaifuu-core` validates against, even though the `utsushi-core` Rust
/// type that previously held this constant was deleted by UTSUSHI-224.
pub const FIXTURE_OBSERVATION_HOOK_SCHEMA_LITERAL: &str = "0.1.0-alpha";

pub struct FixtureRuntimeAdapter {
    inner: EnginePortAdapter<FixtureEnginePort>,
}

impl FixtureRuntimeAdapter {
    pub const NAME: &'static str = "utsushi-fixture";

    pub fn new() -> Self {
        Self {
            inner: EnginePortAdapter::new(FixtureEnginePort::new())
                .expect("fixture engine port manifest must be valid"),
        }
    }
}

impl Default for FixtureRuntimeAdapter {
    fn default() -> Self {
        Self::new()
    }
}

impl RuntimeAdapter for FixtureRuntimeAdapter {
    fn descriptor(&self) -> RuntimeAdapterDescriptor {
        self.inner.descriptor()
    }

    fn trace(&self, request: &RuntimeRequest<'_>) -> UtsushiResult<Value> {
        read_source(request.input_root)?;
        self.inner.trace(request)
    }

    fn capture(&self, request: &RuntimeRequest<'_>) -> UtsushiResult<Value> {
        read_source(request.input_root)?;
        self.inner.capture(request)
    }

    fn smoke_validate(&self, request: &RuntimeRequest<'_>) -> UtsushiResult<Value> {
        read_source(request.input_root)?;
        self.inner.smoke_validate(request)
    }
}

pub fn trace_fixture(input_root: &Path) -> UtsushiResult<Value> {
    let adapter = FixtureRuntimeAdapter::new();
    adapter.trace(&RuntimeRequest::new(input_root))
}

pub fn capture_fixture(input_root: &Path) -> UtsushiResult<Value> {
    let adapter = FixtureRuntimeAdapter::new();
    let artifact_root = input_root.join("runtime-artifacts");
    adapter.capture(&RuntimeRequest::new(input_root).with_artifact_root(&artifact_root))
}

pub fn smoke_fixture(input_root: &Path) -> UtsushiResult<Value> {
    let adapter = FixtureRuntimeAdapter::new();
    let artifact_root = input_root.join("runtime-artifacts");
    adapter.smoke_validate(&RuntimeRequest::new(input_root).with_artifact_root(&artifact_root))
}

/// Engine family the fixture runtime adapter attempts when it reads an
/// input root. The fixture adapter interprets its input as a synthetic,
/// deterministic fixture manifest (`source.json`); it never emulates a
/// commercial engine, so the family it attempts is the fixture family
/// itself. Carried on the [`UnsupportedInputShape`] diagnostic so a caller
/// can see which family was being attempted when the input was refused.
pub const FIXTURE_ENGINE_FAMILY: &str = "fixture";

/// Structured diagnostic emitted when the fixture runtime adapter is handed
/// an input that is not a valid fixture — for example a real game directory,
/// or any directory missing the `source.json` fixture manifest. The adapter
/// refuses such input with this typed `utsushi.unsupported_input_shape`
/// diagnostic (carrying the attempted `engine_family` and a helpful detail)
/// instead of surfacing an opaque `os::Error::NotFound` from the underlying
/// manifest read.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UnsupportedInputShape {
    engine_family: String,
    detail: String,
}

impl UnsupportedInputShape {
    /// Stable diagnostic code in the `utsushi.*` namespace.
    pub const CODE: &'static str = "utsushi.unsupported_input_shape";

    pub fn new(engine_family: impl Into<String>, detail: impl Into<String>) -> Self {
        Self {
            engine_family: engine_family.into(),
            detail: detail.into(),
        }
    }

    pub fn code(&self) -> &'static str {
        Self::CODE
    }

    pub fn engine_family(&self) -> &str {
        &self.engine_family
    }

    pub fn detail(&self) -> &str {
        &self.detail
    }

    /// Structured diagnostic envelope emitted on stdout by the CLI:
    /// `{"diagnostic":{"code":..., "engine_family":..., "detail":...}}`.
    pub fn to_diagnostic_json(&self) -> Value {
        json!({
            "diagnostic": {
                "code": Self::CODE,
                "engine_family": self.engine_family,
                "detail": self.detail,
            }
        })
    }
}

impl fmt::Display for UnsupportedInputShape {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            formatter,
            "{}: input for engine family {} is not a valid fixture: {}",
            Self::CODE,
            self.engine_family,
            self.detail,
        )
    }
}

impl std::error::Error for UnsupportedInputShape {}

pub(crate) fn read_source(input_root: &Path) -> UtsushiResult<Value> {
    // Refuse a NON-fixture input with a typed diagnostic BEFORE the raw
    // filesystem read would surface an opaque `os::Error::NotFound`. A valid
    // fixture input is a directory carrying a `source.json` manifest with a
    // non-empty `units` array; anything else (a real game directory, an empty
    // directory, a malformed manifest) is refused here.
    let manifest_path = input_root.join("source.json");
    if !manifest_path.is_file() {
        return Err(UnsupportedInputShape::new(
            FIXTURE_ENGINE_FAMILY,
            "input is not a fixture: expected a fixture manifest named source.json (a fixture directory carries a source.json with a non-empty `units` array)",
        )
        .into());
    }
    let raw = fs::read_to_string(&manifest_path)?;
    let source: Value = serde_json::from_str(&raw).map_err(|error| {
        UnsupportedInputShape::new(
            FIXTURE_ENGINE_FAMILY,
            format!("fixture manifest source.json is not valid JSON: {error}"),
        )
    })?;
    if !source.get("units").is_some_and(Value::is_array) {
        return Err(UnsupportedInputShape::new(
            FIXTURE_ENGINE_FAMILY,
            "fixture manifest source.json is missing the required `units` array",
        )
        .into());
    }
    Ok(source)
}

pub(crate) fn first_unit(source: &Value) -> UtsushiResult<&Value> {
    source["units"]
        .as_array()
        .and_then(|units| units.first())
        .ok_or_else(|| "source has no units".into())
}

fn adapter_id_value(descriptor: &RuntimeAdapterDescriptor) -> Value {
    json!({
        "name": descriptor.name,
        "version": descriptor.version,
    })
}

fn source_revision_value(source: &Value) -> Value {
    json!({
        "sourceId": source["gameId"].as_str().unwrap_or("fixture"),
        "revisionId": "fixture-source-v0.1",
    })
}

fn observation_bridge_ref_value(unit: &Value, index: usize) -> UtsushiResult<Value> {
    Ok(json!({
        "bridgeUnitId": legacy_fixture_id("bridge-unit", index),
        "sourceUnitKey": require_str(unit, "sourceUnitKey")?,
    }))
}

fn runtime_target_id(source: &Value) -> String {
    format!(
        "fixture:{}",
        source["gameId"]
            .as_str()
            .unwrap_or("unknown-runtime-target")
    )
}

pub(crate) fn bridge_unit_ref(unit: &Value, index: usize) -> UtsushiResult<Value> {
    Ok(json!({
        "bridgeUnitId": legacy_fixture_id("bridge-unit", index),
        "sourceUnitKey": require_str(unit, "sourceUnitKey")?
    }))
}

pub(crate) fn require_str<'a>(value: &'a Value, key: &str) -> UtsushiResult<&'a str> {
    value[key]
        .as_str()
        .ok_or_else(|| format!("fixture source unit missing {key}").into())
}

pub(crate) fn legacy_fixture_id(kind: &str, index: usize) -> String {
    let mut compact = kind.replace('-', "");
    compact.truncate(8);
    while compact.len() < 8 {
        compact.push('0');
    }
    format!("019ed000-0000-7000-8000-{compact}{index:04}")
}

#[cfg(test)]
mod tests {
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
        let adapter = FixtureRuntimeAdapter::new();
        let descriptor = adapter.descriptor();

        assert_eq!(descriptor.name, FixtureRuntimeAdapter::NAME);
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
        let adapter = FixtureRuntimeAdapter::new();
        let mut registry = RuntimeAdapterRegistry::new();
        registry.register(&adapter).unwrap();

        let report = registry
            .run(
                FixtureRuntimeAdapter::NAME,
                RuntimeOperation::Trace,
                &RuntimeRequest::new(&game_dir),
            )
            .unwrap();

        assert_eq!(report["adapterName"], FixtureRuntimeAdapter::NAME);
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
        let adapter = FixtureRuntimeAdapter::new();
        let mut registry = RuntimeAdapterRegistry::new();
        registry.register(&adapter).unwrap();

        let error = registry
            .run(
                FixtureRuntimeAdapter::NAME,
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
        assert_eq!(report["adapterName"], FixtureRuntimeAdapter::NAME);
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

        let adapter = FixtureRuntimeAdapter::new();
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
}
