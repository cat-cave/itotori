//! Browser launch runtime report builders.

use serde_json::{Value, json};
use utsushi_core::{
    ApproximationTier, ControlledPlaybackSession, EvidenceTier, FidelityTier,
    RuntimeAdapterDescriptor, RuntimeCapturedArtifact, RuntimeOperation, RuntimePlaybackFeature,
    UtsushiResult,
};

use super::observe::browser_environment_value;
use super::{
    BROWSER_APPROXIMATION_ID, BROWSER_CAPTURE_ID, BROWSER_OBSERVATION_FRAME_ID,
    BROWSER_OBSERVATION_TEXT_ID, BROWSER_RUN_ID, BROWSER_SESSION_ID, BROWSER_TRACE_ID,
    BROWSER_VIEWPORT_HEIGHT, BROWSER_VIEWPORT_WIDTH, OBSERVATION_SOURCE_FIXTURE_DECLARED,
};
use crate::FIXTURE_OBSERVATION_HOOK_SCHEMA_LITERAL;

pub(super) struct BrowserReportInput {
    pub(super) operation: RuntimeOperation,
    pub(super) fidelity_tier: FidelityTier,
    pub(super) evidence_tier: EvidenceTier,
    pub(super) trace_events: Vec<Value>,
    pub(super) observation_events: Vec<Value>,
    pub(super) captures: Vec<Value>,
    pub(super) elapsed_millis: u128,
    pub(super) launch_target: String,
    pub(super) limitation: &'static str,
}

pub(super) fn browser_runtime_report(
    descriptor: &RuntimeAdapterDescriptor,
    source: &Value,
    input: BrowserReportInput,
) -> Value {
    let BrowserReportInput {
        operation,
        fidelity_tier,
        evidence_tier,
        trace_events,
        observation_events,
        captures,
        elapsed_millis,
        launch_target,
        limitation,
    } = input;
    let affected_bridge_unit_refs = trace_events
        .iter()
        .filter_map(|event| event.get("bridgeUnitRef").cloned())
        .collect::<Vec<_>>();
    let mut limitations = descriptor.limitations.clone();
    limitations.push(limitation.to_string());
    limitations.push(format!(
        "Browser launch target was recorded as repository-relative fixture entrypoint {launch_target}; raw local paths are omitted from report metadata."
    ));
    limitations.push(format!(
        "Browser launch completed in {elapsed_millis} ms under the core bounded process harness."
    ));

    // Only claim a layout-probe approximation when the launch actually
    // observed bridge-linked runtime events. A launch that produced no
    // instrumented DOM (the strict-proof negative control) makes no
    // approximation claim rather than an empty, invalid one.
    let approximations = if affected_bridge_unit_refs.is_empty() {
        Vec::new()
    } else {
        vec![json!({
            "approximationId": BROWSER_APPROXIMATION_ID,
            "approximationTier": ApproximationTier::LayoutProbe.as_str(),
            "scope": "browser launch adapter",
            "description": "Browser launch/capture proves bounded entrypoint reachability and screenshot production, but not RPG Maker scene instrumentation or reference-runtime fidelity.",
            "affectedBridgeUnitRefs": affected_bridge_unit_refs,
            "evidenceTierCeiling": evidence_tier.as_str()
        })]
    };

    json!({
        "schemaVersion": "0.2.0",
        "runtimeReportId": BROWSER_RUN_ID,
        "sourceLocale": source["sourceLocale"].as_str().unwrap_or("und"),
        "adapterName": descriptor.name,
        "adapterVersion": descriptor.version,
        "fidelityTier": fidelity_tier.as_str(),
        "evidenceTier": evidence_tier.as_str(),
        "runtimeCapabilities": descriptor.capability_contract.to_json(),
        "controlledPlaybackSession": ControlledPlaybackSession {
            session_id: BROWSER_SESSION_ID.to_string(),
            adapter_name: descriptor.name.clone(),
            adapter_version: descriptor.version.clone(),
            capability_class: descriptor.capability_contract.capability_class,
            requested_operation: operation,
            status: "passed".to_string(),
            fidelity_tier,
            evidence_tier,
            features_used: browser_features_used(operation),
            limitations: limitations.clone(),
        }.to_json(),
        "status": "passed",
        "createdAt": "2026-06-17T00:00:00.000Z",
        "traceEvents": trace_events,
        "observationHookEvents": observation_events,
        "branchEvents": [],
        "captures": captures,
        "recordings": [],
        "approximations": approximations,
        "validationFindings": [],
        "referenceComparisons": [],
        "limitations": limitations
    })
}

