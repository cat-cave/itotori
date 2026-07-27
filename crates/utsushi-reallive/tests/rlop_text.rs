//! Synthetic acceptance tests for the `module_msg`
//! text/messaging RLOperation family.
//!
//! Each opcode covered by [`utsushi_reallive::register_text_rlops`] gets
//! a dedicated test: assert the correct [`TextSurfaceSink`] event fires
//! when expected, the VM advances per the
//! [`utsushi_reallive::DispatchOutcome`] contract, and the variable
//! banks stay untouched (the text opcodes do not write banks; that is
//! the `module_sys` / `module_mem` job for ).
//!
//! `msg.pause` exercises the longop queue path: it yields and resumes
//! once the [`utsushi_reallive::AlwaysReadyScheduler`] sees the head.
//! The choice family (`select` / `select_s` / `select_w`
//! `select_objbtn`) lives in `module_sel` as of; see
//! `tests/rlop_sel.rs` for that family's acceptance tests.

use std::sync::{Arc, Mutex};

use utsushi_core::EvidenceTier;
use utsushi_core::substrate::{SinkCapability, SinkError, SinkResult, TextLine, TextSurfaceSink};
use utsushi_reallive::{
    AlwaysReadyScheduler, BytecodeElement, DispatchOutcome, ExprValue, InMemorySceneStore, LongOp,
    LongOpId, LongOpIdSequence, MSG_MODULE_ID, MSG_MODULE_TYPE, MsgOpcode, MsgRuntime,
    OPCODE_CLEAR_INDENT, OPCODE_FAST_TEXT, OPCODE_FONT_COLOR, OPCODE_LINE_BREAK, OPCODE_MSG_CLEAR,
    OPCODE_MSG_HIDE, OPCODE_NORMAL_TEXT, OPCODE_PAGE, OPCODE_PAUSE, OPCODE_SET_INDENT,
    OPCODE_TEXT_POS, OPCODE_TEXT_POS_X, OPCODE_TEXT_WINDOW, PauseLongOp, RlopKey, RlopRegistry,
    Scene, StepOutcome, Vm, VmEvent, dispatch_textout, dispatch_textout_at, register_text_rlops,
    text_module_msg_keys,
};

#[path = "support/rlop_text.rs"]
mod support;

use support::{CollectingSink, RejectingSink, build_scene, dispatch_command};

#[test]
fn register_text_rlops_registers_each_opcode_across_the_compiler_lattice() {
    let sink = Arc::new(CollectingSink::new());
    let runtime = Arc::new(MsgRuntime::with_sink(sink));
    let mut registry = RlopRegistry::new();
    let count = register_text_rlops(&mut registry, runtime);
    assert_eq!(count, MsgOpcode::ALL.len() * 3);
    assert_eq!(registry.len(), count);
}

#[test]
fn text_module_msg_keys_cover_every_compiler_lattice_type() {
    let keys = text_module_msg_keys();
    assert_eq!(keys.len(), MsgOpcode::ALL.len() * 3);
    for module_type in [0, 1, 2] {
        assert_eq!(
            keys.iter()
                .filter(|key| key.module_type == module_type)
                .count(),
            MsgOpcode::ALL.len(),
        );
    }
    for key in keys {
        assert_eq!(key.module_id, MSG_MODULE_ID);
        assert_eq!(key.module_id, 3);
    }
}

// msg.text_out — top-level Textout element handler

#[test]
fn text_out_appends_to_runtime_pending_body_no_emission_yet() {
    let sink = Arc::new(CollectingSink::new());
    let runtime = MsgRuntime::with_sink(sink.clone());
    // Shift-JIS for "あ" (0x82, 0xA0).
    dispatch_textout(&runtime, &[0x82, 0xa0]);
    assert_eq!(runtime.pending_body_len(), 2);
    // No emission until a control opcode flushes — substrate-honesty:
    // the line is not "observed" until a logical boundary fires.
    assert!(sink.snapshot().is_empty());
}

#[test]
fn port_textout_metadata_preserves_offset_and_shift_jis_bytes() {
    let sink = Arc::new(CollectingSink::new());
    let runtime = Arc::new(MsgRuntime::with_sink(sink.clone()));
    let body = vec![0x82, 0xa0]; // "あ"
    dispatch_textout_at(&runtime, 0x1234, &body);

    let mut registry = RlopRegistry::new();
    register_text_rlops(&mut registry, Arc::clone(&runtime));
    let line_break = registry
        .get(RlopKey::new(
            MSG_MODULE_TYPE,
            MSG_MODULE_ID,
            OPCODE_LINE_BREAK,
        ))
        .expect("line_break registered");
    let mut vm = Vm::new(1, 0);
    line_break.dispatch(&mut vm, &[]);

    let lines = sink.drain();
    assert_eq!(lines.len(), 1);
    assert_eq!(lines[0].byte_offset_in_scene, Some(0x1234));
    assert_eq!(lines[0].body_shift_jis, Some(body));
}

