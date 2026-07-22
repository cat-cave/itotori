use super::*;
use serde_json::json;

fn sample_set_json() -> Value {
    json!({
        "schemaVersion": JUMP_TARGET_SCHEMA_VERSION,
        "source": "fixture",
        "adapterId": "utsushi-fixture",
        "targets": [
            {
                "targetId": "target-b",
                "bridgeUnitId": "bridge-unit-b",
                "activatesAtTick": 5
            },
            {
                "targetId": "target-a",
                "bridgeUnitId": "bridge-unit-a",
                "activatesAtTick": 4
            }
        ]
    })
}

fn index_with(ids: &[&str]) -> InMemoryBridgeUnitIndex {
    InMemoryBridgeUnitIndex::from_ids(ids.iter().copied())
}

#[test]
fn loader_normalises_target_order_by_tick_then_id() {
    let bytes = serde_json::to_vec(&sample_set_json()).unwrap();
    let set = JumpTargetSet::load_from_json(&bytes).unwrap();
    let ids: Vec<&str> = set.targets.iter().map(|t| t.target_id.as_str()).collect();
    assert_eq!(ids, vec!["target-a", "target-b"]);
}

#[test]
fn loader_rejects_unknown_schema_version() {
    let mut value = sample_set_json();
    value["schemaVersion"] = Value::String("9.9.9".to_string());
    let bytes = serde_json::to_vec(&value).unwrap();
    let error = JumpTargetSet::load_from_json(&bytes).unwrap_err();
    assert!(matches!(
        error,
        JumpTargetError::UnsupportedSchemaVersion { .. }
    ));
    assert_eq!(error.semantic_code(), codes::UNSUPPORTED_SCHEMA_VERSION,);
}

#[test]
fn loader_rejects_unknown_field() {
    let mut value = sample_set_json();
    value
        .as_object_mut()
        .unwrap()
        .insert("extraField".to_string(), Value::String("nope".to_string()));
    let bytes = serde_json::to_vec(&value).unwrap();
    let error = JumpTargetSet::load_from_json(&bytes).unwrap_err();
    assert!(matches!(error, JumpTargetError::InvalidJson { .. }));
}

#[test]
fn loader_rejects_host_path_in_label_field() {
    let mut value = sample_set_json();
    value["targets"][0]["label"] = Value::String("/home/trevor/secret".to_string());
    let bytes = serde_json::to_vec(&value).unwrap();
    let error = JumpTargetSet::load_from_json(&bytes).unwrap_err();
    match error {
        JumpTargetError::UnredactedLocalPath { field_path, .. } => {
            assert!(field_path.contains("label"));
        }
        other => panic!("expected UnredactedLocalPath, got {other:?}"),
    }
}

#[test]
fn validate_passes_for_well_formed_set() {
    let bytes = serde_json::to_vec(&sample_set_json()).unwrap();
    let set = JumpTargetSet::load_from_json(&bytes).unwrap();
    let index = index_with(&["bridge-unit-a", "bridge-unit-b"]);
    set.validate(&index).unwrap();
}

#[test]
fn validate_rejects_target_with_missing_bridge_unit() {
    let bytes = serde_json::to_vec(&sample_set_json()).unwrap();
    let set = JumpTargetSet::load_from_json(&bytes).unwrap();
    let index = index_with(&["bridge-unit-a"]);
    let error = set.validate(&index).unwrap_err();
    match error {
        JumpTargetError::JumpTargetMissingBridgeUnit {
            target_id,
            bridge_unit_id,
        } => {
            assert_eq!(target_id, "target-b");
            assert_eq!(bridge_unit_id, "bridge-unit-b");
        }
        other => panic!("expected JumpTargetMissingBridgeUnit, got {other:?}"),
    }
}

#[test]
fn validate_rejects_duplicate_target_id() {
    // Force both targets to share targetId AND bridgeUnitId so the
    // sort by (tick, id) preserves both rather than collapsing.
    let mut value = sample_set_json();
    value["targets"][0]["targetId"] = Value::String("target-a".to_string());
    value["targets"][0]["bridgeUnitId"] = Value::String("bridge-unit-a".to_string());
    value["targets"][1]["targetId"] = Value::String("target-a".to_string());
    value["targets"][1]["bridgeUnitId"] = Value::String("bridge-unit-a".to_string());
    let bytes = serde_json::to_vec(&value).unwrap();
    let set = JumpTargetSet::load_from_json(&bytes).unwrap();
    let index = index_with(&["bridge-unit-a", "bridge-unit-b"]);
    let error = set.validate(&index).unwrap_err();
    match error {
        JumpTargetError::DuplicateTargetId { target_id } => {
            assert_eq!(target_id, "target-a");
        }
        other => panic!("expected DuplicateTargetId, got {other:?}"),
    }
}

#[test]
fn validate_rejects_activates_at_tick_zero() {
    let mut value = sample_set_json();
    value["targets"][1]["activatesAtTick"] = json!(0);
    let bytes = serde_json::to_vec(&value).unwrap();
    let set = JumpTargetSet::load_from_json(&bytes).unwrap();
    let index = index_with(&["bridge-unit-a", "bridge-unit-b"]);
    let error = set.validate(&index).unwrap_err();
    match error {
        JumpTargetError::ActivatesAtTickIsZero { target_id } => {
            // After sort, tick 0 lands first.
            assert_eq!(target_id, "target-a");
        }
        other => panic!("expected ActivatesAtTickIsZero, got {other:?}"),
    }
}

#[test]
fn validate_rejects_target_id_with_whitespace() {
    let mut value = sample_set_json();
    value["targets"][0]["targetId"] = Value::String("target b".to_string());
    let bytes = serde_json::to_vec(&value).unwrap();
    let set = JumpTargetSet::load_from_json(&bytes).unwrap();
    let index = index_with(&["bridge-unit-a", "bridge-unit-b"]);
    let error = set.validate(&index).unwrap_err();
    assert!(matches!(
        error,
        JumpTargetError::TargetIdLooksLikeLocalPath { .. }
    ));
}

#[test]
fn every_variant_has_a_registered_code() {
    let variants = [
        JumpTargetError::UnsupportedSchemaVersion {
            observed: "x".to_string(),
            expected: "y".to_string(),
        },
        JumpTargetError::InvalidJson {
            reason: "x".to_string(),
        },
        JumpTargetError::TargetIdLooksLikeLocalPath {
            target_id: "x".to_string(),
            reason: "x".to_string(),
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
    for variant in &variants {
        let code = variant.semantic_code();
        assert!(
            codes::ALL.contains(&code),
            "code {code:?} for {variant:?} not in codes::ALL"
        );
    }
    // And the registry has no aliases for missing variants.
    assert_eq!(codes::ALL.len(), variants.len());
}

#[test]
fn schema_version_constant_is_alpha() {
    assert_eq!(JUMP_TARGET_SCHEMA_VERSION, "0.1.0-alpha");
}

#[test]
fn in_memory_bridge_unit_index_round_trips() {
    let mut index = InMemoryBridgeUnitIndex::new();
    assert!(index.is_empty());
    index.insert("bridge-unit-1");
    index.insert("bridge-unit-2");
    index.insert("bridge-unit-1");
    assert_eq!(index.len(), 2);
    assert!(index.contains("bridge-unit-1"));
    assert!(!index.contains("bridge-unit-3"));
}
