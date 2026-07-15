//! Alpha public encrypted-readiness evidence generator.
//! This module COMPOSES the packed-engine readiness validator
//! ([`crate::packed_engine_readiness`]) — it does NOT reimplement readiness
//! logic. The generator reads a single *alpha-encrypted fixture directory*
//! that holds two synthetic, public input families:
//! 1. packed-engine readiness **profile fixtures** (`*.profile.json`, the exact
//!    [`PackedEngineReadinessProfile`] schema), and
//! 2. synthetic **patch artifacts** (`*.patch.json`, [`AlphaEncryptedPatchArtifact`])
//!    that pair a `profileId` with a hash-only patch-result reference.
//!    It runs [`validate_packed_engine_readiness_dir`] over the directory to
//!    obtain the [`PackedReadinessValidationReport`], then joins each
//!    validated profile entry with its patch artifact to emit an
//!    [`AlphaEncryptedReadinessReport`] — readiness EVIDENCE, never a production
//!    patch-support claim.
//! # The mechanical line (not prose)
//! The profile-ready-vs-readiness-only posture is taken VERBATIM from the
//! validator's mechanically-derived
//! [`PackedReadinessOutcome`]/[`PackedReadinessPosture`]; this layer never
//! re-derives it. On top of that, the generator enforces three mechanical
//! join rules, each a structured [`AlphaEncryptedFinding`], never prose:
//! - a profile-ready entry whose effective outcome reaches `extract`/`patch`
//!   MUST carry a patch-result reference (`patch_result_ref_missing` otherwise);
//! - a readiness-only entry MUST NOT carry a patch-result reference
//!   (`readiness_only_claims_patch` otherwise — this is the
//!   "readiness overstated as production support" guard);
//! - every validation failure for a profile propagates as a blocking
//!   `validation_failed` finding (the generator can never bless a profile the
//!   validator rejected).
//! # Evidence is synthetic, redacted, hash-only
//! Inputs and outputs carry NO raw retail bytes, NO raw key material, NO
//! decrypted scripts, NO helper dumps, and NO private paths: only synthetic
//! profile/fixture/helper ids, local-scheme [`SecretRef`] key references, and
//! `sha256:` content/output/report hashes. Reports are funnelled through
//! [`redact_for_log_or_report`]. The README-safe
//! [`AlphaEncryptedReadinessSummary`] reduces further to aggregate counts,
//! covered engine families, and the report hash — it names no asset, helper,
//! key, or patch id at all.

use std::collections::BTreeMap;
use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::packed_engine_readiness::{
    PackedEngineReadinessProfile, PackedReadinessEntryReport, PackedReadinessValidationReport,
    PackedTransformStack, validate_packed_engine_readiness_dir,
};
use crate::{
    CapabilityLevel, KaifuuResult, LayeredAccessHelperStatus, LayeredAccessKeyMaterialStatus,
    OperationStatus, PackedEngineFamily, PackedReadinessOutcome, PackedReadinessPosture,
    PartialDiagnosticSeverity, PatchBackTransform, ProofHash, SecretRef, SemanticErrorCode,
    read_json, redact_for_log_or_report, sha256_hash_bytes, stable_json,
};

/// Schema version of the synthetic patch-artifact input.
pub const ALPHA_ENCRYPTED_PATCH_ARTIFACT_SCHEMA_VERSION: &str = "0.1.0";
/// Schema version of the generated full evidence report.
pub const ALPHA_ENCRYPTED_READINESS_REPORT_SCHEMA_VERSION: &str = "0.1.0";
/// Schema version of the README-safe summary artifact.
pub const ALPHA_ENCRYPTED_READINESS_SUMMARY_SCHEMA_VERSION: &str = "0.1.0";

/// Glob the generator reads for synthetic patch artifacts.
pub const ALPHA_ENCRYPTED_PATCH_ARTIFACT_GLOB: &str = "*.patch.json";

/// The support boundary stamped into every report and summary — the
/// readiness-evidence-not-production-support line.
pub const ALPHA_ENCRYPTED_READINESS_SUPPORT_BOUNDARY: &str = "Alpha encrypted-readiness evidence composes the KAIFUU-103 packed-engine readiness validator output with synthetic packed-engine profile fixtures and synthetic patch artifacts. It is readiness EVIDENCE that a transform stack, key/helper gating, and patch-back surface are recognized — it is NOT a production patch-support claim. A readiness-only posture (helper-gated, missing key material, or media transform) never carries a patch result. Every input is synthetic and public; artifacts carry only ids, counts, and sha256 hashes — never key material, plaintext content, helper memory, or local paths.";

// Synthetic patch-artifact input

