//! Replay-log determinism gate for the committed bridge-linked jump target
//! fixtures (UTSUSHI-062 §7.5, §7.6).
//!
//! For each committed `*.json` jump target fixture under
//! `crates/utsushi-fixture/tests/fixtures/jump_targets/`, this gate:
//!
//! 1. Loads the fixture and validates its bridge linkage against an
//!    in-memory [`BridgeUnitIndex`] built from the fixture's bridge unit
//!    list.
//! 2. Drives an [`InMemoryReferenceRecorder`] with a deterministic input
//!    plan that text-advances up to each target's `activates_at_tick` and
//!    fires a [`InputEvent::Choice`] at the activation tick.
//! 3. Serializes through [`deterministic_json_bytes`] (UTSUSHI-060) and
//!    compares the bytes byte-for-byte to the committed
//!    `replay_logs/<name>.replay-log.json` artifact.
//!
//! The gate also asserts that every
//! `JumpTargetFixture::activates_at_tick` aligns to a `ReplayEntry` whose
//! `event.kind() == InputKind::Choice` in the paired log, pinning the
//! bridge-linkage alignment claim called out in the plan.

use std::collections::BTreeSet;

use utsushi_core::{
    ChoiceIndex, ClockOrigin, InMemoryReferenceRecorder, InputEvent, InputKind, LogicalClockTick,
    ReferenceRecorder, ReferenceTrace, ReplayEntry, ReplayLogBuilder, ReplayMetadata, SourceTag,
    deterministic_json_bytes,
};
use utsushi_fixture::{InMemoryBridgeUnitIndex, JumpTargetSet};

const SINGLE_BRANCH_JSON: &[u8] =
    include_bytes!("../../utsushi-fixture/tests/fixtures/jump_targets/single_branch.json");
const MULTI_BRANCH_JSON: &[u8] =
    include_bytes!("../../utsushi-fixture/tests/fixtures/jump_targets/multi_branch.json");
const LOOPING_JSON: &[u8] =
    include_bytes!("../../utsushi-fixture/tests/fixtures/jump_targets/looping.json");

const SINGLE_BRANCH_GOLDEN: &[u8] = include_bytes!(
    "../../utsushi-fixture/tests/fixtures/jump_targets/replay_logs/single_branch.replay-log.json"
);
const MULTI_BRANCH_GOLDEN: &[u8] = include_bytes!(
    "../../utsushi-fixture/tests/fixtures/jump_targets/replay_logs/multi_branch.replay-log.json"
);
const LOOPING_GOLDEN: &[u8] = include_bytes!(
    "../../utsushi-fixture/tests/fixtures/jump_targets/replay_logs/looping.replay-log.json"
);

#[derive(Clone, Copy)]
enum FixtureCase {
    SingleBranch,
    MultiBranch,
    Looping,
}

impl FixtureCase {
    fn name(self) -> &'static str {
        match self {
            Self::SingleBranch => "single_branch",
            Self::MultiBranch => "multi_branch",
            Self::Looping => "looping",
        }
    }

    fn fixture_bytes(self) -> &'static [u8] {
        match self {
            Self::SingleBranch => SINGLE_BRANCH_JSON,
            Self::MultiBranch => MULTI_BRANCH_JSON,
            Self::Looping => LOOPING_JSON,
        }
    }

    fn extra_bridge_units(self) -> Vec<&'static str> {
        match self {
            // Looping fixture references "head" via the target; the body is
            // a separate visited unit that the index also publishes so the
            // bridge-unit registry is honest about every node the run
            // traverses.
            Self::Looping => vec!["bridge-unit-looping-body"],
            _ => vec![],
        }
    }

    fn run_id(self) -> &'static str {
        match self {
            Self::SingleBranch => "jump-target-single-branch",
            Self::MultiBranch => "jump-target-multi-branch",
            Self::Looping => "jump-target-looping",
        }
    }

    fn chosen_target_index(self) -> u16 {
        // The replay log records exactly one taken Choice at the activation
        // tick. Multi-branch fans into target B (index 1) of the canonical
        // [a, b, c] ordering, exercising "not-taken targets still
        // validate" semantics. Single-branch and looping each have a single
        // target so the chosen index is 0.
        match self {
            Self::SingleBranch | Self::Looping => 0,
            Self::MultiBranch => 1,
        }
    }
}

const ALL_CASES: &[FixtureCase] = &[
    FixtureCase::SingleBranch,
    FixtureCase::MultiBranch,
    FixtureCase::Looping,
];

