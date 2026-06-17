use std::collections::{BTreeMap, HashSet};
use std::fmt;
use std::fs::{self, File, OpenOptions};
use std::io::{ErrorKind, Write};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::Value;

pub type KaifuuResult<T> = Result<T, Box<dyn std::error::Error>>;
pub const PROFILE_SCHEMA_VERSION: &str = "0.1.0";
pub const ASSET_INVENTORY_SCHEMA_VERSION: &str = "0.1.0";

pub const BRIDGE_SCHEMA_VERSION_V02: &str = "0.2.0";

pub mod contracts;

pub trait EngineAdapter {
    fn id(&self) -> &'static str;
    fn name(&self) -> &'static str;
    fn capabilities(&self) -> AdapterCapabilities;
    fn detect(&self, request: DetectRequest<'_>) -> KaifuuResult<DetectionResult>;
    fn profile(&self, request: ProfileRequest<'_>) -> KaifuuResult<GameProfile>;
    fn list_assets(&self, request: AssetListRequest<'_>) -> KaifuuResult<AssetList>;
    fn asset_inventory(
        &self,
        request: AssetInventoryRequest<'_>,
    ) -> KaifuuResult<AssetInventoryManifest>;
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
pub struct AssetInventoryRequest<'a> {
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
    AssetInventory,
    NonTextSurfaceExtraction,
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
    let _ = required_string_value(failures, engine, "engine.adapterId");
    let _ = required_string_value(failures, engine, "engine.engineFamily");
    let _ = required_string_value(failures, engine, "engine.detectedVariant");
    if let Some(engine_version) = engine.get("engineVersion")
        && !engine_version.is_null()
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
        if let Some(source_hash) = asset.get("sourceHash")
            && !source_hash.is_null()
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
        if let Some(capability_name) = capability_name
            && !seen.insert(capability_name.clone())
        {
            failures.push(ProfileValidationFailure {
                code: "duplicate_capability".to_string(),
                field: field.to_string(),
                message: format!("capability {capability_name} appears more than once"),
            });
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
            "asset_inventory",
            "non_text_surface_extraction",
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
            && let (Ok(category), Ok(status)) = (
                serde_json::from_value::<RequirementCategory>(Value::String(category)),
                serde_json::from_value::<RequirementStatus>(Value::String(status)),
            )
        {
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
        || path_has_windows_drive_prefix_component(path)
        || path.split(['/', '\\']).any(str::is_empty)
    {
        failures.push(ProfileValidationFailure {
            code: "invalid_asset_path".to_string(),
            field: field.to_string(),
            message:
                "asset path must be relative and must not contain parent traversal or drive prefixes"
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
pub struct AssetInventoryManifest {
    pub schema_version: String,
    pub manifest_id: String,
    pub adapter_id: String,
    pub source_locale: String,
    pub assets: Vec<AssetInventoryAsset>,
    pub surfaces: Vec<AssetInventorySurface>,
    pub capabilities: Vec<CapabilityReport>,
    pub warnings: Vec<AdapterWarning>,
    pub metadata: BTreeMap<String, String>,
}

impl AssetInventoryManifest {
    pub fn normalize(&mut self) {
        self.assets.sort_by_key(|asset| asset.asset_id.clone());
        self.surfaces
            .sort_by_key(|surface| surface.surface_id.clone());
        for surface in &mut self.surfaces {
            surface.notes.sort();
            surface.notes.dedup();
        }
        self.capabilities.sort_by_key(|report| {
            (
                serde_json::to_string(&report.capability).unwrap_or_default(),
                serde_json::to_string(&report.status).unwrap_or_default(),
                report.limitation.clone(),
            )
        });
        self.warnings
            .sort_by_key(|warning| (warning.code.clone(), warning.message.clone()));
    }

    pub fn stable_json(&self) -> KaifuuResult<String> {
        let mut normalized = self.clone();
        normalized.normalize();
        Ok(format!("{}\n", serde_json::to_string_pretty(&normalized)?))
    }

    pub fn validate(&self) -> AssetInventoryValidationResult {
        let mut failures = Vec::new();
        if self.schema_version != ASSET_INVENTORY_SCHEMA_VERSION {
            failures.push(AssetInventoryValidationFailure {
                code: "unsupported_schema_version".to_string(),
                field: "schemaVersion".to_string(),
                message: format!(
                    "schemaVersion must be {ASSET_INVENTORY_SCHEMA_VERSION}, got {}",
                    self.schema_version
                ),
            });
        }
        if self.manifest_id.trim().is_empty() {
            failures.push(required_inventory_failure(
                "manifestId",
                "manifestId must not be empty",
            ));
        }
        if self.adapter_id.trim().is_empty() {
            failures.push(required_inventory_failure(
                "adapterId",
                "adapterId must not be empty",
            ));
        }
        if !is_bcp47_like_locale(&self.source_locale) {
            failures.push(AssetInventoryValidationFailure {
                code: "invalid_locale".to_string(),
                field: "sourceLocale".to_string(),
                message: "sourceLocale must be a BCP 47-style locale tag".to_string(),
            });
        }
        if self.assets.is_empty() {
            failures.push(AssetInventoryValidationFailure {
                code: "missing_assets".to_string(),
                field: "assets".to_string(),
                message: "asset inventory must include at least one asset".to_string(),
            });
        }

        let mut asset_ids = HashSet::new();
        let mut asset_keys_by_id = BTreeMap::new();
        for (index, asset) in self.assets.iter().enumerate() {
            let field = format!("assets.{index}");
            if asset.asset_id.trim().is_empty()
                || asset.asset_id.chars().any(char::is_whitespace)
                || asset.asset_id.contains('\0')
            {
                failures.push(AssetInventoryValidationFailure {
                    code: "invalid_asset_id".to_string(),
                    field: format!("{field}.assetId"),
                    message:
                        "assetId must not be empty and must not contain whitespace or null bytes"
                            .to_string(),
                });
            }
            if !asset_ids.insert(asset.asset_id.clone()) {
                failures.push(AssetInventoryValidationFailure {
                    code: "duplicate_asset_id".to_string(),
                    field: "assets".to_string(),
                    message: format!("assetId {} appears more than once", asset.asset_id),
                });
            }
            if asset.asset_key.trim().is_empty() {
                failures.push(required_inventory_failure(
                    &format!("{field}.assetKey"),
                    "assetKey must not be empty",
                ));
            }
            if let Some(path) = &asset.path {
                validate_asset_inventory_relative_path(
                    &mut failures,
                    &format!("{field}.path"),
                    path,
                );
            }
            if let Some(source_hash) = &asset.source_hash
                && source_hash.trim().is_empty()
            {
                failures.push(AssetInventoryValidationFailure {
                    code: "invalid_source_hash".to_string(),
                    field: format!("{field}.sourceHash"),
                    message: "sourceHash must be omitted or non-empty".to_string(),
                });
            }
            asset_keys_by_id.insert(asset.asset_id.clone(), asset.asset_key.clone());
        }

        let mut surface_ids = HashSet::new();
        for (index, surface) in self.surfaces.iter().enumerate() {
            let field = format!("surfaces.{index}");
            if surface.surface_id.trim().is_empty()
                || surface.surface_id.chars().any(char::is_whitespace)
                || surface.surface_id.contains('\0')
            {
                failures.push(AssetInventoryValidationFailure {
                    code: "invalid_surface_id".to_string(),
                    field: format!("{field}.surfaceId"),
                    message:
                        "surfaceId must not be empty and must not contain whitespace or null bytes"
                            .to_string(),
                });
            }
            if !surface_ids.insert(surface.surface_id.clone()) {
                failures.push(AssetInventoryValidationFailure {
                    code: "duplicate_surface_id".to_string(),
                    field: "surfaces".to_string(),
                    message: format!("surfaceId {} appears more than once", surface.surface_id),
                });
            }
            if !asset_ids.contains(&surface.source_asset_ref.asset_id) {
                failures.push(AssetInventoryValidationFailure {
                    code: "unknown_asset_ref".to_string(),
                    field: format!("{field}.sourceAssetRef.assetId"),
                    message: format!(
                        "surface references unknown assetId {}",
                        surface.source_asset_ref.asset_id
                    ),
                });
            }
            if let Some(expected_key) = asset_keys_by_id.get(&surface.source_asset_ref.asset_id)
                && let Some(asset_key) = &surface.source_asset_ref.asset_key
                && asset_key != expected_key
            {
                failures.push(AssetInventoryValidationFailure {
                    code: "asset_key_mismatch".to_string(),
                    field: format!("{field}.sourceAssetRef.assetKey"),
                    message: format!(
                        "assetKey {asset_key} does not match referenced asset key {expected_key}"
                    ),
                });
            }
            if let Some(source_location) = &surface.source_location {
                validate_asset_inventory_source_location(
                    &mut failures,
                    &format!("{field}.sourceLocation"),
                    source_location,
                );
            }
            if matches!(
                &surface.text_source_kind,
                AssetInventoryTextSourceKind::NotApplicable
            ) && surface.source_text.is_some()
            {
                failures.push(AssetInventoryValidationFailure {
                    code: "unexpected_source_text".to_string(),
                    field: format!("{field}.sourceText"),
                    message: "sourceText must be omitted when textSourceKind is not_applicable"
                        .to_string(),
                });
            }
            if !matches!(
                &surface.text_source_kind,
                AssetInventoryTextSourceKind::NotApplicable
            ) && surface
                .source_text
                .as_deref()
                .map(str::trim)
                .unwrap_or("")
                .is_empty()
            {
                failures.push(AssetInventoryValidationFailure {
                    code: "missing_source_text".to_string(),
                    field: format!("{field}.sourceText"),
                    message: "sourceText is required unless textSourceKind is not_applicable"
                        .to_string(),
                });
            }
            if let Some(source_hash) = &surface.source_hash
                && source_hash.trim().is_empty()
            {
                failures.push(AssetInventoryValidationFailure {
                    code: "invalid_source_hash".to_string(),
                    field: format!("{field}.sourceHash"),
                    message: "sourceHash must be omitted or non-empty".to_string(),
                });
            }
            if matches!(
                &surface.patching.status,
                CapabilityStatus::Limited
                    | CapabilityStatus::Unsupported
                    | CapabilityStatus::RequiresUserInput
            ) && surface
                .patching
                .limitation
                .as_deref()
                .map(str::trim)
                .unwrap_or("")
                .is_empty()
            {
                failures.push(AssetInventoryValidationFailure {
                    code: "missing_patching_limitation".to_string(),
                    field: format!("{field}.patching.limitation"),
                    message:
                        "limited, unsupported, and user-input patching reports require a limitation"
                            .to_string(),
                });
            }
        }

        AssetInventoryValidationResult {
            schema_version: ASSET_INVENTORY_SCHEMA_VERSION.to_string(),
            manifest_id: Some(self.manifest_id.clone()),
            status: if failures.is_empty() {
                OperationStatus::Passed
            } else {
                OperationStatus::Failed
            },
            failures,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AssetInventoryValidationResult {
    pub schema_version: String,
    pub manifest_id: Option<String>,
    pub status: OperationStatus,
    pub failures: Vec<AssetInventoryValidationFailure>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AssetInventoryValidationFailure {
    pub code: String,
    pub field: String,
    pub message: String,
}

fn required_inventory_failure(field: &str, message: &str) -> AssetInventoryValidationFailure {
    AssetInventoryValidationFailure {
        code: "missing_required_field".to_string(),
        field: field.to_string(),
        message: message.to_string(),
    }
}

fn validate_asset_inventory_relative_path(
    failures: &mut Vec<AssetInventoryValidationFailure>,
    field: &str,
    path: &str,
) {
    let mut profile_failures = Vec::new();
    validate_relative_path(&mut profile_failures, field, path);
    if !profile_failures.is_empty() {
        failures.extend(profile_failures.into_iter().map(|failure| {
            AssetInventoryValidationFailure {
                code: failure.code,
                field: failure.field,
                message: failure.message,
            }
        }));
    }
}

fn validate_asset_inventory_source_location(
    failures: &mut Vec<AssetInventoryValidationFailure>,
    field: &str,
    value: &Value,
) {
    let Some(location) = value.as_object() else {
        failures.push(AssetInventoryValidationFailure {
            code: "invalid_source_location".to_string(),
            field: field.to_string(),
            message: "sourceLocation must be a JSON object".to_string(),
        });
        return;
    };

    for key in location.keys() {
        if !["containerKey", "entryPath", "range", "region"].contains(&key.as_str()) {
            failures.push(AssetInventoryValidationFailure {
                code: "engine_specific_source_location".to_string(),
                field: format!("{field}.{key}"),
                message:
                    "sourceLocation must use neutral fields: containerKey, entryPath, range, region"
                        .to_string(),
            });
        }
    }
    if let Some(container_key) = location.get("containerKey")
        && container_key
            .as_str()
            .map(str::trim)
            .unwrap_or("")
            .is_empty()
    {
        failures.push(AssetInventoryValidationFailure {
            code: "invalid_source_location".to_string(),
            field: format!("{field}.containerKey"),
            message: "containerKey must be a non-empty string".to_string(),
        });
    }
    if let Some(entry_path) = location.get("entryPath") {
        let Some(entry_path) = entry_path.as_array() else {
            failures.push(AssetInventoryValidationFailure {
                code: "invalid_source_location".to_string(),
                field: format!("{field}.entryPath"),
                message: "entryPath must be an array of non-empty strings".to_string(),
            });
            return;
        };
        for (index, entry) in entry_path.iter().enumerate() {
            if entry.as_str().map(str::trim).unwrap_or("").is_empty() {
                failures.push(AssetInventoryValidationFailure {
                    code: "invalid_source_location".to_string(),
                    field: format!("{field}.entryPath.{index}"),
                    message: "entryPath entries must be non-empty strings".to_string(),
                });
            }
        }
    }
    if let Some(range) = location.get("range") {
        validate_asset_inventory_u64_object_fields(
            failures,
            &format!("{field}.range"),
            range,
            &["startByte", "endByte"],
        );
    }
    if let Some(region) = location.get("region") {
        validate_asset_inventory_u64_object_fields(
            failures,
            &format!("{field}.region"),
            region,
            &["x", "y", "width", "height"],
        );
    }
}

fn validate_asset_inventory_u64_object_fields(
    failures: &mut Vec<AssetInventoryValidationFailure>,
    field: &str,
    value: &Value,
    expected_fields: &[&str],
) {
    let Some(object) = value.as_object() else {
        failures.push(AssetInventoryValidationFailure {
            code: "invalid_source_location".to_string(),
            field: field.to_string(),
            message: format!("{field} must be a JSON object"),
        });
        return;
    };
    for key in object.keys() {
        if !expected_fields.contains(&key.as_str()) {
            failures.push(AssetInventoryValidationFailure {
                code: "invalid_source_location".to_string(),
                field: format!("{field}.{key}"),
                message: format!(
                    "{field} must only contain fields: {}",
                    expected_fields.join(", ")
                ),
            });
        }
    }
    for expected in expected_fields {
        if object.get(*expected).and_then(Value::as_u64).is_none() {
            failures.push(AssetInventoryValidationFailure {
                code: "invalid_source_location".to_string(),
                field: format!("{field}.{expected}"),
                message: format!("{field}.{expected} must be an unsigned integer"),
            });
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AssetInventoryAsset {
    pub asset_id: String,
    pub asset_key: String,
    pub asset_kind: AssetInventoryAssetKind,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_hash: Option<String>,
    pub metadata: BTreeMap<String, String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AssetInventoryAssetKind {
    Script,
    Image,
    Audio,
    Video,
    UiTexture,
    Font,
    Database,
    Metadata,
    Text,
    Archive,
    Unknown,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AssetInventorySurface {
    pub surface_id: String,
    pub asset_surface_kind: AssetInventorySurfaceKind,
    pub source_asset_ref: AssetInventoryAssetRef,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_location: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_text: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_hash: Option<String>,
    pub text_source_kind: AssetInventoryTextSourceKind,
    pub patch_mode: AssetInventoryPatchMode,
    pub patching: CapabilityReport,
    pub notes: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AssetInventoryAssetRef {
    pub asset_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub asset_key: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AssetInventorySurfaceKind {
    ImageText,
    UiArt,
    SongTitle,
    Font,
    Credits,
    Video,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AssetInventoryTextSourceKind {
    Metadata,
    ManualTranscription,
    OcrHint,
    NotApplicable,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AssetInventoryPatchMode {
    MetadataOnly,
    NoPatchRequired,
    RegionRedrawRequired,
    AssetReplacementRequired,
    FontSubstitutionRequired,
    Unsupported,
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
    #[serde(skip_serializing_if = "Option::is_none")]
    pub parsed_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub arguments: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub variable_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub format_hint: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub example_values: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub base_start_byte: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub base_end_byte: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub annotation_start_byte: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub annotation_end_byte: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub annotation_text: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub annotation_locale: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub display_mode: Option<String>,
}

impl ProtectedSpan {
    pub fn new(
        kind: impl Into<String>,
        raw: impl Into<String>,
        start: u64,
        end: u64,
        preserve_mode: impl Into<String>,
    ) -> Self {
        Self {
            kind: kind.into(),
            raw: raw.into(),
            start,
            end,
            preserve_mode: preserve_mode.into(),
            parsed_name: None,
            arguments: None,
            variable_name: None,
            format_hint: None,
            example_values: None,
            base_start_byte: None,
            base_end_byte: None,
            annotation_start_byte: None,
            annotation_end_byte: None,
            annotation_text: None,
            annotation_locale: None,
            display_mode: None,
        }
    }

    pub fn variable_placeholder(
        raw: impl Into<String>,
        start: u64,
        end: u64,
        variable_name: impl Into<String>,
    ) -> Self {
        let variable_name = variable_name.into();
        let mut span = Self::new("variable_placeholder", raw, start, end, "map");
        span.variable_name = Some(variable_name);
        span
    }

    pub fn control_markup(
        raw: impl Into<String>,
        start: u64,
        end: u64,
        parsed_name: impl Into<String>,
        arguments: Vec<String>,
    ) -> Self {
        let mut span = Self::new("control_markup", raw, start, end, "exact");
        span.parsed_name = Some(parsed_name.into());
        if !arguments.is_empty() {
            span.arguments = Some(arguments);
        }
        span
    }

    fn normalized(mut self, source_text: &str) -> KaifuuResult<Self> {
        let original_kind = self.kind.clone();
        self.kind = normalize_protected_span_kind(&self.kind)
            .ok_or_else(|| format!("unsupported protected span kind {}", self.kind))?
            .to_string();
        if self.preserve_mode.trim().is_empty()
            || original_kind == "placeholder"
            || (self.kind == "variable_placeholder" && self.preserve_mode == "exact")
        {
            self.preserve_mode = default_preserve_mode_for_span_kind(&self.kind).to_string();
        }
        if !["exact", "map", "transform", "locale_policy"].contains(&self.preserve_mode.as_str()) {
            return Err(format!(
                "unsupported protected span preserveMode {}",
                self.preserve_mode
            )
            .into());
        }
        self.raw = source_slice_for_span(source_text, self.start, self.end, &self.raw)?.to_string();
        if self.kind == "variable_placeholder" && self.variable_name.is_none() {
            self.variable_name = variable_name_from_raw_placeholder(&self.raw);
        }
        self.arguments = normalize_non_empty_string_vec(self.arguments);
        self.example_values = normalize_non_empty_string_vec(self.example_values);
        Ok(self)
    }

    fn merge_missing_metadata_from(&mut self, other: &Self) {
        if self.parsed_name.is_none() {
            self.parsed_name = other.parsed_name.clone();
        }
        if self.arguments.is_none() {
            self.arguments = other.arguments.clone();
        }
        if self.variable_name.is_none() {
            self.variable_name = other.variable_name.clone();
        }
        if self.format_hint.is_none() {
            self.format_hint = other.format_hint.clone();
        }
        if self.example_values.is_none() {
            self.example_values = other.example_values.clone();
        }
        if self.base_start_byte.is_none() {
            self.base_start_byte = other.base_start_byte;
        }
        if self.base_end_byte.is_none() {
            self.base_end_byte = other.base_end_byte;
        }
        if self.annotation_start_byte.is_none() {
            self.annotation_start_byte = other.annotation_start_byte;
        }
        if self.annotation_end_byte.is_none() {
            self.annotation_end_byte = other.annotation_end_byte;
        }
        if self.annotation_text.is_none() {
            self.annotation_text = other.annotation_text.clone();
        }
        if self.annotation_locale.is_none() {
            self.annotation_locale = other.annotation_locale.clone();
        }
        if self.display_mode.is_none() {
            self.display_mode = other.display_mode.clone();
        }
    }
}

pub fn normalize_protected_spans(
    source_text: &str,
    spans: Vec<ProtectedSpan>,
) -> KaifuuResult<Vec<ProtectedSpan>> {
    let mut normalized = spans
        .into_iter()
        .map(|span| span.normalized(source_text))
        .collect::<KaifuuResult<Vec<_>>>()?;
    normalized.sort_by_key(|span| {
        (
            span.start,
            span.end,
            span.kind.clone(),
            span.raw.clone(),
            span.parsed_name.clone(),
        )
    });

    let mut merged: Vec<ProtectedSpan> = Vec::new();
    for span in normalized {
        if let Some(existing) = merged.last_mut()
            && existing.start == span.start
            && existing.end == span.end
            && existing.kind == span.kind
            && existing.raw == span.raw
        {
            existing.merge_missing_metadata_from(&span);
            continue;
        }
        if let Some(previous) = merged.last()
            && previous.end > span.start
        {
            return Err(format!(
                "protected spans must not overlap: {}..{} overlaps {}..{}",
                previous.start, previous.end, span.start, span.end
            )
            .into());
        }
        merged.push(span);
    }

    Ok(merged)
}

fn normalize_protected_span_kind(kind: &str) -> Option<&'static str> {
    match kind {
        "control_markup" => Some("control_markup"),
        "variable_placeholder" | "placeholder" => Some("variable_placeholder"),
        "ruby_annotation" => Some("ruby_annotation"),
        _ => None,
    }
}

fn default_preserve_mode_for_span_kind(kind: &str) -> &'static str {
    match kind {
        "variable_placeholder" => "map",
        "ruby_annotation" => "locale_policy",
        _ => "exact",
    }
}

fn normalize_non_empty_string_vec(values: Option<Vec<String>>) -> Option<Vec<String>> {
    let values = values?
        .into_iter()
        .filter(|value| !value.trim().is_empty())
        .collect::<Vec<_>>();
    if values.is_empty() {
        None
    } else {
        Some(values)
    }
}

fn source_slice_for_span<'a>(
    source_text: &'a str,
    start: u64,
    end: u64,
    expected_raw: &str,
) -> KaifuuResult<&'a str> {
    if end <= start {
        return Err("protected span end must be greater than start".into());
    }
    let start = usize::try_from(start).map_err(|_| "protected span start is too large")?;
    let end = usize::try_from(end).map_err(|_| "protected span end is too large")?;
    if end > source_text.len() {
        return Err("protected span end must be within sourceText bytes".into());
    }
    if !source_text.is_char_boundary(start) || !source_text.is_char_boundary(end) {
        return Err("protected span boundaries must align to UTF-8 character boundaries".into());
    }
    let actual = &source_text[start..end];
    if actual != expected_raw {
        return Err(format!(
            "protected span raw {:?} must match sourceText byte range {:?}",
            expected_raw, actual
        )
        .into());
    }
    Ok(actual)
}

fn variable_name_from_raw_placeholder(raw: &str) -> Option<String> {
    raw.strip_prefix('{')
        .and_then(|value| value.strip_suffix('}'))
        .filter(|value| !value.trim().is_empty())
        .map(str::to_string)
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PatchRef {
    pub asset_id: String,
    pub write_mode: String,
    pub source_unit_key: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BridgeContractValidationError {
    message: String,
}

impl BridgeContractValidationError {
    fn new(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
        }
    }
}

impl fmt::Display for BridgeContractValidationError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for BridgeContractValidationError {}

pub type BridgeContractResult<T> = Result<T, BridgeContractValidationError>;

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BridgeBundleV02 {
    pub schema_version: String,
    pub bridge_id: String,
    pub source_game: SourceGameRevisionV02,
    pub source_bundle_hash: String,
    pub source_bundle_revision: SourceRevisionV02,
    pub source_locale: String,
    pub hash_strategy: HashStrategyV02,
    pub extractor: BridgeExtractorV02,
    pub assets: Vec<BridgeAssetV02>,
    pub units: Vec<LocalizationUnitV02>,
    pub policy_records: Vec<PolicyRecordV02>,
}

impl BridgeBundleV02 {
    pub fn validate_json(value: &Value) -> BridgeContractResult<Self> {
        let bundle: Self = serde_json::from_value(value.clone()).map_err(|error| {
            BridgeContractValidationError::new(format!(
                "BridgeBundleV02 must match the Rust serde contract: {error}"
            ))
        })?;
        bundle.validate()?;
        Ok(bundle)
    }

    pub fn validate(&self) -> BridgeContractResult<()> {
        assert_schema_version_v02(&self.schema_version, "BridgeBundleV02.schemaVersion")?;
        assert_uuid7(&self.bridge_id, "BridgeBundleV02.bridgeId")?;
        self.source_game.validate("BridgeBundleV02.sourceGame")?;
        assert_hash_string_v02(&self.source_bundle_hash, "BridgeBundleV02.sourceBundleHash")?;
        self.source_bundle_revision
            .validate("BridgeBundleV02.sourceBundleRevision")?;
        assert_revision_hash_matches_v02(
            &self.source_bundle_revision,
            &self.source_bundle_hash,
            "BridgeBundleV02.sourceBundleRevision",
        )?;
        assert_non_empty(&self.source_locale, "BridgeBundleV02.sourceLocale")?;
        self.hash_strategy
            .validate("BridgeBundleV02.hashStrategy")?;
        self.extractor.validate("BridgeBundleV02.extractor")?;

        let mut asset_ids = HashSet::new();
        for (index, asset) in self.assets.iter().enumerate() {
            let label = format!("BridgeBundleV02.assets[{index}]");
            asset.validate(&label)?;
            if !asset_ids.insert(asset.asset_id.clone()) {
                return Err(BridgeContractValidationError::new(format!(
                    "{label}.assetId must be unique within BridgeBundleV02.assets"
                )));
            }
        }

        for (index, unit) in self.units.iter().enumerate() {
            let label = format!("BridgeBundleV02.units[{index}]");
            unit.validate(&label, &asset_ids)?;
        }

        for (index, record) in self.policy_records.iter().enumerate() {
            record.validate(&format!("BridgeBundleV02.policyRecords[{index}]"))?;
        }

        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceGameRevisionV02 {
    pub game_id: String,
    pub game_version: String,
    pub source_profile_id: String,
    pub source_profile_revision: SourceRevisionV02,
}

impl SourceGameRevisionV02 {
    fn validate(&self, label: &str) -> BridgeContractResult<()> {
        assert_non_empty(&self.game_id, &format!("{label}.gameId"))?;
        assert_non_empty(&self.game_version, &format!("{label}.gameVersion"))?;
        assert_non_empty(&self.source_profile_id, &format!("{label}.sourceProfileId"))?;
        self.source_profile_revision
            .validate(&format!("{label}.sourceProfileRevision"))
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceRevisionV02 {
    pub revision_id: String,
    pub revision_kind: String,
    pub value: String,
    pub created_at: Option<String>,
}

impl SourceRevisionV02 {
    fn validate(&self, label: &str) -> BridgeContractResult<()> {
        assert_uuid7(&self.revision_id, &format!("{label}.revisionId"))?;
        assert_one_of(
            &self.revision_kind,
            &["content_hash", "source_control", "build", "manual_snapshot"],
            &format!("{label}.revisionKind"),
        )?;
        assert_non_empty(&self.value, &format!("{label}.value"))?;
        if self.revision_kind == "content_hash" {
            assert_hash_string_v02(&self.value, &format!("{label}.value"))?;
        }
        if let Some(created_at) = &self.created_at {
            assert_non_empty(created_at, &format!("{label}.createdAt"))?;
        }
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HashStrategyV02 {
    pub source_profile: HashRuleV02,
    pub source_bundle: HashRuleV02,
    pub source_asset: HashRuleV02,
    pub source_unit: HashRuleV02,
    pub patch_export: HashRuleV02,
    pub delta_package: HashRuleV02,
}

impl HashStrategyV02 {
    fn validate(&self, label: &str) -> BridgeContractResult<()> {
        self.source_profile.validate(
            &format!("{label}.sourceProfile"),
            "source_profile",
            "utf8-nfc-lf-json-stable-v1",
            false,
        )?;
        self.source_bundle.validate(
            &format!("{label}.sourceBundle"),
            "source_bundle",
            "utf8-nfc-lf-json-stable-v1",
            false,
        )?;
        self.source_asset.validate(
            &format!("{label}.sourceAsset"),
            "source_asset",
            "bytes",
            false,
        )?;
        self.source_unit.validate(
            &format!("{label}.sourceUnit"),
            "source_unit",
            "utf8-nfc-lf-json-stable-v1",
            true,
        )?;
        self.patch_export.validate(
            &format!("{label}.patchExport"),
            "patch_export",
            "utf8-nfc-lf-json-stable-v1",
            false,
        )?;
        self.delta_package.validate(
            &format!("{label}.deltaPackage"),
            "delta_package",
            "utf8-nfc-lf-json-stable-v1",
            false,
        )
    }
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HashRuleV02 {
    pub scope: String,
    pub algorithm: String,
    pub normalization: String,
    pub fields: Option<Vec<String>>,
}

impl HashRuleV02 {
    fn validate(
        &self,
        label: &str,
        expected_scope: &str,
        expected_normalization: &str,
        require_fields: bool,
    ) -> BridgeContractResult<()> {
        assert_equals(&self.scope, expected_scope, &format!("{label}.scope"))?;
        assert_equals(&self.algorithm, "sha256", &format!("{label}.algorithm"))?;
        assert_equals(
            &self.normalization,
            expected_normalization,
            &format!("{label}.normalization"),
        )?;
        if let Some(fields) = &self.fields {
            for (index, field) in fields.iter().enumerate() {
                assert_non_empty(field, &format!("{label}.fields[{index}]"))?;
            }
        }
        if require_fields && self.fields.as_ref().is_none_or(Vec::is_empty) {
            return Err(BridgeContractValidationError::new(format!(
                "{label}.fields must not be empty"
            )));
        }
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BridgeExtractorV02 {
    pub name: String,
    pub version: String,
}

impl BridgeExtractorV02 {
    fn validate(&self, label: &str) -> BridgeContractResult<()> {
        assert_non_empty(&self.name, &format!("{label}.name"))?;
        assert_non_empty(&self.version, &format!("{label}.version"))
    }
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BridgeAssetV02 {
    pub asset_id: String,
    pub asset_key: String,
    pub asset_kind: String,
    pub source_hash: String,
    pub source_revision: SourceRevisionV02,
    pub path: Option<String>,
}

impl BridgeAssetV02 {
    fn validate(&self, label: &str) -> BridgeContractResult<()> {
        assert_uuid7(&self.asset_id, &format!("{label}.assetId"))?;
        assert_non_empty(&self.asset_key, &format!("{label}.assetKey"))?;
        assert_one_of(
            &self.asset_kind,
            &[
                "script",
                "image",
                "audio",
                "video",
                "ui_texture",
                "font",
                "database",
                "metadata",
                "text",
            ],
            &format!("{label}.assetKind"),
        )?;
        assert_hash_string_v02(&self.source_hash, &format!("{label}.sourceHash"))?;
        self.source_revision
            .validate(&format!("{label}.sourceRevision"))?;
        assert_revision_hash_matches_v02(
            &self.source_revision,
            &self.source_hash,
            &format!("{label}.sourceRevision"),
        )?;
        if let Some(path) = &self.path {
            assert_non_empty(path, &format!("{label}.path"))?;
        }
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalizationUnitV02 {
    pub bridge_unit_id: String,
    pub surface_id: String,
    pub surface_kind: String,
    pub source_unit_key: String,
    pub occurrence_id: String,
    pub source_locale: String,
    pub source_text: String,
    pub source_hash: String,
    pub source_revision: SourceRevisionV02,
    pub source_asset_ref: AssetRefV02,
    pub source_location: Value,
    pub speaker: Option<SpeakerContextV02>,
    pub context: Value,
    pub policy: Option<Value>,
    pub spans: Vec<BridgeSpanV02>,
    pub patch_ref: PatchRefV02,
    pub runtime_expectation: RuntimeExpectationV02,
}

impl LocalizationUnitV02 {
    fn validate(&self, label: &str, asset_ids: &HashSet<String>) -> BridgeContractResult<()> {
        assert_uuid7(&self.bridge_unit_id, &format!("{label}.bridgeUnitId"))?;
        assert_uuid7(&self.surface_id, &format!("{label}.surfaceId"))?;
        assert_surface_kind(&self.surface_kind, &format!("{label}.surfaceKind"))?;
        assert_non_empty(&self.source_unit_key, &format!("{label}.sourceUnitKey"))?;
        assert_non_empty(&self.occurrence_id, &format!("{label}.occurrenceId"))?;
        assert_non_empty(&self.source_locale, &format!("{label}.sourceLocale"))?;
        assert_non_empty(&self.source_text, &format!("{label}.sourceText"))?;
        assert_hash_string_v02(&self.source_hash, &format!("{label}.sourceHash"))?;
        self.source_revision
            .validate(&format!("{label}.sourceRevision"))?;
        self.source_asset_ref
            .validate(&format!("{label}.sourceAssetRef"))?;
        assert_known_asset_id(
            &self.source_asset_ref.asset_id,
            &format!("{label}.sourceAssetRef.assetId"),
            asset_ids,
        )?;
        assert_source_location_v02(&self.source_location, &format!("{label}.sourceLocation"))?;
        if let Some(speaker) = &self.speaker {
            speaker.validate(&format!("{label}.speaker"))?;
        }
        assert_surface_context_v02(
            &self.context,
            &format!("{label}.context"),
            &self.surface_kind,
            asset_ids,
        )?;
        if let Some(policy) = &self.policy {
            assert_localization_policy_v02(policy, &format!("{label}.policy"))?;
        }
        for (index, span) in self.spans.iter().enumerate() {
            span.validate(&format!("{label}.spans[{index}]"), &self.source_text)?;
        }
        self.patch_ref.validate(&format!("{label}.patchRef"))?;
        assert_known_asset_id(
            &self.patch_ref.asset_id,
            &format!("{label}.patchRef.assetId"),
            asset_ids,
        )?;
        assert_equals(
            &self.patch_ref.source_unit_key,
            &self.source_unit_key,
            &format!("{label}.patchRef.sourceUnitKey"),
        )?;
        if self.patch_ref.source_revision.revision_id != self.source_revision.revision_id {
            return Err(BridgeContractValidationError::new(format!(
                "{label}.patchRef.sourceRevision.revisionId must match unit sourceRevision"
            )));
        }
        if self.patch_ref.source_revision.value != self.source_revision.value {
            return Err(BridgeContractValidationError::new(format!(
                "{label}.patchRef.sourceRevision.value must match unit sourceRevision"
            )));
        }
        self.runtime_expectation
            .validate(&format!("{label}.runtimeExpectation"))
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AssetRefV02 {
    pub asset_id: String,
    pub asset_key: Option<String>,
}

impl AssetRefV02 {
    fn validate(&self, label: &str) -> BridgeContractResult<()> {
        assert_uuid7(&self.asset_id, &format!("{label}.assetId"))?;
        if let Some(asset_key) = &self.asset_key {
            assert_non_empty(asset_key, &format!("{label}.assetKey"))?;
        }
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpeakerContextV02 {
    pub knowledge_state: String,
    pub speaker_id: Option<String>,
    pub display_name: Option<String>,
    pub canonical_name_ref: Option<String>,
    pub raw_speaker_text: Option<String>,
    pub evidence: Option<String>,
    pub reader_label: Option<String>,
}

impl SpeakerContextV02 {
    fn validate(&self, label: &str) -> BridgeContractResult<()> {
        assert_one_of(
            &self.knowledge_state,
            &[
                "known",
                "parser_unknown",
                "reader_unknown",
                "not_applicable",
            ],
            &format!("{label}.knowledgeState"),
        )?;
        match self.knowledge_state.as_str() {
            "known" => {
                assert_required_uuid7(self.speaker_id.as_deref(), &format!("{label}.speakerId"))?;
                assert_required_string(
                    self.display_name.as_deref(),
                    &format!("{label}.displayName"),
                )?;
            }
            "reader_unknown" => {
                assert_required_uuid7(self.speaker_id.as_deref(), &format!("{label}.speakerId"))?;
                assert_required_string(
                    self.display_name.as_deref(),
                    &format!("{label}.displayName"),
                )?;
                assert_required_string(
                    self.reader_label.as_deref(),
                    &format!("{label}.readerLabel"),
                )?;
            }
            "parser_unknown" => {
                if let Some(raw) = &self.raw_speaker_text {
                    assert_non_empty(raw, &format!("{label}.rawSpeakerText"))?;
                }
                if let Some(evidence) = &self.evidence {
                    assert_non_empty(evidence, &format!("{label}.evidence"))?;
                }
            }
            "not_applicable" => {}
            _ => unreachable!(),
        }
        if let Some(canonical_name_ref) = &self.canonical_name_ref {
            assert_non_empty(canonical_name_ref, &format!("{label}.canonicalNameRef"))?;
        }
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BridgeSpanV02 {
    pub span_id: String,
    pub span_kind: String,
    pub raw: String,
    pub start_byte: u64,
    pub end_byte: u64,
    pub preserve_mode: String,
    pub parsed_name: Option<Value>,
    pub arguments: Option<Value>,
    pub variable_name: Option<Value>,
    pub format_hint: Option<Value>,
    pub example_values: Option<Value>,
    pub base_start_byte: Option<Value>,
    pub base_end_byte: Option<Value>,
    pub annotation_start_byte: Option<Value>,
    pub annotation_end_byte: Option<Value>,
    pub annotation_text: Option<Value>,
    pub annotation_locale: Option<Value>,
    pub display_mode: Option<Value>,
    pub policy: Option<Value>,
}

impl BridgeSpanV02 {
    fn validate(&self, label: &str, source_text: &str) -> BridgeContractResult<()> {
        assert_uuid7(&self.span_id, &format!("{label}.spanId"))?;
        assert_one_of(
            &self.span_kind,
            &["control_markup", "variable_placeholder", "ruby_annotation"],
            &format!("{label}.spanKind"),
        )?;
        assert_non_empty(&self.raw, &format!("{label}.raw"))?;
        assert_one_of(
            &self.preserve_mode,
            &["exact", "map", "transform", "locale_policy"],
            &format!("{label}.preserveMode"),
        )?;
        assert_optional_value_string(self.parsed_name.as_ref(), &format!("{label}.parsedName"))?;
        if let Some(arguments) = &self.arguments {
            assert_value_string_array(arguments, &format!("{label}.arguments"))?;
        }
        assert_optional_value_string(
            self.variable_name.as_ref(),
            &format!("{label}.variableName"),
        )?;
        assert_optional_value_string(self.format_hint.as_ref(), &format!("{label}.formatHint"))?;
        if let Some(example_values) = &self.example_values {
            assert_value_string_array(example_values, &format!("{label}.exampleValues"))?;
        }
        if self.end_byte <= self.start_byte {
            return Err(BridgeContractValidationError::new(format!(
                "{label}.endByte must be greater than {label}.startByte"
            )));
        }
        let start = self.start_byte as usize;
        let end = self.end_byte as usize;
        let source_bytes = source_text.as_bytes();
        if end > source_bytes.len() {
            return Err(BridgeContractValidationError::new(format!(
                "{label}.endByte must be within sourceText UTF-8 bytes"
            )));
        }
        if &source_bytes[start..end] != self.raw.as_bytes() {
            return Err(BridgeContractValidationError::new(format!(
                "{label}.raw must match sourceText byte range"
            )));
        }
        if let Some(policy) = &self.policy {
            assert_localization_policy_v02(policy, &format!("{label}.policy"))?;
        }
        if self.span_kind == "ruby_annotation" {
            assert_value_byte_range(
                self.base_start_byte.as_ref(),
                self.base_end_byte.as_ref(),
                &format!("{label}.base"),
            )?;
            assert_value_byte_range(
                self.annotation_start_byte.as_ref(),
                self.annotation_end_byte.as_ref(),
                &format!("{label}.annotation"),
            )?;
            assert_required_value_string(
                self.annotation_text.as_ref(),
                &format!("{label}.annotationText"),
            )?;
            assert_optional_value_string(
                self.annotation_locale.as_ref(),
                &format!("{label}.annotationLocale"),
            )?;
            assert_optional_value_string(
                self.display_mode.as_ref(),
                &format!("{label}.displayMode"),
            )?;
        }
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PatchRefV02 {
    pub asset_id: String,
    pub write_mode: String,
    pub source_unit_key: String,
    pub source_revision: SourceRevisionV02,
    pub constraints: Option<Vec<String>>,
}

impl PatchRefV02 {
    fn validate(&self, label: &str) -> BridgeContractResult<()> {
        assert_uuid7(&self.asset_id, &format!("{label}.assetId"))?;
        assert_one_of(
            &self.write_mode,
            &[
                "replace",
                "insert",
                "update_region",
                "replace_asset",
                "metadata",
            ],
            &format!("{label}.writeMode"),
        )?;
        assert_non_empty(&self.source_unit_key, &format!("{label}.sourceUnitKey"))?;
        self.source_revision
            .validate(&format!("{label}.sourceRevision"))?;
        if let Some(constraints) = &self.constraints {
            for (index, constraint) in constraints.iter().enumerate() {
                assert_non_empty(constraint, &format!("{label}.constraints[{index}]"))?;
            }
        }
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeExpectationV02 {
    pub expectation_kind: String,
    pub region: Option<Value>,
    pub trace_key: Option<Value>,
}

impl RuntimeExpectationV02 {
    fn validate(&self, label: &str) -> BridgeContractResult<()> {
        assert_one_of(
            &self.expectation_kind,
            &[
                "trace_text",
                "layout_probe",
                "screenshot_region",
                "metadata_only",
            ],
            &format!("{label}.expectationKind"),
        )?;
        if let Some(region) = &self.region {
            assert_pixel_region_v02(region, &format!("{label}.region"))?;
        }
        if let Some(trace_key) = &self.trace_key {
            assert_value_string(trace_key, &format!("{label}.traceKey"))?;
        }
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PolicyRecordV02 {
    pub policy_record_id: String,
    pub policy_record_kind: String,
    pub policy_action: String,
    pub term_key: String,
    pub source_text: String,
    pub target_locale: Option<String>,
    pub locale_branch_id: Option<String>,
    pub romanization_system: Option<String>,
    pub preserve_form: Option<String>,
    pub scope: Option<String>,
    pub policy_reason: String,
    pub review_required: Option<bool>,
}

impl PolicyRecordV02 {
    fn validate(&self, label: &str) -> BridgeContractResult<()> {
        assert_uuid7(&self.policy_record_id, &format!("{label}.policyRecordId"))?;
        assert_one_of(
            &self.policy_record_kind,
            &["romanized_term", "non_translated_term"],
            &format!("{label}.policyRecordKind"),
        )?;
        assert_one_of(
            &self.policy_action,
            &["localize", "romanize", "do_not_translate"],
            &format!("{label}.policyAction"),
        )?;
        assert_non_empty(&self.term_key, &format!("{label}.termKey"))?;
        assert_non_empty(&self.source_text, &format!("{label}.sourceText"))?;
        if let Some(target_locale) = &self.target_locale {
            assert_non_empty(target_locale, &format!("{label}.targetLocale"))?;
        }
        if let Some(locale_branch_id) = &self.locale_branch_id {
            assert_uuid7(locale_branch_id, &format!("{label}.localeBranchId"))?;
        }
        if self.target_locale.is_none() && self.locale_branch_id.is_none() {
            return Err(BridgeContractValidationError::new(format!(
                "{label} must include targetLocale or localeBranchId"
            )));
        }
        if let Some(scope) = &self.scope {
            assert_surface_kind(scope, &format!("{label}.scope"))?;
        }
        if let Some(romanization_system) = &self.romanization_system {
            assert_non_empty(romanization_system, &format!("{label}.romanizationSystem"))?;
        }
        if let Some(preserve_form) = &self.preserve_form {
            assert_non_empty(preserve_form, &format!("{label}.preserveForm"))?;
        }
        assert_non_empty(&self.policy_reason, &format!("{label}.policyReason"))?;
        Ok(())
    }
}

fn assert_source_location_v02(value: &Value, label: &str) -> BridgeContractResult<()> {
    let location = as_record(value, label)?;
    assert_optional_value_string(
        location.get("containerKey"),
        &format!("{label}.containerKey"),
    )?;
    if let Some(entry_path) = location.get("entryPath") {
        assert_value_string_array(entry_path, &format!("{label}.entryPath"))?;
    }
    if let Some(range) = location.get("range") {
        assert_byte_range_v02(range, &format!("{label}.range"))?;
    }
    if let Some(region) = location.get("region") {
        assert_pixel_region_v02(region, &format!("{label}.region"))?;
    }
    Ok(())
}

fn assert_surface_context_v02(
    value: &Value,
    label: &str,
    surface_kind: &str,
    asset_ids: &HashSet<String>,
) -> BridgeContractResult<()> {
    let context = as_record(value, label)?;
    if let Some(route) = context.get("route") {
        assert_route_context_v02(route, &format!("{label}.route"))?;
    }
    if let Some(choice) = context.get("choice") {
        assert_choice_context_v02(choice, &format!("{label}.choice"))?;
    }
    if let Some(ui) = context.get("ui") {
        assert_ui_context_v02(ui, &format!("{label}.ui"))?;
    }
    if let Some(tutorial) = context.get("tutorial") {
        assert_tutorial_context_v02(tutorial, &format!("{label}.tutorial"))?;
    }
    if let Some(database) = context.get("database") {
        assert_database_context_v02(database, &format!("{label}.database"))?;
    }
    if let Some(song) = context.get("song") {
        assert_song_context_v02(song, &format!("{label}.song"), asset_ids)?;
    }
    if let Some(image_text) = context.get("imageText") {
        assert_image_text_context_v02(image_text, &format!("{label}.imageText"))?;
    }
    if let Some(metadata) = context.get("metadata") {
        assert_metadata_context_v02(metadata, &format!("{label}.metadata"))?;
    }
    if let Some(speaker_name) = context.get("speakerName") {
        assert_speaker_name_context_v02(speaker_name, &format!("{label}.speakerName"))?;
    }

    if let Some(required_context) = required_context_for_surface_kind(surface_kind)
        && !context.contains_key(required_context)
    {
        return Err(BridgeContractValidationError::new(format!(
            "{label}.{required_context} is required for {surface_kind}"
        )));
    }
    Ok(())
}

fn required_context_for_surface_kind(surface_kind: &str) -> Option<&'static str> {
    match surface_kind {
        "choice_label" => Some("choice"),
        "ui_label" => Some("ui"),
        "tutorial_text" => Some("tutorial"),
        "database_entry" => Some("database"),
        "song_title" => Some("song"),
        "image_text" => Some("imageText"),
        "metadata_text" => Some("metadata"),
        "speaker_name" => Some("speakerName"),
        _ => None,
    }
}

fn assert_route_context_v02(value: &Value, label: &str) -> BridgeContractResult<()> {
    let route = as_record(value, label)?;
    assert_optional_value_uuid7(route.get("routeId"), &format!("{label}.routeId"))?;
    assert_optional_value_string(route.get("routeKey"), &format!("{label}.routeKey"))?;
    assert_optional_value_uuid7(route.get("sceneId"), &format!("{label}.sceneId"))?;
    assert_optional_value_string(route.get("sceneKey"), &format!("{label}.sceneKey"))?;
    assert_optional_value_uuid7(route.get("branchId"), &format!("{label}.branchId"))?;
    assert_optional_value_string(route.get("branchKey"), &format!("{label}.branchKey"))?;
    assert_optional_value_string(route.get("position"), &format!("{label}.position"))
}

fn assert_choice_context_v02(value: &Value, label: &str) -> BridgeContractResult<()> {
    let choice = as_record(value, label)?;
    assert_required_value_uuid7(
        choice.get("choiceGroupId"),
        &format!("{label}.choiceGroupId"),
    )?;
    assert_required_value_uuid7(choice.get("choiceId"), &format!("{label}.choiceId"))?;
    assert_non_negative_integer_value(choice.get("optionIndex"), &format!("{label}.optionIndex"))?;
    assert_optional_value_string(
        choice.get("routeTargetRef"),
        &format!("{label}.routeTargetRef"),
    )
}

fn assert_ui_context_v02(value: &Value, label: &str) -> BridgeContractResult<()> {
    let ui = as_record(value, label)?;
    assert_value_one_of(
        ui.get("uiArea"),
        &[
            "dialogue_window",
            "menu",
            "hud",
            "settings",
            "save_load",
            "battle",
            "status",
            "system",
        ],
        &format!("{label}.uiArea"),
    )?;
    assert_optional_value_string(ui.get("controlRef"), &format!("{label}.controlRef"))?;
    assert_optional_value_string(
        ui.get("layoutConstraint"),
        &format!("{label}.layoutConstraint"),
    )
}

fn assert_tutorial_context_v02(value: &Value, label: &str) -> BridgeContractResult<()> {
    let tutorial = as_record(value, label)?;
    assert_required_value_string(
        tutorial.get("tutorialStepRef"),
        &format!("{label}.tutorialStepRef"),
    )?;
    if let Some(input_action_refs) = tutorial.get("inputActionRefs") {
        assert_value_string_array(input_action_refs, &format!("{label}.inputActionRefs"))?;
    }
    assert_optional_value_string(
        tutorial.get("platformCondition"),
        &format!("{label}.platformCondition"),
    )
}

fn assert_database_context_v02(value: &Value, label: &str) -> BridgeContractResult<()> {
    let database = as_record(value, label)?;
    assert_value_one_of(
        database.get("databaseKind"),
        &[
            "item",
            "skill",
            "quest",
            "location",
            "achievement",
            "character_bio",
            "bestiary",
            "codex",
            "encyclopedia",
        ],
        &format!("{label}.databaseKind"),
    )?;
    assert_required_value_string(database.get("entryId"), &format!("{label}.entryId"))?;
    assert_required_value_string(database.get("fieldKey"), &format!("{label}.fieldKey"))?;
    assert_optional_value_string(database.get("sortKey"), &format!("{label}.sortKey"))
}

fn assert_song_context_v02(
    value: &Value,
    label: &str,
    asset_ids: &HashSet<String>,
) -> BridgeContractResult<()> {
    let song = as_record(value, label)?;
    if let Some(audio_asset_ref) = song.get("audioAssetRef") {
        let asset_id =
            assert_asset_ref_value_v02(audio_asset_ref, &format!("{label}.audioAssetRef"))?;
        assert_known_asset_id(
            asset_id,
            &format!("{label}.audioAssetRef.assetId"),
            asset_ids,
        )?;
    }
    assert_optional_value_string(song.get("trackId"), &format!("{label}.trackId"))?;
    assert_required_value_string(song.get("titleField"), &format!("{label}.titleField"))?;
    if let Some(credit_refs) = song.get("creditRefs") {
        assert_value_string_array(credit_refs, &format!("{label}.creditRefs"))?;
    }
    Ok(())
}

fn assert_image_text_context_v02(value: &Value, label: &str) -> BridgeContractResult<()> {
    let image_text = as_record(value, label)?;
    assert_required_pixel_region_v02(image_text.get("region"), &format!("{label}.region"))?;
    assert_optional_value_string(image_text.get("ocrText"), &format!("{label}.ocrText"))?;
    assert_required_boolean(image_text.get("editable"), &format!("{label}.editable"))?;
    assert_value_one_of(
        image_text.get("replacementMode"),
        &[
            "redraw_region",
            "overlay_text",
            "replace_asset",
            "metadata_only",
        ],
        &format!("{label}.replacementMode"),
    )
}

fn assert_metadata_context_v02(value: &Value, label: &str) -> BridgeContractResult<()> {
    let metadata = as_record(value, label)?;
    assert_value_one_of(
        metadata.get("metadataScope"),
        &[
            "package",
            "platform",
            "save_data",
            "credits",
            "config",
            "achievement",
        ],
        &format!("{label}.metadataScope"),
    )?;
    assert_required_value_string(metadata.get("fieldKey"), &format!("{label}.fieldKey"))?;
    assert_value_one_of(
        metadata.get("visibility"),
        &["runtime", "package", "platform", "internal"],
        &format!("{label}.visibility"),
    )
}

fn assert_speaker_name_context_v02(value: &Value, label: &str) -> BridgeContractResult<()> {
    let speaker_name = as_record(value, label)?;
    assert_value_one_of(
        speaker_name.get("displayContext"),
        &["name_plate", "backlog", "chat", "battle_callout"],
        &format!("{label}.displayContext"),
    )?;
    assert_optional_value_string(
        speaker_name.get("canonicalNameRef"),
        &format!("{label}.canonicalNameRef"),
    )
}

fn assert_localization_policy_v02(value: &Value, label: &str) -> BridgeContractResult<()> {
    let policy = as_record(value, label)?;
    assert_value_one_of(
        policy.get("policyAction"),
        &["localize", "romanize", "do_not_translate"],
        &format!("{label}.policyAction"),
    )?;
    assert_optional_value_string(policy.get("targetLocale"), &format!("{label}.targetLocale"))?;
    assert_optional_value_uuid7(
        policy.get("localeBranchId"),
        &format!("{label}.localeBranchId"),
    )?;
    assert_optional_value_string(policy.get("targetText"), &format!("{label}.targetText"))?;
    assert_optional_value_string(
        policy.get("romanizationSystem"),
        &format!("{label}.romanizationSystem"),
    )?;
    assert_optional_value_string(policy.get("policyReason"), &format!("{label}.policyReason"))?;
    if policy.get("targetLocale").is_none() && policy.get("localeBranchId").is_none() {
        return Err(BridgeContractValidationError::new(format!(
            "{label} must include targetLocale or localeBranchId"
        )));
    }
    Ok(())
}

fn assert_asset_ref_value_v02<'a>(value: &'a Value, label: &str) -> BridgeContractResult<&'a str> {
    let asset_ref = as_record(value, label)?;
    let asset_id =
        assert_required_value_uuid7(asset_ref.get("assetId"), &format!("{label}.assetId"))?;
    assert_optional_value_string(asset_ref.get("assetKey"), &format!("{label}.assetKey"))?;
    Ok(asset_id)
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
    pub protected_span_mappings: Vec<ProtectedSpanMapping>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProtectedSpanMapping {
    pub raw: String,
    pub target_start: u64,
    pub target_end: u64,
}

impl ProtectedSpanMapping {
    pub fn new(raw: impl Into<String>, target_start: u64, target_end: u64) -> Self {
        Self {
            raw: raw.into(),
            target_start,
            target_end,
        }
    }

    pub fn first_in_target(raw: &str, target_text: &str) -> Option<Self> {
        let start = target_text.find(raw)?;
        let end = start + raw.len();
        Some(Self::new(raw, start as u64, end as u64))
    }

    pub fn matches_target_text(&self, target_text: &str) -> bool {
        let Ok(start) = usize::try_from(self.target_start) else {
            return false;
        };
        let Ok(end) = usize::try_from(self.target_end) else {
            return false;
        };
        if end <= start
            || end > target_text.len()
            || !target_text.is_char_boundary(start)
            || !target_text.is_char_boundary(end)
        {
            return false;
        }
        target_text[start..end] == self.raw
    }
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
pub enum GoldenAssertionStatus {
    Passed,
    Failed,
    Skipped,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GoldenPhaseReport {
    pub phase: String,
    pub status: GoldenAssertionStatus,
    pub details: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub asset_ref: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_unit_key: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub support_boundary: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expected: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub actual: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GoldenFailure {
    pub code: String,
    pub phase: String,
    pub adapter_id: String,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub asset_ref: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_unit_key: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub support_boundary: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expected: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub actual: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GoldenRoundTripReport {
    pub schema_version: String,
    pub report_id: String,
    pub adapter_id: String,
    pub adapter_name: String,
    pub status: OperationStatus,
    pub phases: Vec<GoldenPhaseReport>,
    pub failures: Vec<GoldenFailure>,
}

impl GoldenRoundTripReport {
    pub fn stable_json(&self) -> KaifuuResult<String> {
        stable_json(self)
    }
}

pub enum GoldenByteEquivalenceMode {
    AssertSourceJson,
    Unsupported { support_boundary: String },
}

pub struct GoldenHarnessRequest<'a> {
    pub game_dir: &'a Path,
    pub work_dir: &'a Path,
    pub adapter_id: Option<&'a str>,
    pub byte_equivalence: GoldenByteEquivalenceMode,
    pub translated_patch_export: Option<&'a Value>,
    pub translated_source_bridge: Option<&'a Value>,
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

fn assert_schema_version_v02(value: &str, label: &str) -> BridgeContractResult<()> {
    if value == BRIDGE_SCHEMA_VERSION_V02 {
        return Ok(());
    }
    if value == "0.1.0" {
        return Err(BridgeContractValidationError::new(format!(
            "{label} must be {BRIDGE_SCHEMA_VERSION_V02}; 0.1.0 is the legacy fixture contract"
        )));
    }
    Err(BridgeContractValidationError::new(format!(
        "{label} must be {BRIDGE_SCHEMA_VERSION_V02}"
    )))
}

fn assert_required_string(value: Option<&str>, label: &str) -> BridgeContractResult<()> {
    match value {
        Some(value) => assert_non_empty(value, label),
        None => Err(BridgeContractValidationError::new(format!(
            "{label} must be a non-empty string"
        ))),
    }
}

fn assert_required_uuid7(value: Option<&str>, label: &str) -> BridgeContractResult<()> {
    match value {
        Some(value) => assert_uuid7(value, label),
        None => Err(BridgeContractValidationError::new(format!(
            "{label} must be a UUID7 string"
        ))),
    }
}

fn assert_non_empty(value: &str, label: &str) -> BridgeContractResult<()> {
    if value.is_empty() {
        Err(BridgeContractValidationError::new(format!(
            "{label} must be a non-empty string"
        )))
    } else {
        Ok(())
    }
}

fn assert_equals(value: &str, expected: &str, label: &str) -> BridgeContractResult<()> {
    if value == expected {
        Ok(())
    } else {
        Err(BridgeContractValidationError::new(format!(
            "{label} must be {expected}"
        )))
    }
}

fn assert_one_of(value: &str, allowed: &[&str], label: &str) -> BridgeContractResult<()> {
    if allowed.contains(&value) {
        Ok(())
    } else {
        Err(BridgeContractValidationError::new(format!(
            "{label} must be one of: {}",
            allowed.join(", ")
        )))
    }
}

fn assert_surface_kind(value: &str, label: &str) -> BridgeContractResult<()> {
    assert_one_of(
        value,
        &[
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
        ],
        label,
    )
}

fn assert_known_asset_id(
    asset_id: &str,
    label: &str,
    asset_ids: &HashSet<String>,
) -> BridgeContractResult<()> {
    if asset_ids.contains(asset_id) {
        Ok(())
    } else {
        Err(BridgeContractValidationError::new(format!(
            "{label} must reference an asset in BridgeBundleV02.assets"
        )))
    }
}

fn as_record<'a>(
    value: &'a Value,
    label: &str,
) -> BridgeContractResult<&'a serde_json::Map<String, Value>> {
    value
        .as_object()
        .ok_or_else(|| BridgeContractValidationError::new(format!("{label} must be an object")))
}

fn assert_required_value_string<'a>(
    value: Option<&'a Value>,
    label: &str,
) -> BridgeContractResult<&'a str> {
    match value {
        Some(value) => assert_value_string(value, label),
        None => Err(BridgeContractValidationError::new(format!(
            "{label} must be a non-empty string"
        ))),
    }
}

fn assert_optional_value_string(value: Option<&Value>, label: &str) -> BridgeContractResult<()> {
    if let Some(value) = value {
        assert_value_string(value, label)?;
    }
    Ok(())
}

fn assert_value_string<'a>(value: &'a Value, label: &str) -> BridgeContractResult<&'a str> {
    match value.as_str() {
        Some(value) if !value.is_empty() => Ok(value),
        _ => Err(BridgeContractValidationError::new(format!(
            "{label} must be a non-empty string"
        ))),
    }
}

fn assert_value_string_array(value: &Value, label: &str) -> BridgeContractResult<()> {
    let array = value
        .as_array()
        .ok_or_else(|| BridgeContractValidationError::new(format!("{label} must be an array")))?;
    for (index, item) in array.iter().enumerate() {
        assert_value_string(item, &format!("{label}[{index}]"))?;
    }
    Ok(())
}

fn assert_required_value_uuid7<'a>(
    value: Option<&'a Value>,
    label: &str,
) -> BridgeContractResult<&'a str> {
    let value = assert_required_value_string(value, label)?;
    assert_uuid7(value, label)?;
    Ok(value)
}

fn assert_optional_value_uuid7(value: Option<&Value>, label: &str) -> BridgeContractResult<()> {
    if let Some(value) = value {
        let value = assert_value_string(value, label)?;
        assert_uuid7(value, label)?;
    }
    Ok(())
}

fn assert_value_one_of(
    value: Option<&Value>,
    allowed: &[&str],
    label: &str,
) -> BridgeContractResult<()> {
    let value = assert_required_value_string(value, label)?;
    assert_one_of(value, allowed, label)
}

fn assert_non_negative_integer_value(
    value: Option<&Value>,
    label: &str,
) -> BridgeContractResult<u64> {
    match value.and_then(Value::as_u64) {
        Some(value) => Ok(value),
        None => Err(BridgeContractValidationError::new(format!(
            "{label} must be a non-negative integer"
        ))),
    }
}

fn assert_positive_integer_value(value: Option<&Value>, label: &str) -> BridgeContractResult<u64> {
    match value.and_then(Value::as_u64) {
        Some(value) if value > 0 => Ok(value),
        _ => Err(BridgeContractValidationError::new(format!(
            "{label} must be a positive integer"
        ))),
    }
}

fn assert_required_boolean(value: Option<&Value>, label: &str) -> BridgeContractResult<()> {
    if value.and_then(Value::as_bool).is_some() {
        Ok(())
    } else {
        Err(BridgeContractValidationError::new(format!(
            "{label} must be a boolean"
        )))
    }
}

fn assert_byte_range_v02(value: &Value, label: &str) -> BridgeContractResult<()> {
    let range = as_record(value, label)?;
    let start_byte =
        assert_non_negative_integer_value(range.get("startByte"), &format!("{label}.startByte"))?;
    let end_byte =
        assert_non_negative_integer_value(range.get("endByte"), &format!("{label}.endByte"))?;
    if end_byte <= start_byte {
        return Err(BridgeContractValidationError::new(format!(
            "{label}.endByte must be greater than {label}.startByte"
        )));
    }
    Ok(())
}

fn assert_value_byte_range(
    start_byte: Option<&Value>,
    end_byte: Option<&Value>,
    label: &str,
) -> BridgeContractResult<()> {
    let start_byte = assert_non_negative_integer_value(start_byte, &format!("{label}.startByte"))?;
    let end_byte = assert_non_negative_integer_value(end_byte, &format!("{label}.endByte"))?;
    if end_byte <= start_byte {
        return Err(BridgeContractValidationError::new(format!(
            "{label}.endByte must be greater than {label}.startByte"
        )));
    }
    Ok(())
}

fn assert_required_pixel_region_v02(
    value: Option<&Value>,
    label: &str,
) -> BridgeContractResult<()> {
    match value {
        Some(value) => assert_pixel_region_v02(value, label),
        None => Err(BridgeContractValidationError::new(format!(
            "{label} must be an object"
        ))),
    }
}

fn assert_pixel_region_v02(value: &Value, label: &str) -> BridgeContractResult<()> {
    let region = as_record(value, label)?;
    assert_non_negative_integer_value(region.get("x"), &format!("{label}.x"))?;
    assert_non_negative_integer_value(region.get("y"), &format!("{label}.y"))?;
    assert_positive_integer_value(region.get("width"), &format!("{label}.width"))?;
    assert_positive_integer_value(region.get("height"), &format!("{label}.height"))?;
    Ok(())
}

fn assert_revision_hash_matches_v02(
    revision: &SourceRevisionV02,
    hash: &str,
    label: &str,
) -> BridgeContractResult<()> {
    if revision.revision_kind == "content_hash" && revision.value != hash {
        Err(BridgeContractValidationError::new(format!(
            "{label}.value must equal the matching content hash"
        )))
    } else {
        Ok(())
    }
}

fn assert_hash_string_v02(value: &str, label: &str) -> BridgeContractResult<()> {
    if value.len() != 71 || !value.starts_with("sha256:") {
        return Err(BridgeContractValidationError::new(format!(
            "{label} must be a canonical sha256 hash string"
        )));
    }
    if value[7..]
        .bytes()
        .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        Ok(())
    } else {
        Err(BridgeContractValidationError::new(format!(
            "{label} must be a canonical sha256 hash string"
        )))
    }
}

fn assert_uuid7(value: &str, label: &str) -> BridgeContractResult<()> {
    let bytes = value.as_bytes();
    let valid = bytes.len() == 36
        && bytes[8] == b'-'
        && bytes[13] == b'-'
        && bytes[18] == b'-'
        && bytes[23] == b'-'
        && bytes[14] == b'7'
        && matches!(bytes[19], b'8' | b'9' | b'a' | b'b' | b'A' | b'B')
        && bytes
            .iter()
            .enumerate()
            .all(|(index, byte)| matches!(index, 8 | 13 | 18 | 23) || byte.is_ascii_hexdigit());
    if valid {
        Ok(())
    } else {
        Err(BridgeContractValidationError::new(format!(
            "{label} must be a UUID7 string"
        )))
    }
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

pub fn safe_join_relative(root: &Path, relative_path: &str) -> KaifuuResult<PathBuf> {
    let parts = safe_relative_path_parts(relative_path)?;
    let mut output_path = root.to_path_buf();
    for part in parts {
        output_path.push(part);
    }
    Ok(output_path)
}

fn safe_relative_path_parts(relative_path: &str) -> KaifuuResult<Vec<&str>> {
    if relative_path.is_empty()
        || relative_path.starts_with('/')
        || relative_path.starts_with('\\')
        || relative_path.contains('\0')
    {
        return Err(unsafe_relative_path_error(relative_path));
    }

    let parts = relative_path.split(['/', '\\']).collect::<Vec<_>>();
    if parts.iter().enumerate().any(|(index, part)| {
        part.is_empty()
            || *part == "."
            || *part == ".."
            || (index == 0 && part.ends_with(':'))
            || is_windows_drive_prefix_component(part)
    }) {
        return Err(unsafe_relative_path_error(relative_path));
    }

    Ok(parts)
}

fn path_has_windows_drive_prefix_component(path: &str) -> bool {
    path.split(['/', '\\'])
        .any(is_windows_drive_prefix_component)
}

fn is_windows_drive_prefix_component(component: &str) -> bool {
    let bytes = component.as_bytes();
    bytes.len() >= 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':'
}

fn unsafe_relative_path_error(relative_path: &str) -> Box<dyn std::error::Error> {
    format!(
        "unsafe relative output path {relative_path:?}: path must be relative and must not contain traversal or drive prefixes"
    )
    .into()
}

pub fn atomic_write_text(path: &Path, content: &str) -> KaifuuResult<()> {
    let parent = path.parent().unwrap_or_else(|| Path::new("."));
    let file_name = path
        .file_name()
        .ok_or("atomic write target must include a file name")?
        .to_string_lossy();
    fs::create_dir_all(parent)?;

    let mut attempt = 0_u32;
    let temp_path = loop {
        let candidate = parent.join(format!(".{file_name}.tmp-{}-{attempt}", std::process::id()));
        match OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&candidate)
        {
            Ok(mut file) => {
                if let Err(error) = write_and_sync(&mut file, content) {
                    let _ = fs::remove_file(&candidate);
                    return Err(error);
                }
                break candidate;
            }
            Err(error) if error.kind() == ErrorKind::AlreadyExists => {
                attempt = attempt
                    .checked_add(1)
                    .ok_or("could not allocate atomic write temp file")?;
            }
            Err(error) => return Err(error.into()),
        }
    };

    if let Err(error) = fs::rename(&temp_path, path) {
        let _ = fs::remove_file(&temp_path);
        return Err(error.into());
    }
    sync_directory_best_effort(parent);
    Ok(())
}

fn write_and_sync(file: &mut File, content: &str) -> KaifuuResult<()> {
    file.write_all(content.as_bytes())?;
    file.sync_all()?;
    Ok(())
}

fn sync_directory_best_effort(path: &Path) {
    if let Ok(directory) = File::open(path) {
        let _ = directory.sync_all();
    }
}

pub fn write_json<T>(path: &Path, value: &T) -> KaifuuResult<()>
where
    T: Serialize,
{
    atomic_write_text(path, &stable_json(value)?)
}

pub fn stable_json<T>(value: &T) -> KaifuuResult<String>
where
    T: Serialize,
{
    let pretty = serde_json::to_string_pretty(value)?;
    Ok(format!("{}\n", compact_primitive_json_arrays(&pretty)?))
}

fn compact_primitive_json_arrays(pretty: &str) -> KaifuuResult<String> {
    let lines = pretty.lines().collect::<Vec<_>>();
    let mut formatted = Vec::with_capacity(lines.len());
    let mut index = 0;

    while index < lines.len() {
        let line = lines[index];
        if let Some(compacted) = compact_primitive_json_array(&lines, index)? {
            formatted.push(compacted.line);
            index = compacted.next_index;
        } else {
            formatted.push(line.to_string());
            index += 1;
        }
    }

    Ok(formatted.join("\n"))
}

struct CompactedJsonArray {
    line: String,
    next_index: usize,
}

fn compact_primitive_json_array(
    lines: &[&str],
    start_index: usize,
) -> KaifuuResult<Option<CompactedJsonArray>> {
    let line = lines[start_index];
    let trimmed = line.trim_end();
    if trimmed == "[" || !trimmed.ends_with('[') {
        return Ok(None);
    }
    let Some(open_index) = line.rfind('[') else {
        return Ok(None);
    };
    let prefix = &line[..open_index];
    let mut items = Vec::new();
    let mut index = start_index + 1;

    while let Some(candidate) = lines.get(index) {
        let trimmed_candidate = candidate.trim();
        if trimmed_candidate == "]" || trimmed_candidate == "]," {
            if items.is_empty() {
                return Ok(None);
            }
            let trailing_comma = if trimmed_candidate.ends_with(',') {
                ","
            } else {
                ""
            };
            return Ok(Some(CompactedJsonArray {
                line: format!("{prefix}[{}]{trailing_comma}", items.join(", ")),
                next_index: index + 1,
            }));
        }

        let item = trimmed_candidate
            .strip_suffix(',')
            .unwrap_or(trimmed_candidate);
        let parsed: Value = match serde_json::from_str(item) {
            Ok(value) => value,
            Err(_) => return Ok(None),
        };
        if !is_primitive_json_value(&parsed) {
            return Ok(None);
        }
        items.push(item.to_string());
        index += 1;
    }

    Ok(None)
}

fn is_primitive_json_value(value: &Value) -> bool {
    matches!(
        value,
        Value::Null | Value::Bool(_) | Value::Number(_) | Value::String(_)
    )
}

pub fn read_json<T>(path: &Path) -> KaifuuResult<T>
where
    T: for<'de> Deserialize<'de>,
{
    Ok(serde_json::from_str(&fs::read_to_string(path)?)?)
}

pub fn run_round_trip_golden(
    registry: &AdapterRegistry,
    request: GoldenHarnessRequest<'_>,
) -> KaifuuResult<GoldenRoundTripReport> {
    let adapter = golden_adapter(registry, request.game_dir, request.adapter_id)?;
    let mut report = GoldenRoundTripReport {
        schema_version: "0.1.0".to_string(),
        report_id: deterministic_id("golden-round-trip", 1),
        adapter_id: adapter.id().to_string(),
        adapter_name: adapter.name().to_string(),
        status: OperationStatus::Passed,
        phases: vec![],
        failures: vec![],
    };

    let detection = adapter.detect(DetectRequest {
        game_dir: request.game_dir,
    });
    match detection {
        Ok(detection) if detection.detected => report_passed_phase(
            &mut report,
            "detect",
            "adapter detected the fixture input",
            None,
        ),
        Ok(detection) => {
            let failure = GoldenFailure {
                code: "adapter_not_detected".to_string(),
                phase: "detect".to_string(),
                adapter_id: adapter.id().to_string(),
                message: "selected adapter did not detect the fixture input".to_string(),
                asset_ref: detection
                    .evidence
                    .first()
                    .map(|evidence| evidence.path.clone()),
                source_unit_key: None,
                support_boundary: None,
                expected: Some("detected=true".to_string()),
                actual: Some("detected=false".to_string()),
            };
            record_golden_failure(&mut report, failure);
            return Ok(finalize_golden_report(report));
        }
        Err(error) => {
            record_golden_failure(
                &mut report,
                GoldenFailure {
                    code: "detect_error".to_string(),
                    phase: "detect".to_string(),
                    adapter_id: adapter.id().to_string(),
                    message: error.to_string(),
                    asset_ref: None,
                    source_unit_key: None,
                    support_boundary: None,
                    expected: Some("successful detection".to_string()),
                    actual: Some("adapter error".to_string()),
                },
            );
            return Ok(finalize_golden_report(report));
        }
    }

    let extraction = match adapter.extract(ExtractRequest {
        game_dir: request.game_dir,
    }) {
        Ok(extraction) => {
            report_passed_phase(
                &mut report,
                "extract",
                format!("extracted {} bridge unit(s)", extraction.bridge.units.len()),
                None,
            );
            extraction
        }
        Err(error) => {
            record_golden_failure(
                &mut report,
                GoldenFailure {
                    code: "extract_error".to_string(),
                    phase: "extract".to_string(),
                    adapter_id: adapter.id().to_string(),
                    message: error.to_string(),
                    asset_ref: None,
                    source_unit_key: None,
                    support_boundary: None,
                    expected: Some("successful extraction".to_string()),
                    actual: Some("adapter error".to_string()),
                },
            );
            return Ok(finalize_golden_report(report));
        }
    };

    let unchanged_patch = match unchanged_patch_export(&extraction.bridge) {
        Ok(patch) => patch,
        Err(failure) => {
            record_golden_failure(&mut report, failure.with_adapter_id(adapter.id()));
            return Ok(finalize_golden_report(report));
        }
    };

    let unchanged_output_dir = prepare_golden_work_dir(request.work_dir, "unchanged-patch")?;
    match adapter.patch(PatchRequest {
        game_dir: request.game_dir,
        patch_export: &unchanged_patch,
        output_dir: &unchanged_output_dir,
    }) {
        Ok(patch_result) if patch_result.status == OperationStatus::Passed => report_passed_phase(
            &mut report,
            "unchanged_patch",
            "unchanged patch applied successfully",
            Some("source.json"),
        ),
        Ok(patch_result) => {
            record_adapter_failures(&mut report, adapter.id(), "unchanged_patch", &patch_result);
            return Ok(finalize_golden_report(report));
        }
        Err(error) => {
            record_golden_failure(
                &mut report,
                GoldenFailure {
                    code: "unchanged_patch_error".to_string(),
                    phase: "unchanged_patch".to_string(),
                    adapter_id: adapter.id().to_string(),
                    message: error.to_string(),
                    asset_ref: Some("source.json".to_string()),
                    source_unit_key: None,
                    support_boundary: None,
                    expected: Some("successful unchanged patch".to_string()),
                    actual: Some("adapter error".to_string()),
                },
            );
            return Ok(finalize_golden_report(report));
        }
    }

    report_byte_equivalence(
        &mut report,
        request.game_dir,
        &unchanged_output_dir,
        &request.byte_equivalence,
    );
    report_verify_phase(
        adapter,
        &mut report,
        "unchanged_verify",
        &unchanged_output_dir,
    );
    report_output_equivalence(
        adapter,
        &mut report,
        &extraction,
        &unchanged_output_dir,
        "unchanged_output_equivalence",
    );

    if let Some(translated_patch_export) = request.translated_patch_export {
        report_translated_patch(
            adapter,
            &mut report,
            &extraction,
            request.game_dir,
            request.work_dir,
            translated_patch_export,
            request.translated_source_bridge,
        )?;
    }

    Ok(finalize_golden_report(report))
}

fn golden_adapter<'a>(
    registry: &'a AdapterRegistry,
    game_dir: &Path,
    adapter_id: Option<&str>,
) -> KaifuuResult<&'a dyn EngineAdapter> {
    if let Some(adapter_id) = adapter_id {
        return registry
            .get(adapter_id)
            .ok_or_else(|| format!("adapter {adapter_id} is not registered").into());
    }

    let detection = registry
        .detect(game_dir)?
        .ok_or_else(|| format!("no registered adapter detected {}", game_dir.display()))?;
    registry.get(&detection.adapter_id).ok_or_else(|| {
        format!(
            "detected adapter {} is not registered",
            detection.adapter_id
        )
        .into()
    })
}

fn prepare_golden_work_dir(root: &Path, child: &str) -> KaifuuResult<PathBuf> {
    let path = safe_join_relative(root, child)?;
    match fs::remove_dir_all(&path) {
        Ok(()) => {}
        Err(error) if error.kind() == ErrorKind::NotFound => {}
        Err(error) => return Err(error.into()),
    }
    fs::create_dir_all(&path)?;
    Ok(path)
}

fn unchanged_patch_export(bridge: &BridgeBundle) -> Result<PatchExport, GoldenFailure> {
    let mut entries = Vec::with_capacity(bridge.units.len());
    for unit in &bridge.units {
        let mut protected_span_mappings = Vec::new();
        let mut search_start = 0;
        for span in &unit.protected_spans {
            if span.raw.is_empty() {
                continue;
            }
            let Some(relative_start) = unit.source_text[search_start..].find(&span.raw) else {
                return Err(GoldenFailure {
                    code: "unchanged_patch_protected_span_missing".to_string(),
                    phase: "unchanged_patch_build".to_string(),
                    adapter_id: String::new(),
                    message: format!(
                        "protected span raw text {:?} was not present while building unchanged patch",
                        span.raw
                    ),
                    asset_ref: Some(unit.patch_ref.asset_id.clone()),
                    source_unit_key: Some(unit.source_unit_key.clone()),
                    support_boundary: Some(
                        "unchanged patch generation requires protected span raw text to exist in sourceText"
                            .to_string(),
                    ),
                    expected: Some(span.raw.clone()),
                    actual: Some(unit.source_text.clone()),
                });
            };
            let target_start = search_start + relative_start;
            let target_end = target_start + span.raw.len();
            search_start = target_end;
            protected_span_mappings.push(ProtectedSpanMapping::new(
                &span.raw,
                target_start as u64,
                target_end as u64,
            ));
        }
        entries.push(PatchExportEntry {
            bridge_unit_id: unit.bridge_unit_id.clone(),
            source_unit_key: unit.source_unit_key.clone(),
            source_hash: unit.source_hash.clone(),
            target_text: unit.source_text.clone(),
            protected_span_mappings,
        });
    }

    Ok(PatchExport {
        patch_export_id: deterministic_id("round-trip-patch", 1),
        source_locale: bridge.source_locale.clone(),
        target_locale: bridge.source_locale.clone(),
        entries,
    })
}

impl GoldenFailure {
    fn with_adapter_id(mut self, adapter_id: &str) -> Self {
        self.adapter_id = adapter_id.to_string();
        self
    }
}

fn report_passed_phase(
    report: &mut GoldenRoundTripReport,
    phase: &str,
    details: impl Into<String>,
    asset_ref: Option<&str>,
) {
    report.phases.push(GoldenPhaseReport {
        phase: phase.to_string(),
        status: GoldenAssertionStatus::Passed,
        details: details.into(),
        asset_ref: asset_ref.map(str::to_string),
        source_unit_key: None,
        support_boundary: None,
        expected: None,
        actual: None,
    });
}

fn record_golden_failure(report: &mut GoldenRoundTripReport, failure: GoldenFailure) {
    report.phases.push(GoldenPhaseReport {
        phase: failure.phase.clone(),
        status: GoldenAssertionStatus::Failed,
        details: failure.message.clone(),
        asset_ref: failure.asset_ref.clone(),
        source_unit_key: failure.source_unit_key.clone(),
        support_boundary: failure.support_boundary.clone(),
        expected: failure.expected.clone(),
        actual: failure.actual.clone(),
    });
    report.failures.push(failure);
}

fn record_adapter_failures(
    report: &mut GoldenRoundTripReport,
    adapter_id: &str,
    phase: &str,
    patch_result: &PatchResult,
) {
    if patch_result.failures.is_empty() {
        record_golden_failure(
            report,
            GoldenFailure {
                code: "patch_failed_without_detail".to_string(),
                phase: phase.to_string(),
                adapter_id: adapter_id.to_string(),
                message: "adapter returned failed patch status without detailed failures"
                    .to_string(),
                asset_ref: None,
                source_unit_key: None,
                support_boundary: None,
                expected: Some("patch status passed".to_string()),
                actual: Some("patch status failed".to_string()),
            },
        );
        return;
    }

    for failure in &patch_result.failures {
        let asset_ref = failure.asset_ref.clone();
        record_golden_failure(
            report,
            GoldenFailure {
                code: failure.error_code.clone(),
                phase: phase.to_string(),
                adapter_id: adapter_id.to_string(),
                message: failure
                    .remediation
                    .clone()
                    .unwrap_or_else(|| failure.support_boundary.clone()),
                source_unit_key: source_unit_key_from_asset_ref(asset_ref.as_deref()),
                asset_ref,
                support_boundary: Some(failure.support_boundary.clone()),
                expected: Some("patch status passed".to_string()),
                actual: Some("patch status failed".to_string()),
            },
        );
    }
}

fn report_byte_equivalence(
    report: &mut GoldenRoundTripReport,
    game_dir: &Path,
    output_dir: &Path,
    mode: &GoldenByteEquivalenceMode,
) {
    match mode {
        GoldenByteEquivalenceMode::Unsupported { support_boundary } => {
            report.phases.push(GoldenPhaseReport {
                phase: "byte_equivalence".to_string(),
                status: GoldenAssertionStatus::Skipped,
                details: "byte-identical round-trip is not claimed for this adapter".to_string(),
                asset_ref: Some("source.json".to_string()),
                source_unit_key: None,
                support_boundary: Some(support_boundary.clone()),
                expected: None,
                actual: None,
            });
        }
        GoldenByteEquivalenceMode::AssertSourceJson => {
            let original_path = game_dir.join("source.json");
            let patched_path = output_dir.join("source.json");
            match (fs::read(&original_path), fs::read(&patched_path)) {
                (Ok(original), Ok(patched)) if original == patched => report_passed_phase(
                    report,
                    "byte_equivalence",
                    "source.json bytes are identical after unchanged patch",
                    Some("source.json"),
                ),
                (Ok(original), Ok(patched)) => record_golden_failure(
                    report,
                    GoldenFailure {
                        code: "byte_equivalence_mismatch".to_string(),
                        phase: "byte_equivalence".to_string(),
                        adapter_id: report.adapter_id.clone(),
                        message: "source.json bytes changed after unchanged patch".to_string(),
                        asset_ref: Some("source.json".to_string()),
                        source_unit_key: None,
                        support_boundary: Some(
                            "byte-identical mode requires unchanged patch output to match the input bytes"
                                .to_string(),
                        ),
                        expected: Some(byte_content_hash(&original)),
                        actual: Some(byte_content_hash(&patched)),
                    },
                ),
                (original, patched) => record_golden_failure(
                    report,
                    GoldenFailure {
                        code: "byte_equivalence_io_error".to_string(),
                        phase: "byte_equivalence".to_string(),
                        adapter_id: report.adapter_id.clone(),
                        message: format!(
                            "could not read source.json for byte comparison: original={}, patched={}",
                            original.err().map(|error| error.to_string()).unwrap_or_default(),
                            patched.err().map(|error| error.to_string()).unwrap_or_default()
                        ),
                        asset_ref: Some("source.json".to_string()),
                        source_unit_key: None,
                        support_boundary: Some(
                            "byte-identical mode requires source.json to exist before and after patching"
                                .to_string(),
                        ),
                        expected: Some("readable source.json input and output".to_string()),
                        actual: Some("missing or unreadable source.json".to_string()),
                    },
                ),
            }
        }
    }
}

fn byte_content_hash(bytes: &[u8]) -> String {
    let mut hash: u64 = 0xcbf29ce484222325;
    for byte in bytes {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x100000001b3);
    }
    format!("{hash:016x}")
}

fn report_verify_phase(
    adapter: &dyn EngineAdapter,
    report: &mut GoldenRoundTripReport,
    phase: &str,
    game_dir: &Path,
) {
    match adapter.verify(VerifyRequest { game_dir }) {
        Ok(verify) if verify.status == OperationStatus::Passed => report_passed_phase(
            report,
            phase,
            "adapter verification passed",
            Some("source.json"),
        ),
        Ok(verify) => {
            if verify.failures.is_empty() {
                record_golden_failure(
                    report,
                    GoldenFailure {
                        code: "verify_failed_without_detail".to_string(),
                        phase: phase.to_string(),
                        adapter_id: adapter.id().to_string(),
                        message: "adapter verification failed without detailed failures"
                            .to_string(),
                        asset_ref: Some("source.json".to_string()),
                        source_unit_key: None,
                        support_boundary: None,
                        expected: Some("verify status passed".to_string()),
                        actual: Some("verify status failed".to_string()),
                    },
                );
            } else {
                for failure in verify.failures {
                    let asset_ref = failure.asset_ref.clone();
                    record_golden_failure(
                        report,
                        GoldenFailure {
                            code: failure.error_code,
                            phase: phase.to_string(),
                            adapter_id: adapter.id().to_string(),
                            message: failure
                                .remediation
                                .unwrap_or_else(|| failure.support_boundary.clone()),
                            source_unit_key: source_unit_key_from_asset_ref(asset_ref.as_deref()),
                            asset_ref,
                            support_boundary: Some(failure.support_boundary),
                            expected: Some("verify status passed".to_string()),
                            actual: Some("verify status failed".to_string()),
                        },
                    );
                }
            }
        }
        Err(error) => record_golden_failure(
            report,
            GoldenFailure {
                code: "verify_error".to_string(),
                phase: phase.to_string(),
                adapter_id: adapter.id().to_string(),
                message: error.to_string(),
                asset_ref: Some("source.json".to_string()),
                source_unit_key: None,
                support_boundary: None,
                expected: Some("successful verification".to_string()),
                actual: Some("adapter error".to_string()),
            },
        ),
    }
}

fn report_output_equivalence(
    adapter: &dyn EngineAdapter,
    report: &mut GoldenRoundTripReport,
    original_extraction: &ExtractionResult,
    output_dir: &Path,
    phase: &str,
) {
    let patched_extraction = match adapter.extract(ExtractRequest {
        game_dir: output_dir,
    }) {
        Ok(extraction) => extraction,
        Err(error) => {
            record_golden_failure(
                report,
                GoldenFailure {
                    code: "output_equivalence_extract_error".to_string(),
                    phase: phase.to_string(),
                    adapter_id: adapter.id().to_string(),
                    message: error.to_string(),
                    asset_ref: Some("source.json".to_string()),
                    source_unit_key: None,
                    support_boundary: Some(
                        "output equivalence requires patched output to remain extractable"
                            .to_string(),
                    ),
                    expected: Some("extractable patched output".to_string()),
                    actual: Some("adapter extract error".to_string()),
                },
            );
            return;
        }
    };

    let expected = unit_signatures(&original_extraction.bridge);
    let actual = unit_signatures(&patched_extraction.bridge);
    if expected == actual {
        report_passed_phase(
            report,
            phase,
            "patched output extracts to the same source unit text and hashes",
            Some("source.json"),
        );
        return;
    }

    for (key, expected_signature) in &expected {
        match actual.get(key) {
            Some(actual_signature) if actual_signature == expected_signature => {}
            Some(actual_signature) => record_golden_failure(
                report,
                GoldenFailure {
                    code: "output_unit_mismatch".to_string(),
                    phase: phase.to_string(),
                    adapter_id: adapter.id().to_string(),
                    message: "patched output changed an extracted source unit".to_string(),
                    asset_ref: Some(format!("source.json#{key}")),
                    source_unit_key: Some(key.clone()),
                    support_boundary: Some(
                        "unchanged patch output equivalence requires source units to extract identically"
                            .to_string(),
                    ),
                    expected: Some(expected_signature.clone()),
                    actual: Some(actual_signature.clone()),
                },
            ),
            None => record_golden_failure(
                report,
                GoldenFailure {
                    code: "output_unit_missing".to_string(),
                    phase: phase.to_string(),
                    adapter_id: adapter.id().to_string(),
                    message: "patched output is missing an extracted source unit".to_string(),
                    asset_ref: Some(format!("source.json#{key}")),
                    source_unit_key: Some(key.clone()),
                    support_boundary: Some(
                        "unchanged patch output equivalence requires all source units to remain present"
                            .to_string(),
                    ),
                    expected: Some(expected_signature.clone()),
                    actual: None,
                },
            ),
        }
    }

    for key in actual.keys().filter(|key| !expected.contains_key(*key)) {
        record_golden_failure(
            report,
            GoldenFailure {
                code: "output_unit_unexpected".to_string(),
                phase: phase.to_string(),
                adapter_id: adapter.id().to_string(),
                message: "patched output contains an unexpected extracted source unit".to_string(),
                asset_ref: Some(format!("source.json#{key}")),
                source_unit_key: Some(key.clone()),
                support_boundary: Some(
                    "unchanged patch output equivalence requires no extra source units".to_string(),
                ),
                expected: None,
                actual: actual.get(key).cloned(),
            },
        );
    }
}

fn unit_signatures(bridge: &BridgeBundle) -> BTreeMap<String, String> {
    bridge
        .units
        .iter()
        .map(|unit| {
            (
                unit.source_unit_key.clone(),
                format!("{}:{}", unit.source_hash, unit.source_text),
            )
        })
        .collect()
}

fn report_translated_patch(
    adapter: &dyn EngineAdapter,
    report: &mut GoldenRoundTripReport,
    extraction: &ExtractionResult,
    game_dir: &Path,
    work_dir: &Path,
    patch_export_value: &Value,
    translated_source_bridge: Option<&Value>,
) -> KaifuuResult<()> {
    if patch_export_value["schemaVersion"].as_str() == Some(BRIDGE_SCHEMA_VERSION_V02) {
        match contracts::validate_patch_export_v02(patch_export_value) {
            Ok(()) => report_passed_phase(
                report,
                "translated_patch_contract",
                "translated v0.2 patch export passed contract validation",
                None,
            ),
            Err(error) => {
                record_golden_failure(
                    report,
                    GoldenFailure {
                        code: "translated_patch_contract_invalid".to_string(),
                        phase: "translated_patch_contract".to_string(),
                        adapter_id: adapter.id().to_string(),
                        message: error.to_string(),
                        asset_ref: None,
                        source_unit_key: None,
                        support_boundary: Some(
                            "translated public fixture patches must satisfy PatchExportV02"
                                .to_string(),
                        ),
                        expected: Some("valid PatchExportV02".to_string()),
                        actual: Some("invalid patch export".to_string()),
                    },
                );
                return Ok(());
            }
        }
        report_v02_source_compatibility(
            report,
            adapter.id(),
            patch_export_value,
            translated_source_bridge,
        );
    }

    if report
        .failures
        .iter()
        .any(|failure| failure.phase == "translated_source_compatibility")
    {
        return Ok(());
    }

    let patch_export = match patch_export_for_adapter(patch_export_value, &extraction.bridge) {
        Ok(patch_export) => patch_export,
        Err(error) => {
            record_golden_failure(
                report,
                GoldenFailure {
                    code: "translated_patch_conversion_failed".to_string(),
                    phase: "translated_patch_conversion".to_string(),
                    adapter_id: adapter.id().to_string(),
                    message: error.to_string(),
                    asset_ref: None,
                    source_unit_key: None,
                    support_boundary: Some(
                        "translated patch conversion requires every sourceUnitKey to exist in the current extraction"
                            .to_string(),
                    ),
                    expected: Some("convertible patch export".to_string()),
                    actual: Some("conversion error".to_string()),
                },
            );
            return Ok(());
        }
    };

    report_passed_phase(
        report,
        "translated_patch_conversion",
        "translated patch export converted to the adapter patch contract",
        None,
    );

    let output_dir = prepare_golden_work_dir(work_dir, "translated-patch")?;
    match adapter.patch(PatchRequest {
        game_dir,
        patch_export: &patch_export,
        output_dir: &output_dir,
    }) {
        Ok(patch_result) if patch_result.status == OperationStatus::Passed => {
            report_passed_phase(
                report,
                "translated_patch",
                "translated patch applied successfully",
                Some("source.json"),
            );
        }
        Ok(patch_result) => {
            record_adapter_failures(report, adapter.id(), "translated_patch", &patch_result);
            return Ok(());
        }
        Err(error) => {
            record_golden_failure(
                report,
                GoldenFailure {
                    code: "translated_patch_error".to_string(),
                    phase: "translated_patch".to_string(),
                    adapter_id: adapter.id().to_string(),
                    message: error.to_string(),
                    asset_ref: Some("source.json".to_string()),
                    source_unit_key: None,
                    support_boundary: None,
                    expected: Some("successful translated patch".to_string()),
                    actual: Some("adapter error".to_string()),
                },
            );
            return Ok(());
        }
    }

    report_translated_target_equivalence(report, adapter.id(), &patch_export, &output_dir);
    report_verify_phase(adapter, report, "translated_verify", &output_dir);
    Ok(())
}

fn report_v02_source_compatibility(
    report: &mut GoldenRoundTripReport,
    adapter_id: &str,
    patch_export: &Value,
    source_bridge: Option<&Value>,
) {
    let Some(source_bridge) = source_bridge else {
        report.phases.push(GoldenPhaseReport {
            phase: "translated_source_compatibility".to_string(),
            status: GoldenAssertionStatus::Skipped,
            details: "no v0.2 source bridge was provided for translated patch source-hash compatibility"
                .to_string(),
            asset_ref: None,
            source_unit_key: None,
            support_boundary: Some(
                "v0.2 source compatibility requires the source bridge artifact used to create the patch export"
                    .to_string(),
            ),
            expected: None,
            actual: None,
        });
        return;
    };

    let bridge_units = match v02_bridge_units_by_key(source_bridge) {
        Ok(units) => units,
        Err(error) => {
            record_golden_failure(
                report,
                GoldenFailure {
                    code: "translated_source_bridge_invalid".to_string(),
                    phase: "translated_source_compatibility".to_string(),
                    adapter_id: adapter_id.to_string(),
                    message: error.to_string(),
                    asset_ref: None,
                    source_unit_key: None,
                    support_boundary: Some(
                        "v0.2 source compatibility requires a bridge with units keyed by sourceUnitKey"
                            .to_string(),
                    ),
                    expected: Some("valid source bridge units".to_string()),
                    actual: Some("invalid source bridge".to_string()),
                },
            );
            return;
        }
    };

    let entries = match patch_export["entries"].as_array() {
        Some(entries) => entries,
        None => {
            record_golden_failure(
                report,
                GoldenFailure {
                    code: "translated_patch_entries_missing".to_string(),
                    phase: "translated_source_compatibility".to_string(),
                    adapter_id: adapter_id.to_string(),
                    message: "translated patch export is missing entries".to_string(),
                    asset_ref: None,
                    source_unit_key: None,
                    support_boundary: None,
                    expected: Some("entries array".to_string()),
                    actual: None,
                },
            );
            return;
        }
    };

    let mut compatible = 0_usize;
    for entry in entries {
        let source_unit_key = entry["sourceUnitKey"].as_str().unwrap_or("");
        let bridge_unit_id = entry["bridgeUnitId"].as_str().unwrap_or("");
        let source_hash = entry["sourceHash"].as_str().unwrap_or("");
        let Some(unit) = bridge_units.get(source_unit_key) else {
            record_golden_failure(
                report,
                GoldenFailure {
                    code: "translated_source_unit_missing".to_string(),
                    phase: "translated_source_compatibility".to_string(),
                    adapter_id: adapter_id.to_string(),
                    message:
                        "translated patch references a source unit absent from the source bridge"
                            .to_string(),
                    asset_ref: Some("source.json".to_string()),
                    source_unit_key: Some(source_unit_key.to_string()),
                    support_boundary: Some(
                        "translated patch sourceUnitKey values must exist in the source bridge"
                            .to_string(),
                    ),
                    expected: Some("source bridge unit".to_string()),
                    actual: None,
                },
            );
            continue;
        };

        if unit.bridge_unit_id != bridge_unit_id {
            record_golden_failure(
                report,
                GoldenFailure {
                    code: "translated_bridge_unit_mismatch".to_string(),
                    phase: "translated_source_compatibility".to_string(),
                    adapter_id: adapter_id.to_string(),
                    message: "translated patch bridgeUnitId does not match the source bridge"
                        .to_string(),
                    asset_ref: Some(unit.asset_ref.clone()),
                    source_unit_key: Some(source_unit_key.to_string()),
                    support_boundary: Some(
                        "translated patch entries must reference the source bridge unit they were exported from"
                            .to_string(),
                    ),
                    expected: Some(unit.bridge_unit_id.clone()),
                    actual: Some(bridge_unit_id.to_string()),
                },
            );
            continue;
        }

        if unit.source_hash != source_hash {
            record_golden_failure(
                report,
                GoldenFailure {
                    code: "translated_source_hash_mismatch".to_string(),
                    phase: "translated_source_compatibility".to_string(),
                    adapter_id: adapter_id.to_string(),
                    message: "translated patch sourceHash does not match the source bridge"
                        .to_string(),
                    asset_ref: Some(unit.asset_ref.clone()),
                    source_unit_key: Some(source_unit_key.to_string()),
                    support_boundary: Some(
                        "translated patch sourceHash must match the source bridge before adapter-specific hash translation"
                            .to_string(),
                    ),
                    expected: Some(unit.source_hash.clone()),
                    actual: Some(source_hash.to_string()),
                },
            );
            continue;
        }

        compatible += 1;
    }

    if report
        .failures
        .iter()
        .any(|failure| failure.phase == "translated_source_compatibility")
    {
        return;
    }

    report_passed_phase(
        report,
        "translated_source_compatibility",
        format!("validated {compatible} translated patch source unit(s) against the source bridge"),
        None,
    );
}

#[derive(Debug, Clone)]
struct V02BridgeUnitSummary {
    bridge_unit_id: String,
    source_hash: String,
    asset_ref: String,
}

fn v02_bridge_units_by_key(
    source_bridge: &Value,
) -> KaifuuResult<BTreeMap<String, V02BridgeUnitSummary>> {
    let units = source_bridge["units"]
        .as_array()
        .ok_or("source bridge missing units array")?;
    let mut units_by_key = BTreeMap::new();
    for unit in units {
        let key = require_str(unit, "sourceUnitKey")?;
        let asset_ref = unit["patchRef"]["assetId"]
            .as_str()
            .or_else(|| unit["sourceAssetRef"]["assetId"].as_str())
            .unwrap_or("source.json");
        units_by_key.insert(
            key.to_string(),
            V02BridgeUnitSummary {
                bridge_unit_id: require_str(unit, "bridgeUnitId")?.to_string(),
                source_hash: require_str(unit, "sourceHash")?.to_string(),
                asset_ref: format!("{asset_ref}#{key}"),
            },
        );
    }
    Ok(units_by_key)
}

fn patch_export_for_adapter(value: &Value, bridge: &BridgeBundle) -> KaifuuResult<PatchExport> {
    if value["schemaVersion"].as_str() != Some(BRIDGE_SCHEMA_VERSION_V02) {
        return PatchExport::from_value(value);
    }

    let units_by_key = bridge
        .units
        .iter()
        .map(|unit| (unit.source_unit_key.as_str(), unit))
        .collect::<BTreeMap<_, _>>();
    let entries = value["entries"]
        .as_array()
        .ok_or("translated patch export missing entries")?
        .iter()
        .map(|entry| {
            let source_unit_key = require_str(entry, "sourceUnitKey")?;
            let source_unit = units_by_key.get(source_unit_key).ok_or_else(|| {
                format!(
                    "translated patch entry {source_unit_key} is missing from current extraction"
                )
            })?;
            Ok(PatchExportEntry {
                bridge_unit_id: source_unit.bridge_unit_id.clone(),
                source_unit_key: source_unit_key.to_string(),
                source_hash: source_unit.source_hash.clone(),
                target_text: require_str(entry, "targetText")?.to_string(),
                protected_span_mappings: serde_json::from_value(
                    entry["protectedSpanMappings"].clone(),
                )?,
            })
        })
        .collect::<KaifuuResult<Vec<_>>>()?;

    Ok(PatchExport {
        patch_export_id: require_str(value, "patchExportId")?.to_string(),
        source_locale: require_str(value, "sourceLocale")?.to_string(),
        target_locale: require_str(value, "targetLocale")?.to_string(),
        entries,
    })
}

fn report_translated_target_equivalence(
    report: &mut GoldenRoundTripReport,
    adapter_id: &str,
    patch_export: &PatchExport,
    output_dir: &Path,
) {
    let output_path = output_dir.join("source.json");
    let source: Value = match read_json(&output_path) {
        Ok(source) => source,
        Err(error) => {
            record_golden_failure(
                report,
                GoldenFailure {
                    code: "translated_target_read_error".to_string(),
                    phase: "translated_target_equivalence".to_string(),
                    adapter_id: adapter_id.to_string(),
                    message: error.to_string(),
                    asset_ref: Some("source.json".to_string()),
                    source_unit_key: None,
                    support_boundary: Some(
                        "translated target equivalence requires fixture JSON output with targetText fields"
                            .to_string(),
                    ),
                    expected: Some("readable patched source.json".to_string()),
                    actual: Some("read error".to_string()),
                },
            );
            return;
        }
    };

    let units = match source["units"].as_array() {
        Some(units) => units,
        None => {
            record_golden_failure(
                report,
                GoldenFailure {
                    code: "translated_target_units_missing".to_string(),
                    phase: "translated_target_equivalence".to_string(),
                    adapter_id: adapter_id.to_string(),
                    message: "translated patch output is missing a units array".to_string(),
                    asset_ref: Some("source.json".to_string()),
                    source_unit_key: None,
                    support_boundary: Some(
                        "translated target equivalence requires fixture JSON output with units"
                            .to_string(),
                    ),
                    expected: Some("units array".to_string()),
                    actual: None,
                },
            );
            return;
        }
    };

    let targets_by_key = units
        .iter()
        .filter_map(|unit| {
            Some((
                unit["sourceUnitKey"].as_str()?.to_string(),
                unit["targetText"].as_str().map(str::to_string),
            ))
        })
        .collect::<BTreeMap<_, _>>();

    let mut matched = 0_usize;
    for entry in &patch_export.entries {
        match targets_by_key.get(&entry.source_unit_key) {
            Some(Some(actual)) if actual == &entry.target_text => {
                matched += 1;
            }
            Some(Some(actual)) => record_golden_failure(
                report,
                GoldenFailure {
                    code: "translated_target_text_mismatch".to_string(),
                    phase: "translated_target_equivalence".to_string(),
                    adapter_id: adapter_id.to_string(),
                    message: "translated patch output targetText does not match the patch export"
                        .to_string(),
                    asset_ref: Some(format!("source.json#{}", entry.source_unit_key)),
                    source_unit_key: Some(entry.source_unit_key.clone()),
                    support_boundary: Some(
                        "translated patch target equivalence requires each targetText to be written exactly"
                            .to_string(),
                    ),
                    expected: Some(entry.target_text.clone()),
                    actual: Some(actual.clone()),
                },
            ),
            Some(None) => record_golden_failure(
                report,
                GoldenFailure {
                    code: "translated_target_text_missing".to_string(),
                    phase: "translated_target_equivalence".to_string(),
                    adapter_id: adapter_id.to_string(),
                    message: "translated patch output unit is missing targetText".to_string(),
                    asset_ref: Some(format!("source.json#{}", entry.source_unit_key)),
                    source_unit_key: Some(entry.source_unit_key.clone()),
                    support_boundary: Some(
                        "translated patch target equivalence requires each patched unit to contain targetText"
                            .to_string(),
                    ),
                    expected: Some(entry.target_text.clone()),
                    actual: None,
                },
            ),
            None => record_golden_failure(
                report,
                GoldenFailure {
                    code: "translated_target_unit_missing".to_string(),
                    phase: "translated_target_equivalence".to_string(),
                    adapter_id: adapter_id.to_string(),
                    message: "translated patch output is missing a patched source unit".to_string(),
                    asset_ref: Some(format!("source.json#{}", entry.source_unit_key)),
                    source_unit_key: Some(entry.source_unit_key.clone()),
                    support_boundary: Some(
                        "translated patch target equivalence requires every patch entry sourceUnitKey to be present"
                            .to_string(),
                    ),
                    expected: Some(entry.target_text.clone()),
                    actual: None,
                },
            ),
        }
    }

    if report
        .failures
        .iter()
        .any(|failure| failure.phase == "translated_target_equivalence")
    {
        return;
    }

    report_passed_phase(
        report,
        "translated_target_equivalence",
        format!("verified {matched} translated targetText value(s) in source.json"),
        Some("source.json"),
    );
}

fn source_unit_key_from_asset_ref(asset_ref: Option<&str>) -> Option<String> {
    let (_, source_unit_key) = asset_ref?.split_once('#')?;
    (!source_unit_key.is_empty()).then(|| source_unit_key.to_string())
}

fn finalize_golden_report(mut report: GoldenRoundTripReport) -> GoldenRoundTripReport {
    report.status = if report.failures.is_empty() {
        OperationStatus::Passed
    } else {
        OperationStatus::Failed
    };
    report
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

    fn temp_dir(name: &str) -> PathBuf {
        let nonce = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir =
            std::env::temp_dir().join(format!("kaifuu-core-{name}-{}-{nonce}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn bridge_fixture_value(relative_path: &str) -> Value {
        let path = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../..")
            .join(relative_path);
        serde_json::from_str(&fs::read_to_string(path).expect("fixture should be readable"))
            .expect("fixture should be valid JSON")
    }

    fn bridge_v02_fixture_value() -> Value {
        bridge_fixture_value("packages/localization-bridge-schema/test/examples/bridge-v0.2.json")
    }

    fn contract_fixture_manifest_v02_value() -> Value {
        bridge_fixture_value(
            "packages/localization-bridge-schema/test/examples/contract-fixtures-v0.2.json",
        )
    }

    fn contract_example_fixture_value(manifest_path: &str) -> Value {
        let relative_path = manifest_path
            .strip_prefix("./")
            .expect("manifest paths should be relative to examples");
        bridge_fixture_value(&format!(
            "packages/localization-bridge-schema/test/examples/{relative_path}"
        ))
    }

    fn semantic_error_matches(error: &str, expected_pattern: &str) -> bool {
        let simplified = expected_pattern
            .replace("\\.", ".")
            .replace("\\[", "[")
            .replace("\\]", "]")
            .replace("\\(", "(")
            .replace("\\)", ")");
        simplified
            .split(".*")
            .filter(|part| !part.is_empty())
            .all(|part| error.contains(part))
    }

    fn expect_bridge_v02_error(fixture: Value, expected_error: &str) {
        let error = BridgeBundleV02::validate_json(&fixture)
            .expect_err("invalid bridge fixture should fail Rust validation")
            .to_string();
        assert!(
            error.contains(expected_error),
            "expected error containing {expected_error:?}, got: {error}"
        );
    }

    #[test]
    fn safe_join_relative_rejects_absolute_and_traversal_paths() {
        let root = Path::new("patched-game");
        let safe = safe_join_relative(root, "data/source.json").unwrap();
        assert_eq!(safe, root.join("data").join("source.json"));

        for unsafe_path in [
            "",
            "/source.json",
            "\\source.json",
            "C:/source.json",
            "C:\\source.json",
            "C:source.json",
            "c:source.json",
            "data/C:source.json",
            "data\\C:source.json",
            "../source.json",
            "data/../source.json",
            "data\\..\\source.json",
            "data//source.json",
            "./source.json",
            "data/./source.json",
            "source.json\0suffix",
        ] {
            assert!(
                safe_join_relative(root, unsafe_path).is_err(),
                "{unsafe_path:?} should be rejected"
            );
        }
    }

    #[test]
    fn profile_validation_rejects_windows_drive_relative_asset_paths() {
        for unsafe_path in [
            "C:source.json",
            "c:source.json",
            "data/C:source.json",
            "data\\C:source.json",
        ] {
            let profile = serde_json::json!({
                "schemaVersion": PROFILE_SCHEMA_VERSION,
                "profileId": deterministic_id("profile", 1),
                "gameId": "hello-fixture",
                "title": "Hello Fixture",
                "sourceLocale": "ja-JP",
                "engine": {
                    "adapterId": "kaifuu.fixture",
                    "engineFamily": "fixture",
                    "engineVersion": null,
                    "detectedVariant": "plain-json"
                },
                "assets": [
                    {
                        "assetId": deterministic_id("asset", 1),
                        "path": unsafe_path,
                        "assetKind": "script",
                        "textSurfaces": ["dialogue"],
                        "patching": {
                            "capability": "patching",
                            "status": "supported",
                            "limitation": null
                        }
                    }
                ],
                "capabilities": [
                    {
                        "capability": "patching",
                        "status": "supported",
                        "limitation": null
                    }
                ],
                "requirements": []
            });

            let validation = validate_profile_value(&profile);

            assert_eq!(validation.status, OperationStatus::Failed);
            assert!(
                validation.failures.iter().any(|failure| {
                    failure.code == "invalid_asset_path" && failure.field == "assets.0.path"
                }),
                "{unsafe_path:?} should be rejected, got {:?}",
                validation.failures
            );
        }
    }

    #[test]
    fn asset_inventory_rejects_engine_specific_source_location_fields() {
        let manifest = AssetInventoryManifest {
            schema_version: ASSET_INVENTORY_SCHEMA_VERSION.to_string(),
            manifest_id: deterministic_id("asset-inventory", 1),
            adapter_id: "kaifuu.fixture".to_string(),
            source_locale: "ja-JP".to_string(),
            assets: vec![AssetInventoryAsset {
                asset_id: "asset-image-sign".to_string(),
                asset_key: "image/sign".to_string(),
                asset_kind: AssetInventoryAssetKind::Image,
                path: Some("images/sign.png".to_string()),
                source_hash: Some(content_hash("image/sign")),
                metadata: BTreeMap::new(),
            }],
            surfaces: vec![AssetInventorySurface {
                surface_id: "surface-image-sign-text".to_string(),
                asset_surface_kind: AssetInventorySurfaceKind::ImageText,
                source_asset_ref: AssetInventoryAssetRef {
                    asset_id: "asset-image-sign".to_string(),
                    asset_key: Some("image/sign".to_string()),
                },
                source_location: Some(serde_json::json!({
                    "containerKey": "image/sign",
                    "rpgMakerEventId": 12
                })),
                source_text: Some("注意".to_string()),
                source_hash: Some(content_hash("注意")),
                text_source_kind: AssetInventoryTextSourceKind::ManualTranscription,
                patch_mode: AssetInventoryPatchMode::RegionRedrawRequired,
                patching: CapabilityReport::unsupported(
                    Capability::AssetTextPatching,
                    "test adapter does not patch image assets",
                ),
                notes: vec![],
            }],
            capabilities: vec![CapabilityReport::supported(Capability::AssetInventory)],
            warnings: vec![],
            metadata: BTreeMap::new(),
        };

        let validation = manifest.validate();

        assert_eq!(validation.status, OperationStatus::Failed);
        assert!(validation.failures.iter().any(|failure| {
            failure.code == "engine_specific_source_location"
                && failure.field == "surfaces.0.sourceLocation.rpgMakerEventId"
        }));
    }

    #[test]
    fn atomic_write_text_cleans_temp_file_when_rename_fails() {
        let dir = temp_dir("atomic-rename-failure");
        let target = dir.join("source.json");
        fs::create_dir_all(&target).unwrap();

        let error = atomic_write_text(&target, "patched\n")
            .unwrap_err()
            .to_string();

        assert!(
            error.contains("Is a directory")
                || error.contains("Access is denied")
                || error.contains("cannot be moved")
                || error.contains("directory")
        );
        assert!(target.is_dir());
        let temp_entries = fs::read_dir(&dir)
            .unwrap()
            .filter_map(Result::ok)
            .filter(|entry| {
                entry
                    .file_name()
                    .to_string_lossy()
                    .starts_with(".source.json.tmp-")
            })
            .count();
        assert_eq!(temp_entries, 0);
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn rust_bridge_contract_accepts_shared_v02_bridge_fixture() {
        let fixture = bridge_v02_fixture_value();

        let bundle = BridgeBundleV02::validate_json(&fixture)
            .expect("shared v0.2 bridge fixture should validate in Rust");

        assert_eq!(bundle.schema_version, BRIDGE_SCHEMA_VERSION_V02);
        assert_eq!(bundle.bridge_id, "019ed001-0000-7000-8000-000000000001");
        assert_eq!(bundle.units.len(), 12);
    }

    #[test]
    fn shared_contract_fixture_suite_accepts_all_manifest_valid_fixtures() {
        let manifest = contract_fixture_manifest_v02_value();
        contracts::validate_shared_contract_fixture_v02("contract-fixtures-v0.2", &manifest)
            .expect("contract fixture manifest should validate in Rust");

        let valid_fixtures = manifest["validFixtures"]
            .as_array()
            .expect("manifest validFixtures should be an array");
        for fixture in valid_fixtures {
            let kind = fixture["kind"]
                .as_str()
                .expect("fixture kind should be a string");
            let path = fixture["path"]
                .as_str()
                .expect("fixture path should be a string");
            let value = contract_example_fixture_value(path);

            contracts::validate_shared_contract_fixture_v02(kind, &value).unwrap_or_else(|error| {
                panic!("{kind} fixture {path} failed Rust validation: {error}")
            });
        }
    }

    #[test]
    fn shared_contract_fixture_suite_rejects_all_manifest_invalid_fixtures() {
        let manifest = contract_fixture_manifest_v02_value();
        let invalid_fixtures = manifest["invalidFixtures"]
            .as_array()
            .expect("manifest invalidFixtures should be an array");

        for fixture in invalid_fixtures {
            let kind = fixture["kind"]
                .as_str()
                .expect("fixture kind should be a string");
            let path = fixture["path"]
                .as_str()
                .expect("fixture path should be a string");
            let expected = fixture["expectedSemanticError"]
                .as_str()
                .expect("expected error should be a string");
            let value = contract_example_fixture_value(path);

            let error = contracts::validate_shared_contract_fixture_v02(kind, &value)
                .expect_err("invalid contract fixture should fail Rust validation")
                .to_string();
            assert!(
                semantic_error_matches(&error, expected),
                "{kind} fixture {path} produced unexpected error. expected {expected:?}, got {error:?}"
            );
        }
    }

    #[test]
    fn rust_bridge_contract_rejects_invalid_shared_bridge_fixtures_semantically() {
        for (relative_path, expected_error) in [
            (
                "packages/localization-bridge-schema/test/examples/invalid/bridge-v0.2-dangling-asset-ref.json",
                "sourceAssetRef.assetId must reference an asset",
            ),
            (
                "packages/localization-bridge-schema/test/examples/invalid/bridge-v0.2-malformed-hash.json",
                "sourceBundleHash must be a canonical sha256 hash string",
            ),
            (
                "packages/localization-bridge-schema/test/examples/invalid/bridge-v0.2-schema-version-0.1.json",
                "schemaVersion must be 0.2.0; 0.1.0 is the legacy fixture contract",
            ),
        ] {
            let fixture = bridge_fixture_value(relative_path);
            let error = BridgeBundleV02::validate_json(&fixture)
                .expect_err("invalid bridge fixture should fail Rust validation")
                .to_string();
            assert!(
                error.contains(expected_error),
                "{relative_path} produced unexpected error: {error}"
            );
        }
    }

    #[test]
    fn rust_source_revision_v02_matches_ts_revision_kind_enum() {
        for (revision_kind, value) in [
            (
                "content_hash",
                "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            ),
            ("source_control", "main@abc123"),
            ("build", "build-2026-06-17"),
            ("manual_snapshot", "snapshot-1"),
        ] {
            SourceRevisionV02 {
                revision_id: "019ed001-0000-7000-8000-000000000001".to_string(),
                revision_kind: revision_kind.to_string(),
                value: value.to_string(),
                created_at: None,
            }
            .validate("SourceRevisionV02")
            .expect("TS-supported revisionKind should validate in Rust");
        }

        for revision_kind in ["manual", "release"] {
            let error = SourceRevisionV02 {
                revision_id: "019ed001-0000-7000-8000-000000000001".to_string(),
                revision_kind: revision_kind.to_string(),
                value: "snapshot-1".to_string(),
                created_at: None,
            }
            .validate("SourceRevisionV02")
            .expect_err("TS-unsupported revisionKind should fail in Rust")
            .to_string();
            assert!(error.contains("revisionKind"), "{error}");
        }
    }

    #[test]
    fn rust_bridge_contract_rejects_audited_v02_semantic_divergences() {
        let mut fixture = bridge_v02_fixture_value();
        fixture["units"][0]["sourceLocation"] = serde_json::json!(["script/prologue"]);
        expect_bridge_v02_error(fixture, "sourceLocation must be an object");

        let mut fixture = bridge_v02_fixture_value();
        fixture["units"][0]["sourceLocation"]["range"]["endByte"] = serde_json::json!(0);
        expect_bridge_v02_error(fixture, "sourceLocation.range.endByte must be greater than");

        let mut fixture = bridge_v02_fixture_value();
        fixture["units"][3]["context"]
            .as_object_mut()
            .unwrap()
            .remove("choice");
        expect_bridge_v02_error(fixture, "context.choice is required for choice_label");

        let mut fixture = bridge_v02_fixture_value();
        fixture["units"][6]["context"]["database"]["databaseKind"] = serde_json::json!("global");
        expect_bridge_v02_error(fixture, "context.database.databaseKind");

        let mut fixture = bridge_v02_fixture_value();
        fixture["units"][6]["policy"] = serde_json::json!({
            "policyAction": "localize"
        });
        expect_bridge_v02_error(
            fixture,
            "policy must include targetLocale or localeBranchId",
        );

        let mut fixture = bridge_v02_fixture_value();
        fixture["units"][0]["spans"][0]["policy"] = serde_json::json!({
            "policyAction": "manual"
        });
        expect_bridge_v02_error(fixture, "spans[0].policy.policyAction");

        let mut fixture = bridge_v02_fixture_value();
        fixture["units"][0]["spans"][0]["parsedName"] = serde_json::json!("");
        expect_bridge_v02_error(fixture, "spans[0].parsedName must be a non-empty string");

        let mut fixture = bridge_v02_fixture_value();
        fixture["units"][0]["spans"][0]["arguments"] = serde_json::json!({
            "name": "player"
        });
        expect_bridge_v02_error(fixture, "spans[0].arguments must be an array");

        let mut fixture = bridge_v02_fixture_value();
        fixture["units"][0]["spans"][0]["exampleValues"] = serde_json::json!([""]);
        expect_bridge_v02_error(
            fixture,
            "spans[0].exampleValues[0] must be a non-empty string",
        );

        let mut fixture = bridge_v02_fixture_value();
        fixture["units"][0]["spans"][0]["spanKind"] = serde_json::json!("ruby_annotation");
        expect_bridge_v02_error(
            fixture,
            "spans[0].base.startByte must be a non-negative integer",
        );

        let mut fixture = bridge_v02_fixture_value();
        fixture["units"][0]["spans"][0] = serde_json::json!({
            "spanId": "019ed001-0000-7000-8000-000000000801",
            "spanKind": "ruby_annotation",
            "raw": "{player}",
            "startByte": 7,
            "endByte": 15,
            "preserveMode": "locale_policy",
            "baseStartByte": 7,
            "baseEndByte": 7,
            "annotationStartByte": 7,
            "annotationEndByte": 15,
            "annotationText": "player"
        });
        expect_bridge_v02_error(fixture, "spans[0].base.endByte must be greater than");

        let mut fixture = bridge_v02_fixture_value();
        fixture["units"][0]["spans"][0] = serde_json::json!({
            "spanId": "019ed001-0000-7000-8000-000000000801",
            "spanKind": "ruby_annotation",
            "raw": "{player}",
            "startByte": 7,
            "endByte": 15,
            "preserveMode": "locale_policy",
            "baseStartByte": 7,
            "baseEndByte": 15,
            "annotationStartByte": 7,
            "annotationEndByte": 15,
            "annotationText": ""
        });
        expect_bridge_v02_error(
            fixture,
            "spans[0].annotationText must be a non-empty string",
        );

        let mut fixture = bridge_v02_fixture_value();
        fixture["units"][7]["context"]["song"]["audioAssetRef"]["assetId"] =
            serde_json::json!("019ed001-0000-7000-8000-00000000ffff");
        expect_bridge_v02_error(fixture, "context.song.audioAssetRef.assetId");

        let mut fixture = bridge_v02_fixture_value();
        fixture["units"][0]["patchRef"]["assetId"] =
            serde_json::json!("019ed001-0000-7000-8000-00000000ffff");
        expect_bridge_v02_error(fixture, "patchRef.assetId");

        let mut fixture = bridge_v02_fixture_value();
        fixture["units"][0]["runtimeExpectation"]["traceKey"] = serde_json::json!("");
        expect_bridge_v02_error(fixture, "runtimeExpectation.traceKey");

        let mut fixture = bridge_v02_fixture_value();
        fixture["units"][8]["runtimeExpectation"]["region"]["width"] = serde_json::json!(0);
        expect_bridge_v02_error(fixture, "runtimeExpectation.region.width");
    }

    #[test]
    fn rust_bridge_contract_documents_non_bridge_fixture_scope() {
        let fixture = bridge_fixture_value(
            "packages/localization-bridge-schema/test/examples/triage-v0.2.json",
        );

        let error = BridgeBundleV02::validate_json(&fixture)
            .expect_err("triage fixture is not a bridge bundle")
            .to_string();

        assert!(error.contains("missing field `bridgeId`"), "{error}");
    }

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
    fn protected_span_normalizer_uses_engine_neutral_byte_spans() {
        let source_text = "こんにちは、{player}。";
        let spans = normalize_protected_spans(
            source_text,
            vec![ProtectedSpan::new(
                "placeholder",
                "{player}",
                18,
                26,
                "exact",
            )],
        )
        .unwrap();

        assert_eq!(spans.len(), 1);
        assert_eq!(spans[0].kind, "variable_placeholder");
        assert_eq!(spans[0].preserve_mode, "map");
        assert_eq!(spans[0].variable_name.as_deref(), Some("player"));
        assert_eq!(
            &source_text[spans[0].start as usize..spans[0].end as usize],
            spans[0].raw
        );
    }

    #[test]
    fn protected_span_normalizer_rejects_overlapping_spans() {
        let error = normalize_protected_spans(
            "abc {name}",
            vec![
                ProtectedSpan::control_markup("{name}", 4, 10, "unknown_placeholder", vec![]),
                ProtectedSpan::variable_placeholder("{name}", 4, 10, "name"),
                ProtectedSpan::control_markup("name", 5, 9, "bad_nested_span", vec![]),
            ],
        )
        .expect_err("overlapping spans should fail")
        .to_string();

        assert!(error.contains("must not overlap"), "{error}");
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

            fn asset_inventory(
                &self,
                _request: AssetInventoryRequest<'_>,
            ) -> KaifuuResult<AssetInventoryManifest> {
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
