//! UTSUSHI-208 — RealLive bytecode VM (fetch / decode / dispatch /
//! advance) with longop yield + substrate snapshot.
//!
//! The VM owns the central RealLive execution state: the active
//! `(scene, pc)`, the call stack, the typed variable banks, and the
//! suspended-longop queue. Each [`Vm::step`] call fetches the next
//! bytecode element at the current `(scene, pc)`, decodes it, and
//! dispatches according to the
//! [`crate::rlop::DispatchOutcome`] table.
//!
//! # Substrate-honesty posture
//!
//! - **No panic on bad bytecode.** Every failure surfaces as a typed
//!   [`VmError`] or [`VmWarning`]. The synthetic test suite pins the
//!   `goto +0` budget terminator (`Vm::step_many`) and the empty-stack
//!   `ret` / `rtl` error paths.
//! - **No silent fallbacks.** A missing RLOp surfaces a typed
//!   [`VmWarning::MissingRlop`] event; the VM advances past the
//!   command and the warning is exposed via [`Vm::take_warnings`]. The
//!   `Halt` and `Yield` outcomes are typed; there is no
//!   "execute-something-else" fallback for an unsupported op.
//! - **Substrate `Inspectable` / `Restorable` adoption.** The VM does
//!   not invent a private snapshot format — every restorable field is
//!   carried under the `port.utsushi_reallive_vm.*` namespace inside a
//!   substrate [`StateTree`], and the `VarBanks` substrate impl is
//!   re-used verbatim for the banks payload.
//!
//! # Public surface
//!
//! - [`Vm`] — the VM itself.
//! - [`SceneId`] — scene-id alias (`u16`).
//! - [`Scene`] / [`SceneStore`] — the scene index the VM consumes.
//!   `Scene` carries a pre-decoded element list (so `pc` can index it
//!   by byte offset cheaply); `SceneStore` is the lookup the VM uses
//!   when a Jump / FarCall changes scene.
//! - [`StackFrame`] / [`StackFrameKind`] — call-stack frame types.
//! - [`StepOutcome`] — the typed result of a single step.
//! - [`StepManyOutcome`] — the typed result of [`Vm::step_many`].
//! - [`VmError`] / [`VmWarning`] / [`VmEvent`] — typed diagnostics.

use std::collections::{BTreeMap, VecDeque};

use serde::{Deserialize, Serialize};

use utsushi_core::substrate::{
    Inspectable, Restorable, RestoreReport, SnapshotError, StatePath, StateTree, StateValue,
};

use crate::bytecode_element::{
    BytecodeDecodeError, BytecodeElement, CommandArgShape, decode_command_arg_values,
};
use crate::expression::{ExprNode, parse_expression};
use crate::expression_eval::{EvaluationError, evaluate, evaluate_assignment};
use crate::rlop::{
    DispatchOutcome, ExprValue, LongOp, LongOpId, LongOpReadiness, LongOpScheduler, RlopKey,
    RlopRegistry,
};
use crate::var_banks::VarBanks;

/// Scene id (`u16`). Matches the on-disk scene-directory slot index
/// produced by [`crate::RealSceneEntry`].
pub type SceneId = u16;

/// Stable identifier of the VM `Inspectable` surface. Used by the
/// substrate facade so two snapshots from different ports cannot be
/// accidentally diffed.
pub const VM_INSPECTABLE_ID: &str = "utsushi-reallive-vm";

/// State-tree namespace root for the VM. Engine-port convention places
/// port-owned fields under `port.*`.
const NAMESPACE_ROOT: &str = "port";

/// State-path leaf for the manifest entry. Always present so an empty
/// VM still produces a non-empty `StateTree`.
const MANIFEST_PATH: &str = "port.utsushi_reallive_vm.manifest";
/// State-path leaf for `scene`.
const SCENE_PATH: &str = "port.utsushi_reallive_vm.scene";
/// State-path leaf for `pc`.
const PC_PATH: &str = "port.utsushi_reallive_vm.pc";
/// State-path leaf for the call stack payload.
const STACK_PATH: &str = "port.utsushi_reallive_vm.stack";
/// State-path leaf for the queued longop payload.
const LONGOP_PATH: &str = "port.utsushi_reallive_vm.longop_queue";
/// State-path leaf for the halt flag.
const HALTED_PATH: &str = "port.utsushi_reallive_vm.halted";

/// Manifest string under [`MANIFEST_PATH`]. Carries the schema label
/// so a future schema bump can be detected at restore time.
const VM_MANIFEST: &str = "utsushi-reallive-vm/0.1.0-alpha";

/// Default budget ceiling for [`Vm::step_many`]. Pinned so a caller
/// that forgets to pass an explicit budget cannot accidentally execute
/// an infinite `goto +0` loop without a terminator.
pub const DEFAULT_STEP_BUDGET: u32 = 100_000;

/// Hard ceiling on the call-stack depth. Pinned at the rlvm-documented
/// 1024 frames so a runaway `gosub`/`farcall` chain produces a typed
/// [`VmError::StackOverflow`] instead of an unbounded `Vec` growth.
/// Acceptance criterion #4 in UTSUSHI-210 — exercised by the
/// `stack_overflow_after_limit_pushes` test.
pub const STACK_DEPTH_LIMIT: usize = 1024;

/// One frame on the VM call stack.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct StackFrame {
    /// Scene to return to when this frame is popped. `Some(scene)` for a
    /// far-call frame; `None` for a subroutine frame (the subroutine
    /// stays within the calling scene).
    pub return_scene: Option<SceneId>,
    /// pc to return to within the calling scene (post-`gosub` or
    /// post-`farcall` byte).
    pub return_pc: u32,
    /// Frame kind discriminator — used by `ret` vs `rtl` to assert they
    /// pop the right kind of frame.
    pub frame_kind: StackFrameKind,
}

/// Frame kind discriminator carried on every [`StackFrame`].
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum StackFrameKind {
    /// Pushed by `gosub`; popped by `ret`.
    Subroutine,
    /// Pushed by `farcall`; popped by `rtl`.
    FarCall,
}

impl StackFrameKind {
    /// Stable lowercase tag used in diagnostics and in the substrate
    /// state-tree wire form.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Subroutine => "subroutine",
            Self::FarCall => "far_call",
        }
    }

    /// Parse from the stable wire form. Returns `None` on an unknown
    /// tag so the restore path can surface a typed error.
    ///
    /// Deliberately not named `from_str` (and not implemented as
    /// [`std::str::FromStr`]) so the callsite is grep-pinnable as
    /// "wire-form parse" rather than as a generic string conversion.
    pub fn parse_wire(raw: &str) -> Option<Self> {
        match raw {
            "subroutine" => Some(Self::Subroutine),
            "far_call" => Some(Self::FarCall),
            _ => None,
        }
    }
}

/// One decoded scene the VM can execute against. Carries the
/// pre-decoded bytecode element list and a `(byte_offset → index)` map
/// so a `pc` value (which is a byte offset in the RealLive convention)
/// can resolve to an element in O(log n).
#[derive(Debug, Clone)]
pub struct Scene {
    /// Scene id (matches the `SceneStore` key).
    pub id: SceneId,
    /// Pre-decoded bytecode elements. The byte_offset/byte_len ranges
    /// partition the underlying decompressed bytes exactly (per the
    /// UTSUSHI-204 invariant).
    pub elements: Vec<BytecodeElement>,
    /// Total decompressed bytecode length. Used as the terminating pc
    /// value — a `pc` equal to `bytecode_len` indicates "past the end
    /// of the scene".
    pub bytecode_len: u32,
    /// `byte_offset → element index` lookup.
    offset_to_index: BTreeMap<u32, usize>,
    /// `entrypoint_index → byte_offset` lookup, built from the scene's
    /// [`BytecodeElement::MetaEntrypoint`] markers. A cross-scene
    /// `farcall(scene, entrypoint)` / `jump(scene, entrypoint)` resolves
    /// a non-zero entrypoint through this map; entrypoint `0` maps to pc
    /// `0` (scene start) whether or not a marker names it.
    entrypoints: BTreeMap<u16, u32>,
}

impl Scene {
    /// Build a `Scene` from the pre-decoded element list. Returns
    /// `None` if the element list is empty (the alpha-gate "no silent
    /// zero-state" contract) or if any element overflows `u32`.
    ///
    /// `bytecode_len` is computed as `last.byte_offset + last.byte_len`
    /// rather than `sum(byte_len)` so this constructor stays robust
    /// against a caller that hands us a sub-range of a larger
    /// element list (`elements[0].byte_offset()` may legitimately be
    /// non-zero in that case).
    pub fn new(id: SceneId, elements: Vec<BytecodeElement>) -> Option<Self> {
        if elements.is_empty() {
            return None;
        }
        let mut offset_to_index = BTreeMap::new();
        let mut entrypoints = BTreeMap::new();
        for (idx, element) in elements.iter().enumerate() {
            let offset = u32::try_from(element.byte_offset()).ok()?;
            offset_to_index.insert(offset, idx);
            if let BytecodeElement::MetaEntrypoint {
                entrypoint_index, ..
            } = element
            {
                // The marker's byte offset is the pc a cross-scene call
                // into that entrypoint resumes at.
                entrypoints.insert(*entrypoint_index, offset);
            }
        }
        let last = elements.last()?;
        let last_offset = u32::try_from(last.byte_offset()).ok()?;
        let last_len = u32::try_from(last.byte_len()).ok()?;
        let bytecode_len = last_offset.checked_add(last_len)?;
        Some(Self {
            id,
            elements,
            bytecode_len,
            offset_to_index,
            entrypoints,
        })
    }

