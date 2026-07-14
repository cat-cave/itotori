//! Fixture snapshot restore playback smoke ().
//!
//! This single integration test exercises the controlled playback contract
//! through an inline fixture by performing a full **snapshot save → restore
//! → re-playback** cycle. The substrate (`InMemorySnapshotStore`
//! `SnapshotConformanceCheck`, `InMemoryReferenceRecorder`
//! `deterministic_json_bytes`) already exists; this slice is the structural
//! smoke gate that consumes it.
//!
//! Headline structural defenses:
//!
//! - **Pass on identity.** When `(baseline, observed)` are byte-identical
//!   `SnapshotConformanceCheck::run` returns `Pass` with an evidence tier
//!   that is the floor of `expected_tier`, the baseline tier, and the
//!   observed tier ( contract).
//! - **Fail with state_drift on divergence.** Mutating any `StatePath`
//!   value yields `Fail { semantic_code: "utsushi.snapshot.state_drift" }`
//!   with one `EvidenceRef::StatePath` entry per drifted path.
//! - **Missing snapshot → typed NotFound, never `Option<Snapshot>::None`.**
//!   The `SnapshotStore::resolve` contract returns
//!   `SnapshotStoreError::NotFound` (code `utsushi.snapshot.store_not_found`).
//! - **No host paths.** Every serialized payload passes
//!   `reject_unredacted_local_paths`.

use serde_json::Value;
use utsushi_core::conformance::result::ResultOutcome;
use utsushi_core::recorder::deterministic_json_bytes;
use utsushi_core::snapshot::store::codes as store_codes;
use utsushi_core::{
    ClockOrigin, EvidenceRef, EvidenceTier, InMemoryReferenceRecorder, InMemorySnapshotStore,
    InputEvent, Inspectable, LogicalClockTick, ProfileId, ReferenceRecorder, ReplayEntry,
    ReplayLogBuilder, ReplayMetadata, SNAPSHOT_SCHEMA_VERSION, Snapshot, SnapshotConformanceCheck,
    SnapshotError, SnapshotId, SnapshotRef, SnapshotRequest, SnapshotSchemaVersion, SnapshotStore,
    SnapshotStoreError, SourceTag, StatePath, StateTree, StateValue, diff_snapshots,
    redaction::reject_unredacted_local_paths, take_snapshot,
};

const INSPECTABLE_ID: &str = "utsushi-fixture";
const BASELINE_ID: &str = "smoke-snapshot-001";
const OBSERVED_ID: &str = "smoke-observed-001";
const BASELINE_TICK: u64 = 7;
const SMOKE_RUN_ID: &str = "fixture-snapshot-restore-smoke";

/// Inline inspectable port driving the smoke fixture. Carries a pre-built
/// `StateTree` so the test can construct multiple snapshot variants from
/// the same template.
struct SmokeInspect {
    tree: StateTree,
}

impl SmokeInspect {
    fn new(tree: StateTree) -> Self {
        Self { tree }
    }
}

impl Inspectable for SmokeInspect {
    fn inspectable_id(&self) -> &'static str {
        INSPECTABLE_ID
    }

    fn inspect_state(&self) -> Result<StateTree, SnapshotError> {
        Ok(self.tree.clone())
    }
}

/// Canonical baseline state entries. The substrate's `StatePath`
/// validator pins the top-level segment to a known [`StateNamespace`]
/// (`runtime`, `replay`, `bridge`, `vfs`, `port`, `metadata`), so the
/// smoke uses public, namespaced paths that any engine port could emit.
fn canonical_entries() -> Vec<(&'static str, StateValue)> {
    vec![
        (
            "bridge.scene_id",
            StateValue::String {
                value: "scene-loop-entry".to_string(),
            },
        ),
        ("bridge.scene_position_line", StateValue::Uint { value: 12 }),
        ("runtime.flags_read_count", StateValue::Uint { value: 4 }),
        (
            "port.inventory_slot_0",
            StateValue::String {
                value: "scene-token-a".to_string(),
            },
        ),
    ]
}

