use super::*;

/// Shared dispatch body for the four variants. Each variant is its own
/// [`RLOperation`] impl so the registry key (and the
/// [`SelectVariant`] discriminant tag) names the entry point; the
/// dispatch body lives here so the four impls stay synchronised.
fn dispatch_select(
    variant: SelectVariant,
    runtime: &SelRuntime,
    vm: &mut Vm,
    args: &[ExprValue],
) -> DispatchOutcome {
    let mut choices: Vec<Vec<u8>> = Vec::with_capacity(args.len());
    let mut rendered: Vec<(usize, String)> = Vec::with_capacity(args.len());
    for (idx, arg) in args.iter().enumerate() {
        let bytes = match arg {
            ExprValue::Bytes(bytes) => bytes.clone(),
            ExprValue::Int(_) => {
                // A skipped Int never becomes a stored choice, so the raw
                // arg position `idx` is the only meaningful pointer to the
                // offending arg in the source list.
                runtime.record_warning(SelRuntimeWarning::ArgShapeMismatch {
                    variant,
                    choice_index: idx,
                    expected: "bytes",
                });
                continue;
            }
        };
        // The emitted `choice:<idx>` surface (and SELBTN styling) must use
        // the stored `choices` Vec position, not the raw arg index: that
        // Vec position is what `SelectLongOp::choose` / `set_store` index
        // into when the user picks. With non-Bytes args interleaved the two
        // diverge, so derive the index from the contiguous choices length.
        let choice_index = choices.len();
        let text = if let Ok(text) = decode_shift_jis(&bytes) {
            text
        } else {
            runtime.record_warning(SelRuntimeWarning::InvalidShiftJis {
                variant,
                choice_index,
            });
            String::from_utf8_lossy(&bytes).into_owned()
        };
        rendered.push((choice_index, text));
        choices.push(bytes);
    }
    if args.is_empty() {
        runtime.record_warning(SelRuntimeWarning::MissingChoices { variant });
    }
    // A select command that recovered ZERO choice labels is not a
    // presentable prompt — advance it instead of yielding an empty
    // SelectLongOp. Now that the family is registered at the REAL
    // `module_type=0`, this guard keeps the OTHER `(0, 2, x)` sel-family
    // opcodes that carry no inline `{ … }` option block (e.g. an
    // option-less `select_s` that reads from the string table, or a
    // selection-control op that slips through) fail-soft as `Advance` —
    // exactly as the opcode catalog gap-filled them before — rather than
    // parking a bogus empty choice that would inflate `choices_made` and
    // write a spurious `$store = 0`. Real `select_w (0, 2, 2)` prompts
    // always carry an option block, so they still yield + drive a branch.
    if choices.is_empty() {
        return DispatchOutcome::Advance;
    }
    let id = runtime.id_sequence().allocate();
    let option_line_ids: Vec<String> = rendered
        .into_iter()
        .filter_map(|(index, text)| runtime.emit_choice(variant, index, text))
        .collect();
    if option_line_ids.len() == choices.len() {
        runtime.record_prompt(SelectionPrompt {
            longop_id: id,
            byte_offset_in_scene: vm.pc(),
            kind: SelectionPromptKind::Text,
            cancelable: false,
            option_line_ids,
        });
    }
    let select = SelectLongOp::new(id, choices);
    let LongOp { id, private_state } = select.into_longop();
    DispatchOutcome::Yield {
        longop_id: id,
        private_state,
    }
}

/// `select` — basic choice prompt. Each arg is a Shift-JIS choice
/// label.
#[derive(Debug)]
pub struct SelectOp {
    runtime: Arc<SelRuntime>,
}

impl SelectOp {
    /// Build the op against a shared [`SelRuntime`].
    pub fn new(runtime: Arc<SelRuntime>) -> Self {
        Self { runtime }
    }
}

impl RLOperation for SelectOp {
    fn dispatch(&self, vm: &mut Vm, args: &[ExprValue]) -> DispatchOutcome {
        dispatch_select(SelectVariant::Select, &self.runtime, vm, args)
    }
}

/// `select_s` — choice with explicit string-table args. Same byte-
/// string shape as [`SelectOp`]; the variant exists so audit tooling
/// can pin which opcode produced the queued longop.
#[derive(Debug)]
pub struct SelectSOp {
    runtime: Arc<SelRuntime>,
}

