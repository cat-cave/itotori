//! KAIFUU-126 — BGI / Ethornell detector profile fixtures.
//!
//! This is a detector-fixture slice only. It records synthetic BGI/Ethornell
//! container/profile evidence in the KAIFUU-085 compat-evidence shape: engine
//! family, variant, container, crypto, codec, surface, fixture id, secret
//! requirement ids, proof hashes, and diagnostics. It deliberately does not
//! infer key requirements for BSE/DSC/CompressedBG markers; those variants are
//! represented as `none_or_unknown_variant` crypto until a concrete profile
//! proves otherwise.

use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::{
    CodecTransform, ContainerTransform, KaifuuResult, OperationStatus, PartialDiagnosticSeverity,
    ProofHash, SemanticErrorCode, SurfaceTransform, read_json, redact_for_log_or_report,
    sha256_hash_bytes, stable_json,
};

pub const BGI_DETECTOR_FIXTURE_SCHEMA_VERSION: &str = "0.1.0";
pub const BGI_DETECTOR_REPORT_SCHEMA_VERSION: &str = "0.1.0";
pub const BGI_ENGINE_FAMILY: &str = "bgi";
pub const BGI_DETECTOR_SUPPORT_BOUNDARY: &str = "BGI/Ethornell detector fixtures identify synthetic Buriko ARC20 / BSE / DSC / CompressedBG profile variants only. They do not parse archives, decompress payloads, decrypt assets, extract text, or claim patch-back support. Unknown encrypted/compressed/layered variants stay crypto=none_or_unknown_variant with empty secret requirement ids until concrete key evidence exists.";

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BgiDetectorProfile {
    BurikoArc20Container,
    BseEncryptedContainer,
    DscCompressedContainer,
    CompressedBgLayeredTransform,
    NoHeaderArc,
    UnknownContainer,
}

