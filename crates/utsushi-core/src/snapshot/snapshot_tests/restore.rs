use super::*;

// Restorable round-trip & restoration error tests.

struct FakePort {
    id: &'static str,
    frame: u64,
    last_string: Option<String>,
}

impl Inspectable for FakePort {
    fn inspectable_id(&self) -> &'static str {
        self.id
    }
    fn inspect_state(&self) -> Result<StateTree, SnapshotError> {
        let mut tree = StateTree::new();
        tree.insert(
            StatePath::parse("port.frame").expect("path"),
            StateValue::Uint { value: self.frame },
        )?;
        if let Some(text) = &self.last_string {
            tree.insert(
                StatePath::parse("port.last").expect("path"),
                StateValue::String {
                    value: text.clone(),
                },
            )?;
        }
        tree.insert(
            StatePath::parse("metadata.adapter_name").expect("path"),
            StateValue::String {
                value: "fake-port".to_string(),
            },
        )?;
        Ok(tree)
    }
}

impl Restorable for FakePort {
    fn restore_state(&mut self, state: &StateTree) -> Result<RestoreReport, SnapshotError> {
        let mut consumed = Vec::new();
        let mut ignored = Vec::new();
        for (path, value) in state.iter() {
            match (path.as_str(), value) {
                ("port.frame", StateValue::Uint { value }) => {
                    self.frame = *value;
                    consumed.push(path.clone());
                }
                ("port.frame", other) => {
                    return Err(SnapshotError::RestoreTypeMismatch {
                        path: path.clone(),
                        expected: "uint",
                        found: other.type_tag(),
                    });
                }
                ("port.last", StateValue::String { value }) => {
                    self.last_string = Some(value.clone());
                    consumed.push(path.clone());
                }
                ("metadata.adapter_name", StateValue::String { .. }) => {
                    // Metadata is informational; declare ignored by
                    // design so the runner can audit-track it.
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
    let request =
        SnapshotRequest::new("run-001", "2026-06-23T00:00:00Z", EvidenceTier::E2).with_tick(tick);
    take_snapshot(port, &request).expect("snapshot")
}

#[test]
fn restore_snapshot_round_trip_produces_equal_snapshot_on_re_take() {
    let mut port = FakePort {
        id: "fake-port",
        frame: 1,
        last_string: Some("hello".to_string()),
    };
    let snapshot_a = take(&port, 1);
    port.frame = 42;
    port.last_string = Some("changed".to_string());
    restore_snapshot(&mut port, &snapshot_a).expect("restore");
    let snapshot_b = take(&port, 1);
    assert_eq!(snapshot_a, snapshot_b);
    let bytes_a = serde_json::to_vec(&snapshot_a).expect("a bytes");
    let bytes_b = serde_json::to_vec(&snapshot_b).expect("b bytes");
    assert_eq!(bytes_a, bytes_b, "canonical JSON form must be byte-equal");
}

#[test]
fn restore_snapshot_with_mismatched_inspectable_id_returns_typed_error() {
    let port_a = FakePort {
        id: "fake-port",
        frame: 1,
        last_string: None,
    };
    let snapshot = take(&port_a, 1);
    let mut port_b = FakePort {
        id: "different-port",
        frame: 0,
        last_string: None,
    };
    let err = restore_snapshot(&mut port_b, &snapshot).expect_err("mismatch");
    assert!(matches!(err, SnapshotError::InspectableIdMismatch { .. }));
}

#[test]
fn restore_snapshot_with_unknown_state_path_returns_restore_state_path_unknown() {
    struct PortReturningSeed;
    impl Inspectable for PortReturningSeed {
        fn inspectable_id(&self) -> &'static str {
            "fake-port"
        }
        fn inspect_state(&self) -> Result<StateTree, SnapshotError> {
            let mut tree = StateTree::new();
            tree.insert(
                StatePath::parse("port.unknown_thing").expect("p"),
                StateValue::Uint { value: 1 },
            )?;
            Ok(tree)
        }
    }

    // Construct a snapshot whose state tree carries a path the port
    // does not consume.
    let mut tree = StateTree::new();
    tree.insert(
        StatePath::parse("port.unknown_thing").expect("p"),
        StateValue::Uint { value: 1 },
    )
    .expect("insert");
    let seed_port = PortReturningSeed;
    let snapshot = take(&seed_port, 1);
    let mut port = FakePort {
        id: "fake-port",
        frame: 0,
        last_string: None,
    };
    let err = restore_snapshot(&mut port, &snapshot).expect_err("unknown");
    assert!(matches!(err, SnapshotError::RestoreStatePathUnknown { .. }));
}

#[test]
fn restore_snapshot_with_wrong_type_returns_restore_type_mismatch() {
    struct WrongTypePort;
    impl Inspectable for WrongTypePort {
        fn inspectable_id(&self) -> &'static str {
            "fake-port"
        }
        fn inspect_state(&self) -> Result<StateTree, SnapshotError> {
            let mut tree = StateTree::new();
            tree.insert(
                StatePath::parse("port.frame").expect("p"),
                StateValue::String {
                    value: "not-a-number".to_string(),
                },
            )?;
            Ok(tree)
        }
    }
    let wrong = WrongTypePort;
    let snapshot = take(&wrong, 1);
    let mut port = FakePort {
        id: "fake-port",
        frame: 0,
        last_string: None,
    };
    let err = restore_snapshot(&mut port, &snapshot).expect_err("mismatch");
    assert!(matches!(err, SnapshotError::RestoreTypeMismatch { .. }));
}

#[test]
fn restore_snapshot_with_out_of_range_value_returns_restore_value_out_of_range() {
    struct StrictPort {
        frame: u64,
    }
    impl Inspectable for StrictPort {
        fn inspectable_id(&self) -> &'static str {
            "strict-port"
        }
        fn inspect_state(&self) -> Result<StateTree, SnapshotError> {
            let mut tree = StateTree::new();
            tree.insert(
                StatePath::parse("port.frame").expect("p"),
                StateValue::Uint { value: self.frame },
            )?;
            Ok(tree)
        }
    }
    impl Restorable for StrictPort {
        fn restore_state(&mut self, state: &StateTree) -> Result<RestoreReport, SnapshotError> {
            for (path, value) in state.iter() {
                if path.as_str() == "port.frame"
                    && let StateValue::Uint { value } = value
                {
                    if *value > 1_000 {
                        return Err(SnapshotError::RestoreValueOutOfRange {
                            path: path.clone(),
                            reason: "frame ceiling 1000".to_string(),
                        });
                    }
                    self.frame = *value;
                }
            }
            Ok(RestoreReport::empty())
        }
    }
    let seed = StrictPort { frame: 10_000 };
    let snapshot = take(&seed, 1);
    let mut port = StrictPort { frame: 0 };
    let err = restore_snapshot(&mut port, &snapshot).expect_err("out of range");
    assert!(matches!(err, SnapshotError::RestoreValueOutOfRange { .. }));
}

#[test]
fn restore_snapshot_on_inspect_only_port_returns_restore_unsupported() {
    // A port that does not implement `Restorable` cannot be passed to
    // `restore_snapshot` (compile-time check). Surface the same
    // posture via the typed error: a port that knows it cannot
    // restore returns `RestoreUnsupported` from inside its
    // implementation.
    struct InspectOnlyWithStub;
    impl Inspectable for InspectOnlyWithStub {
        fn inspectable_id(&self) -> &'static str {
            "inspect-only"
        }
        fn inspect_state(&self) -> Result<StateTree, SnapshotError> {
            let mut tree = StateTree::new();
            tree.insert(
                StatePath::parse("port.frame").expect("p"),
                StateValue::Uint { value: 1 },
            )?;
            Ok(tree)
        }
    }
    impl Restorable for InspectOnlyWithStub {
        fn restore_state(&mut self, _: &StateTree) -> Result<RestoreReport, SnapshotError> {
            Err(SnapshotError::RestoreUnsupported {
                inspectable_id: "inspect-only".to_string(),
            })
        }
    }
    let seed = InspectOnlyWithStub;
    let snapshot = take(&seed, 1);
    let mut port = InspectOnlyWithStub;
    let err = restore_snapshot(&mut port, &snapshot).expect_err("unsupported");
    assert!(matches!(err, SnapshotError::RestoreUnsupported { .. }));
}

