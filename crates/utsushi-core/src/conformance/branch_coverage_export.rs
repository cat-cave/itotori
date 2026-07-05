//! Branch-coverage EXPORT artifact (UTSUSHI-070).
//!
//! A DATA-ONLY job that reshapes two already-derived surfaces into a single
//! STABLE export artifact for alpha reports + offline review:
//!
//! - the UTSUSHI-009
//!   [`BranchCoverageReadModel`](super::branch_coverage::BranchCoverageReadModel)
//!   (per-branch coverage view: branch ids, route-map ids, observed trace ids,
//!   reachable text counts, coverage status, and the per-status summary), and
//! - the UTSUSHI-069
//!   [`BranchCoverageGapReport`](super::branch_coverage_gaps::BranchCoverageGapReport)
//!   gap findings (unvisited-reachable / ambiguous-route, with severity).
//!
//! This module NEVER launches a runtime host, browses a dashboard, captures a
//! screenshot, or reads the clock. In particular it takes the **generated-at**
//! timestamp as an INJECTED parameter — it never calls `SystemTime::now()` — so
//! the same read model plus the same injected timestamp always yields the exact
//! same bytes. That determinism is what makes the JSON + Markdown outputs
//! snapshot-testable and safe to commit as a stable artifact. Its only
//! dependency is `serde`.
//!
//! # What the export contains
//!
//! - `generatedAt` — the injected timestamp metadata.
//! - `readModel` — the full read model: every record's branch id, route-map
//!   ids, observed trace ids, reachable text count, and coverage status, plus
//!   the per-status coverage summary.
//! - `gaps.summary` — the gap COUNTS (per kind + per severity + uncovered
//!   reachable text). Always present.
//! - `gaps.findings` — the detailed gap findings from UTSUSHI-069. Present only
//!   when the caller opts in (`include_findings`); the export "can include gap
//!   findings" without being forced to.

use serde::{Deserialize, Serialize};

use super::branch_coverage::BranchCoverageReadModel;
use super::branch_coverage_gaps::{
    BranchCoverageGapFinding, BranchCoverageGapSummary, emit_branch_coverage_gap_findings,
};

/// Stable schema id for the serialized export artifact.
pub const BRANCH_COVERAGE_EXPORT_SCHEMA_VERSION: &str = "utsushi.branch_coverage_export.v0.1";

/// The gap half of an export: the always-present gap COUNTS, plus the optional
/// detailed findings.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BranchCoverageExportGaps {
    /// Schema id of the UTSUSHI-069 gap-findings report the counts came from.
    pub schema_version: String,
    /// Per-kind / per-severity gap counts. Always present, even with no
    /// findings requested — the counts stand alone.
    pub summary: BranchCoverageGapSummary,
    /// The detailed gap findings. Present only when the caller opted in;
    /// omitted from the wire form otherwise.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub findings: Option<Vec<BranchCoverageGapFinding>>,
}

/// The stable branch-coverage export artifact.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BranchCoverageExport {
    pub schema_version: String,
    /// INJECTED generated-at metadata — never read from the clock.
    pub generated_at: String,
    pub adapter_id: String,
    /// The full UTSUSHI-009 read model (records + coverage summary).
    pub read_model: BranchCoverageReadModel,
    /// The UTSUSHI-069 gap counts (+ optional findings).
    pub gaps: BranchCoverageExportGaps,
}

/// Export-construction error.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum BranchCoverageExportError {
    /// The injected `generated_at` is empty, too long, or carries whitespace /
    /// control characters (which would corrupt the JSON + Markdown outputs).
    GeneratedAtMalformed { value: String },
}

impl std::fmt::Display for BranchCoverageExportError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::GeneratedAtMalformed { value } => {
                write!(formatter, "generated-at {value:?} is malformed")
            }
        }
    }
}

impl std::error::Error for BranchCoverageExportError {}

/// The injected generated-at must be a compact, single-token timestamp (e.g. an
/// RFC 3339 instant like `2026-07-05T00:00:00Z`): non-empty, bounded, and free
/// of whitespace / control characters so it renders cleanly into both the JSON
/// string and the Markdown metadata line.
fn validate_generated_at(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 64
        && value.chars().all(|c| !c.is_control() && !c.is_whitespace())
}

/// Build the export artifact from a read model and an INJECTED generated-at.
///
/// Emits the UTSUSHI-069 gap report internally (pure), hoists its counts into
/// `gaps.summary`, and includes the detailed `gaps.findings` only when
/// `include_findings` is set. Deterministic: the same read model + the same
/// `generated_at` always produces the same artifact.
pub fn build_branch_coverage_export(
    read_model: &BranchCoverageReadModel,
    generated_at: impl Into<String>,
    include_findings: bool,
) -> Result<BranchCoverageExport, BranchCoverageExportError> {
    let generated_at = generated_at.into();
    if !validate_generated_at(&generated_at) {
        return Err(BranchCoverageExportError::GeneratedAtMalformed {
            value: generated_at,
        });
    }

    let gap_report = emit_branch_coverage_gap_findings(read_model);
    let findings = include_findings.then(|| gap_report.findings.clone());

    Ok(BranchCoverageExport {
        schema_version: BRANCH_COVERAGE_EXPORT_SCHEMA_VERSION.to_string(),
        generated_at,
        adapter_id: read_model.adapter_id.clone(),
        read_model: read_model.clone(),
        gaps: BranchCoverageExportGaps {
            schema_version: gap_report.schema_version,
            summary: gap_report.summary,
            findings,
        },
    })
}

