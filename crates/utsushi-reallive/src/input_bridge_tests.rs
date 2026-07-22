use super::*;
use crate::rlop::{LongOp, LongOpId};
use utsushi_core::input::{MenuTarget, PointerButton};

fn pause_head() -> LongOp {
    PauseLongOp::new(LongOpId(1)).into_longop()
}

fn select_head(options: usize) -> LongOp {
    let choices: Vec<Vec<u8>> = (0..options)
        .map(|i| format!("opt{i}").into_bytes())
        .collect();
    SelectLongOp::new(LongOpId(2), choices).into_longop()
}

fn chosen_index(head: &LongOp) -> Option<u16> {
    SelectLongOp::try_from_longop(head)
        .ok()
        .and_then(|s| s.chosen())
}

fn object_head(cancelable: bool) -> LongOp {
    let mut select = ObjectSelectLongOp::try_new(LongOpId(3), vec![7, 2]).expect("bounded");
    select.set_cancelable(cancelable);
    select.into_longop()
}

#[test]
fn classify_reads_yield_shape_from_magic() {
    assert_eq!(PendingYield::classify(&pause_head()), PendingYield::Pause);
    assert_eq!(
        PendingYield::classify(&select_head(3)),
        PendingYield::Select { choice_count: 3 }
    );
    assert_eq!(
        PendingYield::classify(&LongOp::new(LongOpId(9), vec![0xEE, 0x00])),
        PendingYield::Other
    );
}

#[test]
fn headless_source_advances_pause_and_resolves_choice() {
    let mut sched = BridgeScheduler::headless(HeadlessChoicePolicy::Fixed(1));
    let mut pause = pause_head();
    assert_eq!(sched.poll(&mut pause), LongOpReadiness::Ready);
    assert!(PauseLongOp::try_from_longop(&pause).unwrap().dismissed());

    let mut select = ObjectSelectLongOp::try_new(LongOpId(2), vec![7, 2, 9])
        .expect("bounded")
        .into_longop();
    assert_eq!(sched.poll(&mut select), LongOpReadiness::Ready);
    assert_eq!(
        ObjectSelectLongOp::try_from_longop(&select)
            .expect("object select")
            .outcome(),
        crate::rlop::ObjectSelectOutcome::DisplayIndex(1)
    );
    assert_eq!(sched.pauses_advanced(), 1);
    assert_eq!(sched.choices_made(), 1);
}

#[test]
fn user_source_suspends_until_input_then_commits() {
    let queue = UserInputQueue::new();
    let mut sched = BridgeScheduler::user(queue.clone());
    let mut select = select_head(2);
    // No input yet → suspend.
    assert_eq!(sched.poll(&mut select), LongOpReadiness::Pending);
    assert_eq!(chosen_index(&select), None);
    // User picks option 1 → commit.
    queue.push_choice(1);
    assert_eq!(sched.poll(&mut select), LongOpReadiness::Ready);
    assert_eq!(chosen_index(&select), Some(1));
}

#[test]
fn pointer_and_menu_navigate_then_advance_commits_highlight() {
    let queue = UserInputQueue::new();
    let mut sched = BridgeScheduler::user(queue.clone());
    let mut select = select_head(4);
    // Hover (pointer nav), then move highlight to option 2 via menu, then
    // click-to-advance commits the highlighted option.
    queue.push(InputEvent::Pointer {
        x: 0.5,
        y: 0.5,
        button: PointerButton::Primary,
    });
    queue.push(InputEvent::MenuSelect {
        target: MenuTarget::new("choice", "2"),
    });
    queue.push(InputEvent::advance());
    assert_eq!(sched.poll(&mut select), LongOpReadiness::Ready);
    assert_eq!(chosen_index(&select), Some(2));
    assert_eq!(sched.nav_events(), 2);
    // All three gestures were captured for replay.
    assert_eq!(sched.captured_events().len(), 3);
}

#[test]
fn capture_ticks_are_strictly_monotonic() {
    let mut sched = BridgeScheduler::headless(HeadlessChoicePolicy::AlwaysFirst);
    let mut p = pause_head();
    sched.poll(&mut p);
    let mut s = select_head(2);
    sched.poll(&mut s);
    let ticks: Vec<u64> = sched.captured_events().iter().map(|(t, _)| t.0).collect();
    assert_eq!(ticks, vec![1, 2]);
    let log = sched.build_log("unit-test").expect("log builds");
    assert_eq!(log.events().len(), 2);
}

