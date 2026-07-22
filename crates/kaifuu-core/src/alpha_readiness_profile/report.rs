use super::*;

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
