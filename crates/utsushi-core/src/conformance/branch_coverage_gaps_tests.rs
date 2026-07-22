use super::*;

use super::super::branch_coverage::{BranchTraceObservation, RouteMapEntry, join_branch_coverage};

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
