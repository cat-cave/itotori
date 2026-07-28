//! Fixture loading and detector report generation.

use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::{
    CodecTransform, ContainerTransform, CryptoTransform, KaifuuResult, OperationStatus,
    PartialDiagnosticSeverity, SecretRef, SemanticErrorCode, SurfaceTransform, read_json,
    redact_for_log_or_report, stable_json,
};

use super::model::*;

// Fixture (input) schema

/// A Wolf protection detector fixture set — a small manifest of synthetic
/// detector profile records.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WolfProtectionDetectorFixture {
    pub schema_version: String,
    /// Stable id for the fixture set (synthetic; no retail names/local paths).
    pub detector_set_id: String,
    /// Provenance node id stamped into generated reports.
    pub source_node_id: String,
    pub engine_family: String,
    pub entries: Vec<WolfProtectionDetectorFixtureEntry>,
}

/// One synthetic Wolf detector profile record. Carries every acceptance field:
/// engine family, variant, container, crypto/protection state, codec, surface,
/// fixture id, secret requirement ids, and (expected) diagnostics.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WolfProtectionDetectorFixtureEntry {
    /// Stable per-record fixture id.
    pub fixture_id: String,
    /// The detected/declared variant label (synthetic, human-readable).
    pub variant: String,
    /// Wolf-shaped container leg (expected `wolf_archive`).
    pub container: ContainerTransform,
    /// The wolf-specific protection state the record encodes.
    pub protection_signal: WolfArchiveProtectionSignal,
    /// The shared crypto transform leg (checked against the signal's canonical
    /// crypto).
    pub crypto: CryptoTransform,
    pub codec: CodecTransform,
    pub surface: SurfaceTransform,
    /// Concrete key requirements (secret requirement ids + optional local-scheme
    /// key refs). Empty for plain and unknown-unrecognized records.
    #[serde(default)]
    pub secret_requirements: Vec<WolfSecretRequirement>,
    /// The profile this record is authored to classify to. The detector
    /// recomputes it from evidence and raises a finding on a mismatch.
    pub expected_profile: WolfProtectionProfile,
    /// The semantic diagnostic codes this record expects. Recomputed from
    /// evidence; a mismatch is a finding.
    #[serde(default)]
    pub expected_semantic_codes: Vec<String>,
}

/// A concrete key requirement recorded by a protected / helper-required record.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WolfSecretRequirement {
    /// Stable id of the key requirement (never raw key bytes).
    pub requirement_id: String,
    /// Local-scheme reference to the key material (never raw key bytes).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub key_ref: Option<SecretRef>,
}

// Report (generated) schema

/// The generated per-record detector report. Echoes every acceptance field and
/// carries the mechanically-derived profile, capability tuple, and diagnostics.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WolfProtectionDetectorEntryReport {
    pub fixture_id: String,
    pub source_node_id: String,
    pub engine_family: String,
    pub variant: String,
    pub container: ContainerTransform,
    pub protection_signal: WolfArchiveProtectionSignal,
    pub crypto: CryptoTransform,
    pub codec: CodecTransform,
    pub surface: SurfaceTransform,
    /// The secret requirement ids this record names (redacted; never key bytes).
    pub secret_requirement_ids: Vec<String>,
    /// The mechanically-derived protection profile (single source of truth).
    pub profile: WolfProtectionProfile,
    pub capability_tuple: WolfCapabilityTuple,
    pub diagnostics: Vec<WolfProtectionDiagnostic>,
    pub status: OperationStatus,
    /// Structured validation findings (declared-vs-derived mismatches).
    pub findings: Vec<WolfProtectionDiagnostic>,
}

impl WolfProtectionDetectorEntryReport {
    pub(crate) fn redacted_for_report(&self) -> Self {
        Self {
            fixture_id: redact_for_log_or_report(&self.fixture_id),
            source_node_id: redact_for_log_or_report(&self.source_node_id),
            engine_family: redact_for_log_or_report(&self.engine_family),
            variant: redact_for_log_or_report(&self.variant),
            container: self.container,
            protection_signal: self.protection_signal,
            crypto: self.crypto,
            codec: self.codec,
            surface: self.surface,
            secret_requirement_ids: self
                .secret_requirement_ids
                .iter()
                .map(|id| redact_for_log_or_report(id))
                .collect(),
            profile: self.profile,
            capability_tuple: self.capability_tuple.clone(),
            diagnostics: self
                .diagnostics
                .iter()
                .map(WolfProtectionDiagnostic::redacted_for_report)
                .collect(),
            status: self.status.clone(),
            findings: self
                .findings
                .iter()
                .map(WolfProtectionDiagnostic::redacted_for_report)
                .collect(),
        }
    }
}

