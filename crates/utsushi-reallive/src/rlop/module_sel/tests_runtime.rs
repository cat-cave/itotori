use super::*;

#[test]
fn selection_control_signal_keys_on_button_object_setup_ops() {
    // No button-object setup ops in the scene → a plain text-window
    // select.
    assert_eq!(
        selection_control_signal([OPCODE_SELECT_W, OPCODE_SELECT_W]),
        SelectionControlSignal::TextWindow
    );
    // `objbtn_init` (20) present → button-object graphical select.
    assert_eq!(
        selection_control_signal([OPCODE_OBJBTN_INIT, OPCODE_SELECT_W]),
        SelectionControlSignal::ButtonObject
    );
    // `select_objbtn` (4) present → button-object graphical select.
    assert_eq!(
        selection_control_signal([OPCODE_SELECT_OBJBTN, OPCODE_SELECT_W]),
        SelectionControlSignal::ButtonObject
    );
}

#[test]
fn choice_input_scheduler_starts_pending() {
    let scheduler = ChoiceInputScheduler::new();
    assert_eq!(scheduler.pending(), None);
}

#[test]
fn choice_input_scheduler_flips_to_ready_after_record_choice() {
    use crate::rlop::LongOpId;
    let mut scheduler = ChoiceInputScheduler::new();
    let select = ObjectSelectLongOp::try_new(LongOpId(7), vec![7, 2]).expect("bounded");
    let mut head = select.into_longop();
    // No choice yet — pending.
    assert_eq!(
        scheduler.poll(&mut head),
        LongOpReadiness::Pending,
        "pending without recorded choice"
    );
    scheduler.record_choice(ChoiceIndex(1));
    assert_eq!(
        scheduler.poll(&mut head),
        LongOpReadiness::Ready,
        "ready after record_choice"
    );
    let decoded = ObjectSelectLongOp::try_from_longop(&head).expect("decode");
    assert_eq!(
        decoded.outcome(),
        crate::rlop::ObjectSelectOutcome::DisplayIndex(1)
    );
}

#[test]
fn choice_input_scheduler_ignores_non_select_longops() {
    use crate::rlop::{LongOp, LongOpId};
    let mut scheduler = ChoiceInputScheduler::new();
    scheduler.record_choice(ChoiceIndex(0));
    let mut head = LongOp::new(
        LongOpId(1),
        vec![0xFF, 0x00, 0x00], // non-magic prefix
    );
    assert_eq!(scheduler.poll(&mut head), LongOpReadiness::Pending);
}

#[test]
fn selbtn_style_suffix_returns_none_when_no_gameexe() {
    let sink = Arc::new(CollectingSink::new());
    let runtime = SelRuntime::with_sink(sink);
    assert!(runtime.selbtn_style_suffix(0).is_none());
}

#[test]
fn interleaved_int_arg_keeps_emitted_index_aligned_with_choices_vec() {
    // Args: Bytes("A"), Int(7), Bytes("B"). The Int is skipped from the
    // stored `choices` Vec, so the two surviving choices occupy Vec
    // positions 0 and 1. The emitted `choice:<idx>` surfaces must name
    // those contiguous positions (0, 1) — NOT the raw arg indices
    // (0, 2) — so a user pick routed through `SelectLongOp::choose`
    // `set_store` lands on the matching stored entry.
    let sink = Arc::new(CollectingSink::new());
    let runtime = Arc::new(SelRuntime::with_sink(
        Arc::clone(&sink) as Arc<dyn TextSurfaceSink>
    ));
    let op = SelectOp::new(Arc::clone(&runtime));

    let outcome = op.dispatch(
        &mut Vm::new(1, 0),
        &[
            ExprValue::Bytes(b"A".to_vec()),
            ExprValue::Int(7),
            ExprValue::Bytes(b"B".to_vec()),
        ],
    );

    // Emitted surfaces name the contiguous choices-Vec positions.
    let lines = sink.lines.lock().expect("lock");
    let surfaces: Vec<Option<&str>> = lines
        .iter()
        .map(|line| line.text_surface.as_deref())
        .collect();
    assert_eq!(
        surfaces,
        vec![Some("choice:0"), Some("choice:1")],
        "emitted indices must be contiguous choices-Vec positions, not raw arg indices"
    );
    let texts: Vec<&str> = lines.iter().map(|line| line.text.as_str()).collect();
    assert_eq!(texts, vec!["A", "B"]);
    let line_ids: Vec<String> = lines.iter().map(|line| line.line_id.clone()).collect();
    drop(lines);

    // The yielded SelectLongOp stores exactly the two Bytes choices, so
    // index 1 (the emitted "choice:1") decodes back to "B".
    let DispatchOutcome::Yield {
        longop_id,
        private_state,
    } = outcome
    else {
        panic!("select must yield a longop");
    };
    let head = LongOp {
        id: longop_id,
        private_state,
    };
    let select = SelectLongOp::try_from_longop(&head).expect("decode select payload");
    assert_eq!(select.choices(), &[b"A".to_vec(), b"B".to_vec()]);
    assert_eq!(
        runtime.take_prompts(),
        vec![SelectionPrompt {
            longop_id,
            byte_offset_in_scene: 0,
            kind: SelectionPromptKind::Text,
            cancelable: false,
            option_line_ids: line_ids,
        }]
    );

    // The skipped Int is reported against its raw arg position (1).
    let warnings = runtime.take_warnings();
    assert_eq!(
        warnings,
        vec![SelRuntimeWarning::ArgShapeMismatch {
            variant: SelectVariant::Select,
            choice_index: 1,
            expected: "bytes",
        }]
    );
}

#[test]
fn text_prompt_is_omitted_when_any_stored_choice_line_is_rejected() {
    let sink = Arc::new(CollectingSink::rejecting_after(1));
    let runtime = Arc::new(SelRuntime::with_sink(
        Arc::clone(&sink) as Arc<dyn TextSurfaceSink>
    ));

    assert!(matches!(
        SelectOp::new(Arc::clone(&runtime)).dispatch(
            &mut Vm::new(1, 0),
            &[
                ExprValue::Bytes(b"first".to_vec()),
                ExprValue::Bytes(b"second".to_vec())
            ],
        ),
        DispatchOutcome::Yield { .. }
    ));
    assert!(runtime.take_prompts().is_empty());
    assert_eq!(
        runtime.take_warnings(),
        vec![SelRuntimeWarning::SinkRejected {
            variant: SelectVariant::Select,
            reason: "utsushi.sink.unsupported_kind: sink=text_surface adapter=reject-second-choice reason=test sink rejects one choice".to_string(),
        }]
    );
}

#[test]
fn varbanks_store_pin() {
    // Compile-level guard that `VarBanks::set_store` exists with
    // a u32 signature — the VM resume path depends on it.
    let mut banks = VarBanks::new();
    banks.set_store(0xABCD);
    assert_eq!(banks.store(), 0xABCD);
}