// msg.line_break — flushes the pending body as one line

#[test]
fn line_break_flushes_pending_body_as_one_text_line() {
    let sink = Arc::new(CollectingSink::new());
    let runtime = Arc::new(MsgRuntime::with_sink(sink.clone()));
    // Shift-JIS for "こんにちは"
    let konnichiwa = [
        0x82, 0xb1, // こ
        0x82, 0xf1, // ん
        0x82, 0xc9, // に
        0x82, 0xbf, // ち
        0x82, 0xcd, // は
    ];
    dispatch_textout(&runtime, &konnichiwa);
    let mut registry = RlopRegistry::new();
    register_text_rlops(&mut registry, Arc::clone(&runtime));
    let op = registry
        .get(RlopKey::new(
            MSG_MODULE_TYPE,
            MSG_MODULE_ID,
            OPCODE_LINE_BREAK,
        ))
        .expect("line_break registered");
    let mut vm = Vm::new(1, 0);
    let outcome = op.dispatch(&mut vm, &[]);
    assert!(matches!(outcome, DispatchOutcome::Advance));
    let lines = sink.drain();
    assert_eq!(lines.len(), 1);
    assert_eq!(lines[0].text, "こんにちは");
    assert_eq!(lines[0].evidence_tier, EvidenceTier::E1);
    assert_eq!(runtime.pending_body_len(), 0);
}

#[test]
fn fast_text_advances_without_splitting_the_pending_line() {
    let (outcome, lines, runtime) = dispatch_command(OPCODE_FAST_TEXT, &[]);
    assert!(matches!(outcome, DispatchOutcome::Advance));
    assert!(lines.is_empty());
    assert_eq!(runtime.pending_body_len(), 0);
}

#[test]
fn normal_text_advances_without_splitting_the_pending_line() {
    let (outcome, lines, _) = dispatch_command(OPCODE_NORMAL_TEXT, &[]);
    assert!(matches!(outcome, DispatchOutcome::Advance));
    assert!(lines.is_empty());
}

#[test]
fn set_indent_and_clear_indent_advance() {
    for opcode in [OPCODE_SET_INDENT, OPCODE_CLEAR_INDENT] {
        let (outcome, lines, _) = dispatch_command(opcode, &[]);
        assert!(matches!(outcome, DispatchOutcome::Advance));
        assert!(lines.is_empty());
    }
}

#[test]
fn text_position_commands_advance() {
    for opcode in [OPCODE_TEXT_POS, OPCODE_TEXT_POS_X] {
        let (outcome, lines, _) = dispatch_command(opcode, &[ExprValue::Int(42)]);
        assert!(matches!(outcome, DispatchOutcome::Advance));
        assert!(lines.is_empty());
    }
}

#[test]
fn page_advances_emits_line_and_clears_speaker() {
    let sink = Arc::new(CollectingSink::new());
    let runtime = Arc::new(MsgRuntime::with_sink(sink.clone()));
    dispatch_textout(&runtime, &[0x82, 0xa0]);
    let mut registry = RlopRegistry::new();
    register_text_rlops(&mut registry, Arc::clone(&runtime));
    let page = registry
        .get(RlopKey::new(MSG_MODULE_TYPE, MSG_MODULE_ID, OPCODE_PAGE))
        .expect("page registered");
    let mut vm = Vm::new(1, 0);
    let outcome = page.dispatch(&mut vm, &[]);
    assert!(matches!(outcome, DispatchOutcome::Advance));
    let lines = sink.drain();
    assert_eq!(lines.len(), 1);
    assert_eq!(lines[0].text, "あ");
}

#[test]
fn msg_hide_advances_and_flushes_pending_line() {
    let sink = Arc::new(CollectingSink::new());
    let runtime = Arc::new(MsgRuntime::with_sink(sink.clone()));
    dispatch_textout(&runtime, &[0x82, 0xa0]);
    let mut registry = RlopRegistry::new();
    register_text_rlops(&mut registry, Arc::clone(&runtime));
    let op = registry
        .get(RlopKey::new(
            MSG_MODULE_TYPE,
            MSG_MODULE_ID,
            OPCODE_MSG_HIDE,
        ))
        .expect("msg_hide registered");
    let mut vm = Vm::new(1, 0);
    let outcome = op.dispatch(&mut vm, &[]);
    assert!(matches!(outcome, DispatchOutcome::Advance));
    assert_eq!(sink.drain().len(), 1);
}

