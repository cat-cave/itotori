//! Alpha packed/encrypted-engine readiness-PROFILE subset.
//! This module is the *profile* half of the alpha packed-engine readiness
//! story. Where ([`crate::packed_engine_readiness`]) is the reusable
//! per-fixture transform-stack *validator*, and
//! ([`crate::alpha_encrypted_readiness`]) is the *evidence* generator that joins
//! validated profiles with synthetic patch artifacts, owns the small
//! curated subset of high-value packed/encrypted engines whose prerequisite
//! proof nodes exist and states — per engine, per operation — the alpha
//! capability level plus the helper/key gating.
//! It ships three deliverables, all built on the SHARED vocabulary (never
//! reimplemented):
//! 1. a **template** ([`alpha_readiness_profile_template`]) — the canonical,
//!    validation-passing skeleton an author copies to declare a new engine;
//! 2. **seeds** ([`alpha_readiness_seeds`]) for the five subset engines —
//!    Siglus, KiriKiri XP3, Wolf RPG Editor, RPG Maker VX Ace / RGSS3, and
//!    BGI / Ethornell; and
//! 3. an **alpha capability-level summary renderer**
//!    ([`render_alpha_capability_summary`] + [`AlphaCapabilitySummary`]).
//! # The five operations (identify / inventory / extract / patch / helper-key)
//! Each profile states, for the four capability rungs
//! ([`crate::CapabilityLevel`]) via an [`crate::AdapterCapabilityMatrix`], a
//! per-operation [`crate::CapabilityLevelStatus`] (supported / partial /
//! unsupported), plus a fifth **helper-key** posture
//! ([`AlphaHelperKeyStatus`]) that records the key-material and helper gating.
//! The renderer surfaces all five for every engine.
//! # Honest ceilings — BGI / Ethornell is detector/profile-only
//! The alpha subset applies a STRICTER ceiling than the engine spec.
//! BGI / Ethornell readiness is limited to detector/profile evidence (from the
//! detection node): its seed claims `identify` only and marks
//! inventory / extract / patch `unsupported`. It never claims an archive parser
//! or patch support — the honest ceiling, below even the family
//! spec's theoretical ceiling.
//! # Unknown / out-of-profile vs. in-profile BUG (the mechanical distinction)
//! Validation classifies every finding with a [`ReadinessFailureClass`]:
//! - [`ReadinessFailureClass::OutOfProfile`] — a semantic boundary that is NOT a
//!   defect: an unknown engine family, or a claim that reaches PAST the engine
//!   family's theoretical ceiling. An honestly-`unsupported` rung is
//!   the profile's declared boundary and produces NO finding at all.
//! - [`ReadinessFailureClass::InProfileBug`] — a defect INSIDE claimed support:
//!   a rung the profile claims (`supported`/`partial`) whose required backing
//!   field (fixture, key, helper, patch-back, provenance) is missing or
//!   inconsistent.
//!   Both classes fail the profile, but the class is recorded so a genuine
//!   not-yet-supported boundary is never confused with a broken claim.
//! # Evidence is synthetic, redacted, ref-only
//! Profiles carry NO raw key material, NO private asset paths, NO decrypted
//! scripts, NO helper dumps, and NO story filenames: only synthetic
//! profile/fixture ids, a local-scheme [`crate::SecretRef`] key reference, a
//! helper id, and — optionally — a hash/id-only reference to a private-local
//! aggregate report (never a path). Reports and the rendered summary are
//! funnelled through [`crate::redact_for_log_or_report`].

use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::{
    AdapterCapabilityMatrix, CapabilityLevel, KaifuuResult, LayeredAccessHelperStatus,
    LayeredAccessKeyMaterialStatus, OperationStatus, PackedEngineFamily, PartialDiagnosticSeverity,
    PatchBackTransform, SecretRef, SemanticErrorCode, redact_for_log_or_report, stable_json,
};

mod seed_profiles;
mod validate;

pub use seed_profiles::{
    alpha_readiness_profile_template, alpha_readiness_seed_bgi, alpha_readiness_seed_kirikiri_xp3,
    alpha_readiness_seed_rgss3, alpha_readiness_seed_siglus, alpha_readiness_seed_wolf,
    alpha_readiness_seeds,
};
pub use validate::validate_alpha_readiness_profile;

/// Schema version of the profile input. Bumped on any breaking field change.
pub const ALPHA_READINESS_PROFILE_SCHEMA_VERSION: &str = "0.1.0";
/// Schema version of the rendered capability summary.
pub const ALPHA_READINESS_SUMMARY_SCHEMA_VERSION: &str = "0.1.0";
/// Canonical spec-DAG node id every seed/template is authored for.
pub const ALPHA_READINESS_SOURCE_NODE_ID: &str = "KAIFUU-056";
/// Canonical profile-fixture glob the subset consumes.
pub const ALPHA_READINESS_PROFILE_GLOB: &str = "*.profile.json";