/// A synthetic, public patch artifact: a hash-only reference to a patch result
/// produced for one readiness profile. Carries NO patched bytes and NO
/// decrypted content — only the patch-result id, the touched synthetic asset
/// ids, and the `sha256:` output hash.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AlphaEncryptedPatchArtifact {
    pub schema_version: String,
    /// Stable patch-result id (synthetic; no retail names or local paths).
    pub patch_result_id: String,
    /// The `profileId` of the readiness profile this patch result is for.
    pub profile_id: String,
    /// The spec-DAG node id this artifact is authored for (``).
    pub source_node_id: String,
    /// Outcome of the synthetic patch run.
    pub status: OperationStatus,
    /// The patch-back transform exercised (must match the profile's).
    pub patch_back: PatchBackTransform,
    /// Synthetic in-archive asset ids the patch touched (never local paths).
    pub touched_assets: Vec<String>,
    /// `sha256:` hash of the synthetic patched output (never raw bytes).
    pub output_hash: ProofHash,
}

// Findings

/// A structured generator finding — never prose, never silent.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AlphaEncryptedFinding {
    pub code: String,
    pub severity: PartialDiagnosticSeverity,
    pub field: String,
    pub message: String,
    pub semantic_code: String,
}

impl AlphaEncryptedFinding {
    fn redacted_for_report(&self) -> Self {
        Self {
            code: redact_for_log_or_report(&self.code),
            severity: self.severity,
            field: redact_for_log_or_report(&self.field),
            message: redact_for_log_or_report(&self.message),
            semantic_code: self.semantic_code.clone(),
        }
    }
}

fn finding(
    code: &str,
    severity: PartialDiagnosticSeverity,
    field: &str,
    message: String,
    semantic_code: SemanticErrorCode,
) -> AlphaEncryptedFinding {
    AlphaEncryptedFinding {
        code: code.to_string(),
        severity,
        field: field.to_string(),
        message,
        semantic_code: semantic_code.as_str().to_string(),
    }
}

// Report

/// The hash-only patch-result reference carried by a profile-ready entry.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AlphaEncryptedPatchResultRef {
    pub patch_result_id: String,
    pub status: OperationStatus,
    pub patch_back: PatchBackTransform,
    pub touched_asset_count: u64,
    pub output_hash: ProofHash,
}

impl AlphaEncryptedPatchResultRef {
    fn from_artifact(artifact: &AlphaEncryptedPatchArtifact) -> Self {
        Self {
            patch_result_id: artifact.patch_result_id.clone(),
            status: artifact.status.clone(),
            patch_back: artifact.patch_back,
            touched_asset_count: artifact.touched_assets.len() as u64,
            output_hash: artifact.output_hash.clone(),
        }
    }

    fn redacted_for_report(&self) -> Self {
        Self {
            patch_result_id: redact_for_log_or_report(&self.patch_result_id),
            status: self.status.clone(),
            patch_back: self.patch_back,
            touched_asset_count: self.touched_asset_count,
            output_hash: self.output_hash.clone(),
        }
    }
}

/// One alpha-encrypted readiness evidence entry — the full acceptance tuple:
/// profile id, fixture id, engine family, surface ids, helper id, key ref,
/// capability levels, patch-result ref, diagnostics, and content hash.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AlphaEncryptedReadinessEntry {
    pub profile_id: String,
    pub fixture_id: String,
    pub source_node_id: String,
    pub engine_family: PackedEngineFamily,
    pub transform_stack: PackedTransformStack,
    /// Synthetic in-archive surface (asset) ids drawn from the profile content.
    pub surface_ids: Vec<String>,
    pub declared_capability: CapabilityLevel,
    /// The mechanically-derived outcome (taken verbatim).
    pub effective_outcome: PackedReadinessOutcome,
    pub posture: PackedReadinessPosture,
    pub key_status: LayeredAccessKeyMaterialStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub key_ref: Option<SecretRef>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub key_requirement_id: Option<String>,
    pub helper_status: LayeredAccessHelperStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub helper_id: Option<String>,
    pub content_hash: ProofHash,
    pub content_entry_count: u64,
    /// Whether the validator passed this profile.
    pub validation_status: OperationStatus,
    /// Hash-only patch-result reference (present only for patch-capable
    /// profile-ready entries).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub patch_result: Option<AlphaEncryptedPatchResultRef>,
    pub status: OperationStatus,
    pub findings: Vec<AlphaEncryptedFinding>,
}