/// Build the canonical baseline `StateTree` shared by every test.
fn baseline_state_tree() -> StateTree {
    let mut tree = StateTree::new();
    for (path, value) in canonical_entries() {
        tree.insert(StatePath::parse(path).expect("baseline path"), value)
            .expect("insert canonical");
    }
    tree
}

fn baseline_snapshot() -> Snapshot {
    let port = SmokeInspect::new(baseline_state_tree());
    let request = SnapshotRequest::new(SMOKE_RUN_ID, "2026-06-23T00:00:00Z", EvidenceTier::E1)
        .with_snapshot_id(SnapshotId::parse(BASELINE_ID).expect("baseline id"))
        .with_tick(BASELINE_TICK);
    take_snapshot(&port, &request).expect("baseline snapshot")
}

fn observed_snapshot_identical_to_baseline() -> Snapshot {
    let port = SmokeInspect::new(baseline_state_tree());
    let request = SnapshotRequest::new(SMOKE_RUN_ID, "2026-06-23T00:00:00Z", EvidenceTier::E1)
        .with_snapshot_id(SnapshotId::parse(OBSERVED_ID).expect("observed id"))
        .with_tick(BASELINE_TICK);
    take_snapshot(&port, &request).expect("observed snapshot")
}

fn observed_snapshot_with_drift(mutations: &[(&str, StateValue)]) -> Snapshot {
    // The substrate's `StateTree::insert` rejects duplicates, so we build
    // a fresh tree from the canonical entries with mutation overrides
    // applied. The canonical entry list is the source of truth here.
    let mut tree = StateTree::new();
    for (path, default_value) in canonical_entries() {
        let mutation = mutations
            .iter()
            .find(|(mutated_path, _)| *mutated_path == path)
            .map(|(_, value)| value.clone());
        let value = mutation.unwrap_or_else(|| default_value.clone());
        tree.insert(StatePath::parse(path).expect("canonical path"), value)
            .expect("insert canonical");
    }
    let port = SmokeInspect::new(tree);
    let request = SnapshotRequest::new(SMOKE_RUN_ID, "2026-06-23T00:00:00Z", EvidenceTier::E1)
        .with_snapshot_id(SnapshotId::parse(OBSERVED_ID).expect("observed id"))
        .with_tick(BASELINE_TICK);
    take_snapshot(&port, &request).expect("observed snapshot")
}

fn snapshot_ref(snapshot: &Snapshot) -> SnapshotRef {
    SnapshotRef {
        snapshot_id: snapshot.snapshot_id().clone(),
        inspectable_id: snapshot.inspectable_id().to_string(),
        evidence_tier: snapshot.evidence_tier(),
    }
}

fn populated_store(baseline: &Snapshot, observed: &Snapshot) -> InMemorySnapshotStore {
    let store = InMemorySnapshotStore::new();
    store.insert(baseline.clone()).expect("insert baseline");
    store.insert(observed.clone()).expect("insert observed");
    store
}

fn build_check(baseline: &Snapshot, observed: &Snapshot) -> SnapshotConformanceCheck {
    SnapshotConformanceCheck {
        profile: ProfileId::SnapshotRestore,
        baseline: snapshot_ref(baseline),
        observed: snapshot_ref(observed),
        expected_tier: EvidenceTier::E1,
    }
}

#[test]
fn fixture_snapshot_round_trips_through_in_memory_store_byte_for_byte() {
    let baseline = baseline_snapshot();
    let store = InMemorySnapshotStore::new();
    store.insert(baseline.clone()).expect("save baseline");
    let resolved = store
        .resolve(&snapshot_ref(&baseline))
        .expect("resolve baseline");
    let before = serde_json::to_vec(&baseline).expect("serialize baseline");
    let after = serde_json::to_vec(&resolved).expect("serialize resolved");
    assert_eq!(
        before, after,
        "round-trip through InMemorySnapshotStore must be byte-identical"
    );
}