    /// Resolve an entrypoint index to a byte-offset pc within this scene.
    ///
    /// Entrypoint `0` is the scene start (`pc 0`) whether or not an
    /// explicit [`BytecodeElement::MetaEntrypoint`] marker names it — this
    /// matches the RealLive convention that a bare `farcall(scene)` /
    /// `jump(scene)` (no explicit entrypoint arg) enters at the top. A
    /// non-zero entrypoint resolves through the marker map; an index with
    /// no marker returns `None` so the VM surfaces a typed
    /// [`VmError::EntrypointNotFound`] instead of silently landing at 0.
    pub fn entrypoint_pc(&self, entrypoint: u16) -> Option<u32> {
        if entrypoint == 0 {
            return Some(self.entrypoints.get(&0).copied().unwrap_or(0));
        }
        self.entrypoints.get(&entrypoint).copied()
    }

    /// Resolve `pc` (a byte offset) to the element starting at that
    /// offset. Returns `None` if the pc lands past the end of the
    /// scene or in the middle of an element (which would indicate a
    /// jump landed on a non-aligned byte — a hard error at the VM
    /// layer).
    pub fn element_at(&self, pc: u32) -> Option<&BytecodeElement> {
        let idx = *self.offset_to_index.get(&pc)?;
        self.elements.get(idx)
    }

    /// Whether `pc` is past the last element. Used by the VM to surface
    /// a typed `StepOutcome::EndOfScene` instead of a panic.
    pub fn is_past_end(&self, pc: u32) -> bool {
        pc >= self.bytecode_len
    }
}

/// Lookup the VM consults when a Jump / FarCall references a scene.
///
/// Implementors typically wrap a `BTreeMap<SceneId, Arc<Scene>>` or a
/// lazy decoder over a scene archive. The VM only requires
/// `fetch(scene) -> Option<&Scene>` so the test fixtures can supply
/// synthetic scenes directly.
pub trait SceneStore {
    /// Fetch the scene for `id`. Returns `None` if the scene is not
    /// present in the store — the VM surfaces this as a typed
    /// [`VmError::SceneNotFound`].
    fn fetch(&self, id: SceneId) -> Option<&Scene>;
}

/// In-memory scene store. The default fixture for tests.
#[derive(Debug, Default)]
pub struct InMemorySceneStore {
    scenes: BTreeMap<SceneId, Scene>,
}

impl InMemorySceneStore {
    /// Construct an empty in-memory scene store.
    pub fn new() -> Self {
        Self::default()
    }

    /// Insert a scene; returns the previously-stored scene (if any).
    pub fn insert(&mut self, scene: Scene) -> Option<Scene> {
        self.scenes.insert(scene.id, scene)
    }

    /// Number of scenes in the store.
    pub fn len(&self) -> usize {
        self.scenes.len()
    }

    /// Whether the store has zero scenes.
    pub fn is_empty(&self) -> bool {
        self.scenes.is_empty()
    }

    /// Every scene id present, in ascending order.
    pub fn scene_ids(&self) -> Vec<SceneId> {
        self.scenes.keys().copied().collect()
    }
}

impl SceneStore for InMemorySceneStore {
    fn fetch(&self, id: SceneId) -> Option<&Scene> {
        self.scenes.get(&id)
    }
}

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
    /// advance further until the caller resets it (Jump / FarCall /
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
    /// reached one of the terminating outcomes (`EndOfScene`,
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
/// own a `SinkSet` (UTSUSHI-209+) will lift these into typed text /
/// frame events.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum VmEvent {
    /// Generic "advanced past an element" event — emitted for elements
    /// the VM consumed cleanly. Carries the variant name so the
    /// audit-grep can pin which elements were touched without
    /// re-walking the bytecode.
    Advanced {
        /// Variant name of the consumed element (`meta_line`,
        /// `command`, etc.).
        element: &'static str,
    },
    /// A textout run was consumed. The VM has no sinks yet (per the
    /// UTSUSHI-208 scope) so the raw bytes are surfaced for the
    /// follow-up UTSUSHI-209 / UTSUSHI-220 sinks to consume.
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
    /// landing is a follow-up node; the VM records the marker as a
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
        /// Stable string naming the op family (e.g. `"goto"`,
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

/// The RealLive bytecode VM.
///
/// Owns the active scene/pc, the call stack, the typed variable banks,
/// and the suspended-longop queue. Stepping is driven by
/// [`Vm::step`] / [`Vm::step_many`]; the substrate
/// [`Inspectable`] / [`Restorable`] impls round-trip the whole VM
/// through the snapshot store.
#[derive(Debug, Clone)]
pub struct Vm {
    scene: SceneId,
    pc: u32,
    stack: Vec<StackFrame>,
    banks: VarBanks,
    longop_queue: VecDeque<LongOp>,
    halted: bool,
    warnings: Vec<VmWarning>,
    /// Byte offset immediately past the command currently being
    /// dispatched. Set transiently by [`Vm::dispatch_element`] before an
    /// op's `dispatch`, so a control-flow op (`gosub` / `farcall`) can
    /// read the return pc it must push without the VM having to prepend
    /// it as a synthetic argument. Not part of the substrate snapshot —
    /// it is only meaningful mid-step and defaults to `0` at every tick
    /// boundary.
    post_pc: u32,
    /// One-shot deterministic spin-break request. When `true`, the NEXT
    /// executed control-transfer command (goto / goto_if / goto_on /
    /// gosub / farcall — anything whose [`DispatchOutcome`] would move the
    /// pc off the natural fall-through) is FORCED to fall through to its
    /// post-command pc instead, and the flag is cleared. Set by the
    /// branch-following driver's provable-spin detector to MODEL the
    /// deterministic event the loop was polling for having fired (so the
    /// poll takes its exit edge). Never part of a snapshot — it is a
    /// transient driver control, `false` at every tick boundary.
    suppress_next_transfer: bool,
    /// Set to `true` by [`Vm::dispatch_element`] iff the most recent step
    /// actually consumed a [`Self::suppress_next_transfer`] request (i.e.
    /// a real control transfer was rewritten to a fall-through). Lets the
    /// driver confirm the modeled event landed on a genuine transfer.
    last_transfer_suppressed: bool,
}

impl Vm {
    /// Construct a VM positioned at `(scene, pc)` with empty banks /
    /// stack / longop queue.
    pub fn new(scene: SceneId, pc: u32) -> Self {
        Self {
            scene,
            pc,
            stack: Vec::new(),
            banks: VarBanks::new(),
            longop_queue: VecDeque::new(),
            halted: false,
            warnings: Vec::new(),
            post_pc: 0,
            suppress_next_transfer: false,
            last_transfer_suppressed: false,
        }
    }

    /// Fold the FULL deterministic control state — active `(scene, pc)`,
    /// the call-stack shape (each frame's return scene / pc / kind), and
    /// the complete mutable memory ([`VarBanks::fingerprint`]) — into a
    /// 64-bit fingerprint.
    ///
    /// Two VMs sharing a `control_fingerprint` will, under the same store
    /// / registry / (deterministic) scheduler, execute an IDENTICAL next
    /// step: stepping is a pure function of exactly this state. The
    /// branch-following driver uses the fingerprint to PROVE a spin — a
    /// walk that returns to an already-seen fingerprint is in a
    /// deterministic infinite loop (no clock / RNG can perturb it), which
    /// is the trigger for the driver's event-flag model.
    pub fn control_fingerprint(&self) -> u64 {
        const FNV_OFFSET: u64 = 0xcbf2_9ce4_8422_2325;
        const FNV_PRIME: u64 = 0x0000_0100_0000_01b3;
        let mut hash = FNV_OFFSET;
        let mut fold = |bytes: &[u8]| {
            for byte in bytes {
                hash ^= u64::from(*byte);
                hash = hash.wrapping_mul(FNV_PRIME);
            }
        };
        fold(&self.scene.to_le_bytes());
        fold(&self.pc.to_le_bytes());
        fold(&(self.stack.len() as u64).to_le_bytes());
        for frame in &self.stack {
            fold(&frame.return_scene.unwrap_or(u16::MAX).to_le_bytes());
            fold(&frame.return_pc.to_le_bytes());
            fold(&[frame.frame_kind as u8]);
        }
        fold(&[u8::from(self.halted)]);
        // Combine with the memory fingerprint (already an FNV fold).
        fold(&self.banks.fingerprint().to_le_bytes());
        hash
    }

    /// Request that the NEXT executed control-transfer command fall
    /// through to its post-command pc instead of transferring. See
    /// [`Self::suppress_next_transfer`]. One-shot: cleared as soon as a
    /// transfer consumes it (or the flag is explicitly reset).
    pub fn request_suppress_next_transfer(&mut self) {
        self.suppress_next_transfer = true;
    }

