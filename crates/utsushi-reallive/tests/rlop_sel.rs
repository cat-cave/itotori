//! UTSUSHI-211 — synthetic acceptance tests for the `module_sel`
//! choice family (`select` / `select_s` / `select_w` / `select_objbtn`).
//!
//! Two acceptance tests are pinned by the spec:
//!
//! - `choice_select_s_emits_three_options`: a synthetic `select_s` with
//!   three byte-string args emits 3 `TextLine` events through the sink,
//!   each tagged `text_surface = "choice:<idx>"`, and then suspends
//!   with a queued [`SelectLongOp`] carrying the chosen-pending
//!   sentinel.
//! - `choice_resume_writes_store_reg`: feeding `ChoiceIndex(1)` to a
//!   [`ChoiceInputScheduler`] resumes the longop and writes `1` into
//!   the VM's store register; the pc advanced past the choice element
//!   on the original dispatch.
//!
//! Two additional tests exercise the SELBTN.NNN.* Gameexe styling and
//! the registry shape:
//!
//! - `selbtn_styling_surfaces_on_emitted_choice_lines`: when the
//!   Gameexe carries `#SELBTN.000.000 = "value"`, the choice line for
//!   index 0 includes the SELBTN suffix in its `text_surface` tag.
//! - `register_sel_rlops_covers_every_variant_and_reallive_real_bytes_alias`:
//!   the helper populates every canonical variant plus the
//!   Sweetie-HD-observed `select_w` opcode alias.

use std::sync::{Arc, Mutex};

use utsushi_core::EvidenceTier;
use utsushi_core::substrate::{ChoiceIndex, SinkCapability, SinkResult, TextLine, TextSurfaceSink};
use utsushi_reallive::{
    BytecodeElement, ChoiceInputScheduler, DispatchOutcome, ExprValue, Gameexe, InMemorySceneStore,
    LongOpId, NeverReadyScheduler, OPCODE_SELECT_OBJBTN, OPCODE_SELECT_S, OPCODE_SELECT_W,
    OPCODE_SELECT_W_SWEETIE_HD_ALIAS, RlopKey, RlopRegistry, SEL_MODULE_ID, SEL_MODULE_TYPE,
    SEL_OPCODE_SELECT, SEL_RLOP_COUNT, Scene, SelRuntime, SelectLongOp, SelectVariant, StepOutcome,
    Vm, VmEvent, register_sel_rlops,
};

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

fn build_runtime(gameexe: Option<Arc<Gameexe>>) -> (Arc<CollectingSink>, Arc<SelRuntime>) {
    let sink: Arc<CollectingSink> = Arc::new(CollectingSink::new());
    let sink_dyn: Arc<dyn TextSurfaceSink> = sink.clone();
    let runtime = match gameexe {
        Some(game) => Arc::new(SelRuntime::with_gameexe(sink_dyn, game)),
        None => Arc::new(SelRuntime::with_sink(sink_dyn)),
    };
    (sink, runtime)
}

