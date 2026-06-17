use std::fs;
use std::path::Path;

use serde_json::Value;

pub type UtsushiResult<T> = Result<T, Box<dyn std::error::Error>>;

#[derive(Clone, Copy, Debug)]
pub struct RuntimeRequest<'a> {
    pub input_root: &'a Path,
    pub artifact_root: Option<&'a Path>,
}

impl<'a> RuntimeRequest<'a> {
    pub fn new(input_root: &'a Path) -> Self {
        Self {
            input_root,
            artifact_root: None,
        }
    }

    pub fn with_artifact_root(mut self, artifact_root: &'a Path) -> Self {
        self.artifact_root = Some(artifact_root);
        self
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RuntimeAdapterDescriptor {
    pub name: String,
    pub version: String,
    pub fidelity_tier: FidelityTier,
    pub evidence_tier_ceiling: EvidenceTier,
    pub capabilities: Vec<RuntimeCapability>,
    pub approximation_tiers: Vec<ApproximationTier>,
    pub limitations: Vec<String>,
}

impl RuntimeAdapterDescriptor {
    pub fn supports(&self, capability: RuntimeCapability) -> bool {
        self.capabilities.contains(&capability)
    }

    pub fn uses_approximation(&self, approximation_tier: ApproximationTier) -> bool {
        self.approximation_tiers.contains(&approximation_tier)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum RuntimeOperation {
    Trace,
    BranchDiscovery,
    Capture,
    SmokeValidation,
}

impl RuntimeOperation {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Trace => "trace",
            Self::BranchDiscovery => "branch_discovery",
            Self::Capture => "capture",
            Self::SmokeValidation => "smoke_validation",
        }
    }

    pub fn required_capability(self) -> RuntimeCapability {
        match self {
            Self::Trace => RuntimeCapability::Trace,
            Self::BranchDiscovery => RuntimeCapability::BranchDiscovery,
            Self::Capture => RuntimeCapability::FrameCapture,
            Self::SmokeValidation => RuntimeCapability::SmokeValidation,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum RuntimeCapability {
    Trace,
    BranchDiscovery,
    FrameCapture,
    SmokeValidation,
    ReplayReview,
    ReferenceComparison,
}

impl RuntimeCapability {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Trace => "trace",
            Self::BranchDiscovery => "branch_discovery",
            Self::FrameCapture => "frame_capture",
            Self::SmokeValidation => "smoke_validation",
            Self::ReplayReview => "replay_review",
            Self::ReferenceComparison => "reference_comparison",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum EvidenceTier {
    E0,
    E1,
    E2,
    E3,
    E4,
}

impl EvidenceTier {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::E0 => "E0",
            Self::E1 => "E1",
            Self::E2 => "E2",
            Self::E3 => "E3",
            Self::E4 => "E4",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum FidelityTier {
    TraceOnly,
    LayoutProbe,
    ReplayReview,
    ReferenceFidelity,
}

impl FidelityTier {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::TraceOnly => "trace_only",
            Self::LayoutProbe => "layout_probe",
            Self::ReplayReview => "replay_review",
            Self::ReferenceFidelity => "reference_fidelity",
        }
    }

    pub fn evidence_ceiling(self) -> EvidenceTier {
        match self {
            Self::TraceOnly => EvidenceTier::E1,
            Self::LayoutProbe => EvidenceTier::E2,
            Self::ReplayReview => EvidenceTier::E3,
            Self::ReferenceFidelity => EvidenceTier::E4,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum ApproximationTier {
    None,
    DeterministicFixture,
    LayoutProbe,
    EnginePartial,
    ReferenceMatched,
}

impl ApproximationTier {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::None => "none",
            Self::DeterministicFixture => "deterministic_fixture",
            Self::LayoutProbe => "layout_probe",
            Self::EnginePartial => "engine_partial",
            Self::ReferenceMatched => "reference_matched",
        }
    }
}

pub trait RuntimeAdapter {
    fn descriptor(&self) -> RuntimeAdapterDescriptor;

    fn trace(&self, request: &RuntimeRequest<'_>) -> UtsushiResult<Value>;

    fn discover_branches(&self, _request: &RuntimeRequest<'_>) -> UtsushiResult<Value> {
        Err(unsupported_operation(&self.descriptor(), RuntimeOperation::BranchDiscovery).into())
    }

    fn capture(&self, _request: &RuntimeRequest<'_>) -> UtsushiResult<Value> {
        Err(unsupported_operation(&self.descriptor(), RuntimeOperation::Capture).into())
    }

    fn smoke_validate(&self, _request: &RuntimeRequest<'_>) -> UtsushiResult<Value> {
        Err(unsupported_operation(&self.descriptor(), RuntimeOperation::SmokeValidation).into())
    }

    fn run(
        &self,
        operation: RuntimeOperation,
        request: &RuntimeRequest<'_>,
    ) -> UtsushiResult<Value> {
        match operation {
            RuntimeOperation::Trace => self.trace(request),
            RuntimeOperation::BranchDiscovery => self.discover_branches(request),
            RuntimeOperation::Capture => self.capture(request),
            RuntimeOperation::SmokeValidation => self.smoke_validate(request),
        }
    }
}

pub struct RuntimeAdapterRegistry<'a> {
    adapters: Vec<&'a dyn RuntimeAdapter>,
}

impl<'a> RuntimeAdapterRegistry<'a> {
    pub fn new() -> Self {
        Self {
            adapters: Vec::new(),
        }
    }

    pub fn register(&mut self, adapter: &'a dyn RuntimeAdapter) -> UtsushiResult<()> {
        let descriptor = adapter.descriptor();
        if descriptor.evidence_tier_ceiling > descriptor.fidelity_tier.evidence_ceiling() {
            return Err(format!(
                "runtime adapter {} evidence ceiling {} exceeds fidelity tier {}",
                descriptor.name,
                descriptor.evidence_tier_ceiling.as_str(),
                descriptor.fidelity_tier.as_str()
            )
            .into());
        }
        if self
            .adapters
            .iter()
            .any(|registered| registered.descriptor().name == descriptor.name)
        {
            return Err(format!("runtime adapter already registered: {}", descriptor.name).into());
        }
        self.adapters.push(adapter);
        Ok(())
    }

    pub fn adapter(&self, name: &str) -> Option<&'a dyn RuntimeAdapter> {
        self.adapters
            .iter()
            .find(|adapter| adapter.descriptor().name == name)
            .copied()
    }

    pub fn require(&self, name: &str) -> UtsushiResult<&'a dyn RuntimeAdapter> {
        self.adapter(name)
            .ok_or_else(|| format!("runtime adapter not registered: {name}").into())
    }

    pub fn descriptors(&self) -> Vec<RuntimeAdapterDescriptor> {
        self.adapters
            .iter()
            .map(|adapter| adapter.descriptor())
            .collect()
    }

    pub fn run(
        &self,
        adapter_name: &str,
        operation: RuntimeOperation,
        request: &RuntimeRequest<'_>,
    ) -> UtsushiResult<Value> {
        let adapter = self.require(adapter_name)?;
        let descriptor = adapter.descriptor();
        let required_capability = operation.required_capability();
        if !descriptor.supports(required_capability) {
            return Err(unsupported_operation(&descriptor, operation).into());
        }
        adapter.run(operation, request)
    }
}

impl Default for RuntimeAdapterRegistry<'_> {
    fn default() -> Self {
        Self::new()
    }
}

pub fn write_json(path: &Path, value: &Value) -> UtsushiResult<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::write(path, format!("{}\n", serde_json::to_string_pretty(value)?))?;
    Ok(())
}

fn unsupported_operation(
    descriptor: &RuntimeAdapterDescriptor,
    operation: RuntimeOperation,
) -> String {
    format!(
        "runtime adapter {} does not support {}",
        descriptor.name,
        operation.as_str()
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    struct FakeTraceAdapter;

    impl RuntimeAdapter for FakeTraceAdapter {
        fn descriptor(&self) -> RuntimeAdapterDescriptor {
            RuntimeAdapterDescriptor {
                name: "fake-trace".to_string(),
                version: "0.0.0-test".to_string(),
                fidelity_tier: FidelityTier::TraceOnly,
                evidence_tier_ceiling: EvidenceTier::E1,
                capabilities: vec![RuntimeCapability::Trace],
                approximation_tiers: vec![ApproximationTier::DeterministicFixture],
                limitations: vec!["unit test adapter".to_string()],
            }
        }

        fn trace(&self, request: &RuntimeRequest<'_>) -> UtsushiResult<Value> {
            Ok(json!({
                "operation": "trace",
                "inputRoot": request.input_root.display().to_string()
            }))
        }
    }

    struct OverclaimingAdapter;

    impl RuntimeAdapter for OverclaimingAdapter {
        fn descriptor(&self) -> RuntimeAdapterDescriptor {
            RuntimeAdapterDescriptor {
                name: "overclaiming".to_string(),
                version: "0.0.0-test".to_string(),
                fidelity_tier: FidelityTier::LayoutProbe,
                evidence_tier_ceiling: EvidenceTier::E4,
                capabilities: vec![RuntimeCapability::Trace, RuntimeCapability::FrameCapture],
                approximation_tiers: vec![ApproximationTier::ReferenceMatched],
                limitations: vec![],
            }
        }

        fn trace(&self, _request: &RuntimeRequest<'_>) -> UtsushiResult<Value> {
            Ok(json!({ "operation": "trace" }))
        }
    }

    #[test]
    fn fidelity_tiers_match_runtime_schema_evidence_ceilings() {
        assert_eq!(FidelityTier::TraceOnly.evidence_ceiling(), EvidenceTier::E1);
        assert_eq!(
            FidelityTier::LayoutProbe.evidence_ceiling(),
            EvidenceTier::E2
        );
        assert_eq!(
            FidelityTier::ReplayReview.evidence_ceiling(),
            EvidenceTier::E3
        );
        assert_eq!(
            FidelityTier::ReferenceFidelity.evidence_ceiling(),
            EvidenceTier::E4
        );
    }

    #[test]
    fn registry_dispatches_by_adapter_name() {
        let adapter = FakeTraceAdapter;
        let mut registry = RuntimeAdapterRegistry::new();
        registry.register(&adapter).unwrap();

        let input_root = Path::new("fixtures/hello-game");
        let report = registry
            .run(
                "fake-trace",
                RuntimeOperation::Trace,
                &RuntimeRequest::new(input_root),
            )
            .unwrap();

        assert_eq!(report["operation"], "trace");
        assert_eq!(report["inputRoot"], "fixtures/hello-game");
        assert_eq!(registry.descriptors()[0].name, "fake-trace");
    }

    #[test]
    fn registry_rejects_duplicate_adapter_names() {
        let adapter = FakeTraceAdapter;
        let mut registry = RuntimeAdapterRegistry::new();

        registry.register(&adapter).unwrap();
        let error = registry.register(&adapter).unwrap_err().to_string();

        assert!(error.contains("already registered"));
    }

    #[test]
    fn registry_rejects_adapter_evidence_overclaims() {
        let adapter = OverclaimingAdapter;
        let mut registry = RuntimeAdapterRegistry::new();

        let error = registry.register(&adapter).unwrap_err().to_string();

        assert!(error.contains("exceeds fidelity tier"));
    }

    #[test]
    fn registry_fails_closed_for_unsupported_operations() {
        let adapter = FakeTraceAdapter;
        let mut registry = RuntimeAdapterRegistry::new();
        registry.register(&adapter).unwrap();

        let error = registry
            .run(
                "fake-trace",
                RuntimeOperation::Capture,
                &RuntimeRequest::new(Path::new("fixtures/hello-game")),
            )
            .unwrap_err()
            .to_string();

        assert!(error.contains("does not support capture"));
    }
}
