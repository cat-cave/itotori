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

use super::{LongOp, LongOpId, LongOpReadiness, LongOpScheduler};

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

    /// Decode a [`LongOp`] carrier back into a `SelectLongOp`. Returns
    /// a typed [`SelectLongOpDecodeError`] if the magic byte does not
    /// match, the length prefix is truncated, or a choice body runs
    /// past the end of the payload.
    pub fn try_from_longop(op: &LongOp) -> Result<Self, SelectLongOpDecodeError> {
        let state = &op.private_state;
        if state.len() < 5 {
            return Err(SelectLongOpDecodeError::UnexpectedPayloadLength {
                observed: state.len(),
                minimum: 5,
            });
        }
        if state[0] != SELECT_PRIVATE_STATE_MAGIC {
            return Err(SelectLongOpDecodeError::MagicMismatch {
                observed: state[0],
                expected: SELECT_PRIVATE_STATE_MAGIC,
            });
        }
        let chosen_raw = u16::from_le_bytes([state[1], state[2]]);
        let chosen = if chosen_raw == Self::CHOSEN_SENTINEL_PENDING {
            None
        } else {
            Some(chosen_raw)
        };
        let count = u16::from_le_bytes([state[3], state[4]]) as usize;
        let mut choices: Vec<Vec<u8>> = Vec::with_capacity(count);
        let mut cursor = 5usize;
        for _ in 0..count {
            if cursor + 2 > state.len() {
                return Err(SelectLongOpDecodeError::TruncatedChoiceLength { cursor });
            }
            let len = u16::from_le_bytes([state[cursor], state[cursor + 1]]) as usize;
            cursor += 2;
            if cursor + len > state.len() {
                return Err(SelectLongOpDecodeError::TruncatedChoiceBody { cursor, len });
            }
            choices.push(state[cursor..cursor + len].to_vec());
            cursor += len;
        }
        Ok(Self {
            id: op.id,
            choices,
            chosen,
        })
    }
}

/// Typed decode error for [`SelectLongOp::try_from_longop`]. Returned
/// when a snapshot restore or a substrate scheduler hands the wrapper a
/// malformed private-state payload.
#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum SelectLongOpDecodeError {
    /// Payload byte length was below the fixed 5-byte header.
    #[error("utsushi.reallive.rlop.select.payload_length: observed={observed} minimum={minimum}")]
    UnexpectedPayloadLength {
        /// Payload byte length observed.
        observed: usize,
        /// Minimum byte length the decoder expected.
        minimum: usize,
    },
    /// Magic byte at offset 0 did not match
    /// [`SELECT_PRIVATE_STATE_MAGIC`].
    #[error(
        "utsushi.reallive.rlop.select.magic_mismatch: observed=0x{observed:02x} expected=0x{expected:02x}"
    )]
    MagicMismatch {
        /// Magic byte observed at offset 0.
        observed: u8,
        /// Magic byte the decoder expected.
        expected: u8,
    },
    /// A choice's `u16` length prefix ran past the end of the payload.
    #[error("utsushi.reallive.rlop.select.truncated_choice_length: cursor={cursor}")]
    TruncatedChoiceLength {
        /// Byte cursor where the length prefix was expected.
        cursor: usize,
    },
    /// A choice's body bytes ran past the end of the payload.
    #[error("utsushi.reallive.rlop.select.truncated_choice_body: cursor={cursor} len={len}")]
    TruncatedChoiceBody {
        /// Byte cursor where the body bytes started.
        cursor: usize,
        /// Length the choice declared.
        len: usize,
    },
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
        let mut op = LongOp::new(LongOpId(1), vec![]);
        assert_eq!(scheduler.poll(&mut op), LongOpReadiness::Pending);
        assert_eq!(scheduler.poll(&mut op), LongOpReadiness::Pending);
        assert_eq!(scheduler.poll(&mut op), LongOpReadiness::Ready);
    }
}