fn sel_command(offset: usize, opcode: u16) -> BytecodeElement {
    BytecodeElement::Command {
        module_type: SEL_MODULE_TYPE,
        module_id: SEL_MODULE_ID,
        opcode,
        arg_count: 0,
        overload: 0,
        goto_targets: vec![],
        raw_bytes: vec![
            0x23,
            SEL_MODULE_TYPE,
            SEL_MODULE_ID,
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

// ---------------------------------------------------------------------
// Spec acceptance 1: select_s emits 3 TextLines then suspends
// ---------------------------------------------------------------------

#[test]
fn choice_select_s_emits_three_options() {
    let (sink, runtime) = build_runtime(None);
    let mut registry = RlopRegistry::new();
    register_sel_rlops(&mut registry, Arc::clone(&runtime));
    let op = registry
        .get(RlopKey::new(
            SEL_MODULE_TYPE,
            SEL_MODULE_ID,
            OPCODE_SELECT_S,
        ))
        .expect("select_s registered");
    let mut vm = Vm::new(1, 0);
    let outcome = op.dispatch(
        &mut vm,
        &[
            ExprValue::Bytes(b"a".to_vec()),
            ExprValue::Bytes(b"b".to_vec()),
            ExprValue::Bytes(b"c".to_vec()),
        ],
    );
    let (longop_id, private_state) = match outcome {
        DispatchOutcome::Yield {
            longop_id,
            private_state,
        } => (longop_id, private_state),
        other => panic!("expected Yield, got {other:?}"),
    };
    let lines = sink.drain();
    assert_eq!(lines.len(), 3, "three choice TextLines emitted");
    assert_eq!(lines[0].text, "a");
    assert_eq!(lines[0].text_surface.as_deref(), Some("choice:0"));
    assert_eq!(lines[1].text, "b");
    assert_eq!(lines[1].text_surface.as_deref(), Some("choice:1"));
    assert_eq!(lines[2].text, "c");
    assert_eq!(lines[2].text_surface.as_deref(), Some("choice:2"));
    // Each line is E1 (runtime-observed).
    for line in &lines {
        assert_eq!(line.evidence_tier, EvidenceTier::E1);
    }
    // The yielded longop carries the SELECT magic and chosen-pending
    // sentinel.
    assert_eq!(
        private_state[0],
        utsushi_reallive::SELECT_PRIVATE_STATE_MAGIC
    );
    assert_eq!(longop_id, LongOpId(1));
    let decoded =
        SelectLongOp::try_from_longop(&utsushi_reallive::LongOp::new(longop_id, private_state))
            .expect("decode");
    assert_eq!(decoded.choice_count(), 3);
    assert_eq!(decoded.chosen(), None);
}

// ---------------------------------------------------------------------
// Spec acceptance 2: ChoiceIndex(1) resume writes store_reg and pc
// advanced past the choice element on dispatch
// ---------------------------------------------------------------------

#[test]
fn choice_resume_writes_store_reg() {
    let (_sink, runtime) = build_runtime(None);
    let mut registry = RlopRegistry::new();
    register_sel_rlops(&mut registry, Arc::clone(&runtime));
    // Two-element scene: select_s element (8 bytes) + dummy element.
    // Synthetic scene with one select_s opcode — the VM will:
    //   1. Dispatch select_s with zero args (because the bytecode
    //      Command we built has argc=0). The op records a
    //      `MissingChoices` warning but yields the longop. pc advances
    //      to post_pc (= 8).
    //   2. Subsequent step: scheduler returns Ready (because we
    //      recorded a choice). The longop is popped, the chosen index
    //      is written to store_reg.
    let scene = Scene::new(
        1,
        vec![
            sel_command(0, OPCODE_SELECT_S),
            sel_command(8, OPCODE_SELECT_W), // dummy follow-up so pc has somewhere to land
        ],
    )
    .expect("non-empty scene");
    let mut store = InMemorySceneStore::new();
    store.insert(scene);
    let mut vm = Vm::new(1, 0);
    // Bytecode dispatch path supplies zero args; build a longop via
    // direct dispatch so the synthetic choice list is non-empty. This
    // mirrors the production path where UTSUSHI-205+ argument decoding
    // will supply the Shift-JIS choice strings.
    {
        let op = registry
            .get(RlopKey::new(
                SEL_MODULE_TYPE,
                SEL_MODULE_ID,
                OPCODE_SELECT_S,
            ))
            .expect("select_s registered");
        let outcome = op.dispatch(
            &mut vm,
            &[
                ExprValue::Bytes(b"left".to_vec()),
                ExprValue::Bytes(b"right".to_vec()),
            ],
        );
        // Threaded apply mirrors the VM step path (Yield → enqueue +
        // advance pc past the dispatching command).
        vm.apply_dispatch_outcome(&outcome, 8).expect("apply");
    }
    // pc advanced past the select element.
    assert_eq!(vm.pc(), 8);
    assert_eq!(vm.longop_queue().len(), 1);
    // Feed the choice and let the scheduler/VM-resume hook do the rest.
    let mut scheduler = ChoiceInputScheduler::new();
    scheduler.record_choice(ChoiceIndex(1));
    let outcome = vm.step(&store, &registry, &mut scheduler).expect("step");
    assert!(matches!(outcome, StepOutcome::LongOpResumed { .. }));
    // The store register now reads as 1 — the resume side-effect
    // wrote the chosen index.
    assert_eq!(vm.banks().store(), 1);
    // The queue is drained.
    assert_eq!(vm.longop_queue().len(), 0);
}

// ---------------------------------------------------------------------
// SELBTN.NNN.* Gameexe styling surfaces on the emitted choice line
// ---------------------------------------------------------------------

#[test]
fn selbtn_styling_surfaces_on_emitted_choice_lines() {
    // Build a synthetic Gameexe with one SELBTN.000.000 entry.
    let game_ini = b"#SELBTN.000.000 = 12, 34, 56\n";
    let gameexe = Arc::new(Gameexe::parse(game_ini).expect("parse gameexe"));
    let (sink, runtime) = build_runtime(Some(gameexe));
    let mut registry = RlopRegistry::new();
    register_sel_rlops(&mut registry, Arc::clone(&runtime));
    let op = registry
        .get(RlopKey::new(
            SEL_MODULE_TYPE,
            SEL_MODULE_ID,
            SEL_OPCODE_SELECT,
        ))
        .expect("select registered");
    let mut vm = Vm::new(1, 0);
    let _outcome = op.dispatch(
        &mut vm,
        &[
            ExprValue::Bytes(b"first".to_vec()),
            ExprValue::Bytes(b"second".to_vec()),
        ],
    );
    let lines = sink.drain();
    assert_eq!(lines.len(), 2);
    // The first choice (index 0) should carry the SELBTN style tag.
    let first_surface = lines[0]
        .text_surface
        .as_deref()
        .expect("text_surface present");
    assert!(
        first_surface.starts_with("choice:0;"),
        "first choice surface starts with choice:0 + styling, got {first_surface}"
    );
    assert!(
        first_surface.contains("selbtn=000"),
        "SELBTN.000.000 surfaces as selbtn=000 in tag, got {first_surface}"
    );
    // The second choice (index 1) has no SELBTN entry, so falls back
    // to the plain choice surface.
    assert_eq!(lines[1].text_surface.as_deref(), Some("choice:1"));
}

// ---------------------------------------------------------------------
// Registry shape — every variant and the Sweetie-HD alias resolve
// ---------------------------------------------------------------------

#[test]
fn register_sel_rlops_covers_every_variant_and_reallive_real_bytes_alias() {
    let (_sink, runtime) = build_runtime(None);
    let mut registry = RlopRegistry::new();
    let count = register_sel_rlops(&mut registry, runtime);
    assert_eq!(count, SEL_RLOP_COUNT);
    assert_eq!(registry.len(), SEL_RLOP_COUNT);
    for variant in SelectVariant::ALL {
        assert!(
            registry.get(variant.rlop_key()).is_some(),
            "missing variant {variant:?}",
        );
    }
    let alias_key = RlopKey::new(
        SEL_MODULE_TYPE,
        SEL_MODULE_ID,
        OPCODE_SELECT_W_SWEETIE_HD_ALIAS,
    );
    assert!(
        registry.get(alias_key).is_some(),
        "Sweetie HD select_w alias missing"
    );
}

// ---------------------------------------------------------------------
// Substrate scheduler audit — pending without recorded choice stays
// suspended; no private wait loop
// ---------------------------------------------------------------------

#[test]
fn scheduler_keeps_vm_suspended_until_choice_recorded() {
    let (_sink, runtime) = build_runtime(None);
    let mut registry = RlopRegistry::new();
    register_sel_rlops(&mut registry, Arc::clone(&runtime));
    let scene = Scene::new(1, vec![sel_command(0, OPCODE_SELECT_W)]).expect("scene");
    let mut store = InMemorySceneStore::new();
    store.insert(scene);
    let mut vm = Vm::new(1, 0);
    // First step dispatches the select_w command — Yield, advance pc.
    let mut scheduler = ChoiceInputScheduler::new();
    let step1 = vm.step(&store, &registry, &mut scheduler).expect("step 1");
    assert!(matches!(
        step1,
        StepOutcome::Advanced {
            event: VmEvent::CommandDispatched {
                outcome: DispatchOutcome::Yield { .. },
                ..
            }
        }
    ));
    assert_eq!(vm.longop_queue().len(), 1);
    // Subsequent step without a recorded choice: suspended.
    let step2 = vm.step(&store, &registry, &mut scheduler).expect("step 2");
    assert!(
        matches!(step2, StepOutcome::Suspended { .. }),
        "no choice recorded → suspended, not popping"
    );
    // store register still zero (the default).
    assert_eq!(vm.banks().store(), 0);
}

// ---------------------------------------------------------------------
// objbtn variant exercises the same dispatch shape
// ---------------------------------------------------------------------

#[test]
fn select_objbtn_emits_choices_like_other_variants() {
    let (sink, runtime) = build_runtime(None);
    let mut registry = RlopRegistry::new();
    register_sel_rlops(&mut registry, Arc::clone(&runtime));
    let op = registry
        .get(RlopKey::new(
            SEL_MODULE_TYPE,
            SEL_MODULE_ID,
            OPCODE_SELECT_OBJBTN,
        ))
        .expect("select_objbtn registered");
    let mut vm = Vm::new(1, 0);
    let outcome = op.dispatch(&mut vm, &[ExprValue::Bytes(b"go".to_vec())]);
    assert!(matches!(outcome, DispatchOutcome::Yield { .. }));
    let lines = sink.drain();
    assert_eq!(lines.len(), 1);
    assert_eq!(lines[0].text, "go");
}

// ---------------------------------------------------------------------
// Never-ready scheduler with a queued select keeps the VM suspended —
// pin the substrate-honesty posture (no panic, no infinite loop).
// ---------------------------------------------------------------------

#[test]
fn never_ready_scheduler_keeps_select_longop_pending() {
    let (_sink, runtime) = build_runtime(None);
    let mut registry = RlopRegistry::new();
    register_sel_rlops(&mut registry, Arc::clone(&runtime));
    let scene = Scene::new(1, vec![sel_command(0, OPCODE_SELECT_S)]).expect("scene");
    let mut store = InMemorySceneStore::new();
    store.insert(scene);
    let mut vm = Vm::new(1, 0);
    let mut scheduler = NeverReadyScheduler;
    let _step1 = vm.step(&store, &registry, &mut scheduler).expect("step 1");
    let step2 = vm.step(&store, &registry, &mut scheduler).expect("step 2");
    assert!(matches!(step2, StepOutcome::Suspended { .. }));
}