/// The support boundary surfaced in the rendered summary.
pub const ALPHA_READINESS_SUPPORT_BOUNDARY: &str = "The alpha readiness-profile subset states, per high-value packed/encrypted engine and per operation (identify, inventory, extract, patch, helper-key), the alpha capability level and helper/key gating. A rung is claimed only up to the engine's honest alpha ceiling — BGI / Ethornell is detector/profile-only and never claims an archive parser or patch support. An honestly-unsupported rung is the declared boundary, not a defect; a claimed rung missing its backing field is an in-profile bug. Profiles are generated from public synthetic fixtures and may be supplemented by a hash-only reference to a private-local aggregate report. No raw key material, private asset paths, decrypted scripts, helper dumps, or story filenames are ever serialized.";

// Profile input schema

/// The helper/key gating posture — the fifth "operation" every profile states.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AlphaHelperKeyStatus {
    pub key_status: LayeredAccessKeyMaterialStatus,
    /// Local-scheme reference to the key material (never raw key bytes).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub key_ref: Option<SecretRef>,
    pub helper_status: LayeredAccessHelperStatus,
    /// Stable helper id (never a local path / binary / memory dump).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub helper_id: Option<String>,
}

impl AlphaHelperKeyStatus {
    /// A profile that needs neither key material nor a helper.
    pub fn none_required() -> Self {
        Self {
            key_status: LayeredAccessKeyMaterialStatus::NotRequired,
            key_ref: None,
            helper_status: LayeredAccessHelperStatus::NotRequired,
            helper_id: None,
        }
    }

    /// A profile whose key material is resolved (characterized), no helper.
    pub fn resolved_key(key_ref: SecretRef) -> Self {
        Self {
            key_status: LayeredAccessKeyMaterialStatus::Resolved,
            key_ref: Some(key_ref),
            helper_status: LayeredAccessHelperStatus::NotRequired,
            helper_id: None,
        }
    }

    fn redacted_for_report(&self) -> Self {
        Self {
            key_status: self.key_status,
            key_ref: self.key_ref.clone(),
            helper_status: self.helper_status,
            helper_id: self.helper_id.as_deref().map(redact_for_log_or_report),
        }
    }
}

/// How a profile was generated. Public-synthetic is the baseline; a private
/// aggregate may SUPPLEMENT it via a hash/id-only reference (never a path).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AlphaReadinessProvenance {
    /// `true` when the profile was generated from committed public synthetic
    /// fixtures.
    pub from_public_synthetic_fixture: bool,
    /// Optional hash/id-only reference to a private-local aggregate report that
    /// supplements the public fixture. Never a filesystem path.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub private_aggregate_ref: Option<String>,
}

impl AlphaReadinessProvenance {
    pub fn public_synthetic() -> Self {
        Self {
            from_public_synthetic_fixture: true,
            private_aggregate_ref: None,
        }
    }

    /// A public profile SUPPLEMENTED by a private-local aggregate (ref-only).
    pub fn supplemented(private_aggregate_ref: impl Into<String>) -> Self {
        Self {
            from_public_synthetic_fixture: true,
            private_aggregate_ref: Some(private_aggregate_ref.into()),
        }
    }

    fn redacted_for_report(&self) -> Self {
        Self {
            from_public_synthetic_fixture: self.from_public_synthetic_fixture,
            private_aggregate_ref: self
                .private_aggregate_ref
                .as_deref()
                .map(redact_for_log_or_report),
        }
    }
}

/// One alpha readiness profile: the per-operation capability posture of a single
/// packed/encrypted engine in the alpha subset.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AlphaReadinessProfile {
    pub schema_version: String,
    /// Stable profile id (synthetic; no retail names or local paths).
    pub profile_id: String,
    /// Stable id of the backing public synthetic fixture.
    pub fixture_id: String,
    /// The spec-DAG node id this profile is authored for (``).
    pub source_node_id: String,
    /// The prerequisite proof-node/artifact this subset entry relies on.
    pub prerequisite_proof: String,
    pub engine_family: PackedEngineFamily,
    /// Per-operation capability posture (identify / inventory / extract /
    /// patch). `adapterId` is a synthetic engine id, never a path.
    pub capabilities: AdapterCapabilityMatrix,
    /// The fifth operation: helper/key gating.
    pub helper_key: AlphaHelperKeyStatus,
    /// The patch-back write mode. A claimed `patch` rung REQUIRES a real write
    /// mode ([`PatchBackTransform::RepackArchive`]); otherwise `Unsupported`.
    pub patch_back: PatchBackTransform,
    pub provenance: AlphaReadinessProvenance,
}

impl AlphaReadinessProfile {
    pub(super) fn synthetic_adapter_id(family: PackedEngineFamily) -> String {
        format!("kaifuu.packed.{}", family.as_str())
    }
}

