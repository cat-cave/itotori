//! Integration test for the snapshot substrate's redaction claim
//! ( §1 claim 3).
//!
//! Exercises all three redaction layers:
//! 1. `StatePath::parse` rejects host-path-shaped path strings.
//! 2. `StateValue::String` rejects host-path values at insert time.
//! 3. `Snapshot::validate` rejects unredacted strings in the serialized form
//!    (the belt-and-suspenders walk over the JSON envelope).

use utsushi_core::{
    AssetId, BYTES_HASH_HEX_LEN, BYTES_SAMPLE_HEX_LEN, BytesValue, EvidenceTier, Inspectable,
    Snapshot, SnapshotError, SnapshotRequest, StatePath, StateTree, StateValue, take_snapshot,
};

const INSPECTABLE_ID: &str = "utsushi-fixture-redaction";

struct LeakyPort {
    bad_value: StateValue,
}

impl Inspectable for LeakyPort {
    fn inspectable_id(&self) -> &'static str {
        INSPECTABLE_ID
    }
    fn inspect_state(&self) -> Result<StateTree, SnapshotError> {
        let mut tree = StateTree::new();
        tree.insert(
            StatePath::parse("port.cache_dir").expect("path"),
            self.bad_value.clone(),
        )?;
        Ok(tree)
    }
}

#[test]
fn snapshot_payload_does_not_contain_temp_path_after_inspectable_emits_one() {
    // Layer 2: a port that tries to expose `/tmp/secret` under
    // `port.cache_dir` fails at `inspect_state` because `StateTree::insert`
    // validates the leaf value and the local-path filter rejects the
    // string.
    let port = LeakyPort {
        bad_value: StateValue::String {
            value: "/tmp/secret".to_string(),
        },
    };
    let request = SnapshotRequest::new("run-redaction", "2026-06-23T12:00:00Z", EvidenceTier::E2)
        .with_tick(1);
    let err = take_snapshot(&port, &request).expect_err("must reject local path");
    assert!(matches!(err, SnapshotError::RedactionViolation { .. }));
}

#[test]
fn snapshot_payload_does_not_embed_raw_asset_bytes() {
    // BytesValue carries hash + sample only. A sample longer than the
    // documented ceiling fails validation; that ceiling is the structural
    // bar that prevents accidental embedding of raw asset bytes.
    let leaky_bytes = BytesValue {
        sample_hex: "ab".repeat(BYTES_SAMPLE_HEX_LEN),
        hash: "0".repeat(BYTES_HASH_HEX_LEN),
        length: 4,
    };
    let port = LeakyPort {
        bad_value: StateValue::Bytes(leaky_bytes),
    };
    let request = SnapshotRequest::new("run-redaction", "2026-06-23T12:00:00Z", EvidenceTier::E2)
        .with_tick(1);
    let err = take_snapshot(&port, &request).expect_err("must reject oversize bytes");
    assert!(matches!(err, SnapshotError::InvalidBytesValue { .. }));
}

#[test]
fn snapshot_with_asset_id_references_does_not_embed_asset_bytes() {
    // Positive case: AssetId references are the only path-shaped values
    // allowed in a snapshot. The serialized form contains only
    // `vfs://...` strings, no asset payload bytes, and passes the
    // redaction walk.
    struct CleanPort;
    impl Inspectable for CleanPort {
        fn inspectable_id(&self) -> &'static str {
            INSPECTABLE_ID
        }
        fn inspect_state(&self) -> Result<StateTree, SnapshotError> {
            let mut tree = StateTree::new();
            tree.insert(
                StatePath::parse("vfs.script").expect("path"),
                StateValue::AssetId {
                    value: AssetId::parse("vfs://www/script.txt").expect("asset"),
                },
            )?;
            tree.insert(
                StatePath::parse("metadata.adapter_name").expect("path"),
                StateValue::String {
                    value: "deterministic-fixture".to_string(),
                },
            )?;
            Ok(tree)
        }
    }
    let port = CleanPort;
    let request = SnapshotRequest::new("run-redaction", "2026-06-23T12:00:00Z", EvidenceTier::E2)
        .with_tick(1);
    let snapshot = take_snapshot(&port, &request).expect("clean snapshot");
    let serialized = serde_json::to_string(&snapshot).expect("to json");
    assert!(
        serialized.contains("vfs://www/script.txt"),
        "asset id must appear in serialized form: {serialized}"
    );
    // The serialized form must not contain host-path substrings.
    for forbidden in ["/home/", "/tmp/", "/Users/", "/var/folders/", "file://"] {
        assert!(
            !serialized.contains(forbidden),
            "serialized form contained {forbidden}: {serialized}"
        );
    }
}

#[test]
fn snapshot_state_path_with_drive_letter_shape_is_rejected_at_parse() {
    // Layer 1: a state path that looks like a Windows drive-letter path
    // is rejected at parse time. Engine ports cannot encode host paths
    // in segment names.
    let err = StatePath::parse("port.c:\\users\\trevor").expect_err("must reject");
    assert!(matches!(err, SnapshotError::InvalidStatePath { .. }));
}

#[test]
fn snapshot_validate_redaction_walk_catches_serialized_form_leak() {
    // Layer 3 / defense-in-depth: a JSON snapshot whose state tree
    // entries somehow contain a host string fails the final walk. We
    // construct such a payload by hand and reconstitute it.
    let port = LeakyPort {
        bad_value: StateValue::String {
            value: "deterministic-fixture".to_string(),
        },
    };
    let request = SnapshotRequest::new("run-redaction", "2026-06-23T12:00:00Z", EvidenceTier::E2)
        .with_tick(1);
    let snapshot = take_snapshot(&port, &request).expect("clean");
    let mut json = serde_json::to_value(&snapshot).expect("to value");
    // Replace the clean string with a leaking one inside the serialized
    // payload and reconstitute.
    json["stateTree"]["port.cache_dir"]["value"] =
        serde_json::Value::String("/home/trevor/leak".to_string());
    let err = Snapshot::from_json_value(json).expect_err("must reject");
    assert!(matches!(err, SnapshotError::RedactionViolation { .. }));
}
