use std::str::FromStr;

use serde::{Deserialize, Deserializer, Serialize, Serializer};

use crate::{UtsushiResult, validate_runtime_artifact_uri};

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ObservationAdapterId {
    pub name: String,
    pub version: String,
}

impl ObservationAdapterId {
    pub fn validate(&self) -> UtsushiResult<()> {
        validate_required_metadata("adapterId.name", &self.name)?;
        validate_required_metadata("adapterId.version", &self.version)?;
        Ok(())
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ObservationEnvironment {
    pub runtime: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub engine: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub platform: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub display: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub locale: Option<String>,
}

impl ObservationEnvironment {
    pub fn validate(&self) -> UtsushiResult<()> {
        validate_required_metadata("environment.runtime", &self.runtime)?;
        Ok(())
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ObservationSourceRevision {
    pub source_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub revision_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub content_hash: Option<String>,
}

impl ObservationSourceRevision {
    pub fn validate(&self) -> UtsushiResult<()> {
        validate_required_metadata("sourceRevision.sourceId", &self.source_id)?;
        Ok(())
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ObservationBridgeRef {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bridge_unit_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_unit_key: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub runtime_object_id: Option<String>,
}

impl ObservationBridgeRef {
    pub fn validate(&self) -> UtsushiResult<()> {
        if is_absent_or_blank(self.bridge_unit_id.as_deref())
            && is_absent_or_blank(self.source_unit_key.as_deref())
            && is_absent_or_blank(self.runtime_object_id.as_deref())
        {
            return Err("observation bridge ref must identify a bridge unit, source unit, or runtime object".into());
        }
        Ok(())
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum ObservationRedactionStatus {
    NotRequired,
    Redacted,
}

impl ObservationRedactionStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::NotRequired => "not_required",
            Self::Redacted => "redacted",
        }
    }
}

impl FromStr for ObservationRedactionStatus {
    type Err = String;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        match value {
            "not_required" => Ok(Self::NotRequired),
            "redacted" => Ok(Self::Redacted),
            _ => Err(format!("unknown observation redaction status: {value}")),
        }
    }
}

impl Serialize for ObservationRedactionStatus {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        serializer.serialize_str(self.as_str())
    }
}

impl<'de> Deserialize<'de> for ObservationRedactionStatus {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let value = String::deserialize(deserializer)?;
        Self::from_str(&value).map_err(serde::de::Error::custom)
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ObservationRedactionMetadata {
    pub status: ObservationRedactionStatus,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub rules: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub redacted_fields: Vec<String>,
}

impl ObservationRedactionMetadata {
    pub fn not_required() -> Self {
        Self {
            status: ObservationRedactionStatus::NotRequired,
            rules: Vec::new(),
            redacted_fields: Vec::new(),
        }
    }

    pub fn redacted(rules: Vec<String>, redacted_fields: Vec<String>) -> Self {
        Self {
            status: ObservationRedactionStatus::Redacted,
            rules,
            redacted_fields,
        }
    }

    pub fn validate(&self) -> UtsushiResult<()> {
        match self.status {
            ObservationRedactionStatus::NotRequired => {
                if !self.rules.is_empty() || !self.redacted_fields.is_empty() {
                    return Err("observation redaction metadata with status not_required must not declare redaction rules or fields".into());
                }
            }
            ObservationRedactionStatus::Redacted => {
                if self.rules.is_empty() || self.redacted_fields.is_empty() {
                    return Err("redacted observation hook events must declare redaction rules and redacted fields".into());
                }
                for rule in &self.rules {
                    validate_required_metadata("redaction.rules[]", rule)?;
                }
                for field in &self.redacted_fields {
                    validate_required_metadata("redaction.redactedFields[]", field)?;
                }
            }
        }
        Ok(())
    }
}

// `deleted-hookPayload` + every payload variant
// (`ObservationTextPayload`, `ObservationChoicePayload`
// `ObservationChoiceOption`, `ObservationBranchPayload`
// `ObservationScenePayload`, `ObservationFramePayload`
// `ObservationErrorPayload`) deleted. The substrate observation surface is
// now the sink-set bridge (`crate::sink::TextLine` / `FrameArtifact`
// `AudioEvent`); choice / branch / scene / error payloads have no
// production consumer in the Sweetie HD ground-truth scope and are
// re-introduced only when an engine port pushes them through a typed
// sink contract.

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ObservationArtifactRef {
    pub artifact_id: String,
    pub artifact_kind: String,
    pub uri: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub media_type: Option<String>,
}

impl ObservationArtifactRef {
    pub fn validate(&self) -> UtsushiResult<()> {
        validate_required_metadata("payload.artifactRef.artifactId", &self.artifact_id)?;
        validate_required_metadata("payload.artifactRef.artifactKind", &self.artifact_kind)?;
        validate_runtime_artifact_uri(&self.uri)?;
        Ok(())
    }
}

fn validate_required_metadata(field: &str, value: &str) -> UtsushiResult<()> {
    if value.trim().is_empty() {
        return Err(format!("observation hook event missing required field {field}").into());
    }
    Ok(())
}

fn is_absent_or_blank(value: Option<&str>) -> bool {
    value.is_none_or(|value| value.trim().is_empty())
}
