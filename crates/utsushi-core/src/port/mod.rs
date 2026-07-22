//! Engine-port runner template ().
//!
//! This module is the engine-neutral substrate every Utsushi engine port
//! implements. The substrate defines:
//!
//! 1. [`PortManifest`] — a static, audit-grade declaration every port
//!    exposes as an associated `const`.
//! 2. [`EnginePort`] — the lifecycle trait (launch / observe / capture
//!    shutdown plus optional `jump`).
//! 3. [`Runner`] — orchestrates manifest validation, cancellation
//!    artifact-root containment, and observation re-validation.
//! 4. [`EnginePortAdapter`] — a bridge that lets an `EnginePort` register
//!    on the [`RuntimeAdapter`](crate::RuntimeAdapter) registry surface.
//! 5. [`conformance`] — the ABI conformance harness engine port crates
//!    use in their integration tests.
//!
//! See the plan in `.plan/.md` for the design rationale.

pub mod conformance;
pub mod diagnostics;
pub mod impl_map;
pub mod manifest;
pub mod parity;
pub mod runner;
mod runtime_adapter;
pub mod trait_;

pub use diagnostics::{
    CapabilityReason, DriftKind, EnginePortError, ManifestError, PortShutdownOutcome,
    PortShutdownStatus,
};
pub use impl_map::{
    CaptureMethod, EngineFamily, EvidenceKind, EvidenceRef, ExpectedOutcome, FixtureClassification,
    FixtureHashMismatch, FixtureKind, FixtureRef, FixtureStore, FixtureStoreError,
    IMPL_MAP_SCHEMA_VERSION, ImplMapError, ImplMapManifestMismatch, ImplementationMap,
    PortId as ImplMapPortId, ProvenanceField, ReferenceBehavior, ReferenceField,
    STATUS_VALIDATED_DISCLAIMER, Status as ImplMapStatus, Subsystem, SubsystemId, SubsystemStatus,
    UnsupportedReason, ValidationCommand, ValidationCommandId, ValidationReport, ValidationWarning,
    validate as validate_impl_map, validate_against_manifest as validate_impl_map_against_manifest,
    validate_and_promote as validate_and_promote_impl_map, verify_fixture_hashes,
};
pub use manifest::{
    EnvFieldSchema, EnvFieldShape, LifecycleStage, OPTIONAL_LIFECYCLE_STAGES, PortCapability,
    PortManifest, REQUIRED_LIFECYCLE_STAGES,
};
pub use parity::{
    CAPABILITY_CONTRACT, CapabilityDeclaration, CapabilityStance, EngineParityProfile, ParityError,
    ParityFailure, ParityGap, ParityGapKind, ParityPending, ParityReport, evaluate_parity,
};
pub use runner::{Runner, RunnerCancellation, RunnerObservation, RunnerOutcome};
pub use runtime_adapter::EnginePortAdapter;
pub use trait_::{CaptureOutcome, EnginePort, MomentId, PortEnv, PortRequest};

use serde_json::{Value, json};

use crate::{
    ApproximationTier, RuntimeAdapterDescriptor, RuntimeOperation, RuntimePlaybackFeature,
    UtsushiResult, validate_runtime_artifact_uri,
};

const ENGINE_PORT_REPORT_CREATED_AT: &str = "2026-06-17T00:00:00.000Z";