#[test]
fn restore_snapshot_with_old_schema_version_returns_schema_version_mismatch() {
    // Bypass `from_json_value` validation by constructing the
    // Snapshot manually through serde — we want to exercise the
    // `restore_snapshot` check, not the from_json_value check.
    // Use a permissive deserializer wrapper.
    #[derive(Serialize, Deserialize)]
    struct Raw {
        schema_version: SnapshotSchemaVersion,
        snapshot_id: SnapshotId,
        generated_at: String,
        inspectable_id: String,
        state_tree: StateTree,
        evidence_tier: EvidenceTier,
        envelope_class: SnapshotEnvelope,
    }
    impl Raw {
        fn into_snapshot(self) -> Snapshot {
            // Build via JSON round-trip into a Snapshot value
            // bypassing `from_json_value`'s validate call.
            serde_json::from_value(serde_json::json!({
                "schemaVersion": self.schema_version,
                "snapshotId": self.snapshot_id,
                "generatedAt": self.generated_at,
                "inspectableId": self.inspectable_id,
                "stateTree": self.state_tree,
                "evidenceTier": self.evidence_tier,
                "envelopeClass": self.envelope_class,
            }))
            .expect("snapshot")
        }
    }

    let snapshot = make_snapshot();
    let mut json = snapshot.to_json_value().expect("json");
    json["schemaVersion"] = "0.0.1".into();
    let raw = Raw {
        schema_version: SnapshotSchemaVersion("0.0.1".to_string()),
        snapshot_id: snapshot.snapshot_id().clone(),
        generated_at: snapshot.generated_at().to_string(),
        inspectable_id: snapshot.inspectable_id().to_string(),
        state_tree: snapshot.state_tree().clone(),
        evidence_tier: snapshot.evidence_tier(),
        envelope_class: snapshot.envelope_class(),
    };
    let bad_snapshot = raw.into_snapshot();
    let mut port = FakePort {
        id: "utsushi-fixture",
        frame: 0,
        last_string: None,
    };
    let err = restore_snapshot(&mut port, &bad_snapshot).expect_err("bad schema");
    assert!(matches!(err, SnapshotError::SchemaVersionMismatch { .. }));
}