// Findings + failure classification (the mechanical distinction)

/// Distinguishes an unknown / out-of-profile semantic boundary from a defect
/// inside a claimed-support profile.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ReadinessFailureClass {
    /// A semantic boundary that is NOT a defect (unknown engine, a claim past
    /// the engine family's theoretical ceiling).
    OutOfProfile,
    /// A defect inside claimed support (a claimed rung missing its backing).
    InProfileBug,
}

impl ReadinessFailureClass {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::OutOfProfile => "out_of_profile",
            Self::InProfileBug => "in_profile_bug",
        }
    }
}

/// A structured validation finding — never prose, never silent.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AlphaReadinessFinding {
    pub code: String,
    pub severity: PartialDiagnosticSeverity,
    pub failure_class: ReadinessFailureClass,
    pub field: String,
    pub message: String,
    pub semantic_code: String,
}

impl AlphaReadinessFinding {
    fn redacted_for_report(&self) -> Self {
        Self {
            code: redact_for_log_or_report(&self.code),
            severity: self.severity,
            failure_class: self.failure_class,
            field: redact_for_log_or_report(&self.field),
            message: redact_for_log_or_report(&self.message),
            semantic_code: self.semantic_code.clone(),
        }
    }
}

// Per-profile validation entry

/// Per-operation status snapshot as recorded in the entry (the rendered row).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AlphaOperationStatuses {
    pub identify: String,
    pub inventory: String,
    pub extract: String,
    pub patch: String,
    /// Combined helper-key posture kind (e.g. `resolved/not_required`).
    pub helper_key: String,
}

impl AlphaOperationStatuses {
    fn from(matrix: &AdapterCapabilityMatrix, helper_key: &AlphaHelperKeyStatus) -> Self {
        Self {
            identify: matrix.identify.kind_str().to_string(),
            inventory: matrix.inventory.kind_str().to_string(),
            extract: matrix.extract.kind_str().to_string(),
            patch: matrix.patch.kind_str().to_string(),
            helper_key: format!(
                "{}/{}",
                key_status_str(helper_key.key_status),
                helper_status_str(helper_key.helper_status)
            ),
        }
    }
}

fn key_status_str(status: LayeredAccessKeyMaterialStatus) -> &'static str {
    match status {
        LayeredAccessKeyMaterialStatus::NotRequired => "not_required",
        LayeredAccessKeyMaterialStatus::Resolved => "resolved",
        LayeredAccessKeyMaterialStatus::Missing => "missing",
        LayeredAccessKeyMaterialStatus::HelperGated => "helper_gated",
    }
}

fn helper_status_str(status: LayeredAccessHelperStatus) -> &'static str {
    match status {
        LayeredAccessHelperStatus::NotRequired => "not_required",
        LayeredAccessHelperStatus::Available => "available",
        LayeredAccessHelperStatus::Unavailable => "unavailable",
    }
}

/// The validated report entry for one profile.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AlphaReadinessEntry {
    pub profile_id: String,
    pub fixture_id: String,
    pub source_node_id: String,
    pub prerequisite_proof: String,
    pub engine_family: PackedEngineFamily,
    pub operations: AlphaOperationStatuses,
    /// The highest capability rung the profile claims as fully `supported`
    /// (strict — `partial` does not count). `None` when nothing is supported.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub highest_supported_level: Option<CapabilityLevel>,
    /// `true` iff the engine's honest ceiling is detector/profile-only
    /// (`identify` supported, every higher rung unsupported).
    pub detector_only: bool,
    pub helper_key: AlphaHelperKeyStatus,
    pub patch_back: PatchBackTransform,
    pub provenance: AlphaReadinessProvenance,
    pub status: OperationStatus,
    pub out_of_profile_finding_count: u64,
    pub in_profile_bug_count: u64,
    pub findings: Vec<AlphaReadinessFinding>,
}

impl AlphaReadinessEntry {
    fn redacted_for_report(&self) -> Self {
        Self {
            profile_id: redact_for_log_or_report(&self.profile_id),
            fixture_id: redact_for_log_or_report(&self.fixture_id),
            source_node_id: redact_for_log_or_report(&self.source_node_id),
            prerequisite_proof: redact_for_log_or_report(&self.prerequisite_proof),
            engine_family: self.engine_family,
            operations: self.operations.clone(),
            highest_supported_level: self.highest_supported_level,
            detector_only: self.detector_only,
            helper_key: self.helper_key.redacted_for_report(),
            patch_back: self.patch_back,
            provenance: self.provenance.redacted_for_report(),
            status: self.status.clone(),
            out_of_profile_finding_count: self.out_of_profile_finding_count,
            in_profile_bug_count: self.in_profile_bug_count,
            findings: self
                .findings
                .iter()
                .map(AlphaReadinessFinding::redacted_for_report)
                .collect(),
        }
    }
}