impl SelectSOp {
    pub fn new(runtime: Arc<SelRuntime>) -> Self {
        Self { runtime }
    }
}

impl RLOperation for SelectSOp {
    fn dispatch(&self, vm: &mut Vm, args: &[ExprValue]) -> DispatchOutcome {
        dispatch_select(SelectVariant::SelectS, &self.runtime, vm, args)
    }
}

/// `select_w` — windowed choice. Same arg shape as [`SelectOp`].
#[derive(Debug)]
pub struct SelectWOp {
    runtime: Arc<SelRuntime>,
}

impl SelectWOp {
    pub fn new(runtime: Arc<SelRuntime>) -> Self {
        Self { runtime }
    }
}

impl RLOperation for SelectWOp {
    fn dispatch(&self, vm: &mut Vm, args: &[ExprValue]) -> DispatchOutcome {
        dispatch_select(SelectVariant::SelectW, &self.runtime, vm, args)
    }
}

fn dispatch_select_objbtn(
    runtime: &SelRuntime,
    vm: &mut Vm,
    args: &[ExprValue],
) -> DispatchOutcome {
    let [ExprValue::Int(group)] = args else {
        runtime.record_warning(SelRuntimeWarning::ObjectButtonGroupArgsInvalid {
            observed: args.len(),
        });
        return DispatchOutcome::Advance;
    };
    dispatch_object_select(runtime, vm.pc(), *group, false)
}

fn dispatch_object_select(
    runtime: &SelRuntime,
    byte_offset_in_scene: u32,
    group: i32,
    cancelable: bool,
) -> DispatchOutcome {
    let Some(graphics) = runtime.graphics() else {
        runtime.record_warning(SelRuntimeWarning::ObjectButtonRuntimeUnavailable { group });
        return DispatchOutcome::Advance;
    };
    let candidates = graphics.foreground_button_candidates(group);
    if candidates.is_empty() {
        runtime.record_warning(SelRuntimeWarning::ObjectButtonCandidatesEmpty { group });
        return DispatchOutcome::Advance;
    }
    let return_values: Vec<i32> = candidates
        .iter()
        .map(|candidate| candidate.options.button_number)
        .collect();
    let mut select =
        match ObjectSelectLongOp::try_new(runtime.id_sequence().allocate(), return_values) {
            Ok(select) => select,
            Err(ObjectSelectLongOpBuildError::TooManyReturnValues { observed }) => {
                runtime.record_warning(SelRuntimeWarning::ObjectButtonCarrierTooLarge { observed });
                return DispatchOutcome::Advance;
            }
        };
    select.set_cancelable(cancelable);
    let LongOp { id, private_state } = select.into_longop();
    runtime.record_prompt(SelectionPrompt {
        longop_id: id,
        byte_offset_in_scene,
        kind: SelectionPromptKind::ObjectButtons {
            group,
            options: candidates
                .into_iter()
                .enumerate()
                .map(|(display_index, candidate)| {
                    let hit_region = candidate.object.hit_region(None);
                    ObjectButtonPromptOption {
                        display_index: display_index as u16,
                        button_number: candidate.options.button_number,
                        fg_slot: candidate.slot,
                        visual_snapshot: candidate.object,
                        candidate_scope: ObjectButtonCandidateScope::TopLevelForegroundOnly,
                        hit_region,
                    }
                })
                .collect(),
        },
        cancelable,
        option_line_ids: Vec::new(),
    });
    DispatchOutcome::Yield {
        longop_id: id,
        private_state,
    }
}

#[derive(Debug)]
pub struct SelectObjbtnOp {
    runtime: Arc<SelRuntime>,
}

impl SelectObjbtnOp {
    pub fn new(runtime: Arc<SelRuntime>) -> Self {
        Self { runtime }
    }
}

impl RLOperation for SelectObjbtnOp {
    fn dispatch(&self, vm: &mut Vm, args: &[ExprValue]) -> DispatchOutcome {
        dispatch_select_objbtn(&self.runtime, vm, args)
    }
}

/// `select_s` at rlvm opcode `3` — string-table text choice. Same carrier as
/// [`SelectSOp`] / [`SelectOp`] (yields a [`SelectLongOp`] over its recovered
/// option labels); the distinct [`SelectVariant::SelectS3`] tag pins which
/// opcode produced the queued longop. Registered for exact rlvm `Sel`-oracle
/// coverage — the opcode is absent from both proven corpora, so it is an
/// oracle-faithfulness op, not a real-bytes-driven one.
#[derive(Debug)]
pub struct SelectS3Op {
    runtime: Arc<SelRuntime>,
}

