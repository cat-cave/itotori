use std::any::Any;
use std::fs;
use std::io::{self, Write};
use std::panic::{self, AssertUnwindSafe};
use std::path::{Component, Path, PathBuf};
use std::process::{Child, Command, ExitStatus, Stdio};
use std::sync::mpsc;
use std::thread;
use std::time::{Duration, Instant};

use serde_json::Value;

pub type UtsushiResult<T> = Result<T, Box<dyn std::error::Error>>;

pub const RUNTIME_ARTIFACT_URI_ROOT: &str = "artifacts/utsushi/runtime";
pub const RUNTIME_ARTIFACT_ROOT_MARKER: &str = ".utsushi-runtime-artifacts";

const DEFAULT_HARNESS_TIMEOUT: Duration = Duration::from_secs(30);
const DEFAULT_HARNESS_SHUTDOWN_GRACE: Duration = Duration::from_secs(2);
const DEFAULT_HARNESS_HOOK_TIMEOUT: Duration = Duration::from_secs(5);
const DEFAULT_HARNESS_POLL_INTERVAL: Duration = Duration::from_millis(10);

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

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RuntimeLaunchCommand {
    pub program: PathBuf,
    pub args: Vec<String>,
    pub current_dir: Option<PathBuf>,
    pub env: Vec<(String, String)>,
}

impl RuntimeLaunchCommand {
    pub fn new(program: impl Into<PathBuf>) -> Self {
        Self {
            program: program.into(),
            args: Vec::new(),
            current_dir: None,
            env: Vec::new(),
        }
    }

    pub fn arg(mut self, arg: impl Into<String>) -> Self {
        self.args.push(arg.into());
        self
    }

    pub fn args<I, S>(mut self, args: I) -> Self
    where
        I: IntoIterator<Item = S>,
        S: Into<String>,
    {
        self.args.extend(args.into_iter().map(Into::into));
        self
    }

    pub fn current_dir(mut self, current_dir: impl Into<PathBuf>) -> Self {
        self.current_dir = Some(current_dir.into());
        self
    }

    pub fn env(mut self, key: impl Into<String>, value: impl Into<String>) -> Self {
        self.env.push((key.into(), value.into()));
        self
    }