impl AlphaEncryptedReadinessEntry {
    fn redacted_for_report(&self) -> Self {
        Self {
            profile_id: redact_for_log_or_report(&self.profile_id),
            fixture_id: redact_for_log_or_report(&self.fixture_id),
            source_node_id: redact_for_log_or_report(&self.source_node_id),
            engine_family: self.engine_family,
            transform_stack: self.transform_stack,
            surface_ids: self
                .surface_ids
                .iter()
                .map(|id| redact_for_log_or_report(id))
                .collect(),
            declared_capability: self.declared_capability,
            effective_outcome: self.effective_outcome,
            posture: self.posture,
            key_status: self.key_status,
            key_ref: self.key_ref.clone(),
            key_requirement_id: self
                .key_requirement_id
                .as_deref()
                .map(redact_for_log_or_report),
            helper_status: self.helper_status,
            helper_id: self.helper_id.as_deref().map(redact_for_log_or_report),
            content_hash: self.content_hash.clone(),
            content_entry_count: self.content_entry_count,
            validation_status: self.validation_status.clone(),
            patch_result: self
                .patch_result
                .as_ref()
                .map(AlphaEncryptedPatchResultRef::redacted_for_report),
            status: self.status.clone(),
            findings: self
                .findings
                .iter()
                .map(AlphaEncryptedFinding::redacted_for_report)
                .collect(),
        }
    }
}

/// The mechanical proof that the validation report was consumed: its
/// status, posture counts, and a `sha256:` hash over its canonical
/// serialization.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConsumedValidationReport {
    pub schema_version: String,
    pub status: OperationStatus,
    pub profile_count: u64,
    pub profile_ready_count: u64,
    pub readiness_only_count: u64,
    pub report_hash: ProofHash,
}

/// The full alpha-encrypted readiness evidence report written to
/// `target/kaifuu/alpha-encrypted-readiness.json`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AlphaEncryptedReadinessReport {
    pub schema_version: String,
    pub source_node_id: String,
    pub support_boundary: String,
    pub status: OperationStatus,
    /// Proof the validator output was consumed (not prose).
    pub consumed_validation: ConsumedValidationReport,
    pub profile_count: u64,
    pub profile_ready_count: u64,
    pub readiness_only_count: u64,
    pub patch_evidence_count: u64,
    pub entries: Vec<AlphaEncryptedReadinessEntry>,
    /// Report-level findings (dangling patch artifacts, missing inputs,...).
    pub findings: Vec<AlphaEncryptedFinding>,
    /// `sha256:` hash over the canonical serialization of the entries.
    pub report_hash: ProofHash,
}

impl AlphaEncryptedReadinessReport {
    pub fn entry(&self, profile_id: &str) -> Option<&AlphaEncryptedReadinessEntry> {
        self.entries
            .iter()
            .find(|entry| entry.profile_id == profile_id)
    }

    /// Sorted, distinct engine families covered (README-safe).
    pub fn covered_families(&self) -> Vec<PackedEngineFamily> {
        let mut families: Vec<PackedEngineFamily> =
            self.entries.iter().map(|e| e.engine_family).collect();
        families.sort();
        families.dedup();
        families
    }

    pub fn redacted_for_report(&self) -> Self {
        Self {
            schema_version: self.schema_version.clone(),
            source_node_id: redact_for_log_or_report(&self.source_node_id),
            support_boundary: redact_for_log_or_report(&self.support_boundary),
            status: self.status.clone(),
            consumed_validation: self.consumed_validation.clone(),
            profile_count: self.profile_count,
            profile_ready_count: self.profile_ready_count,
            readiness_only_count: self.readiness_only_count,
            patch_evidence_count: self.patch_evidence_count,
            entries: self
                .entries
                .iter()
                .map(AlphaEncryptedReadinessEntry::redacted_for_report)
                .collect(),
            findings: self
                .findings
                .iter()
                .map(AlphaEncryptedFinding::redacted_for_report)
                .collect(),
            report_hash: self.report_hash.clone(),
        }
    }

    pub fn stable_json(&self) -> KaifuuResult<String> {
        stable_json(&self.redacted_for_report())
    }

    /// The README-safe summary: aggregate counts, covered families, and the
    /// report hash only. Names no asset, helper, key, or patch id.
    pub fn summary(&self) -> AlphaEncryptedReadinessSummary {
        AlphaEncryptedReadinessSummary {
            schema_version: ALPHA_ENCRYPTED_READINESS_SUMMARY_SCHEMA_VERSION.to_string(),
            source_node_id: self.source_node_id.clone(),
            support_boundary: self.support_boundary.clone(),
            evidence_kind: ALPHA_ENCRYPTED_EVIDENCE_KIND.to_string(),
            status: self.status.clone(),
            profile_count: self.profile_count,
            profile_ready_count: self.profile_ready_count,
            readiness_only_count: self.readiness_only_count,
            patch_evidence_count: self.patch_evidence_count,
            covered_engine_families: self
                .covered_families()
                .iter()
                .map(|family| family.as_str().to_string())
                .collect(),
            report_hash: self.report_hash.clone(),
        }
    }
}