    /// Whether the most recent [`Vm::step`] rewrote a real control
    /// transfer into a fall-through because a
    /// [`Self::request_suppress_next_transfer`] was pending.
    pub fn last_transfer_suppressed(&self) -> bool {
        self.last_transfer_suppressed
    }

    /// Byte offset immediately past the command currently being
    /// dispatched. Only meaningful while an op's `dispatch` is executing
    /// (the branch-following `gosub` / `farcall` ops read it to obtain the
    /// return pc); `0` outside a dispatch.
    pub fn post_pc(&self) -> u32 {
        self.post_pc
    }

    /// Borrow the scene id the VM is currently positioned in.
    pub fn scene(&self) -> SceneId {
        self.scene
    }

    /// Borrow the pc the VM is currently positioned at.
    pub fn pc(&self) -> u32 {
        self.pc
    }

    /// Borrow the call stack. Used by tests and by the snapshot path.
    pub fn stack(&self) -> &[StackFrame] {
        &self.stack
    }

    /// Borrow the typed variable banks.
    pub fn banks(&self) -> &VarBanks {
        &self.banks
    }

    /// Borrow the typed variable banks mutably.
    pub fn banks_mut(&mut self) -> &mut VarBanks {
        &mut self.banks
    }

    /// Borrow the suspended-longop queue.
    pub fn longop_queue(&self) -> &VecDeque<LongOp> {
        &self.longop_queue
    }

    /// Whether the VM has observed a `DispatchOutcome::Halt`. While
    /// halted, `step` returns `StepOutcome::Halted` and does not
    /// advance the pc.
    pub fn is_halted(&self) -> bool {
        self.halted
    }

    /// Drain the accumulated fail-soft warnings. Callers wire this into
    /// their diagnostic sink at a cadence of their choosing.
    pub fn take_warnings(&mut self) -> Vec<VmWarning> {
        std::mem::take(&mut self.warnings)
    }

    /// Borrow the fail-soft warnings without draining.
    pub fn warnings(&self) -> &[VmWarning] {
        &self.warnings
    }

    /// Reset the halt flag. The caller drives this — the VM never
    /// silently un-halts itself.
    pub fn clear_halt(&mut self) {
        self.halted = false;
    }

    /// Append a fail-soft warning to the VM's diagnostic buffer.
    ///
    /// Per-module RLOperation tables (UTSUSHI-209, UTSUSHI-210, …) use
    /// this to surface a typed observation (e.g. a malformed argument
    /// list) without panicking and without inventing a separate side
    /// channel. The warning is drained by [`Vm::take_warnings`] at the
    /// caller's cadence.
    pub fn push_warning(&mut self, warning: VmWarning) {
        self.warnings.push(warning);
    }

    /// Apply a [`DispatchOutcome`] against the VM, advancing to
    /// `post_pc` for [`DispatchOutcome::Advance`] / `Yield`. Exposed so
    /// per-module RLOperation tests can drive the same code path as
    /// the dispatch loop without staging a synthetic scene store —
    /// useful for the stack-overflow and frame-kind-mismatch
    /// acceptance tests.
    pub fn apply_dispatch_outcome(
        &mut self,
        outcome: &DispatchOutcome,
        post_pc: u32,
    ) -> Result<(), VmError> {
        self.apply_outcome(outcome, post_pc)
    }

    /// Apply the typed resume side-effect for a popped longop.
    ///
    /// If `popped` carries a select-shaped private state (magic byte =
    /// [`crate::rlop::SELECT_PRIVATE_STATE_MAGIC`]) and the chosen
    /// index has been recorded, write the chosen index to the store
    /// register through [`crate::var_banks::VarBanks::set_store`].
    /// Non-select longops are ignored. Malformed payloads surface a
    /// fail-soft [`VmWarning::ChoiceResumeMalformed`].
    ///
    /// Exposed so per-module integration tests and the substrate
    /// runner can drive the same code path as [`Vm::step`] without
    /// staging a synthetic scene store.
    pub fn apply_choice_resume(&mut self, popped: &crate::rlop::LongOp) {
        if popped.private_state.first() != Some(&crate::rlop::SELECT_PRIVATE_STATE_MAGIC) {
            return;
        }
        match crate::rlop::SelectLongOp::try_from_longop(popped) {
            Ok(select) => match select.chosen() {
                Some(index) => {
                    self.banks.set_store(index as u32);
                }
                None => {
                    self.warnings.push(VmWarning::ChoiceResumeWithoutChoice {
                        longop_id: popped.id,
                    });
                }
            },
            Err(err) => {
                self.warnings.push(VmWarning::ChoiceResumeMalformed {
                    longop_id: popped.id,
                    reason: err.to_string(),
                });
            }
        }
    }

    /// Take a single fetch / decode / dispatch / advance step.
    ///
    /// The scheduler is consulted before fetching the next element so a
    /// queued longop can suspend the VM without making forward
    /// progress. Returns one of the typed [`StepOutcome`] variants.
    pub fn step(
        &mut self,
        scenes: &dyn SceneStore,
        registry: &RlopRegistry,
        scheduler: &mut dyn LongOpScheduler,
    ) -> Result<StepOutcome, VmError> {
        if self.halted {
            return Ok(StepOutcome::Halted);
        }
        // Reset the per-step "did we suppress a transfer" flag; the
        // Command-dispatch path sets it back to `true` iff this step
        // rewrites a control transfer into a fall-through.
        self.last_transfer_suppressed = false;
        // Longop queue: poll the head before fetching the next
        // element. A `Pending` reading suspends the VM; a `Ready`
        // reading pops the head and lets the next step resume the
        // normal dispatch.
        if let Some(head) = self.longop_queue.front_mut() {
            let head_id = head.id;
            match scheduler.poll(head) {
                LongOpReadiness::Pending => {
                    return Ok(StepOutcome::Suspended { longop_id: head_id });
                }
                LongOpReadiness::Ready => {
                    // SAFETY: front_mut returned Some so pop_front
                    // cannot fail. The expect documents the invariant.
                    let popped = self
                        .longop_queue
                        .pop_front()
                        .expect("front_mut returned Some, pop_front must succeed");
                    // UTSUSHI-211: typed resume side-effect. If the
                    // popped longop carries a SelectLongOp payload
                    // (magic byte = SELECT_PRIVATE_STATE_MAGIC), decode
                    // the chosen index and write it into the store
                    // register. The scheduler (e.g.
                    // [`ChoiceInputScheduler`]) is responsible for
                    // recording the chosen index into the head's
                    // private state before signalling Ready; this path
                    // is the substrate-coupled translation from
                    // "scheduler said Ready" to "VM observed a chosen
                    // index". The audit-focus pin for UTSUSHI-211
                    // ("Longop coupling — the longop must use the
                    // substrate scheduler, not a private wait loop")
                    // lands here.
                    self.apply_choice_resume(&popped);
                    return Ok(StepOutcome::LongOpResumed { longop_id: head_id });
                }
            }
        }
        // Fetch + decode the current element.
        let scene = scenes
            .fetch(self.scene)
            .ok_or(VmError::SceneNotFound { scene: self.scene })?;
        if scene.is_past_end(self.pc) {
            return Ok(StepOutcome::EndOfScene { scene: self.scene });
        }
        let Some(element) = scene.element_at(self.pc) else {
            return Err(VmError::UnalignedPc {
                scene: self.scene,
                pc: self.pc,
                bytecode_len: scene.bytecode_len,
            });
        };
        // We clone the element so we can release the borrow on the
        // scene store before mutating self (the dispatch path may
        // mutate banks / stack / pc).
        let element = element.clone();
        let element_len =
            u32::try_from(element.byte_len()).map_err(|_| VmError::BytecodeDecode {
                scene: self.scene,
                pc: self.pc,
                reason: "element byte_len exceeds u32::MAX".to_string(),
            })?;
        let post_pc = self
            .pc
            .checked_add(element_len)
            .ok_or(VmError::BytecodeDecode {
                scene: self.scene,
                pc: self.pc,
                reason: "pc + element_len overflows u32".to_string(),
            })?;

        let event = self.dispatch_element(scenes, element, post_pc, registry)?;
        Ok(StepOutcome::Advanced { event })
    }

    /// Run [`Vm::step`] up to `max_steps` times. Returns one of the
    /// typed [`StepManyOutcome`] variants. Acceptance criterion #0 —
    /// a synthetic `goto +0` infinite loop produces
    /// [`StepManyOutcome::OutOfBudget`] (no panic, no infinite loop).
    pub fn step_many(
        &mut self,
        scenes: &dyn SceneStore,
        registry: &RlopRegistry,
        scheduler: &mut dyn LongOpScheduler,
        max_steps: u32,
    ) -> Result<StepManyOutcome, VmError> {
        let mut executed: u32 = 0;
        while executed < max_steps {
            let outcome = self.step(scenes, registry, scheduler)?;
            match &outcome {
                StepOutcome::Advanced { .. } | StepOutcome::LongOpResumed { .. } => {
                    executed = executed.saturating_add(1);
                }
                StepOutcome::Suspended { .. }
                | StepOutcome::EndOfScene { .. }
                | StepOutcome::Halted => {
                    return Ok(StepManyOutcome::Completed {
                        executed,
                        last: outcome,
                    });
                }
            }
        }
        Ok(StepManyOutcome::OutOfBudget { executed })
    }