#[test]
fn fixture_snapshot_resolves_to_deep_equal_baseline() {
    let baseline = baseline_snapshot();
    let store = InMemorySnapshotStore::new();
    store.insert(baseline.clone()).expect("save baseline");
    let resolved = store
        .resolve(&snapshot_ref(&baseline))
        .expect("resolve baseline");
    assert_eq!(resolved, baseline);
}

#[test]
fn fixture_snapshot_serializes_identically_across_two_consecutive_calls() {
    let baseline = baseline_snapshot();
    let first = serde_json::to_vec(&baseline).expect("first");
    let second = serde_json::to_vec(&baseline).expect("second");
    assert_eq!(
        first, second,
        "two consecutive serializations of the same snapshot must be byte-equal"
    );
}

#[test]
fn fixture_snapshot_serialize_resolve_serialize_produces_byte_identical_output_across_three_runs() {
    let baseline = baseline_snapshot();
    let store = InMemorySnapshotStore::new();
    store.insert(baseline.clone()).expect("save baseline");
    let mut payloads = Vec::new();
    for _ in 0..3 {
        let resolved = store
            .resolve(&snapshot_ref(&baseline))
            .expect("resolve baseline");
        payloads.push(serde_json::to_vec(&resolved).expect("serialize resolved"));
    }
    assert_eq!(payloads[0], payloads[1]);
    assert_eq!(payloads[1], payloads[2]);
}

#[test]
fn fixture_snapshot_conformance_check_passes_when_baseline_and_observed_match() {
    let baseline = baseline_snapshot();
    let observed = observed_snapshot_identical_to_baseline();
    let store = populated_store(&baseline, &observed);
    let check = build_check(&baseline, &observed);

    let outcome = check.run(&store);
    match outcome {
        ResultOutcome::Pass { evidence_tier } => {
            // Pass tier floors at the minimum of the three sources.
            assert_eq!(evidence_tier, EvidenceTier::E1);
        }
        other => panic!("expected Pass, got {other:?}"),
    }
}

#[test]
fn fixture_snapshot_conformance_check_fails_with_state_drift_code_when_one_state_path_diverges() {
    let baseline = baseline_snapshot();
    let observed = observed_snapshot_with_drift(&[(
        "runtime.flags_read_count",
        StateValue::Uint { value: 99 },
    )]);
    let store = populated_store(&baseline, &observed);
    let check = build_check(&baseline, &observed);

    let outcome = check.run(&store);
    match &outcome {
        ResultOutcome::Fail { semantic_code, .. } => {
            assert_eq!(semantic_code, store_codes::STATE_DRIFT);
        }
        other => panic!("expected Fail, got {other:?}"),
    }

    // Pull the per-path StatePath evidence vec out of the diff to confirm
    // the audit-focus "verbatim path quoted" contract.
    let resolved_baseline = store.resolve(&check.baseline).expect("baseline");
    let resolved_observed = store.resolve(&check.observed).expect("observed");
    let diff = diff_snapshots(&resolved_baseline, &resolved_observed).expect("diff");
    let evidence = SnapshotConformanceCheck::state_path_evidence_from_diff(&diff);
    assert_eq!(evidence.len(), 1);
    match &evidence[0] {
        EvidenceRef::StatePath { path } => {
            assert_eq!(path, "runtime.flags_read_count");
        }
        other => panic!("expected StatePath evidence, got {other:?}"),
    }
}