/// The fixed evidence-kind discriminator stamped into the summary so README
/// consumers can never mistake it for a production support matrix.
pub const ALPHA_ENCRYPTED_EVIDENCE_KIND: &str = "readiness_evidence";

/// README-safe summary artifact written to
/// `target/kaifuu/alpha-encrypted-readiness.summary.json`. Carries ONLY
/// aggregate counts, covered engine families, and the report hash — no asset,
/// helper, key, or patch ids, no paths, no source text.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AlphaEncryptedReadinessSummary {
    pub schema_version: String,
    pub source_node_id: String,
    pub support_boundary: String,
    /// Always `readiness_evidence` — distinguishes evidence from production
    /// support.
    pub evidence_kind: String,
    pub status: OperationStatus,
    pub profile_count: u64,
    pub profile_ready_count: u64,
    pub readiness_only_count: u64,
    pub patch_evidence_count: u64,
    pub covered_engine_families: Vec<String>,
    pub report_hash: ProofHash,
}

impl AlphaEncryptedReadinessSummary {
    pub fn redacted_for_report(&self) -> Self {
        Self {
            schema_version: self.schema_version.clone(),
            source_node_id: redact_for_log_or_report(&self.source_node_id),
            support_boundary: redact_for_log_or_report(&self.support_boundary),
            evidence_kind: self.evidence_kind.clone(),
            status: self.status.clone(),
            profile_count: self.profile_count,
            profile_ready_count: self.profile_ready_count,
            readiness_only_count: self.readiness_only_count,
            patch_evidence_count: self.patch_evidence_count,
            covered_engine_families: self.covered_engine_families.clone(),
            report_hash: self.report_hash.clone(),
        }
    }

    pub fn stable_json(&self) -> KaifuuResult<String> {
        stable_json(&self.redacted_for_report())
    }
}

// Generator

/// True iff the effective outcome is a patch-capable profile-ready rung
/// (`extract`/`patch`) that therefore REQUIRES a patch-result reference.
fn requires_patch_evidence(outcome: PackedReadinessOutcome) -> bool {
    matches!(
        outcome,
        PackedReadinessOutcome::Extract | PackedReadinessOutcome::Patch
    )
}

