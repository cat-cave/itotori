//! Live-DOM observation parsing for the browser launch adapter.

use std::env;

use serde_json::{Value, json};
use utsushi_core::{EvidenceTier, RuntimeAdapterDescriptor};

use super::{OBSERVATION_SOURCE_LIVE_DOM, OBSERVED_ISLAND_BEGIN, OBSERVED_ISLAND_END};
use crate::FIXTURE_OBSERVATION_HOOK_SCHEMA_LITERAL;

/// Extract the observation island the fixture's runtime script injected into
/// the live post-render DOM, returning the decoded `events` array. Any DOM
/// without a well-formed island (JS never ran, render produced nothing, or the
/// caller passed a static source read) yields an empty vector — the
/// strict-proof negative control.
pub(super) fn parse_observed_dom(dom: &str) -> Vec<Value> {
    let Some(start) = dom.find(OBSERVED_ISLAND_BEGIN) else {
        return Vec::new();
    };
    let after = &dom[start + OBSERVED_ISLAND_BEGIN.len()..];
    let Some(end) = after.find(OBSERVED_ISLAND_END) else {
        return Vec::new();
    };
    let json = after[..end].trim();
    let Ok(parsed) = serde_json::from_str::<Value>(json) else {
        return Vec::new();
    };
    parsed
        .get("events")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
}

/// Turn the observed DOM events into `(traceEvents, observationHookEvents)`.
///
/// The observed surface spans the RPG Maker MV/MZ runtime event kinds the
/// public fixture emits from a live render:
/// - `text` -> a trace event AND a text observation hook event
/// - `choice` -> a choice observation hook event
/// - `scene` -> a scene observation hook event (SceneManager/map transition)
/// - `branch` -> a branch observation hook event (conditional-branch routing).
///
/// `scene` and `branch` are carried by the existing observation-hook envelope
/// (`ObservationScenePayload` / `ObservationBranchPayload`); no schema change is
/// required to observe them beyond the text+choice surface.
pub(super) fn build_observed_events(
    descriptor: &RuntimeAdapterDescriptor,
    source: &Value,
    observed: &[Value],
) -> (Vec<Value>, Vec<Value>) {
    let mut trace_events = Vec::new();
    let mut observation_events = Vec::new();
    for (index, event) in observed.iter().enumerate() {
        match event.get("kind").and_then(Value::as_str) {
            Some("text") => {
                if let Some(hook) = observed_text_hook_event(descriptor, source, index, event) {
                    observation_events.push(hook);
                }
                if let Some(trace) = observed_trace_event(source, index, event) {
                    trace_events.push(trace);
                }
            }
            Some("choice") => {
                if let Some(hook) = observed_choice_hook_event(descriptor, source, index, event) {
                    observation_events.push(hook);
                }
            }
            Some("scene") => {
                if let Some(hook) = observed_scene_hook_event(descriptor, source, index, event) {
                    observation_events.push(hook);
                }
            }
            Some("branch") => {
                if let Some(hook) = observed_branch_hook_event(descriptor, source, index, event) {
                    observation_events.push(hook);
                }
            }
            _ => {}
        }
    }
    (trace_events, observation_events)
}

/// Deterministic event id derived from the fixed observation-id base and the
/// observed event's position in the live DOM stream.
pub(super) fn observed_event_id(index: usize) -> String {
    format!("019ed050-0000-7000-8000-0000000072{index:02}")
}

pub(super) fn observed_trace_id(index: usize) -> String {
    format!("019ed050-0000-7000-8000-0000000073{index:02}")
}

