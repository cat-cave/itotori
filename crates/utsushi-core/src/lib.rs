use std::fs;
use std::io::{self, Write};
use std::path::{Component, Path, PathBuf};

use serde_json::Value;

pub type UtsushiResult<T> = Result<T, Box<dyn std::error::Error>>;

pub const RUNTIME_ARTIFACT_URI_ROOT: &str = "artifacts/utsushi/runtime";
pub const RUNTIME_ARTIFACT_ROOT_MARKER: &str = ".utsushi-runtime-artifacts";

const OBVIOUS_UNMANAGED_ROOT_SENTINELS: &[&str] = &[
    ".git",
    "Cargo.toml",
    "package.json",
    "pyproject.toml",
    "go.mod",
    "project.godot",
    "Assets",
];

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

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum RuntimeArtifactKind {
    TraceLog,
    Screenshot,
    FrameCapture,
    Recording,
    ConformanceReport,
}

impl RuntimeArtifactKind {
    pub fn artifact_kind(self) -> &'static str {
        match self {
            Self::TraceLog => "trace_log",
            Self::Screenshot => "screenshot",
            Self::FrameCapture => "frame_capture",
            Self::Recording => "recording",
            Self::ConformanceReport => "reference_comparison",
        }
    }

    pub fn directory(self) -> &'static str {
        match self {
            Self::TraceLog => "traces",
            Self::Screenshot => "screenshots",
            Self::FrameCapture => "frame-captures",
            Self::Recording => "recordings",
            Self::ConformanceReport => "conformance-reports",
        }
    }

    pub fn default_extension(self) -> &'static str {
        match self {
            Self::TraceLog | Self::ConformanceReport => "json",
            Self::Screenshot | Self::FrameCapture => "png",
            Self::Recording => "webm",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RuntimeArtifactName {
    pub run_id: String,
    pub kind: RuntimeArtifactKind,
    pub artifact_id: String,
    pub extension: String,
}

impl RuntimeArtifactName {
    pub fn new(
        run_id: impl Into<String>,
        kind: RuntimeArtifactKind,
        artifact_id: impl Into<String>,
    ) -> UtsushiResult<Self> {
        Self::with_extension(run_id, kind, artifact_id, kind.default_extension())
    }

    pub fn with_extension(
        run_id: impl Into<String>,
        kind: RuntimeArtifactKind,
        artifact_id: impl Into<String>,
        extension: impl Into<String>,
    ) -> UtsushiResult<Self> {
        let name = Self {
            run_id: run_id.into(),
            kind,
            artifact_id: artifact_id.into(),
            extension: extension.into(),
        };
        validate_artifact_segment("run id", &name.run_id)?;
        validate_artifact_segment("artifact id", &name.artifact_id)?;
        validate_artifact_extension(&name.extension)?;
        Ok(name)
    }

    pub fn uri(&self) -> String {
        format!(
            "{}/{}/{}/{}.{}",
            RUNTIME_ARTIFACT_URI_ROOT,
            self.run_id,
            self.kind.directory(),
            self.artifact_id,
            self.extension
        )
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RuntimeArtifactRoot {
    root: PathBuf,
}

impl RuntimeArtifactRoot {
    pub fn new(root: impl Into<PathBuf>) -> Self {
        Self { root: root.into() }
    }

    pub fn path(&self) -> &Path {
        &self.root
    }

    pub fn prepare(&self) -> UtsushiResult<()> {
        let root_existed = match fs::symlink_metadata(&self.root) {
            Ok(metadata) => {
                ensure_directory_metadata(&self.root, &metadata)?;
                ensure_existing_directory_path_without_symlinks(&self.root)?;
                true
            }
            Err(error) if error.kind() == io::ErrorKind::NotFound => {
                create_directory_path_without_symlinks(&self.root)?;
                false
            }
            Err(error) => return Err(error.into()),
        };

        let marker = self.root.join(RUNTIME_ARTIFACT_ROOT_MARKER);
        let marker_exists = match fs::symlink_metadata(&marker) {
            Ok(metadata) => {
                if metadata.file_type().is_symlink() || !metadata.is_file() {
                    return Err(format!(
                        "runtime artifact root marker must be a regular file: {}",
                        marker.display()
                    )
                    .into());
                }
                true
            }
            Err(error) if error.kind() == io::ErrorKind::NotFound => false,
            Err(error) => return Err(error.into()),
        };

        if marker_exists {
            self.assert_not_obvious_unmanaged_root()?;
            return Ok(());
        }

        self.assert_not_obvious_unmanaged_root()?;
        if root_existed && directory_has_entries(&self.root)? {
            return Err(format!(
                "refusing to adopt non-empty unmarked runtime artifact root {}",
                self.root.display()
            )
            .into());
        }

        write_new_marker(&marker)?;
        Ok(())
    }

    pub fn artifact_path(&self, uri: &str) -> UtsushiResult<PathBuf> {
        let relative = validate_runtime_artifact_uri(uri)?;
        Ok(self.root.join(relative))
    }

    pub fn write_bytes(&self, uri: &str, contents: &[u8]) -> UtsushiResult<PathBuf> {
        self.assert_managed_root()?;
        let relative = validate_runtime_artifact_uri(uri)?;
        let path = self.root.join(&relative);
        let Some(parent) = relative.parent() else {
            return Err(
                format!("runtime artifact uri is missing parent directories: {uri}").into(),
            );
        };
        create_artifact_directory_path_without_symlinks(&self.root, parent)?;
        reject_symlink_destination(&path)?;
        write_file_atomically(&path, contents)?;
        reject_symlink_destination(&path)?;
        Ok(path)
    }

    pub fn cleanup_contents(&self) -> UtsushiResult<()> {
        self.assert_managed_root()?;
        for entry in fs::read_dir(&self.root)? {
            let entry = entry?;
            if entry.file_name() == RUNTIME_ARTIFACT_ROOT_MARKER {
                continue;
            }
            remove_artifact_entry(&entry.path())?;
        }
        Ok(())
    }

    fn assert_managed_root(&self) -> UtsushiResult<()> {
        ensure_existing_directory_path_without_symlinks(&self.root)?;
        let canonical = fs::canonicalize(&self.root)?;
        if canonical.parent().is_none() {
            return Err("refusing to clean filesystem root as a runtime artifact root".into());
        }
        let marker = canonical.join(RUNTIME_ARTIFACT_ROOT_MARKER);
        let marker_metadata = match fs::symlink_metadata(&marker) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == io::ErrorKind::NotFound => {
                return Err(format!(
                    "runtime artifact cleanup requires managed root marker {} under {}",
                    RUNTIME_ARTIFACT_ROOT_MARKER,
                    canonical.display()
                )
                .into());
            }
            Err(error) => return Err(error.into()),
        };
        if marker_metadata.file_type().is_symlink() || !marker_metadata.is_file() {
            return Err(format!(
                "runtime artifact cleanup requires regular managed root marker {} under {}",
                RUNTIME_ARTIFACT_ROOT_MARKER,
                canonical.display()
            )
            .into());
        }
        self.assert_not_obvious_unmanaged_root()?;
        Ok(())
    }

    fn assert_not_obvious_unmanaged_root(&self) -> UtsushiResult<()> {
        for sentinel in OBVIOUS_UNMANAGED_ROOT_SENTINELS {
            if fs::symlink_metadata(self.root.join(sentinel)).is_ok() {
                return Err(format!(
                    "refusing to use obvious source or project root as runtime artifact root: {} contains {}",
                    self.root.display(),
                    sentinel
                )
                .into());
            }
        }
        Ok(())
    }
}

pub fn runtime_artifact_uri(
    run_id: &str,
    kind: RuntimeArtifactKind,
    artifact_id: &str,
) -> UtsushiResult<String> {
    Ok(RuntimeArtifactName::new(run_id, kind, artifact_id)?.uri())
}

pub fn validate_runtime_artifact_uri(uri: &str) -> UtsushiResult<PathBuf> {
    if uri.starts_with('/')
        || uri.contains('\\')
        || uri.starts_with("data:")
        || uri.starts_with("blob:")
        || uri.starts_with("file:")
        || has_uri_scheme(uri)
    {
        return Err(format!("runtime artifact uri must be managed and portable: {uri}").into());
    }

    let Some(relative) = uri.strip_prefix(&format!("{RUNTIME_ARTIFACT_URI_ROOT}/")) else {
        return Err(format!(
            "runtime artifact uri must live under {RUNTIME_ARTIFACT_URI_ROOT}: {uri}"
        )
        .into());
    };
    if relative
        .split('/')
        .any(|segment| segment.is_empty() || segment == "." || segment == "..")
    {
        return Err(format!("runtime artifact uri must not contain traversal: {uri}").into());
    }
    let path = Path::new(relative);
    let mut clean = PathBuf::new();
    for component in path.components() {
        match component {
            Component::Normal(segment) => clean.push(segment),
            _ => {
                return Err(
                    format!("runtime artifact uri must not contain traversal: {uri}").into(),
                );
            }
        }
    }
    if clean.components().count() < 3 {
        return Err(
            format!("runtime artifact uri is missing run, kind, or filename: {uri}").into(),
        );
    }
    Ok(clean)
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

    pub fn rank(self) -> u8 {
        match self {
            Self::TraceOnly => 1,
            Self::LayoutProbe => 2,
            Self::ReplayReview => 3,
            Self::ReferenceFidelity => 4,
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

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum RuntimeCapabilityClass {
    StaticTrace,
    LaunchCapture,
    InstrumentedRuntime,
    PartialVm,
    ReferenceVm,
}

impl RuntimeCapabilityClass {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::StaticTrace => "static_trace",
            Self::LaunchCapture => "launch_capture",
            Self::InstrumentedRuntime => "instrumented_runtime",
            Self::PartialVm => "partial_vm",
            Self::ReferenceVm => "reference_vm",
        }
    }

    pub fn fidelity_tier_ceiling(self) -> FidelityTier {
        match self {
            Self::StaticTrace => FidelityTier::TraceOnly,
            Self::LaunchCapture => FidelityTier::LayoutProbe,
            Self::InstrumentedRuntime | Self::PartialVm => FidelityTier::ReplayReview,
            Self::ReferenceVm => FidelityTier::ReferenceFidelity,
        }
    }

    pub fn evidence_tier_ceiling(self) -> EvidenceTier {
        self.fidelity_tier_ceiling().evidence_ceiling()
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum RuntimePlaybackFeature {
    StaticTrace,
    Launch,
    TextTrace,
    BranchDiscovery,
    FrameCapture,
    Jump,
    Snapshot,
    Screenshot,
    Recording,
    InstrumentationHooks,
    VmStateInspection,
    ReferenceComparison,
}

impl RuntimePlaybackFeature {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::StaticTrace => "static_trace",
            Self::Launch => "launch",
            Self::TextTrace => "text_trace",
            Self::BranchDiscovery => "branch_discovery",
            Self::FrameCapture => "frame_capture",
            Self::Jump => "jump",
            Self::Snapshot => "snapshot",
            Self::Screenshot => "screenshot",
            Self::Recording => "recording",
            Self::InstrumentationHooks => "instrumentation_hooks",
            Self::VmStateInspection => "vm_state_inspection",
            Self::ReferenceComparison => "reference_comparison",
        }
    }

    fn covers_runtime_capability(self, capability: RuntimeCapability) -> bool {
        matches!(
            (self, capability),
            (
                Self::StaticTrace | Self::TextTrace,
                RuntimeCapability::Trace
            ) | (Self::BranchDiscovery, RuntimeCapability::BranchDiscovery)
                | (Self::FrameCapture, RuntimeCapability::FrameCapture)
                | (Self::TextTrace, RuntimeCapability::SmokeValidation)
                | (Self::FrameCapture, RuntimeCapability::SmokeValidation)
                | (Self::Recording, RuntimeCapability::ReplayReview)
                | (
                    Self::ReferenceComparison,
                    RuntimeCapability::ReferenceComparison
                )
        )
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum RuntimeFeatureStatus {
    Supported,
    Partial,
    Unsupported,
}

impl RuntimeFeatureStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Supported => "supported",
            Self::Partial => "partial",
            Self::Unsupported => "unsupported",
        }
    }

    fn is_available(self) -> bool {
        matches!(self, Self::Supported | Self::Partial)
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RuntimeFeatureSupport {
    pub feature: RuntimePlaybackFeature,
    pub status: RuntimeFeatureStatus,
    pub evidence_tier_ceiling: Option<EvidenceTier>,
    pub description: String,
    pub limitations: Vec<String>,
}

impl RuntimeFeatureSupport {
    pub fn supported(
        feature: RuntimePlaybackFeature,
        evidence_tier_ceiling: EvidenceTier,
        description: impl Into<String>,
    ) -> Self {
        Self {
            feature,
            status: RuntimeFeatureStatus::Supported,
            evidence_tier_ceiling: Some(evidence_tier_ceiling),
            description: description.into(),
            limitations: Vec::new(),
        }
    }

    pub fn partial(
        feature: RuntimePlaybackFeature,
        evidence_tier_ceiling: EvidenceTier,
        description: impl Into<String>,
        limitations: Vec<String>,
    ) -> Self {
        Self {
            feature,
            status: RuntimeFeatureStatus::Partial,
            evidence_tier_ceiling: Some(evidence_tier_ceiling),
            description: description.into(),
            limitations,
        }
    }

    pub fn unsupported(feature: RuntimePlaybackFeature, description: impl Into<String>) -> Self {
        Self {
            feature,
            status: RuntimeFeatureStatus::Unsupported,
            evidence_tier_ceiling: None,
            description: description.into(),
            limitations: Vec::new(),
        }
    }

    pub fn to_json(&self) -> Value {
        let mut value = serde_json::Map::new();
        value.insert("feature".to_string(), self.feature.as_str().into());
        value.insert("status".to_string(), self.status.as_str().into());
        if let Some(evidence_tier_ceiling) = self.evidence_tier_ceiling {
            value.insert(
                "evidenceTierCeiling".to_string(),
                evidence_tier_ceiling.as_str().into(),
            );
        }
        value.insert("description".to_string(), self.description.clone().into());
        value.insert(
            "limitations".to_string(),
            self.limitations
                .iter()
                .map(|limitation| Value::String(limitation.clone()))
                .collect::<Vec<_>>()
                .into(),
        );
        Value::Object(value)
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RuntimeCapabilityContract {
    pub contract_version: String,
    pub capability_class: RuntimeCapabilityClass,
    pub fidelity_tier_ceiling: FidelityTier,
    pub evidence_tier_ceiling: EvidenceTier,
    pub features: Vec<RuntimeFeatureSupport>,
    pub limitations: Vec<String>,
}

impl RuntimeCapabilityContract {
    pub fn new(
        capability_class: RuntimeCapabilityClass,
        fidelity_tier_ceiling: FidelityTier,
        evidence_tier_ceiling: EvidenceTier,
        features: Vec<RuntimeFeatureSupport>,
        limitations: Vec<String>,
    ) -> Self {
        Self {
            contract_version: "0.2.0".to_string(),
            capability_class,
            fidelity_tier_ceiling,
            evidence_tier_ceiling,
            features,
            limitations,
        }
    }

    pub fn validate(&self) -> UtsushiResult<()> {
        if self.fidelity_tier_ceiling.rank() > self.capability_class.fidelity_tier_ceiling().rank()
        {
            return Err(format!(
                "runtime capability class {} cannot claim fidelity ceiling {}",
                self.capability_class.as_str(),
                self.fidelity_tier_ceiling.as_str()
            )
            .into());
        }
        if self.evidence_tier_ceiling > self.fidelity_tier_ceiling.evidence_ceiling() {
            return Err(format!(
                "runtime capability contract evidence ceiling {} exceeds fidelity ceiling {}",
                self.evidence_tier_ceiling.as_str(),
                self.fidelity_tier_ceiling.as_str()
            )
            .into());
        }
        if self.evidence_tier_ceiling > self.capability_class.evidence_tier_ceiling() {
            return Err(format!(
                "runtime capability class {} cannot claim evidence ceiling {}",
                self.capability_class.as_str(),
                self.evidence_tier_ceiling.as_str()
            )
            .into());
        }
        for feature in &self.features {
            match (feature.status, feature.evidence_tier_ceiling) {
                (RuntimeFeatureStatus::Supported | RuntimeFeatureStatus::Partial, None) => {
                    return Err(format!(
                        "runtime feature {} must declare an evidence ceiling",
                        feature.feature.as_str()
                    )
                    .into());
                }
                (RuntimeFeatureStatus::Unsupported, Some(_)) => {
                    return Err(format!(
                        "unsupported runtime feature {} must not declare an evidence ceiling",
                        feature.feature.as_str()
                    )
                    .into());
                }
                (_, Some(feature_ceiling)) if feature_ceiling > self.evidence_tier_ceiling => {
                    return Err(format!(
                        "runtime feature {} evidence ceiling {} exceeds contract ceiling {}",
                        feature.feature.as_str(),
                        feature_ceiling.as_str(),
                        self.evidence_tier_ceiling.as_str()
                    )
                    .into());
                }
                _ => {}
            }
        }
        Ok(())
    }

    pub fn supports_required_features(&self, capabilities: &[RuntimeCapability]) -> bool {
        capabilities.iter().all(|capability| {
            self.features.iter().any(|feature| {
                feature.status.is_available()
                    && feature.feature.covers_runtime_capability(*capability)
            })
        })
    }

    pub fn to_json(&self) -> Value {
        serde_json::json!({
            "contractVersion": self.contract_version,
            "capabilityClass": self.capability_class.as_str(),
            "fidelityTierCeiling": self.fidelity_tier_ceiling.as_str(),
            "evidenceTierCeiling": self.evidence_tier_ceiling.as_str(),
            "features": self.features.iter().map(RuntimeFeatureSupport::to_json).collect::<Vec<_>>(),
            "limitations": self.limitations
        })
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ControlledPlaybackSession {
    pub session_id: String,
    pub adapter_name: String,
    pub adapter_version: String,
    pub capability_class: RuntimeCapabilityClass,
    pub requested_operation: RuntimeOperation,
    pub status: String,
    pub fidelity_tier: FidelityTier,
    pub evidence_tier: EvidenceTier,
    pub features_used: Vec<RuntimePlaybackFeature>,
    pub limitations: Vec<String>,
}

impl ControlledPlaybackSession {
    pub fn to_json(&self) -> Value {
        serde_json::json!({
            "sessionId": self.session_id,
            "adapterName": self.adapter_name,
            "adapterVersion": self.adapter_version,
            "capabilityClass": self.capability_class.as_str(),
            "requestedOperation": self.requested_operation.as_str(),
            "status": self.status,
            "fidelityTier": self.fidelity_tier.as_str(),
            "evidenceTier": self.evidence_tier.as_str(),
            "featuresUsed": self
                .features_used
                .iter()
                .map(|feature| feature.as_str())
                .collect::<Vec<_>>(),
            "limitations": self.limitations
        })
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
        descriptor.validate_contract()?;
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

fn has_uri_scheme(value: &str) -> bool {
    let Some(colon) = value.find(':') else {
        return false;
    };
    let scheme = &value[..colon];
    !scheme.is_empty()
        && scheme.chars().enumerate().all(|(index, character)| {
            character.is_ascii_alphabetic()
                || (index > 0
                    && (character.is_ascii_digit()
                        || character == '+'
                        || character == '.'
                        || character == '-'))
        })
}

fn validate_artifact_segment(label: &str, value: &str) -> UtsushiResult<()> {
    if value.is_empty()
        || value == "."
        || value == ".."
        || value.contains('/')
        || value.contains('\\')
        || !value.chars().all(|character| {
            character.is_ascii_alphanumeric() || matches!(character, '-' | '_' | '.')
        })
    {
        return Err(format!("runtime artifact {label} is not a safe path segment: {value}").into());
    }
    Ok(())
}

fn validate_artifact_extension(extension: &str) -> UtsushiResult<()> {
    if extension.is_empty()
        || extension.starts_with('.')
        || !extension
            .chars()
            .all(|character| character.is_ascii_alphanumeric())
    {
        return Err(format!("runtime artifact extension is not safe: {extension}").into());
    }
    Ok(())
}

fn ensure_directory_metadata(path: &Path, metadata: &fs::Metadata) -> UtsushiResult<()> {
    if metadata.file_type().is_symlink() {
        return Err(format!(
            "runtime artifact path component must not be a symlink: {}",
            path.display()
        )
        .into());
    }
    if !metadata.is_dir() {
        return Err(format!(
            "runtime artifact path component must be a directory: {}",
            path.display()
        )
        .into());
    }
    Ok(())
}

fn ensure_existing_directory_path_without_symlinks(path: &Path) -> UtsushiResult<()> {
    if path.as_os_str().is_empty() {
        return Err("runtime artifact root must not be empty".into());
    }

    let mut current = PathBuf::new();
    for component in path.components() {
        match component {
            Component::Prefix(prefix) => current.push(prefix.as_os_str()),
            Component::RootDir => current.push(component.as_os_str()),
            Component::CurDir => {}
            Component::ParentDir | Component::Normal(_) => {
                current.push(component.as_os_str());
                let metadata = fs::symlink_metadata(&current)?;
                ensure_directory_metadata(&current, &metadata)?;
            }
        }
    }
    Ok(())
}

fn create_directory_path_without_symlinks(path: &Path) -> UtsushiResult<()> {
    if path.as_os_str().is_empty() {
        return Err("runtime artifact root must not be empty".into());
    }

    let mut current = PathBuf::new();
    for component in path.components() {
        match component {
            Component::Prefix(prefix) => current.push(prefix.as_os_str()),
            Component::RootDir => current.push(component.as_os_str()),
            Component::CurDir => {}
            Component::ParentDir | Component::Normal(_) => {
                current.push(component.as_os_str());
                match fs::symlink_metadata(&current) {
                    Ok(metadata) => ensure_directory_metadata(&current, &metadata)?,
                    Err(error) if error.kind() == io::ErrorKind::NotFound => {
                        fs::create_dir(&current)?;
                        let metadata = fs::symlink_metadata(&current)?;
                        ensure_directory_metadata(&current, &metadata)?;
                    }
                    Err(error) => return Err(error.into()),
                }
            }
        }
    }
    Ok(())
}

fn create_artifact_directory_path_without_symlinks(
    root: &Path,
    relative: &Path,
) -> UtsushiResult<()> {
    ensure_existing_directory_path_without_symlinks(root)?;
    let mut current = root.to_path_buf();
    for component in relative.components() {
        match component {
            Component::Normal(segment) => {
                current.push(segment);
                match fs::symlink_metadata(&current) {
                    Ok(metadata) => ensure_directory_metadata(&current, &metadata)?,
                    Err(error) if error.kind() == io::ErrorKind::NotFound => {
                        fs::create_dir(&current)?;
                        let metadata = fs::symlink_metadata(&current)?;
                        ensure_directory_metadata(&current, &metadata)?;
                    }
                    Err(error) => return Err(error.into()),
                }
            }
            _ => {
                return Err(format!(
                    "runtime artifact relative path must contain only normal segments: {}",
                    relative.display()
                )
                .into());
            }
        }
    }
    Ok(())
}

fn directory_has_entries(path: &Path) -> UtsushiResult<bool> {
    Ok(fs::read_dir(path)?.next().transpose()?.is_some())
}

fn write_new_marker(path: &Path) -> UtsushiResult<()> {
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)?;
    file.write_all(b"managed-by=utsushi-runtime\n")?;
    file.sync_all()?;
    Ok(())
}

fn reject_symlink_destination(path: &Path) -> UtsushiResult<()> {
    match fs::symlink_metadata(path) {
        Ok(metadata) => {
            if metadata.file_type().is_symlink() {
                return Err(format!(
                    "runtime artifact destination must not be a symlink: {}",
                    path.display()
                )
                .into());
            }
            if metadata.is_dir() {
                return Err(format!(
                    "runtime artifact destination must not be a directory: {}",
                    path.display()
                )
                .into());
            }
            Ok(())
        }
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.into()),
    }
}

fn write_file_atomically(path: &Path, contents: &[u8]) -> UtsushiResult<()> {
    let parent = path.parent().ok_or_else(|| {
        format!(
            "runtime artifact destination has no parent: {}",
            path.display()
        )
    })?;
    let filename = path.file_name().ok_or_else(|| {
        format!(
            "runtime artifact destination has no filename: {}",
            path.display()
        )
    })?;
    let mut last_error = None;
    for attempt in 0..16 {
        let temporary = parent.join(format!(
            ".{}.tmp-{}-{attempt}",
            filename.to_string_lossy(),
            std::process::id()
        ));
        match fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)
        {
            Ok(mut file) => {
                if let Err(error) = file.write_all(contents).and_then(|()| file.sync_all()) {
                    let _ = fs::remove_file(&temporary);
                    return Err(error.into());
                }
                fs::rename(&temporary, path)?;
                return Ok(());
            }
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {
                last_error = Some(error);
            }
            Err(error) => return Err(error.into()),
        }
    }
    Err(last_error
        .unwrap_or_else(|| io::Error::new(io::ErrorKind::AlreadyExists, "temporary file exists"))
        .into())
}

fn remove_artifact_entry(path: &Path) -> UtsushiResult<()> {
    let metadata = fs::symlink_metadata(path)?;
    if metadata.is_dir() {
        fs::remove_dir_all(path)?;
    } else {
        fs::remove_file(path)?;
    }
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
    use std::time::{SystemTime, UNIX_EPOCH};

    struct FakeTraceAdapter;

    fn trace_contract() -> RuntimeCapabilityContract {
        RuntimeCapabilityContract::new(
            RuntimeCapabilityClass::StaticTrace,
            FidelityTier::TraceOnly,
            EvidenceTier::E1,
            vec![
                RuntimeFeatureSupport::supported(
                    RuntimePlaybackFeature::StaticTrace,
                    EvidenceTier::E1,
                    "static trace fixture",
                ),
                RuntimeFeatureSupport::supported(
                    RuntimePlaybackFeature::TextTrace,
                    EvidenceTier::E1,
                    "text trace fixture",
                ),
                RuntimeFeatureSupport::unsupported(
                    RuntimePlaybackFeature::Jump,
                    "jump is not part of the base trace contract",
                ),
                RuntimeFeatureSupport::unsupported(
                    RuntimePlaybackFeature::Snapshot,
                    "snapshot is not part of the base trace contract",
                ),
                RuntimeFeatureSupport::unsupported(
                    RuntimePlaybackFeature::Screenshot,
                    "screenshots are not part of the base trace contract",
                ),
                RuntimeFeatureSupport::unsupported(
                    RuntimePlaybackFeature::Recording,
                    "recording is not part of the base trace contract",
                ),
            ],
            vec!["unit test adapter".to_string()],
        )
    }

    fn temp_root(name: &str) -> PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!(
            "utsushi-core-{name}-{}-{nonce}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        root
    }

    impl RuntimeAdapter for FakeTraceAdapter {
        fn descriptor(&self) -> RuntimeAdapterDescriptor {
            RuntimeAdapterDescriptor {
                name: "fake-trace".to_string(),
                version: "0.0.0-test".to_string(),
                fidelity_tier: FidelityTier::TraceOnly,
                evidence_tier_ceiling: EvidenceTier::E1,
                capability_contract: trace_contract(),
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
                capability_contract: RuntimeCapabilityContract::new(
                    RuntimeCapabilityClass::LaunchCapture,
                    FidelityTier::LayoutProbe,
                    EvidenceTier::E4,
                    vec![RuntimeFeatureSupport::supported(
                        RuntimePlaybackFeature::FrameCapture,
                        EvidenceTier::E4,
                        "overclaims capture evidence",
                    )],
                    vec![],
                ),
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

        assert!(error.contains("exceeds"));
    }

    #[test]
    fn capability_contract_serializes_base_unsupported_features() {
        let contract = trace_contract();
        contract.validate().unwrap();

        let value = contract.to_json();

        assert_eq!(value["capabilityClass"], "static_trace");
        assert_eq!(value["evidenceTierCeiling"], "E1");
        assert!(
            value["features"].as_array().unwrap().iter().any(|feature| {
                feature["feature"] == "jump" && feature["status"] == "unsupported"
            })
        );
        assert!(value["features"].as_array().unwrap().iter().any(|feature| {
            feature["feature"] == "snapshot" && feature["status"] == "unsupported"
        }));
        assert!(value["features"].as_array().unwrap().iter().any(|feature| {
            feature["feature"] == "screenshot" && feature["status"] == "unsupported"
        }));
        assert!(value["features"].as_array().unwrap().iter().any(|feature| {
            feature["feature"] == "recording" && feature["status"] == "unsupported"
        }));
    }

    #[test]
    fn capability_classes_map_to_expected_evidence_boundaries() {
        assert_eq!(
            RuntimeCapabilityClass::StaticTrace.evidence_tier_ceiling(),
            EvidenceTier::E1
        );
        assert_eq!(
            RuntimeCapabilityClass::LaunchCapture.evidence_tier_ceiling(),
            EvidenceTier::E2
        );
        assert_eq!(
            RuntimeCapabilityClass::InstrumentedRuntime.evidence_tier_ceiling(),
            EvidenceTier::E3
        );
        assert_eq!(
            RuntimeCapabilityClass::PartialVm.evidence_tier_ceiling(),
            EvidenceTier::E3
        );
        assert_eq!(
            RuntimeCapabilityClass::ReferenceVm.evidence_tier_ceiling(),
            EvidenceTier::E4
        );
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

    #[test]
    fn runtime_artifact_names_are_deterministic_and_managed() {
        let uri = runtime_artifact_uri(
            "019ed003-0000-7000-8000-000000001000",
            RuntimeArtifactKind::Screenshot,
            "019ed003-0000-7000-8000-000000002000",
        )
        .unwrap();

        assert_eq!(
            uri,
            "artifacts/utsushi/runtime/019ed003-0000-7000-8000-000000001000/screenshots/019ed003-0000-7000-8000-000000002000.png"
        );
        assert_eq!(RuntimeArtifactKind::TraceLog.artifact_kind(), "trace_log");
        assert_eq!(
            RuntimeArtifactKind::FrameCapture.artifact_kind(),
            "frame_capture"
        );
        assert_eq!(RuntimeArtifactKind::Recording.artifact_kind(), "recording");
        assert_eq!(
            RuntimeArtifactKind::ConformanceReport.artifact_kind(),
            "reference_comparison"
        );
        assert!(validate_runtime_artifact_uri(&uri).is_ok());
    }

    #[test]
    fn runtime_artifact_paths_reject_traversal_and_external_uris() {
        for uri in [
            "../capture.png",
            "artifacts/utsushi/runtime/run/screenshots/../capture.png",
            "artifacts/utsushi/runtime/run/screenshots/./capture.png",
            "/tmp/capture.png",
            "file:///tmp/capture.png",
            "data:image/png;base64,AAAA",
            "artifacts\\utsushi\\runtime\\run\\capture.png",
            "artifacts/utsushi/hello/frame.png",
        ] {
            assert!(
                validate_runtime_artifact_uri(uri).is_err(),
                "{uri} should be rejected"
            );
        }
    }

    #[test]
    fn runtime_artifact_root_maps_uris_inside_managed_root() {
        let temp = temp_root("artifact-path");
        let root = RuntimeArtifactRoot::new(temp.join("runtime-artifacts"));
        let uri = runtime_artifact_uri("run-1", RuntimeArtifactKind::TraceLog, "trace-1").unwrap();

        let path = root.artifact_path(&uri).unwrap();

        assert!(path.starts_with(root.path()));
        assert_eq!(path.file_name().unwrap(), "trace-1.json");
        assert!(root.artifact_path("../source.json").is_err());
        let _ = fs::remove_dir_all(temp);
    }

    #[test]
    fn runtime_artifact_cleanup_requires_marker_and_keeps_other_roots() {
        let temp = temp_root("cleanup");
        let source_game = temp.join("game");
        let local_corpus = temp.join("local-corpus");
        let benchmark = temp.join("benchmark-output");
        let patch_output = temp.join("patch-output");
        for dir in [&source_game, &local_corpus, &benchmark, &patch_output] {
            fs::create_dir_all(dir).unwrap();
            fs::write(dir.join("keep.txt"), "not managed by utsushi runtime\n").unwrap();
        }

        let source_root = RuntimeArtifactRoot::new(&source_game);
        assert!(source_root.cleanup_contents().is_err());
        assert!(source_game.join("keep.txt").is_file());

        let managed_path = temp.join("runtime-artifacts");
        let managed_root = RuntimeArtifactRoot::new(&managed_path);
        managed_root.prepare().unwrap();
        let uri =
            runtime_artifact_uri("run-cleanup", RuntimeArtifactKind::Recording, "recording-1")
                .unwrap();
        let artifact_path = managed_root
            .write_bytes(&uri, b"runtime recording reference")
            .unwrap();
        assert!(artifact_path.is_file());

        managed_root.cleanup_contents().unwrap();

        assert!(managed_path.join(RUNTIME_ARTIFACT_ROOT_MARKER).is_file());
        assert!(!artifact_path.exists());
        for dir in [&source_game, &local_corpus, &benchmark, &patch_output] {
            assert!(dir.join("keep.txt").is_file());
        }
        let _ = fs::remove_dir_all(temp);
    }

    #[test]
    fn runtime_artifact_prepare_refuses_non_empty_unmarked_roots() {
        let temp = temp_root("adoption");
        let source_game = temp.join("game");
        fs::create_dir_all(&source_game).unwrap();
        fs::write(source_game.join("keep.txt"), "source content\n").unwrap();

        let root = RuntimeArtifactRoot::new(&source_game);
        let error = root.prepare().unwrap_err().to_string();

        assert!(error.contains("non-empty unmarked"));
        assert!(source_game.join("keep.txt").is_file());
        assert!(!source_game.join(RUNTIME_ARTIFACT_ROOT_MARKER).exists());
        let _ = fs::remove_dir_all(temp);
    }

    #[test]
    fn runtime_artifact_cleanup_refuses_marked_source_roots() {
        let temp = temp_root("marked-source");
        let source_root = temp.join("repo");
        fs::create_dir_all(&source_root).unwrap();
        fs::write(
            source_root.join("Cargo.toml"),
            "[package]\nname = \"source\"\n",
        )
        .unwrap();
        fs::write(
            source_root.join(RUNTIME_ARTIFACT_ROOT_MARKER),
            "managed-by=utsushi-runtime\n",
        )
        .unwrap();
        fs::write(source_root.join("keep.txt"), "source content\n").unwrap();

        let root = RuntimeArtifactRoot::new(&source_root);
        let error = root.cleanup_contents().unwrap_err().to_string();

        assert!(error.contains("obvious source or project root"));
        assert!(source_root.join("Cargo.toml").is_file());
        assert!(source_root.join("keep.txt").is_file());
        let _ = fs::remove_dir_all(temp);
    }

    #[cfg(unix)]
    #[test]
    fn runtime_artifact_write_rejects_symlink_parent_components() {
        use std::os::unix::fs as unix_fs;

        let temp = temp_root("symlink-parent");
        let managed_path = temp.join("runtime-artifacts");
        let outside = temp.join("outside");
        fs::create_dir_all(&outside).unwrap();
        let root = RuntimeArtifactRoot::new(&managed_path);
        root.prepare().unwrap();
        unix_fs::symlink(&outside, managed_path.join("run-link")).unwrap();
        let uri =
            runtime_artifact_uri("run-link", RuntimeArtifactKind::TraceLog, "trace-1").unwrap();

        let error = root.write_bytes(&uri, b"trace").unwrap_err().to_string();

        assert!(error.contains("symlink"));
        assert!(!outside.join("traces").exists());
        let _ = fs::remove_dir_all(temp);
    }

    #[cfg(unix)]
    #[test]
    fn runtime_artifact_write_rejects_symlink_destinations() {
        use std::os::unix::fs as unix_fs;

        let temp = temp_root("symlink-destination");
        let managed_path = temp.join("runtime-artifacts");
        let outside = temp.join("outside.txt");
        fs::write(&outside, "outside content\n").unwrap();
        let root = RuntimeArtifactRoot::new(&managed_path);
        root.prepare().unwrap();
        let uri =
            runtime_artifact_uri("run-dest", RuntimeArtifactKind::TraceLog, "trace-1").unwrap();
        let artifact_path = root.artifact_path(&uri).unwrap();
        fs::create_dir_all(artifact_path.parent().unwrap()).unwrap();
        unix_fs::symlink(&outside, &artifact_path).unwrap();

        let error = root.write_bytes(&uri, b"trace").unwrap_err().to_string();

        assert!(error.contains("symlink"));
        assert_eq!(fs::read_to_string(&outside).unwrap(), "outside content\n");
        let _ = fs::remove_dir_all(temp);
    }
}
