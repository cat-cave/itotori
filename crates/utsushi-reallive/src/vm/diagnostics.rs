use super::*;

/// Typed result of a single [`Vm::step`] call.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum StepOutcome {
    /// One element was dispatched. The pc moved (possibly to a new
    /// scene). The `event` field reports the typed observation the
    /// caller may surface to an `EnginePort` sink.
    Advanced {
        /// Typed observation from this step.
        event: VmEvent,
    },
    /// The VM was suspended on a queued longop. The scheduler reported
    /// `Pending`; the next `step` will poll again.
    Suspended {
        /// Id of the queued longop the VM is suspended on.
        longop_id: LongOpId,
    },
    /// A queued longop was consumed (the scheduler returned `Ready` and
    /// the head was popped). The VM did not advance the pc on this
    /// step; the next `step` resumes the normal fetch/decode/dispatch.
    LongOpResumed {
        /// Id of the longop that was just consumed.
        longop_id: LongOpId,
    },
    /// The pc reached the end of the current scene. The VM does not
    /// advance further until the caller resets it (Jump / FarCall
    /// restore).
    EndOfScene {
        /// Scene id that hit end-of-scene.
        scene: SceneId,
    },
    /// A `Halt` dispatch outcome was observed. The VM will not advance
    /// further until the caller resets it.
    Halted,
}

/// Typed result of [`Vm::step_many`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum StepManyOutcome {
    /// The VM completed `executed` steps and stopped because it
    /// reached one of the terminating outcomes (`EndOfScene`
    /// `Halted`, `Suspended` with no progress).
    Completed {
        /// Number of `Advanced` / `LongOpResumed` steps observed
        /// before termination.
        executed: u32,
        /// The terminating outcome.
        last: StepOutcome,
    },
    /// The `max_steps` budget was exhausted before the VM terminated.
    /// Acceptance criterion #0 — `goto +0` infinite loop with
    /// `max_steps=100` produces this variant.
    OutOfBudget {
        /// Number of steps executed before the budget ran out.
        executed: u32,
    },
}

/// Typed observation produced by a successful step. Engine ports that
/// own a `SinkSet` (+) will lift these into typed text
/// frame events.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum VmEvent {
    /// Generic "advanced past an element" event — emitted for elements
    /// the VM consumed cleanly. Carries the variant name so the
    /// audit-grep can pin which elements were touched without
    /// re-walking the bytecode.
    Advanced {
        /// Variant name of the consumed element (`meta_line`
        /// `command`, etc.).
        element: &'static str,
    },
    /// A textout run was consumed. The VM has no sinks yet (per the
    /// scope) so the raw bytes are surfaced for the
    /// follow-up sinks to consume.
    Textout {
        /// Raw bytes of the textout run (Shift-JIS bytes; UTF-8
        /// conversion is the sink's responsibility).
        raw_bytes: Vec<u8>,
    },
    /// A command was dispatched through the registry. Carries the
    /// resolved key and the dispatch outcome the op produced.
    CommandDispatched {
        /// Composite key (`module_type`, `module_id`, `opcode`).
        key: RlopKey,
        /// Registrar provenance when a concrete operation resolved. `None`
        /// identifies a missing key; its typed warning carries the diagnostic.
        provenance: Option<RlopImplementationProvenance>,
        /// The outcome the op returned.
        outcome: DispatchOutcome,
    },
    /// An expression element was evaluated. The VM stores the
    /// resulting value into the var banks (assignment) or leaves it on
    /// the store register (plain expression).
    ExpressionEvaluated {
        /// Whether the expression was an assignment.
        is_assignment: bool,
        /// Resulting i32 value (the assignment target value, or the
        /// plain-expression value pushed to the store register).
        value: i32,
    },
    /// A `SelectionOption` element was observed. Selection runtime is
    /// later; the VM records the marker so a future selection sink can
    /// pick up the event.
    SelectionOption {
        /// Marker byte (`0x30..=0x34`).
        marker: u8,
    },
}

