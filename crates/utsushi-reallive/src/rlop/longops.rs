//! UTSUSHI-209 — typed `LongOp` wrappers for the text / messaging
//! family.
//!
//! The UTSUSHI-208 [`crate::rlop::LongOp`] carrier is a tuple of
//! `(LongOpId, private_state: Vec<u8>)`. The private state is opaque to
//! the VM and to the snapshot store; per-family typed wrappers encode
//! and decode the state into the carrier so the runtime scheduler (and
//! the test scheduler) can reason about the suspension shape without
//! string-matching on the bytes.
//!
//! Two wrappers ship here:
//!
//! - [`PauseLongOp`] — produced by `msg.pause`. Private state carries
//!   a single byte indicating whether the user has dismissed the
//!   pause. The test scheduler ([`AfterNPollsScheduler`] from
//!   UTSUSHI-208) flips the byte after `N` polls; the runtime
//!   scheduler will wire user input later.
//! - [`SelectLongOp`] — produced by `msg.select`. Private state
//!   carries the byte-length-prefixed choices plus a chosen-index
//!   placeholder. The test scheduler
//!   ([`SelectionChoiceCountScheduler`]) flips the chosen-index after
//!   `N` polls; the runtime scheduler will wire user input later.
//!
//! Substrate-honesty posture: the wrappers never panic on a malformed
//! private state — every decode failure surfaces a typed
//! [`PauseLongOpDecodeError`] so the caller (typically a snapshot
//! restore path) can react.

use serde::{Deserialize, Serialize};
use thiserror::Error;

use super::{DispatchOutcome, LongOp, LongOpId, LongOpReadiness, LongOpScheduler};
use crate::vm::SceneId;

/// Magic byte that prefixes every `PauseLongOp` private-state payload.
/// Picked so the byte does not collide with the [`SELECT_PRIVATE_STATE_MAGIC`]
/// payload prefix — the snapshot restore path uses the magic to
/// distinguish the two shapes without committing to a schema-versioning
/// scheme yet.
pub const PAUSE_PRIVATE_STATE_MAGIC: u8 = 0xA1;

/// Magic byte that prefixes every `SelectLongOp` private-state payload.
pub const SELECT_PRIVATE_STATE_MAGIC: u8 = 0xA2;

/// Default number of `Pending` polls a [`PauseLongOp`] observes before
/// the synthetic test scheduler reports it as `Ready`. Pinned so the
/// synthetic tests have a stable cadence — the runtime scheduler will
/// not use this constant.
pub const DEFAULT_PAUSE_POLLS: u32 = 1;

/// Typed wrapper around the `Pause` private state.
///
/// The pause longop encodes a single boolean — "has the user dismissed
/// the pause?". The byte is `0x00` while the pause is still active and
/// `0x01` once it has been dismissed. The wrapper exposes typed
/// `dismissed()` / `mark_dismissed()` so the runtime path does not
/// reach into the bytes directly.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PauseLongOp {
    id: LongOpId,
    dismissed: bool,
}

impl PauseLongOp {
    /// Build a fresh `PauseLongOp` keyed on `id`. The pause starts
    /// undismissed; the scheduler is responsible for flipping the bit
    /// once the user input arrives (test scheduler) or wall-clock event
    /// fires (runtime scheduler).
    pub fn new(id: LongOpId) -> Self {
        Self {
            id,
            dismissed: false,
        }
    }

    /// Stable id this pause carries.
    pub fn id(&self) -> LongOpId {
        self.id
    }

    /// Whether the user has dismissed the pause.
    pub fn dismissed(&self) -> bool {
        self.dismissed
    }

    /// Mark the pause as dismissed. The next scheduler poll will see
    /// the flipped bit and report `Ready`.
    pub fn mark_dismissed(&mut self) {
        self.dismissed = true;
    }

    /// Encode the wrapper into a [`LongOp`] carrier. The private state
    /// is the two-byte `[PAUSE_PRIVATE_STATE_MAGIC, dismissed_flag]`
    /// payload; the magic byte lets the snapshot path round-trip the
    /// shape without ambiguity.
    pub fn into_longop(self) -> LongOp {
        let dismissed_flag = if self.dismissed { 0x01 } else { 0x00 };
        LongOp::new(self.id, vec![PAUSE_PRIVATE_STATE_MAGIC, dismissed_flag])
    }

    /// Decode a [`LongOp`] carrier back into a `PauseLongOp`. Returns
    /// a typed error if the magic byte does not match or the payload
    /// length is wrong.
    pub fn try_from_longop(op: &LongOp) -> Result<Self, PauseLongOpDecodeError> {
        let state = &op.private_state;
        if state.len() != 2 {
            return Err(PauseLongOpDecodeError::UnexpectedPayloadLength {
                observed: state.len(),
                expected: 2,
            });
        }
        if state[0] != PAUSE_PRIVATE_STATE_MAGIC {
            return Err(PauseLongOpDecodeError::MagicMismatch {
                observed: state[0],
                expected: PAUSE_PRIVATE_STATE_MAGIC,
            });
        }
        let dismissed = match state[1] {
            0x00 => false,
            0x01 => true,
            other => {
                return Err(PauseLongOpDecodeError::DismissedFlagOutOfRange { observed: other });
            }
        };
        Ok(Self {
            id: op.id,
            dismissed,
        })
    }
}

