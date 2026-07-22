use super::*;

#[test]
fn pause_round_trips_through_longop_carrier() {
    let longop = PauseLongOp::new(LongOpId(0x42)).into_longop();
    assert_eq!(longop.id, LongOpId(0x42));
    assert_eq!(longop.private_state, vec![PAUSE_PRIVATE_STATE_MAGIC, 0x00]);
    let decoded = PauseLongOp::try_from_longop(&longop).expect("decode");
    assert_eq!(decoded.id(), LongOpId(0x42));
    assert!(!decoded.dismissed());
}

#[test]
fn pause_dismissed_flag_round_trips() {
    let mut pause = PauseLongOp::new(LongOpId(1));
    pause.mark_dismissed();
    let longop = pause.into_longop();
    assert_eq!(longop.private_state[1], 0x01);
    let decoded = PauseLongOp::try_from_longop(&longop).expect("decode");
    assert!(decoded.dismissed());
}

#[test]
fn pause_decode_rejects_wrong_length() {
    let longop = LongOp::new(LongOpId(1), vec![PAUSE_PRIVATE_STATE_MAGIC]);
    let err = PauseLongOp::try_from_longop(&longop).expect_err("must reject short");
    assert!(matches!(
        err,
        PauseLongOpDecodeError::UnexpectedPayloadLength {
            observed: 1,
            expected: 2,
        }
    ));
}

#[test]
fn pause_decode_rejects_wrong_magic() {
    let longop = LongOp::new(LongOpId(1), vec![0x00, 0x00]);
    let err = PauseLongOp::try_from_longop(&longop).expect_err("must reject magic");
    assert!(matches!(
        err,
        PauseLongOpDecodeError::MagicMismatch {
            observed: 0x00,
            expected: PAUSE_PRIVATE_STATE_MAGIC,
        }
    ));
}

#[test]
fn pause_decode_rejects_invalid_dismissed_flag() {
    let longop = LongOp::new(LongOpId(1), vec![PAUSE_PRIVATE_STATE_MAGIC, 0x99]);
    let err = PauseLongOp::try_from_longop(&longop).expect_err("must reject flag");
    assert!(matches!(
        err,
        PauseLongOpDecodeError::DismissedFlagOutOfRange { observed: 0x99 }
    ));
}

#[test]
fn select_encodes_payload_with_magic_and_lengths() {
    let choices = vec![b"yes".to_vec(), b"no".to_vec()];
    let longop = SelectLongOp::new(LongOpId(7), choices).into_longop();
    assert_eq!(longop.id, LongOpId(7));
    let state = &longop.private_state;
    assert_eq!(state[0], SELECT_PRIVATE_STATE_MAGIC);
    // chosen sentinel = 0xFFFF
    assert_eq!(state[1], 0xFF);
    assert_eq!(state[2], 0xFF);
    // count = 2
    assert_eq!(state[3], 0x02);
    assert_eq!(state[4], 0x00);
    // first choice: len=3 then "yes"
    assert_eq!(state[5], 0x03);
    assert_eq!(state[6], 0x00);
    assert_eq!(&state[7..10], b"yes");
    // second choice: len=2 then "no"
    assert_eq!(state[10], 0x02);
    assert_eq!(state[11], 0x00);
    assert_eq!(&state[12..14], b"no");
}

#[test]
fn select_choose_records_index() {
    let mut select = SelectLongOp::new(LongOpId(1), vec![b"a".to_vec(), b"b".to_vec()]);
    assert_eq!(select.chosen(), None);
    select.choose(1);
    assert_eq!(select.chosen(), Some(1));
    let longop = select.into_longop();
    // chosen index 1 == 0x0001 LE
    assert_eq!(longop.private_state[1], 0x01);
    assert_eq!(longop.private_state[2], 0x00);
}

#[test]
fn object_select_wire_is_bounded_and_round_trips() {
    assert!(matches!(
        ObjectSelectLongOp::try_new(LongOpId(5), vec![0; u16::MAX as usize + 1]),
        Err(ObjectSelectLongOpBuildError::TooManyReturnValues { .. })
    ));
    let mut select = ObjectSelectLongOp::try_new(LongOpId(6), vec![7, -2]).expect("bounded");
    select.set_cancelable(true);
    select.select(1);
    let longop = select.into_longop();
    assert_eq!(
        longop.private_state[..8],
        [OBJECT_SELECT_PRIVATE_STATE_MAGIC, 2, 1, 1, 1, 0, 2, 0]
    );
    let decoded = ObjectSelectLongOp::try_from_longop(&longop).expect("decode");
    assert_eq!(decoded.return_values(), &[7, -2]);
    assert!(decoded.is_cancelable());
    assert_eq!(decoded.outcome(), ObjectSelectOutcome::DisplayIndex(1));
    let mut cancelled = decoded;
    cancelled.cancel();
    assert_eq!(
        ObjectSelectLongOp::try_from_longop(&cancelled.into_longop())
            .expect("decode")
            .outcome(),
        ObjectSelectOutcome::Cancelled
    );
    let v1 = LongOp::new(
        LongOpId(7),
        vec![0xA3, 1, 1, 0, 2, 0, 7, 0, 0, 0, 2, 0, 0, 0],
    );
    let v1 = ObjectSelectLongOp::try_from_longop(&v1).expect("v1 decode");
    assert_eq!(v1.flags(), 0);
    assert_eq!(v1.outcome(), ObjectSelectOutcome::DisplayIndex(1));

    let decode = |state| ObjectSelectLongOp::try_from_longop(&LongOp::new(LongOpId(8), state));
    assert!(matches!(
        decode(vec![0xA3, 2, 0, 0, 1, 0, 0, 0]),
        Err(ObjectSelectLongOpDecodeError::ReservedOutcomeIndex { tag: 0, index: 1 })
    ));
    assert!(matches!(
        decode(vec![0xA3, 2, 1, 2, 1, 0, 0, 0]),
        Err(ObjectSelectLongOpDecodeError::ReservedOutcomeIndex { tag: 2, index: 1 })
    ));
    assert!(matches!(
        decode(vec![0xA3, 2, 0, 2, 0, 0, 0, 0]),
        Err(ObjectSelectLongOpDecodeError::CancelledWithoutCancelableFlag)
    ));
    assert!(matches!(
        decode(vec![0xA3, 2, 2, 0, 0, 0, 0, 0]),
        Err(ObjectSelectLongOpDecodeError::UnknownFlags { observed: 2 })
    ));
    assert!(matches!(
        decode(vec![0xA3, 2, 0, 3, 0, 0, 0, 0]),
        Err(ObjectSelectLongOpDecodeError::UnknownOutcomeTag { observed: 3 })
    ));
    assert!(matches!(
        decode(vec![0xA3, 3]),
        Err(ObjectSelectLongOpDecodeError::UnsupportedVersion { observed: 3 })
    ));
}

