use std::collections::{BTreeMap, BTreeSet, HashSet};
use std::fmt;
use std::fs::{self, File, OpenOptions};
use std::io::{self, ErrorKind, Read, Write};
use std::path::{Path, PathBuf};

#[cfg(any(target_os = "linux", target_os = "macos"))]
use std::ffi::CString;

use serde::{Deserialize, Serialize};
use serde_json::Value;

pub type KaifuuResult<T> = Result<T, Box<dyn std::error::Error>>;
pub const PROFILE_SCHEMA_VERSION: &str = "0.1.0";
pub const ASSET_INVENTORY_SCHEMA_VERSION: &str = "0.1.0";
pub const ARCHIVE_DETECTION_SCHEMA_VERSION: &str = "0.1.0";
pub const REDACTED_DETECTION_GAME_DIR: &str = "[redacted-local-game-dir]";

pub const BRIDGE_SCHEMA_VERSION_V02: &str = "0.2.0";

pub const SEMANTIC_MISSING_KEY_PROFILE: &str = "kaifuu.missing_capability.key_profile";
pub const SEMANTIC_MISSING_KEY_MATERIAL: &str = "kaifuu.missing_key_material";
pub const SEMANTIC_HELPER_UNAVAILABLE: &str = "kaifuu.helper_unavailable";
pub const SEMANTIC_KEY_VALIDATION_FAILED: &str = "kaifuu.key_validation_failed";
pub const SEMANTIC_SECRET_REDACTED: &str = "kaifuu.secret_redacted";
pub const SEMANTIC_PROTECTED_EXECUTABLE_UNSUPPORTED: &str =
    "kaifuu.protected_executable_unsupported";