    /// Dispatch a fetched element. Centralised so [`Vm::step`] stays
    /// focused on the fetch / queue / pc-arithmetic loop. The `post_pc`
    /// argument is the byte offset that follows the element — used by
    /// the `Advance` and `Subroutine` / `FarCall` paths.
    fn dispatch_element(
        &mut self,
        scenes: &dyn SceneStore,
        element: BytecodeElement,
        post_pc: u32,
        registry: &RlopRegistry,
    ) -> Result<VmEvent, VmError> {
        match element {
            BytecodeElement::MetaLine { .. } => {
                self.pc = post_pc;
                Ok(VmEvent::Advanced {
                    element: "meta_line",
                })
            }
            BytecodeElement::MetaEntrypoint { .. } => {
                self.pc = post_pc;
                Ok(VmEvent::Advanced {
                    element: "meta_entrypoint",
                })
            }
            BytecodeElement::MetaKidoku { .. } => {
                self.pc = post_pc;
                Ok(VmEvent::Advanced {
                    element: "meta_kidoku",
                })
            }
            BytecodeElement::Comma { .. } => {
                self.pc = post_pc;
                Ok(VmEvent::Advanced { element: "comma" })
            }
            BytecodeElement::Textout { raw_bytes, .. } => {
                self.pc = post_pc;
                Ok(VmEvent::Textout { raw_bytes })
            }
            BytecodeElement::SelectionOption { marker, .. } => {
                self.warnings
                    .push(VmWarning::SelectionRuntimeUnimplemented {
                        marker,
                        scene: self.scene,
                        pc: self.pc,
                    });
                self.pc = post_pc;
                Ok(VmEvent::SelectionOption { marker })
            }
            BytecodeElement::Expression { raw_bytes, .. } => {
                let event = self.dispatch_expression(&raw_bytes);
                self.pc = post_pc;
                Ok(event)
            }
            BytecodeElement::Command {
                module_type,
                module_id,
                opcode,
                raw_bytes,
                goto_targets,
                goto_case_exprs,
                ..
            } => {
                let key = RlopKey::new(module_type, module_id, opcode);
                if let Some(op) = registry.get(key) {
                    // Decode the element's own argument list and
                    // dispatch with the REAL values. Previously this
                    // passed `&[]`, so every argument-taking op — all
                    // control-flow ops (goto / farcall / …) included —
                    // saw an empty slice and took its warn-and-advance
                    // path, making jumps dead in the integration path.
                    //
                    // The goto-family jump-target pointers live OUTSIDE
                    // the `(...)` argument list (the decoder framed them
                    // as trailing `i32`s). Append them as trailing `Int`
                    // args so a control-flow op sees `[cond?.., target..]`
                    // — the layout `GotoOp` / `GotoIfOp` / `GotoOnOp`
                    // expect. Non-goto commands carry no targets, so this
                    // is a no-op for them.
                    let mut args = self.decode_command_args(&raw_bytes);
                    if goto_case_exprs.is_empty() {
                        for target in &goto_targets {
                            args.push(ExprValue::Int(i32::from_ne_bytes(target.to_ne_bytes())));
                        }
                    } else {
                        // `goto_case` / `gosub_case`: the decoded `(disc)`
                        // list left the discriminant in `args[0]`. Evaluate
                        // each case's match EXPRESSION against it (in real VM
                        // memory context) and pre-resolve the matched target,
                        // reproducing the exact `value == case_i` selection.
                        // The op receives the single resolved target (or an
                        // empty arg list ⇒ no case matched and no default `()`
                        // case, so control falls through).
                        let discriminant = args.first().and_then(ExprValue::as_int);
                        let selected = self.select_goto_case_target(
                            discriminant,
                            &goto_targets,
                            &goto_case_exprs,
                        );
                        args.clear();
                        if let Some(target) = selected {
                            args.push(ExprValue::Int(i32::from_ne_bytes(target.to_ne_bytes())));
                        }
                    }
                    // Expose the post-command pc so branch-following
                    // `gosub` / `farcall` ops can read the return pc they
                    // must push, without the VM prepending a synthetic arg.
                    self.post_pc = post_pc;
                    let outcome = op.dispatch(self, &args);
                    self.post_pc = 0;
                    // Deterministic spin-break / event model: if the
                    // branch-following driver armed a one-shot suppression
                    // (it PROVED the walk is re-entering an identical
                    // `(scene, pc, stack, memory)` state — a deterministic
                    // infinite loop) and THIS command is a pc-moving
                    // control transfer (a backward `goto` closing the poll
                    // loop, or a computed `farcall`/`gosub` into an event
                    // subsystem), rewrite it to a fall-through. This models
                    // the polled event having fired: the poll takes its
                    // exit edge instead of looping. `ret` / `rtl` unwinds
                    // are never rewritten (that would corrupt the stack).
                    let outcome =
                        if self.suppress_next_transfer && outcome_is_pc_moving_transfer(&outcome) {
                            self.suppress_next_transfer = false;
                            self.last_transfer_suppressed = true;
                            DispatchOutcome::Advance
                        } else {
                            outcome
                        };
                    // Cross-scene outcomes address a target by
                    // `(scene, entrypoint)`; resolve the entrypoint to a
                    // concrete pc against the store (which the op layer
                    // cannot see) before applying. The resolved outcome is
                    // what the VmEvent reports, so downstream sees the real
                    // scene/pc transfer.
                    let resolved = self.resolve_scene_outcome(scenes, &outcome, post_pc)?;
                    self.apply_outcome(&resolved, post_pc)?;
                    Ok(VmEvent::CommandDispatched {
                        key,
                        outcome: resolved,
                    })
                } else {
                    self.warnings.push(VmWarning::MissingRlop {
                        key,
                        scene: self.scene,
                        pc: self.pc,
                    });
                    self.pc = post_pc;
                    Ok(VmEvent::CommandDispatched {
                        key,
                        outcome: DispatchOutcome::Advance,
                    })
                }
            }
        }
    }

    /// Decode a `Command` element's `(...)` argument list (from
    /// `raw_bytes`, past the 8-byte header) into the [`ExprValue`] slice
    /// [`crate::rlop::RLOperation::dispatch`] expects.
    ///
    /// This is the seam the audit pinned: the integration dispatch path
    /// used to pass `&[]`, so control-flow opcodes never received their
    /// targets and a real scene's `goto` was silently walked linearly
    /// instead of jumping. Each comma-separated argument value is decoded
    /// to its real `ExprValue` — expression-shaped data is parsed +
    /// evaluated to an `Int`, string / complex data is carried as
    /// `Bytes`.
    ///
    /// Decoding is fail-soft to match the surrounding dispatch loop: a
    /// value that fails to parse / evaluate surfaces a typed
    /// [`VmWarning::ExpressionFailure`] and decoding stops, so the op
    /// observes the prefix it could decode and applies its own typed
    /// arity / variant check rather than panicking. The element already
    /// length-walked successfully at decode time, so a hard structural
    /// error here is unreachable on real scenes; if it ever occurs it is
    /// surfaced as a warning and an empty arg list, never a panic.
    fn decode_command_args(&mut self, raw_bytes: &[u8]) -> Vec<ExprValue> {
        let arg_slices = match decode_command_arg_values(raw_bytes) {
            Ok(slices) => slices,
            Err(err) => {
                self.warnings.push(VmWarning::ExpressionFailure {
                    scene: self.scene,
                    pc: self.pc,
                    reason: err.to_string(),
                });
                return Vec::new();
            }
        };
        let mut values = Vec::with_capacity(arg_slices.len());
        for arg in arg_slices {
            match arg.shape {
                CommandArgShape::Expression => match parse_expression(&arg.bytes) {
                    Ok((node, _consumed)) => match self.eval_expression_node(&node) {
                        Ok((_is_assignment, value)) => values.push(ExprValue::Int(value)),
                        Err(err) => {
                            self.warnings.push(VmWarning::ExpressionFailure {
                                scene: self.scene,
                                pc: self.pc,
                                reason: err.to_string(),
                            });
                            break;
                        }
                    },
                    Err(err) => {
                        self.warnings.push(VmWarning::ExpressionFailure {
                            scene: self.scene,
                            pc: self.pc,
                            reason: err.to_string(),
                        });
                        break;
                    }
                },
                CommandArgShape::String | CommandArgShape::Complex => {
                    values.push(ExprValue::Bytes(arg.bytes));
                }
            }
        }
        values
    }

