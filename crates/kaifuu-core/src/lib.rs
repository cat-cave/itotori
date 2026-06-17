use std::collections::BTreeMap;
use std::fs;
use std::path::Path;

use serde::{Deserialize, Serialize};
use serde_json::Value;

pub type KaifuuResult<T> = Result<T, Box<dyn std::error::Error>>;
pub const PROFILE_SCHEMA_VERSION: &str = "0.1.0";

pub trait EngineAdapter {
    fn id(&self) -> &'static str;
    fn name(&self) -> &'static str;
    fn capabilities(&self) -> AdapterCapabilities;
    fn detect(&self, request: DetectRequest<'_>) -> KaifuuResult<DetectionResult>;
    fn profile(&self, request: ProfileRequest<'_>) -> KaifuuResult<GameProfile>;
    fn list_assets(&self, request: AssetListRequest<'_>) -> KaifuuResult<AssetList>;
    fn extract(&self, request: ExtractRequest<'_>) -> KaifuuResult<ExtractionResult>;
    fn patch(&self, request: PatchRequest<'_>) -> KaifuuResult<PatchResult>;
    fn verify(&self, request: VerifyRequest<'_>) -> KaifuuResult<VerificationResult>;
}

#[derive(Default)]
pub struct AdapterRegistry {
    adapters: Vec<Box<dyn EngineAdapter>>,
}

impl AdapterRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn register<A>(&mut self, adapter: A)
    where
        A: EngineAdapter + 'static,
    {
        self.adapters.push(Box::new(adapter));
        self.adapters.sort_by_key(|adapter| adapter.id());
    }

    pub fn adapters(&self) -> &[Box<dyn EngineAdapter>] {
        &self.adapters
    }

    pub fn get(&self, adapter_id: &str) -> Option<&dyn EngineAdapter> {
        self.adapters
            .iter()
            .find(|adapter| adapter.id() == adapter_id)
            .map(Box::as_ref)
    }

    pub fn detect_all(&self, game_dir: &Path) -> KaifuuResult<Vec<DetectionResult>> {
        let mut results = Vec::new();
        for adapter in &self.adapters {
            let mut result = adapter.detect(DetectRequest { game_dir })?;
            result.normalize();
            results.push(result);
        }
        Ok(results)
    }

    pub fn detect(&self, game_dir: &Path) -> KaifuuResult<Option<DetectionResult>> {
        let mut best = None;
        for result in self.detect_all(game_dir)? {
            if result.detected {
                best = Some(result);
                break;
            }
        }
        Ok(best)
    }
}

#[derive(Clone, Copy)]
pub struct DetectRequest<'a> {
    pub game_dir: &'a Path,
}

#[derive(Clone, Copy)]
pub struct ProfileRequest<'a> {
    pub game_dir: &'a Path,
}

#[derive(Clone, Copy)]
pub struct AssetListRequest<'a> {
    pub game_dir: &'a Path,
}

#[derive(Clone, Copy)]
pub struct ExtractRequest<'a> {
    pub game_dir: &'a Path,
}

#[derive(Clone, Copy)]
pub struct PatchRequest<'a> {
    pub game_dir: &'a Path,
    pub patch_export: &'a PatchExport,
    pub output_dir: &'a Path,
}