/// The aggregate detector report over a fixture set.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WolfProtectionDetectorReport {
    pub schema_version: String,
    pub detector_set_id: String,
    pub source_node_id: String,
    pub engine_family: String,
    pub support_boundary: String,
    pub status: OperationStatus,
    pub entries: Vec<WolfProtectionDetectorEntryReport>,
}

impl WolfProtectionDetectorReport {
    pub fn entry(&self, fixture_id: &str) -> Option<&WolfProtectionDetectorEntryReport> {
        self.entries
            .iter()
            .find(|entry| entry.fixture_id == fixture_id)
    }

    /// The report's archive/protection diagnostic matrix: each classified
    /// record mapped to its profile → capability tuple + diagnostics.
    pub fn diagnostic_matrix(&self) -> Vec<WolfProtectionMatrixRow> {
        self.entries
            .iter()
            .map(|entry| WolfProtectionMatrixRow {
                profile: entry.profile,
                capability_tuple: entry.capability_tuple.clone(),
                diagnostics: entry.diagnostics.clone(),
            })
            .collect()
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
                .map(WolfProtectionDetectorEntryReport::redacted_for_report)
                .collect(),
        }
    }

    pub fn stable_json(&self) -> KaifuuResult<String> {
        stable_json(&self.redacted_for_report())
    }
}

// Detector (generate + validate)

/// Run the Wolf protection detector over a fixture set. Every record is
/// classified into a profile mechanically; the record's declared expectation is
/// used only to raise structured findings on a mismatch. Never panics; a
/// blocking finding flips the record (and the report) to `Failed`.
pub fn run_wolf_protection_detector(
    fixture: &WolfProtectionDetectorFixture,
) -> WolfProtectionDetectorReport {
    let mut entries = Vec::with_capacity(fixture.entries.len());
    for entry in &fixture.entries {
        entries.push(detect_entry(
            entry,
            &fixture.source_node_id,
            &fixture.engine_family,
        ));
    }
    let status = if entries
        .iter()
        .all(|entry| matches!(entry.status, OperationStatus::Passed))
    {
        OperationStatus::Passed
    } else {
        OperationStatus::Failed
    };
    WolfProtectionDetectorReport {
        schema_version: WOLF_PROTECTION_DETECTOR_REPORT_SCHEMA_VERSION.to_string(),
        detector_set_id: fixture.detector_set_id.clone(),
        source_node_id: fixture.source_node_id.clone(),
        engine_family: fixture.engine_family.clone(),
        support_boundary: WOLF_PROTECTION_DETECTOR_SUPPORT_BOUNDARY.to_string(),
        status,
        entries,
    }
}