#[test]
fn fixture_snapshot_conformance_check_lists_every_drifted_state_path_in_evidence() {
    let baseline = baseline_snapshot();
    let observed = observed_snapshot_with_drift(&[
        (
            "bridge.scene_id",
            StateValue::String {
                value: "scene-loop-back".to_string(),
            },
        ),
        ("bridge.scene_position_line", StateValue::Uint { value: 42 }),
        ("runtime.flags_read_count", StateValue::Uint { value: 7 }),
    ]);
    let store = populated_store(&baseline, &observed);
    let check = build_check(&baseline, &observed);

    let outcome = check.run(&store);
    assert!(matches!(outcome, ResultOutcome::Fail { .. }));

    let resolved_baseline = store.resolve(&check.baseline).expect("baseline");
    let resolved_observed = store.resolve(&check.observed).expect("observed");
    let diff = diff_snapshots(&resolved_baseline, &resolved_observed).expect("diff");
    let evidence = SnapshotConformanceCheck::state_path_evidence_from_diff(&diff);
    let paths: Vec<&str> = evidence
        .iter()
        .map(|entry| match entry {
            EvidenceRef::StatePath { path } => path.as_str(),
            other => panic!("expected StatePath, got {other:?}"),
        })
        .collect();
    // The diff iterator is sorted; the BTree iteration order is the
    // ordering we assert against to keep the test deterministic.
    assert_eq!(
        paths,
        vec![
            "bridge.scene_id",
            "bridge.scene_position_line",
            "runtime.flags_read_count",
        ]
    );
}

#[test]
fn fixture_snapshot_conformance_check_fail_detail_quotes_state_path_verbatim() {
    let baseline = baseline_snapshot();
    let observed = observed_snapshot_with_drift(&[(
        "port.inventory_slot_0",
        StateValue::String {
            value: "scene-token-b".to_string(),
        },
    )]);
    let store = populated_store(&baseline, &observed);
    let check = build_check(&baseline, &observed);

    let outcome = check.run(&store);
    match outcome {
        ResultOutcome::Fail {
            semantic_code,
            detail,
        } => {
            assert_eq!(semantic_code, store_codes::STATE_DRIFT);
            // The check's `detail` text reports the count; the verbatim
            // StatePath quoting lands in the EvidenceRef::StatePath vec.
            assert!(detail.contains('1'), "detail must report the path count");
        }
        other => panic!("expected Fail, got {other:?}"),
    }

    // And the verbatim-path defense lives on the EvidenceRef vec.
    let resolved_baseline = store.resolve(&check.baseline).expect("baseline");
    let resolved_observed = store.resolve(&check.observed).expect("observed");
    let diff = diff_snapshots(&resolved_baseline, &resolved_observed).expect("diff");
    let evidence = SnapshotConformanceCheck::state_path_evidence_from_diff(&diff);
    match &evidence[0] {
        EvidenceRef::StatePath { path } => {
            assert_eq!(path, "port.inventory_slot_0");
        }
        other => panic!("expected StatePath, got {other:?}"),
    }
}

#[test]
fn fixture_snapshot_store_resolve_returns_not_found_when_snapshot_ref_missing() {
    // Plan acceptance criterion 3: missing snapshot is NEVER an Option::None
    // silent skip; the typed error path is the only way out.
    let store = InMemorySnapshotStore::new();
    let missing_ref = SnapshotRef {
        snapshot_id: SnapshotId::parse("smoke-missing-001").expect("id"),
        inspectable_id: INSPECTABLE_ID.to_string(),
        evidence_tier: EvidenceTier::E1,
    };
    let err = store
        .resolve(&missing_ref)
        .expect_err("must surface NotFound");
    match &err {
        SnapshotStoreError::NotFound { snapshot_id } => {
            assert_eq!(snapshot_id.as_str(), "smoke-missing-001");
        }
        other => panic!("expected NotFound, got {other:?}"),
    }
    assert_eq!(err.semantic_code(), store_codes::STORE_NOT_FOUND);
}