impl BgiDetectorProfile {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::BurikoArc20Container => "buriko_arc20_container",
            Self::BseEncryptedContainer => "bse_encrypted_container",
            Self::DscCompressedContainer => "dsc_compressed_container",
            Self::CompressedBgLayeredTransform => "compressed_bg_layered_transform",
            Self::NoHeaderArc => "no_header_arc",
            Self::UnknownContainer => "unknown_container",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BgiDetectorCrypto {
    NoneOrUnknownVariant,
}

impl BgiDetectorCrypto {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::NoneOrUnknownVariant => "none_or_unknown_variant",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BgiDetectorFixture {
    pub schema_version: String,
    pub detector_set_id: String,
    pub source_node_id: String,
    pub engine_family: String,
    pub entries: Vec<BgiDetectorFixtureEntry>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BgiDetectorFixtureEntry {
    pub fixture_id: String,
    pub variant: String,
    pub profile: BgiDetectorProfile,
    pub container: ContainerTransform,
    pub crypto: BgiDetectorCrypto,
    pub codec: CodecTransform,
    pub surface: SurfaceTransform,
    #[serde(default)]
    pub secret_requirement_ids: Vec<String>,
    pub proof_hashes: Vec<ProofHash>,
    #[serde(default)]
    pub expected_semantic_codes: Vec<SemanticErrorCode>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BgiDetectorDiagnostic {
    pub code: String,
    pub severity: PartialDiagnosticSeverity,
    pub field: String,
    pub message: String,
    pub semantic_code: SemanticErrorCode,
}

impl BgiDetectorDiagnostic {
    fn redacted_for_report(&self) -> Self {
        Self {
            code: redact_for_log_or_report(&self.code),
            severity: self.severity,
            field: redact_for_log_or_report(&self.field),
            message: redact_for_log_or_report(&self.message),
            semantic_code: self.semantic_code,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BgiDetectorEntryReport {
    pub fixture_id: String,
    pub source_node_id: String,
    pub engine_family: String,
    pub variant: String,
    pub profile: BgiDetectorProfile,
    pub container: ContainerTransform,
    pub crypto: BgiDetectorCrypto,
    pub codec: CodecTransform,
    pub surface: SurfaceTransform,
    pub secret_requirement_ids: Vec<String>,
    pub proof_hashes: Vec<ProofHash>,
    pub diagnostics: Vec<BgiDetectorDiagnostic>,
    pub status: OperationStatus,
    pub findings: Vec<BgiDetectorDiagnostic>,
}

impl BgiDetectorEntryReport {
    fn redacted_for_report(&self) -> Self {
        Self {
            fixture_id: redact_for_log_or_report(&self.fixture_id),
            source_node_id: redact_for_log_or_report(&self.source_node_id),
            engine_family: redact_for_log_or_report(&self.engine_family),
            variant: redact_for_log_or_report(&self.variant),
            profile: self.profile,
            container: self.container,
            crypto: self.crypto,
            codec: self.codec,
            surface: self.surface,
            secret_requirement_ids: self
                .secret_requirement_ids
                .iter()
                .map(|id| redact_for_log_or_report(id))
                .collect(),
            proof_hashes: self.proof_hashes.clone(),
            diagnostics: self
                .diagnostics
                .iter()
                .map(BgiDetectorDiagnostic::redacted_for_report)
                .collect(),
            status: self.status.clone(),
            findings: self
                .findings
                .iter()
                .map(BgiDetectorDiagnostic::redacted_for_report)
                .collect(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BgiDetectorReport {
    pub schema_version: String,
    pub detector_set_id: String,
    pub source_node_id: String,
    pub engine_family: String,
    pub support_boundary: String,
    pub status: OperationStatus,
    pub entries: Vec<BgiDetectorEntryReport>,
}

impl BgiDetectorReport {
    pub fn entry(&self, fixture_id: &str) -> Option<&BgiDetectorEntryReport> {
        self.entries
            .iter()
            .find(|entry| entry.fixture_id == fixture_id)
    }

    pub fn redacted_for_report(&self) -> Self {
        Self {
            schema_version: self.schema_version.clone(),
            detector_set_id: redact_for_log_or_report(&self.detector_set_id),
            source_node_id: redact_for_log_or_report(&self.source_node_id),
            engine_family: redact_for_log_or_report(&self.engine_family),
            support_boundary: redact_for_log_or_report(&self.support_boundary),
            status: self.status.clone(),
            entries: self
                .entries
                .iter()
                .map(BgiDetectorEntryReport::redacted_for_report)
                .collect(),
        }
    }

    pub fn stable_json(&self) -> KaifuuResult<String> {
        stable_json(&self.redacted_for_report())
    }
}

pub fn run_bgi_detector_fixture(fixture: &BgiDetectorFixture) -> BgiDetectorReport {
    let entries: Vec<BgiDetectorEntryReport> = fixture
        .entries
        .iter()
        .map(|entry| detect_entry(entry, &fixture.source_node_id, &fixture.engine_family))
        .collect();
    let status = if entries
        .iter()
        .all(|entry| matches!(entry.status, OperationStatus::Passed))
    {
        OperationStatus::Passed
    } else {
        OperationStatus::Failed
    };

    BgiDetectorReport {
        schema_version: BGI_DETECTOR_REPORT_SCHEMA_VERSION.to_string(),
        detector_set_id: fixture.detector_set_id.clone(),
        source_node_id: fixture.source_node_id.clone(),
        engine_family: fixture.engine_family.clone(),
        support_boundary: BGI_DETECTOR_SUPPORT_BOUNDARY.to_string(),
        status,
        entries,
    }
}

fn detect_entry(
    entry: &BgiDetectorFixtureEntry,
    source_node_id: &str,
    engine_family: &str,
) -> BgiDetectorEntryReport {
    let mut findings = Vec::new();

    if entry.fixture_id.trim().is_empty() {
        findings.push(diagnostic(
            "bgi.detector.fixture_id_missing",
            PartialDiagnosticSeverity::P0,
            "fixtureId",
            "record is missing a non-empty fixtureId",
            SemanticErrorCode::UnknownEngineVariant,
        ));
    }
    if engine_family != BGI_ENGINE_FAMILY {
        findings.push(diagnostic(
            "bgi.detector.wrong_engine_family",
            PartialDiagnosticSeverity::P0,
            "engineFamily",
            format!("BGI detector requires engineFamily={BGI_ENGINE_FAMILY}, got {engine_family}"),
            SemanticErrorCode::UnknownEngineVariant,
        ));
    }
    if entry.crypto != BgiDetectorCrypto::NoneOrUnknownVariant {
        findings.push(diagnostic(
            "bgi.detector.crypto_must_be_unknown",
            PartialDiagnosticSeverity::P0,
            "crypto",
            "BGI detector fixtures must keep crypto=none_or_unknown_variant until a concrete key profile exists",
            SemanticErrorCode::MissingCryptoCapability,
        ));
    }
    if !entry.secret_requirement_ids.is_empty() {
        findings.push(diagnostic(
            "bgi.detector.invented_secret_requirement",
            PartialDiagnosticSeverity::P0,
            "secretRequirementIds",
            "BGI detector fixtures must not name secret requirements without concrete key evidence",
            SemanticErrorCode::MissingCryptoCapability,
        ));
    }

    let diagnostics = derive_diagnostics(entry.profile);
    let derived_codes: Vec<SemanticErrorCode> = diagnostics
        .iter()
        .map(|diagnostic| diagnostic.semantic_code)
        .collect();
    if entry.expected_semantic_codes != derived_codes {
        findings.push(diagnostic(
            "bgi.detector.diagnostic_mismatch",
            PartialDiagnosticSeverity::P0,
            "expectedSemanticCodes",
            format!(
                "record declared diagnostics {:?} but detector derived {:?}",
                entry.expected_semantic_codes, derived_codes
            ),
            SemanticErrorCode::UnknownEngineVariant,
        ));
    }

    let expected_proof = proof_hash_for_entry(entry, source_node_id, engine_family, &derived_codes);
    if entry.proof_hashes != vec![expected_proof.clone()] {
        findings.push(diagnostic(
            "bgi.detector.proof_hash_mismatch",
            PartialDiagnosticSeverity::P0,
            "proofHashes",
            format!(
                "record proof hash did not match derived tuple proof {}",
                expected_proof.as_str()
            ),
            SemanticErrorCode::UnknownEngineVariant,
        ));
    }

    let status = if findings
        .iter()
        .any(|finding| finding.severity.is_blocking())
    {
        OperationStatus::Failed
    } else {
        OperationStatus::Passed
    };

    BgiDetectorEntryReport {
        fixture_id: entry.fixture_id.clone(),
        source_node_id: source_node_id.to_string(),
        engine_family: engine_family.to_string(),
        variant: entry.variant.clone(),
        profile: entry.profile,
        container: entry.container,
        crypto: entry.crypto,
        codec: entry.codec,
        surface: entry.surface,
        secret_requirement_ids: entry.secret_requirement_ids.clone(),
        proof_hashes: entry.proof_hashes.clone(),
        diagnostics,
        status,
        findings,
    }
}

fn derive_diagnostics(profile: BgiDetectorProfile) -> Vec<BgiDetectorDiagnostic> {
    match profile {
        BgiDetectorProfile::BurikoArc20Container => vec![diagnostic(
            "bgi.detector.container_profile_only",
            PartialDiagnosticSeverity::P2,
            "container",
            "BURIKO ARC20 header is detector/profile evidence only; archive parsing is not claimed",
            SemanticErrorCode::UnsupportedVariantPacked,
        )],
        BgiDetectorProfile::BseEncryptedContainer => vec![
            diagnostic(
                "bgi.detector.bse_unknown_variant",
                PartialDiagnosticSeverity::P1,
                "variant",
                "BSE encrypted BGI variant is recognized only as an unknown detector profile",
                SemanticErrorCode::UnknownEngineVariant,
            ),
            diagnostic(
                "bgi.detector.bse_missing_crypto_capability",
                PartialDiagnosticSeverity::P1,
                "crypto",
                "BSE marker does not prove a reusable key requirement",
                SemanticErrorCode::MissingCryptoCapability,
            ),
        ],
        BgiDetectorProfile::DscCompressedContainer => vec![diagnostic(
            "bgi.detector.dsc_missing_codec_capability",
            PartialDiagnosticSeverity::P1,
            "codec",
            "DSC compressed BGI variant has no claimed decompression codec",
            SemanticErrorCode::MissingCodecCapability,
        )],
        BgiDetectorProfile::CompressedBgLayeredTransform => vec![
            diagnostic(
                "bgi.detector.compressed_bg_layered_transform",
                PartialDiagnosticSeverity::P1,
                "surface",
                "CompressedBG requires layered container/decompression/surface handling outside the detector",
                SemanticErrorCode::UnsupportedLayeredTransform,
            ),
            diagnostic(
                "bgi.detector.compressed_bg_missing_codec_capability",
                PartialDiagnosticSeverity::P1,
                "codec",
                "CompressedBG compression is not a claimed codec",
                SemanticErrorCode::MissingCodecCapability,
            ),
        ],
        BgiDetectorProfile::NoHeaderArc => vec![
            diagnostic(
                "bgi.detector.no_header_unknown_variant",
                PartialDiagnosticSeverity::P1,
                "variant",
                "generic .arc without BURIKO ARC20 header is not enough to classify BGI",
                SemanticErrorCode::UnknownEngineVariant,
            ),
            diagnostic(
                "bgi.detector.no_header_missing_container_capability",
                PartialDiagnosticSeverity::P1,
                "container",
                "no BGI container capability is claimed without header evidence",
                SemanticErrorCode::MissingContainerCapability,
            ),
        ],
        BgiDetectorProfile::UnknownContainer => vec![
            diagnostic(
                "bgi.detector.unknown_container_variant",
                PartialDiagnosticSeverity::P1,
                "variant",
                "unrecognized BGI-like container stays an unknown detector profile",
                SemanticErrorCode::UnknownEngineVariant,
            ),
            diagnostic(
                "bgi.detector.unknown_container_missing_capability",
                PartialDiagnosticSeverity::P1,
                "container",
                "unknown BGI-like container has no claimed parser capability",
                SemanticErrorCode::MissingContainerCapability,
            ),
        ],
    }
}

fn diagnostic(
    code: impl Into<String>,
    severity: PartialDiagnosticSeverity,
    field: impl Into<String>,
    message: impl Into<String>,
    semantic_code: SemanticErrorCode,
) -> BgiDetectorDiagnostic {
    BgiDetectorDiagnostic {
        code: code.into(),
        severity,
        field: field.into(),
        message: message.into(),
        semantic_code,
    }
}

fn proof_hash_for_entry(
    entry: &BgiDetectorFixtureEntry,
    source_node_id: &str,
    engine_family: &str,
    semantic_codes: &[SemanticErrorCode],
) -> ProofHash {
    let semantic_codes = semantic_codes
        .iter()
        .map(|code| code.as_str())
        .collect::<Vec<_>>()
        .join(",");
    let material = format!(
        "KAIFUU-126|{source_node_id}|{engine_family}|{}|{}|{}|{}|{}|{}|{}|{semantic_codes}",
        entry.fixture_id,
        entry.variant,
        entry.profile.as_str(),
        container_as_str(entry.container),
        entry.crypto.as_str(),
        codec_as_str(entry.codec),
        surface_as_str(entry.surface),
    );
    ProofHash::new(sha256_hash_bytes(material.as_bytes())).expect("sha256 hash is canonical")
}

fn container_as_str(container: ContainerTransform) -> &'static str {
    match container {
        ContainerTransform::Identity => "identity",
        ContainerTransform::Directory => "directory",
        ContainerTransform::LooseFile => "loose_file",
        ContainerTransform::ProjectAsset => "project_asset",
        ContainerTransform::Archive => "archive",
        ContainerTransform::Xp3 => "xp3",
        ContainerTransform::SiglusPck => "siglus_pck",
        ContainerTransform::Rgssad => "rgssad",
        ContainerTransform::WolfArchive => "wolf_archive",
        ContainerTransform::AssetBundle => "asset_bundle",
        ContainerTransform::Unknown => "unknown",
    }
}

fn codec_as_str(codec: CodecTransform) -> &'static str {
    match codec {
        CodecTransform::Identity => "identity",
        CodecTransform::PngImage => "png_image",
        CodecTransform::M4aAudio => "m4a_audio",
        CodecTransform::OggAudio => "ogg_audio",
        CodecTransform::Utf8Text => "utf8_text",
        CodecTransform::Utf16Text => "utf16_text",
        CodecTransform::ShiftJisText => "shift_jis_text",
        CodecTransform::JsonText => "json_text",
        CodecTransform::RpgMakerMvMzJson => "rpg_maker_mv_mz_json",
        CodecTransform::TyranoScriptMarkup => "tyrano_script_markup",
        CodecTransform::RubyMarshal => "ruby_marshal",
        CodecTransform::BytecodeDecompile => "bytecode_decompile",
        CodecTransform::BinaryTable => "binary_table",
        CodecTransform::Unknown => "unknown",
    }
}

fn surface_as_str(surface: SurfaceTransform) -> &'static str {
    match surface {
        SurfaceTransform::Identity => "identity",
        SurfaceTransform::JsonPointer => "json_pointer",
        SurfaceTransform::ArchiveEntry => "archive_entry",
        SurfaceTransform::BinaryOffset => "binary_offset",
        SurfaceTransform::TableRecord => "table_record",
        SurfaceTransform::RuntimeTrace => "runtime_trace",
        SurfaceTransform::OcrRegion => "ocr_region",
        SurfaceTransform::Unknown => "unknown",
    }
}

pub fn read_bgi_detector_fixture(path: &Path) -> KaifuuResult<BgiDetectorFixture> {
    read_json(path)
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    use super::*;

    fn fixtures_dir() -> PathBuf {
        crate::test_manifest_dir()
            .join("../..")
            .join("fixtures/kaifuu/bgi")
    }

    fn load() -> BgiDetectorFixture {
        read_bgi_detector_fixture(&fixtures_dir().join("detector.profiles.json"))
            .expect("BGI detector fixture must parse")
    }

    fn run() -> BgiDetectorReport {
        run_bgi_detector_fixture(&load())
    }

    #[test]
    fn detector_fixture_set_passes_and_records_kaifuu_085_fields() {
        let report = run();
        assert_eq!(report.status, OperationStatus::Passed, "{:#?}", report);
        assert_eq!(report.engine_family, BGI_ENGINE_FAMILY);
        assert_eq!(report.source_node_id, "KAIFUU-126");
        assert_eq!(report.entries.len(), 6);

        for entry in &report.entries {
            assert_eq!(entry.status, OperationStatus::Passed, "{entry:#?}");
            assert_eq!(entry.engine_family, BGI_ENGINE_FAMILY);
            assert!(!entry.fixture_id.is_empty());
            assert!(!entry.variant.is_empty());
            assert_eq!(entry.crypto, BgiDetectorCrypto::NoneOrUnknownVariant);
            assert!(
                entry.secret_requirement_ids.is_empty(),
                "{} invented a secret requirement",
                entry.fixture_id
            );
            assert_eq!(entry.proof_hashes.len(), 1);
            assert!(!entry.diagnostics.is_empty());
        }
    }

    #[test]
    fn profile_variants_cover_container_compression_and_layered_cases() {
        let report = run();
        for fixture_id in [
            "bgi.buriko-arc20-container",
            "bgi.bse-encrypted-container",
            "bgi.dsc-compressed-container",
            "bgi.compressed-bg-layered-transform",
            "bgi.no-header-arc",
            "bgi.unknown-container",
        ] {
            assert!(report.entry(fixture_id).is_some(), "missing {fixture_id}");
        }

        let bse = report.entry("bgi.bse-encrypted-container").unwrap();
        let bse_codes: Vec<SemanticErrorCode> =
            bse.diagnostics.iter().map(|d| d.semantic_code).collect();
        assert!(bse_codes.contains(&SemanticErrorCode::UnknownEngineVariant));
        assert!(bse_codes.contains(&SemanticErrorCode::MissingCryptoCapability));

        let dsc = report.entry("bgi.dsc-compressed-container").unwrap();
        assert!(
            dsc.diagnostics
                .iter()
                .any(|d| d.semantic_code == SemanticErrorCode::MissingCodecCapability)
        );

        let layered = report.entry("bgi.compressed-bg-layered-transform").unwrap();
        assert!(
            layered
                .diagnostics
                .iter()
                .any(|d| d.semantic_code == SemanticErrorCode::UnsupportedLayeredTransform)
        );
    }

    #[test]
    fn proof_hashes_are_derived_from_tuple_fields() {
        let fixture = load();
        for entry in &fixture.entries {
            let codes: Vec<SemanticErrorCode> = derive_diagnostics(entry.profile)
                .iter()
                .map(|diagnostic| diagnostic.semantic_code)
                .collect();
            assert_eq!(
                entry.proof_hashes,
                vec![proof_hash_for_entry(
                    entry,
                    &fixture.source_node_id,
                    &fixture.engine_family,
                    &codes
                )],
                "{} proof hash drifted",
                entry.fixture_id
            );
        }
    }

    #[test]
    fn report_is_redaction_clean_and_refuses_invented_keys() {
        let mut fixture = load();
        fixture.detector_set_id = "/home/trevor/private/bgi/real-game.arc".to_string();
        let report = run_bgi_detector_fixture(&fixture);
        let json = report.stable_json().expect("stable json");
        assert!(json.contains("[REDACTED:"));
        assert!(!json.contains("/home/trevor/private/bgi/real-game.arc"));
        for forbidden in [
            "local-secret:",
            "fixture-only-bgi-container-key-v1",
            "bgi-ethornell-container-key",
            "KAIFUU_BGI_CONTAINER_KEY",
        ] {
            assert!(!json.contains(forbidden), "report leaked {forbidden}");
        }

        fixture.entries[0]
            .secret_requirement_ids
            .push("bgi-ethornell-container-key".to_string());
        let report = run_bgi_detector_fixture(&fixture);
        assert_eq!(report.status, OperationStatus::Failed);
        let first = report.entry("bgi.buriko-arc20-container").unwrap();
        assert!(first.findings.iter().any(|finding| {
            finding.code == "bgi.detector.invented_secret_requirement"
                && finding.semantic_code == SemanticErrorCode::MissingCryptoCapability
        }));
    }
}
