//! RealLive `module_sel` (choice / selection) RLOperation
//! family.
//!
//! Implements the EXACT rlvm `Sel`-module opcode set `{0,1,2,3,4,14,20}`:
//! the SELECT ops `select`, `select_s`, `select_w`, `select_s` (opcode `3`)
//! `select_objbtn`, `select_objbtn_cancel` plus the `objbtn_init` setup op.
//! Each SELECT opcode yields a
//! [`crate::rlop::longops::SelectLongOp`] carrier whose private state
//! holds the choice byte strings and a pending chosen-index sentinel.
//! The substrate's [`crate::rlop::LongOpScheduler`] decides when the
//! head longop becomes `Ready` — the [`ChoiceInputScheduler`] this module
//! ships flips `Ready` once an [`InputEvent::Choice`]
//! ([`utsushi_core::substrate::ChoiceIndex`]) is fed through
//! [`ChoiceInputScheduler::record_choice`].
//!
//! On resume, the VM's [`crate::vm::Vm::step`] decodes the popped longop's
//! private state and writes the chosen index into the store register
//! (`vm.banks().store()`), keeping the longop coupling honest: the audit
//! focus pinned by ("Longop coupling — the longop must use
//! the substrate scheduler, not a private wait loop") is enforced
//! structurally — there is no per-op wait loop, the chosen index lives
//! on the scheduler until the substrate poll returns `Ready`, and the
//! store-register write happens through the same dispatch path as every
//! other substrate effect.
//!
//! # Module addressing
//!
//! The choice family lives at `(module_type=0, module_id=2)`, matching the
//! RealLive `Sel` module and the decompiler. Real bytecode validates
//! `select_w` at `(0,2,2)` and button-object selection at `(0,2,4)`.
//! Registering this family at `module_type=0` is essential: a wrong module
//! type leaves recognized selects gap-filled as `Advance` no-ops.
//!
//! The registered opcode set is EXACTLY rlvm's `Sel` module `{0,1,2,3,4,14,20}`
//! (verified against `rlvm/src/src/modules/module_sel.cc` — see below); there
//! is no synthetic opcode `120` (rlvm registers no such opcode and no real
//! corpus tuple lands on `(0,2,120)`).
//!
//! NOTE (pre-existing `0/1/2` naming, out of this node's scope): the port's
//! variant NAMES for opcodes `0/1/2` (`select` / `select_s` / `select_w`) do
//! NOT line up with rlvm's `module_sel.cc` labels (`0`=`select_w`, `1`=`select`
//! `2`=`select_s2`, `3`=`select_s`). The opcode NUMBERS registered are what
//! matters for dispatch; every port SELECT opcode funnels through the same
//! [`SelectLongOp`] carrier, so the label mismatch is cosmetic. This node
//! adds opcodes `3` + `14` to reach exact rlvm coverage and does not re-label
//! `0/1/2` (that would churn the real-bytes-anchored `select_w`=`(0,2,2)`
//! documentation and is tracked separately).
//!
//! # Opcode coverage (rlvm `SelModule` — `module_sel.cc`)
//!
//! Opcode | rlvm name | Port variant
//! ------ | ---------------------- | ----------------------------------
//! `0` | `select_w` | [`SelectVariant::Select`]
//! `1` | `select` | [`SelectVariant::SelectS`]
//! `2` | `select_s2` | [`SelectVariant::SelectW`]
//! `3` | `select_s` | [`SelectVariant::SelectS3`]
//! `4` | `select_objbtn` | [`SelectVariant::SelectObjbtn`]
//! `14` | `select_objbtn_cancel` | [`SelectVariant::SelectObjbtnCancel`]
//! `20` | `objbtn_init` | [`ObjbtnInitOp`] (setup, not a select)
//!
//! # Button-object presentation
//!
//! A `select_objbtn` prompt captures each foreground button's image reference,
//! transform, and hit rectangle from the decoded graphics state. The render
//! path uses that metadata directly. It never chooses a pair, strip, or grid
//! from the number of buttons.
//!
//! Every variant yields the same [`SelectLongOp`] carrier — the variant
//! distinction lives in the [`SelectVariant`] enum so audit tooling can
//! pin which opcode produced the queued longop without scraping the
//! private-state bytes.
//!
//! # Substrate-honesty posture
//!
//! - **No private wait loop.** Each op yields a typed
//!   [`DispatchOutcome::Yield`] carrying the [`SelectLongOp`]. The VM
//!   suspends through the substrate's longop queue + scheduler combo;
//!   no thread::sleep, no busy-poll, no host clock involvement.
//! - **Substrate input event.** The [`ChoiceInputScheduler`] consumes
//!   an [`InputEvent::Choice`] / [`ChoiceIndex`]; the engine port is
//!   the only path that calls `record_choice`.
//! - **Typed-resume store-register write.** The VM's step path decodes
//!   the popped longop's magic byte; the chosen index is written to
//!   `store_reg` via the typed `VarBanks::set_store` accessor.
//! - **Gameexe `SELBTN.NNN.*` styling.** Each emitted choice line is
//!   tagged with the styling fields the Gameexe defines for its index
//!   (e.g. `#SELBTN.000.*`). Missing entries fall back to a stable
//!   `choice:<idx>` text-surface label.
//!
//! # Tests
//!
//! - `choice_select_s_emits_three_options` (substrate ack): a synthetic
//!   `select_s` with three byte-string args emits 3 `TextLine` events
//!   (`text_surface = "choice:0/1/2"`) then suspends with a queued
//!   `SelectLongOp`.
//! - `choice_resume_writes_store_reg`: feeding `ChoiceIndex(1)` to the
//!   scheduler resumes the longop and writes `1` to the VM's store
//!   register; the pc advanced past the choice element on the original
//!   dispatch.

