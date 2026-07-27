//! Recognising a script's own polled event loop, and letting a reader out of
//! it.
//!
//! Not every place a script waits for the reader is a suspended long
//! operation. A screen can instead be written as a loop that samples the
//! input device, hit-tests it against the objects it drew, and branches back
//! to the top — the wait is the loop itself, and nothing is ever queued for a
//! scheduler to resolve. A runtime whose only suspension point is a queued
//! long operation has no way to hand such a screen to a reader: it spins
//! until whatever step budget it was given runs out, and reports that budget
//! as the failure.
//!
//! Stepping is a pure function of the state
//! [`Vm::control_fingerprint`](crate::vm::Vm::control_fingerprint) folds, so
//! arriving at an already-seen fingerprint with no input available PROVES the
//! loop cannot leave on its own. That proof is the gate: park there, show the
//! reader the frame, and when they act, model the awaited event as having
//! fired by letting the loop's back edge fall through to its exit instead of
//! closing.

use std::collections::HashSet;

use crate::bytecode_element::BytecodeElement;
use crate::rlop::DispatchOutcome;
use crate::vm::{SceneId, Vm, VmEvent};

/// Whether the step that produced `event` took a control transfer that can
/// CLOSE a loop.
///
/// Every cycle in a control-flow graph contains a back edge: a jump to the
/// same or an earlier address in the same scene, a jump into another scene,
/// or a return. Forward calls and forward jumps cannot close one, so folding
/// the (comparatively expensive) full-state fingerprint only at these edges
/// keeps a long linear scene off the costly path.
pub(crate) fn closes_a_loop(event: &VmEvent, scene_before: SceneId, pc_before: u32) -> bool {
    let VmEvent::CommandDispatched { outcome, .. } = event else {
        return false;
    };
    match outcome {
        DispatchOutcome::Jump { scene, pc } => *scene != scene_before || *pc <= pc_before,
        DispatchOutcome::Return | DispatchOutcome::ReturnFromCall => true,
        _ => false,
    }
}

/// Whether the element at `pc` is a branch that can carry the loop's back
/// edge — a command with at least one jump target at or before its own
/// address. Read from the decoded element rather than from an executed
/// outcome, so the model can be armed for the step that is ABOUT to run.
pub(crate) fn carries_a_back_edge(element: &BytecodeElement, pc: u32) -> bool {
    let BytecodeElement::Command { goto_targets, .. } = element else {
        return false;
    };
    goto_targets.iter().any(|target| *target <= pc)
}

/// Per-drive state for the polled-event-loop gate.
///
/// The proof is scoped to a SINGLE drive on purpose. A loop the reader closes
/// themselves — answering "read that again?" with "yes" — also returns to an
/// identical state, and it would be wrong to break out of that one: they
/// asked for it. Restricting the proof to one drive means only a loop that
/// re-entered its own state with no input available at all can trip the gate.
#[derive(Debug, Default)]
pub(crate) struct PolledEventLoop {
    /// Fingerprints already seen at a loop-closing edge in this drive.
    seen: HashSet<u64>,
    /// Set once a drive has parked on a proven spin; consumed by the next
    /// drive, which then models the awaited event as fired.
    parked: bool,
}

impl PolledEventLoop {
    /// Begin a drive. Returns whether this drive should model the awaited
    /// event as fired (because the previous drive parked on a proven spin).
    pub(crate) fn begin_drive(&mut self) -> bool {
        self.seen.clear();
        std::mem::take(&mut self.parked)
    }

    /// Whether the session is currently parked on a polled event loop, and so
    /// is waiting on the reader even though nothing is queued.
    pub(crate) fn is_parked(&self) -> bool {
        self.parked
    }

    /// Fold the post-step state at a loop-closing edge. `true` means this
    /// exact state was already reached in this drive — the loop is proven
    /// unable to leave without the reader — and the caller should park.
    pub(crate) fn proves_spin(
        &mut self,
        vm: &Vm,
        event: &VmEvent,
        scene: SceneId,
        pc: u32,
    ) -> bool {
        if !closes_a_loop(event, scene, pc) {
            return false;
        }
        let proven = !self.seen.insert(vm.control_fingerprint());
        if proven {
            self.parked = true;
        }
        proven
    }
}
