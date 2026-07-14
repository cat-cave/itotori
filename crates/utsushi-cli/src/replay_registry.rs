//! Registry-routed replay capability for the CLI replay commands.
//!
//! The registry name remains the stable CLI-facing reallive adapter name
//! but the implementation now constructs a request-bound
//! EnginePortAdapter<UtsushiReallivePort>. The generic adapter owns the
//! Runner lifecycle; this module only translates the port's retained review
//! log into the legacy CLI result envelope.

use std::error::Error;
use std::path::Path;

use serde_json::{Value, json};
use utsushi_core::{
    ApproximationTier, EvidenceTier, FidelityTier, RuntimeAdapter, RuntimeAdapterDescriptor,
    RuntimeCapability, RuntimeCapabilityClass, RuntimeCapabilityContract, RuntimeFeatureSupport,
    RuntimePlaybackFeature, RuntimeRequest, UtsushiResult,
};
use utsushi_reallive::{ReplayEvent, ReplayLog};

use crate::reallive_port::build_adapter;

pub const REALLIVE_REPLAY_ADAPTER_NAME: &str = "reallive";
const REPLAY_REVIEW_RESULT_SCHEMA_VERSION: &str = "utsushi.cli.replay-review-result/0.1.0";
const PARAM_SCENE: &str = "scene";
const PARAM_DRIVER: &str = "driver";
const PARAM_GAMEEXE: &str = "gameexe";
const PARAM_G00_DIR: &str = "g00Dir";
const DRIVER_DIRECT: &str = "direct";
const DRIVER_STAGED: &str = "staged";

pub struct RealLiveReplayAdapter;

impl RealLiveReplayAdapter {
    pub const fn new() -> Self {
        Self
    }
}

impl RuntimeAdapter for RealLiveReplayAdapter {
    fn descriptor(&self) -> RuntimeAdapterDescriptor {
        RuntimeAdapterDescriptor {
            name: REALLIVE_REPLAY_ADAPTER_NAME.to_string(),
            version: "0.1.0".to_string(),
            fidelity_tier: FidelityTier::ReplayReview,
            evidence_tier_ceiling: EvidenceTier::E3,
            capability_contract: RuntimeCapabilityContract::new(
                RuntimeCapabilityClass::PartialVm,
                FidelityTier::ReplayReview,
                EvidenceTier::E3,
                vec![
                    RuntimeFeatureSupport::supported(
                        RuntimePlaybackFeature::TextTrace,
                        EvidenceTier::E3,
                        "RealLive replay emits deterministic decoded TextLine evidence through the engine port.",
                    ),
                    RuntimeFeatureSupport::supported(
                        RuntimePlaybackFeature::Recording,
                        EvidenceTier::E3,
                        "RealLive replay-review is driven by EnginePortAdapter and Runner.",
                    ),
                    RuntimeFeatureSupport::supported(
                        RuntimePlaybackFeature::Snapshot,
                        EvidenceTier::E3,
                        "RealLive replay self-verifies snapshot identity inside the EnginePort lifecycle; the CLI does not publish snapshot JSON.",
                    ),
                ],
                vec![
                    "RealLive replay is an alpha VM path and is not a reference-fidelity runtime."
                        .to_string(),
                ],
            ),
            capabilities: vec![RuntimeCapability::ReplayReview],
            approximation_tiers: vec![ApproximationTier::EnginePartial],
            diagnostics: Vec::new(),
            limitations: vec![
                "RealLive replay is limited to the implemented VM subset.".to_string(),
                "Snapshot JSON output is not exposed by the EnginePort replay-review surface."
                    .to_string(),
            ],
        }
    }

    fn trace(&self, _request: &RuntimeRequest<'_>) -> UtsushiResult<Value> {
        Err("RealLive replay adapter supports replay_review, not trace".into())
    }

