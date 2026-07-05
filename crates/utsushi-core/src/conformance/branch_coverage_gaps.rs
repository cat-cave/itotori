//! MV/MZ branch-coverage GAP FINDING emitter (UTSUSHI-069).
//!
//! A DATA-ONLY job that reads the UTSUSHI-009
//! [`BranchCoverageReadModel`](super::branch_coverage::BranchCoverageReadModel)
//! and emits machine-readable **gap findings**. It is the emitter half of the
//! branch-coverage surface: the UTSUSHI-067 branch explorer *browses* the read
//! model as a paginated dashboard; this module instead *judges* it and names
//! the branches that represent real coverage gaps.
//!
//! This module NEVER launches a runtime host, browses a dashboard, or formats
//! an export/report document. It only reshapes the already-derived per-branch
//! coverage view into findings. Its only dependency is `serde`.
//!
//! # What counts as a gap
//!
//! The read model derives a [`CoverageStatus`] per branch. Exactly two of the
//! four states are coverage gaps:
//!
//! | coverage status                     | reachable text | gap?  | gap kind             |
//! | ----------------------------------- | -------------- | ----- | -------------------- |
//! | `Unvisited`                         | `> 0`          | YES   | `unvisited_reachable`|
//! | `Unvisited`                         | `0`            | no    | —                    |
//! | `Ambiguous`                         | any            | YES   | `ambiguous_route`    |
//! | `Visited`                           | any            | no    | —                    |
//! | `Unreachable`                       | any            | no    | —                    |
//!
//! - **`Visited`** branches are already covered — not a gap.
//! - **`Unreachable`** branches are legitimately unreachable (no route map
//!   reaches them and they were never observed) — *not* a gap. Emitting a
//!   finding for them would be a false positive, so they are explicitly
//!   excluded.
//! - An **`Unvisited`** branch is a gap ONLY when it exposes reachable text
//!   (`reachable_text_count > 0`): a reachable branch that carries no
//!   translatable text is nothing to cover.
//! - An **`Ambiguous`** branch is always a gap: its route evidence cannot be
//!   uniquely attributed (a dangling route target, or a key resolving to more
//!   than one route map), so coverage cannot be proven either way.

use serde::{Deserialize, Serialize};

use super::branch_coverage::{BranchCoverageReadModel, BranchCoverageRecord, CoverageStatus};

/// Stable schema id for the serialized gap-findings report + findings.
pub const BRANCH_COVERAGE_GAP_FINDINGS_SCHEMA_VERSION: &str = "utsushi.branch_coverage_gaps.v0.1";

/// The kind of coverage gap a finding names. DERIVED from the branch's
/// [`CoverageStatus`]; only the two gap-bearing states have a kind.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum GapKind {
    /// A branch reachable through exactly one route map, exposing reachable
    /// text, that was never observed at runtime (`Unvisited` +
    /// `reachable_text_count > 0`).
    UnvisitedReachable,
    /// A branch whose route evidence cannot be uniquely attributed
    /// (`Ambiguous`): a dangling route target or a key resolving to several
    /// route maps.
    AmbiguousRoute,
}

impl GapKind {
    /// Stable snake_case wire label.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::UnvisitedReachable => "unvisited_reachable",
            Self::AmbiguousRoute => "ambiguous_route",
        }
    }
}

/// Deterministic gap severity. Higher variants are more urgent.
///
/// The ordering derives from `#[derive(PartialOrd, Ord)]` over the declaration
/// order below (`Low < Medium < High`), so it can be compared and sorted
/// directly.
///
/// See [`severity_for`] for the exact assignment rule.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum GapSeverity {
    /// An ambiguous-route gap: a data-quality problem in the route evidence,
    /// but not proof of missing coverage.
    Low,
    /// An unvisited-reachable gap that exposes a small amount of reachable
    /// text (below [`HIGH_TEXT_SEVERITY_THRESHOLD`]).
    Medium,
    /// An unvisited-reachable gap that exposes a large amount of reachable
    /// text (>= [`HIGH_TEXT_SEVERITY_THRESHOLD`]): the biggest blind spots.
    High,
}

