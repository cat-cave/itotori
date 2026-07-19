use std::path::Path;
use std::sync::Arc;

use serde_json::Value;

use crate::{
    ApproximationTier, EvidenceTier, FidelityTier, ReplayLog, RunnerCancellation,
    RuntimeArtifactRoot, RuntimeCapability, RuntimeCapabilityContract, RuntimeVfs, SnapshotRef,
    UtsushiResult,
};

#[derive(Clone)]
pub struct RuntimeRequest<'a> {
    pub input_root: &'a Path,
    /// Legacy raw capture-root path. Prefer [`Self::managed_artifact_root`]
    /// for code that needs the managed-root capability.
    pub artifact_root: Option<&'a Path>,
    /// Managed artifact root for ports that need runner-enforced capture
    /// containment. When present, this takes precedence over the legacy raw
    /// [`Self::artifact_root`] path.
    pub managed_artifact_root: Option<&'a RuntimeArtifactRoot>,
    /// Optional operation-specific parameters for registry-routed extension
    /// operations. Core trace/capture/smoke paths ignore this field.
    pub parameters: Option<Value>,
    /// Optional, additive handoff for downstream nodes that consume the
    /// runtime VFS (). Slice A of
    /// only adds the field so callers can begin to populate it.
    pub vfs: Option<Arc<dyn RuntimeVfs>>,
    /// Optional, additive handoff for the deterministic replay log
    /// (). When `Some`, an adapter that drives input MUST consume
    /// events through `ReplayLog::next_event` instead of querying live input.
    /// `Arc<ReplayLog>` keeps cloning cheap when the runner shares the log
    /// across multiple adapter invocations.
    pub replay: Option<Arc<ReplayLog>>,
    /// Cancellation token. The `EnginePortAdapter` bridge forwards this
    /// into `EnginePort::launch`/`observe`/`capture` so a long-running
    /// port honours cooperative cancellation; adapters that do not run a
    /// cancellable loop ignore the field.
    pub cancellation: Option<RunnerCancellation>,
    /// Optional snapshot anchor (). When `Some`, the runner is
    /// being asked to restore the snapshot at `start` and replay from the
    /// matching anchor. The reference is intentionally lightweight
    /// (id-only, no payload); the full [`Snapshot`] is resolved by the
    /// runner through the [`SnapshotStore`] trait (). The
    /// trait has typed errors only — `NotFound`
    /// `MismatchedSchemaVersion`, `InvalidSnapshotRef`
    /// `InspectableIdMismatch`, `StoreUnavailable` — so an adapter
    /// receiving this field can rely on the runner having resolved the
    /// ref through a single audit seam. Adapters that do not consume
    /// snapshots ignore the field.
    pub snapshot: Option<SnapshotRef>,
}

impl std::fmt::Debug for RuntimeRequest<'_> {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("RuntimeRequest")
            .field("input_root", &self.input_root)
            .field("artifact_root", &self.artifact_root)
            .field(
                "managed_artifact_root",
                &self.managed_artifact_root.map(RuntimeArtifactRoot::path),
            )
            .field("parameters", &self.parameters)
            .field("vfs", &self.vfs.as_ref().map(|_| "Arc<dyn RuntimeVfs>"))
            .field("replay", &self.replay.as_ref().map(|_| "Arc<ReplayLog>"))
            .field(
                "cancellation",
                &self.cancellation.as_ref().map(|_| "RunnerCancellation"),
            )
            .field(
                "snapshot",
                &if self.snapshot.is_some() {
                    "<present>"
                } else {
                    "<absent>"
                },
            )
            .finish()
    }
}

impl<'a> RuntimeRequest<'a> {
    pub fn new(input_root: &'a Path) -> Self {
        Self {
            input_root,
            artifact_root: None,
            managed_artifact_root: None,
            parameters: None,
            vfs: None,
            replay: None,
            cancellation: None,
            snapshot: None,
        }
    }

    pub fn with_artifact_root(mut self, artifact_root: &'a Path) -> Self {
        self.artifact_root = Some(artifact_root);
        self
    }

    /// Supply the managed artifact-root capability used by an
    /// [`crate::EnginePortAdapter`]. The legacy raw-path field remains
    /// available for existing `RuntimeAdapter` callers.
    pub fn with_managed_artifact_root(mut self, artifact_root: &'a RuntimeArtifactRoot) -> Self {
        self.managed_artifact_root = Some(artifact_root);
        self
    }