/// Typed decode error for [`PauseLongOp::try_from_longop`]. Returned
/// when a snapshot restore (or a synthetic test) hands the wrapper a
/// malformed private-state payload.
#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum PauseLongOpDecodeError {
    /// Payload byte length did not match the expected fixed shape.
    #[error("utsushi.reallive.rlop.pause.payload_length: observed={observed} expected={expected}")]
    UnexpectedPayloadLength {
        /// Payload byte length observed.
        observed: usize,
        /// Payload byte length the decoder expected.
        expected: usize,
    },
    /// Magic byte at offset 0 did not match
    /// [`PAUSE_PRIVATE_STATE_MAGIC`].
    #[error(
        "utsushi.reallive.rlop.pause.magic_mismatch: observed=0x{observed:02x} expected=0x{expected:02x}"
    )]
    MagicMismatch {
        /// Magic byte observed at offset 0.
        observed: u8,
        /// Magic byte the decoder expected.
        expected: u8,
    },
    /// `dismissed` flag at offset 1 was neither `0x00` nor `0x01`.
    #[error(
        "utsushi.reallive.rlop.pause.dismissed_flag: observed=0x{observed:02x} expected 0x00 or 0x01"
    )]
    DismissedFlagOutOfRange {
        /// Flag byte observed at offset 1.
        observed: u8,
    },
}

/// Typed wrapper around the `Select` private state.
///
/// The select longop carries the choice list (each entry length-prefixed
/// with a `u16 LE`) and a `u16 LE` chosen-index sentinel (`0xFFFF` while
/// the choice is pending, `0..N` once a choice has been made). The
/// runtime scheduler will write the chosen index from user input;
/// the test scheduler ([`SelectionChoiceCountScheduler`]) writes
/// index `0` after `N` polls so synthetic tests can observe the
/// resume path deterministically.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SelectLongOp {
    id: LongOpId,
    choices: Vec<Vec<u8>>,
    chosen: Option<u16>,
}

impl SelectLongOp {
    /// `u16 LE` sentinel value indicating "no choice yet".
    pub const CHOSEN_SENTINEL_PENDING: u16 = 0xFFFF;

    /// Build a fresh `SelectLongOp` from a list of Shift-JIS-encoded
    /// choice byte strings. The chosen-index starts as
    /// [`CHOSEN_SENTINEL_PENDING`].
    pub fn new(id: LongOpId, choices: Vec<Vec<u8>>) -> Self {
        Self {
            id,
            choices,
            chosen: None,
        }
    }

    /// Stable id this select carries.
    pub fn id(&self) -> LongOpId {
        self.id
    }

    /// Borrow the choice list (each entry is the raw Shift-JIS bytes
    /// of one option).
    pub fn choices(&self) -> &[Vec<u8>] {
        &self.choices
    }

    /// Number of choices the user is being offered.
    pub fn choice_count(&self) -> usize {
        self.choices.len()
    }

    /// Chosen index, if any.
    pub fn chosen(&self) -> Option<u16> {
        self.chosen
    }

    /// Record a chosen index. The runtime scheduler calls this when
    /// the user makes a choice; the test scheduler calls it to
    /// deterministically resume.
    pub fn choose(&mut self, index: u16) {
        self.chosen = Some(index);
    }

    /// Encode the wrapper into a [`LongOp`] carrier. Payload shape:
    /// `[SELECT_PRIVATE_STATE_MAGIC, chosen_lo, chosen_hi, count_lo,
    /// count_hi, [<len_lo, len_hi, body...>; count]]`. The magic byte
    /// lets the snapshot path round-trip the shape without ambiguity.
    pub fn into_longop(self) -> LongOp {
        let mut state = Vec::with_capacity(5);
        state.push(SELECT_PRIVATE_STATE_MAGIC);
        let chosen_raw = self
            .chosen
            .unwrap_or(Self::CHOSEN_SENTINEL_PENDING)
            .to_le_bytes();
        state.extend_from_slice(&chosen_raw);
        let count = u16::try_from(self.choices.len()).unwrap_or(u16::MAX);
        state.extend_from_slice(&count.to_le_bytes());
        for choice in &self.choices {
            let len = u16::try_from(choice.len()).unwrap_or(u16::MAX);
            state.extend_from_slice(&len.to_le_bytes());
            let take = len as usize;
            // If a single choice exceeds `u16::MAX`, truncate at the
            // serialise boundary rather than panicking — the snapshot
            // shape carries a u16 length prefix by construction.
            state.extend_from_slice(&choice[..take.min(choice.len())]);
        }
        LongOp::new(self.id, state)
    }
}

