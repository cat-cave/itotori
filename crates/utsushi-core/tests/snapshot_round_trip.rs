//! Integration test for the snapshot substrate's round-trip determinism
//! claim (UTSUSHI-023 §1 claim 1).
//!
//! Builds an in-test fixture port that implements `Inspectable` + `Restorable`
//! against a small state surface, takes a snapshot, mutates the port, restores
//! from the snapshot, re-takes a snapshot, and asserts the canonical
//! serialized form is byte-equal.

use std::collections::BTreeMap;

use utsushi_core::{
    AssetId, EvidenceTier, Inspectable, LogicalClockTick, Restorable, RestoreReport, Snapshot,
    SnapshotError, SnapshotRequest, StatePath, StateTree, StateValue, diff_snapshots,
    restore_snapshot, take_snapshot,
};

const INSPECTABLE_ID: &str = "utsushi-fixture-roundtrip";

struct FixtureInspectable {
    tick: u64,
    bridge_cursor: u64,
    frame: u64,
    asset: AssetId,
    nested_flag: bool,
}

impl FixtureInspectable {
    fn new() -> Self {
        Self {
            tick: 1,
            bridge_cursor: 0,
            frame: 0,
            asset: AssetId::parse("vfs://www/script.ks").expect("asset"),
            nested_flag: false,
        }
    }
}

impl Inspectable for FixtureInspectable {
    fn inspectable_id(&self) -> &'static str {
        INSPECTABLE_ID
    }

    fn inspect_state(&self) -> Result<StateTree, SnapshotError> {
        let mut tree = StateTree::new();
        tree.insert(
            StatePath::parse("runtime.clock.tick").expect("path"),
            StateValue::Tick {
                value: LogicalClockTick(self.tick),
            },
        )?;
        tree.insert(
            StatePath::parse("bridge.unit.cursor").expect("path"),
            StateValue::Uint {
                value: self.bridge_cursor,
            },
        )?;
        tree.insert(
            StatePath::parse("port.frame").expect("path"),
            StateValue::Uint { value: self.frame },
        )?;
        tree.insert(
            StatePath::parse("vfs.script").expect("path"),
            StateValue::AssetId {
                value: self.asset.clone(),
            },
        )?;
        let mut nested = BTreeMap::new();
        nested.insert(
            "flag".to_string(),
            StateValue::Bool {
                value: self.nested_flag,
            },
        );
        nested.insert(
            "counter".to_string(),
            StateValue::Int {
                value: self.tick as i64,
            },
        );
        tree.insert(
            StatePath::parse("port.nested").expect("path"),
            StateValue::Nested { entries: nested },
        )?;
        tree.insert(
            StatePath::parse("metadata.adapter_name").expect("path"),
            StateValue::String {
                value: "utsushi-fixture-roundtrip".to_string(),
            },
        )?;
        Ok(tree)
    }
}

impl Restorable for FixtureInspectable {
    fn restore_state(&mut self, state: &StateTree) -> Result<RestoreReport, SnapshotError> {
        let mut consumed = Vec::new();
        let mut ignored = Vec::new();
        for (path, value) in state.iter() {
            match (path.as_str(), value) {
                ("runtime.clock.tick", StateValue::Tick { value }) => {
                    self.tick = value.get();
                    consumed.push(path.clone());
                }
                ("bridge.unit.cursor", StateValue::Uint { value }) => {
                    self.bridge_cursor = *value;
                    consumed.push(path.clone());
                }
                ("port.frame", StateValue::Uint { value }) => {
                    self.frame = *value;
                    consumed.push(path.clone());
                }
                ("vfs.script", StateValue::AssetId { value }) => {
                    self.asset = value.clone();
                    consumed.push(path.clone());
                }
                ("port.nested", StateValue::Nested { entries }) => {
                    if let Some(StateValue::Bool { value }) = entries.get("flag") {
                        self.nested_flag = *value;
                    } else {
                        return Err(SnapshotError::RestoreTypeMismatch {
                            path: path.clone(),
                            expected: "nested.flag=bool",
                            found: "missing",
                        });
                    }
                    consumed.push(path.clone());
                }
                ("metadata.adapter_name", StateValue::String { .. }) => {
                    ignored.push(path.clone());
                }
                _ => {
                    return Err(SnapshotError::RestoreStatePathUnknown { path: path.clone() });
                }
            }
        }
        Ok(RestoreReport {
            consumed_paths: consumed,
            ignored_by_design: ignored,
        })
    }
}

