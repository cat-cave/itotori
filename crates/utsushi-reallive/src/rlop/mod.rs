//! UTSUSHI-208 — `RLOperation` trait, dispatch outcomes, and the
//! registry / longop-scheduler seam.
//!
//! Per-module RLOperation tables (the actual text / control-flow / sys
//! operations) land in UTSUSHI-209 and UTSUSHI-210. This module hosts
//! both the trait substrate (defined here) and the per-module submodules
//! that register concrete ops:
//!
//! - [`longops`] — typed long-op implementors (selection runtime, …).
//! - [`module_ctrl`] — UTSUSHI-210 control-flow family
//!   (`goto`/`gosub`/`farcall`/`ret`/`rtl`/`select`/`halt`).
//!
//! # Public surface
//!
//! - [`RLOperation`] — object-safe trait with a single
//!   [`RLOperation::dispatch`] method.
//! - [`DispatchOutcome`] — typed enum every dispatch must return.
//!   Variants cover plain advance, intra-scene jump, subroutine,
//!   cross-scene far-call, paired returns, longop yield, and a hard
//!   halt.
//! - [`ExprValue`] — engine-neutral value carried as a dispatch arg.
//! - [`RlopRegistry`] — `(module_type, module_id, opcode)` →
//!   `Arc<dyn RLOperation>` lookup. Missing entries surface as a
//!   fail-soft warning at the VM level (`MissingRlop`), not a panic.
//! - [`LongOp`] / [`LongOpScheduler`] — the suspended-longop queue
//!   substrate. The trait is test-controlled so synthetic tests can
//!   gate when a queued longop is "ready to continue" without
//!   real-clock dependencies.
//!
//! # Substrate-honesty posture
//!
//! Every fail-soft surface (missing rlop, longop still pending) is a
//! typed signal — never `unwrap()`, never `Ok(())` after a silent skip.
//! See `crates/utsushi-reallive/src/vm.rs` for the dispatch loop that
//! consumes these types.

use std::collections::BTreeMap;
use std::fmt;
use std::sync::Arc;

use serde::{Deserialize, Serialize};

use crate::vm::{SceneId, Vm};

// UTSUSHI-209 / UTSUSHI-210 / UTSUSHI-211 / UTSUSHI-212: per-module
// RLOperation tables. The text/messaging family lives in
// [`module_msg`]; the control-flow family in [`module_ctrl`]; the
// choice (`select` / `select_s` / `select_w` / `select_objbtn`) family
// in [`module_sel`]; the typed `LongOp` shapes (`pause`, `select`)
// live in [`longops`]. UTSUSHI-212 adds the string / memory /
// system-arithmetic families in [`module_str`], [`module_mem`], and
// [`module_sys`].
pub mod longops;
pub mod module_audio;
pub mod module_catalog;
pub mod module_ctrl;
pub mod module_grp;
pub mod module_mem;
pub mod module_msg;
pub mod module_obj;
pub mod module_sel;
pub mod module_str;
pub mod module_sys;

pub use longops::{
    DEFAULT_PAUSE_POLLS, HeadlessChoicePolicy, HeadlessInputScheduler, PAUSE_PRIVATE_STATE_MAGIC,
    PauseLongOp, PauseLongOpDecodeError, SELECT_PRIVATE_STATE_MAGIC, SelectLongOp,
    SelectLongOpDecodeError, SelectionChoiceCountScheduler,
};
pub use module_msg::{
    LongOpIdSequence, MSG_MODULE_ID, MSG_MODULE_TYPE, MsgFontColorOp, MsgFontSizeOp,
    MsgLineBreakOp, MsgLineNumberOp, MsgMsgClearOp, MsgMsgHideOp, MsgNameCloseOp, MsgNameOpenOp,
    MsgOpcode, MsgPageOp, MsgParagraphBreakOp, MsgPauseOp, MsgRuntime, MsgRuntimeWarning,
    MsgTextWindowOp, OPCODE_FONT_COLOR, OPCODE_FONT_SIZE, OPCODE_LINE_BREAK, OPCODE_LINE_NUMBER,
    OPCODE_MSG_CLEAR, OPCODE_MSG_HIDE, OPCODE_NAME_CLOSE, OPCODE_NAME_OPEN, OPCODE_PAGE,
    OPCODE_PARAGRAPH_BREAK, OPCODE_PAUSE, OPCODE_TEXT_OUT, OPCODE_TEXT_WINDOW, dispatch_textout,
    register_text_rlops, text_module_msg_keys,
};
pub use module_sel::{
    ChoiceInputScheduler, OPCODE_OBJBTN_INIT, OPCODE_SELECT as SEL_OPCODE_SELECT,
    OPCODE_SELECT_OBJBTN, OPCODE_SELECT_OBJBTN_CANCEL, OPCODE_SELECT_S, OPCODE_SELECT_W,
    ObjbtnInitOp, SEL_MODULE_ID, SEL_MODULE_TYPE, SEL_RLOP_COUNT, SelRuntime, SelRuntimeWarning,
    SelectModality, SelectObjbtnOp, SelectOp, SelectSOp, SelectVariant, SelectWOp,
    SelectionControlSignal, register_sel_rlops, select_modality, selection_control_signal,
};

