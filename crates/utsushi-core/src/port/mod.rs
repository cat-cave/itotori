//! Engine-port runner template (UTSUSHI-103).
//!
//! This module is the engine-neutral substrate every Utsushi engine port
//! implements. The substrate defines:
//!
//! 1. [`PortManifest`] — a static, audit-grade declaration every port
//!    exposes as an associated `const`.
//! 2. [`EnginePort`] — the lifecycle trait (launch / observe / capture /
//!    shutdown plus optional `jump`).
//! 3. [`Runner`] — orchestrates manifest validation, cancellation,
//!    artifact-root containment, and observation re-validation.
//! 4. [`EnginePortAdapter`] — a bridge that lets an `EnginePort` register
//!    on the [`RuntimeAdapter`](crate::RuntimeAdapter) registry surface.
//! 5. [`conformance`] — the ABI conformance harness engine port crates
//!    use in their integration tests.
//!
//! See the plan in `.plan/UTSUSHI-103.md` for the design rationale.

pub mod conformance;
pub mod diagnostics;
pub mod impl_map;
pub mod manifest;
pub mod parity;
pub mod runner;
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
pub use trait_::{CaptureOutcome, EnginePort, MomentId, PortEnv, PortRequest};

use std::sync::Mutex;

use serde_json::{Value, json};

use crate::{
    ApproximationTier, RuntimeAdapter, RuntimeAdapterDescriptor, RuntimeArtifactRoot,
    RuntimeCapability, RuntimeCapabilityClass, RuntimeCapabilityContract, RuntimeFeatureSupport,
    RuntimeOperation, RuntimePlaybackFeature, RuntimeRequest, UtsushiResult,
    validate_runtime_artifact_uri,
};

const ENGINE_PORT_REPORT_CREATED_AT: &str = "2026-06-17T00:00:00.000Z";

/// Bridge that lets an `EnginePort` register on the
/// `RuntimeAdapterRegistry`. It hides the port's generic parameter behind
/// the `dyn RuntimeAdapter` object and serialises access through a `Mutex`
/// so multiple `RuntimeAdapter` calls can share one port instance.
pub struct EnginePortAdapter<P: EnginePort + 'static> {
    port: Mutex<P>,
    runner: Runner,
    descriptor: RuntimeAdapterDescriptor,
}

impl<P: EnginePort + 'static> EnginePortAdapter<P> {
    /// Build a new adapter. Validates the manifest up-front so a port
    /// with a malformed manifest never makes it into the registry.
    pub fn new(port: P) -> Result<Self, EnginePortError> {
        let runner = Runner::new();
        runner.validate_manifest(&P::MANIFEST)?;
        let descriptor = descriptor_from_manifest(&P::MANIFEST);
        Ok(Self {
            port: Mutex::new(port),
            runner,
            descriptor,
        })
    }

    pub fn manifest(&self) -> &PortManifest {
        // Read the const through the type to avoid storing a copy.
        &P::MANIFEST
    }

    fn run_lifecycle(
        &self,
        request: &RuntimeRequest<'_>,
        operation: RuntimeOperation,
    ) -> UtsushiResult<Value> {
        // A poisoned lock carries a `PoisonError<MutexGuard<'_, _>>` whose guard
        // borrows the mutex, so it is not `'static` and cannot be boxed
        // directly; re-stringify into the boxed `UtsushiResult` boundary.
        let mut port = self
            .port
            .lock()
            .map_err(|error| format!("engine port lock poisoned: {error}"))?;
        let run_id = format!("{}-{}", P::MANIFEST.id, operation.as_str());
        let cancellation = request.cancellation.clone().unwrap_or_default();
        // The `RuntimeAdapter` surface carries the artifact root as a raw
        // `&Path`; the port lifecycle works against the managed
        // `RuntimeArtifactRoot` so capture output is contained and
        // audit-validated. Wrap the path and prepare the managed root here so
        // the port receives a fully managed root — the same idiom every other
        // `RuntimeAdapter` implementation uses. When no artifact root is
        // supplied the managed root stays `None` and the runner fails closed on
        // Capture/SmokeValidation with `EnginePortError::ArtifactRootMissing`.
        let managed_artifact_root = match request.artifact_root {
            Some(path) => {
                let root = RuntimeArtifactRoot::new(path);
                root.prepare()?;
                Some(root)
            }
            None => None,
        };
        let mut port_request = PortRequest::new(request.input_root, &run_id, operation)
            .with_cancellation(cancellation);
        if let Some(vfs) = request.vfs.clone() {
            port_request = port_request.with_vfs(vfs);
        }
        if let Some(root) = managed_artifact_root.as_ref() {
            port_request = port_request.with_artifact_root(root);
        }
        let runner_outcome = match operation {
            RuntimeOperation::Trace => self.runner.run_trace(&mut *port, &port_request),
            RuntimeOperation::Capture => self.runner.run_capture(&mut *port, &port_request),
            RuntimeOperation::SmokeValidation => self.runner.run_smoke(&mut *port, &port_request),
            RuntimeOperation::BranchDiscovery => {
                return Err(format!(
                    "engine port adapter {} does not support {}",
                    self.descriptor.name,
                    RuntimeOperation::BranchDiscovery.as_str()
                )
                .into());
            }
        }?;

        runner_outcome_to_value(&runner_outcome, operation, &self.descriptor)
    }
}