    fn replay_review(&self, request: &RuntimeRequest<'_>) -> UtsushiResult<Value> {
        let params = request
            .parameters
            .as_ref()
            .ok_or("utsushi.cli.replay.registry.missing_parameters")?;
        let scene_id = required_u16_param(params, PARAM_SCENE)?;
        let driver = params
            .get(PARAM_DRIVER)
            .and_then(Value::as_str)
            .unwrap_or(DRIVER_DIRECT);
        if !matches!(driver, DRIVER_DIRECT | DRIVER_STAGED) {
            return Err(format!(
                "utsushi.cli.replay.registry.invalid_parameters: unsupported replay driver {driver}"
            )
            .into());
        }

        let gameexe_path = required_path_param(params, PARAM_GAMEEXE)?;
        let g00_dir = required_path_param(params, PARAM_G00_DIR)?;
        let adapter = build_adapter(request.input_root, scene_id, &gameexe_path, &g00_dir)
            .map_err(|error| {
                let prefix = if driver == DRIVER_STAGED {
                    "utsushi.cli.replay_validate.driver"
                } else {
                    "utsushi.cli.replay.driver"
                };
                format!("{prefix}: {error}")
            })?;

        // The review operation is fully driven by the generic adapter. The
        // returned runtime evidence report is intentionally not substituted
        // for the legacy replay-log envelope; the latter is read from the
        // same concrete port after Runner has completed the lifecycle.
        adapter.replay_review(request)?;
        let log = adapter
            .with_port(|port| port.replay_log().cloned())?
            .ok_or("utsushi.cli.replay.registry_result: port did not produce replay log")?;
        replay_result_value(scene_id, driver, &log)
    }
}

pub fn replay_parameters(scene_id: u16, gameexe: &Path, g00_dir: &Path) -> Value {
    replay_parameters_with_driver(scene_id, DRIVER_DIRECT, gameexe, g00_dir)
}

pub fn replay_validate_parameters(scene_id: u16, gameexe: &Path, g00_dir: &Path) -> Value {
    replay_parameters_with_driver(scene_id, DRIVER_STAGED, gameexe, g00_dir)
}

fn replay_parameters_with_driver(
    scene_id: u16,
    driver: &str,
    gameexe: &Path,
    g00_dir: &Path,
) -> Value {
    json!({
        PARAM_SCENE: scene_id,
        PARAM_DRIVER: driver,
        PARAM_GAMEEXE: gameexe.display().to_string(),
        PARAM_G00_DIR: g00_dir.display().to_string(),
    })
}

pub fn replay_log_json(result: &Value, diagnostic_prefix: &str) -> Result<String, Box<dyn Error>> {
    required_string(result, "replayLogJson", diagnostic_prefix)
}

pub fn text_line_count(result: &Value, diagnostic_prefix: &str) -> Result<u64, Box<dyn Error>> {
    result
        .get("textLineCount")
        .and_then(Value::as_u64)
        .ok_or_else(|| format!("{diagnostic_prefix}.registry_result: missing textLineCount").into())
}

pub fn emit_textlines_from_result(
    result: &Value,
    diagnostic_prefix: &str,
) -> Result<(), Box<dyn Error>> {
    let lines = result
        .get("textLines")
        .and_then(Value::as_array)
        .ok_or_else(|| format!("{diagnostic_prefix}.registry_result: missing textLines"))?;
    for line in lines {
        let index = line.get("index").and_then(Value::as_u64).ok_or_else(|| {
            format!("{diagnostic_prefix}.registry_result: missing text line index")
        })?;
        let pc = line
            .get("byteOffsetInScene")
            .and_then(Value::as_u64)
            .ok_or_else(|| {
                format!("{diagnostic_prefix}.registry_result: missing text line byteOffsetInScene")
            })?;
        let body = line
            .get("bodyUtf8")
            .and_then(Value::as_str)
            .ok_or_else(|| {
                format!("{diagnostic_prefix}.registry_result: missing text line bodyUtf8")
            })?;
        println!("textline[{index}] pc=0x{pc:04x} body={body:?}");
    }
    println!("textline_total={}", lines.len());
    Ok(())
}