    fn to_command(&self) -> Command {
        let mut command = Command::new(&self.program);
        command
            .args(&self.args)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        if let Some(current_dir) = &self.current_dir {
            command.current_dir(current_dir);
        }
        for (key, value) in &self.env {
            command.env(key, value);
        }
        command
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RuntimeLaunchCapturePlan {
    pub run_id: String,
    pub operation: RuntimeOperation,
    pub command: RuntimeLaunchCommand,
    pub timeout: Duration,
    pub shutdown_grace: Duration,
    pub hook_timeout: Duration,
    pub poll_interval: Duration,
    pub artifact_root: Option<PathBuf>,
}

impl RuntimeLaunchCapturePlan {
    pub fn new(
        run_id: impl Into<String>,
        operation: RuntimeOperation,
        command: RuntimeLaunchCommand,
    ) -> Self {
        Self {
            run_id: run_id.into(),
            operation,
            command,
            timeout: DEFAULT_HARNESS_TIMEOUT,
            shutdown_grace: DEFAULT_HARNESS_SHUTDOWN_GRACE,
            hook_timeout: DEFAULT_HARNESS_HOOK_TIMEOUT,
            poll_interval: DEFAULT_HARNESS_POLL_INTERVAL,
            artifact_root: None,
        }
    }

    pub fn with_timeout(mut self, timeout: Duration) -> Self {
        self.timeout = timeout;
        self
    }

    pub fn with_shutdown_grace(mut self, shutdown_grace: Duration) -> Self {
        self.shutdown_grace = shutdown_grace;
        self
    }

    pub fn with_hook_timeout(mut self, hook_timeout: Duration) -> Self {
        self.hook_timeout = hook_timeout;
        self
    }

    pub fn with_poll_interval(mut self, poll_interval: Duration) -> Self {
        self.poll_interval = poll_interval;
        self
    }

    pub fn with_artifact_root(mut self, artifact_root: impl Into<PathBuf>) -> Self {
        self.artifact_root = Some(artifact_root.into());
        self
    }

    fn validate(&self) -> Result<(), RuntimeHarnessError> {
        if let Err(error) = validate_artifact_segment("run id", &self.run_id) {
            return Err(RuntimeHarnessError::new(
                RuntimeHarnessErrorKind::InvalidPlan,
                self.operation,
                format!("invalid runtime harness run id: {error}"),
            ));
        }
        if self.command.program.as_os_str().is_empty() {
            return Err(RuntimeHarnessError::new(
                RuntimeHarnessErrorKind::InvalidPlan,
                self.operation,
                "runtime launch command program must not be empty",
            ));
        }
        if self.timeout.is_zero() {
            return Err(RuntimeHarnessError::new(
                RuntimeHarnessErrorKind::InvalidPlan,
                self.operation,
                "runtime launch timeout must be greater than zero",
            ));
        }
        if self.shutdown_grace.is_zero() {
            return Err(RuntimeHarnessError::new(
                RuntimeHarnessErrorKind::InvalidPlan,
                self.operation,
                "runtime launch shutdown grace must be greater than zero",
            ));
        }
        if self.hook_timeout.is_zero() {
            return Err(RuntimeHarnessError::new(
                RuntimeHarnessErrorKind::InvalidPlan,
                self.operation,
                "runtime capture hook timeout must be greater than zero",
            ));
        }
        if self.poll_interval.is_zero() {
            return Err(RuntimeHarnessError::new(
                RuntimeHarnessErrorKind::InvalidPlan,
                self.operation,
                "runtime launch poll interval must be greater than zero",
            ));
        }
        Ok(())
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum RuntimeCaptureBoundary {
    AfterLaunch,
    BeforeTerminate,
    AfterExit,
}

impl RuntimeCaptureBoundary {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::AfterLaunch => "after_launch",
            Self::BeforeTerminate => "before_terminate",
            Self::AfterExit => "after_exit",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum RuntimeHarnessErrorKind {
    InvalidPlan,
    LaunchFailed,
    Timeout,
    ProcessFailed,
    ProcessWaitFailed,
    ProcessCleanupFailed,
    CaptureTimeout,
    CaptureFailed,
    ArtifactStoreUnavailable,
    ArtifactWriteFailed,
}

impl RuntimeHarnessErrorKind {
    pub fn code(self) -> &'static str {
        match self {
            Self::InvalidPlan => "runtime_harness_invalid_plan",
            Self::LaunchFailed => "runtime_launch_failed",
            Self::Timeout => "runtime_launch_timeout",
            Self::ProcessFailed => "runtime_process_failed",
            Self::ProcessWaitFailed => "runtime_process_wait_failed",
            Self::ProcessCleanupFailed => "runtime_process_cleanup_failed",
            Self::CaptureTimeout => "runtime_capture_timeout",
            Self::CaptureFailed => "runtime_capture_failed",
            Self::ArtifactStoreUnavailable => "runtime_artifact_store_unavailable",
            Self::ArtifactWriteFailed => "runtime_artifact_write_failed",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RuntimeProcessCleanupScope {
    ProcessTree,
}

impl RuntimeProcessCleanupScope {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::ProcessTree => "process_tree",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct RuntimeProcessCleanup {
    pub attempted: bool,
    pub completed: bool,
    pub scope: RuntimeProcessCleanupScope,
    pub escalated: bool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RuntimeHarnessError {
    pub kind: RuntimeHarnessErrorKind,
    pub operation: RuntimeOperation,
    pub message: String,
    pub boundary: Option<RuntimeCaptureBoundary>,
    pub process_id: Option<u32>,
    pub cleanup: Option<RuntimeProcessCleanup>,
    pub details: Vec<(String, String)>,
}

impl RuntimeHarnessError {
    pub fn new(
        kind: RuntimeHarnessErrorKind,
        operation: RuntimeOperation,
        message: impl Into<String>,
    ) -> Self {
        Self {
            kind,
            operation,
            message: message.into(),
            boundary: None,
            process_id: None,
            cleanup: None,
            details: Vec::new(),
        }
    }

    pub fn capture_failed(operation: RuntimeOperation, message: impl Into<String>) -> Self {
        Self::new(RuntimeHarnessErrorKind::CaptureFailed, operation, message)
    }

    pub fn code(&self) -> &'static str {
        self.kind.code()
    }

    pub fn with_boundary(mut self, boundary: RuntimeCaptureBoundary) -> Self {
        self.boundary = Some(boundary);
        self
    }

    pub fn with_process_id(mut self, process_id: u32) -> Self {
        self.process_id = Some(process_id);
        self
    }

    pub fn with_cleanup(mut self, cleanup: RuntimeProcessCleanup) -> Self {
        self.cleanup = Some(cleanup);
        if !cleanup.completed && self.kind != RuntimeHarnessErrorKind::Timeout {
            self.kind = RuntimeHarnessErrorKind::ProcessCleanupFailed;
        }
        self
    }

    pub fn with_detail(mut self, key: impl Into<String>, value: impl Into<String>) -> Self {
        self.details.push((key.into(), value.into()));
        self
    }

    pub fn to_json(&self) -> Value {
        let details = self
            .details
            .iter()
            .map(|(key, value)| (key.clone(), Value::String(value.clone())))
            .collect::<serde_json::Map<_, _>>();
        let mut value = serde_json::Map::new();
        value.insert("errorCode".to_string(), self.code().into());
        value.insert("message".to_string(), self.message.clone().into());
        value.insert("operation".to_string(), self.operation.as_str().into());
        if let Some(boundary) = self.boundary {
            value.insert("boundary".to_string(), boundary.as_str().into());
        }
        if let Some(process_id) = self.process_id {
            value.insert("processId".to_string(), process_id.into());
        }
        if let Some(cleanup) = self.cleanup {
            value.insert(
                "cleanup".to_string(),
                serde_json::json!({
                    "attempted": cleanup.attempted,
                    "completed": cleanup.completed,
                    "scope": cleanup.scope.as_str(),
                    "escalated": cleanup.escalated
                }),
            );
        }
        if !details.is_empty() {
            value.insert("details".to_string(), Value::Object(details));
        }
        Value::Object(value)
    }

    pub fn to_validation_finding(
        &self,
        finding_id: impl Into<String>,
        finding_kind: impl Into<String>,
        severity: impl Into<String>,
        evidence_tier: EvidenceTier,
    ) -> Value {
        serde_json::json!({
            "findingId": finding_id.into(),
            "findingKind": finding_kind.into(),
            "severity": severity.into(),
            "message": format!("{}: {}", self.code(), self.message),
            "evidenceTier": evidence_tier.as_str()
        })
    }
}

impl std::fmt::Display for RuntimeHarnessError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(formatter, "{}: {}", self.code(), self.message)
    }
}

impl std::error::Error for RuntimeHarnessError {}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RuntimeCapturedArtifact {
    pub artifact_id: String,
    pub artifact_kind: RuntimeArtifactKind,
    pub uri: String,
    pub media_type: Option<String>,
    pub byte_size: u64,
    pub path: PathBuf,
    pub boundary: Option<RuntimeCaptureBoundary>,
}

impl RuntimeCapturedArtifact {
    pub fn artifact_ref_json(&self) -> Value {
        let mut value = serde_json::Map::new();
        value.insert("artifactId".to_string(), self.artifact_id.clone().into());
        value.insert(
            "artifactKind".to_string(),
            self.artifact_kind.artifact_kind().into(),
        );
        value.insert("uri".to_string(), self.uri.clone().into());
        if let Some(media_type) = &self.media_type {
            value.insert("mediaType".to_string(), media_type.clone().into());
        }
        value.insert("byteSize".to_string(), self.byte_size.into());
        Value::Object(value)
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RuntimeCaptureArtifactStore {
    root: RuntimeArtifactRoot,
    run_id: String,
}

impl RuntimeCaptureArtifactStore {
    pub fn prepare(
        root: impl Into<PathBuf>,
        run_id: impl Into<String>,
        operation: RuntimeOperation,
    ) -> Result<Self, RuntimeHarnessError> {
        let run_id = run_id.into();
        if let Err(error) = validate_artifact_segment("run id", &run_id) {
            return Err(RuntimeHarnessError::new(
                RuntimeHarnessErrorKind::InvalidPlan,
                operation,
                format!("invalid runtime artifact run id: {error}"),
            ));
        }
        let store = Self {
            root: RuntimeArtifactRoot::new(root.into()),
            run_id,
        };
        store.root.prepare().map_err(|error| {
            RuntimeHarnessError::new(
                RuntimeHarnessErrorKind::ArtifactWriteFailed,
                operation,
                format!("failed to prepare runtime artifact root: {error}"),
            )
        })?;
        Ok(store)
    }

    pub fn root(&self) -> &RuntimeArtifactRoot {
        &self.root
    }

    pub fn write_artifact(
        &self,
        kind: RuntimeArtifactKind,
        artifact_id: impl Into<String>,
        media_type: impl Into<Option<String>>,
        contents: &[u8],
    ) -> UtsushiResult<RuntimeCapturedArtifact> {
        self.write_artifact_with_extension(
            kind,
            artifact_id,
            kind.default_extension(),
            media_type,
            contents,
        )
    }

    pub fn write_artifact_with_extension(
        &self,
        kind: RuntimeArtifactKind,
        artifact_id: impl Into<String>,
        extension: impl Into<String>,
        media_type: impl Into<Option<String>>,
        contents: &[u8],
    ) -> UtsushiResult<RuntimeCapturedArtifact> {
        let artifact_id = artifact_id.into();
        let name = RuntimeArtifactName::with_extension(
            &self.run_id,
            kind,
            artifact_id.clone(),
            extension.into(),
        )?;
        let uri = name.uri();
        let path = self.root.write_bytes(&uri, contents)?;
        Ok(RuntimeCapturedArtifact {
            artifact_id,
            artifact_kind: kind,
            uri,
            media_type: media_type.into(),
            byte_size: contents.len() as u64,
            path,
            boundary: None,
        })
    }
}

pub struct RuntimeCaptureContext {
    pub operation: RuntimeOperation,
    pub boundary: RuntimeCaptureBoundary,
    pub process_id: u32,
    pub run_id: String,
    artifact_store: Option<RuntimeCaptureArtifactStore>,
    artifacts: Vec<RuntimeCapturedArtifact>,
}

impl RuntimeCaptureContext {
    fn new(
        operation: RuntimeOperation,
        boundary: RuntimeCaptureBoundary,
        process_id: u32,
        run_id: impl Into<String>,
        artifact_store: Option<RuntimeCaptureArtifactStore>,
    ) -> Self {
        Self {
            operation,
            boundary,
            process_id,
            run_id: run_id.into(),
            artifact_store,
            artifacts: Vec::new(),
        }
    }

    pub fn write_artifact(
        &mut self,
        kind: RuntimeArtifactKind,
        artifact_id: impl Into<String>,
        media_type: impl Into<Option<String>>,
        contents: &[u8],
    ) -> Result<RuntimeCapturedArtifact, RuntimeHarnessError> {
        let Some(store) = &self.artifact_store else {
            return Err(RuntimeHarnessError::new(
                RuntimeHarnessErrorKind::ArtifactStoreUnavailable,
                self.operation,
                "capture hook requested artifact storage but no managed runtime artifact root was configured",
            )
            .with_boundary(self.boundary)
            .with_process_id(self.process_id));
        };
        let mut artifact = store
            .write_artifact(kind, artifact_id, media_type, contents)
            .map_err(|error| {
                RuntimeHarnessError::new(
                    RuntimeHarnessErrorKind::ArtifactWriteFailed,
                    self.operation,
                    format!("capture hook failed to write runtime artifact: {error}"),
                )
                .with_boundary(self.boundary)
                .with_process_id(self.process_id)
            })?;
        artifact.boundary = Some(self.boundary);
        self.artifacts.push(artifact.clone());
        Ok(artifact)
    }

    pub fn artifacts(&self) -> &[RuntimeCapturedArtifact] {
        &self.artifacts
    }

    fn into_artifacts(self) -> Vec<RuntimeCapturedArtifact> {
        self.artifacts
    }
}

pub trait RuntimeCaptureHook: Send + 'static {
    fn boundary(&self) -> RuntimeCaptureBoundary;

    fn capture(&mut self, context: &mut RuntimeCaptureContext) -> Result<(), RuntimeHarnessError>;
}

#[derive(Default)]
pub struct RuntimeCaptureHooks {
    hooks: Vec<Box<dyn RuntimeCaptureHook>>,
}

impl RuntimeCaptureHooks {
    pub fn new() -> Self {
        Self { hooks: Vec::new() }
    }

    pub fn push<H>(&mut self, hook: H)
    where
        H: RuntimeCaptureHook,
    {
        self.hooks.push(Box::new(hook));
    }

    pub fn push_boxed(&mut self, hook: Box<dyn RuntimeCaptureHook>) {
        self.hooks.push(hook);
    }

    pub fn is_empty(&self) -> bool {
        self.hooks.is_empty()
    }
}

impl From<Vec<Box<dyn RuntimeCaptureHook>>> for RuntimeCaptureHooks {
    fn from(hooks: Vec<Box<dyn RuntimeCaptureHook>>) -> Self {
        Self { hooks }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct RuntimeProcessExit {
    pub success: bool,
    pub code: Option<i32>,
}

impl RuntimeProcessExit {
    fn from_status(status: ExitStatus) -> Self {
        Self {
            success: status.success(),
            code: status.code(),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RuntimeLaunchCaptureOutcome {
    pub process_id: u32,
    pub exit: RuntimeProcessExit,
    pub elapsed: Duration,
    pub artifacts: Vec<RuntimeCapturedArtifact>,
}

#[derive(Clone, Copy)]
struct RuntimeHookRun<'a> {
    plan: &'a RuntimeLaunchCapturePlan,
    process_id: u32,
    artifact_store: Option<&'a RuntimeCaptureArtifactStore>,
}

#[derive(Clone, Debug, Default)]
pub struct RuntimeLaunchCaptureHarness;

impl RuntimeLaunchCaptureHarness {
    pub fn new() -> Self {
        Self
    }

    pub fn run(
        &self,
        plan: &RuntimeLaunchCapturePlan,
        hooks: &mut RuntimeCaptureHooks,
    ) -> Result<RuntimeLaunchCaptureOutcome, RuntimeHarnessError> {
        plan.validate()?;
        let artifact_store = plan
            .artifact_root
            .as_ref()
            .map(|artifact_root| {
                RuntimeCaptureArtifactStore::prepare(
                    artifact_root.clone(),
                    plan.run_id.clone(),
                    plan.operation,
                )
            })
            .transpose()?;

        let started_at = Instant::now();
        let deadline = started_at + plan.timeout;
        let mut command = plan.command.to_command();
        configure_runtime_process_tree(&mut command, plan.operation)?;
        let mut child = command.spawn().map_err(|error| {
            RuntimeHarnessError::new(
                RuntimeHarnessErrorKind::LaunchFailed,
                plan.operation,
                format!(
                    "failed to launch runtime command {}: {error}",
                    plan.command.program.display()
                ),
            )
            .with_detail("ioKind", error.kind().to_string())
        })?;
        let process_id = child.id();
        let mut artifacts = Vec::new();
        let hook_run = RuntimeHookRun {
            plan,
            process_id,
            artifact_store: artifact_store.as_ref(),
        };

        if let Err(error) = self.run_hooks(
            RuntimeCaptureBoundary::AfterLaunch,
            hook_run,
            hooks,
            &mut artifacts,
            bounded_hook_timeout(plan, deadline),
        ) {
            let cleanup =
                terminate_runtime_process(&mut child, plan.shutdown_grace, plan.poll_interval);
            return Err(error.with_process_id(process_id).with_cleanup(cleanup));
        }

        let status =
            match wait_for_child_exit(&mut child, remaining_until(deadline), plan.poll_interval) {
                Ok(Some(status)) => status,
                Ok(None) => {
                    let before_terminate_error = self.run_hooks(
                        RuntimeCaptureBoundary::BeforeTerminate,
                        hook_run,
                        hooks,
                        &mut artifacts,
                        plan.hook_timeout,
                    );
                    let cleanup = terminate_runtime_process(
                        &mut child,
                        plan.shutdown_grace,
                        plan.poll_interval,
                    );
                    let mut error = RuntimeHarnessError::new(
                        RuntimeHarnessErrorKind::Timeout,
                        plan.operation,
                        format!("runtime command exceeded timeout of {:?}", plan.timeout),
                    )
                    .with_process_id(process_id)
                    .with_cleanup(cleanup)
                    .with_detail("timeoutMillis", plan.timeout.as_millis().to_string());
                    if let Err(hook_error) = before_terminate_error {
                        error = error
                            .with_detail("beforeTerminateHookError", hook_error.code())
                            .with_detail("beforeTerminateHookMessage", hook_error.message);
                    }
                    return Err(error);
                }
                Err(error) => {
                    let cleanup = terminate_runtime_process(
                        &mut child,
                        plan.shutdown_grace,
                        plan.poll_interval,
                    );
                    return Err(RuntimeHarnessError::new(
                        RuntimeHarnessErrorKind::ProcessWaitFailed,
                        plan.operation,
                        format!("failed while waiting for runtime process: {error}"),
                    )
                    .with_process_id(process_id)
                    .with_cleanup(cleanup)
                    .with_detail("ioKind", error.kind().to_string()));
                }
            };

        self.run_hooks(
            RuntimeCaptureBoundary::AfterExit,
            hook_run,
            hooks,
            &mut artifacts,
            plan.hook_timeout,
        )?;

        let exit = RuntimeProcessExit::from_status(status);
        if !exit.success {
            let mut error = RuntimeHarnessError::new(
                RuntimeHarnessErrorKind::ProcessFailed,
                plan.operation,
                "runtime process exited with a non-zero status",
            )
            .with_process_id(process_id);
            if let Some(code) = exit.code {
                error = error.with_detail("exitCode", code.to_string());
            }
            return Err(error);
        }

        Ok(RuntimeLaunchCaptureOutcome {
            process_id,
            exit,
            elapsed: started_at.elapsed(),
            artifacts,
        })
    }

    fn run_hooks(
        &self,
        boundary: RuntimeCaptureBoundary,
        run: RuntimeHookRun<'_>,
        hooks: &mut RuntimeCaptureHooks,
        artifacts: &mut Vec<RuntimeCapturedArtifact>,
        hook_timeout: Duration,
    ) -> Result<(), RuntimeHarnessError> {
        let mut index = 0;
        while index < hooks.hooks.len() {
            if hooks.hooks[index].boundary() != boundary {
                index += 1;
                continue;
            }
            let hook = hooks.hooks.remove(index);
            let context = RuntimeCaptureContext::new(
                run.plan.operation,
                boundary,
                run.process_id,
                run.plan.run_id.clone(),
                run.artifact_store.cloned(),
            );
            match run_capture_hook_with_timeout(hook, context, hook_timeout) {
                Ok((hook, hook_artifacts)) => {
                    artifacts.extend(hook_artifacts);
                    hooks.hooks.insert(index, hook);
                    index += 1;
                }
                Err(RuntimeHookExecutionError::Failed { hook, error }) => {
                    hooks.hooks.insert(index, hook);
                    return Err(error
                        .with_boundary(boundary)
                        .with_process_id(run.process_id));
                }
                Err(RuntimeHookExecutionError::Unrecoverable(error)) => return Err(error),
            }
        }
        Ok(())
    }
}

struct RuntimeHookThreadResult {
    hook: Box<dyn RuntimeCaptureHook>,
    result: Result<Vec<RuntimeCapturedArtifact>, RuntimeHarnessError>,
}

enum RuntimeHookExecutionError {
    Failed {
        hook: Box<dyn RuntimeCaptureHook>,
        error: RuntimeHarnessError,
    },
    Unrecoverable(RuntimeHarnessError),
}

fn run_capture_hook_with_timeout(
    mut hook: Box<dyn RuntimeCaptureHook>,
    mut context: RuntimeCaptureContext,
    timeout: Duration,
) -> Result<(Box<dyn RuntimeCaptureHook>, Vec<RuntimeCapturedArtifact>), RuntimeHookExecutionError>
{
    if timeout.is_zero() {
        return Err(RuntimeHookExecutionError::Unrecoverable(
            capture_hook_timeout_error(
                context.operation,
                context.boundary,
                context.process_id,
                timeout,
            ),
        ));
    }

    let operation = context.operation;
    let boundary = context.boundary;
    let process_id = context.process_id;
    let (sender, receiver) = mpsc::channel();
    thread::spawn(move || {
        let result = match panic::catch_unwind(AssertUnwindSafe(|| hook.capture(&mut context))) {
            Ok(Ok(())) => Ok(context.into_artifacts()),
            Ok(Err(error)) => Err(error),
            Err(payload) => Err(RuntimeHarnessError::capture_failed(
                operation,
                format!(
                    "capture hook panicked at {}: {}",
                    boundary.as_str(),
                    panic_payload_message(payload.as_ref())
                ),
            )
            .with_boundary(boundary)
            .with_process_id(process_id)),
        };
        let _ = sender.send(RuntimeHookThreadResult { hook, result });
    });

    match receiver.recv_timeout(timeout) {
        Ok(RuntimeHookThreadResult {
            hook,
            result: Ok(artifacts),
        }) => Ok((hook, artifacts)),
        Ok(RuntimeHookThreadResult {
            hook,
            result: Err(error),
        }) => Err(RuntimeHookExecutionError::Failed { hook, error }),
        Err(mpsc::RecvTimeoutError::Timeout) => Err(RuntimeHookExecutionError::Unrecoverable(
            capture_hook_timeout_error(operation, boundary, process_id, timeout),
        )),
        Err(mpsc::RecvTimeoutError::Disconnected) => Err(RuntimeHookExecutionError::Unrecoverable(
            RuntimeHarnessError::capture_failed(
                operation,
                format!(
                    "capture hook worker stopped before reporting {}",
                    boundary.as_str()
                ),
            )
            .with_boundary(boundary)
            .with_process_id(process_id),
        )),
    }
}

fn capture_hook_timeout_error(
    operation: RuntimeOperation,
    boundary: RuntimeCaptureBoundary,
    process_id: u32,
    timeout: Duration,
) -> RuntimeHarnessError {
    RuntimeHarnessError::new(
        RuntimeHarnessErrorKind::CaptureTimeout,
        operation,
        format!(
            "capture hook at {} exceeded timeout of {:?}",
            boundary.as_str(),
            timeout
        ),
    )
    .with_boundary(boundary)
    .with_process_id(process_id)
    .with_detail("hookTimeoutMillis", timeout.as_millis().to_string())
}

fn panic_payload_message(payload: &(dyn Any + Send)) -> String {
    if let Some(message) = payload.downcast_ref::<&str>() {
        return (*message).to_string();
    }
    if let Some(message) = payload.downcast_ref::<String>() {
        return message.clone();
    }
    "non-string panic payload".to_string()
}

fn bounded_hook_timeout(plan: &RuntimeLaunchCapturePlan, deadline: Instant) -> Duration {
    let remaining = remaining_until(deadline);
    if remaining < plan.hook_timeout {
        remaining
    } else {
        plan.hook_timeout
    }
}

fn remaining_until(deadline: Instant) -> Duration {
    deadline
        .checked_duration_since(Instant::now())
        .unwrap_or(Duration::ZERO)
}

#[cfg(unix)]
fn configure_runtime_process_tree(
    command: &mut Command,
    _operation: RuntimeOperation,
) -> Result<(), RuntimeHarnessError> {
    use std::os::unix::process::CommandExt;

    command.process_group(0);
    Ok(())
}

#[cfg(not(unix))]
fn configure_runtime_process_tree(
    _command: &mut Command,
    operation: RuntimeOperation,
) -> Result<(), RuntimeHarnessError> {
    Err(RuntimeHarnessError::new(
        RuntimeHarnessErrorKind::InvalidPlan,
        operation,
        "runtime launch process-tree cleanup is unsupported on this platform",
    )
    .with_detail(
        "cleanupScope",
        RuntimeProcessCleanupScope::ProcessTree.as_str(),
    ))
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

fn wait_for_child_exit(
    child: &mut Child,
    timeout: Duration,
    poll_interval: Duration,
) -> io::Result<Option<ExitStatus>> {
    let started_at = Instant::now();
    loop {
        if let Some(status) = child.try_wait()? {
            return Ok(Some(status));
        }
        let elapsed = started_at.elapsed();
        if elapsed >= timeout {
            return Ok(None);
        }
        let remaining = timeout.saturating_sub(elapsed);
        thread::sleep(if remaining < poll_interval {
            remaining
        } else {
            poll_interval
        });
    }
}

fn terminate_runtime_process(
    child: &mut Child,
    shutdown_grace: Duration,
    poll_interval: Duration,
) -> RuntimeProcessCleanup {
    if matches!(child.try_wait(), Ok(Some(_))) {
        return RuntimeProcessCleanup {
            attempted: false,
            completed: true,
            scope: RuntimeProcessCleanupScope::ProcessTree,
            escalated: false,
        };
    }

    let attempted = terminate_process_tree(child.id()).is_ok();
    match wait_for_runtime_process_tree_exit(child, child.id(), shutdown_grace, poll_interval) {
        Ok(true) => {
            return RuntimeProcessCleanup {
                attempted,
                completed: true,
                scope: RuntimeProcessCleanupScope::ProcessTree,
                escalated: false,
            };
        }
        Ok(false) => {}
        Err(_) => {
            return RuntimeProcessCleanup {
                attempted,
                completed: false,
                scope: RuntimeProcessCleanupScope::ProcessTree,
                escalated: false,
            };
        }
    }

    let escalated = kill_process_tree(child.id()).is_ok();
    match wait_for_runtime_process_tree_exit(child, child.id(), shutdown_grace, poll_interval) {
        Ok(true) => RuntimeProcessCleanup {
            attempted,
            completed: true,
            scope: RuntimeProcessCleanupScope::ProcessTree,
            escalated,
        },
        Ok(false) | Err(_) => RuntimeProcessCleanup {
            attempted,
            completed: false,
            scope: RuntimeProcessCleanupScope::ProcessTree,
            escalated,
        },
    }
}

fn wait_for_runtime_process_tree_exit(
    child: &mut Child,
    process_id: u32,
    timeout: Duration,
    poll_interval: Duration,
) -> io::Result<bool> {
    let started_at = Instant::now();
    loop {
        let child_exited = child.try_wait()?.is_some();
        if child_exited && !process_tree_exists(process_id)? {
            return Ok(true);
        }
        let elapsed = started_at.elapsed();
        if elapsed >= timeout {
            return Ok(false);
        }
        let remaining = timeout.saturating_sub(elapsed);
        thread::sleep(if remaining < poll_interval {
            remaining
        } else {
            poll_interval
        });
    }
}

#[cfg(unix)]
fn terminate_process_tree(process_id: u32) -> io::Result<()> {
    unix_signal_process_group(process_id, unix_signals::SIGTERM)
}

#[cfg(unix)]
fn kill_process_tree(process_id: u32) -> io::Result<()> {
    unix_signal_process_group(process_id, unix_signals::SIGKILL)
}

#[cfg(unix)]
fn process_tree_exists(process_id: u32) -> io::Result<bool> {
    match unix_signal_process_group_raw(process_id, 0) {
        Ok(()) => Ok(true),
        Err(error) if error.raw_os_error() == Some(unix_signals::ESRCH) => Ok(false),
        Err(error) => Err(error),
    }
}

#[cfg(not(unix))]
fn terminate_process_tree(_process_id: u32) -> io::Result<()> {
    Err(io::Error::new(
        io::ErrorKind::Unsupported,
        "process-tree cleanup is unsupported on this platform",
    ))
}

#[cfg(not(unix))]
fn kill_process_tree(_process_id: u32) -> io::Result<()> {
    Err(io::Error::new(
        io::ErrorKind::Unsupported,
        "process-tree cleanup is unsupported on this platform",
    ))
}

#[cfg(not(unix))]
fn process_tree_exists(_process_id: u32) -> io::Result<bool> {
    Err(io::Error::new(
        io::ErrorKind::Unsupported,
        "process-tree cleanup is unsupported on this platform",
    ))
}

#[cfg(unix)]
fn unix_signal_process_group(process_id: u32, signal: i32) -> io::Result<()> {
    match unix_signal_process_group_raw(process_id, signal) {
        Ok(()) => Ok(()),
        Err(error) if error.raw_os_error() == Some(unix_signals::ESRCH) => Ok(()),
        Err(error) => Err(error),
    }
}

#[cfg(unix)]
fn unix_signal_process_group_raw(process_id: u32, signal: i32) -> io::Result<()> {
    let process_group_id = i32::try_from(process_id).map_err(|_| {
        io::Error::new(
            io::ErrorKind::InvalidInput,
            format!("process id {process_id} cannot be represented as a Unix process group id"),
        )
    })?;
    let result = unsafe { unix_signals::kill(-process_group_id, signal) };
    if result == 0 {
        return Ok(());
    }
    Err(io::Error::last_os_error())
}

#[cfg(unix)]
mod unix_signals {
    pub const ESRCH: i32 = 3;
    pub const SIGTERM: i32 = 15;
    pub const SIGKILL: i32 = 9;

    unsafe extern "C" {
        pub fn kill(pid: i32, sig: i32) -> i32;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::process::Command as StdCommand;
    use std::sync::{
        Arc,
        atomic::{AtomicBool, AtomicUsize, Ordering},
    };
    use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

    struct FakeTraceAdapter;

    const HARNESS_RUN_ID: &str = "019ed003-0000-7000-8000-000000001014";
    const HARNESS_SCREENSHOT_ID: &str = "019ed003-0000-7000-8000-000000004014";
    const HARNESS_FRAME_ID: &str = "019ed003-0000-7000-8000-000000004015";

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

    fn harness_child_command(test_name: &str) -> RuntimeLaunchCommand {
        RuntimeLaunchCommand::new(std::env::current_exe().unwrap()).args([
            "--exact",
            test_name,
            "--ignored",
            "--nocapture",
        ])
    }

    fn harness_child_command_with_env(
        test_name: &str,
        env: &[(&str, &Path)],
    ) -> RuntimeLaunchCommand {
        let mut command = harness_child_command(test_name);
        for (key, value) in env {
            command = command.env(*key, value.display().to_string());
        }
        command
    }

    fn wait_for_path(path: &Path, timeout: Duration) -> bool {
        let started_at = Instant::now();
        while started_at.elapsed() < timeout {
            if path.exists() {
                return true;
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        path.exists()
    }

    #[test]
    #[ignore]
    fn harness_child_exits() {}

    #[test]
    #[ignore]
    fn harness_child_sleeps() {
        std::thread::sleep(Duration::from_secs(5));
    }

    #[test]
    #[ignore]
    fn harness_child_spawns_grandchild() {
        let heartbeat_path =
            PathBuf::from(std::env::var("UTSUSHI_TEST_GRANDCHILD_HEARTBEAT").unwrap());
        let pid_path = PathBuf::from(std::env::var("UTSUSHI_TEST_GRANDCHILD_PID").unwrap());
        let mut child = StdCommand::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "tests::harness_grandchild_heartbeats",
                "--ignored",
                "--nocapture",
            ])
            .env("UTSUSHI_TEST_GRANDCHILD_HEARTBEAT", &heartbeat_path)
            .env("UTSUSHI_TEST_GRANDCHILD_PID", &pid_path)
            .spawn()
            .unwrap();
        assert!(wait_for_path(&pid_path, Duration::from_secs(1)));
        loop {
            if let Ok(Some(_)) = child.try_wait() {
                panic!("grandchild exited before harness cleanup");
            }
            std::thread::sleep(Duration::from_millis(50));
        }
    }

    #[test]
    #[ignore]
    fn harness_grandchild_heartbeats() {
        let heartbeat_path =
            PathBuf::from(std::env::var("UTSUSHI_TEST_GRANDCHILD_HEARTBEAT").unwrap());
        let pid_path = PathBuf::from(std::env::var("UTSUSHI_TEST_GRANDCHILD_PID").unwrap());
        fs::write(&pid_path, std::process::id().to_string()).unwrap();
        let mut heartbeat = 0_u64;
        loop {
            fs::write(&heartbeat_path, heartbeat.to_string()).unwrap();
            heartbeat += 1;
            std::thread::sleep(Duration::from_millis(20));
        }
    }

    struct WritingCaptureHook {
        boundary: RuntimeCaptureBoundary,
        calls: Arc<AtomicUsize>,
    }

    impl WritingCaptureHook {
        fn new(boundary: RuntimeCaptureBoundary, calls: Arc<AtomicUsize>) -> Self {
            Self { boundary, calls }
        }
    }

    impl RuntimeCaptureHook for WritingCaptureHook {
        fn boundary(&self) -> RuntimeCaptureBoundary {
            self.boundary
        }

        fn capture(
            &mut self,
            context: &mut RuntimeCaptureContext,
        ) -> Result<(), RuntimeHarnessError> {
            self.calls.fetch_add(1, Ordering::SeqCst);
            assert_eq!(context.boundary, self.boundary);
            assert_eq!(context.run_id, HARNESS_RUN_ID);
            context.write_artifact(
                RuntimeArtifactKind::Screenshot,
                HARNESS_SCREENSHOT_ID,
                Some("image/png".to_string()),
                b"runtime screenshot bytes",
            )?;
            context.write_artifact(
                RuntimeArtifactKind::FrameCapture,
                HARNESS_FRAME_ID,
                Some("image/png".to_string()),
                b"runtime frame capture bytes",
            )?;
            Ok(())
        }
    }

    struct ArtifactRequiredHook;

    impl RuntimeCaptureHook for ArtifactRequiredHook {
        fn boundary(&self) -> RuntimeCaptureBoundary {
            RuntimeCaptureBoundary::AfterLaunch
        }

        fn capture(
            &mut self,
            context: &mut RuntimeCaptureContext,
        ) -> Result<(), RuntimeHarnessError> {
            context.write_artifact(
                RuntimeArtifactKind::Screenshot,
                HARNESS_SCREENSHOT_ID,
                Some("image/png".to_string()),
                b"requires an artifact root",
            )?;
            Ok(())
        }
    }

    struct SleepingCaptureHook {
        boundary: RuntimeCaptureBoundary,
        started: Arc<AtomicBool>,
        sleep: Duration,
    }

    impl RuntimeCaptureHook for SleepingCaptureHook {
        fn boundary(&self) -> RuntimeCaptureBoundary {
            self.boundary
        }

        fn capture(
            &mut self,
            _context: &mut RuntimeCaptureContext,
        ) -> Result<(), RuntimeHarnessError> {
            self.started.store(true, Ordering::SeqCst);
            std::thread::sleep(self.sleep);
            Ok(())
        }
    }

    struct PanickingCaptureHook {
        boundary: RuntimeCaptureBoundary,
    }

    impl RuntimeCaptureHook for PanickingCaptureHook {
        fn boundary(&self) -> RuntimeCaptureBoundary {
            self.boundary
        }

        fn capture(
            &mut self,
            _context: &mut RuntimeCaptureContext,
        ) -> Result<(), RuntimeHarnessError> {
            std::panic::resume_unwind(Box::new("intentional capture hook panic"))
        }
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
    fn launch_capture_harness_runs_process_and_persists_hook_artifacts() {
        let temp = temp_root("harness-success");
        let artifact_root = temp.join("runtime-artifacts");
        let plan = RuntimeLaunchCapturePlan::new(
            HARNESS_RUN_ID,
            RuntimeOperation::Capture,
            harness_child_command("tests::harness_child_exits"),
        )
        .with_artifact_root(&artifact_root)
        .with_timeout(Duration::from_secs(5))
        .with_shutdown_grace(Duration::from_secs(1));
        let harness = RuntimeLaunchCaptureHarness::new();
        let calls = Arc::new(AtomicUsize::new(0));
        let mut hooks = RuntimeCaptureHooks::new();
        hooks.push(WritingCaptureHook::new(
            RuntimeCaptureBoundary::AfterLaunch,
            Arc::clone(&calls),
        ));

        let outcome = harness.run(&plan, &mut hooks).unwrap();

        assert!(outcome.exit.success);
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        assert_eq!(outcome.artifacts.len(), 2);
        let screenshot = &outcome.artifacts[0];
        assert_eq!(screenshot.artifact_kind, RuntimeArtifactKind::Screenshot);
        assert_eq!(
            screenshot.boundary,
            Some(RuntimeCaptureBoundary::AfterLaunch)
        );
        assert!(screenshot.path.starts_with(&artifact_root));
        assert!(screenshot.path.is_file());
        assert_eq!(
            fs::read(&screenshot.path).unwrap(),
            b"runtime screenshot bytes"
        );
        let frame_capture = &outcome.artifacts[1];
        assert_eq!(
            frame_capture.artifact_kind,
            RuntimeArtifactKind::FrameCapture
        );
        assert!(frame_capture.path.starts_with(&artifact_root));
        assert!(frame_capture.path.is_file());

        let artifact_ref = screenshot.artifact_ref_json();
        assert_eq!(artifact_ref["artifactKind"], "screenshot");
        assert_eq!(
            artifact_ref["uri"],
            format!(
                "{}/{}/screenshots/{}.png",
                RUNTIME_ARTIFACT_URI_ROOT, HARNESS_RUN_ID, HARNESS_SCREENSHOT_ID
            )
        );
        assert!(artifact_ref.get("data").is_none());
        assert!(artifact_ref.get("bytes").is_none());
        assert!(artifact_ref.get("localPath").is_none());
        assert!(artifact_root.join(RUNTIME_ARTIFACT_ROOT_MARKER).is_file());
        let _ = fs::remove_dir_all(temp);
    }

    #[test]
    fn launch_capture_harness_times_out_and_reaps_child() {
        let plan = RuntimeLaunchCapturePlan::new(
            HARNESS_RUN_ID,
            RuntimeOperation::Capture,
            harness_child_command("tests::harness_child_sleeps"),
        )
        .with_timeout(Duration::from_millis(50))
        .with_shutdown_grace(Duration::from_secs(1))
        .with_poll_interval(Duration::from_millis(5));
        let harness = RuntimeLaunchCaptureHarness::new();
        let started_at = Instant::now();
        let mut hooks = RuntimeCaptureHooks::new();

        let error = harness.run(&plan, &mut hooks).unwrap_err();

        assert!(started_at.elapsed() < Duration::from_secs(3));
        assert_eq!(error.kind, RuntimeHarnessErrorKind::Timeout);
        assert_eq!(error.code(), "runtime_launch_timeout");
        let cleanup = error.cleanup.unwrap();
        assert!(cleanup.attempted);
        assert!(cleanup.completed);
        assert_eq!(cleanup.scope, RuntimeProcessCleanupScope::ProcessTree);
        assert!(error.process_id.is_some());
    }

    #[test]
    fn launch_failures_report_semantic_errors() {
        let temp = temp_root("harness-launch-error");
        let missing_command = temp.join("missing-runtime-command");
        let plan = RuntimeLaunchCapturePlan::new(
            HARNESS_RUN_ID,
            RuntimeOperation::Capture,
            RuntimeLaunchCommand::new(&missing_command),
        );
        let harness = RuntimeLaunchCaptureHarness::new();
        let mut hooks = RuntimeCaptureHooks::new();

        let error = harness.run(&plan, &mut hooks).unwrap_err();

        assert_eq!(error.kind, RuntimeHarnessErrorKind::LaunchFailed);
        let semantic = error.to_json();
        assert_eq!(semantic["errorCode"], "runtime_launch_failed");
        assert_eq!(semantic["operation"], "capture");
        assert!(
            semantic["message"]
                .as_str()
                .unwrap()
                .contains("failed to launch")
        );

        let finding = error.to_validation_finding(
            "019ed003-0000-7000-8000-000000009014",
            "unsupported_runtime_feature",
            "critical",
            EvidenceTier::E1,
        );
        assert_eq!(finding["findingKind"], "unsupported_runtime_feature");
        assert!(
            finding["message"]
                .as_str()
                .unwrap()
                .contains("runtime_launch_failed")
        );
        let _ = fs::remove_dir_all(temp);
    }

    #[test]
    fn capture_hooks_require_managed_artifact_store_boundary() {
        let plan = RuntimeLaunchCapturePlan::new(
            HARNESS_RUN_ID,
            RuntimeOperation::Capture,
            harness_child_command("tests::harness_child_sleeps"),
        )
        .with_timeout(Duration::from_secs(5))
        .with_shutdown_grace(Duration::from_secs(1))
        .with_poll_interval(Duration::from_millis(5));
        let harness = RuntimeLaunchCaptureHarness::new();
        let mut hooks = RuntimeCaptureHooks::new();
        hooks.push(ArtifactRequiredHook);

        let error = harness.run(&plan, &mut hooks).unwrap_err();

        assert_eq!(
            error.kind,
            RuntimeHarnessErrorKind::ArtifactStoreUnavailable
        );
        assert_eq!(error.boundary, Some(RuntimeCaptureBoundary::AfterLaunch));
        let cleanup = error.cleanup.unwrap();
        assert!(cleanup.attempted);
        assert!(cleanup.completed);
        assert_eq!(cleanup.scope, RuntimeProcessCleanupScope::ProcessTree);
        assert_eq!(
            error.to_json()["errorCode"],
            "runtime_artifact_store_unavailable"
        );
    }

    #[test]
    fn after_launch_hook_timeout_cleans_up_runtime_process() {
        let plan = RuntimeLaunchCapturePlan::new(
            HARNESS_RUN_ID,
            RuntimeOperation::Capture,
            harness_child_command("tests::harness_child_sleeps"),
        )
        .with_timeout(Duration::from_secs(5))
        .with_hook_timeout(Duration::from_millis(50))
        .with_shutdown_grace(Duration::from_secs(1))
        .with_poll_interval(Duration::from_millis(5));
        let harness = RuntimeLaunchCaptureHarness::new();
        let started = Arc::new(AtomicBool::new(false));
        let mut hooks = RuntimeCaptureHooks::new();
        hooks.push(SleepingCaptureHook {
            boundary: RuntimeCaptureBoundary::AfterLaunch,
            started: Arc::clone(&started),
            sleep: Duration::from_secs(2),
        });
        let started_at = Instant::now();

        let error = harness.run(&plan, &mut hooks).unwrap_err();

        assert!(started.load(Ordering::SeqCst));
        assert!(started_at.elapsed() < Duration::from_secs(2));
        assert_eq!(error.kind, RuntimeHarnessErrorKind::CaptureTimeout);
        assert_eq!(error.boundary, Some(RuntimeCaptureBoundary::AfterLaunch));
        assert_eq!(error.code(), "runtime_capture_timeout");
        let cleanup = error.cleanup.unwrap();
        assert!(cleanup.attempted);
        assert!(cleanup.completed);
        assert_eq!(cleanup.scope, RuntimeProcessCleanupScope::ProcessTree);
    }

    #[test]
    fn panicking_capture_hooks_are_contained_and_cleanup_runtime_process() {
        let plan = RuntimeLaunchCapturePlan::new(
            HARNESS_RUN_ID,
            RuntimeOperation::Capture,
            harness_child_command("tests::harness_child_sleeps"),
        )
        .with_timeout(Duration::from_secs(5))
        .with_hook_timeout(Duration::from_secs(1))
        .with_shutdown_grace(Duration::from_secs(1))
        .with_poll_interval(Duration::from_millis(5));
        let harness = RuntimeLaunchCaptureHarness::new();
        let mut hooks = RuntimeCaptureHooks::new();
        hooks.push(PanickingCaptureHook {
            boundary: RuntimeCaptureBoundary::AfterLaunch,
        });

        let error = harness.run(&plan, &mut hooks).unwrap_err();

        assert_eq!(error.kind, RuntimeHarnessErrorKind::CaptureFailed);
        assert_eq!(error.boundary, Some(RuntimeCaptureBoundary::AfterLaunch));
        assert!(error.message.contains("capture hook panicked"));
        let cleanup = error.cleanup.unwrap();
        assert!(cleanup.attempted);
        assert!(cleanup.completed);
        assert_eq!(cleanup.scope, RuntimeProcessCleanupScope::ProcessTree);
    }

    #[test]
    fn before_terminate_hook_timeout_does_not_delay_cleanup() {
        let plan = RuntimeLaunchCapturePlan::new(
            HARNESS_RUN_ID,
            RuntimeOperation::Capture,
            harness_child_command("tests::harness_child_sleeps"),
        )
        .with_timeout(Duration::from_millis(50))
        .with_hook_timeout(Duration::from_millis(50))
        .with_shutdown_grace(Duration::from_secs(1))
        .with_poll_interval(Duration::from_millis(5));
        let harness = RuntimeLaunchCaptureHarness::new();
        let started = Arc::new(AtomicBool::new(false));
        let mut hooks = RuntimeCaptureHooks::new();
        hooks.push(SleepingCaptureHook {
            boundary: RuntimeCaptureBoundary::BeforeTerminate,
            started: Arc::clone(&started),
            sleep: Duration::from_secs(2),
        });
        let started_at = Instant::now();

        let error = harness.run(&plan, &mut hooks).unwrap_err();

        assert!(started.load(Ordering::SeqCst));
        assert!(started_at.elapsed() < Duration::from_secs(2));
        assert_eq!(error.kind, RuntimeHarnessErrorKind::Timeout);
        assert!(
            error
                .details
                .iter()
                .any(|(key, value)| key == "beforeTerminateHookError"
                    && value == "runtime_capture_timeout")
        );
        let cleanup = error.cleanup.unwrap();
        assert!(cleanup.attempted);
        assert!(cleanup.completed);
        assert_eq!(cleanup.scope, RuntimeProcessCleanupScope::ProcessTree);
    }

    #[cfg(unix)]
    #[test]
    fn timeout_cleanup_terminates_runtime_process_tree() {
        let temp = temp_root("process-tree");
        let heartbeat_path = temp.join("grandchild-heartbeat");
        let pid_path = temp.join("grandchild.pid");
        let plan = RuntimeLaunchCapturePlan::new(
            HARNESS_RUN_ID,
            RuntimeOperation::Capture,
            harness_child_command_with_env(
                "tests::harness_child_spawns_grandchild",
                &[
                    ("UTSUSHI_TEST_GRANDCHILD_HEARTBEAT", &heartbeat_path),
                    ("UTSUSHI_TEST_GRANDCHILD_PID", &pid_path),
                ],
            ),
        )
        .with_timeout(Duration::from_millis(250))
        .with_shutdown_grace(Duration::from_secs(1))
        .with_poll_interval(Duration::from_millis(5));
        let harness = RuntimeLaunchCaptureHarness::new();
        let mut hooks = RuntimeCaptureHooks::new();

        let error = harness.run(&plan, &mut hooks).unwrap_err();

        assert_eq!(error.kind, RuntimeHarnessErrorKind::Timeout);
        let cleanup = error.cleanup.unwrap();
        assert!(cleanup.attempted);
        assert!(cleanup.completed);
        assert_eq!(cleanup.scope, RuntimeProcessCleanupScope::ProcessTree);
        assert!(pid_path.is_file(), "grandchild should have started");
        assert!(
            heartbeat_path.is_file(),
            "grandchild should have written at least one heartbeat"
        );
        let heartbeat_after_cleanup = fs::read_to_string(&heartbeat_path).unwrap();
        std::thread::sleep(Duration::from_millis(150));
        assert_eq!(
            fs::read_to_string(&heartbeat_path).unwrap(),
            heartbeat_after_cleanup,
            "grandchild heartbeat changed after process-tree cleanup"
        );
        let _ = fs::remove_dir_all(temp);
    }

    #[cfg(not(unix))]
    #[test]
    fn launch_capture_harness_fails_closed_without_process_tree_cleanup_support() {
        let plan = RuntimeLaunchCapturePlan::new(
            HARNESS_RUN_ID,
            RuntimeOperation::Capture,
            harness_child_command("tests::harness_child_exits"),
        );
        let harness = RuntimeLaunchCaptureHarness::new();
        let mut hooks = RuntimeCaptureHooks::new();

        let error = harness.run(&plan, &mut hooks).unwrap_err();

        assert_eq!(error.kind, RuntimeHarnessErrorKind::InvalidPlan);
        assert!(
            error
                .message
                .contains("process-tree cleanup is unsupported")
        );
        assert!(
            error
                .details
                .iter()
                .any(|(key, value)| key == "cleanupScope" && value == "process_tree")
        );
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
