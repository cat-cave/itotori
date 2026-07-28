use std::collections::{BTreeMap, VecDeque};

use serde::{Deserialize, Serialize};

use crate::bytecode_element::{
    BytecodeDecodeError, BytecodeElement, CommandArgShape, decode_command_arg_values,
    extract_select_choice_texts,
};
use crate::expression::{
    ExprNode, ExpressionWarning, parse_expression, parse_expression_with_warnings,
};
use crate::expression_eval::{EvaluationError, evaluate, evaluate_assignment};
use crate::rlop::{
    DispatchOutcome, ExprValue, LongOp, LongOpId, LongOpReadiness, LongOpScheduler,
    RlopImplementationProvenance, RlopKey, RlopRegistry,
};
use crate::var_banks::VarBanks;

pub use diagnostics::{StepManyOutcome, StepOutcome, VmError, VmEvent, VmWarning};
pub use substrate::VM_INSPECTABLE_ID;

/// Scene id (`u16`). Matches the on-disk scene-directory slot index
/// produced by [`crate::RealSceneEntry`].
pub type SceneId = u16;

/// Default budget ceiling for [`Vm::step_many`]. Pinned so a caller
/// that forgets to pass an explicit budget cannot accidentally execute
/// an infinite `goto +0` loop without a terminator.
pub const DEFAULT_STEP_BUDGET: u32 = 100_000;

/// Hard ceiling on the call-stack depth. Pinned at the rlvm-documented
/// 1024 frames so a runaway `gosub`/`farcall` chain produces a typed
/// [`VmError::StackOverflow`] instead of an unbounded `Vec` growth.
/// Acceptance criterion #4 in — exercised by the
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
    /// invariant).
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
    /// matches the RealLive convention that a bare `farcall(scene)`
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
#[derive(Debug, Default, Clone)]
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

/// The RealLive bytecode VM.
///
/// Owns the active scene/pc, the call stack, the typed variable banks
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
    /// Normal-layer `module_sys` frame counters.  The headless VM advances
    /// their deterministic millisecond clock once after each `ReadFrames`
    /// pass, preserving the oracle's initial read while allowing a polled
    /// frame loop to evolve instead of being misclassified as a spin.
    frame_counters: BTreeMap<i32, FrameCounterState>,
    /// Byte offset immediately past the command currently being
    /// dispatched. Set transiently by [`Vm::dispatch_element`] before an
    /// op's `dispatch`, so a control-flow op (`gosub` / `farcall`) can
    /// read the return pc it must push without the VM having to prepend
    /// it as a synthetic argument. Not part of the substrate snapshot —
    /// it is only meaningful mid-step and defaults to `0` at every tick
    /// boundary.
    post_pc: u32,
    /// One-shot deterministic spin-break request. When `true`, the NEXT
    /// executed control-transfer command (goto / goto_if / goto_on
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

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub(crate) struct FrameCounterState {
    pub(crate) min: i32,
    pub(crate) max: i32,
    pub(crate) duration_ms: u32,
    pub(crate) elapsed_ms: u32,
    pub(crate) active: bool,
}