#[derive(Clone, Copy)]
pub struct VerifyRequest<'a> {
    pub game_dir: &'a Path,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Capability {
    Detection,
    Extraction,
    Patching,
    Verification,
    AssetListing,
    ProfileGeneration,
    LineParityPatching,
    AssetTextPatching,
    DeltaPatching,
    EncryptedInput,
    KeyProfile,
    RuntimeVm,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CapabilityStatus {
    Supported,
    Limited,
    Unsupported,
    RequiresUserInput,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CapabilityReport {
    pub capability: Capability,
    pub status: CapabilityStatus,
    pub limitation: Option<String>,
}

impl CapabilityReport {
    pub fn supported(capability: Capability) -> Self {
        Self {
            capability,
            status: CapabilityStatus::Supported,
            limitation: None,
        }
    }

    pub fn limited(capability: Capability, limitation: impl Into<String>) -> Self {
        Self {
            capability,
            status: CapabilityStatus::Limited,
            limitation: Some(limitation.into()),
        }
    }

    pub fn unsupported(capability: Capability, limitation: impl Into<String>) -> Self {
        Self {
            capability,
            status: CapabilityStatus::Unsupported,
            limitation: Some(limitation.into()),
        }
    }

    pub fn requires_user_input(capability: Capability, limitation: impl Into<String>) -> Self {
        Self {
            capability,
            status: CapabilityStatus::RequiresUserInput,
            limitation: Some(limitation.into()),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AdapterCapabilities {
    pub adapter_id: String,
    pub reports: Vec<CapabilityReport>,
}

impl AdapterCapabilities {
    pub fn new(adapter_id: impl Into<String>, reports: Vec<CapabilityReport>) -> Self {
        let mut capabilities = Self {
            adapter_id: adapter_id.into(),
            reports,
        };
        capabilities.normalize();
        capabilities
    }

    pub fn normalize(&mut self) {
        self.reports.sort_by_key(|report| {
            (
                serde_json::to_string(&report.capability).unwrap_or_default(),
                serde_json::to_string(&report.status).unwrap_or_default(),
                report.limitation.clone(),
            )
        });
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DetectionResult {
    pub adapter_id: String,
    pub detected: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub engine_family: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub engine_version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detected_variant: Option<String>,
    pub evidence: Vec<DetectionEvidence>,
    pub requirements: Vec<ProfileRequirement>,
    pub capabilities: Vec<CapabilityReport>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DetectionEvidence {
    pub path: String,
    pub kind: String,
    pub status: EvidenceStatus,
    pub detail: String,
}

impl DetectionResult {
    pub fn normalize(&mut self) {
        self.evidence
            .sort_by_key(|evidence| (evidence.path.clone(), evidence.kind.clone()));
        self.requirements.sort_by_key(ProfileRequirement::sort_key);
        self.capabilities.sort_by_key(|report| {
            (
                serde_json::to_string(&report.capability).unwrap_or_default(),
                serde_json::to_string(&report.status).unwrap_or_default(),
                report.limitation.clone(),
            )
        });
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EvidenceStatus {
    Matched,
    Missing,
    Invalid,
    Informational,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DetectionReport {
    pub schema_version: String,
    pub game_dir: String,
    pub status: DetectionReportStatus,
    pub detections: Vec<DetectionResult>,
    pub warnings: Vec<String>,
}

impl DetectionReport {
    pub fn from_results(game_dir: &Path, detections: Vec<DetectionResult>) -> Self {
        let status = if detections.iter().any(|detection| detection.detected) {
            DetectionReportStatus::Matched
        } else {
            DetectionReportStatus::Unknown
        };
        let warnings = if status == DetectionReportStatus::Unknown {
            vec!["no registered adapter matched this directory".to_string()]
        } else {
            vec![]
        };
        Self {
            schema_version: "0.1.0".to_string(),
            game_dir: game_dir.display().to_string(),
            status,
            detections,
            warnings,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DetectionReportStatus {
    Matched,
    Unknown,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GameProfile {
    pub schema_version: String,
    pub profile_id: String,
    pub game_id: String,
    pub title: String,
    pub source_locale: String,
    pub engine: EngineProfile,
    pub assets: Vec<AssetProfile>,
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
        self.capabilities.sort_by_key(|report| {
            (
                serde_json::to_string(&report.capability).unwrap_or_default(),
                serde_json::to_string(&report.status).unwrap_or_default(),
                report.limitation.clone(),
            )
        });
        self.requirements.sort_by_key(ProfileRequirement::sort_key);
    }

    pub fn stable_json(&self) -> KaifuuResult<String> {
        let mut normalized = self.clone();
        normalized.normalize();
        Ok(format!("{}\n", serde_json::to_string_pretty(&normalized)?))
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
            validation.requirements = self.requirements.clone();
        }
        validation
    }
}

pub fn validate_profile_value(value: &Value) -> ProfileValidationResult {
    let mut failures = Vec::new();
    if !value.is_object() {
        failures.push(ProfileValidationFailure {
            code: "invalid_profile_shape".to_string(),
            field: "$".to_string(),
            message: "profile must be a JSON object".to_string(),
        });
        return profile_validation_result(None, failures, vec![]);
    }

    let profile_id = required_string_value(&mut failures, value, "profileId");
    validate_schema_version(&mut failures, value);
    required_string_value(&mut failures, value, "gameId");
    required_string_value(&mut failures, value, "title");
    validate_locale_field(&mut failures, value, "sourceLocale");
    validate_engine(&mut failures, value.get("engine"));
    let asset_patching_capabilities = validate_assets(&mut failures, value.get("assets"));
    let profile_capabilities =
        validate_capabilities(&mut failures, value.get("capabilities"), "capabilities");
    for (field, capability) in asset_patching_capabilities {
        if !profile_capabilities.contains(&capability) {
            failures.push(ProfileValidationFailure {
                code: "inconsistent_capability".to_string(),
                field,
                message: format!(
                    "asset patching capability {capability} must also appear in profile capabilities"
                ),
            });
        }
    }
    let requirements = validate_requirements(&mut failures, value.get("requirements"));

    profile_validation_result(profile_id, failures, requirements)
}

fn profile_validation_result(
    profile_id: Option<String>,
    failures: Vec<ProfileValidationFailure>,
    requirements: Vec<ProfileRequirement>,
) -> ProfileValidationResult {
    ProfileValidationResult {
        schema_version: PROFILE_SCHEMA_VERSION.to_string(),
        profile_id,
        status: if failures.is_empty() {
            OperationStatus::Passed
        } else {
            OperationStatus::Failed
        },
        failures,
        requirements,
    }
}

fn validate_schema_version(failures: &mut Vec<ProfileValidationFailure>, value: &Value) {
    match value.get("schemaVersion").and_then(Value::as_str) {
        Some(PROFILE_SCHEMA_VERSION) => {}
        Some(version) if version.trim().is_empty() => failures.push(ProfileValidationFailure {
            code: "missing_required_field".to_string(),
            field: "schemaVersion".to_string(),
            message: "schemaVersion must not be empty".to_string(),
        }),
        Some(version) => failures.push(ProfileValidationFailure {
            code: "unsupported_schema_version".to_string(),
            field: "schemaVersion".to_string(),
            message: format!("schemaVersion must be {PROFILE_SCHEMA_VERSION}, got {version}"),
        }),
        None => failures.push(ProfileValidationFailure {
            code: "missing_required_field".to_string(),
            field: "schemaVersion".to_string(),
            message: "schemaVersion must not be empty".to_string(),
        }),
    }
}

fn validate_engine(failures: &mut Vec<ProfileValidationFailure>, engine: Option<&Value>) {
    let Some(engine) = engine else {
        failures.push(ProfileValidationFailure {
            code: "missing_required_field".to_string(),
            field: "engine".to_string(),
            message: "engine must be a JSON object".to_string(),
        });
        return;
    };
    if !engine.is_object() {
        failures.push(ProfileValidationFailure {
            code: "invalid_field_type".to_string(),
            field: "engine".to_string(),
            message: "engine must be a JSON object".to_string(),
        });
        return;
    }
    required_string_value(failures, engine, "engine.adapterId").map(|_| ());
    required_string_value(failures, engine, "engine.engineFamily").map(|_| ());
    required_string_value(failures, engine, "engine.detectedVariant").map(|_| ());
    if let Some(engine_version) = engine.get("engineVersion") {
        if !engine_version.is_null()
            && engine_version
                .as_str()
                .map(|version| version.trim().is_empty())
                .unwrap_or(true)
        {
            failures.push(ProfileValidationFailure {
                code: "invalid_engine_version".to_string(),
                field: "engine.engineVersion".to_string(),
                message: "engine.engineVersion must be null or a non-empty string".to_string(),
            });
        }
    }
}

fn validate_assets(
    failures: &mut Vec<ProfileValidationFailure>,
    assets: Option<&Value>,
) -> Vec<(String, String)> {
    let mut patching_capabilities = Vec::new();
    let Some(assets) = assets else {
        failures.push(ProfileValidationFailure {
            code: "missing_assets".to_string(),
            field: "assets".to_string(),
            message: "profile must identify at least one asset or manifest surface".to_string(),
        });
        return patching_capabilities;
    };
    let Some(assets) = assets.as_array() else {
        failures.push(ProfileValidationFailure {
            code: "invalid_field_type".to_string(),
            field: "assets".to_string(),
            message: "assets must be an array".to_string(),
        });
        return patching_capabilities;
    };
    if assets.is_empty() {
        failures.push(ProfileValidationFailure {
            code: "missing_assets".to_string(),
            field: "assets".to_string(),
            message: "profile must identify at least one asset or manifest surface".to_string(),
        });
    }
    for (index, asset) in assets.iter().enumerate() {
        let field = format!("assets.{index}");
        if !asset.is_object() {
            failures.push(ProfileValidationFailure {
                code: "invalid_field_type".to_string(),
                field,
                message: "asset must be a JSON object".to_string(),
            });
            continue;
        }
        let asset_id = required_string_value(failures, asset, &format!("assets.{index}.assetId"));
        if asset_id
            .as_deref()
            .is_some_and(|id| id.chars().any(char::is_whitespace) || id.contains('\0'))
        {
            failures.push(ProfileValidationFailure {
                code: "invalid_asset_id".to_string(),
                field: format!("assets.{index}.assetId"),
                message: "assetId must not contain whitespace or null bytes".to_string(),
            });
        }
        if let Some(path) = required_string_value(failures, asset, &format!("assets.{index}.path"))
        {
            validate_relative_path(failures, &format!("assets.{index}.path"), &path);
        }
        validate_enum_string(
            failures,
            asset,
            &format!("assets.{index}.assetKind"),
            &[
                "script", "database", "metadata", "image", "audio", "archive", "unknown",
            ],
        );
        validate_text_surfaces(failures, asset.get("textSurfaces"), index);
        if let Some(capability) = validate_capability_report(
            failures,
            asset.get("patching"),
            &format!("assets.{index}.patching"),
        ) {
            patching_capabilities.push((format!("assets.{index}.patching.capability"), capability));
        }
        if let Some(source_hash) = asset.get("sourceHash") {
            if !source_hash.is_null()
                && source_hash
                    .as_str()
                    .map(|hash| hash.trim().is_empty())
                    .unwrap_or(true)
            {
                failures.push(ProfileValidationFailure {
                    code: "invalid_source_hash".to_string(),
                    field: format!("assets.{index}.sourceHash"),
                    message: "sourceHash must be null or a non-empty string".to_string(),
                });
            }
        }
    }
    patching_capabilities
}

fn validate_text_surfaces(
    failures: &mut Vec<ProfileValidationFailure>,
    text_surfaces: Option<&Value>,
    asset_index: usize,
) {
    let field = format!("assets.{asset_index}.textSurfaces");
    let Some(text_surfaces) = text_surfaces else {
        failures.push(ProfileValidationFailure {
            code: "missing_text_surfaces".to_string(),
            field,
            message: "textSurfaces must list at least one known text surface".to_string(),
        });
        return;
    };
    let Some(text_surfaces) = text_surfaces.as_array() else {
        failures.push(ProfileValidationFailure {
            code: "invalid_field_type".to_string(),
            field,
            message: "textSurfaces must be an array".to_string(),
        });
        return;
    };
    if text_surfaces.is_empty() {
        failures.push(ProfileValidationFailure {
            code: "missing_text_surfaces".to_string(),
            field: format!("assets.{asset_index}.textSurfaces"),
            message: "textSurfaces must list at least one known text surface".to_string(),
        });
    }
    let mut seen = std::collections::BTreeSet::new();
    for (surface_index, surface) in text_surfaces.iter().enumerate() {
        let field = format!("assets.{asset_index}.textSurfaces.{surface_index}");
        let Some(surface) = surface.as_str() else {
            failures.push(ProfileValidationFailure {
                code: "invalid_text_surface".to_string(),
                field,
                message: "text surface must be a known string enum value".to_string(),
            });
            continue;
        };
        if ![
            "dialogue",
            "narration",
            "speaker_name",
            "choice_label",
            "ui_label",
            "tutorial_text",
            "database_entry",
            "song_title",
            "image_text",
            "metadata_text",
        ]
        .contains(&surface)
        {
            failures.push(ProfileValidationFailure {
                code: "invalid_text_surface".to_string(),
                field,
                message: format!("unknown text surface {surface}"),
            });
        }
        if !seen.insert(surface.to_string()) {
            failures.push(ProfileValidationFailure {
                code: "duplicate_text_surface".to_string(),
                field: format!("assets.{asset_index}.textSurfaces"),
                message: format!("text surface {surface} is duplicated"),
            });
        }
    }
}

fn validate_capabilities(
    failures: &mut Vec<ProfileValidationFailure>,
    capabilities: Option<&Value>,
    field: &str,
) -> std::collections::BTreeSet<String> {
    let mut seen = std::collections::BTreeSet::new();
    let Some(capabilities) = capabilities else {
        failures.push(ProfileValidationFailure {
            code: "missing_capabilities".to_string(),
            field: field.to_string(),
            message: "capabilities must list at least one capability report".to_string(),
        });
        return seen;
    };
    let Some(capabilities) = capabilities.as_array() else {
        failures.push(ProfileValidationFailure {
            code: "invalid_field_type".to_string(),
            field: field.to_string(),
            message: "capabilities must be an array".to_string(),
        });
        return seen;
    };
    if capabilities.is_empty() {
        failures.push(ProfileValidationFailure {
            code: "missing_capabilities".to_string(),
            field: field.to_string(),
            message: "capabilities must list at least one capability report".to_string(),
        });
    }
    for (index, capability) in capabilities.iter().enumerate() {
        let report_field = format!("{field}.{index}");
        let capability_name = validate_capability_report(failures, Some(capability), &report_field);
        if let Some(capability_name) = capability_name {
            if !seen.insert(capability_name.clone()) {
                failures.push(ProfileValidationFailure {
                    code: "duplicate_capability".to_string(),
                    field: field.to_string(),
                    message: format!("capability {capability_name} appears more than once"),
                });
            }
        }
    }
    seen
}

fn validate_capability_report(
    failures: &mut Vec<ProfileValidationFailure>,
    report: Option<&Value>,
    field: &str,
) -> Option<String> {
    let Some(report) = report else {
        failures.push(ProfileValidationFailure {
            code: "missing_capability_report".to_string(),
            field: field.to_string(),
            message: "capability report must be present".to_string(),
        });
        return None;
    };
    if !report.is_object() {
        failures.push(ProfileValidationFailure {
            code: "invalid_field_type".to_string(),
            field: field.to_string(),
            message: "capability report must be a JSON object".to_string(),
        });
        return None;
    }
    let capability = validate_enum_string(
        failures,
        report,
        &format!("{field}.capability"),
        &[
            "detection",
            "extraction",
            "patching",
            "verification",
            "asset_listing",
            "profile_generation",
            "line_parity_patching",
            "asset_text_patching",
            "delta_patching",
            "encrypted_input",
            "key_profile",
            "runtime_vm",
        ],
    );
    let status = validate_enum_string(
        failures,
        report,
        &format!("{field}.status"),
        &["supported", "limited", "unsupported", "requires_user_input"],
    );
    let limitation = report.get("limitation").and_then(Value::as_str);
    if matches!(
        status.as_deref(),
        Some("limited" | "unsupported" | "requires_user_input")
    ) && limitation.map(str::trim).unwrap_or("").is_empty()
    {
        failures.push(ProfileValidationFailure {
            code: "missing_capability_limitation".to_string(),
            field: format!("{field}.limitation"),
            message: "limited, unsupported, and user-input capabilities require a limitation"
                .to_string(),
        });
    }
    if status.as_deref() == Some("supported")
        && limitation.is_some_and(|text| !text.trim().is_empty())
    {
        failures.push(ProfileValidationFailure {
            code: "unexpected_capability_limitation".to_string(),
            field: format!("{field}.limitation"),
            message: "supported capabilities must not carry a limitation".to_string(),
        });
    }
    capability
}

fn validate_requirements(
    failures: &mut Vec<ProfileValidationFailure>,
    requirements: Option<&Value>,
) -> Vec<ProfileRequirement> {
    let Some(requirements) = requirements else {
        failures.push(ProfileValidationFailure {
            code: "missing_requirements".to_string(),
            field: "requirements".to_string(),
            message: "requirements must be an array".to_string(),
        });
        return vec![];
    };
    let Some(requirements) = requirements.as_array() else {
        failures.push(ProfileValidationFailure {
            code: "invalid_field_type".to_string(),
            field: "requirements".to_string(),
            message: "requirements must be an array".to_string(),
        });
        return vec![];
    };
    let mut parsed = Vec::new();
    let mut seen_keys = std::collections::BTreeSet::new();
    for (index, requirement) in requirements.iter().enumerate() {
        let field = format!("requirements.{index}");
        if !requirement.is_object() {
            failures.push(ProfileValidationFailure {
                code: "invalid_field_type".to_string(),
                field,
                message: "requirement must be a JSON object".to_string(),
            });
            continue;
        }
        let category = validate_enum_string(
            failures,
            requirement,
            &format!("requirements.{index}.category"),
            &["file", "platform", "secret_key"],
        );
        let key =
            required_string_value(failures, requirement, &format!("requirements.{index}.key"));
        let status = validate_enum_string(
            failures,
            requirement,
            &format!("requirements.{index}.status"),
            &["satisfied", "missing", "not_required", "unsupported"],
        );
        let description = required_string_value(
            failures,
            requirement,
            &format!("requirements.{index}.description"),
        );
        let secret = requirement
            .get("secret")
            .and_then(Value::as_bool)
            .unwrap_or_else(|| {
                failures.push(ProfileValidationFailure {
                    code: "invalid_field_type".to_string(),
                    field: format!("requirements.{index}.secret"),
                    message: "requirement secret must be a boolean".to_string(),
                });
                false
            });
        let placeholder = requirement
            .get("placeholder")
            .and_then(Value::as_str)
            .map(str::to_string);

        if let Some(key) = key.as_deref() {
            if !seen_keys.insert(key.to_string()) {
                failures.push(ProfileValidationFailure {
                    code: "duplicate_requirement_key".to_string(),
                    field: "requirements".to_string(),
                    message: format!("requirement key {key} appears more than once"),
                });
            }
            if key.chars().any(char::is_whitespace) || key.contains('\0') {
                failures.push(ProfileValidationFailure {
                    code: "invalid_requirement_key".to_string(),
                    field: format!("requirements.{index}.key"),
                    message: "requirement key must not contain whitespace or null bytes"
                        .to_string(),
                });
            }
        }
        if secret && status.as_deref() == Some("missing") && placeholder.is_none() {
            failures.push(ProfileValidationFailure {
                code: "missing_secret_placeholder".to_string(),
                field: format!("requirements.{index}.placeholder"),
                message: "missing secret requirements must name a placeholder and never store the secret value".to_string(),
            });
        }
        if !secret && placeholder.is_some() {
            failures.push(ProfileValidationFailure {
                code: "unexpected_non_secret_placeholder".to_string(),
                field: format!("requirements.{index}.placeholder"),
                message: "only secret requirements may name placeholders".to_string(),
            });
        }
        if matches!(status.as_deref(), Some("missing" | "unsupported")) {
            failures.push(ProfileValidationFailure {
                code: if status.as_deref() == Some("missing") {
                    "missing_requirement".to_string()
                } else {
                    "unsupported_requirement".to_string()
                },
                field: key
                    .as_deref()
                    .map(|key| format!("requirements.{key}"))
                    .unwrap_or_else(|| format!("requirements.{index}")),
                message: description
                    .clone()
                    .unwrap_or_else(|| "profile requirement is not satisfied".to_string()),
            });
        }
        if let (Some(category), Some(key), Some(status), Some(description)) =
            (category, key, status, description)
        {
            if let (Ok(category), Ok(status)) = (
                serde_json::from_value::<RequirementCategory>(Value::String(category)),
                serde_json::from_value::<RequirementStatus>(Value::String(status)),
            ) {
                parsed.push(ProfileRequirement {
                    category,
                    key,
                    status,
                    description,
                    placeholder,
                    secret,
                });
            }
        }
    }
    parsed
}

fn required_string_value(
    failures: &mut Vec<ProfileValidationFailure>,
    value: &Value,
    field: &str,
) -> Option<String> {
    let key = field.rsplit('.').next().unwrap_or(field);
    match value.get(key).and_then(Value::as_str) {
        Some(text) if !text.trim().is_empty() => Some(text.to_string()),
        Some(_) => {
            failures.push(ProfileValidationFailure {
                code: "missing_required_field".to_string(),
                field: field.to_string(),
                message: format!("{field} must not be empty"),
            });
            None
        }
        None => {
            failures.push(ProfileValidationFailure {
                code: "missing_required_field".to_string(),
                field: field.to_string(),
                message: format!("{field} must not be empty"),
            });
            None
        }
    }
}

fn validate_enum_string(
    failures: &mut Vec<ProfileValidationFailure>,
    value: &Value,
    field: &str,
    allowed: &[&str],
) -> Option<String> {
    let key = field.rsplit('.').next().unwrap_or(field);
    let Some(text) = value.get(key).and_then(Value::as_str) else {
        failures.push(ProfileValidationFailure {
            code: "invalid_enum_value".to_string(),
            field: field.to_string(),
            message: format!("{field} must be one of {}", allowed.join(", ")),
        });
        return None;
    };
    if !allowed.contains(&text) {
        failures.push(ProfileValidationFailure {
            code: "invalid_enum_value".to_string(),
            field: field.to_string(),
            message: format!("{field} must be one of {}", allowed.join(", ")),
        });
        return None;
    }
    Some(text.to_string())
}

fn validate_locale_field(failures: &mut Vec<ProfileValidationFailure>, value: &Value, field: &str) {
    let Some(locale) = required_string_value(failures, value, field) else {
        return;
    };
    if !is_bcp47_like_locale(&locale) {
        failures.push(ProfileValidationFailure {
            code: "invalid_locale".to_string(),
            field: field.to_string(),
            message: format!("{field} must be a BCP 47-style locale tag"),
        });
    }
}

fn is_bcp47_like_locale(locale: &str) -> bool {
    let parts = locale.split('-').collect::<Vec<_>>();
    let Some(language) = parts.first() else {
        return false;
    };
    if !(2..=8).contains(&language.len()) || !language.chars().all(|c| c.is_ascii_alphabetic()) {
        return false;
    }
    parts.iter().skip(1).all(|part| {
        !part.is_empty() && part.len() <= 8 && part.chars().all(|c| c.is_ascii_alphanumeric())
    })
}

fn validate_relative_path(failures: &mut Vec<ProfileValidationFailure>, field: &str, path: &str) {
    let has_parent_component = path.split(['/', '\\']).any(|component| component == "..");
    if path.starts_with('/')
        || path.starts_with('\\')
        || path.contains('\0')
        || has_parent_component
        || path.split(['/', '\\']).any(str::is_empty)
    {
        failures.push(ProfileValidationFailure {
            code: "invalid_asset_path".to_string(),
            field: field.to_string(),
            message: "asset path must be relative and must not contain parent traversal"
                .to_string(),
        });
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EngineProfile {
    pub adapter_id: String,
    pub engine_family: String,
    pub engine_version: Option<String>,
    pub detected_variant: String,
}

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

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtractionResult {
    pub adapter_id: String,
    pub profile: GameProfile,
    pub bridge: BridgeBundle,
    pub warnings: Vec<AdapterWarning>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BridgeBundle {
    pub schema_version: String,
    pub bridge_id: String,
    pub source_bundle_hash: String,
    pub source_locale: String,
    pub extractor_name: String,
    pub extractor_version: String,
    pub units: Vec<BridgeUnit>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BridgeUnit {
    pub bridge_unit_id: String,
    pub source_unit_key: String,
    pub occurrence_id: String,
    pub source_hash: String,
    pub source_locale: String,
    pub source_text: String,
    pub speaker: String,
    pub text_surface: String,
    pub protected_spans: Vec<ProtectedSpan>,
    pub patch_ref: PatchRef,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProtectedSpan {
    pub kind: String,
    pub raw: String,
    pub start: u64,
    pub end: u64,
    pub preserve_mode: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PatchRef {
    pub asset_id: String,
    pub write_mode: String,
    pub source_unit_key: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PatchExport {
    pub patch_export_id: String,
    pub source_locale: String,
    pub target_locale: String,
    pub entries: Vec<PatchExportEntry>,
}

impl PatchExport {
    pub fn from_value(value: &Value) -> KaifuuResult<Self> {
        Ok(serde_json::from_value(value.clone())?)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PatchExportEntry {
    pub bridge_unit_id: String,
    pub source_unit_key: String,
    pub source_hash: String,
    pub target_text: String,
    #[serde(default)]
    pub protected_spans: Vec<ProtectedSpan>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PatchResult {
    pub schema_version: String,
    pub patch_result_id: String,
    pub patch_export_id: String,
    pub status: OperationStatus,
    pub output_hash: String,
    pub failures: Vec<AdapterFailure>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VerificationResult {
    pub schema_version: String,
    pub patch_result_id: String,
    pub status: OperationStatus,
    pub output_hash: String,
    pub failures: Vec<AdapterFailure>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum OperationStatus {
    Passed,
    Failed,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AdapterWarning {
    pub code: String,
    pub message: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AdapterFailure {
    pub error_code: String,
    pub adapter: String,
    pub engine: Option<String>,
    pub detected_variant: Option<String>,
    pub asset_ref: Option<String>,
    pub required_capability: Option<Capability>,
    pub support_boundary: String,
    pub remediation: Option<String>,
}

pub fn deterministic_id(kind: &str, index: usize) -> String {
    let mut compact = kind.replace('-', "");
    compact.truncate(8);
    while compact.len() < 8 {
        compact.push('0');
    }
    format!("019ed000-0000-7000-8000-{}{:04}", compact, index)
}

pub fn content_hash(input: &str) -> String {
    let mut hash: u64 = 0xcbf29ce484222325;
    for byte in input.as_bytes() {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x100000001b3);
    }
    format!("{hash:016x}")
}

pub fn write_json<T>(path: &Path, value: &T) -> KaifuuResult<()>
where
    T: Serialize,
{
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::write(path, format!("{}\n", serde_json::to_string_pretty(value)?))?;
    Ok(())
}

pub fn read_json<T>(path: &Path) -> KaifuuResult<T>
where
    T: for<'de> Deserialize<'de>,
{
    Ok(serde_json::from_str(&fs::read_to_string(path)?)?)
}

pub fn require_str<'a>(value: &'a Value, key: &str) -> KaifuuResult<&'a str> {
    value[key]
        .as_str()
        .ok_or_else(|| format!("missing string field {key}").into())
}

pub fn require_u64(value: &Value, key: &str) -> KaifuuResult<u64> {
    value[key]
        .as_u64()
        .ok_or_else(|| format!("missing u64 field {key}").into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn profile_serialization_is_deterministic() {
        let mut metadata = BTreeMap::new();
        metadata.insert("source".to_string(), "fixture".to_string());
        metadata.insert(
            "supportBoundary".to_string(),
            "plain JSON fixture".to_string(),
        );
        let profile = GameProfile {
            schema_version: "0.1.0".to_string(),
            profile_id: deterministic_id("profile", 1),
            game_id: "hello-fixture".to_string(),
            title: "Hello Fixture".to_string(),
            source_locale: "ja-JP".to_string(),
            engine: EngineProfile {
                adapter_id: "kaifuu.fixture".to_string(),
                engine_family: "fixture".to_string(),
                engine_version: Some("0.0.0".to_string()),
                detected_variant: "plain-json".to_string(),
            },
            assets: vec![AssetProfile {
                asset_id: deterministic_id("asset", 1),
                path: "source.json".to_string(),
                asset_kind: AssetKind::Script,
                text_surfaces: vec![TextSurface::Dialogue],
                source_hash: Some("abcdef".to_string()),
                patching: CapabilityReport::limited(
                    Capability::Patching,
                    "fixture rewrites source.json with pretty JSON",
                ),
            }],
            capabilities: vec![
                CapabilityReport::unsupported(
                    Capability::DeltaPatching,
                    "delta packages are handled outside the engine adapter",
                ),
                CapabilityReport::supported(Capability::Detection),
            ],
            requirements: vec![ProfileRequirement {
                category: RequirementCategory::SecretKey,
                key: "decryption_key".to_string(),
                status: RequirementStatus::NotRequired,
                description: "plain JSON fixture does not require decryption keys".to_string(),
                placeholder: None,
                secret: true,
            }],
            metadata,
        };

        let expected = r#"{
  "schemaVersion": "0.1.0",
  "profileId": "019ed000-0000-7000-8000-profile00001",
  "gameId": "hello-fixture",
  "title": "Hello Fixture",
  "sourceLocale": "ja-JP",
  "engine": {
    "adapterId": "kaifuu.fixture",
    "engineFamily": "fixture",
    "engineVersion": "0.0.0",
    "detectedVariant": "plain-json"
  },
  "assets": [
    {
      "assetId": "019ed000-0000-7000-8000-asset0000001",
      "path": "source.json",
      "assetKind": "script",
      "textSurfaces": [
        "dialogue"
      ],
      "sourceHash": "abcdef",
      "patching": {
        "capability": "patching",
        "status": "limited",
        "limitation": "fixture rewrites source.json with pretty JSON"
      }
    }
  ],
  "capabilities": [
    {
      "capability": "delta_patching",
      "status": "unsupported",
      "limitation": "delta packages are handled outside the engine adapter"
    },
    {
      "capability": "detection",
      "status": "supported",
      "limitation": null
    }
  ],
  "requirements": [
    {
      "category": "secret_key",
      "key": "decryption_key",
      "status": "not_required",
      "description": "plain JSON fixture does not require decryption keys",
      "placeholder": null,
      "secret": true
    }
  ],
  "metadata": {
    "source": "fixture",
    "supportBoundary": "plain JSON fixture"
  }
}
"#;
        assert_eq!(profile.stable_json().unwrap(), expected);
        assert_eq!(
            profile.stable_json().unwrap(),
            profile.stable_json().unwrap()
        );
    }

    #[test]
    fn detection_result_omits_unknown_optional_engine_fields() {
        let unknown = DetectionResult {
            adapter_id: "kaifuu.fixture".to_string(),
            detected: false,
            engine_family: None,
            engine_version: None,
            detected_variant: None,
            evidence: vec![],
            requirements: vec![],
            capabilities: vec![],
        };

        let unknown_json = serde_json::to_value(&unknown).unwrap();
        let unknown_object = unknown_json.as_object().unwrap();
        assert!(!unknown_object.contains_key("engineFamily"));
        assert!(!unknown_object.contains_key("engineVersion"));
        assert!(!unknown_object.contains_key("detectedVariant"));

        let detected = DetectionResult {
            adapter_id: "kaifuu.fixture".to_string(),
            detected: true,
            engine_family: Some("fixture".to_string()),
            engine_version: Some("0.0.0".to_string()),
            detected_variant: Some("plain-json".to_string()),
            evidence: vec![],
            requirements: vec![],
            capabilities: vec![],
        };

        let detected_json = serde_json::to_value(&detected).unwrap();
        assert_eq!(detected_json["engineFamily"], "fixture");
        assert_eq!(detected_json["engineVersion"], "0.0.0");
        assert_eq!(detected_json["detectedVariant"], "plain-json");
    }

    #[test]
    fn registry_orders_adapters_by_id() {
        struct Adapter(&'static str);

        impl EngineAdapter for Adapter {
            fn id(&self) -> &'static str {
                self.0
            }

            fn name(&self) -> &'static str {
                self.0
            }

            fn capabilities(&self) -> AdapterCapabilities {
                AdapterCapabilities::new(self.0, vec![])
            }

            fn detect(&self, _request: DetectRequest<'_>) -> KaifuuResult<DetectionResult> {
                Ok(DetectionResult {
                    adapter_id: self.0.to_string(),
                    detected: true,
                    engine_family: Some(self.0.to_string()),
                    engine_version: None,
                    detected_variant: Some("test".to_string()),
                    evidence: vec![],
                    requirements: vec![],
                    capabilities: vec![],
                })
            }

            fn profile(&self, _request: ProfileRequest<'_>) -> KaifuuResult<GameProfile> {
                unreachable!()
            }

            fn list_assets(&self, _request: AssetListRequest<'_>) -> KaifuuResult<AssetList> {
                unreachable!()
            }

            fn extract(&self, _request: ExtractRequest<'_>) -> KaifuuResult<ExtractionResult> {
                unreachable!()
            }

            fn patch(&self, _request: PatchRequest<'_>) -> KaifuuResult<PatchResult> {
                unreachable!()
            }

            fn verify(&self, _request: VerifyRequest<'_>) -> KaifuuResult<VerificationResult> {
                unreachable!()
            }
        }

        let mut registry = AdapterRegistry::new();
        registry.register(Adapter("z.fixture"));
        registry.register(Adapter("a.fixture"));
        let ids = registry
            .adapters()
            .iter()
            .map(|adapter| adapter.id())
            .collect::<Vec<_>>();
        assert_eq!(ids, vec!["a.fixture", "z.fixture"]);
    }
}