    /// Select the matched `goto_case` / `gosub_case` jump target by
    /// evaluating each case's match expression against the discriminant.
    ///
    /// Faithful to rlvm `GotoCaseElement`: the cases are checked in order;
    /// a non-empty case `(expr)` matches when `eval(expr) == discriminant`,
    /// and the default case (the empty `()`, recorded as an empty
    /// expression) matches unconditionally. Returns the absolute target pc
    /// of the first matching case, or `None` when no case matches and no
    /// default `()` case is present (control falls through past the block).
    ///
    /// Case expressions are evaluated read-only against the current memory
    /// banks (no store-register side effect), so probing the cases never
    /// perturbs VM state.
    fn select_goto_case_target(
        &self,
        discriminant: Option<i32>,
        targets: &[u32],
        cases: &[Vec<u8>],
    ) -> Option<u32> {
        let discriminant = discriminant?;
        for (index, case) in cases.iter().enumerate() {
            let matched = if case.is_empty() {
                // The default `()` case matches any discriminant.
                true
            } else {
                match parse_expression(case) {
                    Ok((node, _consumed)) => {
                        evaluate(&node, &self.banks).is_ok_and(|value| value == discriminant)
                    }
                    // A case whose bytes do not parse as an expression
                    // cannot match; skip it rather than fail the drive.
                    Err(_) => false,
                }
            };
            if matched {
                return targets.get(index).copied();
            }
        }
        None
    }

    /// Evaluate the supplied expression element raw bytes and surface a
    /// typed event. Failures are recorded as fail-soft warnings — the
    /// VM still advances past the expression element.
    fn dispatch_expression(&mut self, raw_bytes: &[u8]) -> VmEvent {
        match parse_expression(raw_bytes) {
            Ok((node, _consumed)) => match self.eval_expression_node(&node) {
                Ok((is_assignment, value)) => VmEvent::ExpressionEvaluated {
                    is_assignment,
                    value,
                },
                Err(err) => {
                    self.warnings.push(VmWarning::ExpressionFailure {
                        scene: self.scene,
                        pc: self.pc,
                        reason: err.to_string(),
                    });
                    VmEvent::ExpressionEvaluated {
                        is_assignment: false,
                        value: 0,
                    }
                }
            },
            Err(err) => {
                self.warnings.push(VmWarning::ExpressionFailure {
                    scene: self.scene,
                    pc: self.pc,
                    reason: err.to_string(),
                });
                VmEvent::ExpressionEvaluated {
                    is_assignment: false,
                    value: 0,
                }
            }
        }
    }

    /// Reduce the parsed [`ExprNode`] either through
    /// `evaluate_assignment` (when the top-level node is an
    /// assignment) or `evaluate` (when it is not). Returns
    /// `(is_assignment, value)`.
    fn eval_expression_node(
        &mut self,
        node: &ExprNode,
    ) -> Result<(bool, i32), ExpressionWrapError> {
        if let ExprNode::Assignment { .. } = node {
            let value =
                evaluate_assignment(node, &mut self.banks).map_err(ExpressionWrapError::Eval)?;
            Ok((true, value))
        } else {
            let value = evaluate(node, &self.banks).map_err(ExpressionWrapError::Eval)?;
            // Plain-expression result lands in the store register
            // per the §H VM-dispatch documentation — the store
            // register is the engine's "expression-result holder"
            // between command boundaries.
            self.banks.set_store(value as u32);
            Ok((false, value))
        }
    }

    /// Rewrite a cross-scene [`DispatchOutcome::JumpToScene`] /
    /// [`DispatchOutcome::FarCallToScene`] into a concrete
    /// [`DispatchOutcome::Jump`] / [`DispatchOutcome::FarCall`] by
    /// resolving the target scene's entrypoint against `scenes`. Every
    /// other outcome passes through unchanged.
    ///
    /// A target scene absent from the store surfaces
    /// [`VmError::SceneNotFound`]; a non-zero entrypoint the target scene
    /// does not declare surfaces [`VmError::EntrypointNotFound`]. Neither
    /// is masked with a fail-soft advance — a cross-scene gap is a real
    /// gap.
    ///
    /// # System-return sentinels
    ///
    /// Two cross-scene targets are RealLive control-flow SENTINELS rather
    /// than real content scenes, and resolve to a deterministic
    /// FALL-THROUGH (`Advance` to `post_pc`) instead of a transfer or a
    /// spurious `SceneNotFound` / `EntrypointNotFound`:
    ///
    /// - **The null scene (`scene 0`)** — RealLive scene ids are 1-based,
    ///   so scene `0` is the "no scene" sentinel. A `farcall(0, …)` /
    ///   `jump(0)` is the game's own guarded "nothing to call" path (Kanon
    ///   emits `farcall(0, 10)`); the engine takes no transfer. This is
    ///   the "absent-but-guarded" case: the guard is intrinsic (the target
    ///   is null), so the path is not taken at runtime.
    /// - **The scenario-return entrypoint (`entrypoint 99`)** — entrypoint
    ///   `99` is the last slot of the 100-slot entrypoint lattice and is
    ///   reserved as the "return to title / scenario complete" marker. A
    ///   present system scene (Sweetie's SEEN9999, which declares real
    ///   entrypoints `0..=15`) is entered at `99` only as this end idiom;
    ///   the headless model treats it as a fall-through so the scene runs
    ///   its real control flow to a natural terminus.
    ///
    /// Any OTHER absent scene (a real content scene missing from the
    /// store) or out-of-range entrypoint is a GENUINE gap and still
    /// surfaces the typed `SceneNotFound` / `EntrypointNotFound`.
    fn resolve_scene_outcome(
        &self,
        scenes: &dyn SceneStore,
        outcome: &DispatchOutcome,
        post_pc: u32,
    ) -> Result<DispatchOutcome, VmError> {
        // System-return sentinels short-circuit to a fall-through before
        // any store lookup — the transfer is not taken at runtime.
        if let DispatchOutcome::JumpToScene {
            target_scene,
            entrypoint,
        }
        | DispatchOutcome::FarCallToScene {
            target_scene,
            entrypoint,
        } = outcome
            && is_system_return_sentinel(*target_scene, *entrypoint)
        {
            return Ok(DispatchOutcome::Advance);
        }
        match outcome {
            DispatchOutcome::JumpToScene {
                target_scene,
                entrypoint,
            } => {
                let pc = self.resolve_entrypoint(scenes, *target_scene, *entrypoint)?;
                Ok(DispatchOutcome::Jump {
                    scene: *target_scene,
                    pc,
                })
            }
            DispatchOutcome::FarCallToScene {
                target_scene,
                entrypoint,
            } => {
                let pc = self.resolve_entrypoint(scenes, *target_scene, *entrypoint)?;
                Ok(DispatchOutcome::FarCall {
                    return_scene: self.scene,
                    return_pc: post_pc,
                    target_scene: *target_scene,
                    target_pc: pc,
                })
            }
            other => Ok(other.clone()),
        }
    }

    /// Resolve `(target_scene, entrypoint)` to a byte-offset pc.
    fn resolve_entrypoint(
        &self,
        scenes: &dyn SceneStore,
        target_scene: SceneId,
        entrypoint: u16,
    ) -> Result<u32, VmError> {
        let scene = scenes.fetch(target_scene).ok_or(VmError::SceneNotFound {
            scene: target_scene,
        })?;
        scene
            .entrypoint_pc(entrypoint)
            .ok_or(VmError::EntrypointNotFound {
                scene: target_scene,
                entrypoint,
            })
    }