fn runner_outcome_to_value(
    outcome: &RunnerOutcome,
    operation: RuntimeOperation,
    descriptor: &RuntimeAdapterDescriptor,
) -> UtsushiResult<Value> {
    // Surface every drained sink emission as a typed JSON payload. The
    // engine-port adapter's wire form is "list of sink-shaped observations"
    // rather than a single hook-envelope; each entry
    // names the sink kind so downstream consumers can route on it without
    // running the full RuntimeEvidenceReportV02 validator.
    //
    // A serialization failure on any payload is propagated as a typed
    // error rather than silently dropping the observation: a dropped
    // payload would hide a real observation from the report.
    let mut observations = Vec::new();
    let mut observation_hook_events = Vec::new();
    let mut sequence = 1_u64;
    let bridge_unit_ref = json!({
        "bridgeUnitId": format!("{}-{}", outcome.manifest_id, operation.as_str()),
    });
    for (tick_index, tick) in outcome.observations.iter().enumerate() {
        for line in &tick.text {
            observations.push(json!({
                "sink": "text_surface",
                "payload": serde_json::to_value(line)?,
            }));
            observation_hook_events.push(json!({
                "schemaVersion": "0.1.0-alpha",
                "eventId": format!("{}-text-{}", outcome.manifest_id, line.line_id),
                "observedAt": ENGINE_PORT_REPORT_CREATED_AT,
                "eventKind": "text",
                "runtimeTargetId": outcome.manifest_id,
                "adapterId": {
                    "name": outcome.manifest_id,
                    "version": outcome.manifest_version,
                },
                "evidenceTier": line.evidence_tier.as_str(),
                "environment": {
                    "runtime": "engine-port",
                    "engine": outcome.manifest_id,
                },
                "bridgeRefs": observation_bridge_refs(line.bridge_ref.as_ref(), &bridge_unit_ref),
                "redaction": {
                    "status": "not_required",
                },
                "payload": {
                    "payloadKind": "text",
                    "text": line.text,
                    "speaker": line.speaker,
                    "textSurface": line.text_surface,
                },
            }));
            sequence += 1;
        }
        for frame in &tick.frames {
            observations.push(json!({
                "sink": "frame_artifact",
                "payload": serde_json::to_value(frame)?,
            }));
            observation_hook_events.push(json!({
                "schemaVersion": "0.1.0-alpha",
                "eventId": format!("{}-frame-{}", outcome.manifest_id, frame.frame_id),
                "observedAt": ENGINE_PORT_REPORT_CREATED_AT,
                "eventKind": "frame",
                "runtimeTargetId": outcome.manifest_id,
                "adapterId": {
                    "name": outcome.manifest_id,
                    "version": outcome.manifest_version,
                },
                "evidenceTier": frame.evidence_tier.as_str(),
                "environment": {
                    "runtime": "engine-port",
                    "engine": outcome.manifest_id,
                },
                "bridgeRefs": observation_bridge_refs(frame.bridge_ref.as_ref(), &bridge_unit_ref),
                "redaction": {
                    "status": "not_required",
                },
                "payload": {
                    "payloadKind": "frame",
                    "frame": frame.frame_index,
                    "width": frame.width,
                    "height": frame.height,
                    "artifactRef": {
                        "artifactId": frame.artifact_ref.artifact_id,
                        "artifactKind": frame.artifact_ref.artifact_kind,
                        "uri": frame.artifact_ref.uri,
                        "mediaType": frame.artifact_ref.media_type,
                    },
                },
            }));
            sequence += 1;
        }
        for event in &tick.audio {
            observations.push(json!({
                "sink": "audio_event",
                "payload": serde_json::to_value(event)?,
            }));
            observation_hook_events.push(json!({
                "schemaVersion": "0.1.0-alpha",
                "eventId": format!("{}-audio-{}", outcome.manifest_id, event.event_id),
                "observedAt": ENGINE_PORT_REPORT_CREATED_AT,
                "eventKind": "scene",
                "runtimeTargetId": outcome.manifest_id,
                "adapterId": {
                    "name": outcome.manifest_id,
                    "version": outcome.manifest_version,
                },
                "evidenceTier": event.evidence_tier.as_str(),
                "environment": {
                    "runtime": "engine-port",
                    "engine": outcome.manifest_id,
                },
                "bridgeRefs": observation_bridge_refs(event.bridge_ref.as_ref(), &bridge_unit_ref),
                "redaction": {
                    "status": "not_required",
                },
                "payload": {
                    "payloadKind": "scene",
                    "sceneId": event.event_id,
                    "sceneName": format!("audio:{}", event.event_kind.as_str()),
                },
            }));
            sequence += 1;
        }
        if tick.total() == 0 {
            observation_hook_events.push(lifecycle_observation_event(
                outcome,
                tick_index as u64,
                sequence,
                &bridge_unit_ref,
            ));
            sequence += 1;
        }
    }
    if observation_hook_events.is_empty() && outcome.capture.is_none() {
        observation_hook_events.push(lifecycle_observation_event(
            outcome,
            0,
            sequence,
            &bridge_unit_ref,
        ));
    }

    let mut evidence_tier = max_observation_evidence_tier(outcome);
    if outcome.capture.is_some() && evidence_tier < crate::EvidenceTier::E2 {
        evidence_tier = crate::EvidenceTier::E2;
    }
    if evidence_tier > descriptor.evidence_tier_ceiling {
        evidence_tier = descriptor.evidence_tier_ceiling;
    }
    if evidence_tier > descriptor.fidelity_tier.evidence_ceiling() {
        evidence_tier = descriptor.fidelity_tier.evidence_ceiling();
    }

    let captures = match outcome.capture.as_ref() {
        Some(capture) => {
            let artifact_id = runtime_artifact_id_from_uri(&capture.artifact_uri)?;
            vec![json!({
                "captureId": deterministic_uuid7(0x200),
                "bridgeUnitRef": bridge_unit_ref,
                "evidenceTier": crate::EvidenceTier::E2.as_str(),
                "frame": 0,
                "width": 1,
                "height": 1,
                "artifactRef": {
                    "artifactId": artifact_id,
                    "artifactKind": "screenshot",
                    "uri": capture.artifact_uri,
                    "mediaType": "image/png",
                },
                "artifactUri": capture.artifact_uri,
                "summary": capture.summary,
            })]
        }
        None => Vec::new(),
    };
    let approximation = json!({
        "approximationId": deterministic_uuid7(0x300),
        "approximationTier": ApproximationTier::EnginePartial.as_str(),
        "scope": "engine-port-adapter",
        "description": "Engine-port adapter report generated from substrate sink emissions and capture metadata.",
        "affectedBridgeUnitRefs": [bridge_unit_ref],
        "evidenceTierCeiling": evidence_tier.as_str(),
    });
    let session = crate::ControlledPlaybackSession {
        session_id: deterministic_uuid7(0x100),
        adapter_name: outcome.manifest_id.to_string(),
        adapter_version: outcome.manifest_version.to_string(),
        capability_class: descriptor.capability_contract.capability_class,
        requested_operation: operation,
        status: "passed".to_string(),
        fidelity_tier: descriptor.fidelity_tier,
        evidence_tier,
        features_used: features_used_for_report(
            operation,
            !observation_hook_events.is_empty(),
            outcome.capture.is_some(),
        ),
        limitations: descriptor.limitations.clone(),
    };
    let mut report = json!({
        "schemaVersion": "0.2.0",
        "runtimeReportId": deterministic_uuid7(1),
        "adapterName": outcome.manifest_id,
        "adapterVersion": outcome.manifest_version,
        "fidelityTier": descriptor.fidelity_tier.as_str(),
        "evidenceTier": evidence_tier.as_str(),
        "runtimeCapabilities": descriptor.capability_contract.to_json(),
        "controlledPlaybackSession": session.to_json(),
        "status": "passed",
        "createdAt": ENGINE_PORT_REPORT_CREATED_AT,
        "traceEvents": [],
        "branchEvents": [],
        "observationHookEvents": observation_hook_events,
        "captures": captures,
        "recordings": [],
        "approximations": [approximation],
        "validationFindings": [],
        "limitations": descriptor.limitations,
        "operation": operation.as_str(),
        "sinkObservations": observations,
        "shutdownStatus": match outcome.shutdown.status {
            PortShutdownStatus::Clean => "clean",
            PortShutdownStatus::AlreadyShutDown => "already_shut_down",
        },
    });
    prune_json_nulls(&mut report);
    Ok(report)
}

