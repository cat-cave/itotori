use std::sync::Mutex;

use utsushi_core::substrate::ChoiceIndex;

use crate::rlop::longops::{
    OBJECT_SELECT_PRIVATE_STATE_MAGIC, ObjectSelectLongOp, SELECT_PRIVATE_STATE_MAGIC, SelectLongOp,
};
use crate::rlop::{LongOp, LongOpReadiness, LongOpScheduler};

// Choice-input scheduler

/// Substrate [`LongOpScheduler`] that resumes a queued
/// [`SelectLongOp`] once an [`InputEvent::Choice`] has been recorded
/// through [`ChoiceInputScheduler::record_choice`].
///
/// The scheduler holds the pending [`ChoiceIndex`] internally. On
/// `poll`, it rewrites the head longop's private state so the chosen
/// index lands in the `SELECT_PRIVATE_STATE_MAGIC` payload before
/// returning [`LongOpReadiness::Ready`]. The VM's `step` path then
/// decodes the chosen index from the popped longop and writes it into
/// the store register via [`crate::vm::Vm::apply_choice_resume`].
///
/// The scheduler is the only path that translates an
/// [`InputEvent::Choice`] into a VM-visible store-register write — no
/// private wait loop, no host-clock dependency, no opcode-side mutation.
#[derive(Debug, Default)]
pub struct ChoiceInputScheduler {
    pending: Mutex<Option<ChoiceIndex>>,
}

impl ChoiceInputScheduler {
    /// Construct a scheduler with no pending choice. The substrate poll
    /// returns `Pending` until [`record_choice`] is called.
    ///
    /// [`record_choice`]: ChoiceInputScheduler::record_choice
    pub fn new() -> Self {
        Self::default()
    }

    /// Record the user's choice. The next [`LongOpScheduler::poll`]
    /// will return [`LongOpReadiness::Ready`] after rewriting the head
    /// longop's private state.
    pub fn record_choice(&self, index: ChoiceIndex) {
        let mut guard = self
            .pending
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        *guard = Some(index);
    }

    /// Borrow the pending choice (if any). Exposed for tests that want
    /// to assert "no choice yet recorded" without forcing a poll.
    pub fn pending(&self) -> Option<ChoiceIndex> {
        let guard = self
            .pending
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        *guard
    }
}

impl LongOpScheduler for ChoiceInputScheduler {
    fn poll(&mut self, head: &mut LongOp) -> LongOpReadiness {
        let pending = {
            let guard = self
                .pending
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            *guard
        };
        let Some(index) = pending else {
            return LongOpReadiness::Pending;
        };
        match head.private_state.first().copied() {
            Some(SELECT_PRIVATE_STATE_MAGIC) => match SelectLongOp::try_from_longop(head) {
                Ok(mut select) => {
                    select.choose(index.get());
                    let LongOp { id, private_state } = select.into_longop();
                    head.id = id;
                    head.private_state = private_state;
                    LongOpReadiness::Ready
                }
                Err(_) => LongOpReadiness::Pending,
            },
            Some(OBJECT_SELECT_PRIVATE_STATE_MAGIC) => {
                match ObjectSelectLongOp::try_from_longop(head) {
                    Ok(mut select) => {
                        select.select(index.get());
                        let LongOp { id, private_state } = select.into_longop();
                        head.id = id;
                        head.private_state = private_state;
                        LongOpReadiness::Ready
                    }
                    Err(_) => LongOpReadiness::Pending,
                }
            }
            _ => LongOpReadiness::Pending,
        }
    }
}