/// Fail-soft warning surfaced through [`Vm::take_warnings`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum VmWarning {
    /// A `Command` element targeted an opcode the registry does not
    /// implement. The VM advances past the command; the warning names
    /// the missing key.
    MissingRlop {
        /// Composite key that was not found.
        key: RlopKey,
        /// Scene id where the miss occurred.
        scene: SceneId,
        /// pc where the miss occurred.
        pc: u32,
    },
    /// Expression evaluation surfaced a typed error; the VM advanced
    /// past the expression element to keep the dispatch loop making
    /// progress, but the failure is recorded here so the caller can
    /// react.
    ExpressionFailure {
        /// Scene id where the failure occurred.
        scene: SceneId,
        /// pc where the failure occurred.
        pc: u32,
        /// Reason string (typed-error `to_string()`).
        reason: String,
    },
    /// Selection-option marker was observed. The full selection-runtime
    /// landing is a later work; the VM records the marker as a
    /// warning so the audit trail names the unimplemented surface
    /// instead of silently advancing past it.
    SelectionRuntimeUnimplemented {
        /// Marker byte.
        marker: u8,
        /// Scene id where it appeared.
        scene: SceneId,
        /// pc where it appeared.
        pc: u32,
    },
    /// An RLOp dispatch observed a malformed argument list (wrong arity
    /// or wrong [`crate::rlop::ExprValue`] variant). The op advances and
    /// the warning names the op family + reason so the audit trail can
    /// pin the call site.
    RlopArgsInvalid {
        /// Stable string naming the op family (e.g. `"goto"`
        /// `"farcall_with_args"`).
        op: &'static str,
        /// Short reason ("expected 1 Int arg, got 0", etc.).
        reason: String,
    },
    /// The choice-resume path observed a popped [`crate::rlop::LongOp`]
    /// whose private state carries the
    /// [`crate::rlop::SELECT_PRIVATE_STATE_MAGIC`] magic byte but
    /// decoded to a malformed payload. Surfaces a typed reason; the
    /// VM does not write to the store register. See
    /// [`Vm::apply_choice_resume`].
    ChoiceResumeMalformed {
        /// Long-op id whose payload was malformed.
        longop_id: LongOpId,
        /// Reason string (typed decode error `to_string()`).
        reason: String,
    },
    /// The choice-resume path popped a select-shaped longop whose
    /// chosen-index was still the pending sentinel. No store-register
    /// write happens; the warning names the longop id so the audit
    /// trail can correlate with the scheduler that signalled Ready
    /// without recording a choice.
    ChoiceResumeWithoutChoice {
        /// Long-op id that was missing a recorded choice.
        longop_id: LongOpId,
    },
    ObjectChoiceResumeMalformed {
        longop_id: LongOpId,
        reason: String,
    },
    ObjectChoiceResumeWithoutChoice {
        longop_id: LongOpId,
    },
    ObjectChoiceResumeUnsupportedOutcome {
        longop_id: LongOpId,
    },
    ObjectChoiceResumeOutOfRange {
        longop_id: LongOpId,
        selected: u16,
        choice_count: usize,
    },
}

