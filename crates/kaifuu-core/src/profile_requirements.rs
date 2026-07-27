use super::*;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProfileRequirement {
    pub category: RequirementCategory,
    pub key: String,
    pub status: RequirementStatus,
    pub description: String,
    pub placeholder: Option<String>,
    pub secret: bool,
}

impl ProfileRequirement {
    pub fn sort_key(&self) -> (String, String, String) {
        (
            serde_json::to_string(&self.category).unwrap_or_default(),
            self.key.clone(),
            serde_json::to_string(&self.status).unwrap_or_default(),
        )
    }

    pub fn redacted_for_report(&self) -> Self {
        Self {
            category: self.category.clone(),
            key: redact_for_log_or_report(&self.key),
            status: self.status.clone(),
            description: redact_for_log_or_report(&self.description),
            placeholder: self.placeholder.as_deref().map(redact_for_log_or_report),
            secret: self.secret,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RequirementCategory {
    File,
    Platform,
    SecretKey,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RequirementStatus {
    Satisfied,
    Missing,
    NotRequired,
    Unsupported,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProfileValidationResult {
    pub schema_version: String,
    pub profile_id: Option<String>,
    pub status: OperationStatus,
    pub failures: Vec<ProfileValidationFailure>,
    pub requirements: Vec<ProfileRequirement>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProfileValidationFailure {
    pub code: String,
    pub field: String,
    pub message: String,
}

impl ProfileValidationResult {
    pub fn redacted_for_report(&self) -> Self {
        Self {
            schema_version: self.schema_version.clone(),
            profile_id: self.profile_id.as_deref().map(redact_for_log_or_report),
            status: self.status.clone(),
            failures: self
                .failures
                .iter()
                .map(ProfileValidationFailure::redacted_for_report)
                .collect(),
            requirements: self
                .requirements
                .iter()
                .map(ProfileRequirement::redacted_for_report)
                .collect(),
        }
    }
}

impl ProfileValidationFailure {
    pub(crate) fn redacted_for_report(&self) -> Self {
        Self {
            code: redact_for_log_or_report(&self.code),
            field: redact_for_log_or_report(&self.field),
            message: redact_for_log_or_report(&self.message),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AssetProfile {
    pub asset_id: String,
    pub path: String,
    pub asset_kind: AssetKind,
    pub text_surfaces: Vec<TextSurface>,
    pub source_hash: Option<String>,
    pub patching: CapabilityReport,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AssetKind {
    Script,
    Database,
    Metadata,
    Image,
    Audio,
    Archive,
    Unknown,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TextSurface {
    Dialogue,
    Narration,
    SpeakerName,
    ChoiceLabel,
    UiLabel,
    TutorialText,
    DatabaseEntry,
    SongTitle,
    ImageText,
    MetadataText,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AssetList {
    pub adapter_id: String,
    pub assets: Vec<AssetProfile>,
}