/// Build a bridge reference linking an observed runtime unit key back to the
/// source unit (and therefore its bridge unit id) it corresponds to. Falls
/// back to a runtime-object reference when the key is unknown so the envelope
/// always identifies *something*.
pub(super) fn observed_bridge_ref(source: &Value, unit_key: Option<&str>) -> Value {
    if let Some(unit_key) = unit_key {
        if let Some(units) = source["units"].as_array()
            && let Some(position) = units
                .iter()
                .position(|unit| unit["sourceUnitKey"].as_str() == Some(unit_key))
        {
            return json!({
                "bridgeUnitId": crate::legacy_fixture_id("bridge-unit", position + 1),
                "sourceUnitKey": unit_key,
            });
        }
        return json!({ "sourceUnitKey": unit_key });
    }
    json!({ "runtimeObjectId": "utsushi:observed:unbound" })
}

pub(super) fn observed_text_hook_event(
    descriptor: &RuntimeAdapterDescriptor,
    source: &Value,
    index: usize,
    observed: &Value,
) -> Option<Value> {
    let text = observed.get("text").and_then(Value::as_str)?;
    let unit_key = observed.get("unitKey").and_then(Value::as_str);
    Some(json!({
        "schemaVersion": FIXTURE_OBSERVATION_HOOK_SCHEMA_LITERAL,
        "eventId": observed_event_id(index),
        "observedAt": "2026-06-17T00:00:00.000Z",
        "eventKind": "text",
        "runtimeTargetId": crate::runtime_target_id(source),
        "adapterId": crate::adapter_id_value(descriptor),
        "evidenceTier": EvidenceTier::E1.as_str(),
        "observationSource": OBSERVATION_SOURCE_LIVE_DOM,
        "environment": browser_environment_value(source),
        "sourceRevision": crate::source_revision_value(source),
        "bridgeRefs": [observed_bridge_ref(source, unit_key)],
        "redaction": {"status": "not_required"},
        "payload": {
            "payloadKind": "text",
            "text": text,
            "speaker": observed.get("speaker").and_then(Value::as_str),
            "textSurface": observed.get("textSurface").and_then(Value::as_str),
        },
    }))
}

pub(super) fn observed_choice_hook_event(
    descriptor: &RuntimeAdapterDescriptor,
    source: &Value,
    index: usize,
    observed: &Value,
) -> Option<Value> {
    let raw_options = observed.get("options").and_then(Value::as_array)?;
    let mut options = Vec::new();
    for (option_index, option) in raw_options.iter().enumerate() {
        let label = option.get("label").and_then(Value::as_str)?;
        let option_id = option
            .get("optionId")
            .and_then(Value::as_str)
            .map_or_else(|| format!("opt-{option_index}"), str::to_string);
        let unit_key = option.get("unitKey").and_then(Value::as_str);
        options.push(json!({
            "optionId": option_id,
            "label": label,
            "bridgeRef": observed_bridge_ref(source, unit_key),
        }));
    }
    if options.is_empty() {
        return None;
    }
    let unit_key = observed.get("unitKey").and_then(Value::as_str);
    Some(json!({
        "schemaVersion": FIXTURE_OBSERVATION_HOOK_SCHEMA_LITERAL,
        "eventId": observed_event_id(index),
        "observedAt": "2026-06-17T00:00:00.000Z",
        "eventKind": "choice",
        "runtimeTargetId": crate::runtime_target_id(source),
        "adapterId": crate::adapter_id_value(descriptor),
        "evidenceTier": EvidenceTier::E1.as_str(),
        "observationSource": OBSERVATION_SOURCE_LIVE_DOM,
        "environment": browser_environment_value(source),
        "sourceRevision": crate::source_revision_value(source),
        "bridgeRefs": [observed_bridge_ref(source, unit_key)],
        "redaction": {"status": "not_required"},
        "payload": {
            "payloadKind": "choice",
            "prompt": observed.get("prompt").and_then(Value::as_str),
            "options": options,
        },
    }))
}