/// Engine-neutral dispatch argument. The UTSUSHI-205 evaluator returns
/// `i32`, so the integer variant is `i32` for that path; the byte-string
/// variant carries raw Shift-JIS bytes (no UTF-8 lossy conversion) so a
/// future textout/string op can consume them verbatim.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum ExprValue {
    /// Signed 32-bit integer (matches `evaluate` / `evaluate_assignment`).
    Int(i32),
    /// Raw byte string. Used by UTSUSHI-209/210 when a string-shaped
    /// argument flows into a dispatch.
    Bytes(Vec<u8>),
}

impl ExprValue {
    /// Convenience accessor — returns the int payload or `None`.
    pub fn as_int(&self) -> Option<i32> {
        match self {
            Self::Int(value) => Some(*value),
            Self::Bytes(_) => None,
        }
    }

    /// Convenience accessor — returns the bytes payload or `None`.
    pub fn as_bytes(&self) -> Option<&[u8]> {
        match self {
            Self::Bytes(bytes) => Some(bytes.as_slice()),
            Self::Int(_) => None,
        }
    }
}

/// Stable identifier for a queued longop. Generated by the dispatcher;
/// the VM threads it through the suspend / resume round trip so a
/// snapshot at the suspend point names the same longop on restore.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
pub struct LongOpId(pub u64);

impl fmt::Display for LongOpId {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "longop:{:016x}", self.0)
    }
}

/// Typed outcome returned by every [`RLOperation::dispatch`] call.
///
/// The VM's `step()` consumes this enum to decide pc / scene / stack
/// transitions. Every control-flow shape RealLive uses is a named
/// variant — there is no `Other(String)` fallback.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum DispatchOutcome {
    /// Advance the pc past the dispatching command. The default outcome
    /// for ops that have no control-flow effect.
    Advance,
    /// Intra-scene jump: rewrite pc, leave the stack untouched. Used by
    /// `goto`.
    Jump {
        /// Destination scene id. Equal to the current scene for an
        /// intra-scene jump; differs for a cross-scene jump (rare —
        /// `goto` is intra-scene in the RealLive op tables).
        scene: SceneId,
        /// Destination pc within `scene`.
        pc: u32,
    },
    /// Push a subroutine frame and jump. Used by `gosub`. The frame
    /// records the post-`gosub` byte (`return_pc`) within the same
    /// scene, and `ret` pops it.
    Subroutine {
        /// pc to return to (post-`gosub` byte).
        return_pc: u32,
        /// Target scene id (typically the current scene; the spec
        /// records a `target_scene` for symmetry with the cross-scene
        /// far-call shape).
        target_scene: SceneId,
        /// pc to begin executing at the subroutine target.
        target_pc: u32,
    },
    /// Push a cross-scene frame and jump. Used by `farcall`. The frame
    /// records both the calling scene and the post-`farcall` byte;
    /// `rtl` pops it and returns to that exact byte.
    FarCall {
        /// Scene to return to (the calling scene).
        return_scene: SceneId,
        /// pc to return to within `return_scene` (post-`farcall` byte).
        return_pc: u32,
        /// Target scene id.
        target_scene: SceneId,
        /// pc to begin executing at the target scene.
        target_pc: u32,
    },
    /// Cross-scene jump addressed by `(scene, entrypoint)` rather than by
    /// a resolved pc. Used by the real branch-following `jump` op, whose
    /// target pc lives in ANOTHER scene and can only be resolved against
    /// the [`crate::vm::SceneStore`] (which the op layer cannot see). The
    /// VM resolves `entrypoint` to a byte-offset pc via
    /// [`crate::vm::Scene::entrypoint_pc`] and rewrites this into a plain
    /// [`DispatchOutcome::Jump`] before applying it — a missing scene
    /// surfaces a typed [`crate::vm::VmError::SceneNotFound`], a missing
    /// entrypoint a [`crate::vm::VmError::EntrypointNotFound`].
    JumpToScene {
        /// Destination scene id.
        target_scene: SceneId,
        /// Entrypoint index within `target_scene` (`0` = scene start).
        entrypoint: u16,
    },
    /// Cross-scene subroutine call addressed by `(scene, entrypoint)`.
    /// Used by the real branch-following `farcall` / `farcall_with` ops.
    /// The VM captures the current `(scene, post_pc)` as the return frame
    /// and resolves `entrypoint` to a byte-offset pc in `target_scene`
    /// before pushing a far-call frame and jumping. `rtl` pops it.
    FarCallToScene {
        /// Destination scene id.
        target_scene: SceneId,
        /// Entrypoint index within `target_scene` (`0` = scene start).
        entrypoint: u16,
    },
    /// Pop a subroutine frame and resume at its `return_pc`. Used by
    /// `ret`. The VM produces a typed `VmError::EmptyStack` if the
    /// stack is empty.
    Return,
    /// Pop a far-call frame and resume at its `return_scene` /
    /// `return_pc`. Used by `rtl`. Produces a typed `VmError::EmptyStack`
    /// on an empty stack.
    ReturnFromCall,
    /// Suspend the VM with a queued longop. The VM enqueues the longop
    /// with the supplied private state and pc-advances past the
    /// dispatching command — the next `step()` will resume from the
    /// queue head (subject to the [`LongOpScheduler`]).
    Yield {
        /// Stable longop id. Threaded through the snapshot round trip.
        longop_id: LongOpId,
        /// Private state the longop carries between resumes. Bytes are
        /// opaque to the VM; serialized verbatim into the substrate
        /// `Inspectable` surface.
        private_state: Vec<u8>,
    },
    /// Hard halt. The VM's `step()` returns `StepOutcome::Halted` and
    /// will not advance further until the caller resets it.
    Halt,
}