#[test]
fn replay_source_reproduces_headless_decisions() {
    // Capture a headless run's decisions, then replay them.
    let mut capture = BridgeScheduler::headless(HeadlessChoicePolicy::Fixed(1));
    let mut s0 = select_head(3);
    capture.poll(&mut s0);
    let log = capture.build_log("run").expect("build");

    let mut replay = BridgeScheduler::replay(&log);
    let mut s1 = select_head(3);
    assert_eq!(replay.poll(&mut s1), LongOpReadiness::Ready);
    assert_eq!(chosen_index(&s1), chosen_index(&s0));
    // Replaying past the log's end suspends (no more input).
    let mut s2 = select_head(3);
    assert_eq!(replay.poll(&mut s2), LongOpReadiness::Pending);
}

#[test]
fn raw_secondary_release_cancels_only_cancelable_object_selects() {
    let queue = UserInputQueue::new();
    let mut scheduler = BridgeScheduler::user(queue.clone());
    let mut cancelable = object_head(true);
    queue.push(InputEvent::raw(
        REALLIVE_RAW_INPUT_ENGINE,
        REALLIVE_RAW_SECONDARY_RELEASE,
    ));
    assert_eq!(scheduler.poll(&mut cancelable), LongOpReadiness::Ready);
    assert_eq!(
        ObjectSelectLongOp::try_from_longop(&cancelable)
            .expect("object")
            .outcome(),
        crate::rlop::ObjectSelectOutcome::Cancelled
    );

    let queue = UserInputQueue::new();
    let mut scheduler = BridgeScheduler::user(queue.clone());
    for mut head in [object_head(false), select_head(2)] {
        queue.push(InputEvent::raw(
            REALLIVE_RAW_INPUT_ENGINE,
            REALLIVE_RAW_SECONDARY_RELEASE,
        ));
        assert_eq!(scheduler.poll(&mut head), LongOpReadiness::Pending);
    }
}

#[test]
fn raw_cancel_replay_is_deterministic_and_other_gestures_do_not_cancel() {
    let queue = UserInputQueue::new();
    let mut capture = BridgeScheduler::user(queue.clone());
    let mut source = object_head(true);
    queue.push(InputEvent::raw(
        REALLIVE_RAW_INPUT_ENGINE,
        REALLIVE_RAW_SECONDARY_RELEASE,
    ));
    assert_eq!(capture.poll(&mut source), LongOpReadiness::Ready);
    let log = capture.build_log("raw-cancel").expect("log");
    let mut replay = BridgeScheduler::replay(&log);
    let mut replayed = object_head(true);
    assert_eq!(replay.poll(&mut replayed), LongOpReadiness::Ready);
    assert_eq!(replayed.private_state, source.private_state);

    let queue = UserInputQueue::new();
    let mut scheduler = BridgeScheduler::user(queue.clone());
    let mut pointer = object_head(true);
    queue.push(InputEvent::Pointer {
        x: 0.5,
        y: 0.5,
        button: PointerButton::Secondary,
    });
    queue.push(InputEvent::raw(
        REALLIVE_RAW_INPUT_ENGINE,
        "key.escape.release",
    ));
    queue.push(InputEvent::raw(
        "other-engine",
        REALLIVE_RAW_SECONDARY_RELEASE,
    ));
    assert_eq!(scheduler.poll(&mut pointer), LongOpReadiness::Pending);
    let mut advance = object_head(true);
    queue.push(InputEvent::advance());
    assert_eq!(scheduler.poll(&mut advance), LongOpReadiness::Ready);
    assert_eq!(
        ObjectSelectLongOp::try_from_longop(&advance)
            .expect("object")
            .outcome(),
        crate::rlop::ObjectSelectOutcome::DisplayIndex(0)
    );
    let mut text = object_head(true);
    queue.push(InputEvent::text());
    assert_eq!(scheduler.poll(&mut text), LongOpReadiness::Ready);
    assert_eq!(
        ObjectSelectLongOp::try_from_longop(&text)
            .expect("object")
            .outcome(),
        crate::rlop::ObjectSelectOutcome::DisplayIndex(0)
    );
}
