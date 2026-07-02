//! UTSUSHI-209 — synthetic acceptance tests for the `module_msg`
//! text/messaging RLOperation family.
//!
//! Each opcode covered by [`utsushi_reallive::register_text_rlops`] gets
//! a dedicated test: assert the correct [`TextSurfaceSink`] event fires
//! when expected, the VM advances per the
//! [`utsushi_reallive::DispatchOutcome`] contract, and the variable
//! banks stay untouched (the text opcodes do not write banks; that is
//! the `module_sys` / `module_mem` job for UTSUSHI-210).
//!
//! `msg.pause` exercises the longop queue path: it yields and resumes
//! once the [`utsushi_reallive::AlwaysReadyScheduler`] sees the head.
//! The choice family (`select` / `select_s` / `select_w` /
//! `select_objbtn`) lives in `module_sel` as of UTSUSHI-211; see
//! `tests/rlop_sel.rs` for that family's acceptance tests.

use std::sync::{Arc, Mutex};

use utsushi_core::EvidenceTier;
use utsushi_core::substrate::{SinkCapability, SinkError, SinkResult, TextLine, TextSurfaceSink};
use utsushi_reallive::{
    AlwaysReadyScheduler, BytecodeElement, DispatchOutcome, ExprValue, InMemorySceneStore, LongOp,
    LongOpId, LongOpIdSequence, MSG_MODULE_ID, MSG_MODULE_TYPE, MsgOpcode, MsgRuntime,
    OPCODE_FONT_COLOR, OPCODE_FONT_SIZE, OPCODE_LINE_BREAK, OPCODE_LINE_NUMBER, OPCODE_MSG_CLEAR,
    OPCODE_MSG_HIDE, OPCODE_NAME_CLOSE, OPCODE_NAME_OPEN, OPCODE_PAGE, OPCODE_PARAGRAPH_BREAK,
    OPCODE_PAUSE, OPCODE_TEXT_WINDOW, PauseLongOp, RlopKey, RlopRegistry, Scene, StepOutcome, Vm,
    VmEvent, dispatch_textout, register_text_rlops, text_module_msg_keys,
};

// ---------------------------------------------------------------------
// Test sink
// ---------------------------------------------------------------------

#[derive(Default)]
struct CollectingSink {
    lines: Mutex<Vec<TextLine>>,
}

impl CollectingSink {
    fn new() -> Self {
        Self::default()
    }

    fn drain(&self) -> Vec<TextLine> {
        std::mem::take(&mut *self.lines.lock().expect("lock"))
    }

    fn snapshot(&self) -> Vec<TextLine> {
        self.lines.lock().expect("lock").clone()
    }
}

impl TextSurfaceSink for CollectingSink {
    fn capability(&self) -> SinkCapability {
        SinkCapability::Supported {
            evidence_tier_ceiling: EvidenceTier::E1,
        }
    }

    fn emit_line(&self, line: TextLine) -> SinkResult<()> {
        line.validate()?;
        self.lines.lock().expect("lock").push(line);
        Ok(())
    }
}

#[derive(Default)]
struct RejectingSink;

impl TextSurfaceSink for RejectingSink {
    fn capability(&self) -> SinkCapability {
        SinkCapability::Unsupported
    }

    fn emit_line(&self, _line: TextLine) -> SinkResult<()> {
        Err(SinkError::UnsupportedKind {
            sink: utsushi_core::substrate::SinkKind::TextSurface,
            adapter_id: "rejecting-stub".to_string(),
            reason: "test stub rejects all lines".to_string(),
        })
    }
}

// ---------------------------------------------------------------------
// Element constructors mirroring the UTSUSHI-208 vm_synthetic.rs
// helpers.
// ---------------------------------------------------------------------

fn command_element(offset: usize, opcode: u16) -> BytecodeElement {
    BytecodeElement::Command {
        module_type: MSG_MODULE_TYPE,
        module_id: MSG_MODULE_ID,
        opcode,
        arg_count: 0,
        overload: 0,
        goto_targets: vec![],
        goto_case_exprs: vec![],
        raw_bytes: vec![
            0x23,
            MSG_MODULE_TYPE,
            MSG_MODULE_ID,
            opcode as u8,
            (opcode >> 8) as u8,
            0,
            0,
            0,
        ],
        byte_offset: offset,
        byte_len: 8,
    }
}

fn build_scene(opcodes: &[u16]) -> Scene {
    let mut elements = Vec::with_capacity(opcodes.len());
    let mut offset = 0usize;
    for opcode in opcodes {
        elements.push(command_element(offset, *opcode));
        offset += 8;
    }
    Scene::new(1, elements).expect("non-empty synthetic scene")
}