impl<P: EnginePort + 'static> RuntimeAdapter for EnginePortAdapter<P> {
    fn descriptor(&self) -> RuntimeAdapterDescriptor {
        self.descriptor.clone()
    }

    fn trace(&self, request: &RuntimeRequest<'_>) -> UtsushiResult<Value> {
        self.run_lifecycle(request, RuntimeOperation::Trace)
    }

    fn capture(&self, request: &RuntimeRequest<'_>) -> UtsushiResult<Value> {
        self.run_lifecycle(request, RuntimeOperation::Capture)
    }

    fn smoke_validate(&self, request: &RuntimeRequest<'_>) -> UtsushiResult<Value> {
        self.run_lifecycle(request, RuntimeOperation::SmokeValidation)
    }
}

fn descriptor_from_manifest(manifest: &PortManifest) -> RuntimeAdapterDescriptor {
    let mut capabilities = Vec::new();
    for capability in manifest.capabilities {
        match capability {
            PortCapability::Observe => capabilities.push(RuntimeCapability::Trace),
            PortCapability::Capture => {
                capabilities.push(RuntimeCapability::FrameCapture);
                capabilities.push(RuntimeCapability::SmokeValidation);
            }
            PortCapability::Jump => capabilities.push(RuntimeCapability::ReplayReview),
            PortCapability::Launch
            | PortCapability::Shutdown
            | PortCapability::Snapshot
            | PortCapability::DeterministicReplay => {}
        }
    }
    let capability_class = derive_capability_class(manifest);
    let capability_contract = derive_capability_contract(manifest, capability_class);
    RuntimeAdapterDescriptor {
        name: manifest.id.to_string(),
        version: manifest.version.to_string(),
        fidelity_tier: manifest.fidelity_tier_max,
        evidence_tier_ceiling: manifest.evidence_tier_max,
        capability_contract,
        capabilities,
        approximation_tiers: vec![ApproximationTier::None],
        diagnostics: Vec::new(),
        limitations: manifest
            .limitations
            .iter()
            .map(std::string::ToString::to_string)
            .collect(),
    }
}

fn derive_capability_class(manifest: &PortManifest) -> RuntimeCapabilityClass {
    match manifest.fidelity_tier_max {
        crate::FidelityTier::TraceOnly => RuntimeCapabilityClass::StaticTrace,
        crate::FidelityTier::LayoutProbe => RuntimeCapabilityClass::LaunchCapture,
        crate::FidelityTier::ReplayReview => RuntimeCapabilityClass::InstrumentedRuntime,
        crate::FidelityTier::ReferenceFidelity => RuntimeCapabilityClass::ReferenceVm,
    }
}

fn derive_capability_contract(
    manifest: &PortManifest,
    capability_class: RuntimeCapabilityClass,
) -> RuntimeCapabilityContract {
    let mut features = Vec::new();
    // Translate manifest capabilities into the RuntimeFeatureSupport list.
    // The mapping is mechanical; engine crates that need a richer narrative
    // build their descriptor directly rather than through this bridge.
    if manifest.capabilities.contains(&PortCapability::Observe) {
        features.push(RuntimeFeatureSupport::supported(
            RuntimePlaybackFeature::StaticTrace,
            manifest.evidence_tier_max,
            "Engine port emits observation hook events through the substrate runner.",
        ));
        features.push(RuntimeFeatureSupport::supported(
            RuntimePlaybackFeature::InstrumentationHooks,
            manifest.evidence_tier_max,
            "Engine port participates in the manifest-driven observation envelope.",
        ));
    }
    if manifest.capabilities.contains(&PortCapability::Launch) {
        features.push(RuntimeFeatureSupport::supported(
            RuntimePlaybackFeature::Launch,
            manifest.evidence_tier_max,
            "Engine port honours the runner's launch lifecycle.",
        ));
    }
    if manifest.capabilities.contains(&PortCapability::Capture) {
        features.push(RuntimeFeatureSupport::supported(
            RuntimePlaybackFeature::FrameCapture,
            manifest.evidence_tier_max,
            "Engine port produces capture artifacts under the managed runtime root.",
        ));
    }
    if !manifest.capabilities.contains(&PortCapability::Jump) {
        features.push(RuntimeFeatureSupport::unsupported(
            RuntimePlaybackFeature::Jump,
            "Engine port does not declare the Jump capability in its manifest.",
        ));
    }
    RuntimeCapabilityContract::new(
        capability_class,
        manifest.fidelity_tier_max,
        manifest.evidence_tier_max,
        features,
        manifest
            .limitations
            .iter()
            .map(std::string::ToString::to_string)
            .collect(),
    )
}

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
mod tests {
    use super::*;
    use crate::EvidenceTier;
    use crate::sink::{AudioEvent, AudioEventKind, TextLine};
    use crate::validate_runtime_evidence_report_value;

