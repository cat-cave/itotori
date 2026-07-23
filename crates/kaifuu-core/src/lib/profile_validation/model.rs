use super::*;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GameProfile {
    pub schema_version: String,
    pub profile_id: String,
    pub game_id: String,
    pub title: String,
    pub source_locale: String,
    pub engine: EngineProfile,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_fingerprint: Option<SourceFingerprint>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub key_requirements: Vec<KeyRequirement>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub archive_parameters: Vec<ArchiveParameter>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub helper_evidence: Option<HelperEvidence>,
    pub assets: Vec<AssetProfile>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub layered_access: Option<LayeredAccessProfile>,
    pub capabilities: Vec<CapabilityReport>,
    pub requirements: Vec<ProfileRequirement>,
    pub metadata: BTreeMap<String, String>,
}

impl GameProfile {
    pub fn normalize(&mut self) {
        for asset in &mut self.assets {
            asset
                .text_surfaces
                .sort_by_key(|surface| serde_json::to_string(surface).unwrap_or_default());
            asset.text_surfaces.dedup();
        }
        self.assets.sort_by_key(|asset| asset.asset_id.clone());
        if let Some(layered_access) = &mut self.layered_access {
            layered_access.normalize();
        }
        self.capabilities.sort_by_key(|report| {
            (
                serde_json::to_string(&report.capability).unwrap_or_default(),
                serde_json::to_string(&report.status).unwrap_or_default(),
                report.limitation.clone(),
            )
        });
        self.requirements.sort_by_key(ProfileRequirement::sort_key);
        self.key_requirements.sort_by_key(KeyRequirement::sort_key);
        self.archive_parameters
            .sort_by_key(ArchiveParameter::sort_key);
        if let Some(helper_evidence) = &mut self.helper_evidence {
            helper_evidence.normalize();
        }
    }

    /// Serialize into report-safe, canonical JSON.
    /// Public serialization always routes through the centralized report
    /// redaction policy (`redact_report_value`) so library callers cannot
    /// accidentally leak absolute paths, key material, helper dumps, or
    /// private text into a report/log/fixture. There is no raw public
    /// serialization path for `GameProfile`; the redaction cannot be bypassed
    /// through this API.
    pub fn stable_json(&self) -> KaifuuResult<String> {
        let mut normalized = self.clone();
        normalized.normalize();
        let value = redact_report_value(&serde_json::to_value(&normalized)?);
        Ok(format!("{}\n", serde_json::to_string_pretty(&value)?))
    }

    pub fn validate(&self) -> ProfileValidationResult {
        let Ok(value) = serde_json::to_value(self) else {
            return ProfileValidationResult {
                schema_version: PROFILE_SCHEMA_VERSION.to_string(),
                profile_id: Some(self.profile_id.clone()),
                status: OperationStatus::Failed,
                failures: vec![ProfileValidationFailure {
                    code: "profile_serialization_failed".to_string(),
                    field: "$".to_string(),
                    message: "profile could not be serialized for validation".to_string(),
                }],
                requirements: self.requirements.clone(),
            };
        };
        let mut validation = validate_profile_value(&value);
        if validation.requirements.is_empty() {
            validation.requirements.clone_from(&self.requirements);
        }
        validation
    }
}