// ---------------------------------------------------------------------
// Per-opcode harness — each helper builds a runtime + registry around a
// fresh sink and dispatches the requested opcode directly through the
// registered Arc<dyn RLOperation>. Tests call these to assert the
// outcome.
// ---------------------------------------------------------------------

fn dispatch_command(
    opcode: u16,
    args: &[ExprValue],
) -> (DispatchOutcome, Vec<TextLine>, Arc<MsgRuntime>) {
    let sink = Arc::new(CollectingSink::new());
    let runtime = Arc::new(MsgRuntime::with_sink(sink.clone()));
    let mut registry = RlopRegistry::new();
    register_text_rlops(&mut registry, Arc::clone(&runtime));
    let key = RlopKey::new(MSG_MODULE_TYPE, MSG_MODULE_ID, opcode);
    let op = registry.get(key).expect("opcode must be registered");
    let mut vm = Vm::new(1, 0);
    let outcome = op.dispatch(&mut vm, args);
    let lines = sink.drain();
    (outcome, lines, runtime)
}

// ---------------------------------------------------------------------
// Registry shape
// ---------------------------------------------------------------------

#[test]
fn register_text_rlops_registers_exactly_twelve_opcodes() {
    let sink = Arc::new(CollectingSink::new());
    let runtime = Arc::new(MsgRuntime::with_sink(sink));
    let mut registry = RlopRegistry::new();
    let count = register_text_rlops(&mut registry, runtime);
    assert_eq!(
        count, 12,
        "alpha contract: exactly 12 module_msg opcodes covered after UTSUSHI-211 moved the choice family to module_sel, got {count}",
    );
    assert_eq!(count, MsgOpcode::ALL.len());
    assert_eq!(registry.len(), count);
}

#[test]
fn text_module_msg_keys_all_target_module_one_three() {
    // msg is the REAL RealLive semantic module_id 3 (an earlier revision
    // mislabelled it 5, which is SYS2 — that clobbered sel.select_objbtn
    // and msg.pause onto the same (1, 5, 3) key).
    for key in text_module_msg_keys() {
        assert_eq!(key.module_type, MSG_MODULE_TYPE);
        assert_eq!(key.module_id, MSG_MODULE_ID);
        assert_eq!(key.module_id, 3);
    }
}

// ---------------------------------------------------------------------
// msg.text_out — top-level Textout element handler
// ---------------------------------------------------------------------

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

// ---------------------------------------------------------------------
// msg.line_break — flushes the pending body as one line
// ---------------------------------------------------------------------

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
fn paragraph_break_advances_and_emits_one_line() {
    let sink = Arc::new(CollectingSink::new());
    let runtime = Arc::new(MsgRuntime::with_sink(sink.clone()));
    dispatch_textout(&runtime, &[0x82, 0xa0]); // "あ"
    let mut registry = RlopRegistry::new();
    register_text_rlops(&mut registry, Arc::clone(&runtime));
    let op = registry
        .get(RlopKey::new(
            MSG_MODULE_TYPE,
            MSG_MODULE_ID,
            OPCODE_PARAGRAPH_BREAK,
        ))
        .expect("paragraph_break registered");
    let mut vm = Vm::new(1, 0);
    let outcome = op.dispatch(&mut vm, &[]);
    assert!(matches!(outcome, DispatchOutcome::Advance));
    let lines = sink.drain();
    assert_eq!(lines.len(), 1);
    assert_eq!(lines[0].text, "あ");
}