fn replay_result_value(scene_id: u16, driver: &str, log: &ReplayLog) -> UtsushiResult<Value> {
    let serialise_prefix = if driver == DRIVER_STAGED {
        "utsushi.cli.replay_validate.serialise"
    } else {
        "utsushi.cli.replay.serialise"
    };
    let replay_log_json = log
        .to_deterministic_json()
        .map_err(|err| format!("{serialise_prefix}: {err}"))?;
    Ok(json!({
        "schemaVersion": REPLAY_REVIEW_RESULT_SCHEMA_VERSION,
        "adapterName": REALLIVE_REPLAY_ADAPTER_NAME,
        "engine": REALLIVE_REPLAY_ADAPTER_NAME,
        "sceneId": scene_id,
        "driver": driver,
        "replayLogJson": replay_log_json,
        "textLineCount": log.text_line_count(),
        "textLines": text_lines(log),
    }))
}

fn text_lines(log: &ReplayLog) -> Value {
    let mut lines = Vec::new();
    for event in &log.events {
        if let ReplayEvent::TextLine {
            byte_offset_in_scene,
            body_utf8,
            ..
        } = event
        {
            lines.push(json!({
                "index": lines.len(),
                "byteOffsetInScene": byte_offset_in_scene,
                "bodyUtf8": body_utf8,
            }));
        }
    }
    Value::Array(lines)
}

fn required_u16_param(params: &Value, key: &str) -> UtsushiResult<u16> {
    let value = params
        .get(key)
        .and_then(Value::as_u64)
        .ok_or_else(|| format!("utsushi.cli.replay.registry.missing_parameter: {key}"))?;
    u16::try_from(value).map_err(|_| {
        format!("utsushi.cli.replay.registry.invalid_parameter: {key} must be a u16").into()
    })
}

fn required_path_param(params: &Value, key: &str) -> UtsushiResult<std::path::PathBuf> {
    params
        .get(key)
        .and_then(Value::as_str)
        .map(std::path::PathBuf::from)
        .ok_or_else(|| format!("utsushi.cli.replay.registry.missing_parameter: {key}").into())
}

fn required_string(
    result: &Value,
    key: &str,
    diagnostic_prefix: &str,
) -> Result<String, Box<dyn Error>> {
    result
        .get(key)
        .and_then(Value::as_str)
        .map(str::to_string)
        .ok_or_else(|| format!("{diagnostic_prefix}.registry_result: missing {key}").into())
}

#[cfg(test)]
mod tests {
    use super::*;
    use utsushi_core::{RuntimeAdapterRegistry, RuntimeRequest};

    #[test]
    fn reallive_replay_adapter_registers_replay_review_capability() {
        let adapter = RealLiveReplayAdapter::new();
        let mut registry = RuntimeAdapterRegistry::new();
        registry.register(&adapter).expect("register adapter");

        let descriptor = registry
            .descriptors()
            .into_iter()
            .find(|descriptor| descriptor.name == REALLIVE_REPLAY_ADAPTER_NAME)
            .expect("descriptor");
        assert!(descriptor.supports(RuntimeCapability::ReplayReview));
    }

    #[test]
    fn missing_seen_reaches_registry_dispatched_reallive_port() {
        let adapter = RealLiveReplayAdapter::new();
        let request = RuntimeRequest::new(Path::new("/tmp/utsushi-missing-seen.txt"))
            .with_parameters(replay_parameters(
                1,
                Path::new("/tmp/utsushi-missing-gameexe.ini"),
                Path::new("/tmp/utsushi-missing-g00"),
            ));

        let err = adapter
            .replay_review(&request)
            .expect_err("missing Seen.txt should fail in the RealLive port");
        assert!(err.to_string().contains("utsushi.cli.replay.driver"));
    }
}