/// Build one evidence entry by joining a validator entry with its
/// (optional) profile fixture and patch artifacts. Pure; every inconsistency is
/// a structured finding.
fn build_entry(
    validation_entry: &PackedReadinessEntryReport,
    profile: Option<&PackedEngineReadinessProfile>,
    artifacts: &[AlphaEncryptedPatchArtifact],
) -> AlphaEncryptedReadinessEntry {
    let mut findings: Vec<AlphaEncryptedFinding> = Vec::new();

    // --- Propagate any validation failure (never bless a rejected
    // profile). ------------------------------------------------------------
    if validation_entry.status == OperationStatus::Failed {
        let codes = validation_entry
            .findings
            .iter()
            .filter(|f| f.severity.is_blocking())
            .map(|f| f.code.clone())
            .collect::<Vec<_>>()
            .join(",");
        findings.push(finding(
            "alpha.encrypted.validation_failed",
            PartialDiagnosticSeverity::P0,
            "validationStatus",
            format!(
                "profile {} failed KAIFUU-103 validation [{codes}]",
                validation_entry.profile_id
            ),
            SemanticErrorCode::UnsupportedEngineVariant,
        ));
    }

    // Surface ids are the synthetic in-archive asset ids from the profile.
    let surface_ids = if let Some(profile) = profile {
        let mut ids: Vec<String> = profile.content.iter().map(|c| c.asset_id.clone()).collect();
        ids.sort();
        ids
    } else {
        findings.push(finding(
            "alpha.encrypted.fixture_input_missing",
            PartialDiagnosticSeverity::P0,
            "profileId",
            format!(
                "no readable profile fixture for validated entry {}",
                validation_entry.profile_id
            ),
            SemanticErrorCode::UnknownEngineVariant,
        ));
        Vec::new()
    };

    if validation_entry.key_status == LayeredAccessKeyMaterialStatus::Resolved
        && validation_entry.key_ref.is_none()
    {
        findings.push(finding(
            "alpha.encrypted.key_metadata_missing",
            PartialDiagnosticSeverity::P0,
            "keyRef",
            format!(
                "profile {} has a resolved key but the report carries no keyRef",
                validation_entry.profile_id
            ),
            SemanticErrorCode::MissingKeyMaterial,
        ));
    }
    if matches!(
        validation_entry.helper_status,
        LayeredAccessHelperStatus::Available | LayeredAccessHelperStatus::Unavailable
    ) && validation_entry.helper_id.is_none()
    {
        findings.push(finding(
            "alpha.encrypted.helper_metadata_missing",
            PartialDiagnosticSeverity::P0,
            "helperId",
            format!(
                "profile {} requires a helper but the report carries no helperId",
                validation_entry.profile_id
            ),
            SemanticErrorCode::HelperRequired,
        ));
    }

    // A patch-capable profile-ready entry MUST carry exactly one patch result;
    // a readiness-only entry MUST NOT (overstating readiness as production
    // patch support is a hard error).
    let needs_patch = validation_entry.posture == PackedReadinessPosture::ProfileReady
        && requires_patch_evidence(validation_entry.effective_outcome);

    for artifact in artifacts {
        if artifact.patch_back != validation_entry.transform_stack.patch_back {
            findings.push(finding(
                "alpha.encrypted.patch_back_mismatch",
                PartialDiagnosticSeverity::P0,
                "patchBack",
                format!(
                    "patch artifact {} declares patchBack {:?} but profile {} uses {:?}",
                    artifact.patch_result_id,
                    artifact.patch_back,
                    validation_entry.profile_id,
                    validation_entry.transform_stack.patch_back
                ),
                SemanticErrorCode::MissingPatchBackCapability,
            ));
        }
        if artifact.status == OperationStatus::Passed && artifact.touched_assets.is_empty() {
            findings.push(finding(
                "alpha.encrypted.patch_result_empty",
                PartialDiagnosticSeverity::P0,
                "touchedAssets",
                format!(
                    "patch artifact {} is passed but touched no assets",
                    artifact.patch_result_id
                ),
                SemanticErrorCode::MissingPatchBackCapability,
            ));
        }
    }

    let patch_result = artifacts
        .first()
        .map(AlphaEncryptedPatchResultRef::from_artifact);

    if needs_patch && patch_result.is_none() {
        findings.push(finding(
            "alpha.encrypted.patch_result_ref_missing",
            PartialDiagnosticSeverity::P0,
            "patchResult",
            format!(
                "profile {} is profile-ready at {} but no patch artifact references it",
                validation_entry.profile_id,
                validation_entry.effective_outcome.as_str()
            ),
            SemanticErrorCode::MissingPatchBackCapability,
        ));
    }
    if !needs_patch && patch_result.is_some() {
        findings.push(finding(
            "alpha.encrypted.readiness_only_claims_patch",
            PartialDiagnosticSeverity::P0,
            "patchResult",
            format!(
                "profile {} is {} ({}) but carries a patch result — readiness must not claim patch support",
                validation_entry.profile_id,
                validation_entry.posture.as_str(),
                validation_entry.effective_outcome.as_str()
            ),
            SemanticErrorCode::UnsupportedLayeredTransform,
        ));
    }
    if artifacts.len() > 1 {
        findings.push(finding(
            "alpha.encrypted.ambiguous_patch_result",
            PartialDiagnosticSeverity::P0,
            "patchResult",
            format!(
                "profile {} has {} patch artifacts; expected at most one",
                validation_entry.profile_id,
                artifacts.len()
            ),
            SemanticErrorCode::AmbiguousEngineVariant,
        ));
    }

    let status = if findings.iter().any(|f| f.severity.is_blocking()) {
        OperationStatus::Failed
    } else {
        OperationStatus::Passed
    };

    AlphaEncryptedReadinessEntry {
        profile_id: validation_entry.profile_id.clone(),
        fixture_id: validation_entry.fixture_id.clone(),
        source_node_id: "KAIFUU-104".to_string(),
        engine_family: validation_entry.engine_family,
        transform_stack: validation_entry.transform_stack,
        surface_ids,
        declared_capability: validation_entry.declared_capability,
        effective_outcome: validation_entry.effective_outcome,
        posture: validation_entry.posture,
        key_status: validation_entry.key_status,
        key_ref: validation_entry.key_ref.clone(),
        key_requirement_id: validation_entry.key_requirement_id.clone(),
        helper_status: validation_entry.helper_status,
        helper_id: validation_entry.helper_id.clone(),
        content_hash: validation_entry.content_hash.clone(),
        content_entry_count: validation_entry.content_entry_count,
        validation_status: validation_entry.status.clone(),
        patch_result,
        status,
        findings,
    }
}

/// Compute the `sha256:` report hash over the canonical serialization of the
/// (already-sorted-by-profile-id) entries.
fn compute_report_hash(entries: &[AlphaEncryptedReadinessEntry]) -> KaifuuResult<ProofHash> {
    let redacted: Vec<AlphaEncryptedReadinessEntry> = entries
        .iter()
        .map(AlphaEncryptedReadinessEntry::redacted_for_report)
        .collect();
    let canonical = stable_json(&redacted)?;
    ProofHash::new(sha256_hash_bytes(canonical.as_bytes())).map_err(Into::into)
}

