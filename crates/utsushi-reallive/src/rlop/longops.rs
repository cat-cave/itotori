//! UTSUSHI-210 — typed long-operation implementors.
//!
//! The UTSUSHI-208 substrate ships an opaque [`crate::rlop::LongOp`] data
//! record (`id` + `private_state: Vec<u8>`) and a
//! [`crate::rlop::LongOpScheduler`] gate that decides when the queue head
//! is ready to resume. This module adds the **first typed long-op
//! implementor** — [`SelectionLongOp`] — that the UTSUSHI-210 control-flow
//! `select` opcode yields and that resumes with a typed
//! [`crate::rlop::DispatchOutcome::Jump`] once the user has recorded a
//! choice.
//!
//! # Wire format
//!
//! The selection long-op's private state is serialized as a compact JSON
//! string and stored under [`LongOp::private_state`] verbatim so the VM's
//! substrate `Inspectable` / `Restorable` round-trip pins the user's
//! pending choice across snapshot boundaries.
//!
//! # Substrate-honesty posture
//!
//! - No silent fallback. A resume call before the user has recorded a
//!   choice surfaces a typed [`SelectionLongOpError::NoUserChoice`]. An
//!   out-of-range choice surfaces [`SelectionLongOpError::ChoiceOutOfRange`].
//! - No `unwrap()` on the (de)serialisation path — every JSON error is
//!   wrapped into a typed [`SelectionLongOpError::PrivateStateMalformed`].
//! - No legacy compat. The wire format carries a manifest label so a
//!   future schema bump is detected at decode time.

use serde::{Deserialize, Serialize};
use thiserror::Error;

use crate::rlop::{DispatchOutcome, LongOp, LongOpId};
use crate::vm::SceneId;

/// Manifest label stamped into the selection long-op's private-state
/// wire form. A future schema bump should change this string so the
/// decode path can detect the mismatch.
pub const SELECTION_LONGOP_MANIFEST: &str = "utsushi-reallive-selection-longop/0.1.0-alpha";

/// Typed error surface for [`SelectionLongOp`] operations.
#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum SelectionLongOpError {
    /// `resume` was called before any user choice had been recorded.
    /// The selection long-op is still pending input — the caller must
    /// drive [`SelectionLongOp::record_user_choice`] first.
    #[error("utsushi.reallive.selection_longop.no_user_choice: id={id}")]
    NoUserChoice {
        /// LongOp id surfaced verbatim for the diagnostic trail.
        id: LongOpId,
    },
    /// The recorded user choice indexed past the end of the choice
    /// table. Surfaces both the requested index and the choice count so
    /// the audit trail names the mismatch.
    #[error(
        "utsushi.reallive.selection_longop.choice_out_of_range: id={id} requested={requested} \
         choices={choices}"
    )]
    ChoiceOutOfRange {
        /// LongOp id.
        id: LongOpId,
        /// Requested choice index.
        requested: usize,
        /// Total choice count.
        choices: usize,
    },
    /// The selection long-op was constructed (or decoded) with an empty
    /// choice list. Selection with zero choices is structurally
    /// undefined and rejected at construction time per the
    /// "no silent zero-state" alpha-gate contract.
    #[error("utsushi.reallive.selection_longop.empty_choices: id={id}")]
    EmptyChoices {
        /// LongOp id.
        id: LongOpId,
    },
    /// Wire-form decode failed. The JSON payload either did not parse
    /// or did not carry the pinned manifest label.
    #[error("utsushi.reallive.selection_longop.private_state_malformed: reason={reason}")]
    PrivateStateMalformed {
        /// Short reason string. Carries the underlying JSON error
        /// `to_string()` or the manifest-mismatch label.
        reason: String,
    },
}

/// Internal wire form for the selection long-op's private state. Held
/// private so the serde derives stay free of the public surface — the
/// only public entry points are the encode/decode round trip and the
/// typed accessors.
#[derive(Debug, Clone, Serialize, Deserialize)]
struct SelectionWire {
    manifest: String,
    choices: Vec<u32>,
    user_choice: Option<usize>,
}