/// Typed error variants surfaced by [`Vm::step`]. Every failure mode is
/// named; the dispatch loop does not panic on bad bytecode.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum VmError {
    /// `Vm::step` consulted [`SceneStore::fetch`] for the current
    /// scene id and got `None`.
    #[error("utsushi.reallive.vm.scene_not_found: scene={scene}")]
    SceneNotFound {
        /// Scene id that was not in the store.
        scene: SceneId,
    },
    /// A cross-scene `jump` / `farcall` referenced an entrypoint index
    /// that the target scene does not declare (no matching
    /// [`BytecodeElement::MetaEntrypoint`] marker). Surfaced instead of
    /// silently landing at pc `0` so a genuine gap is never masked.
    #[error("utsushi.reallive.vm.entrypoint_not_found: scene={scene} entrypoint={entrypoint}")]
    EntrypointNotFound {
        /// Target scene id.
        scene: SceneId,
        /// Entrypoint index that could not be resolved.
        entrypoint: u16,
    },
    /// `pc` did not land on the start of any element (it pointed into
    /// the middle of a decoded element — a Jump / FarCall produced an
    /// invalid target).
    #[error("utsushi.reallive.vm.unaligned_pc: scene={scene} pc={pc} bytecode_len={bytecode_len}")]
    UnalignedPc {
        /// Scene id.
        scene: SceneId,
        /// pc value that did not align.
        pc: u32,
        /// Total decompressed bytecode length of the scene.
        bytecode_len: u32,
    },
    /// `ret` or `rtl` popped an empty stack. Acceptance criterion #1.
    #[error("utsushi.reallive.vm.empty_stack: scene={scene} pc={pc} expected={expected}")]
    EmptyStack {
        /// Scene id where the pop happened.
        scene: SceneId,
        /// pc where the pop happened.
        pc: u32,
        /// Stable string naming the expected frame kind.
        expected: &'static str,
    },
    /// A `ret` popped a far-call frame, or `rtl` popped a subroutine
    /// frame. Surfaces as a typed error so callers can detect
    /// mismatched control-flow primitives.
    #[error(
        "utsushi.reallive.vm.frame_kind_mismatch: scene={scene} pc={pc} expected={expected} \
         found={found}"
    )]
    FrameKindMismatch {
        /// Scene id where the pop happened.
        scene: SceneId,
        /// pc where the pop happened.
        pc: u32,
        /// Expected frame kind ("subroutine" or "far_call").
        expected: &'static str,
        /// Found frame kind ("subroutine" or "far_call").
        found: &'static str,
    },
    /// The bytecode-element decoder surfaced a typed error.
    #[error("utsushi.reallive.vm.bytecode_decode: {reason}")]
    BytecodeDecode {
        /// Scene id.
        scene: SceneId,
        /// pc that failed to decode.
        pc: u32,
        /// Reason string (BytecodeDecodeError `to_string()`).
        reason: String,
    },
    /// The call stack reached [`STACK_DEPTH_LIMIT`] frames. The push was
    /// rejected — the VM does not silently truncate the stack. Surfaces
    /// the originating scene/pc so a runaway `gosub`/`farcall` chain can
    /// be diagnosed at the call site.
    #[error("utsushi.reallive.vm.stack_overflow: scene={scene} pc={pc} limit={limit} kind={kind}")]
    StackOverflow {
        /// Scene id where the offending push happened.
        scene: SceneId,
        /// pc where the offending push happened.
        pc: u32,
        /// Pinned ceiling ([`STACK_DEPTH_LIMIT`]).
        limit: usize,
        /// Stable string naming the frame kind that was being pushed.
        kind: &'static str,
    },
    /// A control-flow op was dispatched expecting one [`DispatchOutcome`]
    /// shape but produced another. Surfaced by
    /// [`crate::syscall::SyscallDispatcher::invoke`] when `FarcallOp`
    /// returns anything other than [`DispatchOutcome::FarCall`]: the
    /// route dispatcher refuses to apply the unexpected outcome rather
    /// than silently forwarding it (which in a release build would
    /// corrupt control flow with no diagnostic). Dead against the current
    /// op tables — pinned so a future `FarcallOp` failure mode surfaces
    /// as a typed error instead of a debug-only assertion.
    #[error(
        "utsushi.reallive.vm.unexpected_dispatch_outcome: scene={scene} pc={pc} expected={expected} found={found}"
    )]
    UnexpectedDispatchOutcome {
        /// Scene id of the route that was dispatched.
        scene: SceneId,
        /// Return pc supplied to the dispatch.
        pc: u32,
        /// Stable token naming the expected outcome ("far_call").
        expected: &'static str,
        /// Stable token naming the outcome actually produced.
        found: &'static str,
    },
}

impl From<BytecodeDecodeError> for VmError {
    fn from(err: BytecodeDecodeError) -> Self {
        Self::BytecodeDecode {
            scene: 0,
            pc: 0,
            reason: err.to_string(),
        }
    }
}
