//! Loader + validator round-trip + redaction-filter coverage for the
//! committed jump target fixtures ( §7.1-§7.4, §7.7).
//!
//! The determinism gate (§7.5/§7.6) lives in
//! `crates/utsushi-core/tests/replay_log_jump_target.rs`. This file focuses on the fixture
//! crate's pure surfaces: loader normalization, schema-version pinning, the
//! redaction walk, and one negative case per code.

use serde_json::{Value, json};
use utsushi_fixture::{
    InMemoryBridgeUnitIndex, JUMP_TARGET_SCHEMA_VERSION, JumpTargetError, JumpTargetSet,
    jump_targets::codes,
};

const SINGLE_BRANCH_JSON: &[u8] = include_bytes!("fixtures/jump_targets/single_branch.json");
const MULTI_BRANCH_JSON: &[u8] = include_bytes!("fixtures/jump_targets/multi_branch.json");
const LOOPING_JSON: &[u8] = include_bytes!("fixtures/jump_targets/looping.json");

fn single_branch_index() -> InMemoryBridgeUnitIndex {
    InMemoryBridgeUnitIndex::from_ids(["bridge-unit-single-branch-a"])
}

fn multi_branch_index() -> InMemoryBridgeUnitIndex {
    InMemoryBridgeUnitIndex::from_ids([
        "bridge-unit-multi-branch-a",
        "bridge-unit-multi-branch-b",
        "bridge-unit-multi-branch-c",
    ])
}

fn looping_index() -> InMemoryBridgeUnitIndex {
    InMemoryBridgeUnitIndex::from_ids(["bridge-unit-looping-head", "bridge-unit-looping-body"])
}

#[test]
fn jump_target_set_round_trips_through_serde_json() {
    let set = JumpTargetSet::load_from_json(SINGLE_BRANCH_JSON).unwrap();
    let value = serde_json::to_value(&set).unwrap();
    let back: JumpTargetSet = serde_json::from_value(value).unwrap();
    assert_eq!(set, back);
}

#[test]
fn jump_target_set_serializes_with_camel_case() {
    let set = JumpTargetSet::load_from_json(SINGLE_BRANCH_JSON).unwrap();
    let value = serde_json::to_value(&set).unwrap();
    assert!(value.get("schemaVersion").is_some());
    assert!(value.get("adapterId").is_some());
    let target = &value["targets"][0];
    assert!(target.get("targetId").is_some());
    assert!(target.get("bridgeUnitId").is_some());
    assert!(target.get("activatesAtTick").is_some());
}

#[test]
fn jump_target_set_rejects_unknown_fields() {
    let mut value: Value = serde_json::from_slice(SINGLE_BRANCH_JSON).unwrap();
    value
        .as_object_mut()
        .unwrap()
        .insert("phantomField".to_string(), json!("nope"));
    let bytes = serde_json::to_vec(&value).unwrap();
    let error = JumpTargetSet::load_from_json(&bytes).unwrap_err();
    assert!(matches!(error, JumpTargetError::InvalidJson { .. }));
    assert_eq!(error.semantic_code(), codes::INVALID_JSON);
}

#[test]
fn jump_target_set_rejects_unknown_schema_version() {
    let mut value: Value = serde_json::from_slice(SINGLE_BRANCH_JSON).unwrap();
    value["schemaVersion"] = json!("9.9.9-future");
    let bytes = serde_json::to_vec(&value).unwrap();
    let error = JumpTargetSet::load_from_json(&bytes).unwrap_err();
    match error {
        JumpTargetError::UnsupportedSchemaVersion { observed, expected } => {
            assert_eq!(observed, "9.9.9-future");
            assert_eq!(expected, JUMP_TARGET_SCHEMA_VERSION);
        }
        other => panic!("expected UnsupportedSchemaVersion, got {other:?}"),
    }
}