pub(super) fn browser_text_observation_hook_event(
    descriptor: &RuntimeAdapterDescriptor,
    source: &Value,
    unit: &Value,
    evidence_tier: EvidenceTier,
) -> UtsushiResult<Value> {
    let bridge_ref_value = crate::observation_bridge_ref_value(unit, 1)?;
    Ok(json!({
        "schemaVersion": FIXTURE_OBSERVATION_HOOK_SCHEMA_LITERAL,
        "eventId": BROWSER_OBSERVATION_TEXT_ID,
        "observedAt": "2026-06-17T00:00:00.000Z",
        "eventKind": "text",
        "runtimeTargetId": crate::runtime_target_id(source),
        "adapterId": crate::adapter_id_value(descriptor),
        "evidenceTier": evidence_tier.as_str(),
        "observationSource": OBSERVATION_SOURCE_FIXTURE_DECLARED,
        "environment": browser_environment_value(source),
        "sourceRevision": crate::source_revision_value(source),
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

pub(super) fn browser_frame_observation_hook_event(
    descriptor: &RuntimeAdapterDescriptor,
    source: &Value,
    unit: &Value,
    screenshot: &RuntimeCapturedArtifact,
) -> UtsushiResult<Value> {
    let bridge_ref_value = crate::observation_bridge_ref_value(unit, 1)?;
    Ok(json!({
        "schemaVersion": FIXTURE_OBSERVATION_HOOK_SCHEMA_LITERAL,
        "eventId": BROWSER_OBSERVATION_FRAME_ID,
        "observedAt": "2026-06-17T00:00:00.000Z",
        "eventKind": "frame",
        "runtimeTargetId": crate::runtime_target_id(source),
        "adapterId": crate::adapter_id_value(descriptor),
        "evidenceTier": EvidenceTier::E2.as_str(),
        "environment": browser_environment_value(source),
        "sourceRevision": crate::source_revision_value(source),
        "bridgeRefs": [bridge_ref_value],
        "redaction": {"status": "not_required"},
        "payload": {
            "payloadKind": "frame",
            "frame": 1,
            "width": BROWSER_VIEWPORT_WIDTH,
            "height": BROWSER_VIEWPORT_HEIGHT,
            "artifactRef": screenshot.artifact_ref_json(),
        },
    }))
}

pub(super) fn browser_features_used(operation: RuntimeOperation) -> Vec<RuntimePlaybackFeature> {
    match operation {
        RuntimeOperation::Trace => {
            vec![
                RuntimePlaybackFeature::Launch,
                RuntimePlaybackFeature::TextTrace,
                RuntimePlaybackFeature::InstrumentationHooks,
            ]
        }
        RuntimeOperation::Capture | RuntimeOperation::SmokeValidation => {
            vec![
                RuntimePlaybackFeature::Launch,
                RuntimePlaybackFeature::TextTrace,
                RuntimePlaybackFeature::Screenshot,
                RuntimePlaybackFeature::FrameCapture,
                RuntimePlaybackFeature::InstrumentationHooks,
            ]
        }
        RuntimeOperation::BranchDiscovery => vec![RuntimePlaybackFeature::BranchDiscovery],
        RuntimeOperation::ReplayReview => vec![RuntimePlaybackFeature::Recording],
    }
}

pub(super) fn browser_trace_event(unit: &Value) -> UtsushiResult<Value> {
    Ok(json!({
        "traceEventId": BROWSER_TRACE_ID,
        "eventKind": "text_observed",
        "bridgeUnitRef": crate::bridge_unit_ref(unit, 1)?,
        "frame": 1,
        "traceKey": crate::require_str(unit, "sourceUnitKey")?,
        "observedText": unit["targetText"]
            .as_str()
            .or_else(|| unit["sourceText"].as_str())
            .unwrap_or("")
    }))
}

pub(super) fn browser_capture_event(
    unit: &Value,
    screenshot: &RuntimeCapturedArtifact,
) -> UtsushiResult<Value> {
    Ok(json!({
        "captureId": BROWSER_CAPTURE_ID,
        "bridgeUnitRef": crate::bridge_unit_ref(unit, 1)?,
        "evidenceTier": EvidenceTier::E2.as_str(),
        "frame": 1,
        "width": BROWSER_VIEWPORT_WIDTH,
        "height": BROWSER_VIEWPORT_HEIGHT,
        "artifactRef": screenshot.artifact_ref_json()
    }))
}