/// A scene/map-transition observation hook event. RPG Maker MV/MZ drives play
/// through `SceneManager` scene changes (`Scene_Map`, `Scene_Battle`,...); the
/// live `Window_MapName` display name (`sceneName`) is a runtime-only string
/// that determines which message stream is active. Carried by the schema's
/// `ObservationScenePayload` (`payloadKind: "scene"`).
pub(super) fn observed_scene_hook_event(
    descriptor: &RuntimeAdapterDescriptor,
    source: &Value,
    index: usize,
    observed: &Value,
) -> Option<Value> {
    let scene_id = observed.get("sceneId").and_then(Value::as_str)?;
    let unit_key = observed.get("unitKey").and_then(Value::as_str);
    Some(json!({
        "schemaVersion": FIXTURE_OBSERVATION_HOOK_SCHEMA_LITERAL,
        "eventId": observed_event_id(index),
        "observedAt": "2026-06-17T00:00:00.000Z",
        "eventKind": "scene",
        "runtimeTargetId": crate::runtime_target_id(source),
        "adapterId": crate::adapter_id_value(descriptor),
        "evidenceTier": EvidenceTier::E1.as_str(),
        "observationSource": OBSERVATION_SOURCE_LIVE_DOM,
        "environment": browser_environment_value(source),
        "sourceRevision": crate::source_revision_value(source),
        "bridgeRefs": [observed_bridge_ref(source, unit_key)],
        "redaction": {"status": "not_required"},
        "payload": {
            "payloadKind": "scene",
            "sceneId": scene_id,
            "sceneName": observed.get("sceneName").and_then(Value::as_str),
        },
    }))
}

/// A conditional-branch/route observation hook event. RPG Maker MV/MZ routes
/// play through Conditional Branch (event command 111) and choice-driven jumps;
/// the branch `label`/`destination` actually `taken` at runtime is the
/// structural spine downstream context-building consumes. Carried by the
/// schema's `ObservationBranchPayload` (`payloadKind: "branch"`).
pub(super) fn observed_branch_hook_event(
    descriptor: &RuntimeAdapterDescriptor,
    source: &Value,
    index: usize,
    observed: &Value,
) -> Option<Value> {
    let branch_id = observed.get("branchId").and_then(Value::as_str)?;
    let unit_key = observed.get("unitKey").and_then(Value::as_str);
    Some(json!({
        "schemaVersion": FIXTURE_OBSERVATION_HOOK_SCHEMA_LITERAL,
        "eventId": observed_event_id(index),
        "observedAt": "2026-06-17T00:00:00.000Z",
        "eventKind": "branch",
        "runtimeTargetId": crate::runtime_target_id(source),
        "adapterId": crate::adapter_id_value(descriptor),
        "evidenceTier": EvidenceTier::E1.as_str(),
        "observationSource": OBSERVATION_SOURCE_LIVE_DOM,
        "environment": browser_environment_value(source),
        "sourceRevision": crate::source_revision_value(source),
        "bridgeRefs": [observed_bridge_ref(source, unit_key)],
        "redaction": {"status": "not_required"},
        "payload": {
            "payloadKind": "branch",
            "branchId": branch_id,
            "label": observed.get("label").and_then(Value::as_str),
            "destination": observed.get("destination").and_then(Value::as_str),
            "taken": observed.get("taken").and_then(Value::as_bool),
        },
    }))
}

pub(super) fn observed_trace_event(
    source: &Value,
    index: usize,
    observed: &Value,
) -> Option<Value> {
    let text = observed.get("text").and_then(Value::as_str)?;
    let unit_key = observed.get("unitKey").and_then(Value::as_str)?;
    Some(json!({
        "traceEventId": observed_trace_id(index),
        "eventKind": "text_observed",
        "bridgeUnitRef": observed_bridge_ref(source, Some(unit_key)),
        "frame": index + 1,
        "traceKey": unit_key,
        "observedText": text,
        "observationSource": OBSERVATION_SOURCE_LIVE_DOM,
    }))
}

pub(super) fn browser_environment_value(source: &Value) -> Value {
    json!({
        "runtime": "browser",
        "engine": "browser-smoke-fixture",
        "platform": env::consts::OS,
        "display": "browser-headless",
        "locale": source["sourceLocale"].as_str(),
    })
}