impl GapSeverity {
    /// Stable snake_case wire label.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Low => "low",
            Self::Medium => "medium",
            Self::High => "high",
        }
    }
}

/// Reachable-text count at or above which an unvisited-reachable gap is
/// promoted from [`GapSeverity::Medium`] to [`GapSeverity::High`].
///
/// Chosen so a branch hiding a substantial block of untranslated text ranks
/// above one hiding a stray line. Deterministic and documented; changing it is
/// a schema-visible policy change.
pub const HIGH_TEXT_SEVERITY_THRESHOLD: u32 = 10;

/// Assign the deterministic severity for a gap.
///
/// The rule, in full:
///
/// - `unvisited_reachable` with `reachable_text_count >=`
///   [`HIGH_TEXT_SEVERITY_THRESHOLD`] → [`GapSeverity::High`].
/// - `unvisited_reachable` with a smaller (but non-zero) reachable-text count
///   → [`GapSeverity::Medium`].
/// - `ambiguous_route` → [`GapSeverity::Low`].
///
/// This satisfies the acceptance ordering "an unvisited-reachable gap with a
/// high text count outranks an ambiguous gap" (`High > Low`), and it further
/// ranks *every* unvisited-reachable gap above every ambiguous one
/// (`High, Medium > Low`), reflecting that a proven-missing branch is a
/// stronger signal than merely ambiguous route evidence.
pub fn severity_for(kind: GapKind, reachable_text_count: u32) -> GapSeverity {
    match kind {
        GapKind::UnvisitedReachable => {
            if reachable_text_count >= HIGH_TEXT_SEVERITY_THRESHOLD {
                GapSeverity::High
            } else {
                GapSeverity::Medium
            }
        }
        GapKind::AmbiguousRoute => GapSeverity::Low,
    }
}

/// A managed artifact-store link named by a gap finding.
///
/// Mirrors the UTSUSHI-067 branch-explorer artifact links so the two surfaces
/// point at the same managed `/artifact-store/` mount: one `runtime-trace`
/// link per observed trace id, one `route-map` link per route-map id. The
/// `uri` is a managed-mount relative path — never a raw filesystem / `file:`
/// URL.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GapArtifactLink {
    /// Link relation: `runtime-trace` or `route-map`.
    pub rel: String,
    /// The trace id or route-map id the link resolves.
    pub ref_id: String,
    /// Managed artifact-store relative URI.
    pub uri: String,
}

/// One emitted gap finding.
///
/// Names every field the acceptance requires: the branch id, the route-map
/// ids, the observed trace ids, the coverage status, the derived gap kind and
/// severity, and the derived artifact links.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BranchCoverageGapFinding {
    /// Stable, deterministic finding id: `branch-coverage-gap:{kind}:{branch}`.
    pub finding_id: String,
    /// The branch this finding is about.
    pub branch_id: String,
    /// The route key the branch leads to, if any (mirrors the record).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub route_key: Option<String>,
    /// The route-map ids the branch resolved to (0, 1, or many).
    pub route_map_ids: Vec<String>,
    /// Observed runtime trace event ids on this branch.
    pub observed_trace_ids: Vec<String>,
    /// Reachable runtime-visible text count on the branch.
    pub reachable_text_count: u32,
    /// The branch's derived coverage status.
    pub coverage_status: CoverageStatus,
    /// The kind of gap this finding names.
    pub gap_kind: GapKind,
    /// The deterministic severity.
    pub severity: GapSeverity,
    /// Managed artifact-store links (trace + route-map).
    pub artifact_links: Vec<GapArtifactLink>,
}

