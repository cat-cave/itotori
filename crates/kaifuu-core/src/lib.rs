use std::collections::{BTreeMap, HashSet};
use std::fmt;
use std::fs;
use std::path::Path;

use serde::{Deserialize, Serialize};
use serde_json::Value;

pub type KaifuuResult<T> = Result<T, Box<dyn std::error::Error>>;

pub const BRIDGE_SCHEMA_VERSION_V02: &str = "0.2.0";

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

    pub fn detect(&self, game_dir: &Path) -> KaifuuResult<Option<DetectionResult>> {
        let mut best = None;
        for adapter in &self.adapters {
            let result = adapter.detect(DetectRequest { game_dir })?;
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

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DetectionResult {
    pub adapter_id: String,
    pub detected: bool,
    pub confidence: f32,
    pub engine_family: Option<String>,
    pub engine_version: Option<String>,
    pub detected_variant: Option<String>,
    pub indicators: Vec<DetectionIndicator>,
    pub capabilities: Vec<CapabilityReport>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DetectionIndicator {
    pub path: String,
    pub kind: String,
    pub evidence: String,
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
    }

    pub fn stable_json(&self) -> KaifuuResult<String> {
        let mut normalized = self.clone();
        normalized.normalize();
        Ok(format!("{}\n", serde_json::to_string_pretty(&normalized)?))
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

    if let Some(required_context) = required_context_for_surface_kind(surface_kind) {
        if !context.contains_key(required_context) {
            return Err(BridgeContractValidationError::new(format!(
                "{label}.{required_context} is required for {surface_kind}"
            )));
        }
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
    fn rust_bridge_contract_accepts_shared_v02_bridge_fixture() {
        let fixture = bridge_v02_fixture_value();

        let bundle = BridgeBundleV02::validate_json(&fixture)
            .expect("shared v0.2 bridge fixture should validate in Rust");

        assert_eq!(bundle.schema_version, BRIDGE_SCHEMA_VERSION_V02);
        assert_eq!(bundle.bridge_id, "019ed001-0000-7000-8000-000000000001");
        assert_eq!(bundle.units.len(), 12);
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
                    confidence: 1.0,
                    engine_family: Some(self.0.to_string()),
                    engine_version: None,
                    detected_variant: Some("test".to_string()),
                    indicators: vec![],
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