// Detailed validation report (findings surfaced, redacted)

/// The detailed alpha-readiness validation report: every profile's entry with
/// its full, classified finding list. The rendered [`AlphaCapabilitySummary`]
/// is the README-safe reduction of this; the report is the diagnostic artifact.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AlphaReadinessValidationReport {
    pub schema_version: String,
    pub support_boundary: String,
    pub status: OperationStatus,
    pub profile_count: u64,
    pub passed_count: u64,
    pub failed_count: u64,
    pub entries: Vec<AlphaReadinessEntry>,
}

impl AlphaReadinessValidationReport {
    pub fn entry(&self, profile_id: &str) -> Option<&AlphaReadinessEntry> {
        self.entries
            .iter()
            .find(|entry| entry.profile_id == profile_id)
    }

    pub fn redacted_for_report(&self) -> Self {
        Self {
            schema_version: self.schema_version.clone(),
            support_boundary: redact_for_log_or_report(&self.support_boundary),
            status: self.status.clone(),
            profile_count: self.profile_count,
            passed_count: self.passed_count,
            failed_count: self.failed_count,
            entries: self
                .entries
                .iter()
                .map(AlphaReadinessEntry::redacted_for_report)
                .collect(),
        }
    }

    pub fn stable_json(&self) -> KaifuuResult<String> {
        stable_json(&self.redacted_for_report())
    }
}

/// Validate a slice of profiles into a detailed report.
pub fn validate_alpha_readiness_profiles(
    profiles: &[AlphaReadinessProfile],
) -> AlphaReadinessValidationReport {
    let entries: Vec<AlphaReadinessEntry> = profiles
        .iter()
        .map(validate_alpha_readiness_profile)
        .collect();
    let passed_count = entries
        .iter()
        .filter(|e| matches!(e.status, OperationStatus::Passed))
        .count() as u64;
    let failed_count = entries.len() as u64 - passed_count;
    let status = if failed_count == 0 {
        OperationStatus::Passed
    } else {
        OperationStatus::Failed
    };
    AlphaReadinessValidationReport {
        schema_version: ALPHA_READINESS_PROFILE_SCHEMA_VERSION.to_string(),
        support_boundary: ALPHA_READINESS_SUPPORT_BOUNDARY.to_string(),
        status,
        profile_count: entries.len() as u64,
        passed_count,
        failed_count,
        entries,
    }
}

/// Read every `*.profile.json` under `dir` (sorted), validate each into a
/// detailed report. A malformed fixture becomes a failed entry, never a hard
/// error.
pub fn validate_alpha_readiness_dir(dir: &Path) -> KaifuuResult<AlphaReadinessValidationReport> {
    let mut files: Vec<std::path::PathBuf> = Vec::new();
    for entry in std::fs::read_dir(dir)? {
        let path = entry?.path();
        if path.is_file()
            && path
                .file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| name.ends_with(".profile.json"))
        {
            files.push(path);
        }
    }
    files.sort();

    let mut entries: Vec<AlphaReadinessEntry> = Vec::with_capacity(files.len());
    for path in &files {
        let file_name = path
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("<unknown>");
        match crate::read_json::<AlphaReadinessProfile>(path) {
            Ok(profile) => entries.push(validate_alpha_readiness_profile(&profile)),
            Err(error) => entries.push(malformed_entry(file_name, &error.to_string())),
        }
    }

    let passed_count = entries
        .iter()
        .filter(|e| matches!(e.status, OperationStatus::Passed))
        .count() as u64;
    let failed_count = entries.len() as u64 - passed_count;
    let status = if failed_count == 0 {
        OperationStatus::Passed
    } else {
        OperationStatus::Failed
    };
    Ok(AlphaReadinessValidationReport {
        schema_version: ALPHA_READINESS_PROFILE_SCHEMA_VERSION.to_string(),
        support_boundary: ALPHA_READINESS_SUPPORT_BOUNDARY.to_string(),
        status,
        profile_count: entries.len() as u64,
        passed_count,
        failed_count,
        entries,
    })
}

fn malformed_entry(file_name: &str, error: &str) -> AlphaReadinessEntry {
    AlphaReadinessEntry {
        profile_id: format!("{file_name}-unparseable"),
        fixture_id: file_name.to_string(),
        source_node_id: ALPHA_READINESS_SOURCE_NODE_ID.to_string(),
        prerequisite_proof: String::new(),
        engine_family: PackedEngineFamily::Unknown,
        operations: AlphaOperationStatuses {
            identify: "unsupported".to_string(),
            inventory: "unsupported".to_string(),
            extract: "unsupported".to_string(),
            patch: "unsupported".to_string(),
            helper_key: "not_required/not_required".to_string(),
        },
        highest_supported_level: None,
        detector_only: false,
        helper_key: AlphaHelperKeyStatus::none_required(),
        patch_back: PatchBackTransform::Unsupported,
        provenance: AlphaReadinessProvenance::public_synthetic(),
        status: OperationStatus::Failed,
        out_of_profile_finding_count: 1,
        in_profile_bug_count: 0,
        findings: vec![validate::finding(
            "alpha.readiness.fixture_unparseable",
            PartialDiagnosticSeverity::P0,
            ReadinessFailureClass::OutOfProfile,
            "fixture",
            format!(
                "profile fixture could not be parsed: {}",
                redact_for_log_or_report(error)
            ),
            SemanticErrorCode::UnknownEngineVariant,
        )],
    }
}