/// Object-safe trait every per-module RLOperation table implements.
///
/// The trait is intentionally small: dispatch consumes a `&mut Vm` so
/// the op can mutate banks / store register through the VM's accessors,
/// and an arg slice. UTSUSHI-209 / UTSUSHI-210 will provide concrete
/// implementors; this crate only ships the trait + the dispatch loop.
pub trait RLOperation: Send + Sync {
    /// Dispatch this RLOperation with the supplied argument values.
    /// Returns the typed [`DispatchOutcome`] the VM acts on.
    fn dispatch(&self, vm: &mut Vm, args: &[ExprValue]) -> DispatchOutcome;
}

/// Composite key for the RLOperation registry: `(module_type, module_id,
/// opcode)`. Matches the three fields the bytecode `Command` element
/// exposes; overload is not part of the key today because the rlvm
/// research anchor documents overload selection happening inside the
/// per-opcode implementation, not at the dispatch-table layer.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct RlopKey {
    /// Module type lattice id (byte 1 of the Command header).
    pub module_type: u8,
    /// Module id (byte 2 of the Command header).
    pub module_id: u8,
    /// Opcode (bytes 3..5 of the Command header, u16 LE).
    pub opcode: u16,
}

impl RlopKey {
    /// Construct an [`RlopKey`] from the three Command-header fields.
    pub const fn new(module_type: u8, module_id: u8, opcode: u16) -> Self {
        Self {
            module_type,
            module_id,
            opcode,
        }
    }
}

impl fmt::Display for RlopKey {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            formatter,
            "rlop[{:02x}/{:02x}/{:04x}]",
            self.module_type, self.module_id, self.opcode
        )
    }
}

/// Registry mapping `(module_type, module_id, opcode)` to an
/// [`RLOperation`] implementor.
///
/// The registry is **fail-soft**: a missing key surfaces as a
/// [`crate::vm::VmWarning::MissingRlop`] at the VM level and the VM
/// advances past the command. Per the UTSUSHI-208 spec node this is
/// intentional — the alpha-tier opcode coverage frontier is the gating
/// criterion, not the all-opcodes-implemented bar.
#[derive(Default, Clone)]
pub struct RlopRegistry {
    entries: BTreeMap<RlopKey, Arc<dyn RLOperation>>,
}

impl fmt::Debug for RlopRegistry {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("RlopRegistry")
            .field("entry_count", &self.entries.len())
            .finish()
    }
}

impl RlopRegistry {
    /// Construct an empty registry. The alpha-tier per-module tables
    /// (UTSUSHI-209 / UTSUSHI-210) will register their ops here.
    pub fn new() -> Self {
        Self::default()
    }