    /// Apply a [`DispatchOutcome`] from a command-dispatch path. The
    /// `post_pc` argument is the byte offset immediately past the
    /// dispatching command — used by `Advance` / `Subroutine` /
    /// `FarCall`.
    fn apply_outcome(&mut self, outcome: &DispatchOutcome, post_pc: u32) -> Result<(), VmError> {
        match outcome {
            DispatchOutcome::Advance => {
                self.pc = post_pc;
                Ok(())
            }
            DispatchOutcome::Jump { scene, pc } => {
                self.scene = *scene;
                self.pc = *pc;
                Ok(())
            }
            DispatchOutcome::JumpToScene { .. } | DispatchOutcome::FarCallToScene { .. } => {
                // These must be resolved into Jump / FarCall against the
                // scene store by `resolve_scene_outcome` before reaching
                // here. If one arrives (e.g. via the public
                // `apply_dispatch_outcome` test seam, which has no store),
                // refuse it rather than silently mis-transferring.
                Err(VmError::UnexpectedDispatchOutcome {
                    scene: self.scene,
                    pc: self.pc,
                    expected: "resolved_jump_or_farcall",
                    found: "unresolved_cross_scene_outcome",
                })
            }
            DispatchOutcome::Subroutine {
                return_pc,
                target_scene,
                target_pc,
            } => {
                if self.stack.len() >= STACK_DEPTH_LIMIT {
                    return Err(VmError::StackOverflow {
                        scene: self.scene,
                        pc: self.pc,
                        limit: STACK_DEPTH_LIMIT,
                        kind: StackFrameKind::Subroutine.as_str(),
                    });
                }
                self.stack.push(StackFrame {
                    return_scene: None,
                    return_pc: *return_pc,
                    frame_kind: StackFrameKind::Subroutine,
                });
                self.scene = *target_scene;
                self.pc = *target_pc;
                Ok(())
            }
            DispatchOutcome::FarCall {
                return_scene,
                return_pc,
                target_scene,
                target_pc,
            } => {
                if self.stack.len() >= STACK_DEPTH_LIMIT {
                    return Err(VmError::StackOverflow {
                        scene: self.scene,
                        pc: self.pc,
                        limit: STACK_DEPTH_LIMIT,
                        kind: StackFrameKind::FarCall.as_str(),
                    });
                }
                self.stack.push(StackFrame {
                    return_scene: Some(*return_scene),
                    return_pc: *return_pc,
                    frame_kind: StackFrameKind::FarCall,
                });
                self.scene = *target_scene;
                self.pc = *target_pc;
                Ok(())
            }
            DispatchOutcome::Return => {
                let frame = self.stack.pop().ok_or(VmError::EmptyStack {
                    scene: self.scene,
                    pc: self.pc,
                    expected: "subroutine",
                })?;
                if frame.frame_kind != StackFrameKind::Subroutine {
                    return Err(VmError::FrameKindMismatch {
                        scene: self.scene,
                        pc: self.pc,
                        expected: "subroutine",
                        found: frame.frame_kind.as_str(),
                    });
                }
                self.pc = frame.return_pc;
                // Subroutine frames do not change scene.
                Ok(())
            }
            DispatchOutcome::ReturnFromCall => {
                let frame = self.stack.pop().ok_or(VmError::EmptyStack {
                    scene: self.scene,
                    pc: self.pc,
                    expected: "far_call",
                })?;
                if frame.frame_kind != StackFrameKind::FarCall {
                    return Err(VmError::FrameKindMismatch {
                        scene: self.scene,
                        pc: self.pc,
                        expected: "far_call",
                        found: frame.frame_kind.as_str(),
                    });
                }
                let return_scene = frame.return_scene.ok_or(VmError::FrameKindMismatch {
                    scene: self.scene,
                    pc: self.pc,
                    expected: "far_call_with_return_scene",
                    found: "far_call_without_return_scene",
                })?;
                self.scene = return_scene;
                self.pc = frame.return_pc;
                Ok(())
            }
            DispatchOutcome::Yield {
                longop_id,
                private_state,
            } => {
                self.longop_queue
                    .push_back(LongOp::new(*longop_id, private_state.clone()));
                self.pc = post_pc;
                Ok(())
            }
            DispatchOutcome::Halt => {
                self.halted = true;
                // pc stays put so the caller can inspect the halt site.
                Ok(())
            }
        }
    }

    /// Public helper for tests + per-module RLOperation tables that want
    /// to enqueue a longop directly. Centralised so the snapshot round
    /// trip uses the same code path as the dispatch loop.
    pub fn enqueue_longop(&mut self, longop: LongOp) {
        self.longop_queue.push_back(longop);
    }
}

/// The null-scene sentinel: RealLive scene ids are 1-based, so scene `0`
/// is "no scene". A cross-scene transfer to it is the game's own guarded
/// "nothing to call" path and takes no transfer at runtime.
pub const NULL_SCENE_SENTINEL: SceneId = 0;

/// The scenario-return entrypoint sentinel: entrypoint `99` is the last
/// slot of the 100-slot entrypoint lattice, reserved as the "return to
/// title / scenario complete" marker. A cross-scene transfer THROUGH it
/// is the end-of-scenario idiom, not a real entrypoint call.
pub const SCENARIO_RETURN_ENTRYPOINT: u16 = 99;

/// Whether a cross-scene `(target_scene, entrypoint)` is a RealLive
/// system-return SENTINEL (the null scene, or the scenario-return
/// entrypoint) rather than a real content target. Sentinels resolve to a
/// deterministic fall-through in [`Vm::resolve_scene_outcome`]; every
/// other absent scene / out-of-range entrypoint remains a typed gap.
fn is_system_return_sentinel(target_scene: SceneId, entrypoint: u16) -> bool {
    target_scene == NULL_SCENE_SENTINEL || entrypoint == SCENARIO_RETURN_ENTRYPOINT
}

/// Whether a [`DispatchOutcome`] moves the pc OFF the natural
/// fall-through by transferring control (an intra- or cross-scene jump,
/// a `gosub`, or a `farcall`) — the outcomes the deterministic
/// spin-break model may rewrite to a fall-through.
///
/// Stack-UNWINDING outcomes (`Return` / `ReturnFromCall`) are excluded:
/// rewriting a `ret` into a fall-through would leave an orphaned frame
/// on the stack and desynchronise the call depth. `Advance` / `Yield` /
/// `Halt` are not transfers.
fn outcome_is_pc_moving_transfer(outcome: &DispatchOutcome) -> bool {
    matches!(
        outcome,
        DispatchOutcome::Jump { .. }
            | DispatchOutcome::Subroutine { .. }
            | DispatchOutcome::FarCall { .. }
            | DispatchOutcome::JumpToScene { .. }
            | DispatchOutcome::FarCallToScene { .. }
    )
}

/// Internal wrapper around an `EvaluationError` so the dispatch path
/// can use `?` ergonomically. The conversion is one-way (eval-error
/// only) so the dispatch path cannot accidentally bubble a
/// `VmError::BytecodeDecode` through here.
#[derive(Debug)]
enum ExpressionWrapError {
    Eval(EvaluationError),
}

impl std::fmt::Display for ExpressionWrapError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Eval(err) => write!(formatter, "{err}"),
        }
    }
}