// Renderer — the alpha capability-level summary

/// One rendered row: an engine's five operation statuses + its ceiling.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AlphaCapabilityRow {
    pub engine_family: PackedEngineFamily,
    pub profile_id: String,
    pub operations: AlphaOperationStatuses,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub highest_supported_level: Option<CapabilityLevel>,
    pub detector_only: bool,
    pub status: OperationStatus,
    pub out_of_profile_finding_count: u64,
    pub in_profile_bug_count: u64,
}

/// The rendered, README-safe alpha capability-level summary. Counts, kinds, and
/// synthetic ids only — never keys, paths, decrypted content, or filenames.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AlphaCapabilitySummary {
    pub schema_version: String,
    pub support_boundary: String,
    pub status: OperationStatus,
    pub engine_count: u64,
    /// Engines whose honest ceiling is detector/profile-only (`identify`).
    pub detector_only_count: u64,
    /// Engines claiming a usable patch posture (`patch` supported or partial).
    pub patch_capable_count: u64,
    pub rows: Vec<AlphaCapabilityRow>,
}

impl AlphaCapabilitySummary {
    pub fn row(&self, engine_family: PackedEngineFamily) -> Option<&AlphaCapabilityRow> {
        self.rows
            .iter()
            .find(|row| row.engine_family == engine_family)
    }

    fn redacted_for_report(&self) -> Self {
        Self {
            schema_version: self.schema_version.clone(),
            support_boundary: redact_for_log_or_report(&self.support_boundary),
            status: self.status.clone(),
            engine_count: self.engine_count,
            detector_only_count: self.detector_only_count,
            patch_capable_count: self.patch_capable_count,
            rows: self
                .rows
                .iter()
                .map(|row| AlphaCapabilityRow {
                    engine_family: row.engine_family,
                    profile_id: redact_for_log_or_report(&row.profile_id),
                    operations: row.operations.clone(),
                    highest_supported_level: row.highest_supported_level,
                    detector_only: row.detector_only,
                    status: row.status.clone(),
                    out_of_profile_finding_count: row.out_of_profile_finding_count,
                    in_profile_bug_count: row.in_profile_bug_count,
                })
                .collect(),
        }
    }

    pub fn stable_json(&self) -> KaifuuResult<String> {
        stable_json(&self.redacted_for_report())
    }

    /// A README-safe ASCII table. Names engines and capability KINDS only.
    pub fn render_text_table(&self) -> String {
        use std::fmt::Write as _;
        let mut out = String::new();
        out.push_str("engine        | identify | inventory | extract | patch | helper-key\n");
        out.push_str("--------------+----------+-----------+---------+-------+-----------\n");
        for row in &self.rows {
            let _ = writeln!(
                out,
                "{:<13} | {:<8} | {:<9} | {:<7} | {:<5} | {}",
                row.engine_family.as_str(),
                row.operations.identify,
                row.operations.inventory,
                row.operations.extract,
                row.operations.patch,
                row.operations.helper_key,
            );
        }
        out
    }
}

/// Validate every profile and render the alpha capability-level summary. The
/// summary status is `Failed` iff any profile fails validation.
pub fn render_alpha_capability_summary(
    profiles: &[AlphaReadinessProfile],
) -> AlphaCapabilitySummary {
    let entries: Vec<AlphaReadinessEntry> = profiles
        .iter()
        .map(validate_alpha_readiness_profile)
        .collect();

    let detector_only_count = entries.iter().filter(|e| e.detector_only).count() as u64;
    // "patch capable" = the profile CLAIMS patch (supported or partial); the
    // recorded kind is the single source of truth.
    let patch_capable_count = entries
        .iter()
        .filter(|e| e.operations.patch != "unsupported")
        .count() as u64;
    let status = if entries
        .iter()
        .all(|e| matches!(e.status, OperationStatus::Passed))
    {
        OperationStatus::Passed
    } else {
        OperationStatus::Failed
    };

    let rows = entries
        .iter()
        .map(|entry| AlphaCapabilityRow {
            engine_family: entry.engine_family,
            profile_id: entry.profile_id.clone(),
            operations: entry.operations.clone(),
            highest_supported_level: entry.highest_supported_level,
            detector_only: entry.detector_only,
            status: entry.status.clone(),
            out_of_profile_finding_count: entry.out_of_profile_finding_count,
            in_profile_bug_count: entry.in_profile_bug_count,
        })
        .collect();

    AlphaCapabilitySummary {
        schema_version: ALPHA_READINESS_SUMMARY_SCHEMA_VERSION.to_string(),
        support_boundary: ALPHA_READINESS_SUPPORT_BOUNDARY.to_string(),
        status,
        engine_count: entries.len() as u64,
        detector_only_count,
        patch_capable_count,
        rows,
    }
}

