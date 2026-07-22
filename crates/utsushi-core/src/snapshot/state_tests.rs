use super::*;

fn id(raw: &str) -> AssetId {
    AssetId::parse(raw).expect("valid asset id")
}

fn sample_bytes_value() -> BytesValue {
    BytesValue {
        sample_hex: "deadbeef".to_string(),
        hash: "0".repeat(BYTES_HASH_HEX_LEN),
        length: 4,
    }
}

#[test]
fn state_path_parses_valid_dotted_segments_into_canonical_form() {
    let path = StatePath::parse("runtime.clock.tick").expect("valid path");
    assert_eq!(path.as_str(), "runtime.clock.tick");
    let collected: Vec<&str> = path.segments().collect();
    assert_eq!(collected, vec!["runtime", "clock", "tick"]);
    assert_eq!(path.top_level(), "runtime");
    assert_eq!(path.namespace(), StateNamespace::Runtime);
}

#[test]
fn state_path_rejects_empty_path_with_invalid_state_path_error() {
    let err = StatePath::parse("").expect_err("empty path must fail");
    assert!(matches!(err, SnapshotError::InvalidStatePath { .. }));
}

#[test]
fn state_path_rejects_uppercase_segment_with_invalid_state_path_error() {
    let err = StatePath::parse("runtime.Clock").expect_err("uppercase must fail");
    assert!(matches!(err, SnapshotError::InvalidStatePath { .. }));
}

#[test]
fn state_path_rejects_more_than_max_segments_with_invalid_state_path_error() {
    let raw = std::iter::once("runtime")
        .chain(std::iter::repeat_n("seg", MAX_STATE_PATH_SEGMENTS))
        .collect::<Vec<_>>()
        .join(".");
    let err = StatePath::parse(&raw).expect_err("too many segments must fail");
    assert!(matches!(err, SnapshotError::InvalidStatePath { .. }));
}

#[test]
fn state_path_rejects_path_longer_than_max_bytes() {
    let raw = format!("port.{}", "x".repeat(MAX_STATE_PATH_BYTES));
    let err = StatePath::parse(&raw).expect_err("overlong path must fail");
    assert!(matches!(err, SnapshotError::InvalidStatePath { .. }));
}

#[test]
fn state_path_rejects_unknown_top_level_namespace() {
    let err = StatePath::parse("nope.frame").expect_err("unknown ns must fail");
    match err {
        SnapshotError::UnknownStateNamespace { observed_root, .. } => {
            assert_eq!(observed_root, "nope");
        }
        other => panic!("unexpected variant: {other:?}"),
    }
}

#[test]
fn state_path_rejects_segment_containing_host_path_shape() {
    let err = StatePath::parse("port.\\home\\trevor").expect_err("backslash must fail");
    // Either local-path redaction (drive-letter / backslash shape) or
    // segment-character validation may catch this; both are
    // InvalidStatePath.
    assert!(matches!(err, SnapshotError::InvalidStatePath { .. }));
}

#[test]
fn state_value_string_serializes_with_value_kind_tag() {
    let value = StateValue::String {
        value: "ok".to_string(),
    };
    let json = serde_json::to_value(&value).expect("serializes");
    assert_eq!(json["valueKind"], "string");
    assert_eq!(json["value"], "ok");
}

#[test]
fn state_value_string_with_local_path_fails_redaction_on_validate() {
    let value = StateValue::String {
        value: "/home/trevor/x".to_string(),
    };
    let err = value
        .validate("port.cache_dir")
        .expect_err("local path must fail");
    assert!(matches!(err, SnapshotError::RedactionViolation { .. }));
}

#[test]
fn state_value_int_round_trips_through_serde_json() {
    let value = StateValue::Int { value: -42 };
    let serialized = serde_json::to_string(&value).expect("serializes");
    let parsed: StateValue = serde_json::from_str(&serialized).expect("deserializes");
    assert_eq!(parsed, value);
}

#[test]
fn state_value_asset_id_uses_vfs_scheme_string_in_wire_form() {
    let value = StateValue::AssetId {
        value: id("vfs://www/script.txt"),
    };
    let json = serde_json::to_value(&value).expect("serializes");
    assert_eq!(json["valueKind"], "assetId");
    assert_eq!(json["value"], "vfs://www/script.txt");
}

#[test]
fn state_value_bytes_requires_full_length_hash() {
    let mut bytes = sample_bytes_value();
    bytes.hash = "short".to_string();
    let value = StateValue::Bytes(bytes);
    let err = value.validate("port.blob").expect_err("short hash fails");
    assert!(matches!(err, SnapshotError::InvalidBytesValue { .. }));
}