#[test]
fn fixture_snapshot_store_does_not_silently_return_optional_none() {
    // Type-level pin: `SnapshotStore::resolve` returns
    // `Result<Snapshot, SnapshotStoreError>`. If a future refactor relaxes
    // this to `Result<Option<Snapshot>, _>` the closure binding fails at
    // compile time because `Option<Snapshot>` is not `Snapshot`.
    fn assert_resolve_signature<S: SnapshotStore>(store: &S, reference: &SnapshotRef) {
        let _: Result<Snapshot, SnapshotStoreError> = store.resolve(reference);
    }
    let store = InMemorySnapshotStore::new();
    let baseline = baseline_snapshot();
    store.insert(baseline.clone()).expect("insert baseline");
    assert_resolve_signature(&store, &snapshot_ref(&baseline));
}

#[test]
fn fixture_snapshot_store_resolve_returns_mismatched_schema_version_when_payload_pinned_to_old_version()
 {
    // Construct a snapshot with the pinned schema version, insert via
    // `insert`, then directly mutate the schema version through the
    // serialized round-trip path to simulate a stored-payload skew.
    let baseline = baseline_snapshot();
    let store = InMemorySnapshotStore::new();
    store.insert(baseline.clone()).expect("insert baseline");

    // Simulate stored-payload skew by inserting a freshly built snapshot
    // whose schema_version is forged through the serialization path.
    let mut forged_value = serde_json::to_value(&baseline).expect("to value");
    forged_value["schemaVersion"] = Value::String("0.0.1-fabricated".to_string());
    // Mutate the snapshot_id so we don't collide with the inserted record.
    forged_value["snapshotId"] = Value::String("smoke-forged-001".to_string());
    let forged: Result<Snapshot, _> = serde_json::from_value(forged_value);
    // Forged payloads round-trip into a Snapshot struct, but the schema
    // version field is a tagged literal; the round-trip succeeds at the
    // struct level. The InMemorySnapshotStore `insert` runs
    // `Snapshot::validate`, which rejects the mismatched schema version.
    let forged = forged.expect("forged value parses");
    let err = store.insert(forged).expect_err("forged insert must reject");
    match err {
        SnapshotStoreError::MismatchedSchemaVersion {
            observed, expected, ..
        } => {
            assert_eq!(observed, "0.0.1-fabricated");
            assert_eq!(expected, SNAPSHOT_SCHEMA_VERSION);
        }
        other => panic!("expected MismatchedSchemaVersion, got {other:?}"),
    }
    // And the in-store baseline still resolves cleanly.
    let resolved = store
        .resolve(&snapshot_ref(&baseline))
        .expect("baseline still resolves");
    assert_eq!(resolved.schema_version().as_str(), SNAPSHOT_SCHEMA_VERSION);
}

#[test]
fn fixture_snapshot_clock_tick_aligns_with_replay_log_post_restore_tail() {
    // Audit-focus defense for "deterministic playback gaps": the baseline
    // snapshot's clock tick (BASELINE_TICK) lines up with the first
    // post-restore ReplayEntry's tick. Recording this through the
    // `InMemoryReferenceRecorder` and re-asserting the alignment closes the
    // loop end-to-end.
    let baseline = baseline_snapshot();
    let store = InMemorySnapshotStore::new();
    store.insert(baseline.clone()).expect("insert baseline");
    let resolved = store
        .resolve(&snapshot_ref(&baseline))
        .expect("resolve baseline");
    assert_eq!(resolved, baseline);

    let recorder = InMemoryReferenceRecorder::new(SourceTag::Fixture, INSPECTABLE_ID, SMOKE_RUN_ID);
    // Post-restore tail: text-advance at BASELINE_TICK + 1, advance at +2.
    let tail_first = ReplayEntry {
        tick: LogicalClockTick(BASELINE_TICK + 1),
        event: InputEvent::text(),
    };
    let tail_second = ReplayEntry {
        tick: LogicalClockTick(BASELINE_TICK + 2),
        event: InputEvent::advance(),
    };
    recorder.record_replay_event(tail_first.clone());
    recorder.record_replay_event(tail_second.clone());

    let trace = recorder.finalize();
    assert_eq!(trace.replay_events.len(), 2);
    assert_eq!(
        trace.replay_events[0].tick,
        LogicalClockTick(BASELINE_TICK + 1)
    );
    assert_eq!(
        trace.replay_events[1].tick,
        LogicalClockTick(BASELINE_TICK + 2)
    );

    // The recorded trace and the snapshot's tick must be byte-deterministic.
    let bytes_a = deterministic_json_bytes(&trace);
    let bytes_b = deterministic_json_bytes(&trace);
    assert_eq!(bytes_a, bytes_b);

    // Round-trip the tail through `ReplayLogBuilder` so the test exercises
    // the existing surface end-to-end as well.
    let mut builder = ReplayLogBuilder::new().metadata(ReplayMetadata::new(
        SMOKE_RUN_ID.to_string(),
        INSPECTABLE_ID.to_string(),
        "0.1.0-alpha",
        ClockOrigin::SnapshotRestore,
        0,
        None,
    ));
    builder.record(tail_first.tick, tail_first.event).unwrap();
    builder.record(tail_second.tick, tail_second.event).unwrap();
    let log = builder.build().expect("replay log builds");
    assert_eq!(log.events()[0].tick, LogicalClockTick(BASELINE_TICK + 1));
}