#[test]
fn jump_target_set_normalizes_target_order_on_load() {
    // Multi-branch JSON has 3 targets at the same tick; verify the canonical
    // sort by (tick, target_id) is stable. The committed JSON is already in
    // canonical order, so a reverse-permutation of the same payload must
    // load into the identical struct.
    let mut value: Value = serde_json::from_slice(MULTI_BRANCH_JSON).unwrap();
    let mut targets: Vec<Value> = value["targets"].as_array().unwrap().clone();
    targets.reverse();
    value["targets"] = Value::Array(targets);
    let bytes = serde_json::to_vec(&value).unwrap();
    let permuted = JumpTargetSet::load_from_json(&bytes).unwrap();
    let canonical = JumpTargetSet::load_from_json(MULTI_BRANCH_JSON).unwrap();
    assert_eq!(permuted, canonical);
    // And the canonical id order is alphabetical at this shared tick.
    let ids: Vec<&str> = canonical
        .targets
        .iter()
        .map(|t| t.target_id.as_str())
        .collect();
    assert_eq!(
        ids,
        vec![
            "multi-branch-target-a",
            "multi-branch-target-b",
            "multi-branch-target-c",
        ]
    );
}

#[test]
fn jump_target_set_validates_single_branch_fixture() {
    let set = JumpTargetSet::load_from_json(SINGLE_BRANCH_JSON).unwrap();
    set.validate(&single_branch_index()).unwrap();
}

#[test]
fn jump_target_set_validates_multi_branch_fixture() {
    let set = JumpTargetSet::load_from_json(MULTI_BRANCH_JSON).unwrap();
    set.validate(&multi_branch_index()).unwrap();
}

#[test]
fn jump_target_set_validates_looping_fixture() {
    let set = JumpTargetSet::load_from_json(LOOPING_JSON).unwrap();
    set.validate(&looping_index()).unwrap();
}

#[test]
fn jump_target_set_rejects_target_id_with_host_path() {
    let mut value: Value = serde_json::from_slice(SINGLE_BRANCH_JSON).unwrap();
    // Inject a host-shaped target_id BEFORE the redaction walk runs; the
    // loader must catch it during load_from_json (not validate()).
    value["targets"][0]["targetId"] = json!("/home/trevor/secret");
    let bytes = serde_json::to_vec(&value).unwrap();
    let error = JumpTargetSet::load_from_json(&bytes).unwrap_err();
    match error {
        JumpTargetError::UnredactedLocalPath {
            field_path,
            value: leaked,
        } => {
            assert!(field_path.contains("targetId"));
            assert!(leaked.contains("/home/trevor"));
        }
        other => panic!("expected UnredactedLocalPath, got {other:?}"),
    }
}

#[test]
fn jump_target_set_rejects_target_id_with_whitespace() {
    // Whitespace inside a target id is NOT a host-path shape, so it must
    // pass the loader's redaction walk and be caught by validate().
    let mut value: Value = serde_json::from_slice(SINGLE_BRANCH_JSON).unwrap();
    value["targets"][0]["targetId"] = json!("contains whitespace");
    let bytes = serde_json::to_vec(&value).unwrap();
    let set = JumpTargetSet::load_from_json(&bytes).unwrap();
    let error = set.validate(&single_branch_index()).unwrap_err();
    match error {
        JumpTargetError::TargetIdLooksLikeLocalPath { target_id, reason } => {
            assert_eq!(target_id, "contains whitespace");
            assert!(reason.contains("whitespace"));
        }
        other => panic!("expected TargetIdLooksLikeLocalPath, got {other:?}"),
    }
}

#[test]
fn jump_target_set_rejects_duplicate_target_id() {
    // Inject a second target sharing the first's id (and bridge unit).
    let mut value: Value = serde_json::from_slice(SINGLE_BRANCH_JSON).unwrap();
    let mut targets = value["targets"].as_array().unwrap().clone();
    let mut duplicate = targets[0].clone();
    duplicate["activatesAtTick"] = json!(8);
    targets.push(duplicate);
    value["targets"] = Value::Array(targets);
    let bytes = serde_json::to_vec(&value).unwrap();
    let set = JumpTargetSet::load_from_json(&bytes).unwrap();
    let error = set.validate(&single_branch_index()).unwrap_err();
    match error {
        JumpTargetError::DuplicateTargetId { target_id } => {
            assert_eq!(target_id, "single-branch-target-a");
        }
        other => panic!("expected DuplicateTargetId, got {other:?}"),
    }
}