    pub fn with_parameters(mut self, parameters: Value) -> Self {
        self.parameters = Some(parameters);
        self
    }

    pub fn with_vfs(mut self, vfs: Arc<dyn RuntimeVfs>) -> Self {
        self.vfs = Some(vfs);
        self
    }

    pub fn with_replay(mut self, replay: Arc<ReplayLog>) -> Self {
        self.replay = Some(replay);
        self
    }

    pub fn with_cancellation(mut self, cancellation: RunnerCancellation) -> Self {
        self.cancellation = Some(cancellation);
        self
    }

    pub fn with_snapshot(mut self, snapshot: SnapshotRef) -> Self {
        self.snapshot = Some(snapshot);
        self
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RuntimeAdapterDescriptor {
    pub name: String,
    pub version: String,
    pub fidelity_tier: FidelityTier,
    pub evidence_tier_ceiling: EvidenceTier,
    pub capability_contract: RuntimeCapabilityContract,
    pub capabilities: Vec<RuntimeCapability>,
    pub approximation_tiers: Vec<ApproximationTier>,
    pub diagnostics: Vec<RuntimeAdapterDiagnostic>,
    pub limitations: Vec<String>,
}

impl RuntimeAdapterDescriptor {
    pub fn supports(&self, capability: RuntimeCapability) -> bool {
        self.capabilities.contains(&capability)
    }

    pub fn uses_approximation(&self, approximation_tier: ApproximationTier) -> bool {
        self.approximation_tiers.contains(&approximation_tier)
    }

    pub fn validate_contract(&self) -> UtsushiResult<()> {
        self.capability_contract.validate()?;
        if self.evidence_tier_ceiling > self.fidelity_tier.evidence_ceiling() {
            return Err(format!(
                "runtime adapter {} evidence ceiling {} exceeds fidelity tier {}",
                self.name,
                self.evidence_tier_ceiling.as_str(),
                self.fidelity_tier.as_str()
            )
            .into());
        }
        if self.evidence_tier_ceiling > self.capability_contract.evidence_tier_ceiling {
            return Err(format!(
                "runtime adapter {} evidence ceiling {} exceeds capability contract ceiling {}",
                self.name,
                self.evidence_tier_ceiling.as_str(),
                self.capability_contract.evidence_tier_ceiling.as_str()
            )
            .into());
        }
        if !self
            .capability_contract
            .supports_required_features(&self.capabilities)
        {
            return Err(format!(
                "runtime adapter {} descriptor capabilities exceed its runtime capability contract",
                self.name
            )
            .into());
        }
        Ok(())
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RuntimeAdapterDiagnostic {
    pub diagnostic_kind: String,
    pub status: String,
    pub severity: String,
    pub message: String,
    pub details: Vec<(String, Value)>,
}

impl RuntimeAdapterDiagnostic {
    pub fn new(
        diagnostic_kind: impl Into<String>,
        status: impl Into<String>,
        severity: impl Into<String>,
        message: impl Into<String>,
    ) -> Self {
        Self {
            diagnostic_kind: diagnostic_kind.into(),
            status: status.into(),
            severity: severity.into(),
            message: message.into(),
            details: Vec::new(),
        }
    }

    pub fn with_detail(mut self, key: impl Into<String>, value: impl Into<String>) -> Self {
        self.details.push((key.into(), Value::String(value.into())));
        self
    }

    pub fn with_detail_value(mut self, key: impl Into<String>, value: Value) -> Self {
        self.details.push((key.into(), value));
        self
    }

    pub fn to_json(&self) -> Value {
        let mut value = serde_json::Map::new();
        value.insert(
            "diagnosticKind".to_string(),
            self.diagnostic_kind.clone().into(),
        );
        value.insert("status".to_string(), self.status.clone().into());
        value.insert("severity".to_string(), self.severity.clone().into());
        value.insert("message".to_string(), self.message.clone().into());
        if !self.details.is_empty() {
            value.insert(
                "details".to_string(),
                Value::Object(
                    self.details
                        .iter()
                        .map(|(key, value)| (key.clone(), value.clone()))
                        .collect::<serde_json::Map<_, _>>(),
                ),
            );
        }
        Value::Object(value)
    }
}
