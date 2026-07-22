//! Typed `LongOp` wrappers for the text / messaging
//! family.
//!
//! The [`crate::rlop::LongOp`] carrier is a tuple of
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
//!   ) flips the byte after `N` polls; the runtime
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

pub const OBJECT_SELECT_PRIVATE_STATE_MAGIC: u8 = 0xA3;
pub const OBJECT_SELECT_PRIVATE_STATE_VERSION: u8 = 2;
const OBJECT_SELECT_V1: u8 = 1;
pub const OBJECT_SELECT_FLAG_CANCELABLE: u8 = 0x01;

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
        let dismissed_flag = u8::from(self.dismissed);
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
    /// `[SELECT_PRIVATE_STATE_MAGIC, chosen_lo, chosen_hi, count_lo
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

#[path = "longops/object_select.rs"]
mod object_select;
pub(crate) use object_select::ObjectSelectLongOpBuildError;
pub use object_select::{ObjectSelectLongOp, ObjectSelectLongOpDecodeError, ObjectSelectOutcome};

#[path = "longops/schedulers.rs"]
mod schedulers;
pub use schedulers::{HeadlessChoicePolicy, HeadlessInputScheduler, SelectionChoiceCountScheduler};

#[cfg(test)]
#[path = "longops/tests.rs"]
mod tests;