/// Per-kind / per-severity aggregate counts for a gap-findings report.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BranchCoverageGapSummary {
    /// Total findings emitted.
    pub gap_count: u32,
    /// Findings with kind `unvisited_reachable`.
    pub unvisited_reachable: u32,
    /// Findings with kind `ambiguous_route`.
    pub ambiguous_route: u32,
    /// Findings at `high` severity.
    pub high_severity: u32,
    /// Findings at `medium` severity.
    pub medium_severity: u32,
    /// Findings at `low` severity.
    pub low_severity: u32,
    /// Sum of `reachable_text_count` over `unvisited_reachable` gaps — the
    /// reachable text that is provably uncovered.
    pub uncovered_reachable_text: u32,
}

/// The emitted gap-findings report.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BranchCoverageGapReport {
    pub schema_version: String,
    pub adapter_id: String,
    /// Findings, sorted deterministically by `branch_id` (one finding per
    /// branch at most, since each record has exactly one coverage status).
    pub findings: Vec<BranchCoverageGapFinding>,
    pub summary: BranchCoverageGapSummary,
}

/// Classify a single coverage record into a gap kind, or `None` when the
/// branch is not a gap (`Visited`, `Unreachable`, or `Unvisited` with no
/// reachable text).
fn gap_kind_for(record: &BranchCoverageRecord) -> Option<GapKind> {
    match record.coverage_status {
        // Unvisited is a gap only when it actually exposes reachable text; an
        // unvisited branch with no reachable text is nothing to cover.
        CoverageStatus::Unvisited if record.reachable_text_count > 0 => {
            Some(GapKind::UnvisitedReachable)
        }
        // Ambiguous route evidence is always a gap.
        CoverageStatus::Ambiguous => Some(GapKind::AmbiguousRoute),
        // Everything else is NOT a gap: `Visited` (already covered),
        // `Unreachable` (legitimately unreachable — emitting a finding would
        // be a false positive), and `Unvisited` with no reachable text.
        CoverageStatus::Unvisited | CoverageStatus::Visited | CoverageStatus::Unreachable => None,
    }
}

/// Derive the managed artifact-store links for a record: one `runtime-trace`
/// link per observed trace id, one `route-map` link per route-map id. Pure and
/// deterministic; mirrors the UTSUSHI-067 branch-explorer path scheme.
fn derive_artifact_links(adapter_id: &str, record: &BranchCoverageRecord) -> Vec<GapArtifactLink> {
    let base = format!("/artifact-store/artifacts/utsushi/branch-coverage/{adapter_id}");
    let mut links =
        Vec::with_capacity(record.observed_trace_ids.len() + record.route_map_ids.len());
    for trace_id in &record.observed_trace_ids {
        links.push(GapArtifactLink {
            rel: "runtime-trace".to_string(),
            ref_id: trace_id.clone(),
            uri: format!("{base}/traces/{trace_id}.json"),
        });
    }
    for route_map_id in &record.route_map_ids {
        links.push(GapArtifactLink {
            rel: "route-map".to_string(),
            ref_id: route_map_id.clone(),
            uri: format!("{base}/route-maps/{route_map_id}.json"),
        });
    }
    links
}

