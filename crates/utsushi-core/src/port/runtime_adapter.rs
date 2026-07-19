//! Legacy `RuntimeAdapter` bridge for manifest-driven engine ports.

use std::sync::Mutex;

use serde_json::Value;

use crate::{
    ApproximationTier, RuntimeAdapter, RuntimeAdapterDescriptor, RuntimeArtifactRoot,
    RuntimeCapability, RuntimeCapabilityClass, RuntimeCapabilityContract, RuntimeFeatureSupport,
    RuntimeOperation, RuntimePlaybackFeature, RuntimeRequest, UtsushiResult,
};

use super::{
    CapabilityReason, EnginePort, EnginePortError, PortCapability, PortManifest, PortRequest,
    Runner, runner_outcome_to_value,
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

    /// Inspect the concrete port after a lifecycle run without exposing the
    /// adapter's mutex or allowing callers to bypass the runner. Operation
    /// adapters use this to retrieve evidence produced by the validated run.
    pub fn with_port<R>(&self, inspect: impl FnOnce(&P) -> R) -> UtsushiResult<R> {
        let port = self
            .port
            .lock()
            .map_err(|error| format!("engine port lock poisoned: {error}"))?;
        Ok(inspect(&*port))
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
        // The typed managed root is the containment capability handed to the
        // runner. The legacy raw path remains a compatibility fallback for
        // existing `RuntimeAdapter` callers, but never replaces a supplied
        // managed root (which may carry policy such as a soft byte budget).
        let legacy_managed_artifact_root = if request.managed_artifact_root.is_none() {
            request.artifact_root.map(RuntimeArtifactRoot::new)
        } else {
            None
        };
        let artifact_root = request
            .managed_artifact_root
            .or(legacy_managed_artifact_root.as_ref());
        if let Some(root) = artifact_root {
            root.prepare()?;
        }

        let mut port_request = PortRequest::new(request.input_root, &run_id, operation)
            .with_cancellation(cancellation);
        if let Some(vfs) = request.vfs.clone() {
            port_request = port_request.with_vfs(vfs);
        }
        if let Some(root) = artifact_root {
            port_request = port_request.with_artifact_root(root);
        }
        let runner_outcome = match operation {
            RuntimeOperation::Trace => self.runner.run_trace(&mut *port, &port_request),
            RuntimeOperation::Capture => self.runner.run_capture(&mut *port, &port_request),
            RuntimeOperation::SmokeValidation => self.runner.run_smoke(&mut *port, &port_request),
            RuntimeOperation::ReplayReview => {
                if !P::MANIFEST
                    .capabilities
                    .contains(&PortCapability::ReplayReview)
                {
                    return Err(EnginePortError::CapabilityUnsupported {
                        capability: PortCapability::ReplayReview,
                        reason: CapabilityReason::NotYetSupported,
                    }
                    .into());
                }
                self.runner.run_replay_review(&mut *port, &port_request)
            }
            RuntimeOperation::BranchDiscovery => {
                return Err(EnginePortError::AdapterOperationUnsupported { operation }.into());
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

    fn discover_branches(&self, request: &RuntimeRequest<'_>) -> UtsushiResult<Value> {
        self.run_lifecycle(request, RuntimeOperation::BranchDiscovery)
    }

    fn capture(&self, request: &RuntimeRequest<'_>) -> UtsushiResult<Value> {
        self.run_lifecycle(request, RuntimeOperation::Capture)
    }

    fn smoke_validate(&self, request: &RuntimeRequest<'_>) -> UtsushiResult<Value> {
        self.run_lifecycle(request, RuntimeOperation::SmokeValidation)
    }

    fn replay_review(&self, request: &RuntimeRequest<'_>) -> UtsushiResult<Value> {
        self.run_lifecycle(request, RuntimeOperation::ReplayReview)
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
            PortCapability::ReplayReview => capabilities.push(RuntimeCapability::ReplayReview),
            PortCapability::Jump
            | PortCapability::Launch
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
    if manifest
        .capabilities
        .contains(&PortCapability::ReplayReview)
    {
        features.push(RuntimeFeatureSupport::supported(
            RuntimePlaybackFeature::Recording,
            manifest.evidence_tier_max,
            "Engine port exposes deterministic replay-review evidence through the runner bridge.",
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