fn detect_entry(
    entry: &WolfProtectionDetectorFixtureEntry,
    source_node_id: &str,
    engine_family: &str,
) -> WolfProtectionDetectorEntryReport {
    let mut findings: Vec<WolfProtectionDiagnostic> = Vec::new();

    if entry.fixture_id.trim().is_empty() {
        findings.push(diagnostic(
            "wolf.detector.fixture_id_missing",
            PartialDiagnosticSeverity::P0,
            "fixtureId",
            "record is missing a non-empty fixtureId",
            SemanticErrorCode::UnknownEngineVariant,
        ));
    }
    if engine_family != WOLF_ENGINE_FAMILY {
        findings.push(diagnostic(
            "wolf.detector.wrong_engine_family",
            PartialDiagnosticSeverity::P0,
            "engineFamily",
            format!(
                "Wolf detector requires engineFamily={WOLF_ENGINE_FAMILY}, got {engine_family}"
            ),
            SemanticErrorCode::UnknownEngineVariant,
        ));
    }
    // Wolf-shaped container leg.
    if entry.container != ContainerTransform::WolfArchive {
        findings.push(diagnostic(
            "wolf.detector.out_of_family_container",
            PartialDiagnosticSeverity::P0,
            "container",
            format!(
                "Wolf detector requires a wolf_archive container, got {:?}",
                entry.container
            ),
            if entry.container == ContainerTransform::Unknown {
                SemanticErrorCode::MissingContainerCapability
            } else {
                SemanticErrorCode::UnsupportedVariantPacked
            },
        ));
    }
    // The declared crypto leg must match the protection signal's canonical
    // crypto — a record cannot claim a plain crypto with a protected signal.
    let canonical_crypto = entry.protection_signal.canonical_crypto();
    if entry.crypto != canonical_crypto {
        findings.push(diagnostic(
            "wolf.detector.crypto_signal_mismatch",
            PartialDiagnosticSeverity::P0,
            "crypto",
            format!(
                "protection signal {} implies crypto {:?} but the record declared {:?}",
                entry.protection_signal.as_str(),
                canonical_crypto,
                entry.crypto
            ),
            SemanticErrorCode::MissingCryptoCapability,
        ));
    }

    // --- The mechanical classification (always recomputed from evidence). --
    let has_requirement = !entry.secret_requirements.is_empty();
    let profile = derive_wolf_protection_profile(entry.protection_signal, has_requirement);
    let reason = unknown_reason(entry.protection_signal, has_requirement);
    let capability_tuple = derive_wolf_capability_tuple(profile);
    let diagnostics = derive_wolf_protection_diagnostics(profile, reason);

    if entry.expected_profile != profile {
        findings.push(diagnostic(
            "wolf.detector.profile_mismatch",
            PartialDiagnosticSeverity::P0,
            "expectedProfile",
            format!(
                "record declared profile {} but the detector classified {}",
                entry.expected_profile.as_str(),
                profile.as_str()
            ),
            SemanticErrorCode::UnknownEngineVariant,
        ));
    }
    // Declared diagnostics (semantic codes) must match the derived set.
    let derived_codes: Vec<&str> = diagnostics
        .iter()
        .map(|d| d.semantic_code.as_str())
        .collect();
    let expected_codes: Vec<&str> = entry
        .expected_semantic_codes
        .iter()
        .map(String::as_str)
        .collect();
    if derived_codes != expected_codes {
        findings.push(diagnostic(
            "wolf.detector.diagnostic_mismatch",
            PartialDiagnosticSeverity::P0,
            "expectedSemanticCodes",
            format!(
                "record declared diagnostics {expected_codes:?} but the detector derived {derived_codes:?}"
            ),
            SemanticErrorCode::UnknownEngineVariant,
        ));
    }
    // A concrete key requirement must name a stable requirement id.
    for requirement in &entry.secret_requirements {
        if requirement.requirement_id.trim().is_empty() {
            findings.push(diagnostic(
                "wolf.detector.requirement_id_missing",
                PartialDiagnosticSeverity::P0,
                "secretRequirements",
                "a secret requirement is missing a non-empty requirementId",
                SemanticErrorCode::MissingKeyProfile,
            ));
        }
    }
    // Mechanical overclaim guard: the detector tuple can never resolve extract /
    // patch / helper / runtime.
    if !capability_tuple.is_detector_only() {
        findings.push(diagnostic(
            "wolf.detector.capability_overclaim",
            PartialDiagnosticSeverity::P0,
            "capabilityTuple",
            "the Wolf protection detector must not advertise extract, patch, helper, or runtime support",
            SemanticErrorCode::UnsupportedVariantPacked,
        ));
    }

    let status = if findings.iter().any(|f| f.severity.is_blocking()) {
        OperationStatus::Failed
    } else {
        OperationStatus::Passed
    };

    WolfProtectionDetectorEntryReport {
        fixture_id: entry.fixture_id.clone(),
        source_node_id: source_node_id.to_string(),
        engine_family: engine_family.to_string(),
        variant: entry.variant.clone(),
        container: entry.container,
        protection_signal: entry.protection_signal,
        crypto: entry.crypto,
        codec: entry.codec,
        surface: entry.surface,
        secret_requirement_ids: entry
            .secret_requirements
            .iter()
            .map(|requirement| requirement.requirement_id.clone())
            .collect(),
        profile,
        capability_tuple,
        diagnostics,
        status,
        findings,
    }
}

/// Load a Wolf protection detector fixture set from disk.
pub fn read_wolf_protection_detector_fixture(
    path: &Path,
) -> KaifuuResult<WolfProtectionDetectorFixture> {
    read_json(path)
}