/// A queued selection long-op.
///
/// The control-flow `select` opcode yields one of these with the choice
/// table populated and `user_choice = None`. The substrate's selection
/// runtime (a follow-up node) wires user input into
/// [`SelectionLongOp::record_user_choice`], at which point [`resume`]
/// returns a [`DispatchOutcome::Jump`] targeting the selected pc.
///
/// [`resume`]: SelectionLongOp::resume
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SelectionLongOp {
    id: LongOpId,
    choices: Vec<u32>,
    user_choice: Option<usize>,
}

impl SelectionLongOp {
    /// Construct a new selection long-op. Returns
    /// [`SelectionLongOpError::EmptyChoices`] when the choice list is
    /// empty — selection with zero choices is structurally undefined.
    pub fn new(id: LongOpId, choices: Vec<u32>) -> Result<Self, SelectionLongOpError> {
        if choices.is_empty() {
            return Err(SelectionLongOpError::EmptyChoices { id });
        }
        Ok(Self {
            id,
            choices,
            user_choice: None,
        })
    }

    /// LongOp id.
    pub fn id(&self) -> LongOpId {
        self.id
    }

    /// Borrow the choice table (target pc values).
    pub fn choices(&self) -> &[u32] {
        &self.choices
    }

    /// Recorded user choice (if any). `None` while the selection is
    /// still pending input.
    pub fn user_choice(&self) -> Option<usize> {
        self.user_choice
    }

    /// Record the user's choice. Returns
    /// [`SelectionLongOpError::ChoiceOutOfRange`] when the index is
    /// past the end of the choice table.
    pub fn record_user_choice(&mut self, requested: usize) -> Result<(), SelectionLongOpError> {
        if requested >= self.choices.len() {
            return Err(SelectionLongOpError::ChoiceOutOfRange {
                id: self.id,
                requested,
                choices: self.choices.len(),
            });
        }
        self.user_choice = Some(requested);
        Ok(())
    }

    /// Resume the selection long-op against `scene`. Returns a typed
    /// [`DispatchOutcome::Jump`] whose `pc` is `choices[user_choice]`.
    ///
    /// # Errors
    ///
    /// - [`SelectionLongOpError::NoUserChoice`] when the user has not
    ///   yet recorded a choice.
    /// - [`SelectionLongOpError::ChoiceOutOfRange`] is *not* surfaced
    ///   here — `record_user_choice` rejects out-of-range indices at
    ///   the input boundary so resume is always safe.
    pub fn resume(&self, scene: SceneId) -> Result<DispatchOutcome, SelectionLongOpError> {
        let idx = self
            .user_choice
            .ok_or(SelectionLongOpError::NoUserChoice { id: self.id })?;
        // `record_user_choice` rejects out-of-range; this `get` is a
        // belt-and-braces guard against a future code path that
        // mutates `user_choice` outside the validated entry point.
        let pc = self
            .choices
            .get(idx)
            .copied()
            .ok_or(SelectionLongOpError::ChoiceOutOfRange {
                id: self.id,
                requested: idx,
                choices: self.choices.len(),
            })?;
        Ok(DispatchOutcome::Jump { scene, pc })
    }

    /// Encode this selection long-op as a queued [`LongOp`] record. The
    /// `private_state` payload is a compact JSON string carrying the
    /// pinned manifest label, the choice table, and the user's pending
    /// choice (if any).
    pub fn to_longop(&self) -> Result<LongOp, SelectionLongOpError> {
        let wire = SelectionWire {
            manifest: SELECTION_LONGOP_MANIFEST.to_string(),
            choices: self.choices.clone(),
            user_choice: self.user_choice,
        };
        let payload = serde_json::to_vec(&wire).map_err(|err| {
            SelectionLongOpError::PrivateStateMalformed {
                reason: err.to_string(),
            }
        })?;
        Ok(LongOp::new(self.id, payload))
    }