fn observation_bridge_refs(
    bridge_ref: Option<&crate::ObservationBridgeRef>,
    fallback: &Value,
) -> Value {
    match bridge_ref {
        Some(bridge_ref) => json!([bridge_ref]),
        None => json!([fallback]),
    }
}

fn lifecycle_observation_event(
    outcome: &RunnerOutcome,
    tick_index: u64,
    sequence: u64,
    bridge_unit_ref: &Value,
) -> Value {
    json!({
        "schemaVersion": "0.1.0-alpha",
        "eventId": format!("{}-lifecycle-{sequence}", outcome.manifest_id),
        "observedAt": ENGINE_PORT_REPORT_CREATED_AT,
        "eventKind": "scene",
        "runtimeTargetId": outcome.manifest_id,
        "adapterId": {
            "name": outcome.manifest_id,
            "version": outcome.manifest_version,
        },
        "evidenceTier": "E0",
        "environment": {
            "runtime": "engine-port",
            "engine": outcome.manifest_id,
        },
        "bridgeRefs": [bridge_unit_ref],
        "redaction": {
            "status": "not_required",
        },
        "payload": {
            "payloadKind": "scene",
            "sceneId": format!("engine-port-tick-{tick_index}"),
            "sceneName": "engine-port lifecycle",
        },
    })
}