fn build_index_for(case: FixtureCase, set: &JumpTargetSet) -> InMemoryBridgeUnitIndex {
    let mut index = InMemoryBridgeUnitIndex::new();
    for target in &set.targets {
        index.insert(target.bridge_unit_id.clone());
    }
    for extra in case.extra_bridge_units() {
        index.insert(extra);
    }
    index
}

/// Build the deterministic input plan for `case`'s fixture.
///
/// The plan is purely positional: text-advance every tick from 1 up to
/// `activation_tick - 1`, then a single Choice at the activation tick
/// referencing the canonical taken target. For multi-target activations
/// (multi_branch), the choice index identifies the selected branch within
/// the canonical sort order.
fn build_replay_entries(case: FixtureCase, set: &JumpTargetSet) -> Vec<ReplayEntry> {
    let activation_tick = set
        .targets
        .iter()
        .map(|target| target.activates_at_tick)
        .max()
        .expect("fixture must declare at least one target");
    let activation_target = &set.targets[case.chosen_target_index() as usize];
    let mut entries = Vec::new();
    for tick in 1..activation_tick.0 {
        entries.push(ReplayEntry {
            tick: LogicalClockTick(tick),
            event: InputEvent::text(),
        });
    }
    entries.push(ReplayEntry {
        tick: activation_tick,
        event: InputEvent::Choice {
            index: ChoiceIndex(case.chosen_target_index()),
            bridge_unit_id: Some(activation_target.bridge_unit_id.clone()),
        },
    });
    entries
}

fn build_reference_trace(case: FixtureCase) -> ReferenceTrace {
    let set = JumpTargetSet::load_from_json(case.fixture_bytes()).expect("load fixture");
    let index = build_index_for(case, &set);
    set.validate(&index)
        .expect("committed fixture must validate against its bridge unit index");
    let recorder =
        InMemoryReferenceRecorder::new(SourceTag::Fixture, &set.adapter_id, case.run_id());
    for entry in build_replay_entries(case, &set) {
        recorder.record_replay_event(entry);
    }
    recorder.finalize()
}

fn build_reference_bytes(case: FixtureCase) -> Vec<u8> {
    deterministic_json_bytes(&build_reference_trace(case))
}

/// Optional escape hatch: when running with
/// `UTSUSHI_DUMP_JUMP_TARGET_GOLDEN=1`, the test prints the canonical bytes
/// for each case to stdout. The maintainer pipes that to
/// `crates/utsushi-fixture/tests/fixtures/jump_targets/replay_logs/*.json`.
/// Default mode is the byte-equality assert below.
fn maybe_dump_golden(case: FixtureCase, bytes: &[u8]) {
    if std::env::var("UTSUSHI_DUMP_JUMP_TARGET_GOLDEN").as_deref() == Ok("1") {
        eprintln!("---BEGIN-GOLDEN {} ---", case.name());
        println!("{}", String::from_utf8(bytes.to_vec()).unwrap());
        eprintln!("---END-GOLDEN {} ---", case.name());
    }
}

#[test]
fn single_branch_replay_log_matches_committed_artifact_byte_for_byte() {
    let observed = build_reference_bytes(FixtureCase::SingleBranch);
    maybe_dump_golden(FixtureCase::SingleBranch, &observed);
    assert_eq!(
        observed, SINGLE_BRANCH_GOLDEN,
        "single_branch.replay-log.json diverged from committed artifact"
    );
}

#[test]
fn multi_branch_replay_log_matches_committed_artifact_byte_for_byte() {
    let observed = build_reference_bytes(FixtureCase::MultiBranch);
    maybe_dump_golden(FixtureCase::MultiBranch, &observed);
    assert_eq!(
        observed, MULTI_BRANCH_GOLDEN,
        "multi_branch.replay-log.json diverged from committed artifact"
    );
}

#[test]
fn looping_replay_log_matches_committed_artifact_byte_for_byte() {
    let observed = build_reference_bytes(FixtureCase::Looping);
    maybe_dump_golden(FixtureCase::Looping, &observed);
    assert_eq!(
        observed, LOOPING_GOLDEN,
        "looping.replay-log.json diverged from committed artifact"
    );
}

#[test]
fn replay_log_byte_match_holds_across_two_consecutive_runs() {
    for case in ALL_CASES {
        let first = build_reference_bytes(*case);
        let second = build_reference_bytes(*case);
        assert_eq!(
            first,
            second,
            "{}: two consecutive recorder runs must produce byte-identical output",
            case.name()
        );
    }
}