/// Render a human-readable Markdown summary of the export.
///
/// Deterministic and pure. Shows the per-status coverage counts and the gap
/// counts / severities; when the export carries detailed findings, they are
/// listed in a stable, branch-id-sorted table (the read model already sorts
/// records, and the gap report preserves that order).
pub fn render_branch_coverage_markdown(export: &BranchCoverageExport) -> String {
    use std::fmt::Write as _;

    let coverage = &export.read_model.summary;
    let gaps = &export.gaps.summary;

    // Writing to a `String` is infallible, so the `write!` results are ignored.
    let mut out = String::new();
    out.push_str("# Branch Coverage Export\n\n");
    let _ = writeln!(out, "- Adapter: `{}`", export.adapter_id);
    let _ = writeln!(out, "- Generated at: {}", export.generated_at);
    let _ = writeln!(out, "- Schema: `{}`\n", export.schema_version);

    out.push_str("## Coverage\n\n");
    out.push_str("| Status | Branches |\n");
    out.push_str("| --- | --- |\n");
    let _ = writeln!(out, "| Visited | {} |", coverage.visited);
    let _ = writeln!(out, "| Unvisited | {} |", coverage.unvisited);
    let _ = writeln!(out, "| Ambiguous | {} |", coverage.ambiguous);
    let _ = writeln!(out, "| Unreachable | {} |", coverage.unreachable);
    let _ = writeln!(out, "| **Total** | {} |\n", coverage.branch_count);
    let _ = writeln!(
        out,
        "Reachable text: {} covered of {} total.\n",
        coverage.covered_reachable_text, coverage.total_reachable_text
    );

    out.push_str("## Gaps\n\n");
    out.push_str("| Metric | Count |\n");
    out.push_str("| --- | --- |\n");
    let _ = writeln!(out, "| Total gaps | {} |", gaps.gap_count);
    let _ = writeln!(
        out,
        "| Unvisited reachable | {} |",
        gaps.unvisited_reachable
    );
    let _ = writeln!(out, "| Ambiguous route | {} |", gaps.ambiguous_route);
    let _ = writeln!(out, "| High severity | {} |", gaps.high_severity);
    let _ = writeln!(out, "| Medium severity | {} |", gaps.medium_severity);
    let _ = writeln!(out, "| Low severity | {} |", gaps.low_severity);
    let _ = writeln!(
        out,
        "| Uncovered reachable text | {} |",
        gaps.uncovered_reachable_text
    );

    if let Some(findings) = &export.gaps.findings {
        out.push('\n');
        out.push_str("## Gap Findings\n\n");
        if findings.is_empty() {
            out.push_str("_No gap findings._\n");
        } else {
            out.push_str("| Branch | Kind | Severity | Reachable text |\n");
            out.push_str("| --- | --- | --- | --- |\n");
            for finding in findings {
                let _ = writeln!(
                    out,
                    "| `{}` | {} | {} | {} |",
                    finding.branch_id,
                    finding.gap_kind.as_str(),
                    finding.severity.as_str(),
                    finding.reachable_text_count
                );
            }
        }
    }

    out
}

#[cfg(test)]
mod tests {
    use super::super::branch_coverage::{
        BranchTraceObservation, RouteMapEntry, join_branch_coverage,
    };
    use super::*;

    fn observation(
        branch_id: &str,
        route_key: Option<&str>,
        trace_ids: &[&str],
        reachable_text_count: u32,
    ) -> BranchTraceObservation {
        BranchTraceObservation {
            branch_id: branch_id.to_string(),
            route_key: route_key.map(str::to_string),
            observed_trace_ids: trace_ids.iter().map(|t| (*t).to_string()).collect(),
            reachable_text_count,
        }
    }

    fn route(route_map_id: &str, route_key: &str) -> RouteMapEntry {
        RouteMapEntry {
            route_map_id: route_map_id.to_string(),
            route_key: route_key.to_string(),
        }
    }