fn max_observation_evidence_tier(outcome: &RunnerOutcome) -> crate::EvidenceTier {
    let mut tier = crate::EvidenceTier::E0;
    for tick in &outcome.observations {
        for line in &tick.text {
            tier = tier.max(line.evidence_tier);
        }
        for frame in &tick.frames {
            tier = tier.max(frame.evidence_tier);
        }
        for event in &tick.audio {
            tier = tier.max(event.evidence_tier);
        }
    }
    tier
}

fn features_used_for_report(
    operation: RuntimeOperation,
    has_observation_hooks: bool,
    has_capture: bool,
) -> Vec<RuntimePlaybackFeature> {
    let mut features = Vec::new();

    if matches!(
        operation,
        RuntimeOperation::Capture | RuntimeOperation::SmokeValidation
    ) && has_capture
    {
        features.push(RuntimePlaybackFeature::FrameCapture);
    }
    if matches!(operation, RuntimeOperation::BranchDiscovery) {
        features.push(RuntimePlaybackFeature::BranchDiscovery);
    }
    if matches!(operation, RuntimeOperation::ReplayReview) {
        features.push(RuntimePlaybackFeature::Recording);
    }
    if has_observation_hooks {
        features.push(RuntimePlaybackFeature::InstrumentationHooks);
    }
    features
}

fn deterministic_uuid7(sequence: u64) -> String {
    format!("0190a000-0000-7000-8000-{sequence:012x}")
}

fn runtime_artifact_id_from_uri(uri: &str) -> UtsushiResult<String> {
    let relative = validate_runtime_artifact_uri(uri)?;
    let filename = relative
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| format!("runtime artifact uri is missing a filename: {uri}"))?;
    let Some((artifact_id, _extension)) = filename.rsplit_once('.') else {
        return Err(format!("runtime artifact uri filename is missing an extension: {uri}").into());
    };
    if artifact_id.is_empty() {
        return Err(
            format!("runtime artifact uri filename is missing an artifact id: {uri}").into(),
        );
    }
    Ok(artifact_id.to_string())
}

fn prune_json_nulls(value: &mut Value) {
    match value {
        Value::Object(object) => {
            object.retain(|_, child| {
                prune_json_nulls(child);
                !child.is_null()
            });
        }
        Value::Array(values) => {
            for child in values {
                prune_json_nulls(child);
            }
        }
        _ => {}
    }
}

#[cfg(test)]
#[path = "port_tests.rs"]
mod tests;
