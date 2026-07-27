use super::*;

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
    pub(crate) fn redacted_for_report(&self) -> Self {
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
            detect_reallive(&scan),
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

pub(crate) const ARCHIVE_DETECTION_EVIDENCE_POLICY: &str = "aggregate-only; no raw keys, helper dumps, decrypted text, local paths, or private source filenames are serialized";
pub(crate) const NON_DETECTED_ARCHIVE_VARIANT: &str = "unknown-variant";

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
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub surfaces: Vec<ArchiveDetectionSurface>,
    pub evidence: Vec<ArchiveDetectionEvidence>,
    pub requirements: Vec<ProfileRequirement>,
    pub diagnostics: Vec<DetectionDiagnostic>,
    pub capabilities: Vec<CapabilityReport>,
    pub support_boundary: String,
}

impl ArchiveDetectionRow {
    pub fn normalize(&mut self) {
        if !self.detected {
            self.detected_variant = NON_DETECTED_ARCHIVE_VARIANT.to_string();
        }
        self.signals
            .sort_by_key(|signal| serde_json::to_string(signal).unwrap_or_default());
        self.signals.dedup();
        for surface in &mut self.surfaces {
            surface.key_requirement_refs.sort();
            surface.key_requirement_refs.dedup();
            surface.diagnostics.sort_by_key(|diagnostic| {
                (
                    diagnostic.code.to_string(),
                    serde_json::to_string(&diagnostic.signal).unwrap_or_default(),
                    diagnostic.support_boundary.clone(),
                )
            });
        }
        self.surfaces
            .sort_by_key(|surface| surface.fixture_id.clone());
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
#[serde(rename_all = "camelCase")]
pub struct ArchiveDetectionSurface {
    pub fixture_id: String,
    pub engine_family: String,
    pub variant: String,
    pub container: ContainerTransform,
    pub crypto: CryptoTransform,
    pub codec: CodecTransform,
    pub surface: String,
    pub count: u64,
    pub key_requirement_refs: Vec<String>,
    pub diagnostics: Vec<DetectionDiagnostic>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ArchiveEngineFamily {
    KiriKiriXp3,
    Siglus,
    #[serde(rename = "reallive")]
    RealLive,
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
    Compressed,
    Encrypted,
    /// Encrypted input was recognized but no reusable crypto capability is
    /// claimed; distinct from `Encrypted` so the detector can emit the
    /// `missing_capability.crypto` diagnostic alongside the encrypted-variant
    /// one (encrypted markers prove detection, not a decryptor).
    CryptoUnsupported,
    Packed,
    /// A layered container/decompression/surface transform (e.g. BGI
    /// CompressedBG) was recognized; handling it needs stacked container +
    /// codec + surface work that lives outside the detection matrix.
    LayeredTransform,
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
pub(crate) struct ArchiveDetectionScan {
    pub(crate) extensions: BTreeMap<String, u64>,
    pub(crate) file_names: BTreeMap<String, u64>,
    pub(crate) headers: Vec<Vec<u8>>,
    pub(crate) orphaned_subtype_marker_count: u64,
    pub(crate) rpg_maker_system_json_encryption_fields: u64,
}

impl ArchiveDetectionScan {
    pub(crate) fn collect(game_dir: &Path) -> Self {
        let mut scan = Self::default();
        scan.visit_dir(game_dir, game_dir);
        scan
    }

    pub(crate) fn visit_dir(&mut self, root: &Path, dir: &Path) {
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

    pub(crate) fn record_file(&mut self, root: &Path, path: &Path) {
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

    pub(crate) fn extension_count(&self, extension: &str) -> u64 {
        self.extensions.get(extension).copied().unwrap_or_default()
    }

    pub(crate) fn extension_counts(&self, extensions: &[&str]) -> u64 {
        extensions
            .iter()
            .map(|extension| self.extension_count(extension))
            .sum()
    }

    pub(crate) fn file_name_count(&self, file_name: &str) -> u64 {
        self.file_names
            .get(&file_name.to_ascii_lowercase())
            .copied()
            .unwrap_or_default()
    }

    pub(crate) fn header_count(&self, needle: &str) -> u64 {
        self.headers
            .iter()
            .filter(|header| header_contains_ascii(header, needle))
            .count() as u64
    }

    pub(crate) fn wolf_rpg_editor_header_count(&self) -> u64 {
        self.headers
            .iter()
            .filter(|header| has_wolf_rpg_editor_primary_evidence(None, header))
            .count() as u64
    }

    pub(crate) fn xp3_header_count(&self) -> u64 {
        self.headers
            .iter()
            .filter(|header| header.starts_with(b"XP3"))
            .count() as u64
    }

    /// Count container headers that carry the given XP3 subtype marker at its
    /// STRUCTURAL position (see [`xp3_structural_marker`]). A genuine plain
    /// XP3 whose member payload happens to contain marker-like text is never
    /// counted — the scan anchors on the container's marker line, not on an
    /// incidental substring anywhere in the early payload bytes.
    pub(crate) fn xp3_structural_marker_count(&self, marker: Xp3StructuralMarker) -> u64 {
        self.headers
            .iter()
            .filter(|header| xp3_structural_marker(header) == Some(marker))
            .count() as u64
    }
}