#[test]
fn selection_choice_count_scheduler_observes_pending_then_ready() {
    let mut scheduler = SelectionChoiceCountScheduler::new(2);
    let mut op = LongOp::new(LongOpId(1), vec![]);
    assert_eq!(scheduler.poll(&mut op), LongOpReadiness::Pending);
    assert_eq!(scheduler.poll(&mut op), LongOpReadiness::Pending);
    assert_eq!(scheduler.poll(&mut op), LongOpReadiness::Ready);
}

#[test]
fn headless_scheduler_auto_dismisses_pause() {
    let mut sched = HeadlessInputScheduler::default();
    let mut head = PauseLongOp::new(LongOpId(1)).into_longop();
    assert_eq!(sched.poll(&mut head), LongOpReadiness::Ready);
    // The pause is now dismissed in the head's private state.
    assert!(
        PauseLongOp::try_from_longop(&head)
            .expect("decode")
            .dismissed()
    );
    assert_eq!(sched.pauses_advanced(), 1);
    assert_eq!(sched.choices_made(), 0);
}

#[test]
fn headless_scheduler_always_first_picks_index_zero() {
    let mut sched = HeadlessInputScheduler::new(HeadlessChoicePolicy::AlwaysFirst);
    let mut head = SelectLongOp::new(
        LongOpId(2),
        vec![b"a".to_vec(), b"b".to_vec(), b"c".to_vec()],
    )
    .into_longop();
    assert_eq!(sched.poll(&mut head), LongOpReadiness::Ready);
    assert_eq!(
        SelectLongOp::try_from_longop(&head)
            .expect("decode")
            .chosen(),
        Some(0)
    );
    assert_eq!(sched.choices_made(), 1);
}

#[test]
fn headless_scheduler_fixed_clamps_to_last_option() {
    let mut sched = HeadlessInputScheduler::new(HeadlessChoicePolicy::Fixed(9));
    let mut head = SelectLongOp::new(LongOpId(3), vec![b"a".to_vec(), b"b".to_vec()]).into_longop();
    assert_eq!(sched.poll(&mut head), LongOpReadiness::Ready);
    // Clamped to the last option (index 1) rather than out-of-range 9.
    assert_eq!(
        SelectLongOp::try_from_longop(&head)
            .expect("decode")
            .chosen(),
        Some(1)
    );
}

#[test]
fn headless_scheduler_scripted_consumes_in_order_then_falls_back() {
    let mut sched = HeadlessInputScheduler::new(HeadlessChoicePolicy::Scripted(vec![2, 1]));
    let choices = vec![b"a".to_vec(), b"b".to_vec(), b"c".to_vec()];
    // First prompt → 2, second → 1, third (exhausted) → 0.
    for expected in [2u16, 1, 0] {
        let mut head = SelectLongOp::new(LongOpId(4), choices.clone()).into_longop();
        assert_eq!(sched.poll(&mut head), LongOpReadiness::Ready);
        assert_eq!(
            SelectLongOp::try_from_longop(&head)
                .expect("decode")
                .chosen(),
            Some(expected)
        );
    }
    assert_eq!(sched.choices_made(), 3);
}

#[test]
fn headless_scheduler_resumes_unknown_longop_shape() {
    let mut sched = HeadlessInputScheduler::default();
    let mut head = LongOp::new(LongOpId(5), vec![0xEE, 0x00]);
    assert_eq!(sched.poll(&mut head), LongOpReadiness::Ready);
    assert_eq!(sched.other_advanced(), 1);
}

#[test]
fn headless_scheduler_is_deterministic_across_identical_drives() {
    let run = || {
        let mut sched = HeadlessInputScheduler::new(HeadlessChoicePolicy::Fixed(1));
        let mut picks = Vec::new();
        for _ in 0..3 {
            let mut head = ObjectSelectLongOp::try_new(LongOpId(6), vec![7, 2])
                .expect("bounded")
                .into_longop();
            sched.poll(&mut head);
            picks.push(
                ObjectSelectLongOp::try_from_longop(&head)
                    .expect("decode")
                    .outcome(),
            );
        }
        picks
    };
    assert_eq!(run(), vec![ObjectSelectOutcome::DisplayIndex(1); 3]);
    assert_eq!(run(), run());
}