/// Emit gap findings from a branch-coverage read model.
///
/// Walks the read model's records (already sorted by `branch_id`), keeps only
/// the two gap-bearing states, and produces one [`BranchCoverageGapFinding`]
/// per gap with its derived kind, severity, and artifact links. `Visited` and
/// `Unreachable` branches (and `Unvisited` branches with no reachable text)
/// produce NO finding. Pure — the same read model always yields the same
/// report.
pub fn emit_branch_coverage_gap_findings(
    model: &BranchCoverageReadModel,
) -> BranchCoverageGapReport {
    let mut findings: Vec<BranchCoverageGapFinding> = Vec::new();
    let mut summary = BranchCoverageGapSummary::default();

    for record in &model.records {
        let Some(gap_kind) = gap_kind_for(record) else {
            continue;
        };
        let severity = severity_for(gap_kind, record.reachable_text_count);

        summary.gap_count += 1;
        match gap_kind {
            GapKind::UnvisitedReachable => {
                summary.unvisited_reachable += 1;
                summary.uncovered_reachable_text = summary
                    .uncovered_reachable_text
                    .saturating_add(record.reachable_text_count);
            }
            GapKind::AmbiguousRoute => summary.ambiguous_route += 1,
        }
        match severity {
            GapSeverity::High => summary.high_severity += 1,
            GapSeverity::Medium => summary.medium_severity += 1,
            GapSeverity::Low => summary.low_severity += 1,
        }

        findings.push(BranchCoverageGapFinding {
            finding_id: format!(
                "branch-coverage-gap:{}:{}",
                gap_kind.as_str(),
                record.branch_id
            ),
            branch_id: record.branch_id.clone(),
            route_key: record.route_key.clone(),
            route_map_ids: record.route_map_ids.clone(),
            observed_trace_ids: record.observed_trace_ids.clone(),
            reachable_text_count: record.reachable_text_count,
            coverage_status: record.coverage_status,
            gap_kind,
            severity,
            artifact_links: derive_artifact_links(&model.adapter_id, record),
        });
    }

    // Records arrive sorted by branch_id; keep that order so findings are
    // deterministic regardless of input ordering upstream.
    findings.sort_by(|a, b| a.branch_id.cmp(&b.branch_id));

    BranchCoverageGapReport {
        schema_version: BRANCH_COVERAGE_GAP_FINDINGS_SCHEMA_VERSION.to_string(),
        adapter_id: model.adapter_id.clone(),
        findings,
        summary,
    }
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

    /// A fixture read model exercising EVERY coverage state, including both
    /// unvisited sub-cases (with and without reachable text) and both
    /// ambiguous sub-cases (dangling target and multi-route).
    fn all_states_model() -> BranchCoverageReadModel {
        let observations = vec![
            // Visited: reachable through one route, observed — NOT a gap.
            observation("b.visited", Some("route_true"), &["t-1", "t-2"], 5),
            // Unvisited + reachable text, HIGH count -> High severity gap.
            observation("b.unvisited_high", Some("route_high"), &[], 20),
            // Unvisited + reachable text, LOW count -> Medium severity gap.
            observation("b.unvisited_low", Some("route_low"), &[], 3),
            // Unvisited but NO reachable text -> NOT a gap.
            observation("b.unvisited_empty", Some("route_empty"), &[], 0),
            // Ambiguous: observed but route key resolves to no route map
            // (dangling target) -> Low severity gap.
            observation("b.ambiguous_dangling", Some("route_orphan"), &["t-3"], 4),
            // Unreachable: no route map, never observed -> NOT a gap.
            observation("b.unreachable", None, &[], 0),
            // Ambiguous: route key resolves to TWO route maps -> Low gap.
            observation("b.ambiguous_multi", Some("route_shared"), &["t-4"], 7),
        ];
        let route_map = vec![
            route("rm-0001", "route_true"),
            route("rm-0002", "route_high"),
            route("rm-0003", "route_low"),
            route("rm-0004", "route_empty"),
            route("rm-0005", "route_shared"),
            route("rm-0006", "route_shared"),
        ];
        join_branch_coverage("utsushi-synthetic", &observations, &route_map).expect("join succeeds")
    }

    fn finding_ids(report: &BranchCoverageGapReport) -> Vec<&str> {
        report
            .findings
            .iter()
            .map(|f| f.branch_id.as_str())
            .collect()
    }

    #[test]
    fn emits_findings_only_for_the_two_gap_kinds() {
        let report = emit_branch_coverage_gap_findings(&all_states_model());

        // Exactly the four gaps — NOT visited, NOT unreachable, NOT the
        // reachable-text-free unvisited branch.
        assert_eq!(
            finding_ids(&report),
            vec![
                "b.ambiguous_dangling",
                "b.ambiguous_multi",
                "b.unvisited_high",
                "b.unvisited_low",
            ]
        );

        // Visited / unreachable / empty-unvisited never appear.
        for excluded in ["b.visited", "b.unreachable", "b.unvisited_empty"] {
            assert!(
                !report.findings.iter().any(|f| f.branch_id == excluded),
                "{excluded} must not produce a finding"
            );
        }
    }

    #[test]
    fn assigns_gap_kind_per_state() {
        let report = emit_branch_coverage_gap_findings(&all_states_model());
        let by_id: std::collections::HashMap<&str, &BranchCoverageGapFinding> = report
            .findings
            .iter()
            .map(|f| (f.branch_id.as_str(), f))
            .collect();

        assert_eq!(
            by_id["b.unvisited_high"].gap_kind,
            GapKind::UnvisitedReachable
        );
        assert_eq!(
            by_id["b.unvisited_low"].gap_kind,
            GapKind::UnvisitedReachable
        );
        assert_eq!(
            by_id["b.ambiguous_dangling"].gap_kind,
            GapKind::AmbiguousRoute
        );
        assert_eq!(by_id["b.ambiguous_multi"].gap_kind, GapKind::AmbiguousRoute);

        // Coverage status is carried through unchanged.
        assert_eq!(
            by_id["b.unvisited_high"].coverage_status,
            CoverageStatus::Unvisited
        );
        assert_eq!(
            by_id["b.ambiguous_multi"].coverage_status,
            CoverageStatus::Ambiguous
        );
    }

    #[test]
    fn assigns_severity_per_rule() {
        let report = emit_branch_coverage_gap_findings(&all_states_model());
        let by_id: std::collections::HashMap<&str, &BranchCoverageGapFinding> = report
            .findings
            .iter()
            .map(|f| (f.branch_id.as_str(), f))
            .collect();

        // Unvisited-reachable, high text count -> High.
        assert_eq!(by_id["b.unvisited_high"].severity, GapSeverity::High);
        // Unvisited-reachable, low text count -> Medium.
        assert_eq!(by_id["b.unvisited_low"].severity, GapSeverity::Medium);
        // Ambiguous -> Low.
        assert_eq!(by_id["b.ambiguous_dangling"].severity, GapSeverity::Low);
        assert_eq!(by_id["b.ambiguous_multi"].severity, GapSeverity::Low);

        // The acceptance ordering: a high-text unvisited gap outranks an
        // ambiguous one.
        assert!(by_id["b.unvisited_high"].severity > by_id["b.ambiguous_dangling"].severity);
    }

    #[test]
    fn severity_threshold_is_inclusive() {
        // Exactly at the threshold is High; one below is Medium.
        assert_eq!(
            severity_for(GapKind::UnvisitedReachable, HIGH_TEXT_SEVERITY_THRESHOLD),
            GapSeverity::High
        );
        assert_eq!(
            severity_for(
                GapKind::UnvisitedReachable,
                HIGH_TEXT_SEVERITY_THRESHOLD - 1
            ),
            GapSeverity::Medium
        );
        assert_eq!(severity_for(GapKind::AmbiguousRoute, 999), GapSeverity::Low);
    }

    #[test]
    fn finding_names_all_required_fields() {
        let report = emit_branch_coverage_gap_findings(&all_states_model());
        let by_id: std::collections::HashMap<&str, &BranchCoverageGapFinding> = report
            .findings
            .iter()
            .map(|f| (f.branch_id.as_str(), f))
            .collect();

        // The multi-route ambiguous branch names branch id, route key, both
        // route-map ids, its trace id, coverage status, kind, severity, and
        // artifact links (one trace link + two route-map links).
        let finding = by_id["b.ambiguous_multi"];
        assert_eq!(
            finding.finding_id,
            "branch-coverage-gap:ambiguous_route:b.ambiguous_multi"
        );
        assert_eq!(finding.branch_id, "b.ambiguous_multi");
        assert_eq!(finding.route_key.as_deref(), Some("route_shared"));
        assert_eq!(finding.route_map_ids, vec!["rm-0005", "rm-0006"]);
        assert_eq!(finding.observed_trace_ids, vec!["t-4"]);
        assert_eq!(finding.reachable_text_count, 7);

        let rels: Vec<&str> = finding
            .artifact_links
            .iter()
            .map(|l| l.rel.as_str())
            .collect();
        assert_eq!(rels, vec!["runtime-trace", "route-map", "route-map"]);
        assert_eq!(finding.artifact_links[0].ref_id, "t-4");
        assert_eq!(
            finding.artifact_links[0].uri,
            "/artifact-store/artifacts/utsushi/branch-coverage/utsushi-synthetic/traces/t-4.json"
        );
        assert_eq!(finding.artifact_links[1].ref_id, "rm-0005");
        assert_eq!(
            finding.artifact_links[2].uri,
            "/artifact-store/artifacts/utsushi/branch-coverage/utsushi-synthetic/route-maps/rm-0006.json"
        );

        // The high-text unvisited gap still names its route-map link even
        // though it has no observed trace.
        let unvisited = by_id["b.unvisited_high"];
        assert!(unvisited.observed_trace_ids.is_empty());
        assert_eq!(unvisited.artifact_links.len(), 1);
        assert_eq!(unvisited.artifact_links[0].rel, "route-map");
    }

    #[test]
    fn summary_counts_kinds_and_severities() {
        let report = emit_branch_coverage_gap_findings(&all_states_model());
        assert_eq!(report.summary.gap_count, 4);
        assert_eq!(report.summary.unvisited_reachable, 2);
        assert_eq!(report.summary.ambiguous_route, 2);
        assert_eq!(report.summary.high_severity, 1);
        assert_eq!(report.summary.medium_severity, 1);
        assert_eq!(report.summary.low_severity, 2);
        // Uncovered reachable text = 20 (high) + 3 (low); ambiguous branches
        // are not counted as uncovered reachable text.
        assert_eq!(report.summary.uncovered_reachable_text, 23);
    }

    #[test]
    fn a_clean_model_emits_no_findings() {
        // Only visited + unreachable + empty-unvisited branches -> no gaps.
        let observations = vec![
            observation("b.visited", Some("route_ok"), &["t-1"], 4),
            observation("b.unreachable", None, &[], 0),
            observation("b.unvisited_empty", Some("route_empty"), &[], 0),
        ];
        let route_map = vec![
            route("rm-0001", "route_ok"),
            route("rm-0002", "route_empty"),
        ];
        let model = join_branch_coverage("utsushi-synthetic", &observations, &route_map)
            .expect("join succeeds");
        let report = emit_branch_coverage_gap_findings(&model);
        assert!(report.findings.is_empty());
        assert_eq!(report.summary, BranchCoverageGapSummary::default());
    }

    #[test]
    fn report_round_trips_through_json() {
        let report = emit_branch_coverage_gap_findings(&all_states_model());
        let bytes = serde_json::to_string(&report).expect("serialize");
        let restored: BranchCoverageGapReport = serde_json::from_str(&bytes).expect("deserialize");
        assert_eq!(report, restored);
        assert_eq!(
            report.schema_version,
            BRANCH_COVERAGE_GAP_FINDINGS_SCHEMA_VERSION
        );
    }

    #[test]
    fn wire_labels_are_stable_snake_case() {
        assert_eq!(GapKind::UnvisitedReachable.as_str(), "unvisited_reachable");
        assert_eq!(GapKind::AmbiguousRoute.as_str(), "ambiguous_route");
        assert_eq!(GapSeverity::High.as_str(), "high");
        assert_eq!(
            serde_json::to_string(&GapKind::UnvisitedReachable).expect("serialize"),
            "\"unvisited_reachable\""
        );
        assert_eq!(
            serde_json::to_string(&GapSeverity::Medium).expect("serialize"),
            "\"medium\""
        );
    }
}