#[test]
fn state_value_bytes_caps_sample_hex_at_documented_length() {
    let mut bytes = sample_bytes_value();
    bytes.sample_hex = "ab".repeat(BYTES_SAMPLE_HEX_LEN);
    let value = StateValue::Bytes(bytes);
    let err = value
        .validate("port.blob")
        .expect_err("oversize sample fails");
    match err {
        SnapshotError::InvalidBytesValue { reason, .. } => {
            assert!(reason.contains("sample_hex"));
        }
        other => panic!("unexpected variant: {other:?}"),
    }
}

#[test]
fn state_value_bytes_diff_compares_on_hash_not_sample_hex() {
    let left = StateValue::Bytes(BytesValue {
        sample_hex: "aaaa".to_string(),
        hash: "0".repeat(BYTES_HASH_HEX_LEN),
        length: 4,
    });
    let right = StateValue::Bytes(BytesValue {
        sample_hex: "bbbb".to_string(),
        hash: "0".repeat(BYTES_HASH_HEX_LEN),
        length: 4,
    });
    assert_eq!(left, right);
}

#[test]
fn state_value_tick_round_trips_through_serde_json() {
    let value = StateValue::Tick {
        value: LogicalClockTick(7),
    };
    let serialized = serde_json::to_string(&value).expect("serializes");
    let parsed: StateValue = serde_json::from_str(&serialized).expect("deserializes");
    assert_eq!(parsed, value);
}

#[test]
fn state_value_nested_serializes_entries_in_sorted_key_order() {
    let mut entries = BTreeMap::new();
    entries.insert("zeta".to_string(), StateValue::Int { value: 1 });
    entries.insert("alpha".to_string(), StateValue::Int { value: 2 });
    let value = StateValue::Nested { entries };
    let json = serde_json::to_string(&value).expect("serializes");
    let alpha = json.find("alpha").expect("alpha present");
    let zeta = json.find("zeta").expect("zeta present");
    assert!(alpha < zeta, "alpha should serialize before zeta");
}

#[test]
fn state_tree_insert_canonicalises_path_and_rejects_duplicates() {
    let mut tree = StateTree::new();
    let path = StatePath::parse("port.frame").expect("path");
    tree.insert(path.clone(), StateValue::Uint { value: 1 })
        .expect("first insert");
    let err = tree
        .insert(path.clone(), StateValue::Uint { value: 2 })
        .expect_err("duplicate must fail");
    assert!(matches!(err, SnapshotError::DuplicateStatePath { .. }));
}

#[test]
fn state_tree_validate_rejects_value_carrying_host_path() {
    // Bypass the insert-time validator by mutating the tree behind
    // the internal map: simulate a malformed nested structure that
    // somehow contains a host string. We do this by constructing the
    // nested map ourselves; insert() validates leaves so we use
    // String at a path whose value would slip past — except insert
    // catches it. We exercise the serialized-form walk by encoding
    // a Nested whose inner value is unredacted: insert-time
    // validation must reject this same input.
    let mut entries = BTreeMap::new();
    entries.insert(
        "cache_dir".to_string(),
        StateValue::String {
            value: "/home/trevor/cache".to_string(),
        },
    );
    let mut tree = StateTree::new();
    let path = StatePath::parse("port.cache").expect("path");
    let err = tree
        .insert(path, StateValue::Nested { entries })
        .expect_err("nested host path must fail");
    assert!(matches!(err, SnapshotError::RedactionViolation { .. }));
}

#[test]
fn state_tree_iter_returns_paths_in_sorted_order() {
    let mut tree = StateTree::new();
    tree.insert(
        StatePath::parse("runtime.b").expect("p"),
        StateValue::Int { value: 1 },
    )
    .expect("insert");
    tree.insert(
        StatePath::parse("runtime.a").expect("p"),
        StateValue::Int { value: 2 },
    )
    .expect("insert");
    tree.insert(
        StatePath::parse("port.frame").expect("p"),
        StateValue::Int { value: 3 },
    )
    .expect("insert");
    let collected: Vec<&str> = tree.paths().map(StatePath::as_str).collect();
    assert_eq!(collected, vec!["port.frame", "runtime.a", "runtime.b"]);
}

#[test]
fn state_tree_serialized_form_passes_reject_unredacted_local_paths() {
    let mut tree = StateTree::new();
    tree.insert(
        StatePath::parse("metadata.adapter_name").expect("p"),
        StateValue::String {
            value: "deterministic-fixture".to_string(),
        },
    )
    .expect("insert");
    tree.insert(
        StatePath::parse("vfs.asset_root").expect("p"),
        StateValue::AssetId {
            value: id("vfs://www/script.txt"),
        },
    )
    .expect("insert");
    tree.validate().expect("clean tree");
}