pub const SEMANTIC_UNSUPPORTED_LAYERED_TRANSFORM: &str = "kaifuu.unsupported_layered_transform";
pub const SEMANTIC_MISSING_CONTAINER_CAPABILITY: &str = "kaifuu.missing_capability.container";
pub const SEMANTIC_MISSING_CRYPTO_CAPABILITY: &str = "kaifuu.missing_capability.crypto";
pub const SEMANTIC_MISSING_CODEC_CAPABILITY: &str = "kaifuu.missing_capability.codec";
pub const SEMANTIC_MISSING_PATCH_BACK_CAPABILITY: &str = "kaifuu.missing_capability.patch_back";
pub const SEMANTIC_UNSUPPORTED_VARIANT_ENCRYPTED: &str = "kaifuu.unsupported_variant.encrypted";
pub const SEMANTIC_UNSUPPORTED_VARIANT_PACKED: &str = "kaifuu.unsupported_variant.packed";
pub const SEMANTIC_UNKNOWN_ENGINE_VARIANT: &str = "kaifuu.unknown_engine_variant";

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
    fn patch_preflight(&self, request: PatchPreflightRequest<'_>) -> KaifuuResult<PatchResult> {
        Ok(PatchResult::preflight_pass(request.patch_export))
    }
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
pub struct PatchPreflightRequest<'a> {
    pub game_dir: &'a Path,
    pub patch_export: &'a PatchExport,
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
    ContainerAccess,
    CryptoAccess,
    CodecAccess,
    PatchBack,
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

    pub fn redacted_for_report(&self) -> Self {
        Self {
            capability: self.capability.clone(),
            status: self.status.clone(),
            limitation: self.limitation.as_deref().map(redact_for_log_or_report),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AdapterCapabilities {
    pub adapter_id: String,
    pub reports: Vec<CapabilityReport>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub key_requirements: Vec<AdapterKeyRequirementDeclaration>,
}

impl AdapterCapabilities {
    pub fn new(adapter_id: impl Into<String>, reports: Vec<CapabilityReport>) -> Self {
        let mut capabilities = Self {
            adapter_id: adapter_id.into(),
            reports,
            key_requirements: vec![],
        };
        capabilities.normalize();
        capabilities
    }

    pub fn with_key_requirements(
        mut self,
        key_requirements: Vec<AdapterKeyRequirementDeclaration>,
    ) -> Self {
        self.key_requirements = key_requirements;
        self.normalize();
        self
    }

    pub fn normalize(&mut self) {
        self.reports.sort_by_key(|report| {
            (
                serde_json::to_string(&report.capability).unwrap_or_default(),
                serde_json::to_string(&report.status).unwrap_or_default(),
                report.limitation.clone(),
            )
        });
        self.key_requirements
            .sort_by_key(AdapterKeyRequirementDeclaration::sort_key);
    }

    pub fn redacted_for_report(&self) -> Self {
        let mut capabilities = self.clone();
        capabilities.adapter_id = redact_for_log_or_report(&capabilities.adapter_id);
        capabilities.reports = capabilities
            .reports
            .iter()
            .map(CapabilityReport::redacted_for_report)
            .collect();
        capabilities.key_requirements = capabilities
            .key_requirements
            .iter()
            .map(AdapterKeyRequirementDeclaration::redacted_for_report)
            .collect();
        capabilities.normalize();
        capabilities
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

impl DetectionEvidence {
    fn redacted_for_report(&self) -> Self {
        Self {
            path: redact_asset_ref_for_report(&self.path),
            kind: redact_for_log_or_report(&self.kind),
            status: self.status.clone(),
            detail: redact_for_log_or_report(&self.detail),
        }
    }
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

    pub fn redacted_for_report(&self) -> Self {
        let mut result = self.clone();
        result.adapter_id = redact_for_log_or_report(&result.adapter_id);
        result.engine_family = result
            .engine_family
            .as_deref()
            .map(redact_for_log_or_report);
        result.engine_version = result
            .engine_version
            .as_deref()
            .map(redact_for_log_or_report);
        result.detected_variant = result
            .detected_variant
            .as_deref()
            .map(redact_for_log_or_report);
        result.evidence = result
            .evidence
            .iter()
            .map(DetectionEvidence::redacted_for_report)
            .collect();
        result.requirements = result
            .requirements
            .iter()
            .map(ProfileRequirement::redacted_for_report)
            .collect();
        result.capabilities = result
            .capabilities
            .iter()
            .map(CapabilityReport::redacted_for_report)
            .collect();
        result.normalize();
        result
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
    #[serde(default)]
    pub archive_detection: ArchiveDetectionReport,
    pub warnings: Vec<String>,
}

impl DetectionReport {
    pub fn from_results(game_dir: &Path, detections: Vec<DetectionResult>) -> Self {
        let detections = detections
            .into_iter()
            .map(|detection| detection.redacted_for_report())
            .collect::<Vec<_>>();
        let archive_detection = ArchiveDetectionReport::scan(game_dir);
        let adapter_matched = detections.iter().any(|detection| detection.detected);
        let archive_matched = archive_detection.status == ArchiveDetectionStatus::Matched;
        let status = if adapter_matched {
            DetectionReportStatus::Matched
        } else {
            DetectionReportStatus::Unknown
        };
        let warnings = if !adapter_matched && archive_matched {
            vec![
                "no registered extraction adapter matched this directory; archive detection reported unsupported input diagnostics".to_string(),
            ]
        } else if status == DetectionReportStatus::Unknown {
            vec!["no registered adapter matched this directory".to_string()]
        } else {
            vec![]
        };
        Self {
            schema_version: "0.1.0".to_string(),
            game_dir: REDACTED_DETECTION_GAME_DIR.to_string(),
            status,
            detections,
            archive_detection,
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
pub struct ArchiveDetectionReport {
    pub schema_version: String,
    pub status: ArchiveDetectionStatus,
    pub evidence_policy: String,
    pub rows: Vec<ArchiveDetectionRow>,
}

impl Default for ArchiveDetectionReport {
    fn default() -> Self {
        Self::empty()
    }
}

impl ArchiveDetectionReport {
    pub fn empty() -> Self {
        Self {
            schema_version: ARCHIVE_DETECTION_SCHEMA_VERSION.to_string(),
            status: ArchiveDetectionStatus::Unknown,
            evidence_policy: ARCHIVE_DETECTION_EVIDENCE_POLICY.to_string(),
            rows: vec![],
        }
    }

    pub fn scan(game_dir: &Path) -> Self {
        let scan = ArchiveDetectionScan::collect(game_dir);
        let mut rows = vec![
            detect_kirikiri_xp3(&scan),
            detect_siglus(&scan),
            detect_rpg_maker_mv_mz(&scan),
            detect_wolf_rpg_editor(&scan),
            detect_bgi_ethornell(&scan),
            detect_renpy(&scan),
            detect_unknown_archive_variant(&scan),
        ];
        for row in &mut rows {
            row.normalize();
        }
        let status = if rows.iter().any(|row| row.detected) {
            ArchiveDetectionStatus::Matched
        } else {
            ArchiveDetectionStatus::Unknown
        };
        Self {
            schema_version: ARCHIVE_DETECTION_SCHEMA_VERSION.to_string(),
            status,
            evidence_policy: ARCHIVE_DETECTION_EVIDENCE_POLICY.to_string(),
            rows,
        }
    }
}

const ARCHIVE_DETECTION_EVIDENCE_POLICY: &str = "aggregate-only; no raw keys, helper dumps, decrypted text, local paths, or private source filenames are serialized";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ArchiveDetectionStatus {
    Matched,
    Unknown,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ArchiveDetectionRow {
    pub row_id: String,
    pub engine_family: ArchiveEngineFamily,
    pub detected: bool,
    pub detected_variant: String,
    pub signals: Vec<ArchiveDetectionSignal>,
    pub evidence: Vec<ArchiveDetectionEvidence>,
    pub requirements: Vec<ProfileRequirement>,
    pub diagnostics: Vec<DetectionDiagnostic>,
    pub capabilities: Vec<CapabilityReport>,
    pub support_boundary: String,
}

impl ArchiveDetectionRow {
    pub fn normalize(&mut self) {
        self.signals
            .sort_by_key(|signal| serde_json::to_string(signal).unwrap_or_default());
        self.signals.dedup();
        self.evidence.sort_by_key(|evidence| {
            (
                serde_json::to_string(&evidence.evidence_type).unwrap_or_default(),
                evidence.pattern.clone(),
                serde_json::to_string(&evidence.status).unwrap_or_default(),
            )
        });
        self.requirements.sort_by_key(ProfileRequirement::sort_key);
        self.diagnostics.sort_by_key(|diagnostic| {
            (
                diagnostic.code.to_string(),
                serde_json::to_string(&diagnostic.signal).unwrap_or_default(),
                diagnostic.support_boundary.clone(),
            )
        });
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
pub enum ArchiveEngineFamily {
    KiriKiriXp3,
    Siglus,
    RpgMakerMvMz,
    WolfRpgEditor,
    BgiEthornell,
    #[serde(rename = "renpy")]
    Renpy,
    Unknown,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ArchiveDetectionSignal {
    Encrypted,
    Packed,
    Protected,
    MissingKey,
    HelperRequired,
    UnknownVariant,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ArchiveDetectionEvidence {
    pub evidence_type: ArchiveEvidenceType,
    pub pattern: String,
    pub status: EvidenceStatus,
    pub count: u64,
    pub detail: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ArchiveEvidenceType {
    FileExtension,
    FileName,
    FileMagic,
    MetadataField,
    AggregateCount,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DetectionDiagnostic {
    pub code: SemanticErrorCode,
    pub signal: ArchiveDetectionSignal,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub required_capability: Option<Capability>,
    pub support_boundary: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub remediation: Option<String>,
}

#[derive(Debug, Default)]
struct ArchiveDetectionScan {
    extensions: BTreeMap<String, u64>,
    file_names: BTreeMap<String, u64>,
    headers: Vec<Vec<u8>>,
    orphaned_subtype_marker_count: u64,
    rpg_maker_system_json_encryption_fields: u64,
}

impl ArchiveDetectionScan {
    fn collect(game_dir: &Path) -> Self {
        let mut scan = Self::default();
        scan.visit_dir(game_dir, game_dir);
        scan
    }

    fn visit_dir(&mut self, root: &Path, dir: &Path) {
        let Ok(entries) = fs::read_dir(dir) else {
            return;
        };
        for entry in entries.filter_map(Result::ok) {
            let path = entry.path();
            let Ok(file_type) = entry.file_type() else {
                continue;
            };
            if file_type.is_dir() {
                self.visit_dir(root, &path);
            } else if file_type.is_file() {
                self.record_file(root, &path);
            }
        }
    }

    fn record_file(&mut self, root: &Path, path: &Path) {
        let extension = lower_path_component(path.extension());
        let file_name = lower_path_component(path.file_name());
        if let Some(extension) = extension.as_deref() {
            *self.extensions.entry(extension.to_string()).or_default() += 1;
        }
        if let Some(file_name) = file_name.as_deref() {
            *self.file_names.entry(file_name.to_string()).or_default() += 1;
        }
        let header = read_header(path, 64);
        if has_orphaned_archive_subtype_marker(extension.as_deref(), &header) {
            self.orphaned_subtype_marker_count += 1;
        }
        self.headers.push(header);
        if is_rpg_maker_system_json(root, path) && system_json_has_encryption_fields(path) {
            self.rpg_maker_system_json_encryption_fields += 1;
        }
    }

    fn extension_count(&self, extension: &str) -> u64 {
        self.extensions.get(extension).copied().unwrap_or_default()
    }

    fn extension_counts(&self, extensions: &[&str]) -> u64 {
        extensions
            .iter()
            .map(|extension| self.extension_count(extension))
            .sum()
    }

    fn file_name_count(&self, file_name: &str) -> u64 {
        self.file_names
            .get(&file_name.to_ascii_lowercase())
            .copied()
            .unwrap_or_default()
    }

    fn header_count(&self, needle: &str) -> u64 {
        self.headers
            .iter()
            .filter(|header| header_contains_ascii(header, needle))
            .count() as u64
    }

    fn wolf_rpg_editor_header_count(&self) -> u64 {
        self.headers
            .iter()
            .filter(|header| has_wolf_rpg_editor_primary_evidence(None, header))
            .count() as u64
    }

    fn xp3_header_count(&self) -> u64 {
        self.headers
            .iter()
            .filter(|header| header.starts_with(b"XP3"))
            .count() as u64
    }
}

fn lower_path_component(component: Option<&std::ffi::OsStr>) -> Option<String> {
    component.map(|component| component.to_string_lossy().to_ascii_lowercase())
}

fn read_header(path: &Path, limit: usize) -> Vec<u8> {
    let Ok(mut file) = File::open(path) else {
        return vec![];
    };
    let mut buffer = vec![0; limit];
    let Ok(read) = file.read(&mut buffer) else {
        return vec![];
    };
    buffer.truncate(read);
    buffer
}

fn header_contains_ascii(header: &[u8], needle: &str) -> bool {
    String::from_utf8_lossy(header)
        .to_ascii_lowercase()
        .contains(&needle.to_ascii_lowercase())
}

fn has_wolf_rpg_editor_primary_evidence(extension: Option<&str>, header: &[u8]) -> bool {
    extension == Some("wolf") || header_contains_ascii(header, "WOLF RPG Editor")
}

fn has_orphaned_archive_subtype_marker(extension: Option<&str>, header: &[u8]) -> bool {
    let xp3_marker = header_contains_ascii(header, "kaifuu-xp3-encrypted")
        || header_contains_ascii(header, "xp3-encrypted")
        || header_contains_ascii(header, "xp3-crypt");
    let xp3_primary = extension == Some("xp3") || header.starts_with(b"XP3");

    let bgi_marker = header_contains_ascii(header, "bgi-encrypted")
        || header_contains_ascii(header, "ethornell-encrypted");
    let bgi_primary = header_contains_ascii(header, "BURIKO ARC20");

    let wolf_marker = header_contains_ascii(header, "wolf-protected")
        || header_contains_ascii(header, "protection-key");
    let wolf_primary = has_wolf_rpg_editor_primary_evidence(extension, header);

    (xp3_marker && !xp3_primary) || (bgi_marker && !bgi_primary) || (wolf_marker && !wolf_primary)
}

fn is_rpg_maker_system_json(root: &Path, path: &Path) -> bool {
    let Ok(relative_path) = path.strip_prefix(root) else {
        return false;
    };
    let parts = relative_path
        .components()
        .filter_map(|component| {
            component
                .as_os_str()
                .to_str()
                .map(|part| part.to_ascii_lowercase())
        })
        .collect::<Vec<_>>();
    parts.ends_with(&["data".to_string(), "system.json".to_string()])
        || parts.ends_with(&[
            "www".to_string(),
            "data".to_string(),
            "system.json".to_string(),
        ])
}

fn system_json_has_encryption_fields(path: &Path) -> bool {
    let Ok(text) = fs::read_to_string(path) else {
        return false;
    };
    let Ok(value) = serde_json::from_str::<Value>(&text) else {
        return false;
    };
    value
        .get("hasEncryptedImages")
        .and_then(Value::as_bool)
        .unwrap_or(false)
        || value
            .get("hasEncryptedAudio")
            .and_then(Value::as_bool)
            .unwrap_or(false)
        || value
            .get("encryptionKey")
            .and_then(Value::as_str)
            .is_some_and(|key| !key.trim().is_empty())
}

fn detect_kirikiri_xp3(scan: &ArchiveDetectionScan) -> ArchiveDetectionRow {
    let xp3_extension_count = scan.extension_count("xp3");
    let xp3_header_count = scan.xp3_header_count();
    let encrypted_marker_count = scan.header_count("kaifuu-xp3-encrypted")
        + scan.header_count("xp3-encrypted")
        + scan.header_count("xp3-crypt");
    let detected = xp3_extension_count > 0 || xp3_header_count > 0;
    let mut signals = if detected {
        vec![ArchiveDetectionSignal::Packed]
    } else {
        vec![]
    };
    if encrypted_marker_count > 0 {
        signals.extend([
            ArchiveDetectionSignal::Encrypted,
            ArchiveDetectionSignal::MissingKey,
            ArchiveDetectionSignal::HelperRequired,
        ]);
    }
    archive_row(ArchiveRowInput {
        row_id: "kirikiri-xp3",
        engine_family: ArchiveEngineFamily::KiriKiriXp3,
        detected,
        detected_variant: if encrypted_marker_count > 0 {
            "xp3-encrypted-archive"
        } else {
            "xp3-archive"
        },
        signals,
        evidence: vec![
            evidence(
                ArchiveEvidenceType::FileExtension,
                "*.xp3",
                xp3_extension_count,
                "XP3 archive extension count",
            ),
            evidence(
                ArchiveEvidenceType::FileMagic,
                "XP3 header",
                xp3_header_count,
                "XP3 archive header count",
            ),
            evidence(
                ArchiveEvidenceType::FileMagic,
                "synthetic XP3 encryption marker",
                encrypted_marker_count,
                "Synthetic encrypted XP3 fixture marker count",
            ),
        ],
        requirements: if encrypted_marker_count > 0 {
            vec![secret_requirement(
                "kirikiri-xp3-key-profile",
                "encrypted XP3 variants require local key/profile evidence before pure adapters can proceed",
                "KAIFUU_KIRIKIRI_XP3_KEY_PROFILE",
            )]
        } else {
            vec![]
        },
        support_boundary: "Kaifuu detects XP3 archives and encrypted XP3 markers but does not claim XP3 extraction, decryption, or archive rebuild support in this matrix.",
    })
}

fn detect_siglus(scan: &ArchiveDetectionScan) -> ArchiveDetectionRow {
    let scene_pck_count = scan.file_name_count("scene.pck");
    let gameexe_dat_count = scan.file_name_count("gameexe.dat");
    let detected = scene_pck_count > 0 || gameexe_dat_count > 0;
    archive_row(ArchiveRowInput {
        row_id: "siglus-scene-pck",
        engine_family: ArchiveEngineFamily::Siglus,
        detected,
        detected_variant: if scene_pck_count > 0 && gameexe_dat_count > 0 {
            "scene-pck-gameexe-dat"
        } else if scene_pck_count > 0 {
            "scene-pck-without-gameexe-dat"
        } else {
            "gameexe-dat-without-scene-pck"
        },
        signals: if detected {
            vec![
                ArchiveDetectionSignal::Packed,
                ArchiveDetectionSignal::Encrypted,
                ArchiveDetectionSignal::MissingKey,
                ArchiveDetectionSignal::HelperRequired,
            ]
        } else {
            Vec::new()
        },
        evidence: vec![
            evidence(
                ArchiveEvidenceType::FileName,
                "Scene.pck",
                scene_pck_count,
                "Siglus scenario package marker count",
            ),
            evidence(
                ArchiveEvidenceType::FileName,
                "Gameexe.dat",
                gameexe_dat_count,
                "Siglus executable metadata marker count",
            ),
        ],
        requirements: if detected {
            vec![
                file_requirement(
                    "Scene.pck",
                    scene_pck_count > 0,
                    "Siglus detection expects aggregate evidence for Scene.pck",
                ),
                file_requirement(
                    "Gameexe.dat",
                    gameexe_dat_count > 0,
                    "Siglus secondary-key workflows usually require Gameexe.dat evidence",
                ),
                secret_requirement(
                    "siglus-secondary-key",
                    "Siglus encrypted packages require a local secondary key reference",
                    "KAIFUU_SIGLUS_SECONDARY_KEY",
                ),
            ]
        } else {
            vec![]
        },
        support_boundary: "Kaifuu detects Siglus package/key-requirement signals only; extraction, secondary-key discovery, and protected executable handling remain helper-gated.",
    })
}

fn detect_rpg_maker_mv_mz(scan: &ArchiveDetectionScan) -> ArchiveDetectionRow {
    let encrypted_asset_count = scan.extension_counts(RPG_MAKER_MV_MZ_ENCRYPTED_SUFFIXES);
    let system_json_count = scan.rpg_maker_system_json_encryption_fields;
    let detected = encrypted_asset_count > 0 || system_json_count > 0;
    archive_row(ArchiveRowInput {
        row_id: "rpg-maker-mv-mz-encrypted-assets",
        engine_family: ArchiveEngineFamily::RpgMakerMvMz,
        detected,
        detected_variant: "mv-mz-encrypted-asset-signals",
        signals: if detected {
            vec![
                ArchiveDetectionSignal::Encrypted,
                ArchiveDetectionSignal::MissingKey,
            ]
        } else {
            Vec::new()
        },
        evidence: vec![
            evidence(
                ArchiveEvidenceType::FileExtension,
                RPG_MAKER_MV_MZ_ENCRYPTED_SUFFIX_PATTERN,
                encrypted_asset_count,
                "RPG Maker MV/MZ encrypted asset extension count",
            ),
            evidence(
                ArchiveEvidenceType::MetadataField,
                "data/System.json encryption fields",
                system_json_count,
                "System.json encryption flags or key-field presence count; key values are never serialized",
            ),
        ],
        requirements: if detected {
            vec![secret_requirement(
                "rpg-maker-mv-mz-asset-key",
                "encrypted RPG Maker MV/MZ assets require a local asset key reference",
                "KAIFUU_RPG_MAKER_ASSET_KEY",
            )]
        } else {
            vec![]
        },
        support_boundary: "Kaifuu detects RPG Maker MV/MZ encrypted asset signals; JSON text patching and encrypted media restoration are separate adapter claims.",
    })
}

const RPG_MAKER_MV_MZ_ENCRYPTED_SUFFIXES: &[&str] =
    &["rpgmvp", "rpgmvm", "rpgmvo", "png_", "m4a_", "ogg_"];
const RPG_MAKER_MV_MZ_ENCRYPTED_SUFFIX_PATTERN: &str =
    "*.rpgmvp|*.rpgmvm|*.rpgmvo|*.png_|*.m4a_|*.ogg_";

fn detect_wolf_rpg_editor(scan: &ArchiveDetectionScan) -> ArchiveDetectionRow {
    let wolf_archive_count = scan.extension_count("wolf");
    let wolf_magic_count = scan.wolf_rpg_editor_header_count();
    let protected_marker_count =
        scan.header_count("wolf-protected") + scan.header_count("protection-key");
    let detected = wolf_archive_count > 0 || wolf_magic_count > 0;
    let mut signals = if detected {
        vec![
            ArchiveDetectionSignal::Packed,
            ArchiveDetectionSignal::Encrypted,
            ArchiveDetectionSignal::MissingKey,
            ArchiveDetectionSignal::HelperRequired,
        ]
    } else {
        vec![]
    };
    if protected_marker_count > 0 {
        signals.push(ArchiveDetectionSignal::Protected);
    }
    archive_row(ArchiveRowInput {
        row_id: "wolf-rpg-editor-archives",
        engine_family: ArchiveEngineFamily::WolfRpgEditor,
        detected,
        detected_variant: if protected_marker_count > 0 {
            "wolf-protected-archive"
        } else {
            "wolf-archive"
        },
        signals,
        evidence: vec![
            evidence(
                ArchiveEvidenceType::FileExtension,
                "*.wolf",
                wolf_archive_count,
                "Wolf RPG Editor archive extension count",
            ),
            evidence(
                ArchiveEvidenceType::FileMagic,
                "WOLF header",
                wolf_magic_count,
                "Wolf archive/header marker count",
            ),
            evidence(
                ArchiveEvidenceType::FileMagic,
                "Wolf protection marker",
                protected_marker_count,
                "Synthetic Wolf protection-key marker count",
            ),
        ],
        requirements: if detected {
            vec![secret_requirement(
                "wolf-rpg-editor-archive-key",
                "Wolf RPG Editor protected archives require local key/helper evidence",
                "KAIFUU_WOLF_ARCHIVE_KEY",
            )]
        } else {
            vec![]
        },
        support_boundary: "Kaifuu detects Wolf RPG Editor archive and protection signals; archive decryption, binary database parsing, and rebuilds remain unsupported here.",
    })
}

fn detect_bgi_ethornell(scan: &ArchiveDetectionScan) -> ArchiveDetectionRow {
    let arc_extension_count = scan.extension_count("arc");
    let buriko_header_count = scan.header_count("BURIKO ARC20");
    let encrypted_marker_count =
        scan.header_count("bgi-encrypted") + scan.header_count("ethornell-encrypted");
    let detected = buriko_header_count > 0;
    let mut signals = if detected {
        vec![
            ArchiveDetectionSignal::Packed,
            ArchiveDetectionSignal::UnknownVariant,
        ]
    } else {
        vec![]
    };
    if encrypted_marker_count > 0 {
        signals.extend([
            ArchiveDetectionSignal::Encrypted,
            ArchiveDetectionSignal::MissingKey,
        ]);
    }
    archive_row(ArchiveRowInput {
        row_id: "bgi-ethornell-containers",
        engine_family: ArchiveEngineFamily::BgiEthornell,
        detected,
        detected_variant: if encrypted_marker_count > 0 {
            "buriko-arc20-encrypted-container"
        } else {
            "buriko-arc20-container"
        },
        signals,
        evidence: vec![
            evidence(
                ArchiveEvidenceType::FileExtension,
                "*.arc",
                arc_extension_count,
                "Generic .arc extension count; BGI classification requires BURIKO header evidence",
            ),
            evidence(
                ArchiveEvidenceType::FileMagic,
                "BURIKO ARC20 header",
                buriko_header_count,
                "BGI/Ethornell archive header count",
            ),
            evidence(
                ArchiveEvidenceType::FileMagic,
                "BGI encrypted container marker",
                encrypted_marker_count,
                "Synthetic BGI/Ethornell encrypted-container marker count",
            ),
        ],
        requirements: if encrypted_marker_count > 0 {
            vec![secret_requirement(
                "bgi-ethornell-container-key",
                "encrypted BGI/Ethornell containers require local key/profile evidence",
                "KAIFUU_BGI_CONTAINER_KEY",
            )]
        } else {
            vec![]
        },
        support_boundary: "Kaifuu detects BGI/Ethornell container headers; script decoding, encrypted container handling, and repacking are not claimed by this matrix.",
    })
}

fn detect_renpy(scan: &ArchiveDetectionScan) -> ArchiveDetectionRow {
    let rpa_count = scan.extension_count("rpa");
    let rpyc_count = scan.extension_count("rpyc");
    let detected = rpa_count > 0 || rpyc_count > 0;
    archive_row(ArchiveRowInput {
        row_id: "renpy-packed-inputs",
        engine_family: ArchiveEngineFamily::Renpy,
        detected,
        detected_variant: if rpa_count > 0 && rpyc_count > 0 {
            "rpa-archive-and-rpyc-compiled-script"
        } else if rpa_count > 0 {
            "rpa-archive"
        } else {
            "rpyc-compiled-script"
        },
        signals: if detected {
            vec![ArchiveDetectionSignal::Packed]
        } else {
            Vec::new()
        },
        evidence: vec![
            evidence(
                ArchiveEvidenceType::FileExtension,
                "*.rpa",
                rpa_count,
                "Ren'Py archive extension count",
            ),
            evidence(
                ArchiveEvidenceType::FileExtension,
                "*.rpyc",
                rpyc_count,
                "Ren'Py compiled script extension count",
            ),
        ],
        requirements: vec![],
        support_boundary: "Kaifuu detects Ren'Py packed or compiled inputs; plaintext .rpy handling, archive unpacking, and decompilation are separate support claims.",
    })
}

fn detect_unknown_archive_variant(scan: &ArchiveDetectionScan) -> ArchiveDetectionRow {
    let unknown_count = scan
        .extension_counts(&["pak", "bundle", "bin"])
        .saturating_add(
            scan.extension_count("dat")
                .saturating_sub(scan.file_name_count("gameexe.dat")),
        )
        .saturating_add(
            scan.extension_count("pck")
                .saturating_sub(scan.file_name_count("scene.pck")),
        )
        .saturating_add(
            scan.extension_count("arc")
                .saturating_sub(scan.header_count("BURIKO ARC20")),
        )
        .saturating_add(scan.orphaned_subtype_marker_count);
    let detected = unknown_count > 0;
    archive_row(ArchiveRowInput {
        row_id: "unknown-archive-variant",
        engine_family: ArchiveEngineFamily::Unknown,
        detected,
        detected_variant: "unprofiled-archive-like-input",
        signals: if detected {
            vec![ArchiveDetectionSignal::UnknownVariant]
        } else {
            Vec::new()
        },
        evidence: vec![
            evidence(
                ArchiveEvidenceType::AggregateCount,
                "*.pak|*.bundle|*.bin|unprofiled *.dat|*.pck|*.arc",
                unknown_count.saturating_sub(scan.orphaned_subtype_marker_count),
                "Archive-like files not covered by a profiled detector row",
            ),
            evidence(
                ArchiveEvidenceType::FileMagic,
                "orphaned encrypted/protected subtype marker",
                scan.orphaned_subtype_marker_count,
                "Subtype marker evidence without a matching profiled archive/container primary signal",
            ),
        ],
        requirements: vec![],
        support_boundary: "Kaifuu records unknown archive-like inputs as aggregate evidence only; no engine, extraction, or patching support is inferred.",
    })
}

struct ArchiveRowInput {
    row_id: &'static str,
    engine_family: ArchiveEngineFamily,
    detected: bool,
    detected_variant: &'static str,
    signals: Vec<ArchiveDetectionSignal>,
    evidence: Vec<ArchiveDetectionEvidence>,
    requirements: Vec<ProfileRequirement>,
    support_boundary: &'static str,
}

fn archive_row(input: ArchiveRowInput) -> ArchiveDetectionRow {
    let signals = if input.detected {
        input.signals
    } else {
        vec![]
    };
    let requirements = if input.detected {
        input.requirements
    } else {
        vec![]
    };
    let diagnostics = diagnostics_for_signals(&signals, input.support_boundary);
    let capabilities = capabilities_for_archive_row(input.detected, &signals);
    ArchiveDetectionRow {
        row_id: input.row_id.to_string(),
        engine_family: input.engine_family,
        detected: input.detected,
        detected_variant: input.detected_variant.to_string(),
        signals,
        evidence: input.evidence,
        requirements,
        diagnostics,
        capabilities,
        support_boundary: input.support_boundary.to_string(),
    }
}

fn evidence(
    evidence_type: ArchiveEvidenceType,
    pattern: impl Into<String>,
    count: u64,
    detail: impl Into<String>,
) -> ArchiveDetectionEvidence {
    ArchiveDetectionEvidence {
        evidence_type,
        pattern: pattern.into(),
        status: if count > 0 {
            EvidenceStatus::Matched
        } else {
            EvidenceStatus::Missing
        },
        count,
        detail: detail.into(),
    }
}

fn secret_requirement(
    key: impl Into<String>,
    description: impl Into<String>,
    placeholder: impl Into<String>,
) -> ProfileRequirement {
    ProfileRequirement {
        category: RequirementCategory::SecretKey,
        key: key.into(),
        status: RequirementStatus::Missing,
        description: description.into(),
        placeholder: Some(placeholder.into()),
        secret: true,
    }
}

fn file_requirement(
    key: impl Into<String>,
    satisfied: bool,
    description: impl Into<String>,
) -> ProfileRequirement {
    ProfileRequirement {
        category: RequirementCategory::File,
        key: key.into(),
        status: if satisfied {
            RequirementStatus::Satisfied
        } else {
            RequirementStatus::Missing
        },
        description: description.into(),
        placeholder: None,
        secret: false,
    }
}

fn capabilities_for_archive_row(
    detected: bool,
    signals: &[ArchiveDetectionSignal],
) -> Vec<CapabilityReport> {
    let mut capabilities = vec![CapabilityReport::supported(Capability::Detection)];
    if detected {
        capabilities.extend([
            CapabilityReport::unsupported(
                Capability::Extraction,
                "archive/encryption matrix detection is not an extraction support claim",
            ),
            CapabilityReport::unsupported(
                Capability::Patching,
                "archive/encryption matrix detection does not rebuild, decrypt, or patch containers",
            ),
        ]);
    }
    if signals.contains(&ArchiveDetectionSignal::Encrypted) {
        capabilities.push(CapabilityReport::unsupported(
            Capability::EncryptedInput,
            "encrypted input was detected, but decryption support is not claimed by the matrix",
        ));
    }
    if signals.contains(&ArchiveDetectionSignal::MissingKey)
        || signals.contains(&ArchiveDetectionSignal::HelperRequired)
    {
        capabilities.push(CapabilityReport::requires_user_input(
            Capability::KeyProfile,
            "recognized protected inputs require local secret refs or helper evidence before future pure adapter work can proceed",
        ));
    }
    capabilities
}

fn diagnostics_for_signals(
    signals: &[ArchiveDetectionSignal],
    support_boundary: &str,
) -> Vec<DetectionDiagnostic> {
    let mut diagnostics = Vec::new();
    for signal in signals {
        match signal {
            ArchiveDetectionSignal::Encrypted => diagnostics.push(diagnostic(
                SemanticErrorCode::UnsupportedVariantEncrypted,
                ArchiveDetectionSignal::Encrypted,
                Some(Capability::EncryptedInput),
                support_boundary,
                "provide a supported key profile only after an adapter explicitly supports this encrypted variant",
            )),
            ArchiveDetectionSignal::Packed => diagnostics.push(diagnostic(
                SemanticErrorCode::UnsupportedVariantPacked,
                ArchiveDetectionSignal::Packed,
                Some(Capability::Extraction),
                support_boundary,
                "use already extracted/plaintext sources or wait for an adapter that claims this container",
            )),
            ArchiveDetectionSignal::Protected => diagnostics.push(diagnostic(
                SemanticErrorCode::ProtectedExecutableUnsupported,
                ArchiveDetectionSignal::Protected,
                Some(Capability::KeyProfile),
                support_boundary,
                "use a local helper workflow that reports redacted protection evidence",
            )),
            ArchiveDetectionSignal::MissingKey => diagnostics.push(diagnostic(
                SemanticErrorCode::MissingKeyMaterial,
                ArchiveDetectionSignal::MissingKey,
                Some(Capability::KeyProfile),
                support_boundary,
                "resolve local key material through a secret ref; do not persist raw keys",
            )),
            ArchiveDetectionSignal::HelperRequired => diagnostics.push(diagnostic(
                SemanticErrorCode::HelperUnavailable,
                ArchiveDetectionSignal::HelperRequired,
                Some(Capability::KeyProfile),
                support_boundary,
                "run an explicitly enabled local helper or provide validated local key evidence",
            )),
            ArchiveDetectionSignal::UnknownVariant => diagnostics.push(diagnostic(
                SemanticErrorCode::UnknownEngineVariant,
                ArchiveDetectionSignal::UnknownVariant,
                Some(Capability::Detection),
                support_boundary,
                "add a synthetic public detector fixture or private-local aggregate evidence before claiming support",
            )),
        }
    }
    diagnostics
}

fn diagnostic(
    code: SemanticErrorCode,
    signal: ArchiveDetectionSignal,
    required_capability: Option<Capability>,
    support_boundary: impl Into<String>,
    remediation: impl Into<String>,
) -> DetectionDiagnostic {
    DetectionDiagnostic {
        code,
        signal,
        required_capability,
        support_boundary: support_boundary.into(),
        remediation: Some(remediation.into()),
    }
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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_fingerprint: Option<SourceFingerprint>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub key_requirements: Vec<KeyRequirement>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub archive_parameters: Vec<ArchiveParameter>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub helper_evidence: Option<HelperEvidence>,
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
        self.key_requirements.sort_by_key(KeyRequirement::sort_key);
        self.archive_parameters
            .sort_by_key(ArchiveParameter::sort_key);
        if let Some(helper_evidence) = &mut self.helper_evidence {
            helper_evidence.normalize();
        }
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
    add_redaction_failures(&mut failures, value);

    let profile_id = required_string_value(&mut failures, value, "profileId");
    validate_schema_version(&mut failures, value);
    required_string_value(&mut failures, value, "gameId");
    required_string_value(&mut failures, value, "title");
    validate_locale_field(&mut failures, value, "sourceLocale");
    validate_engine(&mut failures, value.get("engine"));
    validate_source_fingerprint(&mut failures, value.get("sourceFingerprint"));
    let key_requirements = validate_key_requirements(&mut failures, value.get("keyRequirements"));
    validate_archive_parameters(&mut failures, value.get("archiveParameters"));
    validate_helper_evidence(&mut failures, value.get("helperEvidence"));
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
    validate_required_key_requirement_matches(&mut failures, &requirements, &key_requirements);

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

fn add_redaction_failures(failures: &mut Vec<ProfileValidationFailure>, value: &Value) {
    for finding in validate_secret_redaction_boundary(value) {
        failures.push(ProfileValidationFailure {
            code: finding.code,
            field: finding.field,
            message: finding.reason,
        });
    }
}

fn validate_source_fingerprint(
    failures: &mut Vec<ProfileValidationFailure>,
    source_fingerprint: Option<&Value>,
) {
    let Some(source_fingerprint) = source_fingerprint else {
        return;
    };
    let Some(source_fingerprint) = source_fingerprint.as_object() else {
        failures.push(ProfileValidationFailure {
            code: "invalid_field_type".to_string(),
            field: "sourceFingerprint".to_string(),
            message: "sourceFingerprint must be a JSON object".to_string(),
        });
        return;
    };

    if let Some(game_root_hash) = source_fingerprint.get("gameRootHash")
        && !game_root_hash.is_null()
    {
        validate_sha256_ref_value(failures, game_root_hash, "sourceFingerprint.gameRootHash");
    }

    let Some(engine_evidence) = source_fingerprint.get("engineEvidence") else {
        failures.push(ProfileValidationFailure {
            code: "missing_required_field".to_string(),
            field: "sourceFingerprint.engineEvidence".to_string(),
            message: "sourceFingerprint.engineEvidence must list local-safe evidence names"
                .to_string(),
        });
        return;
    };
    let Some(engine_evidence) = engine_evidence.as_array() else {
        failures.push(ProfileValidationFailure {
            code: "invalid_field_type".to_string(),
            field: "sourceFingerprint.engineEvidence".to_string(),
            message: "sourceFingerprint.engineEvidence must be an array".to_string(),
        });
        return;
    };
    if engine_evidence.is_empty() {
        failures.push(ProfileValidationFailure {
            code: "missing_required_field".to_string(),
            field: "sourceFingerprint.engineEvidence".to_string(),
            message: "sourceFingerprint.engineEvidence must not be empty".to_string(),
        });
    }
    for (index, evidence) in engine_evidence.iter().enumerate() {
        let field = format!("sourceFingerprint.engineEvidence.{index}");
        let Some(evidence) = evidence.as_str() else {
            failures.push(ProfileValidationFailure {
                code: "invalid_field_type".to_string(),
                field,
                message: "engine evidence must be a string".to_string(),
            });
            continue;
        };
        if evidence.trim().is_empty() {
            failures.push(ProfileValidationFailure {
                code: "missing_required_field".to_string(),
                field,
                message: "engine evidence must not be empty".to_string(),
            });
            continue;
        }
        validate_profile_relative_path(failures, &field, evidence);
    }
}

fn validate_key_requirements(
    failures: &mut Vec<ProfileValidationFailure>,
    key_requirements: Option<&Value>,
) -> Vec<KeyRequirement> {
    let Some(key_requirements) = key_requirements else {
        return vec![];
    };
    let Some(key_requirements) = key_requirements.as_array() else {
        failures.push(ProfileValidationFailure {
            code: "invalid_field_type".to_string(),
            field: "keyRequirements".to_string(),
            message: "keyRequirements must be an array".to_string(),
        });
        return vec![];
    };

    let mut parsed = Vec::new();
    let mut seen = BTreeSet::new();
    for (index, requirement_value) in key_requirements.iter().enumerate() {
        let field = format!("keyRequirements.{index}");
        let Some(requirement_object) = requirement_value.as_object() else {
            failures.push(ProfileValidationFailure {
                code: "invalid_field_type".to_string(),
                field,
                message: "key requirement must be a JSON object".to_string(),
            });
            continue;
        };

        let requirement_id = required_string_value(
            failures,
            requirement_value,
            &format!("{field}.requirementId"),
        );
        let secret_ref =
            required_string_value(failures, requirement_value, &format!("{field}.secretRef"))
                .and_then(|secret_ref| validate_secret_ref(failures, &field, secret_ref));
        let kind = validate_enum_string(
            failures,
            requirement_value,
            &format!("{field}.kind"),
            &[
                "fixedBytes",
                "hexBytes",
                "utf8String",
                "archivePassword",
                "rpgMakerAssetKey",
            ],
        )
        .and_then(|kind| {
            serde_json::from_value::<KeyMaterialKind>(Value::String(kind.clone()))
                .map_err(|_| kind)
                .ok()
        });
        let bytes = validate_optional_positive_u32(
            failures,
            requirement_object.get("bytes"),
            &format!("{field}.bytes"),
        );
        let validation = requirement_object.get("validation").and_then(|validation| {
            validate_key_validation_proof(failures, validation, &format!("{field}.validation"))
        });

        if let Some(requirement_id) = requirement_id.as_deref() {
            if !seen.insert(requirement_id.to_string()) {
                failures.push(ProfileValidationFailure {
                    code: "duplicate_key_requirement".to_string(),
                    field: "keyRequirements".to_string(),
                    message: format!("key requirement {requirement_id} appears more than once"),
                });
            }
            validate_identifier(failures, &format!("{field}.requirementId"), requirement_id);
        }

        if matches!(
            kind,
            Some(KeyMaterialKind::FixedBytes | KeyMaterialKind::HexBytes)
        ) && bytes.is_none()
        {
            failures.push(ProfileValidationFailure {
                code: "missing_required_field".to_string(),
                field: format!("{field}.bytes"),
                message: "fixed and hex key requirements must declare byte length".to_string(),
            });
        }

        if let (Some(requirement_id), Some(secret_ref), Some(kind)) =
            (requirement_id, secret_ref, kind)
        {
            parsed.push(KeyRequirement {
                requirement_id,
                secret_ref,
                kind,
                bytes,
                validation,
            });
        }
    }
    parsed
}

fn validate_required_key_requirement_matches(
    failures: &mut Vec<ProfileValidationFailure>,
    requirements: &[ProfileRequirement],
    key_requirements: &[KeyRequirement],
) {
    let key_requirement_ids = key_requirements
        .iter()
        .map(|requirement| requirement.requirement_id.as_str())
        .collect::<BTreeSet<_>>();
    for requirement in requirements.iter().filter(|requirement| {
        requirement.category == RequirementCategory::SecretKey
            && requirement.status != RequirementStatus::NotRequired
    }) {
        if key_requirement_ids.contains(requirement.key.as_str()) {
            continue;
        }
        failures.push(ProfileValidationFailure {
            code: SemanticErrorCode::MissingKeyProfile.to_string(),
            field: "keyRequirements".to_string(),
            message: format!(
                "required secret key {} must have a matching keyRequirements.requirementId with a valid secretRef",
                requirement.key
            ),
        });
    }
}

fn validate_archive_parameters(
    failures: &mut Vec<ProfileValidationFailure>,
    archive_parameters: Option<&Value>,
) -> Vec<ArchiveParameter> {
    let Some(archive_parameters) = archive_parameters else {
        return vec![];
    };
    let Some(archive_parameters) = archive_parameters.as_array() else {
        failures.push(ProfileValidationFailure {
            code: "invalid_field_type".to_string(),
            field: "archiveParameters".to_string(),
            message: "archiveParameters must be an array".to_string(),
        });
        return vec![];
    };

    let mut parsed = Vec::new();
    let mut seen = BTreeSet::new();
    for (index, parameter) in archive_parameters.iter().enumerate() {
        let field = format!("archiveParameters.{index}");
        let Some(parameter_object) = parameter.as_object() else {
            failures.push(ProfileValidationFailure {
                code: "invalid_field_type".to_string(),
                field,
                message: "archive parameter must be a JSON object".to_string(),
            });
            continue;
        };
        let parameter_id =
            required_string_value(failures, parameter, &format!("{field}.parameterId"));
        let name = required_string_value(failures, parameter, &format!("{field}.name"));
        let kind = validate_enum_string(
            failures,
            parameter,
            &format!("{field}.kind"),
            &[
                "archiveFormat",
                "compression",
                "cipherScheme",
                "encoding",
                "variant",
                "other",
            ],
        )
        .and_then(|kind| {
            serde_json::from_value::<ArchiveParameterKind>(Value::String(kind.clone()))
                .map_err(|_| kind)
                .ok()
        });
        let value = required_string_value(failures, parameter, &format!("{field}.value"));
        let source = parameter_object
            .get("source")
            .and_then(|_| {
                validate_enum_string(
                    failures,
                    parameter,
                    &format!("{field}.source"),
                    &["adapterDefault", "detected", "manual", "helperEvidence"],
                )
            })
            .and_then(|source| {
                serde_json::from_value::<ArchiveParameterSource>(Value::String(source.clone()))
                    .map_err(|_| source)
                    .ok()
            });

        if let Some(parameter_id) = parameter_id.as_deref() {
            if !seen.insert(parameter_id.to_string()) {
                failures.push(ProfileValidationFailure {
                    code: "duplicate_archive_parameter".to_string(),
                    field: "archiveParameters".to_string(),
                    message: format!("archive parameter {parameter_id} appears more than once"),
                });
            }
            validate_identifier(failures, &format!("{field}.parameterId"), parameter_id);
        }

        if let (Some(parameter_id), Some(name), Some(kind), Some(value)) =
            (parameter_id, name, kind, value)
        {
            parsed.push(ArchiveParameter {
                parameter_id,
                name,
                kind,
                value,
                source,
            });
        }
    }
    parsed
}

fn validate_helper_evidence(
    failures: &mut Vec<ProfileValidationFailure>,
    helper_evidence: Option<&Value>,
) -> Option<HelperEvidence> {
    let helper_evidence = helper_evidence?;
    let Some(helper_object) = helper_evidence.as_object() else {
        failures.push(ProfileValidationFailure {
            code: "invalid_field_type".to_string(),
            field: "helperEvidence".to_string(),
            message: "helperEvidence must be a JSON object".to_string(),
        });
        return None;
    };
    let helper_kind = validate_enum_string(
        failures,
        helper_evidence,
        "helperEvidence.helperKind",
        &[
            "staticParser",
            "knownKeyDatabaseImport",
            "wineLocalWindowsHelper",
            "remoteWindowsHelper",
            "manualKeyEntry",
        ],
    )
    .and_then(|helper_kind| {
        serde_json::from_value::<HelperKind>(Value::String(helper_kind.clone()))
            .map_err(|_| helper_kind)
            .ok()
    });
    let tool_version =
        required_string_value(failures, helper_evidence, "helperEvidence.toolVersion");
    let redacted_log_hash =
        required_string_value(failures, helper_evidence, "helperEvidence.redactedLogHash")
            .and_then(|hash| {
                validate_sha256_ref_string(failures, "helperEvidence.redactedLogHash", hash)
            });
    let proof_hashes = validate_optional_proof_hashes(
        failures,
        helper_object.get("proofHashes"),
        "helperEvidence.proofHashes",
    );

    if let (Some(helper_kind), Some(tool_version), Some(redacted_log_hash)) =
        (helper_kind, tool_version, redacted_log_hash)
    {
        return Some(HelperEvidence {
            helper_kind,
            tool_version,
            redacted_log_hash,
            proof_hashes,
        });
    }
    None
}

fn validate_optional_proof_hashes(
    failures: &mut Vec<ProfileValidationFailure>,
    proof_hashes: Option<&Value>,
    field: &str,
) -> Vec<KeyValidationProof> {
    let Some(proof_hashes) = proof_hashes else {
        return vec![];
    };
    let Some(proof_hashes) = proof_hashes.as_array() else {
        failures.push(ProfileValidationFailure {
            code: "invalid_field_type".to_string(),
            field: field.to_string(),
            message: "proofHashes must be an array".to_string(),
        });
        return vec![];
    };
    proof_hashes
        .iter()
        .enumerate()
        .filter_map(|(index, proof)| {
            validate_key_validation_proof(failures, proof, &format!("{field}.{index}"))
        })
        .collect()
}

fn validate_key_validation_proof(
    failures: &mut Vec<ProfileValidationFailure>,
    validation: &Value,
    field: &str,
) -> Option<KeyValidationProof> {
    if !validation.is_object() {
        failures.push(ProfileValidationFailure {
            code: "invalid_field_type".to_string(),
            field: field.to_string(),
            message: "key validation proof must be a JSON object".to_string(),
        });
        return None;
    }
    let method = validate_enum_string(
        failures,
        validation,
        &format!("{field}.method"),
        &[
            "decryptHeaderProof",
            "archiveIndexProof",
            "knownPlaintextProof",
            "fixtureRoundTripProof",
        ],
    )
    .and_then(|method| {
        serde_json::from_value::<KeyValidationMethod>(Value::String(method.clone()))
            .map_err(|_| method)
            .ok()
    });
    let proof_hash = required_string_value(failures, validation, &format!("{field}.proofHash"))
        .and_then(|hash| validate_sha256_ref_string(failures, &format!("{field}.proofHash"), hash));
    if let (Some(method), Some(proof_hash)) = (method, proof_hash) {
        return Some(KeyValidationProof { method, proof_hash });
    }
    None
}

fn validate_secret_ref(
    failures: &mut Vec<ProfileValidationFailure>,
    parent_field: &str,
    secret_ref: String,
) -> Option<SecretRef> {
    match SecretRef::new(secret_ref) {
        Ok(secret_ref) => Some(secret_ref),
        Err(message) => {
            failures.push(ProfileValidationFailure {
                code: "invalid_secret_ref".to_string(),
                field: format!("{parent_field}.secretRef"),
                message,
            });
            None
        }
    }
}

fn validate_sha256_ref_value(
    failures: &mut Vec<ProfileValidationFailure>,
    value: &Value,
    field: &str,
) -> Option<ProofHash> {
    let Some(hash) = value.as_str() else {
        failures.push(ProfileValidationFailure {
            code: "invalid_proof_hash".to_string(),
            field: field.to_string(),
            message: format!("{field} must be a sha256:<64 lowercase hex> string"),
        });
        return None;
    };
    validate_sha256_ref_string(failures, field, hash.to_string())
}

fn validate_sha256_ref_string(
    failures: &mut Vec<ProfileValidationFailure>,
    field: &str,
    hash: String,
) -> Option<ProofHash> {
    match ProofHash::new(hash) {
        Ok(hash) => Some(hash),
        Err(message) => {
            failures.push(ProfileValidationFailure {
                code: "invalid_proof_hash".to_string(),
                field: field.to_string(),
                message,
            });
            None
        }
    }
}

fn validate_optional_positive_u32(
    failures: &mut Vec<ProfileValidationFailure>,
    value: Option<&Value>,
    field: &str,
) -> Option<u32> {
    let value = value?;
    let Some(value) = value.as_u64() else {
        failures.push(ProfileValidationFailure {
            code: "invalid_field_type".to_string(),
            field: field.to_string(),
            message: format!("{field} must be a positive integer"),
        });
        return None;
    };
    if value == 0 || value > u32::MAX as u64 {
        failures.push(ProfileValidationFailure {
            code: "invalid_field_value".to_string(),
            field: field.to_string(),
            message: format!("{field} must be a positive 32-bit integer"),
        });
        return None;
    }
    Some(value as u32)
}

fn validate_identifier(failures: &mut Vec<ProfileValidationFailure>, field: &str, value: &str) {
    if value.chars().any(char::is_whitespace) || value.contains('\0') {
        failures.push(ProfileValidationFailure {
            code: "invalid_identifier".to_string(),
            field: field.to_string(),
            message: format!("{field} must not contain whitespace or null bytes"),
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
            validate_profile_relative_path(failures, &format!("assets.{index}.path"), &path);
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
            "container_access",
            "crypto_access",
            "codec_access",
            "patch_back",
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
        if secret
            && category.as_deref() == Some("secret_key")
            && status.as_deref() == Some("missing")
        {
            failures.push(ProfileValidationFailure {
                code: SemanticErrorCode::MissingKeyMaterial.to_string(),
                field: key
                    .as_deref()
                    .map(|key| format!("requirements.{key}"))
                    .unwrap_or_else(|| format!("requirements.{index}")),
                message: description.clone().unwrap_or_else(|| {
                    "required local key material could not be resolved".to_string()
                }),
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

fn validate_profile_relative_path(
    failures: &mut Vec<ProfileValidationFailure>,
    field: &str,
    path: &str,
) {
    if validate_safe_relative_path(path).is_err() {
        failures.push(ProfileValidationFailure {
            code: "invalid_asset_path".to_string(),
            field: field.to_string(),
            message:
                "asset path must be relative and must not contain dot components, parent traversal, or drive prefixes"
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
pub struct SourceFingerprint {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub game_root_hash: Option<ProofHash>,
    pub engine_evidence: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KeyRequirement {
    pub requirement_id: String,
    pub secret_ref: SecretRef,
    pub kind: KeyMaterialKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bytes: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub validation: Option<KeyValidationProof>,
}

impl KeyRequirement {
    pub fn sort_key(&self) -> (String, String) {
        (
            self.requirement_id.clone(),
            self.secret_ref.as_str().to_string(),
        )
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum KeyMaterialKind {
    FixedBytes,
    HexBytes,
    Utf8String,
    ArchivePassword,
    RpgMakerAssetKey,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KeyValidationProof {
    pub method: KeyValidationMethod,
    pub proof_hash: ProofHash,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum KeyValidationMethod {
    DecryptHeaderProof,
    ArchiveIndexProof,
    KnownPlaintextProof,
    FixtureRoundTripProof,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ArchiveParameter {
    pub parameter_id: String,
    pub name: String,
    pub kind: ArchiveParameterKind,
    pub value: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source: Option<ArchiveParameterSource>,
}

impl ArchiveParameter {
    pub fn sort_key(&self) -> (String, String) {
        (self.parameter_id.clone(), self.name.clone())
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ArchiveParameterKind {
    ArchiveFormat,
    Compression,
    CipherScheme,
    Encoding,
    Variant,
    Other,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ArchiveParameterSource {
    AdapterDefault,
    Detected,
    Manual,
    HelperEvidence,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HelperEvidence {
    pub helper_kind: HelperKind,
    pub tool_version: String,
    pub redacted_log_hash: ProofHash,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub proof_hashes: Vec<KeyValidationProof>,
}

impl HelperEvidence {
    pub fn normalize(&mut self) {
        self.proof_hashes.sort_by_key(|proof| {
            (
                serde_json::to_string(&proof.method).unwrap_or_default(),
                proof.proof_hash.as_str().to_string(),
            )
        });
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum HelperKind {
    StaticParser,
    KnownKeyDatabaseImport,
    WineLocalWindowsHelper,
    RemoteWindowsHelper,
    ManualKeyEntry,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AdapterKeyRequirementDeclaration {
    pub requirement_id: String,
    pub engine_family: String,
    pub material_kind: KeyMaterialKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bytes: Option<u32>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub archive_parameters: Vec<ArchiveParameterDeclaration>,
    pub validation: AdapterKeyValidationDeclaration,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub semantic_errors: Vec<SemanticErrorCode>,
}

impl AdapterKeyRequirementDeclaration {
    pub fn sort_key(&self) -> (String, String, String) {
        (
            self.engine_family.clone(),
            self.requirement_id.clone(),
            serde_json::to_string(&self.material_kind).unwrap_or_default(),
        )
    }

    pub fn redacted_for_report(&self) -> Self {
        Self {
            requirement_id: redact_for_log_or_report(&self.requirement_id),
            engine_family: redact_for_log_or_report(&self.engine_family),
            material_kind: self.material_kind,
            bytes: self.bytes,
            archive_parameters: self
                .archive_parameters
                .iter()
                .map(ArchiveParameterDeclaration::redacted_for_report)
                .collect(),
            validation: self.validation.clone(),
            semantic_errors: self.semantic_errors.clone(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ArchiveParameterDeclaration {
    pub parameter_id: String,
    pub name: String,
    pub kind: ArchiveParameterKind,
    pub required: bool,
}

impl ArchiveParameterDeclaration {
    pub fn redacted_for_report(&self) -> Self {
        Self {
            parameter_id: redact_for_log_or_report(&self.parameter_id),
            name: redact_for_log_or_report(&self.name),
            kind: self.kind,
            required: self.required,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AdapterKeyValidationDeclaration {
    pub method: KeyValidationMethod,
    pub proof_required: bool,
}

#[derive(Clone, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct SecretRef(String);

impl SecretRef {
    pub fn new(value: impl Into<String>) -> Result<Self, String> {
        let value = value.into();
        if is_valid_secret_ref(&value) {
            Ok(Self(value))
        } else {
            Err("secretRef must use a local secret-ref scheme and must not contain raw key material, local paths, whitespace, parent traversal, or null bytes".to_string())
        }
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl fmt::Debug for SecretRef {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_tuple("SecretRef")
            .field(&"<secret-ref>")
            .finish()
    }
}

impl Serialize for SecretRef {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        serializer.serialize_str(&self.0)
    }
}

impl<'de> Deserialize<'de> for SecretRef {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        let value = String::deserialize(deserializer)?;
        Self::new(value).map_err(serde::de::Error::custom)
    }
}

#[derive(Clone, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct ProofHash(String);

impl ProofHash {
    pub fn new(value: impl Into<String>) -> Result<Self, String> {
        let value = value.into();
        if is_sha256_ref(&value) {
            Ok(Self(value))
        } else {
            Err("proof hash must be sha256:<64 lowercase hex characters>".to_string())
        }
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl fmt::Debug for ProofHash {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.debug_tuple("ProofHash").field(&self.0).finish()
    }
}

impl Serialize for ProofHash {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        serializer.serialize_str(&self.0)
    }
}

impl<'de> Deserialize<'de> for ProofHash {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        let value = String::deserialize(deserializer)?;
        Self::new(value).map_err(serde::de::Error::custom)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
pub enum SemanticErrorCode {
    #[serde(rename = "kaifuu.missing_capability.key_profile")]
    MissingKeyProfile,
    #[serde(rename = "kaifuu.missing_key_material")]
    MissingKeyMaterial,
    #[serde(rename = "kaifuu.helper_unavailable")]
    HelperUnavailable,
    #[serde(rename = "kaifuu.key_validation_failed")]
    KeyValidationFailed,
    #[serde(rename = "kaifuu.secret_redacted")]
    SecretRedacted,
    #[serde(rename = "kaifuu.protected_executable_unsupported")]
    ProtectedExecutableUnsupported,
    #[serde(rename = "kaifuu.unsupported_layered_transform")]
    UnsupportedLayeredTransform,
    #[serde(rename = "kaifuu.missing_capability.container")]
    MissingContainerCapability,
    #[serde(rename = "kaifuu.missing_capability.crypto")]
    MissingCryptoCapability,
    #[serde(rename = "kaifuu.missing_capability.codec")]
    MissingCodecCapability,
    #[serde(rename = "kaifuu.missing_capability.patch_back")]
    MissingPatchBackCapability,
    #[serde(rename = "kaifuu.unsupported_variant.encrypted")]
    UnsupportedVariantEncrypted,
    #[serde(rename = "kaifuu.unsupported_variant.packed")]
    UnsupportedVariantPacked,
    #[serde(rename = "kaifuu.unknown_engine_variant")]
    UnknownEngineVariant,
}

impl SemanticErrorCode {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::MissingKeyProfile => SEMANTIC_MISSING_KEY_PROFILE,
            Self::MissingKeyMaterial => SEMANTIC_MISSING_KEY_MATERIAL,
            Self::HelperUnavailable => SEMANTIC_HELPER_UNAVAILABLE,
            Self::KeyValidationFailed => SEMANTIC_KEY_VALIDATION_FAILED,
            Self::SecretRedacted => SEMANTIC_SECRET_REDACTED,
            Self::ProtectedExecutableUnsupported => SEMANTIC_PROTECTED_EXECUTABLE_UNSUPPORTED,
            Self::UnsupportedLayeredTransform => SEMANTIC_UNSUPPORTED_LAYERED_TRANSFORM,
            Self::MissingContainerCapability => SEMANTIC_MISSING_CONTAINER_CAPABILITY,
            Self::MissingCryptoCapability => SEMANTIC_MISSING_CRYPTO_CAPABILITY,
            Self::MissingCodecCapability => SEMANTIC_MISSING_CODEC_CAPABILITY,
            Self::MissingPatchBackCapability => SEMANTIC_MISSING_PATCH_BACK_CAPABILITY,
            Self::UnsupportedVariantEncrypted => SEMANTIC_UNSUPPORTED_VARIANT_ENCRYPTED,
            Self::UnsupportedVariantPacked => SEMANTIC_UNSUPPORTED_VARIANT_PACKED,
            Self::UnknownEngineVariant => SEMANTIC_UNKNOWN_ENGINE_VARIANT,
        }
    }
}

impl fmt::Display for SemanticErrorCode {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.as_str())
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SecretRedactionResult {
    pub value: Value,
    pub findings: Vec<SecretRedactionFinding>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SecretRedactionFinding {
    pub code: String,
    pub field: String,
    pub reason: String,
}

pub fn validate_secret_redaction_boundary(value: &Value) -> Vec<SecretRedactionFinding> {
    redact_secret_bearing_value(value).findings
}

pub fn redact_secret_bearing_value(value: &Value) -> SecretRedactionResult {
    let mut findings = Vec::new();
    let value = redact_secret_bearing_value_at(value, "$", &mut findings);
    SecretRedactionResult { value, findings }
}

fn redact_secret_bearing_value_at(
    value: &Value,
    field: &str,
    findings: &mut Vec<SecretRedactionFinding>,
) -> Value {
    match value {
        Value::Object(object) => {
            let mut redacted = serde_json::Map::new();
            for (key, child) in object {
                let child_field = if field == "$" {
                    key.to_string()
                } else {
                    format!("{field}.{key}")
                };
                if let Some(reason) = secret_redaction_reason(key, &child_field, child) {
                    findings.push(SecretRedactionFinding {
                        code: SemanticErrorCode::SecretRedacted.to_string(),
                        field: child_field,
                        reason: reason.to_string(),
                    });
                    redacted.insert(
                        key.clone(),
                        Value::String(format!("[REDACTED:{}]", SEMANTIC_SECRET_REDACTED)),
                    );
                } else {
                    redacted.insert(
                        key.clone(),
                        redact_secret_bearing_value_at(child, &child_field, findings),
                    );
                }
            }
            Value::Object(redacted)
        }
        Value::Array(items) => Value::Array(
            items
                .iter()
                .enumerate()
                .map(|(index, item)| {
                    redact_secret_bearing_value_at(item, &format!("{field}.{index}"), findings)
                })
                .collect(),
        ),
        _ => value.clone(),
    }
}

fn secret_redaction_reason<'a>(key: &str, field: &str, value: &'a Value) -> Option<&'a str> {
    let normalized = normalize_secret_field_name(key);
    if normalized == "secretref"
        && value
            .as_str()
            .is_some_and(|secret_ref| SecretRef::new(secret_ref.to_string()).is_ok())
    {
        return None;
    }
    if normalized == "secret" && value.is_boolean() {
        return None;
    }
    if is_forbidden_secret_field(&normalized) {
        return Some(
            "secret-bearing fields must be redacted before profiles or reports are persisted",
        );
    }
    let text = value.as_str()?;
    if is_free_text_secret_scan_field(&normalized) && free_text_requires_redaction(text) {
        return Some(
            "free-text profile/report fields must not persist secrets, helper dumps, decrypted text, local paths, or private source filenames",
        );
    }
    if is_path_like_field(&normalized) && is_local_absolute_path(text) {
        return Some("local paths must be redacted from profiles and reports");
    }
    if is_key_like_context(&normalized, field) && looks_like_raw_key_material(text) {
        return Some("raw key-like material must be referenced through secretRef, not persisted");
    }
    if is_archive_parameter_value_field(field) && looks_like_raw_key_material(text) {
        return Some(
            "raw key-like archive parameter values must be referenced through secretRef, not persisted",
        );
    }
    None
}

fn normalize_secret_field_name(key: &str) -> String {
    key.chars()
        .filter(|character| character.is_ascii_alphanumeric())
        .flat_map(char::to_lowercase)
        .collect()
}

fn is_forbidden_secret_field(normalized: &str) -> bool {
    matches!(
        normalized,
        "rawkey"
            | "keymaterial"
            | "keybytes"
            | "keyhex"
            | "keyvalue"
            | "rawsecret"
            | "secretmaterial"
            | "secretvalue"
            | "helperdump"
            | "helperlog"
            | "rawlog"
            | "memorydump"
            | "decryptedtext"
            | "decryptedplaintext"
            | "privatetext"
            | "localpath"
    )
}

fn is_path_like_field(normalized: &str) -> bool {
    normalized.contains("path") || normalized == "gamedir"
}

fn is_free_text_secret_scan_field(normalized: &str) -> bool {
    matches!(normalized, "description" | "placeholder" | "limitation")
}

fn is_key_like_context(normalized: &str, field: &str) -> bool {
    normalized.contains("key")
        || normalized.contains("secret")
        || field.starts_with("keyRequirements.")
        || field.contains(".keyRequirements.")
}

fn looks_like_raw_key_material(text: &str) -> bool {
    let text = text.trim();
    if text.starts_with("sha256:") || is_valid_secret_ref(text) {
        return false;
    }
    looks_like_raw_key_material_without_secret_ref(text)
}

fn is_archive_parameter_value_field(field: &str) -> bool {
    let segments = field.split('.').collect::<Vec<_>>();
    segments.len() >= 3
        && segments.last() == Some(&"value")
        && segments
            .get(segments.len().saturating_sub(3))
            .is_some_and(|segment| *segment == "archiveParameters")
        && segments
            .get(segments.len().saturating_sub(2))
            .is_some_and(|segment| segment.parse::<usize>().is_ok())
}

fn is_local_absolute_path(text: &str) -> bool {
    text.starts_with('/')
        || text.starts_with('\\')
        || path_has_windows_drive_prefix_component(text)
        || path_starts_with_home_or_local_env_var(text)
}

fn is_valid_secret_ref(value: &str) -> bool {
    let Some((scheme, name)) = value.split_once(':') else {
        return false;
    };
    if !matches!(
        scheme,
        "local-secret" | "os-keychain" | "secret-manager" | "prompt"
    ) {
        return false;
    }
    if name.is_empty()
        || name.trim() != name
        || name.contains('\0')
        || name.contains('\\')
        || name
            .split('/')
            .any(|component| component.is_empty() || component == "..")
        || is_local_absolute_path(name)
        || looks_like_raw_key_material_without_secret_ref(name)
    {
        return false;
    }
    name.chars().all(|character| {
        character.is_ascii_alphanumeric() || matches!(character, '-' | '_' | '.' | '/' | ':' | '@')
    })
}

fn looks_like_raw_key_material_without_secret_ref(text: &str) -> bool {
    let hex_compact = text
        .chars()
        .filter(|character| !matches!(character, ' ' | '\t' | '\n' | '\r' | ':' | '-'))
        .collect::<String>();
    if hex_compact.len() >= 32
        && hex_compact.len() % 2 == 0
        && hex_compact
            .chars()
            .all(|character| character.is_ascii_hexdigit())
    {
        return true;
    }

    let encoded_compact = text
        .chars()
        .filter(|character| !matches!(character, ' ' | '\t' | '\n' | '\r'))
        .collect::<String>();
    looks_like_base64_key_material(&encoded_compact)
        || looks_like_base64url_key_material(&encoded_compact)
}

fn looks_like_base64_key_material(text: &str) -> bool {
    text.len() >= 22
        && text.chars().all(|character| {
            character.is_ascii_alphanumeric() || matches!(character, '+' | '/' | '=')
        })
        && text
            .chars()
            .any(|character| matches!(character, '+' | '/' | '='))
        && base64_padding_is_valid(text)
        && encoded_material_entropy(text) >= 4.0
}

fn looks_like_base64url_key_material(text: &str) -> bool {
    let unpadded = text.trim_end_matches('=');
    if !(22..=256).contains(&unpadded.len()) {
        return false;
    }
    if !base64_padding_is_valid(text)
        || !unpadded
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || matches!(character, '-' | '_'))
        || unpadded.contains('=')
    {
        return false;
    }

    let has_lowercase = unpadded
        .chars()
        .any(|character| character.is_ascii_lowercase());
    let has_uppercase = unpadded
        .chars()
        .any(|character| character.is_ascii_uppercase());
    let has_digit = unpadded.chars().any(|character| character.is_ascii_digit());
    let has_url_symbol = unpadded
        .chars()
        .any(|character| matches!(character, '-' | '_'));
    let signal_classes =
        usize::from(has_lowercase) + usize::from(has_uppercase) + usize::from(has_digit);
    let entropy = encoded_material_entropy(unpadded);
    (signal_classes >= 3 && entropy >= 4.0)
        || (has_url_symbol && signal_classes >= 2 && entropy >= 3.8)
        || (has_lowercase && has_uppercase && unpadded.len() >= 24 && entropy >= 4.0)
}

fn base64_padding_is_valid(text: &str) -> bool {
    if text.len() % 4 == 1 {
        return false;
    }
    let first_padding = text.find('=').unwrap_or(text.len());
    text[first_padding..]
        .chars()
        .all(|character| character == '=')
}

fn encoded_material_entropy(text: &str) -> f64 {
    let sample = text.trim_end_matches('=');
    if sample.is_empty() {
        return 0.0;
    }
    let mut frequencies = BTreeMap::<char, usize>::new();
    for character in sample.chars() {
        *frequencies.entry(character).or_default() += 1;
    }
    let length = sample.chars().count() as f64;
    frequencies
        .values()
        .map(|count| {
            let probability = *count as f64 / length;
            -probability * probability.log2()
        })
        .sum()
}

fn is_sha256_ref(value: &str) -> bool {
    let Some(hash) = value.strip_prefix("sha256:") else {
        return false;
    };
    hash.len() == 64
        && hash
            .chars()
            .all(|character| character.is_ascii_hexdigit() && !character.is_ascii_uppercase())
}

pub fn redact_for_log_or_report(text: &str) -> String {
    if text_requires_redaction(text) {
        format!("[REDACTED:{}]", SEMANTIC_SECRET_REDACTED)
    } else {
        text.to_string()
    }
}

pub fn redact_report_value(value: &Value) -> Value {
    redact_report_value_at(value, "$")
}

fn redact_report_value_at(value: &Value, field: &str) -> Value {
    match value {
        Value::Object(object) => {
            let mut redacted = serde_json::Map::new();
            for (key, child) in object {
                let child_field = if field == "$" {
                    key.to_string()
                } else {
                    format!("{field}.{key}")
                };
                if secret_redaction_reason(key, &child_field, child).is_some() {
                    redacted.insert(
                        key.clone(),
                        Value::String(format!("[REDACTED:{}]", SEMANTIC_SECRET_REDACTED)),
                    );
                } else {
                    redacted.insert(key.clone(), redact_report_value_at(child, &child_field));
                }
            }
            Value::Object(redacted)
        }
        Value::Array(items) => Value::Array(
            items
                .iter()
                .enumerate()
                .map(|(index, item)| redact_report_value_at(item, &format!("{field}.{index}")))
                .collect(),
        ),
        Value::String(text) => Value::String(redact_for_log_or_report(text)),
        _ => value.clone(),
    }
}

fn redact_asset_ref_for_report(asset_ref: &str) -> String {
    if asset_ref_requires_redaction(asset_ref) {
        format!("[REDACTED:{}]", SEMANTIC_SECRET_REDACTED)
    } else {
        asset_ref.to_string()
    }
}

fn text_requires_redaction(text: &str) -> bool {
    let text = text.trim();
    text_contains_local_absolute_path(text)
        || text_contains_raw_key_material(text)
        || text_contains_forbidden_private_payload(text)
        || text_contains_sensitive_filename(text)
}

fn free_text_requires_redaction(text: &str) -> bool {
    let text = text.trim();
    text_contains_local_absolute_path(text)
        || text_contains_raw_key_material_token(text)
        || text_contains_forbidden_private_payload(text)
        || text_contains_sensitive_filename(text)
}

fn asset_ref_requires_redaction(asset_ref: &str) -> bool {
    if text_requires_redaction(asset_ref) {
        return true;
    }
    let path_part = asset_ref.split('#').next().unwrap_or(asset_ref);
    path_part.contains(['/', '\\']) && safe_relative_path_parts(path_part).is_err()
}

fn text_contains_local_absolute_path(text: &str) -> bool {
    text.split_whitespace()
        .map(trim_token_punctuation)
        .any(token_contains_local_absolute_path)
}

fn token_contains_local_absolute_path(token: &str) -> bool {
    if token.is_empty() {
        return false;
    }
    if is_local_absolute_path(token) || path_has_windows_drive_prefix_component(token) {
        return true;
    }
    token.char_indices().any(|(index, character)| {
        if !matches!(character, '=' | ':') {
            return false;
        }
        if character == ':'
            && token
                .get(index.saturating_sub(5)..index + 3)
                .is_some_and(|window| window.eq_ignore_ascii_case("https://"))
        {
            return false;
        }
        if character == ':'
            && token
                .get(index.saturating_sub(4)..index + 3)
                .is_some_and(|window| window.eq_ignore_ascii_case("http://"))
        {
            return false;
        }
        let candidate = trim_token_punctuation(&token[index + character.len_utf8()..]);
        !candidate.is_empty()
            && (is_local_absolute_path(candidate)
                || path_has_windows_drive_prefix_component(candidate))
    })
}

fn path_starts_with_home_or_local_env_var(path: &str) -> bool {
    let path = path.trim_start();
    if path.starts_with("~/") || path.starts_with("~\\") {
        return true;
    }

    let local_env_prefixes = [
        "$HOME",
        "${HOME}",
        "$USERPROFILE",
        "${USERPROFILE}",
        "$HOMEPATH",
        "${HOMEPATH}",
        "$APPDATA",
        "${APPDATA}",
        "$LOCALAPPDATA",
        "${LOCALAPPDATA}",
        "%HOME%",
        "%USERPROFILE%",
        "%HOMEPATH%",
        "%APPDATA%",
        "%LOCALAPPDATA%",
        "%TEMP%",
        "%TMP%",
    ];
    local_env_prefixes.iter().any(|prefix| {
        path.get(..prefix.len())
            .is_some_and(|start| start.eq_ignore_ascii_case(prefix))
            && path[prefix.len()..].starts_with(['/', '\\'])
    })
}

fn text_contains_raw_key_material(text: &str) -> bool {
    if looks_like_raw_key_material(text) {
        return true;
    }
    text_contains_raw_key_material_token(text)
}

fn text_contains_raw_key_material_token(text: &str) -> bool {
    text.split(|character: char| {
        !(character.is_ascii_alphanumeric() || matches!(character, '+' | '/' | '=' | '-' | '_'))
    })
    .any(looks_like_raw_key_material)
}

fn text_contains_forbidden_private_payload(text: &str) -> bool {
    let normalized = text.to_ascii_lowercase();
    [
        "helper dump",
        "memory dump",
        "register dump",
        "raw helper log",
        "decrypted script",
        "decrypted text",
        "private script",
        "private translated",
        "raw key",
    ]
    .iter()
    .any(|needle| normalized.contains(needle))
}

fn text_contains_sensitive_filename(text: &str) -> bool {
    text.split_whitespace()
        .map(trim_token_punctuation)
        .any(|token| {
            let lower = token.to_ascii_lowercase();
            let looks_like_file = lower.contains('.')
                && lower
                    .rsplit_once('.')
                    .is_some_and(|(_, extension)| extension.len() <= 8);
            looks_like_file
                && ["private", "spoiler", "route", "ending", "true-end"]
                    .iter()
                    .any(|needle| lower.contains(needle))
        })
}

fn trim_token_punctuation(token: &str) -> &str {
    token.trim_matches(|character: char| {
        matches!(
            character,
            '"' | '\'' | '`' | ',' | ';' | ':' | '(' | ')' | '[' | ']' | '{' | '}'
        )
    })
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
    fn redacted_for_report(&self) -> Self {
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
    validate_profile_relative_path(&mut profile_failures, field, path);
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
        stable_json(&self.redacted_for_report())
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

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LayeredAccessStage {
    Container,
    Crypto,
    Codec,
    PatchBack,
}

impl LayeredAccessStage {
    pub fn required_capability(self) -> Capability {
        match self {
            Self::Container => Capability::ContainerAccess,
            Self::Crypto => Capability::CryptoAccess,
            Self::Codec => Capability::CodecAccess,
            Self::PatchBack => Capability::PatchBack,
        }
    }

    pub fn missing_capability_error(self) -> SemanticErrorCode {
        match self {
            Self::Container => SemanticErrorCode::MissingContainerCapability,
            Self::Crypto => SemanticErrorCode::MissingCryptoCapability,
            Self::Codec => SemanticErrorCode::MissingCodecCapability,
            Self::PatchBack => SemanticErrorCode::MissingPatchBackCapability,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LayeredAccessPreflightFailureKind {
    MissingCapability,
    UnsupportedTransform,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LayeredAccessPreflightRequirement {
    pub stage: LayeredAccessStage,
    pub failure_kind: LayeredAccessPreflightFailureKind,
    pub asset_ref: Option<String>,
    pub transform_id: Option<String>,
    pub support_boundary: String,
    pub remediation: Option<String>,
}

impl LayeredAccessPreflightRequirement {
    pub fn missing_capability(
        stage: LayeredAccessStage,
        asset_ref: impl Into<String>,
        support_boundary: impl Into<String>,
    ) -> Self {
        Self {
            stage,
            failure_kind: LayeredAccessPreflightFailureKind::MissingCapability,
            asset_ref: Some(asset_ref.into()),
            transform_id: None,
            support_boundary: support_boundary.into(),
            remediation: Some(remediation_for_layered_stage(stage).to_string()),
        }
    }

    pub fn unsupported_transform(
        stage: LayeredAccessStage,
        transform_id: impl Into<String>,
        asset_ref: impl Into<String>,
        support_boundary: impl Into<String>,
    ) -> Self {
        Self {
            stage,
            failure_kind: LayeredAccessPreflightFailureKind::UnsupportedTransform,
            asset_ref: Some(asset_ref.into()),
            transform_id: Some(transform_id.into()),
            support_boundary: support_boundary.into(),
            remediation: Some(
                "choose a supported layered transform or add a readiness profile before patching"
                    .to_string(),
            ),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LayeredAccessPreflightReport {
    pub schema_version: String,
    pub adapter_id: String,
    pub engine: String,
    pub detected_variant: String,
    pub status: OperationStatus,
    pub failures: Vec<AdapterFailure>,
}

impl LayeredAccessPreflightReport {
    pub fn from_requirements(
        adapter_id: impl Into<String>,
        engine: impl Into<String>,
        detected_variant: impl Into<String>,
        requirements: Vec<LayeredAccessPreflightRequirement>,
    ) -> Self {
        let adapter_id = adapter_id.into();
        let engine = engine.into();
        let detected_variant = detected_variant.into();
        let failures = requirements
            .into_iter()
            .map(|requirement| {
                requirement.to_adapter_failure(&adapter_id, &engine, &detected_variant)
            })
            .collect::<Vec<_>>();
        Self {
            schema_version: PROFILE_SCHEMA_VERSION.to_string(),
            adapter_id,
            engine,
            detected_variant,
            status: if failures.is_empty() {
                OperationStatus::Passed
            } else {
                OperationStatus::Failed
            },
            failures,
        }
        .redacted_for_report()
    }

    pub fn redacted_for_report(&self) -> Self {
        let mut report = self.clone();
        report.adapter_id = redact_for_log_or_report(&report.adapter_id);
        report.engine = redact_for_log_or_report(&report.engine);
        report.detected_variant = redact_for_log_or_report(&report.detected_variant);
        report.failures = report
            .failures
            .iter()
            .map(AdapterFailure::redacted_for_report)
            .collect();
        report
    }

    pub fn stable_json(&self) -> KaifuuResult<String> {
        stable_json(&self.redacted_for_report())
    }
}

impl LayeredAccessPreflightRequirement {
    fn to_adapter_failure(
        &self,
        adapter: &str,
        engine: &str,
        detected_variant: &str,
    ) -> AdapterFailure {
        let mut params = AdapterFailureSemanticParams::new(
            match self.failure_kind {
                LayeredAccessPreflightFailureKind::MissingCapability => {
                    self.stage.missing_capability_error()
                }
                LayeredAccessPreflightFailureKind::UnsupportedTransform => {
                    SemanticErrorCode::UnsupportedLayeredTransform
                }
            },
            adapter,
            &self.support_boundary,
        )
        .engine(engine)
        .detected_variant(detected_variant)
        .required_capability(self.stage.required_capability());
        if let Some(asset_ref) = &self.asset_ref {
            params = params.asset_ref(asset_ref);
        }
        if let Some(remediation) = &self.remediation {
            params = params.remediation(remediation);
        }
        if let Some(transform_id) = &self.transform_id {
            params = params.remediation(format!(
                "{}; unsupported transform: {}",
                self.remediation
                    .as_deref()
                    .unwrap_or("add layered access support"),
                redact_for_log_or_report(transform_id)
            ));
        }
        AdapterFailure::semantic(params)
    }
}

fn remediation_for_layered_stage(stage: LayeredAccessStage) -> &'static str {
    match stage {
        LayeredAccessStage::Container => {
            "provide a supported container/archive transform before extraction or patching"
        }
        LayeredAccessStage::Crypto => {
            "provide supported crypto parameters and resolved key material before extraction or patching"
        }
        LayeredAccessStage::Codec => {
            "provide a supported codec/decompile transform before normalizing text"
        }
        LayeredAccessStage::PatchBack => {
            "provide a supported patch-back transform before writing patched output"
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AdapterFailureSemanticParams {
    error_code: SemanticErrorCode,
    adapter: String,
    engine: Option<String>,
    detected_variant: Option<String>,
    asset_ref: Option<String>,
    required_capability: Option<Capability>,
    support_boundary: String,
    remediation: Option<String>,
}

impl AdapterFailureSemanticParams {
    pub fn new(
        error_code: SemanticErrorCode,
        adapter: impl Into<String>,
        support_boundary: impl Into<String>,
    ) -> Self {
        Self {
            error_code,
            adapter: adapter.into(),
            engine: None,
            detected_variant: None,
            asset_ref: None,
            required_capability: None,
            support_boundary: support_boundary.into(),
            remediation: None,
        }
    }

    pub fn engine(mut self, engine: impl Into<String>) -> Self {
        self.engine = Some(engine.into());
        self
    }

    pub fn detected_variant(mut self, detected_variant: impl Into<String>) -> Self {
        self.detected_variant = Some(detected_variant.into());
        self
    }

    pub fn asset_ref(mut self, asset_ref: impl Into<String>) -> Self {
        self.asset_ref = Some(asset_ref.into());
        self
    }

    pub fn required_capability(mut self, required_capability: Capability) -> Self {
        self.required_capability = Some(required_capability);
        self
    }

    pub fn remediation(mut self, remediation: impl Into<String>) -> Self {
        self.remediation = Some(remediation.into());
        self
    }
}

impl AdapterFailure {
    pub fn semantic(params: AdapterFailureSemanticParams) -> Self {
        Self {
            error_code: params.error_code.to_string(),
            adapter: params.adapter,
            engine: params.engine,
            detected_variant: params.detected_variant,
            asset_ref: params.asset_ref,
            required_capability: params.required_capability,
            support_boundary: params.support_boundary,
            remediation: params.remediation,
        }
        .redacted_for_report()
    }

    pub fn redacted_for_report(&self) -> Self {
        Self {
            error_code: redact_for_log_or_report(&self.error_code),
            adapter: redact_for_log_or_report(&self.adapter),
            engine: self.engine.as_deref().map(redact_for_log_or_report),
            detected_variant: self
                .detected_variant
                .as_deref()
                .map(redact_for_log_or_report),
            asset_ref: self.asset_ref.as_deref().map(redact_asset_ref_for_report),
            required_capability: self.required_capability.clone(),
            support_boundary: redact_for_log_or_report(&self.support_boundary),
            remediation: self.remediation.as_deref().map(redact_for_log_or_report),
        }
    }

    pub fn is_preflight_blocking(&self) -> bool {
        matches!(
            self.error_code.as_str(),
            SEMANTIC_MISSING_KEY_PROFILE
                | SEMANTIC_MISSING_KEY_MATERIAL
                | SEMANTIC_HELPER_UNAVAILABLE
                | SEMANTIC_KEY_VALIDATION_FAILED
                | SEMANTIC_PROTECTED_EXECUTABLE_UNSUPPORTED
                | SEMANTIC_UNSUPPORTED_LAYERED_TRANSFORM
                | SEMANTIC_MISSING_CONTAINER_CAPABILITY
                | SEMANTIC_MISSING_CRYPTO_CAPABILITY
                | SEMANTIC_MISSING_CODEC_CAPABILITY
                | SEMANTIC_MISSING_PATCH_BACK_CAPABILITY
        )
    }

    pub fn missing_key_profile(
        adapter: impl Into<String>,
        engine: impl Into<String>,
        detected_variant: impl Into<String>,
        support_boundary: impl Into<String>,
    ) -> Self {
        Self::semantic(
            AdapterFailureSemanticParams::new(
                SemanticErrorCode::MissingKeyProfile,
                adapter,
                support_boundary,
            )
            .engine(engine)
            .detected_variant(detected_variant)
            .required_capability(Capability::KeyProfile)
            .remediation("provide a key profile that references local secret refs"),
        )
    }

    pub fn missing_key_material(
        adapter: impl Into<String>,
        engine: impl Into<String>,
        detected_variant: impl Into<String>,
        requirement_id: impl Into<String>,
        support_boundary: impl Into<String>,
    ) -> Self {
        Self::semantic(
            AdapterFailureSemanticParams::new(
                SemanticErrorCode::MissingKeyMaterial,
                adapter,
                support_boundary,
            )
            .engine(engine)
            .detected_variant(detected_variant)
            .asset_ref(requirement_id)
            .required_capability(Capability::KeyProfile)
            .remediation(
                "resolve the referenced local secret material before extraction or patching",
            ),
        )
    }

    pub fn helper_unavailable(
        adapter: impl Into<String>,
        engine: impl Into<String>,
        detected_variant: impl Into<String>,
        support_boundary: impl Into<String>,
    ) -> Self {
        Self::semantic(
            AdapterFailureSemanticParams::new(
                SemanticErrorCode::HelperUnavailable,
                adapter,
                support_boundary,
            )
            .engine(engine)
            .detected_variant(detected_variant)
            .required_capability(Capability::KeyProfile)
            .remediation(
                "run an available local helper or provide validated key material manually",
            ),
        )
    }

    pub fn key_validation_failed(
        adapter: impl Into<String>,
        engine: impl Into<String>,
        detected_variant: impl Into<String>,
        requirement_id: impl Into<String>,
        support_boundary: impl Into<String>,
    ) -> Self {
        Self::semantic(
            AdapterFailureSemanticParams::new(
                SemanticErrorCode::KeyValidationFailed,
                adapter,
                support_boundary,
            )
            .engine(engine)
            .detected_variant(detected_variant)
            .asset_ref(requirement_id)
            .required_capability(Capability::KeyProfile)
            .remediation("replace or revalidate the local key material"),
        )
    }

    pub fn protected_executable_unsupported(
        adapter: impl Into<String>,
        engine: impl Into<String>,
        detected_variant: impl Into<String>,
        support_boundary: impl Into<String>,
    ) -> Self {
        Self::semantic(
            AdapterFailureSemanticParams::new(
                SemanticErrorCode::ProtectedExecutableUnsupported,
                adapter,
                support_boundary,
            )
            .engine(engine)
            .detected_variant(detected_variant)
            .required_capability(Capability::KeyProfile)
            .remediation("use a helper that supports this protected executable boundary"),
        )
    }

    pub fn secret_redacted(
        adapter: impl Into<String>,
        engine: impl Into<String>,
        detected_variant: impl Into<String>,
        asset_ref: impl Into<String>,
        support_boundary: impl Into<String>,
    ) -> Self {
        Self::semantic(
            AdapterFailureSemanticParams::new(
                SemanticErrorCode::SecretRedacted,
                adapter,
                support_boundary,
            )
            .engine(engine)
            .detected_variant(detected_variant)
            .asset_ref(asset_ref)
            .remediation("inspect the redacted local-only evidence on the runner"),
        )
    }
}

impl PatchResult {
    pub fn preflight_pass(patch_export: &PatchExport) -> Self {
        Self {
            schema_version: PROFILE_SCHEMA_VERSION.to_string(),
            patch_result_id: deterministic_id("patch-preflight", 0),
            patch_export_id: patch_export.patch_export_id.clone(),
            status: OperationStatus::Passed,
            output_hash: content_hash("patch preflight passed without output"),
            failures: vec![],
        }
    }

    pub fn redacted_for_report(&self) -> Self {
        let mut result = self.clone();
        result.patch_result_id = redact_for_log_or_report(&result.patch_result_id);
        result.patch_export_id = redact_for_log_or_report(&result.patch_export_id);
        result.output_hash = redact_for_log_or_report(&result.output_hash);
        result.failures = result
            .failures
            .iter()
            .map(AdapterFailure::redacted_for_report)
            .collect();
        result
    }

    pub fn has_preflight_blocking_failure(&self) -> bool {
        self.failures
            .iter()
            .any(AdapterFailure::is_preflight_blocking)
    }

    pub fn failure_codes(&self) -> Vec<String> {
        self.failures
            .iter()
            .map(|failure| failure.error_code.clone())
            .collect()
    }
}

impl VerificationResult {
    pub fn redacted_for_report(&self) -> Self {
        let mut result = self.clone();
        result.patch_result_id = redact_for_log_or_report(&result.patch_result_id);
        result.output_hash = redact_for_log_or_report(&result.output_hash);
        result.failures = result
            .failures
            .iter()
            .map(AdapterFailure::redacted_for_report)
            .collect();
        result
    }
}

impl GoldenRoundTripReport {
    pub fn redacted_for_report(&self) -> Self {
        let mut report = self.clone();
        report.report_id = redact_for_log_or_report(&report.report_id);
        report.adapter_id = redact_for_log_or_report(&report.adapter_id);
        report.adapter_name = redact_for_log_or_report(&report.adapter_name);
        report.phases = report
            .phases
            .iter()
            .map(GoldenPhaseReport::redacted_for_report)
            .collect();
        report.failures = report
            .failures
            .iter()
            .map(GoldenFailure::redacted_for_report)
            .collect();
        report
    }
}

impl GoldenPhaseReport {
    fn redacted_for_report(&self) -> Self {
        Self {
            phase: redact_for_log_or_report(&self.phase),
            status: self.status.clone(),
            details: redact_for_log_or_report(&self.details),
            asset_ref: self.asset_ref.as_deref().map(redact_asset_ref_for_report),
            source_unit_key: self
                .source_unit_key
                .as_deref()
                .map(redact_for_log_or_report),
            support_boundary: self
                .support_boundary
                .as_deref()
                .map(redact_for_log_or_report),
            expected: self.expected.as_deref().map(redact_for_log_or_report),
            actual: self.actual.as_deref().map(redact_for_log_or_report),
        }
    }
}

impl GoldenFailure {
    fn redacted_for_report(&self) -> Self {
        Self {
            code: redact_for_log_or_report(&self.code),
            phase: redact_for_log_or_report(&self.phase),
            adapter_id: redact_for_log_or_report(&self.adapter_id),
            message: redact_for_log_or_report(&self.message),
            asset_ref: self.asset_ref.as_deref().map(redact_asset_ref_for_report),
            source_unit_key: self
                .source_unit_key
                .as_deref()
                .map(redact_for_log_or_report),
            support_boundary: self
                .support_boundary
                .as_deref()
                .map(redact_for_log_or_report),
            expected: self.expected.as_deref().map(redact_for_log_or_report),
            actual: self.actual.as_deref().map(redact_for_log_or_report),
        }
    }
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

/// Validates Kaifuu's portable relative path rule for package-controlled writes
/// and profile asset paths.
///
/// This only validates the caller-provided string. It does not normalize,
/// canonicalize, or return a safe output path. Use [`safe_join_relative`] when a
/// validated relative path must be materialized under a trusted root.
///
/// The rule treats `/` and `\` as separators and rejects empty paths, absolute
/// paths, empty components, `.` components, `..` components, NUL bytes, and
/// Windows drive-prefix components anywhere in the path.
pub fn validate_safe_relative_path(relative_path: &str) -> KaifuuResult<()> {
    safe_relative_path_parts(relative_path)?;
    Ok(())
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

fn is_windows_drive_prefix_component(component: &str) -> bool {
    let bytes = component.as_bytes();
    bytes.len() >= 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':'
}

fn path_has_windows_drive_prefix_component(path: &str) -> bool {
    path.split(['/', '\\'])
        .any(is_windows_drive_prefix_component)
}

fn unsafe_relative_path_error(relative_path: &str) -> Box<dyn std::error::Error> {
    format!(
        "unsafe relative output path {relative_path:?}: path must be relative and must not contain dot components, traversal, or drive prefixes"
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

pub fn promote_staged_directory_no_clobber(
    staging_dir: &Path,
    output_dir: &Path,
    output_label: &str,
) -> KaifuuResult<()> {
    let staging_metadata = fs::symlink_metadata(staging_dir)?;
    if !staging_metadata.is_dir() || staging_metadata.file_type().is_symlink() {
        return Err(format!(
            "{output_label} staging path must be a real directory: {}",
            redact_for_log_or_report(&staging_dir.display().to_string())
        )
        .into());
    }

    let parent = output_dir.parent().unwrap_or_else(|| Path::new("."));
    fs::create_dir_all(parent)?;
    if fs::symlink_metadata(output_dir).is_ok() {
        return Err(output_already_exists_error(output_label, output_dir));
    }

    match rename_directory_no_replace(staging_dir, output_dir) {
        Ok(()) => {
            sync_directory_best_effort(parent);
            Ok(())
        }
        Err(error) if error.kind() == ErrorKind::AlreadyExists => {
            Err(output_already_exists_error(output_label, output_dir))
        }
        Err(_error) if fs::symlink_metadata(output_dir).is_ok() => {
            Err(output_already_exists_error(output_label, output_dir))
        }
        Err(error) => Err(format!(
            "{output_label} promotion failed without replacing an existing output path: {}",
            error
        )
        .into()),
    }
}

fn output_already_exists_error(
    output_label: &str,
    output_dir: &Path,
) -> Box<dyn std::error::Error> {
    format!(
        "{output_label} already exists; refusing to replace it during no-clobber promotion: {}",
        redact_for_log_or_report(&output_dir.display().to_string())
    )
    .into()
}

#[cfg(all(
    target_os = "linux",
    any(
        target_arch = "aarch64",
        target_arch = "arm",
        target_arch = "powerpc64",
        target_arch = "riscv64",
        target_arch = "s390x",
        target_arch = "x86",
        target_arch = "x86_64"
    )
))]
fn rename_directory_no_replace(staging_dir: &Path, output_dir: &Path) -> io::Result<()> {
    use std::os::raw::{c_char, c_long};
    use std::os::unix::ffi::OsStrExt;

    const AT_FDCWD: c_long = -100;
    const RENAME_NOREPLACE: c_long = 1;

    #[cfg(target_arch = "aarch64")]
    const SYS_RENAMEAT2: c_long = 276;
    #[cfg(target_arch = "arm")]
    const SYS_RENAMEAT2: c_long = 382;
    #[cfg(target_arch = "powerpc64")]
    const SYS_RENAMEAT2: c_long = 357;
    #[cfg(target_arch = "riscv64")]
    const SYS_RENAMEAT2: c_long = 276;
    #[cfg(target_arch = "s390x")]
    const SYS_RENAMEAT2: c_long = 347;
    #[cfg(target_arch = "x86")]
    const SYS_RENAMEAT2: c_long = 353;
    #[cfg(target_arch = "x86_64")]
    const SYS_RENAMEAT2: c_long = 316;

    unsafe extern "C" {
        fn syscall(num: c_long, ...) -> c_long;
    }

    let staging = CString::new(staging_dir.as_os_str().as_bytes())
        .map_err(|_| io::Error::new(ErrorKind::InvalidInput, "staging path contains NUL byte"))?;
    let output = CString::new(output_dir.as_os_str().as_bytes())
        .map_err(|_| io::Error::new(ErrorKind::InvalidInput, "output path contains NUL byte"))?;
    let result = unsafe {
        syscall(
            SYS_RENAMEAT2,
            AT_FDCWD,
            staging.as_ptr() as *const c_char,
            AT_FDCWD,
            output.as_ptr() as *const c_char,
            RENAME_NOREPLACE,
        )
    };
    if result == 0 {
        Ok(())
    } else {
        Err(io::Error::last_os_error())
    }
}

#[cfg(all(
    target_os = "linux",
    not(any(
        target_arch = "aarch64",
        target_arch = "arm",
        target_arch = "powerpc64",
        target_arch = "riscv64",
        target_arch = "s390x",
        target_arch = "x86",
        target_arch = "x86_64"
    ))
))]
fn rename_directory_no_replace(_staging_dir: &Path, _output_dir: &Path) -> io::Result<()> {
    Err(io::Error::new(
        ErrorKind::Unsupported,
        "no-clobber directory promotion is not implemented for this Linux architecture",
    ))
}

#[cfg(target_os = "macos")]
fn rename_directory_no_replace(staging_dir: &Path, output_dir: &Path) -> io::Result<()> {
    use std::os::raw::{c_char, c_int};
    use std::os::unix::ffi::OsStrExt;

    const RENAME_EXCL: u32 = 0x0000_0004;

    unsafe extern "C" {
        fn renamex_np(from: *const c_char, to: *const c_char, flags: u32) -> c_int;
    }

    let staging = CString::new(staging_dir.as_os_str().as_bytes())
        .map_err(|_| io::Error::new(ErrorKind::InvalidInput, "staging path contains NUL byte"))?;
    let output = CString::new(output_dir.as_os_str().as_bytes())
        .map_err(|_| io::Error::new(ErrorKind::InvalidInput, "output path contains NUL byte"))?;
    let result = unsafe { renamex_np(staging.as_ptr(), output.as_ptr(), RENAME_EXCL) };
    if result == 0 {
        Ok(())
    } else {
        Err(io::Error::last_os_error())
    }
}

#[cfg(windows)]
fn rename_directory_no_replace(staging_dir: &Path, output_dir: &Path) -> io::Result<()> {
    fs::rename(staging_dir, output_dir)
}

#[cfg(all(unix, not(any(target_os = "linux", target_os = "macos"))))]
fn rename_directory_no_replace(_staging_dir: &Path, _output_dir: &Path) -> io::Result<()> {
    Err(io::Error::new(
        ErrorKind::Unsupported,
        "no-clobber directory promotion requires a platform no-replace rename primitive",
    ))
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
            record_golden_failure(&mut report, (*failure).with_adapter_id(adapter.id()));
            return Ok(finalize_golden_report(report));
        }
    };

    let Some(unchanged_output_dir) = run_golden_patch_phase(
        adapter,
        &mut report,
        "unchanged_patch",
        request.game_dir,
        request.work_dir,
        "unchanged-patch",
        &unchanged_patch,
        "unchanged patch applied successfully",
        "unchanged_patch_error",
        "successful unchanged patch",
    )?
    else {
        return Ok(finalize_golden_report(report));
    };

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

#[allow(clippy::too_many_arguments)]
fn run_golden_patch_phase(
    adapter: &dyn EngineAdapter,
    report: &mut GoldenRoundTripReport,
    phase: &str,
    game_dir: &Path,
    work_dir: &Path,
    work_child: &str,
    patch_export: &PatchExport,
    success_details: &str,
    patch_error_code: &str,
    patch_expected: &str,
) -> KaifuuResult<Option<PathBuf>> {
    match adapter.patch_preflight(PatchPreflightRequest {
        game_dir,
        patch_export,
    }) {
        Ok(preflight)
            if preflight.status == OperationStatus::Failed
                && preflight.has_preflight_blocking_failure() =>
        {
            let preflight = preflight.redacted_for_report();
            record_adapter_failures(report, adapter.id(), phase, &preflight);
            return Ok(None);
        }
        Ok(_) => {}
        Err(error) => {
            record_golden_failure(
                report,
                GoldenFailure {
                    code: format!("{phase}_preflight_error"),
                    phase: phase.to_string(),
                    adapter_id: adapter.id().to_string(),
                    message: error.to_string(),
                    asset_ref: Some("source.json".to_string()),
                    source_unit_key: None,
                    support_boundary: None,
                    expected: Some(format!("{patch_expected} preflight")),
                    actual: Some("adapter error".to_string()),
                },
            );
            return Ok(None);
        }
    }

    let output_dir = prepare_golden_work_dir(work_dir, work_child)?;
    match adapter.patch(PatchRequest {
        game_dir,
        patch_export,
        output_dir: &output_dir,
    }) {
        Ok(patch_result) if patch_result.status == OperationStatus::Passed => {
            report_passed_phase(report, phase, success_details, Some("source.json"));
        }
        Ok(patch_result) => {
            let patch_result = patch_result.redacted_for_report();
            record_adapter_failures(report, adapter.id(), phase, &patch_result);
            return Ok(None);
        }
        Err(error) => {
            record_golden_failure(
                report,
                GoldenFailure {
                    code: patch_error_code.to_string(),
                    phase: phase.to_string(),
                    adapter_id: adapter.id().to_string(),
                    message: error.to_string(),
                    asset_ref: Some("source.json".to_string()),
                    source_unit_key: None,
                    support_boundary: None,
                    expected: Some(patch_expected.to_string()),
                    actual: Some("adapter error".to_string()),
                },
            );
            return Ok(None);
        }
    }

    Ok(Some(output_dir))
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

fn unchanged_patch_export(bridge: &BridgeBundle) -> Result<PatchExport, Box<GoldenFailure>> {
    let mut entries = Vec::with_capacity(bridge.units.len());
    for unit in &bridge.units {
        let mut protected_span_mappings = Vec::new();
        let mut search_start = 0;
        for span in &unit.protected_spans {
            if span.raw.is_empty() {
                continue;
            }
            let Some(relative_start) = unit.source_text[search_start..].find(&span.raw) else {
                return Err(Box::new(GoldenFailure {
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
                }));
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

    for failure in patch_result
        .failures
        .iter()
        .map(AdapterFailure::redacted_for_report)
    {
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
                for failure in verify
                    .failures
                    .iter()
                    .map(AdapterFailure::redacted_for_report)
                {
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

    let v02_source_compatibility_checked = patch_export_value["schemaVersion"].as_str()
        != Some(BRIDGE_SCHEMA_VERSION_V02)
        || translated_source_bridge.is_some();
    let patch_export = match patch_export_for_adapter(
        patch_export_value,
        &extraction.bridge,
        v02_source_compatibility_checked,
    ) {
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

    let Some(output_dir) = run_golden_patch_phase(
        adapter,
        report,
        "translated_patch",
        game_dir,
        work_dir,
        "translated-patch",
        &patch_export,
        "translated patch applied successfully",
        "translated_patch_error",
        "successful translated patch",
    )?
    else {
        return Ok(());
    };

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
        record_golden_failure(report, GoldenFailure {
            code: "translated_source_bridge_required".to_string(),
            phase: "translated_source_compatibility".to_string(),
            adapter_id: adapter_id.to_string(),
            message:
                "translated v0.2 patch exports require the source bridge used to create them"
                    .to_string(),
            asset_ref: None,
            source_unit_key: None,
            support_boundary: Some(
                "v0.2 translated patch source compatibility cannot be checked without --translated-source-bridge"
                    .to_string(),
            ),
            expected: Some("source bridge artifact".to_string()),
            actual: Some("missing source bridge".to_string()),
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

fn patch_export_for_adapter(
    value: &Value,
    bridge: &BridgeBundle,
    v02_source_compatibility_checked: bool,
) -> KaifuuResult<PatchExport> {
    if value["schemaVersion"].as_str() != Some(BRIDGE_SCHEMA_VERSION_V02) {
        return PatchExport::from_value(value);
    }
    if !v02_source_compatibility_checked {
        return Err(
            "v0.2 translated patch conversion requires checked source bridge compatibility".into(),
        );
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
    use std::sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    };

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

    fn alpha_proof_fixture_value() -> Value {
        contract_example_fixture_value("./alpha-vertical-proof-manifest-v0.2.json")
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

    fn expect_alpha_proof_error(fixture: Value, expected_error: &str) {
        let error = contracts::validate_alpha_vertical_proof_manifest_v02(&fixture)
            .expect_err("invalid alpha proof manifest should fail Rust validation")
            .to_string();
        assert!(
            error.contains(expected_error),
            "expected error containing {expected_error:?}, got: {error}"
        );
    }

    fn write_fixture_file(root: &Path, relative_path: &str, bytes: &[u8]) {
        let path = root.join(relative_path);
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).unwrap();
        }
        fs::write(path, bytes).unwrap();
    }

    fn detected_archive_row<'a>(
        report: &'a ArchiveDetectionReport,
        row_id: &str,
    ) -> &'a ArchiveDetectionRow {
        let row = report
            .rows
            .iter()
            .find(|row| row.row_id == row_id)
            .unwrap_or_else(|| panic!("missing archive row {row_id}"));
        assert!(row.detected, "{row_id} should be detected: {row:#?}");
        row
    }

    fn golden_boundary_profile(adapter_id: &str) -> GameProfile {
        GameProfile {
            schema_version: PROFILE_SCHEMA_VERSION.to_string(),
            profile_id: deterministic_id("profile", 91),
            game_id: "golden-boundary-fixture".to_string(),
            title: "Golden Boundary Fixture".to_string(),
            source_locale: "ja-JP".to_string(),
            engine: EngineProfile {
                adapter_id: adapter_id.to_string(),
                engine_family: "fixture".to_string(),
                engine_version: None,
                detected_variant: "preflight-boundary".to_string(),
            },
            source_fingerprint: None,
            key_requirements: vec![],
            archive_parameters: vec![],
            helper_evidence: None,
            assets: vec![AssetProfile {
                asset_id: deterministic_id("asset", 91),
                path: "source.json".to_string(),
                asset_kind: AssetKind::Script,
                text_surfaces: vec![TextSurface::Dialogue],
                source_hash: Some(content_hash("こんにちは")),
                patching: CapabilityReport::supported(Capability::Patching),
            }],
            capabilities: vec![
                CapabilityReport::supported(Capability::Detection),
                CapabilityReport::supported(Capability::Extraction),
                CapabilityReport::supported(Capability::Patching),
                CapabilityReport::supported(Capability::Verification),
            ],
            requirements: vec![],
            metadata: BTreeMap::new(),
        }
    }

    fn golden_boundary_extraction(adapter_id: &str) -> ExtractionResult {
        let source_unit_key = "scene.001.line.001".to_string();
        ExtractionResult {
            adapter_id: adapter_id.to_string(),
            profile: golden_boundary_profile(adapter_id),
            bridge: BridgeBundle {
                schema_version: PROFILE_SCHEMA_VERSION.to_string(),
                bridge_id: deterministic_id("bridge", 91),
                source_bundle_hash: content_hash("こんにちは"),
                source_locale: "ja-JP".to_string(),
                extractor_name: "golden-boundary-test".to_string(),
                extractor_version: "0.0.0".to_string(),
                units: vec![BridgeUnit {
                    bridge_unit_id: deterministic_id("bridge-unit", 91),
                    source_unit_key: source_unit_key.clone(),
                    occurrence_id: "scene.001.line.001#1".to_string(),
                    source_hash: content_hash("こんにちは"),
                    source_locale: "ja-JP".to_string(),
                    source_text: "こんにちは".to_string(),
                    speaker: "Narrator".to_string(),
                    text_surface: "dialogue".to_string(),
                    protected_spans: vec![],
                    patch_ref: PatchRef {
                        asset_id: deterministic_id("asset", 91),
                        write_mode: "replace_text".to_string(),
                        source_unit_key,
                    },
                }],
            },
            warnings: vec![],
        }
    }

    fn golden_boundary_patch_export(patch_export_id: impl Into<String>) -> PatchExport {
        PatchExport {
            patch_export_id: patch_export_id.into(),
            source_locale: "ja-JP".to_string(),
            target_locale: "en-US".to_string(),
            entries: vec![PatchExportEntry {
                bridge_unit_id: deterministic_id("bridge-unit", 91),
                source_unit_key: "scene.001.line.001".to_string(),
                source_hash: content_hash("こんにちは"),
                target_text: "Hello.".to_string(),
                protected_span_mappings: vec![],
            }],
        }
    }

    struct GoldenPreflightBoundaryAdapter {
        block_on_preflight_call: usize,
        preflight_calls: Arc<AtomicUsize>,
        patch_calls: Arc<AtomicUsize>,
    }

    impl GoldenPreflightBoundaryAdapter {
        fn preflight_failure(&self, patch_export: &PatchExport) -> PatchResult {
            let raw_key = "00112233445566778899aabbccddeeff";
            let preflight = LayeredAccessPreflightReport::from_requirements(
                self.id(),
                "fixture",
                "layered-access-test",
                vec![
                    LayeredAccessPreflightRequirement::missing_capability(
                        LayeredAccessStage::Container,
                        "private-route-name/ending.ks",
                        "container helper unavailable for $HOME/Private Route Spoiler Game/data.xp3",
                    ),
                    LayeredAccessPreflightRequirement::missing_capability(
                        LayeredAccessStage::Crypto,
                        "%USERPROFILE%\\Games\\Scene.pck",
                        format!(
                            "helper dump at ~/games/private/key.bin included unresolved raw key {raw_key}"
                        ),
                    ),
                ],
            );
            PatchResult {
                schema_version: PROFILE_SCHEMA_VERSION.to_string(),
                patch_result_id: "patch-result=~/Private Route Spoiler Game/patch-result.json"
                    .to_string(),
                patch_export_id: patch_export.patch_export_id.clone(),
                status: OperationStatus::Failed,
                output_hash: format!("helper dump output hash {raw_key}"),
                failures: preflight.failures,
            }
        }
    }

    impl EngineAdapter for GoldenPreflightBoundaryAdapter {
        fn id(&self) -> &'static str {
            "kaifuu.golden-preflight-boundary"
        }

        fn name(&self) -> &'static str {
            "Golden Preflight Boundary"
        }

        fn capabilities(&self) -> AdapterCapabilities {
            AdapterCapabilities::new(
                self.id(),
                vec![
                    CapabilityReport::supported(Capability::Detection),
                    CapabilityReport::supported(Capability::Extraction),
                    CapabilityReport::supported(Capability::Patching),
                    CapabilityReport::supported(Capability::Verification),
                ],
            )
        }

        fn detect(&self, _request: DetectRequest<'_>) -> KaifuuResult<DetectionResult> {
            Ok(DetectionResult {
                adapter_id: self.id().to_string(),
                detected: true,
                engine_family: Some("fixture".to_string()),
                engine_version: None,
                detected_variant: Some("preflight-boundary".to_string()),
                evidence: vec![],
                requirements: vec![],
                capabilities: self.capabilities().reports,
            })
        }

        fn profile(&self, _request: ProfileRequest<'_>) -> KaifuuResult<GameProfile> {
            Ok(golden_boundary_profile(self.id()))
        }

        fn list_assets(&self, _request: AssetListRequest<'_>) -> KaifuuResult<AssetList> {
            Ok(AssetList {
                adapter_id: self.id().to_string(),
                assets: vec![],
            })
        }

        fn asset_inventory(
            &self,
            _request: AssetInventoryRequest<'_>,
        ) -> KaifuuResult<AssetInventoryManifest> {
            Err("asset inventory is not used by golden preflight tests".into())
        }

        fn extract(&self, _request: ExtractRequest<'_>) -> KaifuuResult<ExtractionResult> {
            Ok(golden_boundary_extraction(self.id()))
        }

        fn patch_preflight(&self, request: PatchPreflightRequest<'_>) -> KaifuuResult<PatchResult> {
            let call = self.preflight_calls.fetch_add(1, Ordering::SeqCst) + 1;
            if call == self.block_on_preflight_call {
                Ok(self.preflight_failure(request.patch_export))
            } else {
                Ok(PatchResult::preflight_pass(request.patch_export))
            }
        }

        fn patch(&self, request: PatchRequest<'_>) -> KaifuuResult<PatchResult> {
            self.patch_calls.fetch_add(1, Ordering::SeqCst);
            fs::write(request.output_dir.join("source.json"), "{}\n")?;
            Ok(PatchResult {
                schema_version: PROFILE_SCHEMA_VERSION.to_string(),
                patch_result_id: deterministic_id("patch-result", 91),
                patch_export_id: request.patch_export.patch_export_id.clone(),
                status: OperationStatus::Passed,
                output_hash: content_hash("patched"),
                failures: vec![],
            })
        }

        fn verify(&self, _request: VerifyRequest<'_>) -> KaifuuResult<VerificationResult> {
            Ok(VerificationResult {
                schema_version: PROFILE_SCHEMA_VERSION.to_string(),
                patch_result_id: deterministic_id("verify", 91),
                status: OperationStatus::Passed,
                output_hash: content_hash("verified"),
                failures: vec![],
            })
        }
    }

    #[test]
    fn archive_detection_matrix_reports_requested_engine_families() {
        let root = temp_dir("archive-matrix-families");
        write_fixture_file(
            &root,
            "private-spoiler-route-name.xp3",
            b"XP3\r\nKAIFUU-XP3-ENCRYPTED",
        );
        write_fixture_file(&root, "Scene.pck", b"siglus scene package");
        write_fixture_file(&root, "Gameexe.dat", b"siglus metadata");
        write_fixture_file(
            &root,
            "www/data/System.json",
            br#"{
  "hasEncryptedImages": true,
  "hasEncryptedAudio": true,
  "encryptionKey": "00112233445566778899aabbccddeeff"
}"#,
        );
        write_fixture_file(&root, "img/pictures/title.rpgmvp", b"rpgmvp synthetic");
        write_fixture_file(&root, "img/pictures/title.png_", b"mz image synthetic");
        write_fixture_file(&root, "audio/bgm/theme.m4a_", b"mz audio synthetic");
        write_fixture_file(&root, "audio/se/cursor.ogg_", b"mz audio synthetic");
        write_fixture_file(
            &root,
            "Data.wolf",
            b"WOLF RPG Editor synthetic WOLF-PROTECTED protection-key",
        );
        write_fixture_file(&root, "pack.arc", b"BURIKO ARC20\0BGI-ENCRYPTED synthetic");
        write_fixture_file(&root, "game/archive.rpa", b"RenPy archive synthetic");
        write_fixture_file(&root, "game/script.rpyc", b"RenPy bytecode synthetic");
        write_fixture_file(&root, "mystery/private-route-name.pak", b"unknown archive");

        let report = ArchiveDetectionReport::scan(&root);

        assert_eq!(report.status, ArchiveDetectionStatus::Matched);
        assert_eq!(
            report
                .rows
                .iter()
                .map(|row| row.row_id.as_str())
                .collect::<Vec<_>>(),
            vec![
                "kirikiri-xp3",
                "siglus-scene-pck",
                "rpg-maker-mv-mz-encrypted-assets",
                "wolf-rpg-editor-archives",
                "bgi-ethornell-containers",
                "renpy-packed-inputs",
                "unknown-archive-variant",
            ]
        );

        let kirikiri = detected_archive_row(&report, "kirikiri-xp3");
        assert!(
            kirikiri
                .signals
                .contains(&ArchiveDetectionSignal::Encrypted)
        );
        assert!(kirikiri.diagnostics.iter().any(|diagnostic| {
            diagnostic.code == SemanticErrorCode::UnsupportedVariantEncrypted
        }));

        let siglus = detected_archive_row(&report, "siglus-scene-pck");
        assert!(siglus.signals.contains(&ArchiveDetectionSignal::MissingKey));
        assert!(
            siglus
                .diagnostics
                .iter()
                .any(|diagnostic| { diagnostic.code == SemanticErrorCode::HelperUnavailable })
        );

        let rpg_maker = detected_archive_row(&report, "rpg-maker-mv-mz-encrypted-assets");
        assert!(rpg_maker.evidence.iter().any(|evidence| {
            evidence.pattern == RPG_MAKER_MV_MZ_ENCRYPTED_SUFFIX_PATTERN
                && evidence.status == EvidenceStatus::Matched
                && evidence.count == 4
        }));
        assert!(rpg_maker.evidence.iter().any(|evidence| {
            evidence.pattern == "data/System.json encryption fields"
                && evidence.status == EvidenceStatus::Matched
                && evidence.count == 1
        }));

        let wolf = detected_archive_row(&report, "wolf-rpg-editor-archives");
        assert!(wolf.signals.contains(&ArchiveDetectionSignal::Protected));
        assert!(wolf.diagnostics.iter().any(|diagnostic| {
            diagnostic.code == SemanticErrorCode::ProtectedExecutableUnsupported
        }));

        let bgi = detected_archive_row(&report, "bgi-ethornell-containers");
        assert!(
            bgi.signals
                .contains(&ArchiveDetectionSignal::UnknownVariant)
        );
        assert!(
            bgi.diagnostics
                .iter()
                .any(|diagnostic| { diagnostic.code == SemanticErrorCode::UnknownEngineVariant })
        );

        let renpy = detected_archive_row(&report, "renpy-packed-inputs");
        assert!(
            renpy.diagnostics.iter().any(|diagnostic| {
                diagnostic.code == SemanticErrorCode::UnsupportedVariantPacked
            })
        );

        let unknown = detected_archive_row(&report, "unknown-archive-variant");
        assert!(
            unknown
                .signals
                .contains(&ArchiveDetectionSignal::UnknownVariant)
        );

        let serialized = serde_json::to_string(&report).unwrap();
        assert!(!serialized.contains("private-spoiler-route-name"));
        assert!(!serialized.contains("private-route-name"));
        assert!(!serialized.contains("00112233445566778899aabbccddeeff"));
        assert!(!serialized.contains("confidence"));
        assert!(serialized.contains("aggregate-only"));

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn rpg_maker_encrypted_suffix_detection_matrix_covers_mv_mz_suffixes() {
        let root = temp_dir("rpg-maker-suffix-matrix");
        for suffix in RPG_MAKER_MV_MZ_ENCRYPTED_SUFFIXES {
            write_fixture_file(
                &root,
                &format!("encrypted-assets/sample.{suffix}"),
                b"synthetic encrypted RPG Maker asset suffix fixture",
            );
        }

        let report = ArchiveDetectionReport::scan(&root);

        assert_eq!(report.status, ArchiveDetectionStatus::Matched);
        let rpg_maker = detected_archive_row(&report, "rpg-maker-mv-mz-encrypted-assets");
        assert_eq!(
            rpg_maker.signals,
            vec![
                ArchiveDetectionSignal::Encrypted,
                ArchiveDetectionSignal::MissingKey,
            ]
        );
        assert!(rpg_maker.evidence.iter().any(|evidence| {
            evidence.pattern == RPG_MAKER_MV_MZ_ENCRYPTED_SUFFIX_PATTERN
                && evidence.status == EvidenceStatus::Matched
                && evidence.count == RPG_MAKER_MV_MZ_ENCRYPTED_SUFFIXES.len() as u64
        }));
        assert!(rpg_maker.diagnostics.iter().any(|diagnostic| {
            diagnostic.code == SemanticErrorCode::UnsupportedVariantEncrypted
                && diagnostic.required_capability == Some(Capability::EncryptedInput)
        }));
        assert!(rpg_maker.diagnostics.iter().any(|diagnostic| {
            diagnostic.code == SemanticErrorCode::MissingKeyMaterial
                && diagnostic.required_capability == Some(Capability::KeyProfile)
        }));
        assert!(rpg_maker.capabilities.iter().any(|capability| {
            capability.capability == Capability::EncryptedInput
                && capability.status == CapabilityStatus::Unsupported
        }));
        assert!(rpg_maker.capabilities.iter().any(|capability| {
            capability.capability == Capability::KeyProfile
                && capability.status == CapabilityStatus::RequiresUserInput
        }));
        assert_eq!(rpg_maker.requirements.len(), 1);
        assert_eq!(rpg_maker.requirements[0].key, "rpg-maker-mv-mz-asset-key");

        let serialized = serde_json::to_string(&report).unwrap();
        assert!(!serialized.contains("sample.rpgmvp"));

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn archive_detection_normalizes_marker_only_subtypes_to_unknown_variant_diagnostics() {
        let root = temp_dir("archive-marker-only");
        let marker_only_fixtures: &[(&str, &[u8])] = &[
            (
                "notes/kaifuu-xp3-encrypted-marker.txt",
                b"synthetic kaifuu-xp3-encrypted marker",
            ),
            (
                "notes/xp3-encrypted-marker.txt",
                b"synthetic xp3-encrypted marker",
            ),
            ("notes/xp3-crypt-marker.txt", b"synthetic xp3-crypt marker"),
            ("notes/bgi-marker.txt", b"BGI-ENCRYPTED"),
            ("notes/ethornell-marker.txt", b"ethornell-encrypted"),
            ("notes/wolf-protected-marker.txt", b"wolf-protected"),
            ("notes/wolf-protection-key-marker.txt", b"protection-key"),
        ];
        for (relative_path, bytes) in marker_only_fixtures {
            write_fixture_file(&root, relative_path, bytes);
        }

        let report = ArchiveDetectionReport::scan(&root);

        assert_eq!(report.status, ArchiveDetectionStatus::Matched);
        for row_id in [
            "kirikiri-xp3",
            "bgi-ethornell-containers",
            "wolf-rpg-editor-archives",
        ] {
            let row = report
                .rows
                .iter()
                .find(|row| row.row_id == row_id)
                .unwrap_or_else(|| panic!("missing archive row {row_id}"));
            assert!(!row.detected, "{row_id} should not be family-detected");
            assert!(
                row.signals.is_empty(),
                "{row_id} leaked marker-only signals"
            );
            assert!(
                row.requirements.is_empty(),
                "{row_id} leaked marker-only key requirements"
            );
            assert!(
                row.diagnostics.is_empty(),
                "{row_id} leaked marker-only diagnostics"
            );
            assert!(!row.capabilities.iter().any(|capability| {
                capability.capability == Capability::EncryptedInput
                    || capability.capability == Capability::KeyProfile
            }));
        }

        let unknown = detected_archive_row(&report, "unknown-archive-variant");
        assert_eq!(
            unknown.signals,
            vec![ArchiveDetectionSignal::UnknownVariant]
        );
        assert!(unknown.evidence.iter().any(|evidence| {
            evidence.pattern == "orphaned encrypted/protected subtype marker"
                && evidence.status == EvidenceStatus::Matched
                && evidence.count == marker_only_fixtures.len() as u64
        }));
        assert!(unknown.diagnostics.iter().any(|diagnostic| {
            diagnostic.code == SemanticErrorCode::UnknownEngineVariant
                && diagnostic.required_capability == Some(Capability::Detection)
        }));

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn archive_detection_preserves_wolf_match_with_primary_evidence() {
        let root = temp_dir("wolf-primary-evidence");
        write_fixture_file(
            &root,
            "notes/wolf-header.txt",
            b"WOLF RPG Editor synthetic wolf-protected protection-key marker",
        );
        write_fixture_file(
            &root,
            "Data.wolf",
            b"synthetic protected archive marker without textual header",
        );

        let report = ArchiveDetectionReport::scan(&root);

        assert_eq!(report.status, ArchiveDetectionStatus::Matched);
        let wolf = detected_archive_row(&report, "wolf-rpg-editor-archives");
        assert_eq!(wolf.detected_variant, "wolf-protected-archive");
        assert!(wolf.signals.contains(&ArchiveDetectionSignal::Packed));
        assert!(wolf.signals.contains(&ArchiveDetectionSignal::Encrypted));
        assert!(wolf.signals.contains(&ArchiveDetectionSignal::Protected));
        assert!(wolf.evidence.iter().any(|evidence| {
            evidence.pattern == "*.wolf"
                && evidence.status == EvidenceStatus::Matched
                && evidence.count == 1
        }));
        assert!(wolf.evidence.iter().any(|evidence| {
            evidence.pattern == "WOLF header"
                && evidence.status == EvidenceStatus::Matched
                && evidence.count == 1
        }));
        assert!(wolf.evidence.iter().any(|evidence| {
            evidence.pattern == "Wolf protection marker"
                && evidence.status == EvidenceStatus::Matched
                && evidence.count == 2
        }));
        assert_eq!(wolf.requirements.len(), 1);
        assert_eq!(wolf.requirements[0].key, "wolf-rpg-editor-archive-key");

        let unknown = report
            .rows
            .iter()
            .find(|row| row.row_id == "unknown-archive-variant")
            .unwrap();
        assert!(!unknown.detected);
        assert!(unknown.evidence.iter().any(|evidence| {
            evidence.pattern == "orphaned encrypted/protected subtype marker"
                && evidence.status == EvidenceStatus::Missing
                && evidence.count == 0
        }));

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn detection_report_status_matches_archive_only_inputs_without_adapter_claims() {
        let root = temp_dir("archive-only-detection-report");
        write_fixture_file(&root, "game/scripts.rpa", b"RenPy archive synthetic");
        let report = DetectionReport::from_results(
            &root,
            vec![DetectionResult {
                adapter_id: "kaifuu.fixture".to_string(),
                detected: false,
                engine_family: None,
                engine_version: None,
                detected_variant: None,
                evidence: vec![],
                requirements: vec![],
                capabilities: vec![],
            }],
        );

        assert_eq!(report.status, DetectionReportStatus::Unknown);
        assert_eq!(
            report.archive_detection.status,
            ArchiveDetectionStatus::Matched
        );
        assert!(
            report
                .warnings
                .iter()
                .any(|warning| { warning.contains("no registered extraction adapter") })
        );
        let renpy = detected_archive_row(&report.archive_detection, "renpy-packed-inputs");
        assert!(renpy.capabilities.iter().any(|capability| {
            capability.capability == Capability::Extraction
                && capability.status == CapabilityStatus::Unsupported
        }));

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn detection_report_redacts_absolute_game_dir_and_private_title() {
        let root = temp_dir("private-detection-report");
        let game_dir = root.join("Private Route Spoiler Game");
        fs::create_dir_all(&game_dir).unwrap();
        write_fixture_file(&game_dir, "img/pictures/spoiler-title.png_", b"encrypted");
        let report = DetectionReport::from_results(
            &game_dir,
            vec![DetectionResult {
                adapter_id: "kaifuu.fixture".to_string(),
                detected: false,
                engine_family: None,
                engine_version: None,
                detected_variant: None,
                evidence: vec![],
                requirements: vec![],
                capabilities: vec![],
            }],
        );

        assert_eq!(report.game_dir, REDACTED_DETECTION_GAME_DIR);
        let serialized = serde_json::to_string(&report).unwrap();
        assert!(!serialized.contains(&game_dir.display().to_string()));
        assert!(!serialized.contains("Private Route Spoiler Game"));
        assert!(!serialized.contains("spoiler-title"));
        let rpg_maker = detected_archive_row(
            &report.archive_detection,
            "rpg-maker-mv-mz-encrypted-assets",
        );
        assert!(rpg_maker.evidence.iter().any(|evidence| {
            evidence.pattern == RPG_MAKER_MV_MZ_ENCRYPTED_SUFFIX_PATTERN
                && evidence.status == EvidenceStatus::Matched
                && evidence.count == 1
        }));

        let _ = fs::remove_dir_all(root);
    }

    const UNSAFE_RELATIVE_PATH_FIXTURES: &[(&str, &str)] = &[
        ("empty", ""),
        ("absolute slash", "/source.json"),
        ("absolute backslash", "\\source.json"),
        ("drive absolute slash", "C:/source.json"),
        ("drive absolute backslash", "C:\\source.json"),
        ("drive relative upper", "C:source.json"),
        ("drive relative lower", "c:source.json"),
        ("drive prefix component slash", "data/C:source.json"),
        ("drive prefix component backslash", "data\\C:source.json"),
        ("dot only", "."),
        ("leading dot slash", "./source.json"),
        ("leading dot backslash", ".\\source.json"),
        ("dot component slash", "data/./source.json"),
        ("dot component backslash", "data\\.\\source.json"),
        ("trailing dot component", "data/."),
        ("parent leading slash", "../source.json"),
        ("parent leading backslash", "..\\source.json"),
        ("parent component slash", "data/../source.json"),
        ("parent component backslash", "data\\..\\source.json"),
        ("empty component slash", "data//source.json"),
        ("empty component backslash", "data\\\\source.json"),
        ("nul byte", "source.json\0suffix"),
    ];

    fn profile_with_asset_path(path: &str) -> Value {
        serde_json::json!({
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
                    "path": path,
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
        })
    }

    #[test]
    fn safe_relative_path_validator_and_join_share_negative_matrix() {
        let root = Path::new("patched-game");
        let safe = safe_join_relative(root, "data/source.json").unwrap();
        assert_eq!(safe, root.join("data").join("source.json"));
        assert!(validate_safe_relative_path("data/source.json").is_ok());

        for (case, unsafe_path) in UNSAFE_RELATIVE_PATH_FIXTURES {
            assert!(
                validate_safe_relative_path(unsafe_path).is_err(),
                "{case}: {unsafe_path:?} should be rejected by shared validation"
            );
            assert!(
                safe_join_relative(root, unsafe_path).is_err(),
                "{case}: {unsafe_path:?} should be rejected by safe_join_relative"
            );
        }
    }

    #[test]
    fn profile_validation_uses_shared_relative_path_negative_matrix() {
        for (case, unsafe_path) in UNSAFE_RELATIVE_PATH_FIXTURES {
            let profile = profile_with_asset_path(unsafe_path);
            let validation = validate_profile_value(&profile);

            assert_eq!(
                validation.status,
                OperationStatus::Failed,
                "{case}: {unsafe_path:?} should fail profile validation"
            );
            if unsafe_path.is_empty() {
                assert!(
                    validation.failures.iter().any(|failure| {
                        failure.code == "missing_required_field" && failure.field == "assets.0.path"
                    }),
                    "{case}: empty path should be rejected as a missing required field, got {:?}",
                    validation.failures
                );
            } else {
                assert!(
                    validation.failures.iter().any(|failure| {
                        failure.code == "invalid_asset_path" && failure.field == "assets.0.path"
                    }),
                    "{case}: {unsafe_path:?} should be rejected as invalid asset path, got {:?}",
                    validation.failures
                );
            }
        }
    }

    const ALL_LETTER_RAW_KEY_MATERIAL: &str = "XqQbHYcPLaMRvTEsJZoWknNd";

    fn valid_key_profile_value() -> Value {
        serde_json::json!({
            "schemaVersion": PROFILE_SCHEMA_VERSION,
            "profileId": deterministic_id("profile", 14),
            "gameId": "siglus-owned-local",
            "title": "Siglus Owned Local",
            "sourceLocale": "ja-JP",
            "engine": {
                "adapterId": "kaifuu.siglus",
                "engineFamily": "siglus",
                "engineVersion": null,
                "detectedVariant": "scene-pck-secondary-key"
            },
            "sourceFingerprint": {
                "gameRootHash": "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                "engineEvidence": ["Scene.pck", "Gameexe.dat"]
            },
            "keyRequirements": [
                {
                    "requirementId": "siglus-secondary-key",
                    "secretRef": "local-secret:siglus/example/secondary-key",
                    "kind": "fixedBytes",
                    "bytes": 16,
                    "validation": {
                        "method": "decryptHeaderProof",
                        "proofHash": "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
                    }
                }
            ],
            "archiveParameters": [
                {
                    "parameterId": "scene-archive",
                    "name": "sceneArchive",
                    "kind": "archiveFormat",
                    "value": "Scene.pck",
                    "source": "detected"
                }
            ],
            "helperEvidence": {
                "helperKind": "staticParser",
                "toolVersion": "kaifuu-key-helper/0.1.0",
                "redactedLogHash": "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
                "proofHashes": [
                    {
                        "method": "decryptHeaderProof",
                        "proofHash": "sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd"
                    }
                ]
            },
            "assets": [
                {
                    "assetId": deterministic_id("asset", 14),
                    "path": "Scene.pck",
                    "assetKind": "archive",
                    "textSurfaces": ["dialogue"],
                    "sourceHash": "sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
                    "patching": {
                        "capability": "patching",
                        "status": "limited",
                        "limitation": "requires caller-provided resolved keys and archive parameters"
                    }
                }
            ],
            "capabilities": [
                {
                    "capability": "key_profile",
                    "status": "supported",
                    "limitation": null
                },
                {
                    "capability": "patching",
                    "status": "limited",
                    "limitation": "requires caller-provided resolved keys and archive parameters"
                }
            ],
            "requirements": [
                {
                    "category": "secret_key",
                    "key": "siglus-secondary-key",
                    "status": "satisfied",
                    "description": "secondary key is referenced through local secret storage",
                    "placeholder": null,
                    "secret": true
                }
            ],
            "metadata": {}
        })
    }

    #[test]
    fn profile_validation_accepts_key_profile_secret_refs_and_proofs() {
        let profile = valid_key_profile_value();

        let validation = validate_profile_value(&profile);

        assert_eq!(validation.status, OperationStatus::Passed);
        let profile: GameProfile = serde_json::from_value(profile).unwrap();
        assert_eq!(profile.key_requirements.len(), 1);
        assert_eq!(
            profile.key_requirements[0].secret_ref.as_str(),
            "local-secret:siglus/example/secondary-key"
        );
        assert_eq!(
            profile.helper_evidence.unwrap().redacted_log_hash.as_str(),
            "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"
        );
    }

    #[test]
    fn profile_validation_requires_matching_key_requirement_ids() {
        let mut profile = valid_key_profile_value();
        profile["keyRequirements"][0]["requirementId"] = serde_json::json!("siglus-unrelated-key");

        let validation = validate_profile_value(&profile);

        assert_eq!(validation.status, OperationStatus::Failed);
        assert!(
            validation.failures.iter().any(|failure| {
                failure.code == SEMANTIC_MISSING_KEY_PROFILE
                    && failure.field == "keyRequirements"
                    && failure.message.contains("siglus-secondary-key")
            }),
            "missing strict key requirement match failure: {:#?}",
            validation.failures
        );
    }

    #[test]
    fn profile_validation_rejects_base64url_raw_secret_refs() {
        let mut profile = valid_key_profile_value();
        let raw_base64url = "local-secret:mP9xZpQ2rS7vLj4N8aW_KtYd0hF3uC6b";
        profile["keyRequirements"][0]["secretRef"] = serde_json::json!(raw_base64url);

        let validation = validate_profile_value(&profile);

        assert_eq!(validation.status, OperationStatus::Failed);
        assert!(
            validation.failures.iter().any(|failure| {
                failure.code == "invalid_secret_ref"
                    && failure.field == "keyRequirements.0.secretRef"
            }),
            "missing raw secretRef failure: {:#?}",
            validation.failures
        );
        assert!(SecretRef::new("local-secret:siglus-primary-key").is_ok());
    }

    #[test]
    fn profile_validation_rejects_all_letter_base64url_raw_secret_refs() {
        let mut profile = valid_key_profile_value();
        profile["keyRequirements"][0]["secretRef"] =
            serde_json::json!(format!("local-secret:{ALL_LETTER_RAW_KEY_MATERIAL}"));

        let validation = validate_profile_value(&profile);

        assert_eq!(validation.status, OperationStatus::Failed);
        assert!(
            validation.failures.iter().any(|failure| {
                failure.code == "invalid_secret_ref"
                    && failure.field == "keyRequirements.0.secretRef"
            }),
            "missing all-letter raw secretRef failure: {:#?}",
            validation.failures
        );
        assert!(SecretRef::new("local-secret:siglus-primary-key").is_ok());
        assert!(SecretRef::new("local-secret:rpgmaker-mv-key").is_ok());
    }

    #[test]
    fn profile_validation_rejects_raw_archive_parameter_key_values() {
        let mut profile = valid_key_profile_value();
        let raw_base64url = "mP9xZpQ2rS7vLj4N8aW_KtYd0hF3uC6b";
        profile["archiveParameters"][0]["name"] = serde_json::json!("cipherKey");
        profile["archiveParameters"][0]["kind"] = serde_json::json!("cipherScheme");
        profile["archiveParameters"][0]["value"] = serde_json::json!(raw_base64url);

        let validation = validate_profile_value(&profile);

        assert_eq!(validation.status, OperationStatus::Failed);
        assert!(
            validation.failures.iter().any(|failure| {
                failure.code == SEMANTIC_SECRET_REDACTED
                    && failure.field == "archiveParameters.0.value"
            }),
            "missing raw archive parameter redaction failure: {:#?}",
            validation.failures
        );

        let redacted = redact_secret_bearing_value(&profile);
        assert_eq!(
            redacted.value["archiveParameters"][0]["value"],
            format!("[REDACTED:{}]", SEMANTIC_SECRET_REDACTED)
        );
        assert!(
            !serde_json::to_string(&redacted.value)
                .unwrap()
                .contains(raw_base64url)
        );
    }

    #[test]
    fn profile_validation_rejects_all_letter_raw_archive_parameter_key_values() {
        for parameter_name in ["archiveKey", "cipherMaterial", "secretMaterial"] {
            let mut profile = valid_key_profile_value();
            profile["archiveParameters"][0]["name"] = serde_json::json!(parameter_name);
            profile["archiveParameters"][0]["kind"] = serde_json::json!("cipherScheme");
            profile["archiveParameters"][0]["value"] =
                serde_json::json!(ALL_LETTER_RAW_KEY_MATERIAL);
            profile["archiveParameters"][0]["source"] = serde_json::json!("manual");

            let validation = validate_profile_value(&profile);

            assert_eq!(validation.status, OperationStatus::Failed);
            assert!(
                validation.failures.iter().any(|failure| {
                    failure.code == SEMANTIC_SECRET_REDACTED
                        && failure.field == "archiveParameters.0.value"
                }),
                "missing all-letter raw archive parameter redaction failure for {parameter_name}: {:#?}",
                validation.failures
            );

            let redacted = redact_secret_bearing_value(&profile);
            assert_eq!(
                redacted.value["archiveParameters"][0]["value"],
                format!("[REDACTED:{}]", SEMANTIC_SECRET_REDACTED)
            );
            assert!(
                !serde_json::to_string(&redacted.value)
                    .unwrap()
                    .contains(ALL_LETTER_RAW_KEY_MATERIAL)
            );
        }
    }

    #[test]
    fn profile_validation_rejects_raw_key_material_and_private_evidence() {
        let mut profile = valid_key_profile_value();
        profile["keyRequirements"][0]["rawKey"] =
            serde_json::json!("00112233445566778899aabbccddeeff");
        profile["helperEvidence"]["helperDump"] = serde_json::json!("register dump with key bytes");
        profile["metadata"]["localPath"] = serde_json::json!("/home/dev/private-game");
        profile["metadata"]["decryptedText"] = serde_json::json!("private translated script line");

        let validation = validate_profile_value(&profile);

        assert_eq!(validation.status, OperationStatus::Failed);
        for field in [
            "keyRequirements.0.rawKey",
            "helperEvidence.helperDump",
            "metadata.localPath",
            "metadata.decryptedText",
        ] {
            assert!(
                validation.failures.iter().any(|failure| {
                    failure.code == SEMANTIC_SECRET_REDACTED && failure.field == field
                }),
                "missing redaction failure for {field}: {:#?}",
                validation.failures
            );
        }

        let redacted = redact_secret_bearing_value(&profile);
        assert_eq!(
            redacted.value["keyRequirements"][0]["secretRef"],
            "local-secret:siglus/example/secondary-key"
        );
        let serialized = serde_json::to_string(&redacted.value).unwrap();
        assert!(!serialized.contains("00112233445566778899aabbccddeeff"));
        assert!(!serialized.contains("/home/dev/private-game"));
        assert!(!serialized.contains("private translated script line"));
    }

    #[test]
    fn profile_validation_scans_requirement_and_capability_free_text_fields() {
        let mut profile = valid_key_profile_value();
        profile["requirements"][0]["status"] = serde_json::json!("missing");
        profile["requirements"][0]["description"] = serde_json::json!(
            "helper dump source:/home/dev/game/private-route-ending.ks included raw key 00112233445566778899aabbccddeeff"
        );
        profile["requirements"][0]["placeholder"] =
            serde_json::json!("file=C:\\Games\\SecretRoute\\key.bin");
        profile["capabilities"][1]["limitation"] =
            serde_json::json!("decrypted text from private-route-ending.ks requires local review");

        let validation = validate_profile_value(&profile);

        assert_eq!(validation.status, OperationStatus::Failed);
        for field in [
            "requirements.0.description",
            "requirements.0.placeholder",
            "capabilities.1.limitation",
        ] {
            assert!(
                validation.failures.iter().any(|failure| {
                    failure.code == SEMANTIC_SECRET_REDACTED && failure.field == field
                }),
                "missing free-text redaction failure for {field}: {:#?}",
                validation.failures
            );
        }

        let redacted = validation.redacted_for_report();
        let serialized = serde_json::to_string(&redacted).unwrap();
        assert!(!serialized.contains("/home/dev/game"));
        assert!(!serialized.contains("C:\\Games"));
        assert!(!serialized.contains("helper dump"));
        assert!(!serialized.contains("decrypted text"));
        assert!(!serialized.contains("00112233445566778899aabbccddeeff"));
        assert!(!serialized.contains("private-route-ending.ks"));
    }

    #[test]
    fn log_report_redaction_catches_embedded_local_path_formats() {
        for text in [
            "helper failed path=/home/dev/game",
            "helper failed source:/home/dev/game",
            "helper failed file=C:\\Games\\SecretRoute\\game.exe",
            "helper failed path=~/games/private/key.bin",
            "helper failed path=$HOME/games/key.bin",
            "helper failed path=%USERPROFILE%\\Games\\key.bin",
        ] {
            let redacted = redact_for_log_or_report(text);
            assert_eq!(
                redacted,
                format!("[REDACTED:{}]", SEMANTIC_SECRET_REDACTED),
                "{text} should be redacted"
            );
        }
    }

    #[test]
    fn report_value_redaction_covers_secret_keys_paths_and_nested_payload_text() {
        let value = serde_json::json!({
            "adapterId": "kaifuu.fixture",
            "rawKey": "actual-secret",
            "metadata": {
                "localPath": "~/Private Route Spoiler Game",
                "safeRelativePath": "scripts/common.ks",
                "diagnostic": "source=$HOME/games/private-key.bin"
            },
            "failures": [
                {
                    "message": "decrypted text included 00112233445566778899aabbccddeeff",
                    "assetRef": "%USERPROFILE%\\Games\\private-key.bin"
                }
            ]
        });

        let redacted = redact_report_value(&value);
        let serialized = serde_json::to_string(&redacted).unwrap();

        assert_eq!(redacted["adapterId"], "kaifuu.fixture");
        assert_eq!(
            redacted["metadata"]["safeRelativePath"],
            "scripts/common.ks"
        );
        assert!(serialized.contains(SEMANTIC_SECRET_REDACTED));
        for forbidden in [
            "actual-secret",
            "~/Private Route Spoiler Game",
            "$HOME/games",
            "%USERPROFILE%",
            "Private Route Spoiler Game",
            "private-key.bin",
            "decrypted text",
            "00112233445566778899aabbccddeeff",
        ] {
            assert!(
                !serialized.contains(forbidden),
                "redacted report value leaked {forbidden}: {serialized}"
            );
        }
    }

    #[test]
    fn patch_and_verify_report_redaction_covers_hostile_top_level_fields() {
        let raw_key = "00112233445566778899aabbccddeeff";
        let patch_result = PatchResult {
            schema_version: PROFILE_SCHEMA_VERSION.to_string(),
            patch_result_id: "patch-result=/home/dev/game/private-route-ending.ks".to_string(),
            patch_export_id: format!("patch-export helper dump raw key {raw_key}"),
            status: OperationStatus::Failed,
            output_hash: "C:\\Games\\SecretRoute\\private-route-ending.ks".to_string(),
            failures: vec![AdapterFailure::secret_redacted(
                "kaifuu.fixture",
                "fixture",
                "private-route",
                "private-route-ending.ks",
                format!(
                    "helper dump source:/home/dev/game/private-route-ending.ks raw key {raw_key}"
                ),
            )],
        };
        let verify_result = VerificationResult {
            schema_version: PROFILE_SCHEMA_VERSION.to_string(),
            patch_result_id: "verify-result=/home/dev/game/private-route-ending.ks".to_string(),
            status: OperationStatus::Failed,
            output_hash: format!("helper dump outputHash {raw_key}"),
            failures: vec![AdapterFailure::helper_unavailable(
                "kaifuu.fixture",
                "fixture",
                "private-route",
                "helper unavailable for C:\\Games\\SecretRoute\\private-route-ending.ks",
            )],
        };

        let patch_serialized = serde_json::to_string(&patch_result.redacted_for_report()).unwrap();
        let verify_serialized =
            serde_json::to_string(&verify_result.redacted_for_report()).unwrap();

        for serialized in [&patch_serialized, &verify_serialized] {
            assert!(serialized.contains(SEMANTIC_SECRET_REDACTED));
            for forbidden in [
                "/home/dev/game",
                "C:\\Games",
                "SecretRoute",
                "helper dump",
                raw_key,
                "private-route-ending.ks",
            ] {
                assert!(
                    !serialized.contains(forbidden),
                    "report leaked {forbidden}: {serialized}"
                );
            }
        }
    }

    #[test]
    fn profile_validation_accepts_layered_capability_variants() {
        let mut profile = valid_key_profile_value();
        let capabilities = profile["capabilities"].as_array_mut().unwrap();
        for capability in [
            "container_access",
            "crypto_access",
            "codec_access",
            "patch_back",
        ] {
            capabilities.push(serde_json::json!({
                "capability": capability,
                "status": "requires_user_input",
                "limitation": "requires local layered access support"
            }));
        }

        let validation = validate_profile_value(&profile);

        assert_eq!(validation.status, OperationStatus::Passed);
    }

    #[test]
    fn golden_unchanged_patch_preflight_redaction_blocks_before_work_dir_prepare() {
        let game_dir = temp_dir("golden-unchanged-preflight-game");
        let work_dir = temp_dir("golden-unchanged-preflight-work");
        let sentinel = work_dir.join("unchanged-patch").join("sentinel.txt");
        fs::create_dir_all(sentinel.parent().unwrap()).unwrap();
        fs::write(&sentinel, "keep").unwrap();

        let preflight_calls = Arc::new(AtomicUsize::new(0));
        let patch_calls = Arc::new(AtomicUsize::new(0));
        let mut registry = AdapterRegistry::new();
        registry.register(GoldenPreflightBoundaryAdapter {
            block_on_preflight_call: 1,
            preflight_calls: Arc::clone(&preflight_calls),
            patch_calls: Arc::clone(&patch_calls),
        });

        let report = run_round_trip_golden(
            &registry,
            GoldenHarnessRequest {
                game_dir: &game_dir,
                work_dir: &work_dir,
                adapter_id: Some("kaifuu.golden-preflight-boundary"),
                byte_equivalence: GoldenByteEquivalenceMode::Unsupported {
                    support_boundary: "byte identity is outside this preflight test".to_string(),
                },
                translated_patch_export: None,
                translated_source_bridge: None,
            },
        )
        .unwrap();

        assert_eq!(report.status, OperationStatus::Failed);
        assert_eq!(preflight_calls.load(Ordering::SeqCst), 1);
        assert_eq!(patch_calls.load(Ordering::SeqCst), 0);
        assert!(
            sentinel.exists(),
            "unchanged work dir should not be removed before preflight"
        );
        assert!(report.failures.iter().any(|failure| {
            failure.phase == "unchanged_patch"
                && failure.code == SEMANTIC_MISSING_CONTAINER_CAPABILITY
        }));
        let serialized = report.stable_json().unwrap();
        for forbidden in [
            "$HOME",
            "%USERPROFILE%",
            "~/",
            "Private Route Spoiler Game",
            "private-route-name",
            "Scene.pck",
            "helper dump",
            "00112233445566778899aabbccddeeff",
        ] {
            assert!(
                !serialized.contains(forbidden),
                "golden report leaked {forbidden}: {serialized}"
            );
        }
    }

    #[test]
    fn golden_translated_patch_preflight_blocks_before_work_dir_prepare() {
        let game_dir = temp_dir("golden-translated-preflight-game");
        let work_dir = temp_dir("golden-translated-preflight-work");
        let sentinel = work_dir.join("translated-patch").join("sentinel.txt");
        fs::create_dir_all(sentinel.parent().unwrap()).unwrap();
        fs::write(&sentinel, "keep").unwrap();

        let preflight_calls = Arc::new(AtomicUsize::new(0));
        let patch_calls = Arc::new(AtomicUsize::new(0));
        let mut registry = AdapterRegistry::new();
        registry.register(GoldenPreflightBoundaryAdapter {
            block_on_preflight_call: 2,
            preflight_calls: Arc::clone(&preflight_calls),
            patch_calls: Arc::clone(&patch_calls),
        });
        let translated_patch =
            serde_json::to_value(golden_boundary_patch_export("translated-patch-1")).unwrap();

        let report = run_round_trip_golden(
            &registry,
            GoldenHarnessRequest {
                game_dir: &game_dir,
                work_dir: &work_dir,
                adapter_id: Some("kaifuu.golden-preflight-boundary"),
                byte_equivalence: GoldenByteEquivalenceMode::Unsupported {
                    support_boundary: "byte identity is outside this preflight test".to_string(),
                },
                translated_patch_export: Some(&translated_patch),
                translated_source_bridge: None,
            },
        )
        .unwrap();

        assert_eq!(report.status, OperationStatus::Failed);
        assert_eq!(preflight_calls.load(Ordering::SeqCst), 2);
        assert_eq!(patch_calls.load(Ordering::SeqCst), 1);
        assert!(
            sentinel.exists(),
            "translated work dir should not be removed before preflight"
        );
        assert!(report.failures.iter().any(|failure| {
            failure.phase == "translated_patch"
                && failure.code == SEMANTIC_MISSING_CONTAINER_CAPABILITY
        }));
    }

    #[test]
    fn missing_secret_requirements_emit_key_profile_semantic_errors() {
        let mut profile = valid_key_profile_value();
        profile.as_object_mut().unwrap().remove("keyRequirements");
        profile["requirements"][0]["status"] = serde_json::json!("missing");
        profile["requirements"][0]["placeholder"] = serde_json::json!("KAIFUU_SIGLUS_KEY");

        let validation = validate_profile_value(&profile);

        assert_eq!(validation.status, OperationStatus::Failed);
        for expected_code in [SEMANTIC_MISSING_KEY_MATERIAL, SEMANTIC_MISSING_KEY_PROFILE] {
            assert!(
                validation
                    .failures
                    .iter()
                    .any(|failure| failure.code == expected_code),
                "missing {expected_code}: {:#?}",
                validation.failures
            );
        }
    }

    #[test]
    fn adapter_key_declarations_serialize_stable_semantic_errors() {
        let capabilities = AdapterCapabilities::new(
            "kaifuu.siglus",
            vec![
                CapabilityReport::requires_user_input(
                    Capability::KeyProfile,
                    "requires local-only key profile secret refs",
                ),
                CapabilityReport::requires_user_input(
                    Capability::EncryptedInput,
                    "requires caller-provided resolved keys",
                ),
            ],
        )
        .with_key_requirements(vec![AdapterKeyRequirementDeclaration {
            requirement_id: "siglus-secondary-key".to_string(),
            engine_family: "siglus".to_string(),
            material_kind: KeyMaterialKind::FixedBytes,
            bytes: Some(16),
            archive_parameters: vec![ArchiveParameterDeclaration {
                parameter_id: "scene-archive".to_string(),
                name: "sceneArchive".to_string(),
                kind: ArchiveParameterKind::ArchiveFormat,
                required: true,
            }],
            validation: AdapterKeyValidationDeclaration {
                method: KeyValidationMethod::DecryptHeaderProof,
                proof_required: true,
            },
            semantic_errors: vec![
                SemanticErrorCode::MissingKeyProfile,
                SemanticErrorCode::MissingKeyMaterial,
                SemanticErrorCode::HelperUnavailable,
                SemanticErrorCode::KeyValidationFailed,
                SemanticErrorCode::SecretRedacted,
                SemanticErrorCode::ProtectedExecutableUnsupported,
                SemanticErrorCode::UnsupportedLayeredTransform,
                SemanticErrorCode::MissingContainerCapability,
                SemanticErrorCode::MissingCryptoCapability,
                SemanticErrorCode::MissingCodecCapability,
                SemanticErrorCode::MissingPatchBackCapability,
                SemanticErrorCode::UnsupportedVariantEncrypted,
            ],
        }]);

        let value = serde_json::to_value(capabilities).unwrap();

        assert_eq!(
            value["keyRequirements"][0]["semanticErrors"],
            serde_json::json!([
                "kaifuu.missing_capability.key_profile",
                "kaifuu.missing_key_material",
                "kaifuu.helper_unavailable",
                "kaifuu.key_validation_failed",
                "kaifuu.secret_redacted",
                "kaifuu.protected_executable_unsupported",
                "kaifuu.unsupported_layered_transform",
                "kaifuu.missing_capability.container",
                "kaifuu.missing_capability.crypto",
                "kaifuu.missing_capability.codec",
                "kaifuu.missing_capability.patch_back",
                "kaifuu.unsupported_variant.encrypted"
            ])
        );
    }

    #[test]
    fn adapter_capabilities_redacts_key_requirement_declaration_strings() {
        let capabilities = AdapterCapabilities::new(
            "kaifuu.path=/home/dev/game/private-route-ending.ks",
            vec![CapabilityReport::requires_user_input(
                Capability::KeyProfile,
                "helper dump source:/home/dev/game/private-route-ending.ks exposed raw key 00112233445566778899aabbccddeeff",
            )],
        )
        .with_key_requirements(vec![AdapterKeyRequirementDeclaration {
            requirement_id:
                "source:/home/dev/game/private-route-ending.ks:00112233445566778899aabbccddeeff"
                    .to_string(),
            engine_family: "helper dump C:\\Games\\SecretRoute\\engine.exe".to_string(),
            material_kind: KeyMaterialKind::FixedBytes,
            bytes: Some(16),
            archive_parameters: vec![ArchiveParameterDeclaration {
                parameter_id: "file=C:\\Games\\SecretRoute\\Scene.pck".to_string(),
                name: "private-route-ending.ks".to_string(),
                kind: ArchiveParameterKind::ArchiveFormat,
                required: true,
            }],
            validation: AdapterKeyValidationDeclaration {
                method: KeyValidationMethod::DecryptHeaderProof,
                proof_required: true,
            },
            semantic_errors: vec![SemanticErrorCode::SecretRedacted],
        }]);

        let redacted = capabilities.redacted_for_report();
        let serialized = serde_json::to_string(&redacted).unwrap();

        assert!(serialized.contains(SEMANTIC_SECRET_REDACTED));
        assert_eq!(
            redacted.key_requirements[0].material_kind,
            KeyMaterialKind::FixedBytes
        );
        assert_eq!(redacted.key_requirements[0].bytes, Some(16));
        assert_eq!(
            redacted.key_requirements[0].validation.method,
            KeyValidationMethod::DecryptHeaderProof
        );
        assert_eq!(
            redacted.key_requirements[0].semantic_errors,
            vec![SemanticErrorCode::SecretRedacted]
        );
        for forbidden in [
            "/home/dev/game",
            "C:\\Games",
            "helper dump",
            "00112233445566778899aabbccddeeff",
            "private-route-ending.ks",
            "SecretRoute",
        ] {
            assert!(
                !serialized.contains(forbidden),
                "capabilities leaked {forbidden}"
            );
        }
    }

    #[test]
    fn adapter_failure_constructors_use_key_boundary_codes() {
        assert_eq!(
            AdapterFailure::missing_key_profile(
                "kaifuu.siglus",
                "siglus",
                "scene-pck-secondary-key",
                "pure adapters require a key profile before encrypted extraction"
            )
            .error_code,
            SEMANTIC_MISSING_KEY_PROFILE
        );
        assert_eq!(
            AdapterFailure::missing_key_material(
                "kaifuu.siglus",
                "siglus",
                "scene-pck-secondary-key",
                "siglus-secondary-key",
                "local secret storage did not resolve the referenced key"
            )
            .error_code,
            SEMANTIC_MISSING_KEY_MATERIAL
        );
        assert_eq!(
            AdapterFailure::helper_unavailable(
                "kaifuu.siglus",
                "siglus",
                "scene-pck-secondary-key",
                "helper execution is outside the pure adapter"
            )
            .error_code,
            SEMANTIC_HELPER_UNAVAILABLE
        );
        assert_eq!(
            AdapterFailure::key_validation_failed(
                "kaifuu.siglus",
                "siglus",
                "scene-pck-secondary-key",
                "siglus-secondary-key",
                "proof hash did not match local asset validation"
            )
            .error_code,
            SEMANTIC_KEY_VALIDATION_FAILED
        );
        assert_eq!(
            AdapterFailure::protected_executable_unsupported(
                "kaifuu.kirikiri",
                "kirikiri",
                "xp3-protected-executable",
                "protected executable helper cannot analyze this fixture"
            )
            .error_code,
            SEMANTIC_PROTECTED_EXECUTABLE_UNSUPPORTED
        );
        assert_eq!(
            AdapterFailure::secret_redacted(
                "kaifuu.siglus",
                "siglus",
                "scene-pck-secondary-key",
                "helper-evidence",
                "helper output included secret-bearing fields"
            )
            .error_code,
            SEMANTIC_SECRET_REDACTED
        );
    }

    #[test]
    fn layered_access_preflight_reports_stable_redacted_failures() {
        let raw_key = "00112233445566778899aabbccddeeff";
        let report = LayeredAccessPreflightReport::from_requirements(
            "kaifuu.private-adapter",
            "kirikiri",
            "xp3-encrypted-protected",
            vec![
                LayeredAccessPreflightRequirement::missing_capability(
                    LayeredAccessStage::Container,
                    "private-route-name/ending.ks",
                    "missing XP3 container transform for /home/dev/Private Route Spoiler Game/data.xp3",
                ),
                LayeredAccessPreflightRequirement::missing_capability(
                    LayeredAccessStage::Crypto,
                    "Scene.pck",
                    format!("raw key {raw_key} was not resolved"),
                ),
                LayeredAccessPreflightRequirement::missing_capability(
                    LayeredAccessStage::Codec,
                    "script.bin",
                    "codec support has no helper dump or decrypted text evidence",
                ),
                LayeredAccessPreflightRequirement::missing_capability(
                    LayeredAccessStage::PatchBack,
                    "patch-back-target",
                    "patch-back writer is absent for this container",
                ),
                LayeredAccessPreflightRequirement::unsupported_transform(
                    LayeredAccessStage::Crypto,
                    "helper dump from private executable",
                    "Gameexe.dat",
                    "requested transform is not in the alpha readiness profile",
                ),
            ],
        );

        assert_eq!(report.status, OperationStatus::Failed);
        let codes = report
            .failures
            .iter()
            .map(|failure| failure.error_code.as_str())
            .collect::<Vec<_>>();
        assert_eq!(
            codes,
            vec![
                SEMANTIC_MISSING_CONTAINER_CAPABILITY,
                SEMANTIC_MISSING_CRYPTO_CAPABILITY,
                SEMANTIC_MISSING_CODEC_CAPABILITY,
                SEMANTIC_MISSING_PATCH_BACK_CAPABILITY,
                SEMANTIC_UNSUPPORTED_LAYERED_TRANSFORM,
            ]
        );
        assert!(
            report
                .failures
                .iter()
                .all(AdapterFailure::is_preflight_blocking)
        );
        assert!(
            report.failures.iter().any(|failure| {
                failure.required_capability == Some(Capability::ContainerAccess)
            })
        );
        assert!(
            report
                .failures
                .iter()
                .any(|failure| { failure.required_capability == Some(Capability::PatchBack) })
        );

        let serialized = report.stable_json().unwrap();
        assert!(!serialized.contains(raw_key));
        assert!(!serialized.contains("/home/dev"));
        assert!(!serialized.contains("Private Route Spoiler Game"));
        assert!(!serialized.contains("private-route-name"));
        assert!(!serialized.contains("helper dump"));
        assert!(!serialized.contains("decrypted text"));
        assert!(serialized.contains(SEMANTIC_SECRET_REDACTED));
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
    fn shared_contract_fixture_suite_rejects_alpha_proof_hash_link_mutations() {
        let mut fixture = alpha_proof_fixture_value();
        fixture["contentHashes"]
            .as_array_mut()
            .expect("contentHashes should be an array")
            .retain(|entry| entry["scope"].as_str() != Some("provider_proof"));
        expect_alpha_proof_error(fixture, "contentHashes must include provider_proof");

        let mut fixture = alpha_proof_fixture_value();
        fixture["contentHashes"]
            .as_array_mut()
            .expect("contentHashes should be an array")
            .retain(|entry| entry["scope"].as_str() != Some("bridge_unit"));
        expect_alpha_proof_error(fixture, "contentHashes must include bridge_unit");

        let mut fixture = alpha_proof_fixture_value();
        let provider_hash = fixture["contentHashes"]
            .as_array_mut()
            .expect("contentHashes should be an array")
            .iter_mut()
            .find(|entry| entry["scope"].as_str() == Some("provider_proof"))
            .expect("provider proof hash should exist");
        provider_hash["contentId"] = serde_json::json!("019ed025-0000-7000-8000-000000000202");
        expect_alpha_proof_error(fixture, "providerProofIds[0]");

        let mut fixture = alpha_proof_fixture_value();
        let patch_export_hash = fixture["contentHashes"]
            .as_array_mut()
            .expect("contentHashes should be an array")
            .iter_mut()
            .find(|entry| entry["scope"].as_str() == Some("patch_export"))
            .expect("patch export hash should exist");
        patch_export_hash["contentId"] =
            serde_json::json!("fixtures/hello-game/expected/patch-export-other.json");
        expect_alpha_proof_error(fixture, "artifactRefs.patch_export.hash");
    }

    #[test]
    fn shared_contract_fixture_suite_binds_alpha_public_manifest_hash_links() {
        let mut fixture = alpha_proof_fixture_value();
        fixture["fixture"]["publicManifestHash"] = serde_json::json!(
            "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
        );
        expect_alpha_proof_error(
            fixture,
            "fixture.publicManifestHash must match AlphaVerticalProofManifestV02.artifactRefs.publicFixtureManifest.hash",
        );

        let mut fixture = alpha_proof_fixture_value();
        let replacement_hash =
            "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
        fixture["fixture"]["publicManifestHash"] = serde_json::json!(replacement_hash);
        fixture["artifactRefs"]["publicFixtureManifest"]["hash"] =
            serde_json::json!(replacement_hash);
        let public_fixture_hash = fixture["contentHashes"]
            .as_array_mut()
            .expect("contentHashes should be an array")
            .iter_mut()
            .find(|entry| entry["scope"].as_str() == Some("public_fixture_manifest"))
            .expect("public fixture manifest hash should exist");
        public_fixture_hash["hash"] = serde_json::json!(replacement_hash);

        contracts::validate_alpha_vertical_proof_manifest_v02(&fixture)
            .expect("aligned public manifest hash links should validate");
    }

    #[test]
    fn rust_runtime_evidence_rejects_controlled_playback_status_mismatch() {
        let mut report = contract_example_fixture_value("./runtime-evidence-v0.2.json");
        report["status"] = Value::String("failed".to_string());

        let error = contracts::validate_runtime_evidence_report_v02(&report)
            .expect_err("controlled playback status mismatch should fail Rust validation")
            .to_string();

        assert!(
            error.contains("controlledPlaybackSession.status must match"),
            "unexpected error: {error}"
        );
    }

    #[test]
    fn rust_runtime_evidence_rejects_trace_operation_with_capture_evidence() {
        let mut report = contract_example_fixture_value("./runtime-evidence-v0.2.json");
        report["controlledPlaybackSession"]["requestedOperation"] =
            Value::String("trace".to_string());
        report["branchEvents"] = Value::Array(vec![]);
        report["recordings"] = Value::Array(vec![]);

        let error = contracts::validate_runtime_evidence_report_v02(&report)
            .expect_err("trace-requested session with capture evidence should fail Rust validation")
            .to_string();

        assert!(
            error.contains("requestedOperation trace must not carry capture evidence"),
            "unexpected error: {error}"
        );
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
            source_fingerprint: None,
            key_requirements: vec![],
            archive_parameters: vec![],
            helper_evidence: None,
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
