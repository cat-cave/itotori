//! Registry-routed replay capability for `utsushi-cli replay*`.
//!
//! The CLI owns this adapter because RealLive replay validation currently needs
//! the CLI-local staging seam for xor2 archives. The command modules dispatch
//! through `RuntimeAdapterRegistry`; this module is the only place that knows
//! how the RealLive replay driver is invoked.

use std::error::Error;

use serde_json::{Value, json};
use utsushi_core::{
    ApproximationTier, EvidenceTier, FidelityTier, RuntimeAdapter, RuntimeAdapterDescriptor,
    RuntimeCapability, RuntimeCapabilityClass, RuntimeCapabilityContract, RuntimeFeatureSupport,
    RuntimePlaybackFeature, RuntimeRequest, UtsushiResult,
};
use utsushi_reallive::{
    ReplayEvent, ReplayLog, ReplayOpts, replay_scene, replay_until_first_pause,
};

use crate::staged_replay::replay_scene_staged;

pub const REALLIVE_REPLAY_ADAPTER_NAME: &str = "reallive";
const REPLAY_REVIEW_RESULT_SCHEMA_VERSION: &str = "utsushi.cli.replay-review-result/0.1.0";
const PARAM_SCENE: &str = "scene";
const PARAM_DRIVER: &str = "driver";
const PARAM_SNAPSHOT: &str = "snapshot";
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
                        "RealLive replay emits deterministic decoded TextLine evidence.",
                    ),
                    RuntimeFeatureSupport::supported(
                        RuntimePlaybackFeature::Recording,
                        EvidenceTier::E3,
                        "RealLive replay is available through the CLI runtime registry.",
                    ),
                    RuntimeFeatureSupport::supported(
                        RuntimePlaybackFeature::Snapshot,
                        EvidenceTier::E3,
                        "RealLive replay can stop at the first pause and emit a snapshot.",
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
        let snapshot = params
            .get(PARAM_SNAPSHOT)
            .and_then(Value::as_bool)
            .unwrap_or(false);

        let opts = ReplayOpts::default();
        let (log, snapshot_json) = if snapshot {
            if driver != DRIVER_DIRECT {
                return Err(format!(
                    "utsushi.cli.replay.registry.invalid_parameters: snapshot replay requires \
                     driver={DRIVER_DIRECT}, got {driver}"
                )
                .into());
            }
            let (log, snapshot) = replay_until_first_pause(request.input_root, scene_id)
                .map_err(|err| format!("utsushi.cli.replay.driver: {err}"))?;
            let snapshot_value = snapshot
                .to_json_value()
                .map_err(|err| format!("utsushi.cli.replay.snapshot_serialise: {err}"))?;
            let snapshot_json = serde_json::to_string_pretty(&snapshot_value)
                .map_err(|err| format!("utsushi.cli.replay.snapshot_json: {err}"))?;
            (log, Some(snapshot_json))
        } else {
            let log = match driver {
                DRIVER_DIRECT => replay_scene(request.input_root, scene_id, &opts)
                    .map_err(|err| format!("utsushi.cli.replay.driver: {err}"))?,
                DRIVER_STAGED => replay_scene_staged(request.input_root, scene_id, &opts)
                    .map_err(|err| format!("utsushi.cli.replay_validate.driver: {err}"))?,
                _ => {
                    return Err(format!(
                        "utsushi.cli.replay.registry.invalid_parameters: unsupported replay \
                         driver {driver}"
                    )
                    .into());
                }
            };
            (log, None)
        };

        replay_result_value(scene_id, driver, &log, snapshot_json)
    }
}

pub fn replay_parameters(scene_id: u16) -> Value {
    json!({
        PARAM_SCENE: scene_id,
        PARAM_DRIVER: DRIVER_DIRECT,
        PARAM_SNAPSHOT: false,
    })
}

pub fn replay_snapshot_parameters(scene_id: u16) -> Value {
    json!({
        PARAM_SCENE: scene_id,
        PARAM_DRIVER: DRIVER_DIRECT,
        PARAM_SNAPSHOT: true,
    })
}

pub fn replay_validate_parameters(scene_id: u16) -> Value {
    json!({
        PARAM_SCENE: scene_id,
        PARAM_DRIVER: DRIVER_STAGED,
        PARAM_SNAPSHOT: false,
    })
}

pub fn replay_log_json(result: &Value, diagnostic_prefix: &str) -> Result<String, Box<dyn Error>> {
    required_string(result, "replayLogJson", diagnostic_prefix)
}

pub fn snapshot_json(
    result: &Value,
    diagnostic_prefix: &str,
) -> Result<Option<String>, Box<dyn Error>> {
    match result.get("snapshotJson") {
        Some(Value::String(value)) => Ok(Some(value.clone())),
        Some(_) => Err(format!(
            "{diagnostic_prefix}.registry_result: snapshotJson must be a string"
        )
        .into()),
        None => Ok(None),
    }
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

fn replay_result_value(
    scene_id: u16,
    driver: &str,
    log: &ReplayLog,
    snapshot_json: Option<String>,
) -> UtsushiResult<Value> {
    let serialise_prefix = if driver == DRIVER_STAGED {
        "utsushi.cli.replay_validate.serialise"
    } else {
        "utsushi.cli.replay.serialise"
    };
    let replay_log_json = log
        .to_deterministic_json()
        .map_err(|err| format!("{serialise_prefix}: {err}"))?;
    let mut value = json!({
        "schemaVersion": REPLAY_REVIEW_RESULT_SCHEMA_VERSION,
        "adapterName": REALLIVE_REPLAY_ADAPTER_NAME,
        "engine": REALLIVE_REPLAY_ADAPTER_NAME,
        "sceneId": scene_id,
        "driver": driver,
        "replayLogJson": replay_log_json,
        "textLineCount": log.text_line_count(),
        "textLines": text_lines(log),
    });
    if let Some(snapshot_json) = snapshot_json {
        value["snapshotJson"] = Value::String(snapshot_json);
    }
    Ok(value)
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
    fn missing_seen_reaches_registry_dispatched_reallive_driver() {
        let adapter = RealLiveReplayAdapter::new();
        let request = RuntimeRequest::new(std::path::Path::new("/tmp/utsushi-missing-seen.txt"))
            .with_parameters(replay_parameters(1));

        let err = adapter
            .replay_review(&request)
            .expect_err("missing Seen.txt should fail in RealLive driver");
        assert!(err.to_string().contains("utsushi.cli.replay.driver"));
    }
}