// Directory validation (generation from a public synthetic fixture tree)

/// Read every `*.profile.json` under `dir` (sorted), validate each, and render
/// the aggregate alpha capability summary. A malformed fixture is a failed row,
/// never a hard error.
pub fn render_alpha_capability_summary_dir(dir: &Path) -> KaifuuResult<AlphaCapabilitySummary> {
    let mut files: Vec<std::path::PathBuf> = Vec::new();
    for entry in std::fs::read_dir(dir)? {
        let path = entry?.path();
        if path.is_file()
            && path
                .file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| name.ends_with(".profile.json"))
        {
            files.push(path);
        }
    }
    files.sort();

    let mut profiles: Vec<AlphaReadinessProfile> = Vec::with_capacity(files.len());
    let mut malformed: Vec<AlphaCapabilityRow> = Vec::new();
    for path in &files {
        let file_name = path
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("<unknown>")
            .to_string();
        match crate::read_json::<AlphaReadinessProfile>(path) {
            Ok(profile) => profiles.push(profile),
            Err(error) => malformed.push(malformed_row(&file_name, &error.to_string())),
        }
    }

    let mut summary = render_alpha_capability_summary(&profiles);
    if !malformed.is_empty() {
        summary.status = OperationStatus::Failed;
        summary.rows.extend(malformed);
        summary.engine_count = summary.rows.len() as u64;
    }
    Ok(summary)
}