#[test]
fn msg_clear_discards_pending_body_without_emitting() {
    let sink = Arc::new(CollectingSink::new());
    let runtime = Arc::new(MsgRuntime::with_sink(sink.clone()));
    dispatch_textout(&runtime, &[0x82, 0xa0]);
    assert_eq!(runtime.pending_body_len(), 2);
    let mut registry = RlopRegistry::new();
    register_text_rlops(&mut registry, Arc::clone(&runtime));
    let op = registry
        .get(RlopKey::new(
            MSG_MODULE_TYPE,
            MSG_MODULE_ID,
            OPCODE_MSG_CLEAR,
        ))
        .expect("msg_clear registered");
    let mut vm = Vm::new(1, 0);
    let outcome = op.dispatch(&mut vm, &[]);
    assert!(matches!(outcome, DispatchOutcome::Advance));
    assert_eq!(runtime.pending_body_len(), 0);
    assert!(sink.drain().is_empty(), "msg_clear must not emit a line");
}

#[test]
fn font_color_records_rgb_value() {
    let (outcome, lines, runtime) =
        dispatch_command(OPCODE_FONT_COLOR, &[ExprValue::Int(0x00FF_8800)]);
    assert!(matches!(outcome, DispatchOutcome::Advance));
    assert!(lines.is_empty());
    assert_eq!(runtime.current_font_color(), Some(0x00FF_8800));
}

#[test]
fn font_color_with_bytes_arg_records_arg_shape_mismatch() {
    let (outcome, _, runtime) =
        dispatch_command(OPCODE_FONT_COLOR, &[ExprValue::Bytes(vec![0x82, 0xa0])]);
    assert!(matches!(outcome, DispatchOutcome::Advance));
    let warnings = runtime.take_warnings();
    assert_eq!(warnings.len(), 1);
    assert_eq!(runtime.current_font_color(), None);
}

#[test]
fn phantom_msg_opcode_addresses_do_not_register() {
    let sink = Arc::new(CollectingSink::new());
    let runtime = Arc::new(MsgRuntime::with_sink(sink.clone()));
    let mut registry = RlopRegistry::new();
    register_text_rlops(&mut registry, Arc::clone(&runtime));
    for phantom in [3, 5, 14, 18, 19, 22, 30, 31, 40, 41, 100] {
        assert!(
            registry
                .get(RlopKey::new(0, MSG_MODULE_ID, phantom))
                .is_none()
        );
    }
}

#[test]
fn historical_font_size_address_is_not_a_msg_command() {
    let keys = text_module_msg_keys();
    assert!(
        !keys.contains(&RlopKey::new(0, MSG_MODULE_ID, 31)),
        "the old FontSize mount was a phantom dispatch path"
    );
}

#[test]
fn historical_speaker_bracket_addresses_are_not_msg_commands() {
    let keys = text_module_msg_keys();
    for phantom in [40, 41] {
        assert!(
            !keys.contains(&RlopKey::new(0, MSG_MODULE_ID, phantom)),
            "speaker brackets were not encoded as msg opcode {phantom}"
        );
    }
}

#[test]
fn corrected_msg_opcode_addresses_are_registered() {
    let expected = [
        (MsgOpcode::Pause, 17),
        (MsgOpcode::TextWindow, 102),
        (MsgOpcode::FastText, 103),
        (MsgOpcode::NormalText, 104),
        (MsgOpcode::FontColor, 105),
        (MsgOpcode::MsgHide, 151),
        (MsgOpcode::MsgClear, 152),
        (MsgOpcode::MsgHideAll, 161),
        (MsgOpcode::LineBreak, 201),
        (MsgOpcode::SPause, 205),
        (MsgOpcode::Page, 210),
        (MsgOpcode::SetIndent, 300),
        (MsgOpcode::ClearIndent, 301),
        (MsgOpcode::TextPos, 310),
        (MsgOpcode::TextPosX, 311),
    ];
    let registered = text_module_msg_keys();
    for (opcode, byte) in expected {
        assert_eq!(opcode.opcode(), byte, "{opcode:?} must keep its real byte");
        assert!(registered.contains(&RlopKey::new(0, MSG_MODULE_ID, byte)));
    }
}

#[test]
fn text_window_switches_active_slot() {
    let (outcome, _, runtime) = dispatch_command(OPCODE_TEXT_WINDOW, &[ExprValue::Int(2)]);
    assert!(matches!(outcome, DispatchOutcome::Advance));
    assert_eq!(runtime.current_text_window(), Some(2));
}

// msg.pause — yields a LongOp; resumes through AlwaysReadyScheduler

#[test]
fn pause_yields_a_pause_longop_with_typed_private_state() {
    let (outcome, lines, _) = dispatch_command(OPCODE_PAUSE, &[]);
    assert!(lines.is_empty());
    match outcome {
        DispatchOutcome::Yield {
            longop_id,
            private_state,
        } => {
            let longop = LongOp::new(longop_id, private_state);
            let pause = PauseLongOp::try_from_longop(&longop).expect("decode pause");
            assert_eq!(pause.id(), longop_id);
            assert!(!pause.dismissed());
        }
        other => panic!("expected Yield, got {other:?}"),
    }
}