fn take(port: &dyn Inspectable, tick: u64) -> Snapshot {
    let request = SnapshotRequest::new("run-roundtrip", "2026-06-23T12:00:00Z", EvidenceTier::E2)
        .with_tick(tick);
    take_snapshot(port, &request).expect("snapshot")
}

#[test]
fn fixture_inspectable_round_trip_produces_equal_state_tree() {
    let mut port = FixtureInspectable::new();
    port.tick = 7;
    port.bridge_cursor = 11;
    port.frame = 5;
    port.nested_flag = true;
    let snapshot_a = take(&port, 7);

    // Mutate the port to a clearly different state.
    port.tick = 99;
    port.bridge_cursor = 0;
    port.frame = 1234;
    port.asset = AssetId::parse("vfs://www/other.ks").expect("asset");
    port.nested_flag = false;

    // Restore from snapshot A.
    let report = restore_snapshot(&mut port, &snapshot_a).expect("restore");
    // Audit-focus: every path is consumed or explicitly ignored.
    assert!(
        report
            .consumed_paths
            .iter()
            .any(|p| p.as_str() == "port.frame")
    );
    assert!(
        report
            .ignored_by_design
            .iter()
            .any(|p| p.as_str() == "metadata.adapter_name")
    );

    // Re-take a snapshot at the same tick.
    let snapshot_b = take(&port, 7);
    assert_eq!(snapshot_a, snapshot_b);
    let bytes_a = serde_json::to_vec(&snapshot_a).expect("a");
    let bytes_b = serde_json::to_vec(&snapshot_b).expect("b");
    assert_eq!(
        bytes_a, bytes_b,
        "round-trip canonical JSON form must be byte-equal"
    );

    // The diff between the two must be empty.
    let diff = diff_snapshots(&snapshot_a, &snapshot_b).expect("diff");
    assert!(diff.is_empty(), "round-trip diff must be empty");
}

#[test]
fn fixture_inspectable_round_trip_observation_sequence_matches_after_restore() {
    // Coordination with UTSUSHI-021: a fixture-driven adapter that
    // produces a deterministic observation sequence from a known state
    // tree (here a list of (tick, frame) pairs) must produce the same
    // sequence after a snapshot round trip.
    fn observe(port: &FixtureInspectable) -> Vec<(u64, u64)> {
        vec![(port.tick, port.frame)]
    }
    let mut port = FixtureInspectable::new();
    port.tick = 3;
    port.frame = 42;
    let snapshot = take(&port, 3);
    let before = observe(&port);
    port.tick = 0;
    port.frame = 0;
    restore_snapshot(&mut port, &snapshot).expect("restore");
    let after = observe(&port);
    assert_eq!(before, after);
}

#[test]
fn fixture_inspectable_round_trip_recovers_after_two_mutation_cycles() {
    // Defense in depth: prove the substrate restores deterministically
    // across multiple mutation/restore cycles.
    let mut port = FixtureInspectable::new();
    port.tick = 9;
    port.frame = 100;
    let snapshot_a = take(&port, 9);
    for cycle in 0..3 {
        port.tick = cycle;
        port.frame = cycle * 7;
        restore_snapshot(&mut port, &snapshot_a).expect("restore");
        let resnap = take(&port, 9);
        assert_eq!(resnap, snapshot_a, "cycle {cycle} mismatched");
    }
}