    fn sample_text_line() -> TextLine {
        TextLine {
            line_id: "line-001".to_string(),
            evidence_tier: EvidenceTier::E1,
            text: "hello".to_string(),
            speaker: None,
            color: None,
            text_surface: None,
            bridge_ref: None,
            source_asset: None,
        }
    }

    fn sample_audio_event() -> AudioEvent {
        AudioEvent {
            event_id: "audio-001".to_string(),
            evidence_tier: EvidenceTier::E0,
            event_kind: AudioEventKind::BgmStart,
            cue_id: None,
            source_asset: None,
            bridge_ref: None,
            frame_index: None,
        }
    }

    #[test]
    fn runner_outcome_to_value_surfaces_every_sink_payload_without_dropping() {
        let outcome = RunnerOutcome {
            manifest_id: "utsushi-test-port",
            manifest_version: "0.0.0",
            observations: vec![RunnerObservation {
                text: vec![sample_text_line()],
                frames: Vec::new(),
                audio: vec![sample_audio_event()],
            }],
            capture: None,
            shutdown: PortShutdownOutcome::clean(),
        };

        // The mapper now returns a typed Result and propagates any
        // serialization failure instead of silently dropping a payload.
        let descriptor = RuntimeAdapterDescriptor {
            name: outcome.manifest_id.to_string(),
            version: outcome.manifest_version.to_string(),
            fidelity_tier: crate::FidelityTier::TraceOnly,
            evidence_tier_ceiling: EvidenceTier::E1,
            capability_contract: RuntimeCapabilityContract::new(
                RuntimeCapabilityClass::StaticTrace,
                crate::FidelityTier::TraceOnly,
                EvidenceTier::E1,
                vec![RuntimeFeatureSupport::supported(
                    RuntimePlaybackFeature::InstrumentationHooks,
                    EvidenceTier::E1,
                    "Synthetic test hook support.",
                )],
                Vec::new(),
            ),
            capabilities: vec![RuntimeCapability::Trace],
            approximation_tiers: vec![ApproximationTier::EnginePartial],
            diagnostics: Vec::new(),
            limitations: Vec::new(),
        };
        let value = runner_outcome_to_value(&outcome, RuntimeOperation::Trace, &descriptor)
            .expect("serialisable sink payloads must map to Ok");
        validate_runtime_evidence_report_value(&value)
            .expect("adapter report must satisfy RuntimeEvidenceReportV02");
        let observations = value["sinkObservations"]
            .as_array()
            .expect("sinkObservations array");
        // Both the text and the audio payload must surface; a dropped
        // observation would hide a real emission from the report.
        assert_eq!(observations.len(), 2);
        assert!(
            observations
                .iter()
                .any(|entry| entry["sink"] == "text_surface")
        );
        assert!(
            observations
                .iter()
                .any(|entry| entry["sink"] == "audio_event")
        );
    }

    #[test]
    fn features_used_for_report_reports_only_observed_runtime_features() {
        assert_eq!(
            features_used_for_report(RuntimeOperation::Trace, false, false),
            Vec::<RuntimePlaybackFeature>::new()
        );
        assert_eq!(
            features_used_for_report(RuntimeOperation::Trace, true, false),
            vec![RuntimePlaybackFeature::InstrumentationHooks]
        );
        assert_eq!(
            features_used_for_report(RuntimeOperation::Capture, true, true),
            vec![
                RuntimePlaybackFeature::FrameCapture,
                RuntimePlaybackFeature::InstrumentationHooks
            ]
        );
        assert_eq!(
            features_used_for_report(RuntimeOperation::SmokeValidation, false, false),
            Vec::<RuntimePlaybackFeature>::new()
        );
        assert_eq!(
            features_used_for_report(RuntimeOperation::BranchDiscovery, false, true),
            vec![RuntimePlaybackFeature::BranchDiscovery]
        );
    }
}