    /// Decode a queued [`LongOp`]'s private state back into a typed
    /// selection long-op. Returns a typed
    /// [`SelectionLongOpError::PrivateStateMalformed`] on a malformed
    /// payload or a manifest mismatch.
    pub fn from_longop(longop: &LongOp) -> Result<Self, SelectionLongOpError> {
        let wire: SelectionWire = serde_json::from_slice(&longop.private_state).map_err(|err| {
            SelectionLongOpError::PrivateStateMalformed {
                reason: err.to_string(),
            }
        })?;
        if wire.manifest != SELECTION_LONGOP_MANIFEST {
            return Err(SelectionLongOpError::PrivateStateMalformed {
                reason: format!(
                    "manifest mismatch: observed={} expected={SELECTION_LONGOP_MANIFEST}",
                    wire.manifest
                ),
            });
        }
        if wire.choices.is_empty() {
            return Err(SelectionLongOpError::EmptyChoices { id: longop.id });
        }
        if let Some(idx) = wire.user_choice
            && idx >= wire.choices.len()
        {
            return Err(SelectionLongOpError::ChoiceOutOfRange {
                id: longop.id,
                requested: idx,
                choices: wire.choices.len(),
            });
        }
        Ok(Self {
            id: longop.id,
            choices: wire.choices,
            user_choice: wire.user_choice,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn new_rejects_empty_choices() {
        let err = SelectionLongOp::new(LongOpId(7), vec![]).unwrap_err();
        assert_eq!(err, SelectionLongOpError::EmptyChoices { id: LongOpId(7) });
    }

    #[test]
    fn resume_without_user_choice_is_typed_error() {
        let op = SelectionLongOp::new(LongOpId(1), vec![10, 20]).expect("new");
        let err = op.resume(0).unwrap_err();
        assert_eq!(err, SelectionLongOpError::NoUserChoice { id: LongOpId(1) });
    }

    #[test]
    fn record_then_resume_emits_jump() {
        let mut op = SelectionLongOp::new(LongOpId(2), vec![100, 200, 300]).expect("new");
        op.record_user_choice(1).expect("record");
        let outcome = op.resume(42).expect("resume");
        assert_eq!(outcome, DispatchOutcome::Jump { scene: 42, pc: 200 });
    }

    #[test]
    fn record_out_of_range_returns_typed_error() {
        let mut op = SelectionLongOp::new(LongOpId(3), vec![1, 2]).expect("new");
        let err = op.record_user_choice(5).unwrap_err();
        assert_eq!(
            err,
            SelectionLongOpError::ChoiceOutOfRange {
                id: LongOpId(3),
                requested: 5,
                choices: 2,
            }
        );
    }

    #[test]
    fn round_trip_preserves_pending_state() {
        let op = SelectionLongOp::new(LongOpId(4), vec![5, 6, 7]).expect("new");
        let longop = op.to_longop().expect("encode");
        let restored = SelectionLongOp::from_longop(&longop).expect("decode");
        assert_eq!(restored, op);
    }

    #[test]
    fn round_trip_preserves_recorded_choice() {
        let mut op = SelectionLongOp::new(LongOpId(5), vec![5, 6, 7]).expect("new");
        op.record_user_choice(2).expect("record");
        let longop = op.to_longop().expect("encode");
        let restored = SelectionLongOp::from_longop(&longop).expect("decode");
        assert_eq!(restored.user_choice(), Some(2));
    }

    #[test]
    fn decode_rejects_manifest_mismatch() {
        let bad = LongOp::new(
            LongOpId(6),
            b"{\"manifest\":\"wrong\",\"choices\":[1],\"user_choice\":null}".to_vec(),
        );
        let err = SelectionLongOp::from_longop(&bad).unwrap_err();
        assert!(
            matches!(err, SelectionLongOpError::PrivateStateMalformed { ref reason } if reason.contains("manifest mismatch")),
            "unexpected error variant: {err:?}"
        );
    }

    #[test]
    fn decode_rejects_malformed_json() {
        let bad = LongOp::new(LongOpId(7), b"not json".to_vec());
        let err = SelectionLongOp::from_longop(&bad).unwrap_err();
        assert!(matches!(
            err,
            SelectionLongOpError::PrivateStateMalformed { .. }
        ));
    }
}