// ---------------------------------------------------------------------
// Substrate Inspectable / Restorable
// ---------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
struct StackFrameWire {
    frame_kind: String,
    return_pc: u32,
    return_scene: Option<SceneId>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct StackWire {
    frames: Vec<StackFrameWire>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct LongOpWire {
    id: u64,
    state_hex: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct LongOpQueueWire {
    queue: Vec<LongOpWire>,
}

fn bytes_to_hex(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        out.push(nibble_to_hex(byte >> 4));
        out.push(nibble_to_hex(byte & 0x0F));
    }
    out
}

fn hex_to_bytes(hex: &str) -> Result<Vec<u8>, String> {
    if !hex.len().is_multiple_of(2) {
        return Err("hex payload has odd length".to_string());
    }
    let bytes = hex.as_bytes();
    let mut out = Vec::with_capacity(hex.len() / 2);
    let mut i = 0;
    while i < bytes.len() {
        let hi = hex_to_nibble(bytes[i])?;
        let lo = hex_to_nibble(bytes[i + 1])?;
        out.push((hi << 4) | lo);
        i += 2;
    }
    Ok(out)
}

fn nibble_to_hex(nibble: u8) -> char {
    match nibble {
        0..=9 => (b'0' + nibble) as char,
        10..=15 => (b'a' + (nibble - 10)) as char,
        _ => '?',
    }
}

fn hex_to_nibble(byte: u8) -> Result<u8, String> {
    match byte {
        b'0'..=b'9' => Ok(byte - b'0'),
        b'a'..=b'f' => Ok(10 + (byte - b'a')),
        b'A'..=b'F' => Ok(10 + (byte - b'A')),
        _ => Err(format!("invalid hex byte 0x{byte:02x}")),
    }
}

fn encode_stack(stack: &[StackFrame]) -> Result<String, SnapshotError> {
    let wire = StackWire {
        frames: stack
            .iter()
            .map(|frame| StackFrameWire {
                frame_kind: frame.frame_kind.as_str().to_string(),
                return_pc: frame.return_pc,
                return_scene: frame.return_scene,
            })
            .collect(),
    };
    serde_json::to_string(&wire).map_err(|err| SnapshotError::SerializationFailure {
        reason: err.to_string(),
    })
}

fn decode_stack(payload: &str) -> Result<Vec<StackFrame>, String> {
    let wire: StackWire =
        serde_json::from_str(payload).map_err(|err| format!("malformed stack JSON: {err}"))?;
    wire.frames
        .into_iter()
        .map(|frame| {
            let kind = StackFrameKind::parse_wire(&frame.frame_kind)
                .ok_or_else(|| format!("unknown stack frame kind {:?}", frame.frame_kind))?;
            Ok(StackFrame {
                return_scene: frame.return_scene,
                return_pc: frame.return_pc,
                frame_kind: kind,
            })
        })
        .collect()
}

fn encode_longop_queue(queue: &VecDeque<LongOp>) -> Result<String, SnapshotError> {
    let wire = LongOpQueueWire {
        queue: queue
            .iter()
            .map(|op| LongOpWire {
                id: op.id.0,
                state_hex: bytes_to_hex(&op.private_state),
            })
            .collect(),
    };
    serde_json::to_string(&wire).map_err(|err| SnapshotError::SerializationFailure {
        reason: err.to_string(),
    })
}

fn decode_longop_queue(payload: &str) -> Result<VecDeque<LongOp>, String> {
    let wire: LongOpQueueWire = serde_json::from_str(payload)
        .map_err(|err| format!("malformed longop_queue JSON: {err}"))?;
    let mut out = VecDeque::with_capacity(wire.queue.len());
    for op in wire.queue {
        let private_state = hex_to_bytes(&op.state_hex)?;
        out.push_back(LongOp::new(LongOpId(op.id), private_state));
    }
    Ok(out)
}

impl Inspectable for Vm {
    fn inspectable_id(&self) -> &'static str {
        VM_INSPECTABLE_ID
    }

    fn inspect_state(&self) -> Result<StateTree, SnapshotError> {
        let mut tree = StateTree::new();
        tree.insert(
            StatePath::parse(MANIFEST_PATH)?,
            StateValue::String {
                value: VM_MANIFEST.to_string(),
            },
        )?;
        tree.insert(
            StatePath::parse(SCENE_PATH)?,
            StateValue::Uint {
                value: self.scene as u64,
            },
        )?;
        tree.insert(
            StatePath::parse(PC_PATH)?,
            StateValue::Uint {
                value: self.pc as u64,
            },
        )?;
        tree.insert(
            StatePath::parse(HALTED_PATH)?,
            StateValue::Bool { value: self.halted },
        )?;
        tree.insert(
            StatePath::parse(STACK_PATH)?,
            StateValue::String {
                value: encode_stack(&self.stack)?,
            },
        )?;
        tree.insert(
            StatePath::parse(LONGOP_PATH)?,
            StateValue::String {
                value: encode_longop_queue(&self.longop_queue)?,
            },
        )?;
        // Embed the var-banks substrate impl. The banks own their own
        // sub-tree under `port.var_banks.*` so we merge it here.
        let banks_tree = self.banks.inspect_state()?;
        for (path, value) in banks_tree.iter() {
            tree.insert(path.clone(), value.clone())?;
        }
        debug_assert!(MANIFEST_PATH.starts_with(NAMESPACE_ROOT));
        Ok(tree)
    }
}

impl Restorable for Vm {
    fn restore_state(&mut self, state: &StateTree) -> Result<RestoreReport, SnapshotError> {
        let mut new_scene: SceneId = self.scene;
        let mut new_pc: u32 = self.pc;
        let mut new_halted = false;
        let mut new_stack: Vec<StackFrame> = Vec::new();
        let mut new_longop_queue: VecDeque<LongOp> = VecDeque::new();
        let mut manifest_seen = false;
        let mut scene_seen = false;
        let mut pc_seen = false;
        let mut consumed = Vec::new();

        // The var-banks substrate impl is delegated below; collect a
        // sub-tree of `port.var_banks.*` paths and forward them
        // verbatim so the bank-side restore stays the single source of
        // truth.
        let mut banks_tree = StateTree::new();
        let mut banks_consumed = Vec::new();

        for (path, value) in state.iter() {
            let raw = path.as_str();
            match (raw, value) {
                (MANIFEST_PATH, StateValue::String { value }) => {
                    if value != VM_MANIFEST {
                        return Err(SnapshotError::RestoreValueOutOfRange {
                            path: path.clone(),
                            reason: format!(
                                "vm manifest mismatch: observed={value} expected={VM_MANIFEST}"
                            ),
                        });
                    }
                    manifest_seen = true;
                    consumed.push(path.clone());
                }
                (SCENE_PATH, StateValue::Uint { value }) => {
                    if *value > u16::MAX as u64 {
                        return Err(SnapshotError::RestoreValueOutOfRange {
                            path: path.clone(),
                            reason: format!("scene id {value} exceeds u16::MAX"),
                        });
                    }
                    new_scene = *value as SceneId;
                    scene_seen = true;
                    consumed.push(path.clone());
                }
                (PC_PATH, StateValue::Uint { value }) => {
                    if *value > u32::MAX as u64 {
                        return Err(SnapshotError::RestoreValueOutOfRange {
                            path: path.clone(),
                            reason: format!("pc {value} exceeds u32::MAX"),
                        });
                    }
                    new_pc = *value as u32;
                    pc_seen = true;
                    consumed.push(path.clone());
                }
                (HALTED_PATH, StateValue::Bool { value }) => {
                    new_halted = *value;
                    consumed.push(path.clone());
                }
                (STACK_PATH, StateValue::String { value }) => {
                    new_stack = decode_stack(value).map_err(|reason| {
                        SnapshotError::RestoreValueOutOfRange {
                            path: path.clone(),
                            reason,
                        }
                    })?;
                    consumed.push(path.clone());
                }
                (LONGOP_PATH, StateValue::String { value }) => {
                    new_longop_queue = decode_longop_queue(value).map_err(|reason| {
                        SnapshotError::RestoreValueOutOfRange {
                            path: path.clone(),
                            reason,
                        }
                    })?;
                    consumed.push(path.clone());
                }
                // Type-mismatch fallbacks: each sits after every typed arm so
                // the `other` binding never shadows a specific-type match.
                (SCENE_PATH | PC_PATH, other) => {
                    return Err(SnapshotError::RestoreTypeMismatch {
                        path: path.clone(),
                        expected: "uint",
                        found: other.type_tag(),
                    });
                }
                (HALTED_PATH, other) => {
                    return Err(SnapshotError::RestoreTypeMismatch {
                        path: path.clone(),
                        expected: "bool",
                        found: other.type_tag(),
                    });
                }
                (MANIFEST_PATH | STACK_PATH | LONGOP_PATH, other) => {
                    return Err(SnapshotError::RestoreTypeMismatch {
                        path: path.clone(),
                        expected: "string",
                        found: other.type_tag(),
                    });
                }
                (raw, value) if raw.starts_with("port.var_banks.") => {
                    banks_tree.insert(path.clone(), value.clone())?;
                    banks_consumed.push(path.clone());
                }
                _ => {
                    return Err(SnapshotError::RestoreStatePathUnknown { path: path.clone() });
                }
            }
        }
        if !manifest_seen {
            return Err(SnapshotError::RestoreValueOutOfRange {
                path: StatePath::parse(MANIFEST_PATH)?,
                reason: "vm manifest entry missing from snapshot".to_string(),
            });
        }
        if !scene_seen {
            return Err(SnapshotError::RestoreValueOutOfRange {
                path: StatePath::parse(SCENE_PATH)?,
                reason: "vm scene entry missing from snapshot".to_string(),
            });
        }
        if !pc_seen {
            return Err(SnapshotError::RestoreValueOutOfRange {
                path: StatePath::parse(PC_PATH)?,
                reason: "vm pc entry missing from snapshot".to_string(),
            });
        }

        let banks_report = self.banks.restore_state(&banks_tree)?;
        consumed.extend(banks_report.consumed_paths);

        self.scene = new_scene;
        self.pc = new_pc;
        self.halted = new_halted;
        self.stack = new_stack;
        self.longop_queue = new_longop_queue;
        Ok(RestoreReport {
            consumed_paths: consumed,
            ignored_by_design: banks_report.ignored_by_design,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::bytecode_element::decode_bytecode_stream;
    use crate::rlop::NeverReadyScheduler;

    fn build_scene(id: SceneId, bytes: &[u8]) -> Scene {
        let elements = decode_bytecode_stream(bytes).expect("decode test scene");
        Scene::new(id, elements).expect("non-empty scene")
    }

    /// Encode an int-literal expression value (`$ FF <i32 LE>`).
    fn int_literal_bytes(value: i32) -> Vec<u8> {
        let mut b = vec![0x24, 0xFF];
        b.extend_from_slice(&value.to_le_bytes());
        b
    }

    /// Encode a single `goto(target_pc)` command (module 0/1, opcode 0).
    /// Real `goto` framing per rlvm `bytecode.cc`: the 8-byte header is
    /// followed by ONE trailing `i32 LE` jump-target pointer — NOT a
    /// `(...)` argument list. The decoder frames the pointer into
    /// `Command::goto_targets`; the VM appends it as the sole `Int` arg
    /// so `GotoOp` jumps to it.
    fn goto_command(target_pc: i32) -> Vec<u8> {
        let mut b = vec![0x23, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00];
        b.extend_from_slice(&target_pc.to_le_bytes());
        b
    }

    /// Encode a `farcall(return_scene, return_pc, target_scene,
    /// target_pc)` command (module 0/1, opcode 0x0020) with four
    /// int-literal arguments.
    fn farcall_command(rs: i32, rp: i32, ts: i32, tp: i32) -> Vec<u8> {
        let mut b = vec![0x23, 0x00, 0x01, 0x20, 0x00, 0x04, 0x00, 0x00, b'('];
        for (idx, value) in [rs, rp, ts, tp].iter().enumerate() {
            if idx > 0 {
                b.push(b',');
            }
            b.extend_from_slice(&int_literal_bytes(*value));
        }
        b.push(b')');
        b
    }

    #[test]
    fn scene_entrypoint_pc_resolves_markers_and_defaults_zero() {
        // A goto (12 bytes) at offset 0, then a MetaEntrypoint `!4` marker
        // (`0x21 <idx u16>`) at offset 12.
        let mut bytes = goto_command(12);
        bytes.extend_from_slice(&[0x21, 0x04, 0x00]);
        let scene = build_scene(1, &bytes);
        // Non-zero entrypoint resolves through the marker map.
        assert_eq!(scene.entrypoint_pc(4), Some(12));
        // Entrypoint 0 defaults to the scene start even with no marker.
        assert_eq!(scene.entrypoint_pc(0), Some(0));
        // An undeclared entrypoint is None (VM surfaces EntrypointNotFound).
        assert_eq!(scene.entrypoint_pc(9), None);
    }

    #[test]
    fn cross_scene_sentinels_fall_through_but_real_gaps_surface() {
        // Scene 7 present: a `goto` (12 bytes) then a MetaEntrypoint `!5`
        // marker at offset 12 — so entrypoints 0 (start) and 5 resolve.
        let mut store = InMemorySceneStore::new();
        let mut bytes = goto_command(12);
        bytes.extend_from_slice(&[0x21, 0x05, 0x00]);
        store.insert(build_scene(7, &bytes));
        let vm = Vm::new(7, 0);

        // Null-scene sentinel (scene 0): a farcall / jump to it is the
        // game's guarded "nothing to call" path — resolves to a
        // fall-through Advance, NOT a transfer, NOT a SceneNotFound.
        for outcome in [
            DispatchOutcome::FarCallToScene {
                target_scene: NULL_SCENE_SENTINEL,
                entrypoint: 10,
            },
            DispatchOutcome::JumpToScene {
                target_scene: NULL_SCENE_SENTINEL,
                entrypoint: 0,
            },
        ] {
            assert_eq!(
                vm.resolve_scene_outcome(&store, &outcome, 99).unwrap(),
                DispatchOutcome::Advance,
            );
        }

        // Scenario-return entrypoint 99 of a PRESENT scene: the end idiom —
        // falls through rather than surfacing EntrypointNotFound.
        assert_eq!(
            vm.resolve_scene_outcome(
                &store,
                &DispatchOutcome::FarCallToScene {
                    target_scene: 7,
                    entrypoint: SCENARIO_RETURN_ENTRYPOINT,
                },
                99,
            )
            .unwrap(),
            DispatchOutcome::Advance,
        );

        // A genuinely-taken transfer to an ABSENT (non-sentinel) scene
        // STILL surfaces a typed SceneNotFound — real gaps are not masked.
        assert!(matches!(
            vm.resolve_scene_outcome(
                &store,
                &DispatchOutcome::FarCallToScene {
                    target_scene: 5,
                    entrypoint: 0,
                },
                99,
            ),
            Err(VmError::SceneNotFound { scene: 5 }),
        ));

        // A present scene with a MISSING non-sentinel entrypoint STILL
        // surfaces EntrypointNotFound.
        assert!(matches!(
            vm.resolve_scene_outcome(
                &store,
                &DispatchOutcome::JumpToScene {
                    target_scene: 7,
                    entrypoint: 8,
                },
                99,
            ),
            Err(VmError::EntrypointNotFound {
                scene: 7,
                entrypoint: 8
            }),
        ));
    }

    #[test]
    fn step_dispatches_goto_with_real_args_and_jumps_to_target() {
        // Regression (audit-3): the integration dispatch path passed
        // `op.dispatch(self, &[])`, so `goto` got an empty arg slice and
        // fell through (warn-and-advance) instead of jumping. With the
        // real-arg wiring the decoded target must take effect: stepping a
        // `goto 100` command (which itself occupies bytes 0..16) must
        // move pc to 100, NOT to the linear post-command byte 16.
        let mut store = InMemorySceneStore::new();
        store.insert(build_scene(1, &goto_command(100)));
        let mut registry = RlopRegistry::new();
        crate::rlop::module_ctrl::register_control_flow_rlops(&mut registry);
        let mut scheduler = NeverReadyScheduler;
        let mut vm = Vm::new(1, 0);

        let outcome = vm.step(&store, &registry, &mut scheduler).expect("step");
        assert!(matches!(
            outcome,
            StepOutcome::Advanced {
                event: VmEvent::CommandDispatched { .. }
            }
        ));
        assert_eq!(
            vm.pc(),
            100,
            "goto must jump to its decoded target, not fall through to post_pc"
        );
        assert_ne!(vm.pc(), 16, "pc must NOT be the linear post-command byte");
        assert!(
            vm.warnings().is_empty(),
            "goto with a valid int arg must not warn: {:?}",
            vm.warnings()
        );
    }

    #[test]
    fn step_dispatches_farcall_with_real_args_and_pushes_frame() {
        // Companion control-flow proof: `farcall` needs four decoded args
        // (return_scene, return_pc, target_scene, target_pc). With the
        // empty-slice bug it warn-and-advanced; now it must cross to the
        // target scene/pc and push a far-call frame.
        let mut store = InMemorySceneStore::new();
        store.insert(build_scene(1, &farcall_command(1, 37, 2, 50)));
        let mut registry = RlopRegistry::new();
        crate::rlop::module_ctrl::register_control_flow_rlops(&mut registry);
        let mut scheduler = NeverReadyScheduler;
        let mut vm = Vm::new(1, 0);

        vm.step(&store, &registry, &mut scheduler).expect("step");
        assert_eq!(vm.scene(), 2, "farcall must cross to the target scene");
        assert_eq!(vm.pc(), 50, "farcall must land on the target pc");
        assert_eq!(vm.stack().len(), 1, "farcall must push exactly one frame");
        assert!(
            vm.warnings().is_empty(),
            "farcall with valid int args must not warn: {:?}",
            vm.warnings()
        );
    }

    #[test]
    fn new_vm_has_empty_stack_and_queue() {
        let vm = Vm::new(1, 0);
        assert_eq!(vm.scene(), 1);
        assert_eq!(vm.pc(), 0);
        assert!(vm.stack().is_empty());
        assert!(vm.longop_queue().is_empty());
        assert!(!vm.is_halted());
    }

    #[test]
    fn step_on_meta_line_advances_pc_by_three_bytes() {
        // 0x0A 0x07 0x00 = MetaLine(line_number=7), 3 bytes.
        let bytes = [0x0A, 0x07, 0x00];
        let scene = build_scene(1, &bytes);
        let mut store = InMemorySceneStore::new();
        store.insert(scene);
        let registry = RlopRegistry::new();
        let mut scheduler = NeverReadyScheduler;
        let mut vm = Vm::new(1, 0);
        let outcome = vm.step(&store, &registry, &mut scheduler).expect("step");
        match outcome {
            StepOutcome::Advanced {
                event: VmEvent::Advanced { element },
            } => assert_eq!(element, "meta_line"),
            other => panic!("expected Advanced(meta_line), got {other:?}"),
        }
        assert_eq!(vm.pc(), 3);
    }

    #[test]
    fn end_of_scene_outcome_does_not_panic() {
        let bytes = [0x0A, 0x07, 0x00];
        let scene = build_scene(1, &bytes);
        let mut store = InMemorySceneStore::new();
        store.insert(scene);
        let registry = RlopRegistry::new();
        let mut scheduler = NeverReadyScheduler;
        let mut vm = Vm::new(1, 0);
        let _first = vm.step(&store, &registry, &mut scheduler).expect("step 1");
        let second = vm.step(&store, &registry, &mut scheduler).expect("step 2");
        assert!(matches!(second, StepOutcome::EndOfScene { scene: 1 }));
    }

    #[test]
    fn unaligned_pc_returns_typed_error() {
        // 3-byte MetaLine — a pc of 1 lands in the middle of it.
        let bytes = [0x0A, 0x07, 0x00];
        let scene = build_scene(1, &bytes);
        let mut store = InMemorySceneStore::new();
        store.insert(scene);
        let registry = RlopRegistry::new();
        let mut scheduler = NeverReadyScheduler;
        let mut vm = Vm::new(1, 1);
        match vm.step(&store, &registry, &mut scheduler) {
            Err(VmError::UnalignedPc {
                scene: 1, pc: 1, ..
            }) => {}
            other => panic!("expected UnalignedPc, got {other:?}"),
        }
    }

    #[test]
    fn missing_scene_returns_typed_error() {
        let store = InMemorySceneStore::new();
        let registry = RlopRegistry::new();
        let mut scheduler = NeverReadyScheduler;
        let mut vm = Vm::new(1, 0);
        match vm.step(&store, &registry, &mut scheduler) {
            Err(VmError::SceneNotFound { scene: 1 }) => {}
            other => panic!("expected SceneNotFound, got {other:?}"),
        }
    }

    #[test]
    fn stack_frame_kind_round_trips_through_wire_form() {
        for kind in [StackFrameKind::Subroutine, StackFrameKind::FarCall] {
            assert_eq!(StackFrameKind::parse_wire(kind.as_str()), Some(kind));
        }
        assert!(StackFrameKind::parse_wire("nonsense").is_none());
    }

    #[test]
    fn empty_vm_snapshots_with_substrate_inspectable() {
        let vm = Vm::new(0, 0);
        let tree = vm.inspect_state().expect("inspect");
        assert!(tree.len() >= 6); // manifest + scene + pc + halted + stack + longop + var-banks manifest + store
        let manifest_path = StatePath::parse(MANIFEST_PATH).expect("path");
        match tree.get(&manifest_path).expect("manifest entry") {
            StateValue::String { value } => assert_eq!(value, VM_MANIFEST),
            other => panic!("manifest must be a string, got {other:?}"),
        }
    }

    #[test]
    fn hex_round_trip_helper() {
        let bytes = vec![0xDE, 0xAD, 0xBE, 0xEF];
        let hex = bytes_to_hex(&bytes);
        assert_eq!(hex, "deadbeef");
        let back = hex_to_bytes(&hex).expect("decode");
        assert_eq!(back, bytes);
    }
}
