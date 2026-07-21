use super::*;
use serde_json::json;

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

#[test]
fn derives_all_four_states_from_the_join() {
    let observations = vec![
        observation("b.visited", Some("route_true"), &["t-1", "t-2"], 3),
        observation("b.unvisited", Some("route_bad"), &[], 2),
        observation("b.ambiguous", Some("route_orphan"), &["t-3"], 1),
        observation("b.unreachable", None, &[], 0),
    ];
    let route_map = vec![
        route("rm-0001", "route_true"),
        route("rm-0002", "route_bad"),
    ];
    let model = join_branch_coverage("utsushi-synthetic", &observations, &route_map)
        .expect("join succeeds");

    let by_id: std::collections::HashMap<&str, &BranchCoverageRecord> = model
        .records
        .iter()
        .map(|r| (r.branch_id.as_str(), r))
        .collect();

    assert_eq!(by_id["b.visited"].coverage_status, CoverageStatus::Visited);
    assert_eq!(by_id["b.visited"].route_map_ids, vec!["rm-0001"]);
    assert_eq!(
        by_id["b.unvisited"].coverage_status,
        CoverageStatus::Unvisited
    );
    assert_eq!(
        by_id["b.ambiguous"].coverage_status,
        CoverageStatus::Ambiguous
    );
    assert!(by_id["b.ambiguous"].route_map_ids.is_empty());
    assert_eq!(
        by_id["b.unreachable"].coverage_status,
        CoverageStatus::Unreachable
    );

    assert_eq!(model.summary.branch_count, 4);
    assert_eq!(model.summary.visited, 1);
    assert_eq!(model.summary.unvisited, 1);
    assert_eq!(model.summary.ambiguous, 1);
    assert_eq!(model.summary.unreachable, 1);
    assert_eq!(model.summary.total_reachable_text, 6);
    assert_eq!(model.summary.covered_reachable_text, 3);
}

#[test]
fn multiple_route_maps_for_one_key_is_ambiguous() {
    let observations = vec![observation("b.shared", Some("route_shared"), &["t-1"], 2)];
    let route_map = vec![
        route("rm-0001", "route_shared"),
        route("rm-0002", "route_shared"),
    ];
    let model = join_branch_coverage("utsushi-synthetic", &observations, &route_map)
        .expect("join succeeds");
    assert_eq!(model.records[0].coverage_status, CoverageStatus::Ambiguous);
    assert_eq!(model.records[0].route_map_ids, vec!["rm-0001", "rm-0002"]);
}

#[test]
fn records_are_sorted_by_branch_id() {
    let observations = vec![
        observation("b.zeta", Some("route_a"), &["t-1"], 1),
        observation("b.alpha", Some("route_a"), &["t-2"], 1),
    ];
    let route_map = vec![route("rm-0001", "route_a")];
    let model = join_branch_coverage("utsushi-synthetic", &observations, &route_map)
        .expect("join succeeds");
    let ids: Vec<&str> = model.records.iter().map(|r| r.branch_id.as_str()).collect();
    assert_eq!(ids, vec!["b.alpha", "b.zeta"]);
}

#[test]
fn duplicate_branch_id_is_rejected() {
    let observations = vec![
        observation("b.dup", Some("route_a"), &["t-1"], 1),
        observation("b.dup", Some("route_a"), &["t-2"], 1),
    ];
    let error = join_branch_coverage("utsushi-synthetic", &observations, &[])
        .expect_err("duplicate rejected");
    assert_eq!(
        error,
        BranchCoverageError::DuplicateBranchId {
            branch_id: "b.dup".to_string()
        }
    );
}

#[test]
fn malformed_adapter_id_is_rejected() {
    let error =
        join_branch_coverage("Not A Valid Adapter", &[], &[]).expect_err("adapter rejected");
    assert!(matches!(
        error,
        BranchCoverageError::AdapterIdMalformed { .. }
    ));
}

#[test]
fn read_model_round_trips_through_json() {
    let observations = vec![observation("b.visited", Some("route_a"), &["t-1"], 2)];
    let route_map = vec![route("rm-0001", "route_a")];
    let model = join_branch_coverage("utsushi-synthetic", &observations, &route_map)
        .expect("join succeeds");
    let bytes = serde_json::to_string(&model).expect("serialize");
    let restored: BranchCoverageReadModel = serde_json::from_str(&bytes).expect("deserialize");
    assert_eq!(model, restored);
}

#[test]
fn read_model_from_json_loads_the_fixture_shape() {
    let value = json!({
        "adapterId": "utsushi-synthetic",
        "observations": [
            {
                "branchId": "b.visited",
                "routeKey": "route_true",
                "observedTraceIds": ["t-1"],
                "reachableTextCount": 2
            },
            {
                "branchId": "b.unreachable",
                "observedTraceIds": [],
                "reachableTextCount": 0
            }
        ],
        "routeMap": [
            { "routeMapId": "rm-0001", "routeKey": "route_true" }
        ]
    });
    let model = read_model_from_json(value).expect("loads");
    assert_eq!(
        model.schema_version,
        BRANCH_COVERAGE_READ_MODEL_SCHEMA_VERSION
    );
    assert_eq!(model.summary.branch_count, 2);
    assert_eq!(model.summary.visited, 1);
    assert_eq!(model.summary.unreachable, 1);
}

#[test]
fn coverage_status_serializes_snake_case() {
    assert_eq!(
        serde_json::to_string(&CoverageStatus::Unvisited).expect("serialize"),
        "\"unvisited\""
    );
    assert_eq!(CoverageStatus::Ambiguous.as_str(), "ambiguous");
}
