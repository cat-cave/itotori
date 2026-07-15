use std::str::FromStr;

use serde::{Deserialize, Deserializer, Serialize, Serializer};
use serde_json::Value;

use crate::UtsushiResult;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum RuntimeOperation {
    Trace,
    BranchDiscovery,
    Capture,
    SmokeValidation,
    ReplayReview,
}

impl RuntimeOperation {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Trace => "trace",
            Self::BranchDiscovery => "branch_discovery",
            Self::Capture => "capture",
            Self::SmokeValidation => "smoke_validation",
            Self::ReplayReview => "replay_review",
        }
    }

    pub fn required_capability(self) -> RuntimeCapability {
        match self {
            Self::Trace => RuntimeCapability::Trace,
            Self::BranchDiscovery => RuntimeCapability::BranchDiscovery,
            Self::Capture => RuntimeCapability::FrameCapture,
            Self::SmokeValidation => RuntimeCapability::SmokeValidation,
            Self::ReplayReview => RuntimeCapability::ReplayReview,
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

impl FromStr for EvidenceTier {
    type Err = String;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        match value {
            "E0" => Ok(Self::E0),
            "E1" => Ok(Self::E1),
            "E2" => Ok(Self::E2),
            "E3" => Ok(Self::E3),
            "E4" => Ok(Self::E4),
            _ => Err(format!("unknown evidence tier: {value}")),
        }
    }
}

impl Serialize for EvidenceTier {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        serializer.serialize_str(self.as_str())
    }
}

impl<'de> Deserialize<'de> for EvidenceTier {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let value = String::deserialize(deserializer)?;
        Self::from_str(&value).map_err(serde::de::Error::custom)
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
                Self::StaticTrace | Self::Launch | Self::TextTrace,
                RuntimeCapability::Trace
            ) | (Self::BranchDiscovery, RuntimeCapability::BranchDiscovery)
                | (
                    Self::FrameCapture | Self::Screenshot,
                    RuntimeCapability::FrameCapture
                )
                | (
                    Self::TextTrace | Self::FrameCapture | Self::Screenshot,
                    RuntimeCapability::SmokeValidation
                )
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
