//! Integration test for the MV/MZ branch coverage read
//! model. Loads the committed synthetic fixture
//! `tests/fixtures/conformance/branch_coverage/coverage_status.json`
//! (shared byte-for-byte with the TypeScript dashboard seed), builds the
//! read model through the trace-to-route join, and asserts every
//! required field plus the four coverage states.
//!
//! This is a DATA-ONLY test: it launches no runtime host, opens no
//! browser, and reads no screenshot artifact. It only reshapes the
//! committed join inputs.

use std::collections::HashMap;
use std::path::PathBuf;

use serde_json::Value;
use utsushi_core::conformance::branch_coverage::{
    BRANCH_COVERAGE_READ_MODEL_SCHEMA_VERSION, BranchCoverageRecord, CoverageStatus,
    read_model_from_json,
};

fn load_fixture() -> Value {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tests")
        .join("fixtures")
        .join("conformance")
        .join("branch_coverage")
        .join("coverage_status.json");
    let text = std::fs::read_to_string(&path)
        .unwrap_or_else(|_| panic!("read fixture {}", path.display()));
    serde_json::from_str(&text).unwrap_or_else(|_| panic!("parse fixture {}", path.display()))
}

fn by_branch(model: &[BranchCoverageRecord]) -> HashMap<&str, &BranchCoverageRecord> {
    model.iter().map(|r| (r.branch_id.as_str(), r)).collect()
}

#[test]
fn fixture_join_records_every_required_field() {
    let model = read_model_from_json(load_fixture()).expect("fixture builds");

    assert_eq!(
        model.schema_version,
        BRANCH_COVERAGE_READ_MODEL_SCHEMA_VERSION
    );
    assert_eq!(model.adapter_id, "utsushi-synthetic");

    // Every record carries branch id, route-map ids, observed trace ids
    // reachable text count, and a coverage status.
    for record in &model.records {
        assert!(!record.branch_id.is_empty());
        // route_map_ids / observed_trace_ids are always present (possibly
        // empty); reachable_text_count and coverage_status are required.
        let _ = &record.route_map_ids;
        let _ = &record.observed_trace_ids;
        let _ = record.reachable_text_count;
        let _ = record.coverage_status;
    }
}

#[test]
fn fixture_covers_visited_unvisited_ambiguous_and_unreachable() {
    let model = read_model_from_json(load_fixture()).expect("fixture builds");
    let records = by_branch(&model.records);

    let visited = records["mvmz.map012.ev003.choice0.opt0"];
    assert_eq!(visited.coverage_status, CoverageStatus::Visited);
    assert_eq!(
        visited.route_map_ids,
        vec!["0190a000-0000-7000-8000-0000000000a1"]
    );
    assert_eq!(visited.observed_trace_ids, vec!["trace-0001", "trace-0002"]);
    assert_eq!(visited.reachable_text_count, 3);

    let unvisited = records["mvmz.map012.ev003.choice0.opt1"];
    assert_eq!(unvisited.coverage_status, CoverageStatus::Unvisited);
    assert_eq!(
        unvisited.route_map_ids,
        vec!["0190a000-0000-7000-8000-0000000000a2"]
    );
    assert!(unvisited.observed_trace_ids.is_empty());

    let ambiguous = records["mvmz.map014.ev007.choice1.opt0"];
    assert_eq!(ambiguous.coverage_status, CoverageStatus::Ambiguous);
    assert!(ambiguous.route_map_ids.is_empty());
    assert_eq!(ambiguous.observed_trace_ids, vec!["trace-0003"]);

    let unreachable = records["mvmz.map020.ev001.choice0.opt2"];
    assert_eq!(unreachable.coverage_status, CoverageStatus::Unreachable);
    assert!(unreachable.route_map_ids.is_empty());
    assert!(unreachable.observed_trace_ids.is_empty());
    assert_eq!(unreachable.reachable_text_count, 0);
}

#[test]
fn fixture_summary_counts_each_state_once() {
    let model = read_model_from_json(load_fixture()).expect("fixture builds");
    assert_eq!(model.summary.branch_count, 4);
    assert_eq!(model.summary.visited, 1);
    assert_eq!(model.summary.unvisited, 1);
    assert_eq!(model.summary.ambiguous, 1);
    assert_eq!(model.summary.unreachable, 1);
    assert_eq!(model.summary.total_reachable_text, 6);
    assert_eq!(model.summary.covered_reachable_text, 3);
}
