//! Detailed alpha readiness validation report and multi-profile / directory
//! aggregation. Builds on [`super::validate::validate_alpha_readiness_profile`].

use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::{
    KaifuuResult, OperationStatus, PackedEngineFamily, PartialDiagnosticSeverity,
    PatchBackTransform, SemanticErrorCode, redact_for_log_or_report, stable_json,
};

use super::validate::{finding, validate_alpha_readiness_profile};
use super::{
    ALPHA_READINESS_PROFILE_SCHEMA_VERSION, ALPHA_READINESS_SOURCE_NODE_ID,
    ALPHA_READINESS_SUPPORT_BOUNDARY, AlphaHelperKeyStatus, AlphaOperationStatuses,
    AlphaReadinessEntry, AlphaReadinessProfile, AlphaReadinessProvenance, ReadinessFailureClass,
};

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
        findings: vec![finding(
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