#[test]
fn page_advances_emits_line_and_clears_speaker() {
    let sink = Arc::new(CollectingSink::new());
    let runtime = Arc::new(MsgRuntime::with_sink(sink.clone()));
    // Stage a speaker.
    dispatch_textout(&runtime, &[0x82, 0xa0]); // "あ"
    let mut registry = RlopRegistry::new();
    register_text_rlops(&mut registry, Arc::clone(&runtime));
    let mut vm = Vm::new(1, 0);
    let name_open = registry
        .get(RlopKey::new(
            MSG_MODULE_TYPE,
            MSG_MODULE_ID,
            OPCODE_NAME_OPEN,
        ))
        .expect("name_open registered");
    let outcome = name_open.dispatch(&mut vm, &[]);
    assert!(matches!(outcome, DispatchOutcome::Advance));
    assert_eq!(runtime.pending_speaker().as_deref(), Some("あ"));
    let page = registry
        .get(RlopKey::new(MSG_MODULE_TYPE, MSG_MODULE_ID, OPCODE_PAGE))
        .expect("page registered");
    let outcome = page.dispatch(&mut vm, &[]);
    assert!(matches!(outcome, DispatchOutcome::Advance));
    // After page, the speaker is cleared and the body is empty.
    assert!(runtime.pending_speaker().is_none());
    let _ = sink.drain();
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
fn linenumber_records_the_int_argument() {
    let (outcome, lines, runtime) = dispatch_command(OPCODE_LINE_NUMBER, &[ExprValue::Int(42)]);
    assert!(matches!(outcome, DispatchOutcome::Advance));
    assert!(lines.is_empty());
    assert_eq!(runtime.last_line_number(), Some(42));
}

#[test]
fn linenumber_with_missing_arg_records_a_warning() {
    let (outcome, lines, runtime) = dispatch_command(OPCODE_LINE_NUMBER, &[]);
    assert!(matches!(outcome, DispatchOutcome::Advance));
    assert!(lines.is_empty());
    assert_eq!(runtime.last_line_number(), None);
    let warnings = runtime.take_warnings();
    assert_eq!(warnings.len(), 1);
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
fn font_size_records_clamped_int_argument() {
    let (outcome, lines, runtime) = dispatch_command(OPCODE_FONT_SIZE, &[ExprValue::Int(24)]);
    assert!(matches!(outcome, DispatchOutcome::Advance));
    assert!(lines.is_empty());
    assert_eq!(runtime.current_font_size(), Some(24));
}

#[test]
fn font_size_clamps_out_of_range_input() {
    let (_outcome, _, runtime) = dispatch_command(OPCODE_FONT_SIZE, &[ExprValue::Int(400)]);
    assert_eq!(runtime.current_font_size(), Some(u8::MAX));
}

#[test]
fn name_open_then_close_stages_speaker_label() {
    let sink = Arc::new(CollectingSink::new());
    let runtime = Arc::new(MsgRuntime::with_sink(sink.clone()));
    // Stage speaker bytes (Shift-JIS for "山田")
    dispatch_textout(&runtime, &[0x8e, 0x52, 0x93, 0x63]);
    let mut registry = RlopRegistry::new();
    register_text_rlops(&mut registry, Arc::clone(&runtime));
    let mut vm = Vm::new(1, 0);
    let name_open = registry
        .get(RlopKey::new(
            MSG_MODULE_TYPE,
            MSG_MODULE_ID,
            OPCODE_NAME_OPEN,
        ))
        .expect("name_open registered");
    let outcome = name_open.dispatch(&mut vm, &[]);
    assert!(matches!(outcome, DispatchOutcome::Advance));
    let name_close = registry
        .get(RlopKey::new(
            MSG_MODULE_TYPE,
            MSG_MODULE_ID,
            OPCODE_NAME_CLOSE,
        ))
        .expect("name_close registered");
    let outcome = name_close.dispatch(&mut vm, &[]);
    assert!(matches!(outcome, DispatchOutcome::Advance));
    assert_eq!(runtime.pending_speaker().as_deref(), Some("山田"));
    // Now stage a body and flush via line_break — the emitted line
    // should carry the speaker.
    dispatch_textout(&runtime, &[0x82, 0xa0]);
    let line_break = registry
        .get(RlopKey::new(
            MSG_MODULE_TYPE,
            MSG_MODULE_ID,
            OPCODE_LINE_BREAK,
        ))
        .expect("line_break registered");
    line_break.dispatch(&mut vm, &[]);
    let lines = sink.drain();
    assert_eq!(lines.len(), 1);
    assert_eq!(lines[0].text, "あ");
    assert_eq!(lines[0].speaker.as_deref(), Some("山田"));
}

#[test]
fn text_window_switches_active_slot() {
    let (outcome, _, runtime) = dispatch_command(OPCODE_TEXT_WINDOW, &[ExprValue::Int(2)]);
    assert!(matches!(outcome, DispatchOutcome::Advance));
    assert_eq!(runtime.current_text_window(), Some(2));
}

// ---------------------------------------------------------------------
// msg.pause — yields a LongOp; resumes through AlwaysReadyScheduler
// ---------------------------------------------------------------------

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

// ---------------------------------------------------------------------
// VarBanks invariant — none of the text ops mutate banks
// ---------------------------------------------------------------------

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
            MsgOpcode::LineNumber
            | MsgOpcode::FontColor
            | MsgOpcode::FontSize
            | MsgOpcode::TextWindow => &[ExprValue::Int(1)],
            _ => &[],
        };
        let _outcome = op.dispatch(&mut vm, args);
    }
    assert_eq!(*vm.banks(), snapshot_before, "no text opcode writes banks");
}

// ---------------------------------------------------------------------
// Sink failure path — fail-soft warning, not a panic
// ---------------------------------------------------------------------

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

// ---------------------------------------------------------------------
// LongOpIdSequence pin — used by audit tooling
// ---------------------------------------------------------------------

#[test]
fn longop_id_sequence_pin() {
    let seq = LongOpIdSequence::new();
    assert_eq!(seq.allocate(), LongOpId(1));
    assert_eq!(seq.allocate(), LongOpId(2));
}
