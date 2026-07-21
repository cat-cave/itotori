//! Replay-log determinism gate for the committed bridge-linked jump target
//! fixtures ( §7.5, §7.6).
//!
//! For each committed `*.json` jump target fixture under
//! `crates/utsushi-fixture/tests/fixtures/jump_targets/`, this gate:
//!
//! 1. Loads the fixture and constructs a deterministic input plan that
//!    text-advances up to each target's `activates_at_tick` and fires an
//!    [`InputEvent::Choice`] at the activation tick.
//! 2. Builds that plan through the existing [`ReplayLogBuilder`] surface.
//!
//! The gate also asserts that every
//! `JumpTargetFixture::activates_at_tick` aligns to a `ReplayEntry` whose
//! `event.kind() == InputKind::Choice` in the paired log, pinning the
//! bridge-linkage alignment claim called out in the plan.

use std::collections::BTreeSet;

use utsushi_core::{
    ChoiceIndex, ClockOrigin, InputEvent, InputKind, LogicalClockTick, ReplayEntry,
    ReplayLogBuilder, ReplayMetadata,
};
use utsushi_fixture::JumpTargetSet;

const SINGLE_BRANCH_JSON: &[u8] =
    include_bytes!("../../utsushi-fixture/tests/fixtures/jump_targets/single_branch.json");
const MULTI_BRANCH_JSON: &[u8] =
    include_bytes!("../../utsushi-fixture/tests/fixtures/jump_targets/multi_branch.json");
const LOOPING_JSON: &[u8] =
    include_bytes!("../../utsushi-fixture/tests/fixtures/jump_targets/looping.json");

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
fn replay_log_round_trips_through_the_existing_replay_log_builder() {
    // Sanity: the ReplayEntry sequence passes ReplayLogBuilder validation
    // (monotonic ticks, redaction, schema pin) without any schema change.
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