    /// Register an [`RLOperation`] under `key`.
    ///
    /// # Duplicate-key guard
    ///
    /// Registration is **displacement-free**: every stored op is
    /// non-`None`, so a `key` that is already present would clobber a
    /// live op. That is always a registrar bug (two families claiming the
    /// same `(module_type, module_id, opcode)` — e.g. the historical
    /// `msg.pause` / `sel.select_objbtn` collision at `(1, 5, 3)` caused
    /// by mislabelled `module_id`s), so it **panics** rather than
    /// silently overwriting. This turns any future key collision into a
    /// loud failure at registration/test time instead of a silent
    /// mis-dispatch at runtime.
    ///
    /// Gap-fill callers (e.g. [`crate::rlop::module_catalog`]) must guard
    /// with [`Self::get`] `.is_none()` before registering; they do.
    ///
    /// Returns `None` (there is never a displaced op to return); the
    /// return type is retained so callers can still `assert!(… .is_none())`.
    pub fn register(
        &mut self,
        key: RlopKey,
        op: Arc<dyn RLOperation>,
    ) -> Option<Arc<dyn RLOperation>> {
        assert!(
            !self.entries.contains_key(&key),
            "RlopRegistry key collision: {key} is already registered; a second registrar would \
             displace a live op (this is the class of bug the mislabelled-module_id `(1, 5, 3)` \
             msg.pause/sel.select_objbtn collision was — fix the offending module_id/opcode)"
        );
        self.entries.insert(key, op)
    }

    /// Look up an op by `key`. Returns `None` for a missing entry; the
    /// VM converts the miss into a fail-soft warning.
    pub fn get(&self, key: RlopKey) -> Option<Arc<dyn RLOperation>> {
        self.entries.get(&key).cloned()
    }

    /// Number of registered ops. Pinned so audit tooling can assert
    /// "registry size matches the expected per-module union" without
    /// reaching into the private map.
    pub fn len(&self) -> usize {
        self.entries.len()
    }

    /// Whether the registry has zero entries.
    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }
}

/// Queued longop. The VM owns the queue; the dispatcher returns one of
/// these inside a [`DispatchOutcome::Yield`] and the VM threads the
/// `private_state` through the snapshot round trip.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LongOp {
    /// Stable identifier for the queued longop.
    pub id: LongOpId,
    /// Opaque private state the longop carries between resumes. Bytes
    /// are serialized verbatim into the substrate `Inspectable`
    /// surface.
    pub private_state: Vec<u8>,
}

impl LongOp {
    /// Construct a queued longop record.
    pub fn new(id: LongOpId, private_state: Vec<u8>) -> Self {
        Self { id, private_state }
    }
}

/// The decision a [`LongOpScheduler`] makes about the queue head when
/// the VM is about to step.
///
/// Test fixtures implement [`LongOpScheduler`] so a synthetic `pause`
/// longop can be observed as suspended on one step and ready to resume
/// on the next, without a wall-clock dependency.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LongOpReadiness {
    /// The longop at the queue head is ready to continue. The VM
    /// consumes it (pops the queue) on this step.
    Ready,
    /// The longop at the queue head is still pending. The VM emits a
    /// `Suspended` step outcome and does not advance the pc.
    Pending,
}

/// Trait the VM consults before each step to decide whether the queued
/// longop should resume now. The default `NeverReady` impl keeps a
/// longop suspended indefinitely — useful for the "snapshot at suspend
/// point" round trip test.
///
/// Schedulers receive `&mut LongOp` so an input-driven scheduler can
/// commit a typed resume payload (e.g. the chosen index for a select
/// longop) into the head's private state before signalling `Ready`.
/// Schedulers that don't need to mutate the head simply ignore the
/// mutable reference — see [`NeverReadyScheduler`] /
/// [`AlwaysReadyScheduler`].
pub trait LongOpScheduler: Send + Sync {
    /// Inspect the queue head and report whether it should resume.
    fn poll(&mut self, head: &mut LongOp) -> LongOpReadiness;
}

/// Scheduler that never resumes a queued longop. Used as the default
/// when callers don't supply a scheduler — keeps the VM in a Suspended
/// state until a snapshot / restore replaces the scheduler.
#[derive(Debug, Default, Clone, Copy)]
pub struct NeverReadyScheduler;

impl LongOpScheduler for NeverReadyScheduler {
    fn poll(&mut self, _head: &mut LongOp) -> LongOpReadiness {
        LongOpReadiness::Pending
    }
}