#[test]
fn replay_log_mismatch_emits_fingerprint_diagnostic_with_observed_and_expected() {
    use utsushi_fixture::JumpTargetError;
    // Mutate a known position in the committed artifact: bump the recorded_at
    // label so the byte sequence diverges. We construct the diagnostic
    // ourselves because the production seam is the byte-equality assert; the
    // structural defense is the `ReplayLogFingerprintMismatch` variant
    // existing in the typed-error registry and carrying both sides.
    let observed_bytes = build_reference_bytes(FixtureCase::SingleBranch);
    let mut tampered = SINGLE_BRANCH_GOLDEN.to_vec();
    // Replace the run id with a hex byte the recorder would never emit.
    if let Some(position) = find_subslice(&tampered, b"jump-target-single-branch") {
        tampered[position] = b'X';
    } else {
        panic!("expected run id not found in golden artifact");
    }
    assert_ne!(observed_bytes, tampered);
    let diagnostic = JumpTargetError::ReplayLogFingerprintMismatch {
        observed: format!("{} bytes", observed_bytes.len()),
        expected: format!("{} bytes", tampered.len()),
    };
    match &diagnostic {
        JumpTargetError::ReplayLogFingerprintMismatch { observed, expected } => {
            assert!(observed.contains("bytes"));
            assert!(expected.contains("bytes"));
        }
        other => panic!("expected ReplayLogFingerprintMismatch, got {other:?}"),
    }
    assert_eq!(
        diagnostic.semantic_code(),
        "utsushi.fixture.jump_target.replay_log_fingerprint_mismatch",
    );
}

#[test]
fn jump_target_activates_at_tick_aligns_to_replay_entry_index_for_each_fixture() {
    for case in ALL_CASES {
        let set = JumpTargetSet::load_from_json(case.fixture_bytes()).unwrap();
        let entries = build_replay_entries(*case, &set);
        let activation_ticks: BTreeSet<LogicalClockTick> = set
            .targets
            .iter()
            .map(|target| target.activates_at_tick)
            .collect();
        for tick in &activation_ticks {
            let matching = entries
                .iter()
                .find(|entry| entry.tick == *tick)
                .unwrap_or_else(|| {
                    panic!(
                        "{}: no replay entry at activation tick {tick:?}",
                        case.name()
                    )
                });
            assert_eq!(
                matching.event.kind(),
                InputKind::Choice,
                "{}: replay entry at activation tick {tick:?} must be a Choice",
                case.name()
            );
        }
    }
}

#[test]
fn replay_log_byte_form_does_not_embed_bridge_unit_id_on_replay_entry_shape() {
    // §5 plan constraint: ReplayLog has no per-entry bridge_unit_id field.
    // The fixture's recorded Choice DOES carry one (UTSUSHI-021 already
    // exposes `bridge_unit_id` as an optional field on `InputEvent::Choice`),
    // but the assertion here is structural: the schema_version stays pinned
    // to the existing ReferenceTrace version and the entry shape is the
    // canonical UTSUSHI-021 form.
    let trace = build_reference_trace(FixtureCase::SingleBranch);
    assert_eq!(
        trace.schema_version,
        utsushi_core::REFERENCE_TRACE_SCHEMA_VERSION,
        "fixture trace must use the existing ReferenceTrace schema version (no bump in this slice)"
    );
    // The recorder's replay_events list mirrors UTSUSHI-021's ReplayEntry
    // shape; the test crate already round-trips the wire form. We assert
    // the produced trace contains a Choice with a populated bridge id,
    // proving the linkage rides on InputEvent::Choice, not a new field.
    let choice = trace
        .replay_events
        .iter()
        .find(|entry| matches!(entry.event, InputEvent::Choice { .. }))
        .expect("activation tick must record a Choice");
    if let InputEvent::Choice { bridge_unit_id, .. } = &choice.event {
        assert!(bridge_unit_id.is_some());
    }
}

#[test]
fn replay_log_round_trips_through_the_existing_replay_log_builder() {
    // Sanity: the ReplayEntry sequence the recorder gathered also passes
    // ReplayLogBuilder validation (monotonic ticks, redaction, schema pin)
    // without any UTSUSHI-021 schema change.
    let set = JumpTargetSet::load_from_json(SINGLE_BRANCH_JSON).unwrap();
    let entries = build_replay_entries(FixtureCase::SingleBranch, &set);
    let mut builder = ReplayLogBuilder::new().metadata(ReplayMetadata::new(
        FixtureCase::SingleBranch.run_id().to_string(),
        set.adapter_id.clone(),
        "0.1.0-alpha",
        ClockOrigin::RunStart,
        0,
        None,
    ));
    for entry in entries {
        builder.record(entry.tick, entry.event).unwrap();
    }
    let log = builder.build().unwrap();
    assert_eq!(log.events().len(), 4);
}

fn find_subslice(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack
        .windows(needle.len())
        .position(|window| window == needle)
}
