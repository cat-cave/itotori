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
    RuntimeOperation, RuntimePlaybackFeature, RuntimeRequest, UtsushiResult, runtime_artifact_uri,
};

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

        runner_outcome_to_value(&runner_outcome, operation)
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
    let capabilities = manifest
        .capabilities
        .iter()
        .copied()
        .filter_map(port_capability_to_runtime_capability)
        .collect::<Vec<_>>();
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

fn port_capability_to_runtime_capability(capability: PortCapability) -> Option<RuntimeCapability> {
    match capability {
        PortCapability::Observe => Some(RuntimeCapability::Trace),
        PortCapability::Capture => Some(RuntimeCapability::FrameCapture),
        PortCapability::Jump => Some(RuntimeCapability::ReplayReview),
        PortCapability::Launch
        | PortCapability::Shutdown
        | PortCapability::Snapshot
        | PortCapability::DeterministicReplay => None,
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
    for tick in &outcome.observations {
        for line in &tick.text {
            observations.push(json!({
                "sink": "text_surface",
                "payload": serde_json::to_value(line)?,
            }));
        }
        for frame in &tick.frames {
            observations.push(json!({
                "sink": "frame_artifact",
                "payload": serde_json::to_value(frame)?,
            }));
        }
        for event in &tick.audio {
            observations.push(json!({
                "sink": "audio_event",
                "payload": serde_json::to_value(event)?,
            }));
        }
    }
    let captures = outcome
        .capture
        .as_ref()
        .map(|capture| {
            vec![json!({
                "artifactUri": capture.artifact_uri,
                "summary": capture.summary,
            })]
        })
        .unwrap_or_default();
    Ok(json!({
        "schemaVersion": "0.2.0",
        "runtimeReportId": runtime_artifact_uri(outcome.manifest_id, crate::RuntimeArtifactKind::TraceLog, "engine-port-run")
            .ok(),
        "adapterName": outcome.manifest_id,
        "adapterVersion": outcome.manifest_version,
        "operation": operation.as_str(),
        "sinkObservations": observations,
        "captures": captures,
        "shutdownStatus": match outcome.shutdown.status {
            PortShutdownStatus::Clean => "clean",
            PortShutdownStatus::AlreadyShutDown => "already_shut_down",
        },
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::EvidenceTier;
    use crate::sink::{AudioEvent, AudioEventKind, TextLine};

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
        let value = runner_outcome_to_value(&outcome, RuntimeOperation::Trace)
            .expect("serialisable sink payloads must map to Ok");
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
}
