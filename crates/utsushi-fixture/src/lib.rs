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
    FixtureObservationSinks, FixturePortInspectState, FixturePortStateInspectable, FixtureTextSink,
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
/// type that previously held this constant was deleted by.
pub const FIXTURE_OBSERVATION_HOOK_SCHEMA_LITERAL: &str = "0.1.0-alpha";

pub fn trace_fixture(input_root: &Path) -> UtsushiResult<Value> {
    let adapter = EnginePortAdapter::new(FixtureEnginePort::new())
        .expect("fixture engine port manifest must be valid");
    adapter.trace(&RuntimeRequest::new(input_root))
}

pub fn capture_fixture(input_root: &Path) -> UtsushiResult<Value> {
    let adapter = EnginePortAdapter::new(FixtureEnginePort::new())
        .expect("fixture engine port manifest must be valid");
    let artifact_root = input_root.join("runtime-artifacts");
    adapter.capture(&RuntimeRequest::new(input_root).with_artifact_root(&artifact_root))
}

pub fn smoke_fixture(input_root: &Path) -> UtsushiResult<Value> {
    let adapter = EnginePortAdapter::new(FixtureEnginePort::new())
        .expect("fixture engine port manifest must be valid");
    let artifact_root = input_root.join("runtime-artifacts");
    adapter.smoke_validate(&RuntimeRequest::new(input_root).with_artifact_root(&artifact_root))
}

/// Engine family the fixture engine port attempts when it reads an input
/// root. The port interprets its input as a synthetic
/// deterministic fixture manifest (`source.json`); it never emulates a
/// commercial engine, so the family it attempts is the fixture family
/// itself. Carried on the [`UnsupportedInputShape`] diagnostic so a caller
/// can see which family was being attempted when the input was refused.
pub const FIXTURE_ENGINE_FAMILY: &str = "fixture";

/// Structured diagnostic emitted when the fixture engine port is handed
/// an input that is not a valid fixture — for example a real game directory
/// or any directory missing the `source.json` fixture manifest. The port
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

pub(crate) fn read_source_for_engine_port(
    input_root: &Path,
) -> Result<Value, Box<dyn std::error::Error + Send + Sync>> {
    match read_source(input_root) {
        Ok(source) => Ok(source),
        Err(error) => match error.downcast::<UnsupportedInputShape>() {
            Ok(error) => Err(error),
            Err(error) => match error.downcast::<std::io::Error>() {
                Ok(error) => Err(error),
                Err(error) => Err(Box::new(std::io::Error::other(error.to_string()))),
            },
        },
    }
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
#[path = "lib_tests.rs"]
mod tests;