fn consumed_validation(
    validation: &PackedReadinessValidationReport,
) -> KaifuuResult<ConsumedValidationReport> {
    let canonical = validation.stable_json()?;
    let report_hash = ProofHash::new(sha256_hash_bytes(canonical.as_bytes()))?;
    Ok(ConsumedValidationReport {
        schema_version: validation.schema_version.clone(),
        status: validation.status.clone(),
        profile_count: validation.profile_count,
        profile_ready_count: validation.profile_ready_count,
        readiness_only_count: validation.readiness_only_count,
        report_hash,
    })
}

/// Synthetic patch artifacts grouped by the `profileId` they reference.
type PatchArtifactsByProfile = BTreeMap<String, Vec<AlphaEncryptedPatchArtifact>>;

/// Read every synthetic patch artifact (`*.patch.json`) under `dir`, grouped by
/// `profileId`. A malformed artifact becomes a report-level finding, never a
/// hard error.
fn read_patch_artifacts(
    dir: &Path,
) -> KaifuuResult<(PatchArtifactsByProfile, Vec<AlphaEncryptedFinding>)> {
    let mut by_profile: BTreeMap<String, Vec<AlphaEncryptedPatchArtifact>> = BTreeMap::new();
    let mut findings: Vec<AlphaEncryptedFinding> = Vec::new();

    let mut files: Vec<std::path::PathBuf> = Vec::new();
    for entry in std::fs::read_dir(dir)? {
        let path = entry?.path();
        if path.is_file()
            && path
                .file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| name.ends_with(".patch.json"))
        {
            files.push(path);
        }
    }
    files.sort();

    for path in &files {
        let file_name = path
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("<unknown>");
        match read_json::<AlphaEncryptedPatchArtifact>(path) {
            Ok(artifact) => {
                if artifact.schema_version != ALPHA_ENCRYPTED_PATCH_ARTIFACT_SCHEMA_VERSION {
                    findings.push(finding(
                        "alpha.encrypted.patch_artifact_schema_mismatch",
                        PartialDiagnosticSeverity::P1,
                        "schemaVersion",
                        format!(
                            "patch artifact {file_name} declared schemaVersion {} but generator expects {}",
                            artifact.schema_version, ALPHA_ENCRYPTED_PATCH_ARTIFACT_SCHEMA_VERSION
                        ),
                        SemanticErrorCode::UnsupportedEngineVariant,
                    ));
                }
                by_profile
                    .entry(artifact.profile_id.clone())
                    .or_default()
                    .push(artifact);
            }
            Err(error) => findings.push(finding(
                "alpha.encrypted.patch_artifact_unparseable",
                PartialDiagnosticSeverity::P0,
                "patchArtifact",
                format!(
                    "patch artifact {file_name} could not be parsed: {}",
                    redact_for_log_or_report(&error.to_string())
                ),
                SemanticErrorCode::UnsupportedEngineVariant,
            )),
        }
    }

    // Keep grouped artifacts in a stable order.
    for artifacts in by_profile.values_mut() {
        artifacts.sort_by(|a, b| a.patch_result_id.cmp(&b.patch_result_id));
    }

    Ok((by_profile, findings))
}

/// Read every readiness profile fixture (`*.profile.json`) under `dir`, keyed
/// by `profileId`, for surface-id extraction. Malformed fixtures are ignored
/// here — the validator already records them as failed entries.
fn read_profiles(dir: &Path) -> KaifuuResult<BTreeMap<String, PackedEngineReadinessProfile>> {
    let mut by_id = BTreeMap::new();
    for entry in std::fs::read_dir(dir)? {
        let path = entry?.path();
        let is_profile = path.is_file()
            && path
                .file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| name.ends_with(".profile.json"));
        if is_profile && let Ok(profile) = read_json::<PackedEngineReadinessProfile>(&path) {
            by_id.insert(profile.profile_id.clone(), profile);
        }
    }
    Ok(by_id)
}