impl SelectS3Op {
    /// Build the op against a shared [`SelRuntime`].
    pub fn new(runtime: Arc<SelRuntime>) -> Self {
        Self { runtime }
    }
}

impl RLOperation for SelectS3Op {
    fn dispatch(&self, vm: &mut Vm, args: &[ExprValue]) -> DispatchOutcome {
        dispatch_select(SelectVariant::SelectS3, &self.runtime, vm, args)
    }
}

#[derive(Debug)]
pub struct SelectObjbtnCancelOp {
    runtime: Arc<SelRuntime>,
}

impl SelectObjbtnCancelOp {
    /// Build the op against a shared [`SelRuntime`].
    pub fn new(runtime: Arc<SelRuntime>) -> Self {
        Self { runtime }
    }
}

impl RLOperation for SelectObjbtnCancelOp {
    fn dispatch(&self, vm: &mut Vm, args: &[ExprValue]) -> DispatchOutcome {
        let group = match args {
            [ExprValue::Int(group)] | [ExprValue::Int(group), ExprValue::Int(_)] => *group,
            _ => {
                self.runtime
                    .record_warning(SelRuntimeWarning::ObjectButtonCancelArgsInvalid {
                        observed: args.len(),
                    });
                return DispatchOutcome::Advance;
            }
        };
        dispatch_object_select(&self.runtime, vm.pc(), group, true)
    }
}

/// `objbtn_init` (`sel (0,2,20)`) is recognized as an exact no-op. Binding
/// state lives on graphics objects; selection/resume and rendering remain
/// separate work.
#[derive(Debug, Default)]
pub struct ObjbtnInitOp;

impl ObjbtnInitOp {
    /// Construct the stateless no-op.
    pub fn new() -> Self {
        Self
    }
}

impl RLOperation for ObjbtnInitOp {
    fn dispatch(&self, _vm: &mut Vm, _args: &[ExprValue]) -> DispatchOutcome {
        DispatchOutcome::Advance
    }
}

/// Mount every choice op this module ships into `registry`. Returns
/// the number of entries registered (matches [`SEL_RLOP_COUNT`]).
///
/// Registers the EXACT rlvm `Sel`-module opcode set `{0,1,2,3,4,14,20}`: the
/// six [`SelectVariant`] SELECT ops (`select` `0`, `select_s` `1`, `select_w`
/// `2`, `select_s` `3`, `select_objbtn` `4`, `select_objbtn_cancel` `14`) plus
/// the `objbtn_init` (`20`) button-object group-setup op — no more, no less
/// (there is no synthetic opcode `120`; rlvm's `RLModule("Sel", 0, 2)` has no
/// such opcode).
pub fn register_sel_rlops(registry: &mut RlopRegistry, runtime: Arc<SelRuntime>) -> usize {
    registry.register(
        SelectVariant::Select.rlop_key(),
        Arc::new(SelectOp::new(Arc::clone(&runtime))),
    );
    registry.register(
        SelectVariant::SelectS.rlop_key(),
        Arc::new(SelectSOp::new(Arc::clone(&runtime))),
    );
    registry.register(
        SelectVariant::SelectW.rlop_key(),
        Arc::new(SelectWOp::new(Arc::clone(&runtime))),
    );
    registry.register(
        SelectVariant::SelectS3.rlop_key(),
        Arc::new(SelectS3Op::new(Arc::clone(&runtime))),
    );
    registry.register(
        SelectVariant::SelectObjbtn.rlop_key(),
        Arc::new(SelectObjbtnOp::new(Arc::clone(&runtime))),
    );
    registry.register(
        SelectVariant::SelectObjbtnCancel.rlop_key(),
        Arc::new(SelectObjbtnCancelOp::new(Arc::clone(&runtime))),
    );
    // `objbtn_init` is a recognized no-op; bindings live on graphics objects.
    registry.register(
        RlopKey::new(SEL_MODULE_TYPE, SEL_MODULE_ID, OPCODE_OBJBTN_INIT),
        Arc::new(ObjbtnInitOp::new()),
    );
    SEL_RLOP_COUNT
}