    /// A read model exercising every coverage state and both gap kinds.
    fn model() -> BranchCoverageReadModel {
        let observations = vec![
            observation("b.visited", Some("route_true"), &["t-1", "t-2"], 5),
            observation("b.unvisited_high", Some("route_high"), &[], 20),
            observation("b.unvisited_low", Some("route_low"), &[], 3),
            observation("b.ambiguous", Some("route_orphan"), &["t-3"], 4),
            observation("b.unreachable", None, &[], 0),
        ];
        let route_map = vec![
            route("rm-0001", "route_true"),
            route("rm-0002", "route_high"),
            route("rm-0003", "route_low"),
        ];
        join_branch_coverage("utsushi-synthetic", &observations, &route_map).expect("join succeeds")
    }

    const GENERATED_AT: &str = "2026-07-05T00:00:00Z";

    #[test]
    fn export_carries_injected_generated_at_verbatim() {
        let export =
            build_branch_coverage_export(&model(), GENERATED_AT, false).expect("export builds");
        // The generated-at is exactly what the caller injected — NOT a clock
        // read. Two builds with the same injected value are byte-identical.
        assert_eq!(export.generated_at, GENERATED_AT);
        let again =
            build_branch_coverage_export(&model(), GENERATED_AT, false).expect("export builds");
        assert_eq!(export, again);
    }

    #[test]
    fn export_names_all_required_fields() {
        let export =
            build_branch_coverage_export(&model(), GENERATED_AT, false).expect("export builds");
        assert_eq!(export.schema_version, BRANCH_COVERAGE_EXPORT_SCHEMA_VERSION);
        assert_eq!(export.adapter_id, "utsushi-synthetic");

        // Branch ids, route-map ids, coverage status, trace ids all ride in the
        // embedded read model.
        let visited = export
            .read_model
            .records
            .iter()
            .find(|r| r.branch_id == "b.visited")
            .expect("visited record present");
        assert_eq!(visited.route_map_ids, vec!["rm-0001"]);
        assert_eq!(visited.observed_trace_ids, vec!["t-1", "t-2"]);
        assert_eq!(
            visited.coverage_status,
            super::super::branch_coverage::CoverageStatus::Visited
        );

        // Gap counts are always present.
        assert_eq!(export.gaps.summary.gap_count, 3);
        assert_eq!(export.gaps.summary.unvisited_reachable, 2);
        assert_eq!(export.gaps.summary.ambiguous_route, 1);
        assert_eq!(export.gaps.summary.high_severity, 1);
        assert_eq!(export.gaps.summary.medium_severity, 1);
        assert_eq!(export.gaps.summary.low_severity, 1);
        assert_eq!(export.gaps.summary.uncovered_reachable_text, 23);
    }

    #[test]
    fn findings_are_included_only_on_opt_in() {
        let without =
            build_branch_coverage_export(&model(), GENERATED_AT, false).expect("export builds");
        assert!(without.gaps.findings.is_none());

        let with =
            build_branch_coverage_export(&model(), GENERATED_AT, true).expect("export builds");
        let findings = with.gaps.findings.expect("findings included");
        let ids: Vec<&str> = findings.iter().map(|f| f.branch_id.as_str()).collect();
        assert_eq!(
            ids,
            vec!["b.ambiguous", "b.unvisited_high", "b.unvisited_low"]
        );
    }

    #[test]
    fn malformed_generated_at_is_rejected() {
        for bad in ["", "2026-07-05 00:00:00", "has\nnewline"] {
            let error = build_branch_coverage_export(&model(), bad, false)
                .expect_err("malformed generated-at rejected");
            assert!(matches!(
                error,
                BranchCoverageExportError::GeneratedAtMalformed { .. }
            ));
        }
    }

    #[test]
    fn export_round_trips_through_json() {
        let export =
            build_branch_coverage_export(&model(), GENERATED_AT, true).expect("export builds");
        let bytes = serde_json::to_string(&export).expect("serialize");
        let restored: BranchCoverageExport = serde_json::from_str(&bytes).expect("deserialize");
        assert_eq!(export, restored);
    }

    #[test]
    fn markdown_renders_coverage_and_gap_counts() {
        let export =
            build_branch_coverage_export(&model(), GENERATED_AT, true).expect("export builds");
        let markdown = render_branch_coverage_markdown(&export);

        assert!(markdown.contains("# Branch Coverage Export"));
        assert!(markdown.contains(GENERATED_AT));
        assert!(markdown.contains("| Visited | 1 |"));
        assert!(markdown.contains("| Unvisited | 2 |"));
        assert!(markdown.contains("| Ambiguous | 1 |"));
        assert!(markdown.contains("| Unreachable | 1 |"));
        assert!(markdown.contains("| Total gaps | 3 |"));
        assert!(markdown.contains("| High severity | 1 |"));
        // Findings table appears only when findings are included.
        assert!(markdown.contains("## Gap Findings"));
        assert!(markdown.contains("| `b.ambiguous` | ambiguous_route | low | 4 |"));

        // Without findings, the findings section is absent.
        let no_findings = render_branch_coverage_markdown(
            &build_branch_coverage_export(&model(), GENERATED_AT, false).expect("export builds"),
        );
        assert!(!no_findings.contains("## Gap Findings"));
    }
}
