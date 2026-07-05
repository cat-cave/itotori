use std::fmt;
use std::fs;
use std::path::Path;

use serde_json::{Value, json};
use utsushi_core::{
    ApproximationTier, ControlledPlaybackSession, EvidenceTier, FidelityTier, RuntimeAdapter,
    RuntimeAdapterDescriptor, RuntimeArtifactKind, RuntimeArtifactRoot, RuntimeCapability,
    RuntimeCapabilityClass, RuntimeCapabilityContract, RuntimeFeatureSupport,
    RuntimePlaybackFeature, RuntimeRequest, UtsushiResult, runtime_artifact_uri,
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

pub struct FixtureRuntimeAdapter;

impl FixtureRuntimeAdapter {
    pub const NAME: &'static str = "utsushi-fixture";

    pub fn new() -> Self {
        Self
    }
}

impl Default for FixtureRuntimeAdapter {
    fn default() -> Self {
        Self::new()
    }
}

impl RuntimeAdapter for FixtureRuntimeAdapter {
    fn descriptor(&self) -> RuntimeAdapterDescriptor {
        RuntimeAdapterDescriptor {
            name: Self::NAME.to_string(),
            version: env!("CARGO_PKG_VERSION").to_string(),
            fidelity_tier: FidelityTier::LayoutProbe,
            evidence_tier_ceiling: EvidenceTier::E2,
            capability_contract: fixture_capability_contract(),
            capabilities: vec![
                RuntimeCapability::Trace,
                RuntimeCapability::FrameCapture,
                RuntimeCapability::SmokeValidation,
            ],
            approximation_tiers: vec![ApproximationTier::DeterministicFixture],
            diagnostics: vec![],
            limitations: vec![
                "Synthetic fixture runtime only; no commercial engine behavior is emulated."
                    .to_string(),
                "Frame captures are deterministic screenshot references, not pixel comparisons."
                    .to_string(),
                "Branch discovery is not implemented for the current fixture source format."
                    .to_string(),
            ],
        }
    }

    fn trace(&self, request: &RuntimeRequest<'_>) -> UtsushiResult<Value> {
        let source = read_source(request.input_root)?;
        let unit = first_unit(&source)?;
        let descriptor = self.descriptor();
        Ok(runtime_report(
            &descriptor,
            &source,
            RuntimeReportInput {
                trace_events: vec![trace_event(unit, 1)?],
                observation_events: vec![text_observation_hook_event(
                    &descriptor,
                    &source,
                    unit,
                    1,
                    EvidenceTier::E1,
                )?],
                captures: vec![],
                operation: RuntimeOperationLabel::Trace,
                fidelity_tier: FidelityTier::TraceOnly,
                evidence_tier: EvidenceTier::E1,
                limitation: "Runtime trace reached fixture text; no frame was captured.",
            },
        ))
    }

    fn capture(&self, request: &RuntimeRequest<'_>) -> UtsushiResult<Value> {
        let source = read_source(request.input_root)?;
        let unit = first_unit(&source)?;
        let descriptor = self.descriptor();
        let capture = capture_event(unit, 1)?;
        let observation_events = vec![
            text_observation_hook_event(&descriptor, &source, unit, 1, EvidenceTier::E1)?,
            frame_observation_hook_event(&descriptor, &source, unit, &capture, 1)?,
        ];
        materialize_fixture_capture(request, &capture)?;
        Ok(runtime_report(
            &descriptor,
            &source,
            RuntimeReportInput {
                trace_events: vec![trace_event(unit, 1)?],
                observation_events,
                captures: vec![capture],
                operation: RuntimeOperationLabel::Capture,
                fidelity_tier: FidelityTier::LayoutProbe,
                evidence_tier: EvidenceTier::E2,
                limitation: "Fixture capture produced a screenshot reference; no pixel comparison was performed.",
            },
        ))
    }

    fn smoke_validate(&self, request: &RuntimeRequest<'_>) -> UtsushiResult<Value> {
        self.capture(request)
    }
}

pub fn trace_fixture(input_root: &Path) -> UtsushiResult<Value> {
    let adapter = FixtureRuntimeAdapter::new();
    adapter.trace(&RuntimeRequest::new(input_root))
}

pub fn capture_fixture(input_root: &Path) -> UtsushiResult<Value> {
    let adapter = FixtureRuntimeAdapter::new();
    adapter.capture(&RuntimeRequest::new(input_root))
}

pub fn smoke_fixture(input_root: &Path) -> UtsushiResult<Value> {
    let adapter = FixtureRuntimeAdapter::new();
    adapter.smoke_validate(&RuntimeRequest::new(input_root))
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

#[derive(Clone, Copy)]
enum RuntimeOperationLabel {
    Trace,
    Capture,
}

impl RuntimeOperationLabel {
    fn as_core_operation(self) -> utsushi_core::RuntimeOperation {
        match self {
            Self::Trace => utsushi_core::RuntimeOperation::Trace,
            Self::Capture => utsushi_core::RuntimeOperation::Capture,
        }
    }

    fn features_used(self) -> Vec<RuntimePlaybackFeature> {
        match self {
            Self::Trace => vec![
                RuntimePlaybackFeature::StaticTrace,
                RuntimePlaybackFeature::TextTrace,
                RuntimePlaybackFeature::InstrumentationHooks,
            ],
            Self::Capture => vec![
                RuntimePlaybackFeature::StaticTrace,
                RuntimePlaybackFeature::TextTrace,
                RuntimePlaybackFeature::FrameCapture,
                RuntimePlaybackFeature::InstrumentationHooks,
            ],
        }
    }
}

fn fixture_capability_contract() -> RuntimeCapabilityContract {
    RuntimeCapabilityContract::new(
        RuntimeCapabilityClass::LaunchCapture,
        FidelityTier::LayoutProbe,
        EvidenceTier::E2,
        vec![
            RuntimeFeatureSupport::supported(
                RuntimePlaybackFeature::StaticTrace,
                EvidenceTier::E1,
                "Reads fixture source JSON and emits deterministic text reachability trace events.",
            ),
            RuntimeFeatureSupport::supported(
                RuntimePlaybackFeature::Launch,
                EvidenceTier::E1,
                "Launches the synthetic fixture playback model without invoking a commercial engine.",
            ),
            RuntimeFeatureSupport::supported(
                RuntimePlaybackFeature::TextTrace,
                EvidenceTier::E1,
                "Reports the first reachable fixture text unit as observed runtime text.",
            ),
            RuntimeFeatureSupport::partial(
                RuntimePlaybackFeature::FrameCapture,
                EvidenceTier::E2,
                "Emits deterministic frame metadata and a portable artifact reference.",
                vec![
                    "Frame metadata is fixture-generated and is not a live engine screenshot."
                        .to_string(),
                ],
            ),
            RuntimeFeatureSupport::unsupported(
                RuntimePlaybackFeature::BranchDiscovery,
                "Branch discovery is not implemented for the current fixture source format.",
            ),
            RuntimeFeatureSupport::unsupported(
                RuntimePlaybackFeature::Jump,
                "Controlled jump targets are outside the base fixture contract.",
            ),
            RuntimeFeatureSupport::unsupported(
                RuntimePlaybackFeature::Snapshot,
                "Snapshot save and restore are outside the base fixture contract.",
            ),
            RuntimeFeatureSupport::unsupported(
                RuntimePlaybackFeature::Screenshot,
                "The fixture does not capture live engine screenshots.",
            ),
            RuntimeFeatureSupport::unsupported(
                RuntimePlaybackFeature::Recording,
                "The fixture does not record playback video.",
            ),
            RuntimeFeatureSupport::partial(
                RuntimePlaybackFeature::InstrumentationHooks,
                EvidenceTier::E2,
                "Emits deterministic observation hook envelopes for fixture text and frame evidence.",
                vec![
                    "Observation hook events are fixture-generated and are not live commercial engine callbacks."
                        .to_string(),
                ],
            ),
            RuntimeFeatureSupport::unsupported(
                RuntimePlaybackFeature::VmStateInspection,
                "The fixture does not expose VM state inspection.",
            ),
            RuntimeFeatureSupport::unsupported(
                RuntimePlaybackFeature::ReferenceComparison,
                "The fixture is not a reference VM and performs no reference comparison.",
            ),
        ],
        vec![
            "Synthetic fixture runtime only; no commercial engine behavior is emulated."
                .to_string(),
            "Capture support is deterministic metadata, not live-engine screenshot capture."
                .to_string(),
        ],
    )
}

struct RuntimeReportInput {
    trace_events: Vec<Value>,
    observation_events: Vec<Value>,
    captures: Vec<Value>,
    operation: RuntimeOperationLabel,
    fidelity_tier: FidelityTier,
    evidence_tier: EvidenceTier,
    limitation: &'static str,
}

fn runtime_report(
    descriptor: &RuntimeAdapterDescriptor,
    source: &Value,
    input: RuntimeReportInput,
) -> Value {
    let RuntimeReportInput {
        trace_events,
        observation_events,
        captures,
        operation,
        fidelity_tier,
        evidence_tier,
        limitation,
    } = input;
    let affected_bridge_unit_refs = trace_events
        .iter()
        .filter_map(|event| event.get("bridgeUnitRef").cloned())
        .collect::<Vec<_>>();
    let mut limitations = descriptor.limitations.clone();
    if !limitations.iter().any(|entry| entry == limitation) {
        limitations.push(limitation.to_string());
    }
    json!({
        "schemaVersion": "0.2.0",
        "runtimeReportId": deterministic_uuid("runtime-report", 1),
        "sourceLocale": source["sourceLocale"].as_str().unwrap_or("und"),
        "adapterName": descriptor.name,
        "adapterVersion": descriptor.version,
        "fidelityTier": fidelity_tier.as_str(),
        "evidenceTier": evidence_tier.as_str(),
        "runtimeCapabilities": descriptor.capability_contract.to_json(),
        "controlledPlaybackSession": ControlledPlaybackSession {
            session_id: deterministic_uuid("session", 1),
            adapter_name: descriptor.name.clone(),
            adapter_version: descriptor.version.clone(),
            capability_class: descriptor.capability_contract.capability_class,
            requested_operation: operation.as_core_operation(),
            status: "passed".to_string(),
            fidelity_tier,
            evidence_tier,
            features_used: operation.features_used(),
            limitations: limitations.clone(),
        }.to_json(),
        "status": "passed",
        "createdAt": "2026-06-17T00:00:00.000Z",
        "traceEvents": trace_events,
        "observationHookEvents": observation_events,
        "branchEvents": [],
        "captures": captures,
        "recordings": [],
        "approximations": [
            {
                "approximationId": deterministic_uuid("approximation", 1),
                "approximationTier": ApproximationTier::DeterministicFixture.as_str(),
                "scope": "fixture runtime",
                "description": "Fixture runtime emits deterministic trace and capture evidence without reference-runtime pixel comparison.",
                "affectedBridgeUnitRefs": affected_bridge_unit_refs,
                "evidenceTierCeiling": evidence_tier.as_str()
            }
        ],
        "validationFindings": [],
        "limitations": limitations
    })
}

fn text_observation_hook_event(
    descriptor: &RuntimeAdapterDescriptor,
    source: &Value,
    unit: &Value,
    frame: usize,
    evidence_tier: EvidenceTier,
) -> UtsushiResult<Value> {
    let bridge_ref_value = observation_bridge_ref_value(unit, 1)?;
    Ok(json!({
        "schemaVersion": FIXTURE_OBSERVATION_HOOK_SCHEMA_LITERAL,
        "eventId": deterministic_uuid("observation-text", frame),
        "observedAt": "2026-06-17T00:00:00.000Z",
        "eventKind": "text",
        "runtimeTargetId": runtime_target_id(source),
        "adapterId": adapter_id_value(descriptor),
        "evidenceTier": evidence_tier.as_str(),
        "environment": fixture_environment_value(source),
        "sourceRevision": source_revision_value(source),
        "bridgeRefs": [bridge_ref_value],
        "redaction": {"status": "not_required"},
        "payload": {
            "payloadKind": "text",
            "text": unit["targetText"]
                .as_str()
                .or_else(|| unit["sourceText"].as_str())
                .unwrap_or(""),
            "speaker": unit["speaker"].as_str(),
            "textSurface": unit["textSurface"].as_str(),
        },
    }))
}

fn frame_observation_hook_event(
    descriptor: &RuntimeAdapterDescriptor,
    source: &Value,
    unit: &Value,
    capture: &Value,
    frame: u64,
) -> UtsushiResult<Value> {
    let bridge_ref_value = observation_bridge_ref_value(unit, 1)?;
    Ok(json!({
        "schemaVersion": FIXTURE_OBSERVATION_HOOK_SCHEMA_LITERAL,
        "eventId": deterministic_uuid("observation-frame", frame as usize),
        "observedAt": "2026-06-17T00:00:00.000Z",
        "eventKind": "frame",
        "runtimeTargetId": runtime_target_id(source),
        "adapterId": adapter_id_value(descriptor),
        "evidenceTier": EvidenceTier::E2.as_str(),
        "environment": fixture_environment_value(source),
        "sourceRevision": source_revision_value(source),
        "bridgeRefs": [bridge_ref_value],
        "redaction": {"status": "not_required"},
        "payload": {
            "payloadKind": "frame",
            "frame": frame,
            "width": capture["width"].as_u64(),
            "height": capture["height"].as_u64(),
            "artifactRef": capture["artifactRef"].clone(),
        },
    }))
}

fn adapter_id_value(descriptor: &RuntimeAdapterDescriptor) -> Value {
    json!({
        "name": descriptor.name,
        "version": descriptor.version,
    })
}

fn fixture_environment_value(source: &Value) -> Value {
    json!({
        "runtime": "fixture",
        "engine": "utsushi-fixture",
        "platform": std::env::consts::OS,
        "display": "none",
        "locale": source["sourceLocale"].as_str(),
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

fn trace_event(unit: &Value, frame: usize) -> UtsushiResult<Value> {
    Ok(json!({
        "traceEventId": deterministic_uuid("runtime-trace", frame),
        "eventKind": "text_observed",
        "bridgeUnitRef": bridge_unit_ref(unit, 1)?,
        "frame": frame,
        "traceKey": require_str(unit, "sourceUnitKey")?,
        "observedText": unit["targetText"]
            .as_str()
            .or_else(|| unit["sourceText"].as_str())
            .unwrap_or("")
    }))
}

fn capture_event(unit: &Value, frame: usize) -> UtsushiResult<Value> {
    let artifact_id = deterministic_uuid("screenshot", frame);
    let uri = runtime_artifact_uri(
        &deterministic_uuid("runtime-report", 1),
        RuntimeArtifactKind::Screenshot,
        &artifact_id,
    )?;
    Ok(json!({
        "captureId": deterministic_uuid("capture", frame),
        "bridgeUnitRef": bridge_unit_ref(unit, 1)?,
        "evidenceTier": EvidenceTier::E2.as_str(),
        "frame": frame,
        "width": 320,
        "height": 180,
        "nonZeroPixels": 57600,
        "artifactRef": {
            "artifactId": artifact_id,
            "artifactKind": "screenshot",
            "uri": uri,
            "mediaType": "image/png"
        }
    }))
}

fn materialize_fixture_capture(request: &RuntimeRequest<'_>, capture: &Value) -> UtsushiResult<()> {
    let Some(artifact_root) = request.artifact_root else {
        return Ok(());
    };
    let uri = capture["artifactRef"]["uri"]
        .as_str()
        .ok_or("fixture capture missing artifactRef.uri")?;
    let root = RuntimeArtifactRoot::new(artifact_root);
    root.prepare()?;
    root.write_bytes(
        uri,
        b"utsushi fixture deterministic screenshot placeholder\n",
    )?;
    Ok(())
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

pub(crate) fn deterministic_uuid(kind: &str, index: usize) -> String {
    let kind_code = match kind {
        "runtime-report" => 0x1000,
        "runtime-trace" => 0x2000,
        "capture" => 0x3000,
        "screenshot" => 0x4000,
        "approximation" => 0x5000,
        "session" => 0x6000,
        "observation-text" => 0x7000,
        "observation-frame" => 0x7100,
        _ => 0xf000,
    };
    format!("019ed003-0000-7000-8000-{kind_code:08x}{index:04x}")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};
    use utsushi_core::{RuntimeAdapterRegistry, RuntimeOperation};

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
        assert!(descriptor.uses_approximation(ApproximationTier::DeterministicFixture));
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
                    feature.feature == RuntimePlaybackFeature::Snapshot
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
                        && feature.status == utsushi_core::RuntimeFeatureStatus::Partial
                        && feature.evidence_tier_ceiling == Some(EvidenceTier::E2)
                })
        );
        assert!(
            descriptor
                .capability_contract
                .features
                .iter()
                .any(|feature| {
                    feature.feature == RuntimePlaybackFeature::Recording
                        && feature.status == utsushi_core::RuntimeFeatureStatus::Unsupported
                })
        );
        assert!(
            descriptor
                .limitations
                .iter()
                .any(|limitation| limitation.contains("no commercial engine behavior"))
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
        assert_eq!(report["evidenceTier"], "E1");
        assert_eq!(report["fidelityTier"], "trace_only");
        assert_eq!(
            report["controlledPlaybackSession"]["requestedOperation"],
            "trace"
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
        let report = smoke_fixture(&game_dir).unwrap();

        assert_eq!(report["schemaVersion"], "0.2.0");
        assert_eq!(report["adapterName"], FixtureRuntimeAdapter::NAME);
        assert_eq!(report["evidenceTier"], "E2");
        assert_eq!(report["fidelityTier"], "layout_probe");
        assert_eq!(
            report["runtimeCapabilities"]["capabilityClass"],
            "launch_capture"
        );
        assert_eq!(report["runtimeCapabilities"]["evidenceTierCeiling"], "E2");
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
            report["runtimeCapabilities"]["features"]
                .as_array()
                .unwrap()
                .iter()
                .any(|feature| {
                    feature["feature"] == "screenshot" && feature["status"] == "unsupported"
                })
        );
        assert_eq!(
            report["controlledPlaybackSession"]["capabilityClass"],
            "launch_capture"
        );
        assert_eq!(
            report["controlledPlaybackSession"]["requestedOperation"],
            "capture"
        );
        assert_eq!(report["controlledPlaybackSession"]["evidenceTier"], "E2");
        assert!(
            report["controlledPlaybackSession"]["featuresUsed"]
                .as_array()
                .unwrap()
                .iter()
                .any(|feature| feature == "instrumentation_hooks")
        );
        assert_eq!(report["traceEvents"].as_array().unwrap().len(), 1);
        assert_eq!(report["observationHookEvents"].as_array().unwrap().len(), 2);
        assert_eq!(
            report["observationHookEvents"][0]["schemaVersion"],
            FIXTURE_OBSERVATION_HOOK_SCHEMA_LITERAL
        );
        assert_eq!(report["observationHookEvents"][0]["eventKind"], "text");
        assert_eq!(
            report["observationHookEvents"][0]["payload"]["payloadKind"],
            "text"
        );
        assert_eq!(report["observationHookEvents"][0]["evidenceTier"], "E1");
        assert_eq!(
            report["observationHookEvents"][0]["runtimeTargetId"],
            "fixture:hello-fixture"
        );
        assert_eq!(report["observationHookEvents"][1]["eventKind"], "frame");
        assert_eq!(report["observationHookEvents"][1]["evidenceTier"], "E2");
        assert_eq!(
            report["observationHookEvents"][1]["payload"]["artifactRef"]["uri"],
            report["captures"][0]["artifactRef"]["uri"]
        );
        assert_eq!(report["captures"].as_array().unwrap().len(), 1);
        assert_eq!(
            report["captures"][0]["artifactRef"]["uri"],
            "artifacts/utsushi/runtime/019ed003-0000-7000-8000-000010000001/screenshots/019ed003-0000-7000-8000-000040000001.png"
        );
        assert!(report["captures"][0].get("bytes").is_none());
        assert!(report["captures"][0].get("data").is_none());
        assert_eq!(
            report["approximations"][0]["approximationTier"],
            "deterministic_fixture"
        );
        assert_eq!(report["approximations"][0]["evidenceTierCeiling"], "E2");
        let limitations = report["limitations"].as_array().unwrap();
        assert!(limitations.iter().any(|limitation| {
            limitation
                .as_str()
                .unwrap()
                .contains("no commercial engine behavior")
        }));
        assert!(
            limitations
                .iter()
                .any(|limitation| limitation.as_str().unwrap().contains("no pixel comparison"))
        );
        let _ = fs::remove_dir_all(game_dir);
    }

    #[test]
    fn trace_fixture_serializes_e1_without_capture_claims() {
        let game_dir = temp_game("trace");
        let report = trace_fixture(&game_dir).unwrap();

        assert_eq!(report["schemaVersion"], "0.2.0");
        assert_eq!(report["evidenceTier"], "E1");
        assert_eq!(report["fidelityTier"], "trace_only");
        assert_eq!(report["controlledPlaybackSession"]["evidenceTier"], "E1");
        assert!(
            report["controlledPlaybackSession"]["featuresUsed"]
                .as_array()
                .unwrap()
                .iter()
                .any(|feature| feature == "instrumentation_hooks")
        );
        assert_eq!(report["captures"].as_array().unwrap().len(), 0);
        assert_eq!(report["observationHookEvents"].as_array().unwrap().len(), 1);
        assert_eq!(report["observationHookEvents"][0]["eventKind"], "text");
        assert_eq!(report["observationHookEvents"][0]["evidenceTier"], "E1");
        assert_eq!(report["approximations"][0]["evidenceTierCeiling"], "E1");
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
        let uri = report["captures"][0]["artifactRef"]["uri"]
            .as_str()
            .unwrap();
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
        let _ = fs::remove_dir_all(root);
    }
}