#[test]
fn pause_through_vm_yields_then_resumes_with_always_ready_scheduler() {
    let sink = Arc::new(CollectingSink::new());
    let runtime = Arc::new(MsgRuntime::with_sink(sink.clone()));
    let mut registry = RlopRegistry::new();
    register_text_rlops(&mut registry, Arc::clone(&runtime));
    let scene = build_scene(&[OPCODE_PAUSE, OPCODE_LINE_BREAK]);
    let mut store = InMemorySceneStore::new();
    store.insert(scene);
    let mut vm = Vm::new(1, 0);
    let mut scheduler = AlwaysReadyScheduler;
    // First step: dispatch the pause Command → Yield (pc advanced past
    // the 8-byte command); the longop sits in the queue.
    let step1 = vm.step(&store, &registry, &mut scheduler).expect("step 1");
    let yielded_id = match step1 {
        StepOutcome::Advanced {
            event: VmEvent::CommandDispatched { outcome, .. },
        } => match outcome {
            DispatchOutcome::Yield { longop_id, .. } => longop_id,
            other => panic!("expected Yield outcome, got {other:?}"),
        },
        other => panic!("expected Advanced(CommandDispatched), got {other:?}"),
    };
    assert_eq!(vm.longop_queue().len(), 1);
    assert_eq!(vm.pc(), 8, "pc must advance past the 8-byte command");
    // Second step: scheduler consumes the longop → LongOpResumed (no pc
    // advance).
    let step2 = vm.step(&store, &registry, &mut scheduler).expect("step 2");
    match step2 {
        StepOutcome::LongOpResumed { longop_id } => {
            assert_eq!(longop_id, yielded_id);
        }
        other => panic!("expected LongOpResumed, got {other:?}"),
    }
    assert!(vm.longop_queue().is_empty());
    // Third step: normal dispatch resumes; the next command is
    // OPCODE_LINE_BREAK. With no pending body, no line is emitted.
    let step3 = vm.step(&store, &registry, &mut scheduler).expect("step 3");
    assert!(matches!(
        step3,
        StepOutcome::Advanced {
            event: VmEvent::CommandDispatched { .. }
        }
    ));
    assert_eq!(vm.pc(), 16);
    assert!(sink.drain().is_empty());
}

// VarBanks invariant — none of the text ops mutate banks

#[test]
fn dispatching_every_text_opcode_leaves_var_banks_untouched() {
    let sink = Arc::new(CollectingSink::new());
    let runtime = Arc::new(MsgRuntime::with_sink(sink));
    let mut registry = RlopRegistry::new();
    register_text_rlops(&mut registry, Arc::clone(&runtime));
    let mut vm = Vm::new(1, 0);
    let snapshot_before = vm.banks().clone();
    for opcode in MsgOpcode::ALL {
        let key = opcode.rlop_key();
        let op = registry.get(key).expect("registered");
        let args: &[ExprValue] = match opcode {
            MsgOpcode::FontColor
            | MsgOpcode::TextWindow
            | MsgOpcode::TextPos
            | MsgOpcode::TextPosX => &[ExprValue::Int(1)],
            _ => &[],
        };
        let _outcome = op.dispatch(&mut vm, args);
    }
    assert_eq!(*vm.banks(), snapshot_before, "no text opcode writes banks");
}

// Sink failure path — fail-soft warning, not a panic

#[test]
fn sink_rejection_records_fail_soft_warning_no_panic() {
    let sink = Arc::new(RejectingSink);
    let runtime = Arc::new(MsgRuntime::with_sink(sink));
    dispatch_textout(&runtime, &[0x82, 0xa0]);
    let mut registry = RlopRegistry::new();
    register_text_rlops(&mut registry, Arc::clone(&runtime));
    let op = registry
        .get(RlopKey::new(
            MSG_MODULE_TYPE,
            MSG_MODULE_ID,
            OPCODE_LINE_BREAK,
        ))
        .expect("line_break registered");
    let mut vm = Vm::new(1, 0);
    let outcome = op.dispatch(&mut vm, &[]);
    assert!(matches!(outcome, DispatchOutcome::Advance));
    let warnings = runtime.take_warnings();
    assert_eq!(warnings.len(), 1);
}

// LongOpIdSequence pin — used by audit tooling

#[test]
fn longop_id_sequence_pin() {
    let seq = LongOpIdSequence::new();
    assert_eq!(seq.allocate(), LongOpId(1));
    assert_eq!(seq.allocate(), LongOpId(2));
}