fn malformed_row(file_name: &str, error: &str) -> AlphaCapabilityRow {
    AlphaCapabilityRow {
        engine_family: PackedEngineFamily::Unknown,
        profile_id: format!(
            "{file_name}-unparseable: {}",
            redact_for_log_or_report(error)
        ),
        operations: AlphaOperationStatuses {
            identify: "unsupported".to_string(),
            inventory: "unsupported".to_string(),
            extract: "unsupported".to_string(),
            patch: "unsupported".to_string(),
            helper_key: "not_required/not_required".to_string(),
        },
        highest_supported_level: None,
        detector_only: false,
        status: OperationStatus::Failed,
        out_of_profile_finding_count: 1,
        in_profile_bug_count: 0,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn fixtures_dir() -> PathBuf {
        crate::test_manifest_dir()
            .join("../..")
            .join("fixtures/kaifuu/alpha-readiness")
    }

    fn seeds_dir() -> PathBuf {
        fixtures_dir().join("seeds")
    }

    fn negative_dir() -> PathBuf {
        fixtures_dir().join("negative")
    }

    #[test]
    fn every_seed_states_all_five_operations_and_passes() {
        for profile in alpha_readiness_seeds() {
            let entry = validate_alpha_readiness_profile(&profile);
            assert_eq!(
                entry.status,
                OperationStatus::Passed,
                "seed {} failed: {:?}",
                profile.profile_id,
                entry.findings
            );
            // All five operation statuses are populated (non-empty kinds).
            assert!(!entry.operations.identify.is_empty());
            assert!(!entry.operations.inventory.is_empty());
            assert!(!entry.operations.extract.is_empty());
            assert!(!entry.operations.patch.is_empty());
            assert!(!entry.operations.helper_key.is_empty());
        }
    }

    #[test]
    fn all_five_subset_engines_are_seeded() {
        let families: Vec<PackedEngineFamily> = alpha_readiness_seeds()
            .iter()
            .map(|p| p.engine_family)
            .collect();
        for expected in [
            PackedEngineFamily::Siglus,
            PackedEngineFamily::KirikiriXp3,
            PackedEngineFamily::Wolf,
            PackedEngineFamily::Rgss3,
            PackedEngineFamily::Bgi,
        ] {
            assert!(
                families.contains(&expected),
                "missing seed for {expected:?}"
            );
        }
    }

    #[test]
    fn bgi_is_detector_profile_only_no_parser_or_patch() {
        let entry = validate_alpha_readiness_profile(&alpha_readiness_seed_bgi());
        assert_eq!(entry.status, OperationStatus::Passed);
        assert!(entry.detector_only, "BGI must be detector/profile-only");
        assert_eq!(
            entry.highest_supported_level,
            Some(CapabilityLevel::Identify)
        );
        // No archive parser (inventory/extract) and no patch support.
        assert_eq!(entry.operations.inventory, "unsupported");
        assert_eq!(entry.operations.extract, "unsupported");
        assert_eq!(entry.operations.patch, "unsupported");
        assert_eq!(entry.patch_back, PatchBackTransform::Unsupported);
    }

    #[test]
    fn seeds_round_trip_through_public_synthetic_json() {
        for profile in alpha_readiness_seeds() {
            let json = stable_json(&profile).expect("serialize seed");
            let parsed: AlphaReadinessProfile =
                serde_json::from_str(&json).expect("round trip seed");
            assert_eq!(parsed, profile);
            assert!(profile.provenance.from_public_synthetic_fixture);
        }
    }

    #[test]
    fn profile_generates_from_public_synthetic_fixture_dir() {
        let summary = render_alpha_capability_summary_dir(&seeds_dir())
            .expect("summary renders without environmental error");
        assert_eq!(
            summary.status,
            OperationStatus::Passed,
            "rows: {:?}",
            summary.rows
        );
        assert_eq!(summary.engine_count, 5);
        // BGI is the sole detector-only engine in the subset.
        assert!(summary.detector_only_count >= 1);
        assert!(summary.patch_capable_count >= 1);
    }

    #[test]
    fn private_local_aggregate_supplement_is_ref_only_and_valid() {
        let mut profile = alpha_readiness_seed_siglus();
        profile.provenance =
            AlphaReadinessProvenance::supplemented("aggregate:siglus-2026-07-04-abc123");
        let entry = validate_alpha_readiness_profile(&profile);
        assert_eq!(entry.status, OperationStatus::Passed);
        let json = stable_json(&entry).unwrap();
        assert!(!json.contains("/home/"));
    }

    #[test]
    fn private_aggregate_path_is_rejected() {
        let mut profile = alpha_readiness_seed_siglus();
        profile.provenance =
            AlphaReadinessProvenance::supplemented("/home/trevor/private/aggregate.json");
        let entry = validate_alpha_readiness_profile(&profile);
        assert_eq!(entry.status, OperationStatus::Failed);
        assert!(
            entry
                .findings
                .iter()
                .any(|f| f.code == "alpha.readiness.provenance_ref_invalid")
        );
    }

    #[test]
    fn missing_fixture_field_fails() {
        let mut profile = alpha_readiness_seed_wolf();
        profile.fixture_id = String::new();
        let entry = validate_alpha_readiness_profile(&profile);
        assert_eq!(entry.status, OperationStatus::Failed);
        assert!(
            entry
                .findings
                .iter()
                .any(|f| f.code == "alpha.readiness.fixture_missing")
        );
    }

    #[test]
    fn claimed_patch_without_write_mode_fails_as_in_profile_bug() {
        let mut profile = alpha_readiness_seed_siglus();
        // Siglus claims patch, but drop the patch-back write mode.
        profile.patch_back = PatchBackTransform::Unsupported;
        let entry = validate_alpha_readiness_profile(&profile);
        assert_eq!(entry.status, OperationStatus::Failed);
        let finding = entry
            .findings
            .iter()
            .find(|f| f.code == "alpha.readiness.patch_back_missing_for_claimed_patch")
            .expect("patch-back finding");
        assert_eq!(finding.failure_class, ReadinessFailureClass::InProfileBug);
    }

    #[test]
    fn claimed_extract_without_key_fails_for_key_required_engine() {
        let mut profile = alpha_readiness_seed_siglus();
        profile.helper_key = AlphaHelperKeyStatus::none_required();
        let entry = validate_alpha_readiness_profile(&profile);
        assert_eq!(entry.status, OperationStatus::Failed);
        assert!(entry.findings.iter().any(|f| {
            f.code == "alpha.readiness.key_missing_for_claimed_extract"
                && f.failure_class == ReadinessFailureClass::InProfileBug
        }));
    }

    #[test]
    fn resolved_key_without_ref_fails() {
        let mut profile = alpha_readiness_seed_rgss3();
        profile.helper_key.key_ref = None;
        let entry = validate_alpha_readiness_profile(&profile);
        assert_eq!(entry.status, OperationStatus::Failed);
        assert!(
            entry
                .findings
                .iter()
                .any(|f| f.code == "alpha.readiness.key_ref_missing")
        );
    }

    #[test]
    fn required_helper_without_id_fails() {
        let mut profile = alpha_readiness_seed_wolf();
        profile.helper_key.helper_status = LayeredAccessHelperStatus::Available;
        let entry = validate_alpha_readiness_profile(&profile);
        assert_eq!(entry.status, OperationStatus::Failed);
        assert!(
            entry
                .findings
                .iter()
                .any(|f| f.code == "alpha.readiness.helper_id_missing")
        );
    }

    #[test]
    fn unknown_engine_is_out_of_profile_not_a_bug() {
        let mut profile = alpha_readiness_seed_bgi();
        profile.engine_family = PackedEngineFamily::Unknown;
        let entry = validate_alpha_readiness_profile(&profile);
        assert_eq!(entry.status, OperationStatus::Failed);
        assert_eq!(entry.out_of_profile_finding_count, 1);
        assert_eq!(entry.in_profile_bug_count, 0);
        assert!(entry.findings.iter().any(|f| {
            f.code == "alpha.readiness.unknown_engine_family"
                && f.failure_class == ReadinessFailureClass::OutOfProfile
        }));
    }

    #[test]
    fn overclaim_past_family_ceiling_is_out_of_profile() {
        // RPG Maker MV/MZ media has an `identify` ceiling; claim patch on it.
        let profile = AlphaReadinessProfile {
            schema_version: ALPHA_READINESS_PROFILE_SCHEMA_VERSION.to_string(),
            profile_id: "packed/mvmz/overclaim".to_string(),
            fixture_id: "alpha.readiness.mvmz-overclaim".to_string(),
            source_node_id: ALPHA_READINESS_SOURCE_NODE_ID.to_string(),
            prerequisite_proof: "mv_mz_readiness".to_string(),
            engine_family: PackedEngineFamily::RpgMakerMvMzMedia,
            capabilities: AdapterCapabilityMatrix::up_to(
                "kaifuu.packed.rpg_maker_mv_mz_media",
                CapabilityLevel::Patch,
                "n/a",
            ),
            helper_key: AlphaHelperKeyStatus::resolved_key(seed_profiles::secret(
                "local-secret:rpgmaker-mv-asset-key",
            )),
            patch_back: PatchBackTransform::RepackArchive,
            provenance: AlphaReadinessProvenance::public_synthetic(),
        };
        let entry = validate_alpha_readiness_profile(&profile);
        assert_eq!(entry.status, OperationStatus::Failed);
        assert!(entry.findings.iter().any(|f| {
            f.code == "alpha.readiness.capability_overclaim"
                && f.failure_class == ReadinessFailureClass::OutOfProfile
        }));
    }

    #[test]
    fn honest_unsupported_rung_is_not_a_finding() {
        // BGI honestly declares inventory/extract/patch unsupported — that is
        // the boundary, not a defect: zero findings, and it passes.
        let entry = validate_alpha_readiness_profile(&alpha_readiness_seed_bgi());
        assert!(entry.findings.is_empty());
        assert_eq!(entry.in_profile_bug_count, 0);
        assert_eq!(entry.out_of_profile_finding_count, 0);
    }

    #[test]
    fn template_is_valid_and_conservative() {
        let template = alpha_readiness_profile_template();
        let entry = validate_alpha_readiness_profile(&template);
        assert_eq!(entry.status, OperationStatus::Passed);
        assert_eq!(
            entry.highest_supported_level,
            Some(CapabilityLevel::Identify)
        );
        assert!(entry.detector_only);
    }

    #[test]
    fn renderer_covers_all_engines_and_round_trips() {
        let summary = render_alpha_capability_summary(&alpha_readiness_seeds());
        assert_eq!(summary.status, OperationStatus::Passed);
        assert_eq!(summary.engine_count, 5);
        assert!(summary.row(PackedEngineFamily::Bgi).unwrap().detector_only);
        let json = summary.stable_json().expect("stable json");
        assert!(json.ends_with('\n'));
        let parsed: AlphaCapabilitySummary = serde_json::from_str(&json).expect("round trip");
        assert_eq!(parsed.engine_count, 5);
        // Text table names engines + kinds only.
        let table = summary.render_text_table();
        assert!(table.contains("siglus"));
        assert!(table.contains("bgi"));
    }

    #[test]
    fn summary_serializes_no_keys_paths_or_filenames() {
        let mut profiles = alpha_readiness_seeds();
        // Inject a path into an id; it must be redacted, never serialized raw.
        profiles[0].profile_id = "/home/trevor/private/scene/000.ss".to_string();
        let summary = render_alpha_capability_summary(&profiles);
        let json = summary.stable_json().unwrap();
        assert!(!json.contains("/home/"));
        assert!(json.contains("[REDACTED:"));
        // The rendered summary never carries a raw key ref at all (only kinds).
        assert!(!json.contains("local-secret:"));
    }

    #[test]
    fn key_ref_never_serializes_raw_key_bytes() {
        // The profile serializes the local-secret REF (allowed), never raw key
        // material, and never a local path.
        let json = stable_json(&alpha_readiness_seed_siglus()).unwrap();
        assert!(json.contains("local-secret:siglus-scene-static-key"));
        assert!(!json.contains("/home/"));
    }

    #[test]
    fn malformed_fixture_is_a_failed_row_not_a_panic() {
        let summary = render_alpha_capability_summary_dir(&negative_dir())
            .expect("negative dir renders without environmental error");
        assert_eq!(summary.status, OperationStatus::Failed);
        assert!(
            summary
                .rows
                .iter()
                .all(|r| r.status == OperationStatus::Failed)
        );
    }
}