use std::sync::{Arc, Mutex};

use utsushi_core::substrate::{EvidenceTier, TextLine, TextSurfaceSink};

use super::longops::{ObjectSelectLongOp, ObjectSelectLongOpBuildError, SelectLongOp};
use super::module_msg::LongOpIdSequence;
pub use super::selection_prompt::SelectionPrompt;
use super::{DispatchOutcome, ExprValue, LongOp, RLOperation, RlopKey, RlopRegistry};
use crate::gameexe::Gameexe;
use crate::graphics_objects::{GraphicsObject, GraphicsObjectKind, HitRegion};
use crate::render_pipeline::{ObjectButtonChoiceOption, ObjectButtonChoiceWindowBuildError};
use crate::rlop::module_obj::GraphicsRuntime;
use crate::vm::Vm;

#[path = "module_sel/scheduler.rs"]
mod scheduler;
pub use self::scheduler::ChoiceInputScheduler;

#[path = "module_sel/types.rs"]
mod types;
use self::types::SelRuntimeInner;
pub use self::types::{
    OPCODE_OBJBTN_INIT, OPCODE_SELECT, OPCODE_SELECT_OBJBTN, OPCODE_SELECT_OBJBTN_CANCEL,
    OPCODE_SELECT_S, OPCODE_SELECT_S3, OPCODE_SELECT_W, ObjectButtonCandidateScope,
    ObjectButtonHitRegion, ObjectButtonPromptOption, SEL_MODULE_ID, SEL_MODULE_TYPE,
    SEL_RLOP_COUNT, SelRuntime, SelRuntimeWarning, SelectVariant, SelectionControlSignal,
    SelectionPromptKind, selection_control_signal,
};

#[path = "module_sel/runtime.rs"]
mod runtime;
use self::runtime::decode_shift_jis;

#[path = "module_sel/operations.rs"]
mod operations;
pub use self::operations::{
    ObjbtnInitOp, SelectObjbtnCancelOp, SelectObjbtnOp, SelectOp, SelectS3Op, SelectSOp, SelectWOp,
    register_sel_rlops,
};

#[cfg(test)]
#[path = "module_sel/tests.rs"]
mod tests;
