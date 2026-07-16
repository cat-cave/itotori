use super::{
    DetectionEvidence, content_hash, redact_asset_ref_for_report, redact_for_log_or_report,
};
use serde::{Deserialize, Serialize};

/// partial-adapter report envelope. Emitted by `kaifuu extract` /
/// `kaifuu profile` / `kaifuu verify` when the matched adapter's `detect`
/// returns `detected == false` but accumulated nonzero Matched evidence.
/// The envelope surfaces what bytes WERE recovered, which adapter refusals
/// fired, and at which severity — instead of failing closed with
/// `"no registered adapter detected"`.
/// Schema-stability invariants enforced by the CLI:
/// - `partial` is always `true` (the field is never elided so dashboard
///   ingestion can distinguish a partial run from a complete one even when
///   the inventory happens to be empty).
/// - `detected` is always `false` (partial output is by construction the
///   below-the-detect-gate path).
/// - `severityCounts` is always present (zero-valued buckets included) so
///   the dashboard's bar chart query never has to handle missing keys.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PartialAdapterReport {
    pub schema_version: String,
    pub report_id: String,
    pub adapter_id: String,
    pub detected: bool,
    pub partial: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detected_variant: Option<String>,
    pub command: PartialAdapterCommand,
    pub evidence: Vec<DetectionEvidence>,
    pub diagnostics: Vec<PartialAdapterDiagnostic>,
    pub severity_counts: PartialSeverityCounts,
    pub inventory: PartialAdapterInventory,
}

/// Which CLI command produced the partial report. Lets downstream ingestion
/// route the same envelope into the extract / profile / verify lanes
/// without re-parsing the inventory shape.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PartialAdapterCommand {
    Extract,
    Profile,
    Verify,
}

impl PartialAdapterCommand {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Extract => "extract",
            Self::Profile => "profile",
            Self::Verify => "verify",
        }
    }
}

/// Per-diagnostic severity for partial-report routing. P0/P1 mean the
/// partial output is unsafe to consume (downstream `apply` MUST refuse);
/// `kaifuu verify` exits 1 when any P0/P1 fires. P2/P3 are informational
/// or sub-blocking and never flip the exit code.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum PartialDiagnosticSeverity {
    P0,
    P1,
    P2,
    P3,
}

impl PartialDiagnosticSeverity {
    pub fn is_blocking(self) -> bool {
        matches!(self, Self::P0 | Self::P1)
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::P0 => "P0",
            Self::P1 => "P1",
            Self::P2 => "P2",
            Self::P3 => "P3",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PartialAdapterDiagnostic {
    pub code: String,
    pub severity: PartialDiagnosticSeverity,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub asset_ref: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub remediation: Option<String>,
}

/// Severity bucket counts. Always serialized in full (zero buckets
/// included) so the dashboard does not have to handle missing keys.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PartialSeverityCounts {
    pub p0: u32,
    pub p1: u32,
    pub p2: u32,
    pub p3: u32,
}

impl PartialSeverityCounts {
    pub fn from_diagnostics(diagnostics: &[PartialAdapterDiagnostic]) -> Self {
        let mut counts = Self::default();
        for diagnostic in diagnostics {
            match diagnostic.severity {
                PartialDiagnosticSeverity::P0 => counts.p0 += 1,
                PartialDiagnosticSeverity::P1 => counts.p1 += 1,
                PartialDiagnosticSeverity::P2 => counts.p2 += 1,
                PartialDiagnosticSeverity::P3 => counts.p3 += 1,
            }
        }
        counts
    }

    pub fn blocking(&self) -> u32 {
        self.p0 + self.p1
    }
}

/// What WAS recovered from the bytes, even though `detected` is false.
/// `entries` is the engine-neutral count of stable, byte-anchored units
/// (RealLive: scene-index entries; XP3: archive entries; Siglus: Scene.pck
/// chunk count). `sources` lists the recovered input paths in stable
/// order — schema-stable across runs.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PartialAdapterInventory {
    pub entries: u64,
    pub sources: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_bundle_hash: Option<String>,
}

impl PartialAdapterReport {
    /// Build a normalized partial report with sorted evidence,
    /// deterministic diagnostic order, an up-to-date severity rollup, and a
    /// content-derived `report_id` (see `normalize`) so two partial runs
    /// with distinct inputs never share an id.
    pub fn new(
        adapter_id: impl Into<String>,
        detected_variant: Option<String>,
        command: PartialAdapterCommand,
        evidence: Vec<DetectionEvidence>,
        diagnostics: Vec<PartialAdapterDiagnostic>,
        inventory: PartialAdapterInventory,
    ) -> Self {
        let mut report = Self {
            schema_version: "0.1.0".to_string(),
            // Placeholder; `normalize` replaces it with a content-derived id.
            report_id: String::new(),
            adapter_id: adapter_id.into(),
            detected: false,
            partial: true,
            detected_variant,
            command,
            evidence,
            diagnostics,
            severity_counts: PartialSeverityCounts::default(),
            inventory,
        };
        report.normalize();
        report
    }

    pub fn normalize(&mut self) {
        self.evidence
            .sort_by_key(|evidence| (evidence.path.clone(), evidence.kind.clone()));
        self.diagnostics
            .sort_by_key(|diagnostic| (diagnostic.code.clone(), diagnostic.message.clone()));
        self.inventory.sources.sort();
        self.inventory.sources.dedup();
        self.severity_counts = PartialSeverityCounts::from_diagnostics(&self.diagnostics);
        // Derive `report_id` from the normalized content rather than a
        // hardcoded constant, so two partial runs with distinct
        // adapter/variant/evidence/diagnostics/inventory get distinct ids and
        // dashboard de-duplication by reportId never collapses independent
        // runs. Computed after sorting so id is invariant to input order.
        let fingerprint = serde_json::to_string(&(
            &self.adapter_id,
            &self.detected_variant,
            self.command,
            &self.evidence,
            &self.diagnostics,
            &self.inventory,
        ))
        .unwrap_or_default();
        self.report_id = format!("kaifuu-partial-adapter-{}", content_hash(&fingerprint));
    }

    pub fn has_blocking_diagnostic(&self) -> bool {
        self.severity_counts.blocking() > 0
    }

    pub fn redacted_for_report(&self) -> Self {
        let mut report = self.clone();
        report.adapter_id = redact_for_log_or_report(&report.adapter_id);
        report.report_id = redact_for_log_or_report(&report.report_id);
        report.detected_variant = report
            .detected_variant
            .as_deref()
            .map(redact_for_log_or_report);
        report.evidence = report
            .evidence
            .iter()
            .map(DetectionEvidence::redacted_for_report)
            .collect();
        report.diagnostics = report
            .diagnostics
            .iter()
            .map(PartialAdapterDiagnostic::redacted_for_report)
            .collect();
        report.inventory.sources = report
            .inventory
            .sources
            .iter()
            .map(|source| redact_asset_ref_for_report(source))
            .collect();
        report.inventory.source_bundle_hash = report
            .inventory
            .source_bundle_hash
            .as_deref()
            .map(redact_for_log_or_report);
        report.normalize();
        report
    }
}

impl PartialAdapterDiagnostic {
    fn redacted_for_report(&self) -> Self {
        Self {
            code: redact_for_log_or_report(&self.code),
            severity: self.severity,
            message: redact_for_log_or_report(&self.message),
            asset_ref: self.asset_ref.as_deref().map(redact_asset_ref_for_report),
            remediation: self.remediation.as_deref().map(redact_for_log_or_report),
        }
    }
}
