use std::collections::BTreeMap;
use std::fs;
use std::path::Path;

use serde::{Deserialize, Serialize};
use serde_json::Value;

pub type KaifuuResult<T> = Result<T, Box<dyn std::error::Error>>;

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