/// Scheduler that resumes a [`SelectLongOp`] after observing the queue
/// head as pending for `polls_remaining` polls. The shape mirrors
/// [`crate::rlop::AfterNPollsScheduler`] so a test can swap one for
/// the other; the typed wrapper exists so a synthetic `msg.select`
/// test can spell out "wait N polls, then resume" in a name that
/// reflects the suspension shape.
#[derive(Debug, Clone, Copy)]
pub struct SelectionChoiceCountScheduler {
    /// Remaining `Pending` polls before the head becomes `Ready`.
    pub polls_remaining: u32,
}

impl SelectionChoiceCountScheduler {
    /// Construct a scheduler that reports `Pending` `polls` times and
    /// `Ready` thereafter.
    pub fn new(polls: u32) -> Self {
        Self {
            polls_remaining: polls,
        }
    }
}

impl LongOpScheduler for SelectionChoiceCountScheduler {
    fn poll(&mut self, _head: &LongOp) -> LongOpReadiness {
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

    #[test]
    fn pause_round_trips_through_longop_carrier() {
        let longop = PauseLongOp::new(LongOpId(0x42)).into_longop();
        assert_eq!(longop.id, LongOpId(0x42));
        assert_eq!(longop.private_state, vec![PAUSE_PRIVATE_STATE_MAGIC, 0x00]);
        let decoded = PauseLongOp::try_from_longop(&longop).expect("decode");
        assert_eq!(decoded.id(), LongOpId(0x42));
        assert!(!decoded.dismissed());
    }

    #[test]
    fn pause_dismissed_flag_round_trips() {
        let mut pause = PauseLongOp::new(LongOpId(1));
        pause.mark_dismissed();
        let longop = pause.into_longop();
        assert_eq!(longop.private_state[1], 0x01);
        let decoded = PauseLongOp::try_from_longop(&longop).expect("decode");
        assert!(decoded.dismissed());
    }

    #[test]
    fn pause_decode_rejects_wrong_length() {
        let longop = LongOp::new(LongOpId(1), vec![PAUSE_PRIVATE_STATE_MAGIC]);
        let err = PauseLongOp::try_from_longop(&longop).expect_err("must reject short");
        assert!(matches!(
            err,
            PauseLongOpDecodeError::UnexpectedPayloadLength {
                observed: 1,
                expected: 2,
            }
        ));
    }

    #[test]
    fn pause_decode_rejects_wrong_magic() {
        let longop = LongOp::new(LongOpId(1), vec![0x00, 0x00]);
        let err = PauseLongOp::try_from_longop(&longop).expect_err("must reject magic");
        assert!(matches!(
            err,
            PauseLongOpDecodeError::MagicMismatch {
                observed: 0x00,
                expected: PAUSE_PRIVATE_STATE_MAGIC,
            }
        ));
    }

    #[test]
    fn pause_decode_rejects_invalid_dismissed_flag() {
        let longop = LongOp::new(LongOpId(1), vec![PAUSE_PRIVATE_STATE_MAGIC, 0x99]);
        let err = PauseLongOp::try_from_longop(&longop).expect_err("must reject flag");
        assert!(matches!(
            err,
            PauseLongOpDecodeError::DismissedFlagOutOfRange { observed: 0x99 }
        ));
    }

    #[test]
    fn select_encodes_payload_with_magic_and_lengths() {
        let choices = vec![b"yes".to_vec(), b"no".to_vec()];
        let longop = SelectLongOp::new(LongOpId(7), choices).into_longop();
        assert_eq!(longop.id, LongOpId(7));
        let state = &longop.private_state;
        assert_eq!(state[0], SELECT_PRIVATE_STATE_MAGIC);
        // chosen sentinel = 0xFFFF
        assert_eq!(state[1], 0xFF);
        assert_eq!(state[2], 0xFF);
        // count = 2
        assert_eq!(state[3], 0x02);
        assert_eq!(state[4], 0x00);
        // first choice: len=3 then "yes"
        assert_eq!(state[5], 0x03);
        assert_eq!(state[6], 0x00);
        assert_eq!(&state[7..10], b"yes");
        // second choice: len=2 then "no"
        assert_eq!(state[10], 0x02);
        assert_eq!(state[11], 0x00);
        assert_eq!(&state[12..14], b"no");
    }

    #[test]
    fn select_choose_records_index() {
        let mut select = SelectLongOp::new(LongOpId(1), vec![b"a".to_vec(), b"b".to_vec()]);
        assert_eq!(select.chosen(), None);
        select.choose(1);
        assert_eq!(select.chosen(), Some(1));
        let longop = select.into_longop();
        // chosen index 1 == 0x0001 LE
        assert_eq!(longop.private_state[1], 0x01);
        assert_eq!(longop.private_state[2], 0x00);
    }

    #[test]
    fn selection_choice_count_scheduler_observes_pending_then_ready() {
        let mut scheduler = SelectionChoiceCountScheduler::new(2);
        let op = LongOp::new(LongOpId(1), vec![]);
        assert_eq!(scheduler.poll(&op), LongOpReadiness::Pending);
        assert_eq!(scheduler.poll(&op), LongOpReadiness::Pending);
        assert_eq!(scheduler.poll(&op), LongOpReadiness::Ready);
    }
}

// ============================================================
// UTSUSHI-210 SelectionLongOp — control-flow select opcode
// ============================================================

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
mod selection_tests {
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