#[test]
fn fixture_snapshot_smoke_payload_passes_reject_unredacted_local_paths_filter() {
    // Defends audit-focus "snapshot referenced by host path": every
    // serialized payload exercised by the smoke must pass the
    // project-wide redaction filter.
    let baseline = baseline_snapshot();
    let observed = observed_snapshot_identical_to_baseline();
    let store = populated_store(&baseline, &observed);
    let check = build_check(&baseline, &observed);

    let baseline_value = serde_json::to_value(&baseline).expect("baseline");
    let observed_value = serde_json::to_value(&observed).expect("observed");
    let check_value = serde_json::to_value(&check).expect("check");

    reject_unredacted_local_paths("baseline", &baseline_value).expect("baseline filter");
    reject_unredacted_local_paths("observed", &observed_value).expect("observed filter");
    reject_unredacted_local_paths("check", &check_value).expect("check filter");

    let outcome = check.run(&store);
    let outcome_value = serde_json::to_value(&outcome).expect("outcome");
    reject_unredacted_local_paths("outcome", &outcome_value).expect("outcome filter");
}

#[test]
fn fixture_snapshot_smoke_does_not_inline_bytes_in_any_field() {
    // The smoke's inline fixture uses only `String`, `Uint`, and
    // (downstream) deterministic id values. The snapshot wire form has a
    // `Bytes` variant the substrate exposes for callers that want it; the
    // smoke never opts in. We walk the serialized JSON and assert no
    // `"bytes"` keyed leaf appears anywhere in the smoke's payload.
    let baseline = baseline_snapshot();
    let value = serde_json::to_value(&baseline).expect("serialize baseline");
    assert!(
        !contains_key(&value, "bytes"),
        "smoke baseline must not embed bytes-shaped state"
    );
    // And no `path`-shaped leaf either (snapshot ids/state paths are
    // tagged with their domain keys, not `path`).
    assert!(
        !contains_key(&value, "path"),
        "smoke baseline must not embed a `path` field"
    );
}

#[test]
fn fixture_snapshot_smoke_schema_version_pin_matches_substrate_constant() {
    // Plan §3 step 1: schema_version pinned to SNAPSHOT_SCHEMA_VERSION.
    let baseline = baseline_snapshot();
    assert_eq!(baseline.schema_version().as_str(), SNAPSHOT_SCHEMA_VERSION);
    assert_eq!(
        SnapshotSchemaVersion::current().as_str(),
        SNAPSHOT_SCHEMA_VERSION
    );
}

fn contains_key(value: &Value, key: &str) -> bool {
    match value {
        Value::Object(map) => {
            if map.contains_key(key) {
                return true;
            }
            map.values().any(|child| contains_key(child, key))
        }
        Value::Array(items) => items.iter().any(|item| contains_key(item, key)),
        _ => false,
    }
}