/// Scheduler that always resumes a queued longop immediately. Used by
/// tests that want to verify the resume path through the queue.
#[derive(Debug, Default, Clone, Copy)]
pub struct AlwaysReadyScheduler;

impl LongOpScheduler for AlwaysReadyScheduler {
    fn poll(&mut self, _head: &mut LongOp) -> LongOpReadiness {
        LongOpReadiness::Ready
    }
}

/// Scheduler that resumes the queued longop after a fixed number of
/// polls have observed it as pending. Used by tests that want to
/// observe the suspended → ready transition without a wall clock.
#[derive(Debug, Clone)]
pub struct AfterNPollsScheduler {
    /// Number of additional `Pending` polls before the head becomes
    /// `Ready`. Reaches zero monotonically.
    pub polls_remaining: u32,
}

impl AfterNPollsScheduler {
    /// Build a scheduler that returns `Pending` `polls` times and then
    /// `Ready` thereafter.
    pub fn new(polls: u32) -> Self {
        Self {
            polls_remaining: polls,
        }
    }
}

impl LongOpScheduler for AfterNPollsScheduler {
    fn poll(&mut self, _head: &mut LongOp) -> LongOpReadiness {
        if self.polls_remaining == 0 {
            LongOpReadiness::Ready
        } else {
            self.polls_remaining -= 1;
            LongOpReadiness::Pending
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct AdvanceOp;
    impl RLOperation for AdvanceOp {
        fn dispatch(&self, _vm: &mut Vm, _args: &[ExprValue]) -> DispatchOutcome {
            DispatchOutcome::Advance
        }
    }

    #[test]
    fn registry_register_then_get_round_trips() {
        let mut registry = RlopRegistry::new();
        let key = RlopKey::new(0x01, 0x02, 0x0010);
        assert!(registry.is_empty());
        let prior = registry.register(key, Arc::new(AdvanceOp));
        assert!(prior.is_none());
        assert_eq!(registry.len(), 1);
        let op = registry.get(key).expect("registered op resolves");
        // dispatch must compile through the dyn trait pointer.
        let _ = op;
    }

    #[test]
    fn missing_key_lookup_returns_none_not_panic() {
        let registry = RlopRegistry::new();
        assert!(registry.get(RlopKey::new(0, 0, 0)).is_none());
    }

    #[test]
    fn never_ready_scheduler_keeps_longop_pending() {
        let mut scheduler = NeverReadyScheduler;
        let mut op = LongOp::new(LongOpId(1), vec![]);
        assert_eq!(scheduler.poll(&mut op), LongOpReadiness::Pending);
        assert_eq!(scheduler.poll(&mut op), LongOpReadiness::Pending);
    }

    #[test]
    fn always_ready_scheduler_consumes_longop_immediately() {
        let mut scheduler = AlwaysReadyScheduler;
        let mut op = LongOp::new(LongOpId(1), vec![]);
        assert_eq!(scheduler.poll(&mut op), LongOpReadiness::Ready);
    }

    #[test]
    fn after_n_polls_scheduler_observes_pending_then_ready() {
        let mut scheduler = AfterNPollsScheduler::new(2);
        let mut op = LongOp::new(LongOpId(1), vec![]);
        assert_eq!(scheduler.poll(&mut op), LongOpReadiness::Pending);
        assert_eq!(scheduler.poll(&mut op), LongOpReadiness::Pending);
        assert_eq!(scheduler.poll(&mut op), LongOpReadiness::Ready);
        assert_eq!(scheduler.poll(&mut op), LongOpReadiness::Ready);
    }

    #[test]
    fn expr_value_accessors_round_trip() {
        let int_val = ExprValue::Int(42);
        let bytes_val = ExprValue::Bytes(vec![0x82, 0xa0]);
        assert_eq!(int_val.as_int(), Some(42));
        assert!(int_val.as_bytes().is_none());
        assert!(bytes_val.as_int().is_none());
        assert_eq!(bytes_val.as_bytes(), Some(&[0x82, 0xa0][..]));
    }

    #[test]
    fn longop_id_display_renders_as_hex() {
        let id = LongOpId(0xdead_beef);
        assert_eq!(format!("{id}"), "longop:00000000deadbeef");
    }

    #[test]
    fn rlop_key_display_renders_as_module_lattice() {
        let key = RlopKey::new(0x01, 0x52, 0x000a);
        assert_eq!(format!("{key}"), "rlop[01/52/000a]");
    }
}