#[test]
fn jump_target_set_rejects_missing_bridge_unit() {
    let set = JumpTargetSet::load_from_json(SINGLE_BRANCH_JSON).unwrap();
    // Use an index that does not contain the fixture's bridge unit.
    let index = InMemoryBridgeUnitIndex::from_ids(["bridge-unit-elsewhere"]);
    let error = set.validate(&index).unwrap_err();
    match error {
        JumpTargetError::JumpTargetMissingBridgeUnit {
            target_id,
            bridge_unit_id,
        } => {
            assert_eq!(target_id, "single-branch-target-a");
            assert_eq!(bridge_unit_id, "bridge-unit-single-branch-a");
        }
        other => panic!("expected JumpTargetMissingBridgeUnit, got {other:?}"),
    }
}

#[test]
fn jump_target_set_rejects_activates_at_tick_zero() {
    let mut value: Value = serde_json::from_slice(SINGLE_BRANCH_JSON).unwrap();
    value["targets"][0]["activatesAtTick"] = json!(0);
    let bytes = serde_json::to_vec(&value).unwrap();
    let set = JumpTargetSet::load_from_json(&bytes).unwrap();
    let error = set.validate(&single_branch_index()).unwrap_err();
    match error {
        JumpTargetError::ActivatesAtTickIsZero { target_id } => {
            assert_eq!(target_id, "single-branch-target-a");
        }
        other => panic!("expected ActivatesAtTickIsZero, got {other:?}"),
    }
}

#[test]
fn jump_target_set_passes_reject_unredacted_local_paths_filter() {
    use utsushi_core::redaction::reject_unredacted_local_paths;
    for (label, bytes) in [
        ("single_branch", SINGLE_BRANCH_JSON),
        ("multi_branch", MULTI_BRANCH_JSON),
        ("looping", LOOPING_JSON),
    ] {
        let value: Value = serde_json::from_slice(bytes)
            .unwrap_or_else(|error| panic!("{label}: parse failed: {error}"));
        reject_unredacted_local_paths(label, &value)
            .unwrap_or_else(|error| panic!("{label}: project-wide filter flagged: {error}"));
    }
}

#[test]
fn jump_target_codes_all_registered_in_module_codes_slice() {
    // codes::ALL is the registry of stable semantic codes. Its membership
    // is the public contract; this test pins the count so accidental
    // additions/removals fail loudly.
    assert_eq!(codes::ALL.len(), 9);
    for code in codes::ALL {
        assert!(code.starts_with("utsushi.fixture.jump_target."), "{code}");
    }
}

#[test]
fn every_jump_target_error_variant_emits_a_registered_code() {
    let samples = [
        JumpTargetError::UnsupportedSchemaVersion {
            observed: "x".to_string(),
            expected: "y".to_string(),
        },
        JumpTargetError::InvalidJson {
            reason: "x".to_string(),
        },
        JumpTargetError::TargetIdLooksLikeLocalPath {
            target_id: "x".to_string(),
            reason: "y".to_string(),
        },
        JumpTargetError::DuplicateTargetId {
            target_id: "x".to_string(),
        },
        JumpTargetError::JumpTargetMissingBridgeUnit {
            target_id: "x".to_string(),
            bridge_unit_id: "y".to_string(),
        },
        JumpTargetError::ActivatesAtTickIsZero {
            target_id: "x".to_string(),
        },
        JumpTargetError::UnredactedLocalPath {
            field_path: "x".to_string(),
            value: "y".to_string(),
        },
        JumpTargetError::BlankIdentifier { field: "x" },
        JumpTargetError::ReplayLogFingerprintMismatch {
            observed: "x".to_string(),
            expected: "y".to_string(),
        },
    ];
    for sample in &samples {
        let code = sample.semantic_code();
        assert!(
            codes::ALL.contains(&code),
            "code {code:?} from {sample:?} missing from codes::ALL"
        );
    }
}