/// Generate the alpha-encrypted readiness evidence report by COMPOSING the
/// validator output over `dir` with the synthetic patch artifacts in
/// the same directory. Never panics; every inconsistency is a structured
/// finding. Returns `Err` only on an environmental I/O / hashing failure.
pub fn generate_alpha_encrypted_readiness(
    dir: &Path,
) -> KaifuuResult<AlphaEncryptedReadinessReport> {
    // 1. Consume 's validator output (do not reimplement it).
    let validation = validate_packed_engine_readiness_dir(dir)?;
    let consumed_validation = consumed_validation(&validation)?;

    // 2. Read the profile fixtures (surface ids) and synthetic patch artifacts.
    let profiles = read_profiles(dir)?;
    let (mut artifacts_by_profile, mut report_findings) = read_patch_artifacts(dir)?;

    // 3. Join each validated profile entry with its profile + patch artifacts.
    let mut entries: Vec<AlphaEncryptedReadinessEntry> =
        Vec::with_capacity(validation.profile_count as usize);
    for validation_entry in &validation.entries {
        let profile = profiles.get(&validation_entry.profile_id);
        let artifacts = artifacts_by_profile
            .remove(&validation_entry.profile_id)
            .unwrap_or_default();
        entries.push(build_entry(validation_entry, profile, &artifacts));
    }

    // 4. Any patch artifact that referenced no known profile is dangling.
    for (profile_id, artifacts) in &artifacts_by_profile {
        for artifact in artifacts {
            report_findings.push(finding(
                "alpha.encrypted.dangling_patch_artifact",
                PartialDiagnosticSeverity::P0,
                "patchArtifact",
                format!(
                    "patch artifact {} references unknown profileId {profile_id}",
                    artifact.patch_result_id
                ),
                SemanticErrorCode::UnknownEngineVariant,
            ));
        }
    }

    // 5. An empty fixture directory is a missing-input failure.
    if validation.profile_count == 0 {
        report_findings.push(finding(
            "alpha.encrypted.fixture_inputs_missing",
            PartialDiagnosticSeverity::P0,
            "fixturesDir",
            "alpha-encrypted fixture directory declares no readiness profile fixtures".to_string(),
            SemanticErrorCode::UnknownEngineVariant,
        ));
    }

    // 6. Stable order + counts + report hash.
    entries.sort_by(|a, b| a.profile_id.cmp(&b.profile_id));
    let profile_ready_count = entries
        .iter()
        .filter(|e| e.posture == PackedReadinessPosture::ProfileReady)
        .count() as u64;
    let readiness_only_count = entries
        .iter()
        .filter(|e| e.posture == PackedReadinessPosture::ReadinessOnly)
        .count() as u64;
    let patch_evidence_count = entries.iter().filter(|e| e.patch_result.is_some()).count() as u64;
    let report_hash = compute_report_hash(&entries)?;

    let entries_ok = entries.iter().all(|e| e.status == OperationStatus::Passed);
    let report_findings_blocking = report_findings.iter().any(|f| f.severity.is_blocking());
    let status = if entries_ok && !report_findings_blocking {
        OperationStatus::Passed
    } else {
        OperationStatus::Failed
    };

    Ok(AlphaEncryptedReadinessReport {
        schema_version: ALPHA_ENCRYPTED_READINESS_REPORT_SCHEMA_VERSION.to_string(),
        source_node_id: "KAIFUU-104".to_string(),
        support_boundary: ALPHA_ENCRYPTED_READINESS_SUPPORT_BOUNDARY.to_string(),
        status,
        consumed_validation,
        profile_count: entries.len() as u64,
        profile_ready_count,
        readiness_only_count,
        patch_evidence_count,
        entries,
        findings: report_findings,
        report_hash,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn fixtures_dir() -> PathBuf {
        crate::test_manifest_dir()
            .join("../..")
            .join("fixtures/kaifuu/alpha-encrypted")
    }

    fn generate() -> AlphaEncryptedReadinessReport {
        generate_alpha_encrypted_readiness(&fixtures_dir())
            .expect("generation runs without environmental error")
    }

    #[test]
    fn positive_dir_is_green_and_consumes_validation() {
        let report = generate();
        assert_eq!(
            report.status,
            OperationStatus::Passed,
            "failed entries: {:?}",
            report
                .entries
                .iter()
                .filter(|e| e.status == OperationStatus::Failed)
                .map(|e| (e.profile_id.clone(), e.findings.clone()))
                .collect::<Vec<_>>(),
        );
        // The validation report was consumed (status + hash).
        assert_eq!(report.consumed_validation.status, OperationStatus::Passed);
        assert!(
            report
                .consumed_validation
                .report_hash
                .as_str()
                .starts_with("sha256:")
        );
        assert_eq!(
            report.consumed_validation.profile_count,
            report.profile_count
        );
        // Both postures populate and the counts are consistent.
        assert!(report.profile_ready_count > 0);
        assert!(report.readiness_only_count > 0);
        assert_eq!(
            report.profile_ready_count + report.readiness_only_count,
            report.profile_count
        );
        // At least one patch-capable entry carries patch evidence.
        assert!(report.patch_evidence_count > 0);
        assert!(report.report_hash.as_str().starts_with("sha256:"));
    }

    #[test]
    fn every_entry_names_the_acceptance_tuple() {
        let report = generate();
        for entry in &report.entries {
            assert!(!entry.profile_id.is_empty());
            assert!(!entry.fixture_id.is_empty());
            assert_eq!(entry.source_node_id, "KAIFUU-104");
            assert!(entry.content_hash.as_str().starts_with("sha256:"));
            // Posture/outcome and patch-result presence are mechanically tied.
            match entry.posture {
                PackedReadinessPosture::ProfileReady
                    if requires_patch_evidence(entry.effective_outcome) =>
                {
                    let patch = entry
                        .patch_result
                        .as_ref()
                        .expect("patch-capable profile-ready entry carries a patch result");
                    assert!(patch.output_hash.as_str().starts_with("sha256:"));
                    assert!(!entry.surface_ids.is_empty());
                }
                PackedReadinessPosture::ReadinessOnly => {
                    assert!(
                        entry.patch_result.is_none(),
                        "readiness-only entry must not carry a patch result: {}",
                        entry.profile_id
                    );
                }
                PackedReadinessPosture::ProfileReady => {}
            }
        }
    }

    #[test]
    fn summary_is_readme_safe() {
        let report = generate();
        let summary = report.summary();
        assert_eq!(summary.evidence_kind, "readiness_evidence");
        assert_eq!(summary.report_hash, report.report_hash);
        let json = summary.stable_json().unwrap();
        // The summary names no asset / helper / key / patch id and no paths.
        assert!(!json.contains("local-secret:"));
        assert!(!json.contains("kaifuu.helper."));
        assert!(!json.contains("scene/"));
        assert!(!json.contains("/home/"));
        assert!(json.contains("readiness_evidence"));
        assert!(!summary.covered_engine_families.is_empty());
    }

    #[test]
    fn report_redacts_private_paths_and_carries_no_raw_keys() {
        let report = generate();
        let json = report.stable_json().unwrap();
        assert!(!json.contains("/home/"));
        // Key references are local-scheme refs, never raw key bytes.
        for entry in &report.entries {
            if let Some(secret) = &entry.key_ref {
                assert!(secret.as_str().starts_with("local-secret:"));
            }
        }
    }

    fn base_validation_entry() -> PackedReadinessEntryReport {
        // Reuse the validator over a single real profile.
        let dir = fixtures_dir();
        let report = validate_packed_engine_readiness_dir(&dir).unwrap();
        report
            .entries
            .iter()
            .find(|e| e.posture == PackedReadinessPosture::ProfileReady)
            .cloned()
            .expect("a profile-ready entry exists")
    }

    #[test]
    fn patch_capable_profile_ready_without_artifact_fails() {
        let entry = base_validation_entry();
        assert!(requires_patch_evidence(entry.effective_outcome));
        let built = build_entry(&entry, None, &[]);
        assert_eq!(built.status, OperationStatus::Failed);
        assert!(
            built
                .findings
                .iter()
                .any(|f| f.code == "alpha.encrypted.patch_result_ref_missing")
        );
    }

    #[test]
    fn readiness_only_with_patch_artifact_fails() {
        let dir = fixtures_dir();
        let report = validate_packed_engine_readiness_dir(&dir).unwrap();
        let readiness_only = report
            .entries
            .iter()
            .find(|e| e.posture == PackedReadinessPosture::ReadinessOnly)
            .cloned()
            .expect("a readiness-only entry exists");
        let artifact = AlphaEncryptedPatchArtifact {
            schema_version: ALPHA_ENCRYPTED_PATCH_ARTIFACT_SCHEMA_VERSION.to_string(),
            patch_result_id: "patch/should-not-exist".to_string(),
            profile_id: readiness_only.profile_id.clone(),
            source_node_id: "KAIFUU-104".to_string(),
            status: OperationStatus::Passed,
            patch_back: readiness_only.transform_stack.patch_back,
            touched_assets: vec!["scene/000.ss".to_string()],
            output_hash: ProofHash::new(sha256_hash_bytes(b"synthetic")).unwrap(),
        };
        let built = build_entry(&readiness_only, None, std::slice::from_ref(&artifact));
        assert_eq!(built.status, OperationStatus::Failed);
        assert!(
            built
                .findings
                .iter()
                .any(|f| f.code == "alpha.encrypted.readiness_only_claims_patch")
        );
    }

    #[test]
    fn empty_dir_reports_missing_inputs() {
        // A per-test tempdir (unique, auto-cleaned on drop) — never a shared or
        // fixed temp path, so this test is self-contained and cannot race with
        // any other.
        let tmp = tempfile::tempdir().unwrap();
        let report = generate_alpha_encrypted_readiness(tmp.path()).unwrap();
        assert_eq!(report.status, OperationStatus::Failed);
        assert!(
            report
                .findings
                .iter()
                .any(|f| f.code == "alpha.encrypted.fixture_inputs_missing")
        );
    }

    #[test]
    fn report_round_trips() {
        let report = generate();
        let json = report.stable_json().unwrap();
        assert!(json.ends_with('\n'));
        let parsed: AlphaEncryptedReadinessReport = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed.status, report.status);
        assert_eq!(parsed.report_hash, report.report_hash);
        assert_eq!(parsed.entries.len(), report.entries.len());
    }
}
