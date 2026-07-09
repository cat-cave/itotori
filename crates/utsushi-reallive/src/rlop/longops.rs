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

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ObjectSelectLongOp {
    id: LongOpId,
    return_values: Vec<i32>,
    flags: u8,
    outcome: ObjectSelectOutcome,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum ObjectSelectOutcome {
    Pending,
    DisplayIndex(u16),
    /// Valid only when [`OBJECT_SELECT_FLAG_CANCELABLE`] is set.
    Cancelled,
}

impl ObjectSelectLongOp {
    pub const SELECTED_SENTINEL_PENDING: u16 = 0xFFFF;

    pub(crate) fn try_new(
        id: LongOpId,
        return_values: Vec<i32>,
    ) -> Result<Self, ObjectSelectLongOpBuildError> {
        if return_values.len() > u16::MAX as usize {
            return Err(ObjectSelectLongOpBuildError::TooManyReturnValues {
                observed: return_values.len(),
            });
        }
        Ok(Self {
            id,
            return_values,
            flags: 0,
            outcome: ObjectSelectOutcome::Pending,
        })
    }

    pub fn return_values(&self) -> &[i32] {
        &self.return_values
    }

    pub fn choice_count(&self) -> usize {
        self.return_values.len()
    }

    pub fn flags(&self) -> u8 {
        self.flags
    }

    pub fn is_cancelable(&self) -> bool {
        self.flags & OBJECT_SELECT_FLAG_CANCELABLE != 0
    }

    pub fn set_cancelable(&mut self, cancelable: bool) {
        if cancelable {
            self.flags |= OBJECT_SELECT_FLAG_CANCELABLE;
        } else {
            self.flags &= !OBJECT_SELECT_FLAG_CANCELABLE;
        }
    }

    pub fn outcome(&self) -> ObjectSelectOutcome {
        self.outcome
    }

    pub fn select(&mut self, index: u16) {
        self.outcome = ObjectSelectOutcome::DisplayIndex(index);
    }

    pub fn cancel(&mut self) {
        self.outcome = ObjectSelectOutcome::Cancelled;
    }

    pub fn into_longop(self) -> LongOp {
        let count = self.return_values.len();
        let (tag, index) = match self.outcome {
            ObjectSelectOutcome::Pending => (0, 0),
            ObjectSelectOutcome::DisplayIndex(index) => (1, index),
            ObjectSelectOutcome::Cancelled => (2, 0),
        };
        let mut state = Vec::with_capacity(8 + count * 4);
        state.push(OBJECT_SELECT_PRIVATE_STATE_MAGIC);
        state.push(OBJECT_SELECT_PRIVATE_STATE_VERSION);
        state.push(self.flags);
        state.push(tag);
        state.extend_from_slice(&index.to_le_bytes());
        state.extend_from_slice(&(count as u16).to_le_bytes());
        for value in self.return_values {
            state.extend_from_slice(&value.to_le_bytes());
        }
        LongOp::new(self.id, state)
    }

    pub fn try_from_longop(op: &LongOp) -> Result<Self, ObjectSelectLongOpDecodeError> {
        let state = &op.private_state;
        if state.len() < 2 {
            return Err(ObjectSelectLongOpDecodeError::UnexpectedPayloadLength {
                observed: state.len(),
                minimum: 2,
            });
        }
        if state[0] != OBJECT_SELECT_PRIVATE_STATE_MAGIC {
            return Err(ObjectSelectLongOpDecodeError::MagicMismatch {
                observed: state[0],
                expected: OBJECT_SELECT_PRIVATE_STATE_MAGIC,
            });
        }
        match state[1] {
            OBJECT_SELECT_V1 => Self::decode_v1(op),
            OBJECT_SELECT_PRIVATE_STATE_VERSION => Self::decode_v2(op),
            observed => Err(ObjectSelectLongOpDecodeError::UnsupportedVersion { observed }),
        }
    }

    fn decode_v1(op: &LongOp) -> Result<Self, ObjectSelectLongOpDecodeError> {
        let state = &op.private_state;
        let (return_values, selected) = decode_object_values(state, 6)?;
        Ok(Self {
            id: op.id,
            return_values,
            flags: 0,
            outcome: selected
                .map(ObjectSelectOutcome::DisplayIndex)
                .unwrap_or(ObjectSelectOutcome::Pending),
        })
    }

    fn decode_v2(op: &LongOp) -> Result<Self, ObjectSelectLongOpDecodeError> {
        let state = &op.private_state;
        if state.len() < 8 {
            return Err(ObjectSelectLongOpDecodeError::UnexpectedPayloadLength {
                observed: state.len(),
                minimum: 8,
            });
        }
        let flags = state[2];
        if flags & !OBJECT_SELECT_FLAG_CANCELABLE != 0 {
            return Err(ObjectSelectLongOpDecodeError::UnknownFlags { observed: flags });
        }
        let index = u16::from_le_bytes([state[4], state[5]]);
        let tag = state[3];
        let outcome = match tag {
            0 => {
                if index != 0 {
                    return Err(ObjectSelectLongOpDecodeError::ReservedOutcomeIndex { tag, index });
                }
                ObjectSelectOutcome::Pending
            }
            1 => ObjectSelectOutcome::DisplayIndex(index),
            2 => {
                if index != 0 {
                    return Err(ObjectSelectLongOpDecodeError::ReservedOutcomeIndex { tag, index });
                }
                if flags & OBJECT_SELECT_FLAG_CANCELABLE == 0 {
                    return Err(ObjectSelectLongOpDecodeError::CancelledWithoutCancelableFlag);
                }
                ObjectSelectOutcome::Cancelled
            }
            observed => return Err(ObjectSelectLongOpDecodeError::UnknownOutcomeTag { observed }),
        };
        let (return_values, _) = decode_object_values(state, 8)?;
        Ok(Self {
            id: op.id,
            return_values,
            flags,
            outcome,
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum ObjectSelectLongOpBuildError {
    TooManyReturnValues { observed: usize },
}

#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum ObjectSelectLongOpDecodeError {
    #[error(
        "utsushi.reallive.rlop.object_select.payload_length: observed={observed} minimum={minimum}"
    )]
    UnexpectedPayloadLength { observed: usize, minimum: usize },
    #[error(
        "utsushi.reallive.rlop.object_select.magic_mismatch: observed=0x{observed:02x} expected=0x{expected:02x}"
    )]
    MagicMismatch { observed: u8, expected: u8 },
    #[error("utsushi.reallive.rlop.object_select.unsupported_version: observed={observed}")]
    UnsupportedVersion { observed: u8 },
    #[error(
        "utsushi.reallive.rlop.object_select.values_length: observed={observed} expected={expected}"
    )]
    ValuesLengthMismatch { observed: usize, expected: usize },
    #[error("utsushi.reallive.rlop.object_select.flags: observed=0x{observed:02x}")]
    UnknownFlags { observed: u8 },
    #[error("utsushi.reallive.rlop.object_select.outcome_tag: observed={observed}")]
    UnknownOutcomeTag { observed: u8 },
    #[error("utsushi.reallive.rlop.object_select.reserved_outcome_index: tag={tag} index={index}")]
    ReservedOutcomeIndex { tag: u8, index: u16 },
    #[error("utsushi.reallive.rlop.object_select.cancelled_without_cancelable_flag")]
    CancelledWithoutCancelableFlag,
}

fn decode_object_values(
    state: &[u8],
    header_len: usize,
) -> Result<(Vec<i32>, Option<u16>), ObjectSelectLongOpDecodeError> {
    if state.len() < header_len {
        return Err(ObjectSelectLongOpDecodeError::UnexpectedPayloadLength {
            observed: state.len(),
            minimum: header_len,
        });
    }
    let count_offset = header_len - 2;
    let count = u16::from_le_bytes([state[count_offset], state[count_offset + 1]]) as usize;
    let expected = header_len + count * 4;
    if state.len() != expected {
        return Err(ObjectSelectLongOpDecodeError::ValuesLengthMismatch {
            observed: state.len(),
            expected,
        });
    }
    let values = state[header_len..]
        .chunks_exact(4)
        .map(|bytes| i32::from_le_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]))
        .collect();
    let selected = (header_len == 6)
        .then(|| u16::from_le_bytes([state[2], state[3]]))
        .filter(|index| *index != ObjectSelectLongOp::SELECTED_SENTINEL_PENDING);
    Ok((values, selected))
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

/// Deterministic choice policy for the [`HeadlessInputScheduler`].
///
/// Every variant is reproducible: given the same scene bytecode and the
/// same policy, a headless replay makes byte-identical choices on every
/// run.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum HeadlessChoicePolicy {
    /// Always select the first option (index `0`). The default — the
    /// simplest reproducible policy, and the one that reaches a scene's
    /// natural terminus down its first-choice spine.
    AlwaysFirst,
    /// Always select a fixed index (clamped to the last option when the
    /// prompt offers fewer choices).
    Fixed(u16),
    /// A scripted sequence of indices, consumed one per choice prompt in
    /// order; once exhausted, falls back to index `0`. Lets a test drive
    /// a specific branch spine deterministically.
    Scripted(Vec<u16>),
}

impl HeadlessChoicePolicy {
    /// Resolve the chosen index for a prompt of `choice_count` options,
    /// advancing any internal cursor. Always returns an in-range index
    /// (or `0` for an empty prompt).
    ///
    /// Public so the interactive [`crate::input_bridge::HeadlessSource`]
    /// resolves a choice through the SAME deterministic policy the
    /// [`HeadlessInputScheduler`] uses — the two paths must never diverge.
    pub fn resolve(&self, cursor: usize, choice_count: usize) -> u16 {
        let raw = match self {
            Self::AlwaysFirst => 0u16,
            Self::Fixed(index) => *index,
            Self::Scripted(seq) => seq.get(cursor).copied().unwrap_or(0),
        };
        if choice_count == 0 {
            return 0;
        }
        let ceiling = (choice_count - 1) as u16;
        raw.min(ceiling)
    }
}

/// Deterministic HEADLESS input-provider: the substrate
/// [`LongOpScheduler`] that lets a real branch-following replay run its
/// ACTUAL control flow to a natural terminus with no interactive input.
///
/// Every input-gated yield a real VN scene produces is resolved
/// deterministically:
///
/// - **Pause / wait-for-click** ([`PauseLongOp`], magic
///   [`PAUSE_PRIVATE_STATE_MAGIC`]) — auto-dismissed, resumes immediately
///   ([`LongOpReadiness::Ready`]). This clears the text/pause/wait yields
///   that would otherwise `BudgetExhausted` a headless walk.
/// - **Choice / selection** ([`SelectLongOp`], magic
///   [`SELECT_PRIVATE_STATE_MAGIC`]) — resolved by the configured
///   [`HeadlessChoicePolicy`] (default: always the first option). The
///   chosen index is written into the head's private state (exactly as
///   [`crate::rlop::ChoiceInputScheduler`] does for real input) before
///   `Ready`, so the VM's resume path records it into the store register
///   and downstream `goto_on` / `goto_case` branches deterministically.
/// - **Any other longop shape** — resumed immediately; there is nothing a
///   headless walk can gate on, and refusing would deadlock.
///
/// The provider is byte-deterministic and reproducible: it holds no
/// clock, no RNG, no host input — only the policy and a scripted-choice
/// cursor. It counts the pauses it dismissed and the choices it made so a
/// driver can prove real input-gating was exercised.
#[derive(Debug)]
pub struct HeadlessInputScheduler {
    policy: HeadlessChoicePolicy,
    choice_cursor: usize,
    pauses_advanced: u64,
    choices_made: u64,
    other_advanced: u64,
}

impl Default for HeadlessInputScheduler {
    fn default() -> Self {
        Self::new(HeadlessChoicePolicy::AlwaysFirst)
    }
}

impl HeadlessInputScheduler {
    /// Build a scheduler driving choices by `policy`.
    pub fn new(policy: HeadlessChoicePolicy) -> Self {
        Self {
            policy,
            choice_cursor: 0,
            pauses_advanced: 0,
            choices_made: 0,
            other_advanced: 0,
        }
    }

    /// Number of pause / wait-for-click yields auto-dismissed so far.
    pub fn pauses_advanced(&self) -> u64 {
        self.pauses_advanced
    }

    /// Number of choice prompts resolved so far.
    pub fn choices_made(&self) -> u64 {
        self.choices_made
    }

    /// Number of other (non-pause, non-select) longops auto-resumed.
    pub fn other_advanced(&self) -> u64 {
        self.other_advanced
    }
}

impl LongOpScheduler for HeadlessInputScheduler {
    fn poll(&mut self, head: &mut LongOp) -> LongOpReadiness {
        match head.private_state.first().copied() {
            Some(PAUSE_PRIVATE_STATE_MAGIC) => {
                // Auto-dismiss the pause and resume.
                if let Ok(mut pause) = PauseLongOp::try_from_longop(head) {
                    pause.mark_dismissed();
                    let dismissed = pause.into_longop();
                    head.private_state = dismissed.private_state;
                }
                self.pauses_advanced = self.pauses_advanced.saturating_add(1);
                LongOpReadiness::Ready
            }
            Some(SELECT_PRIVATE_STATE_MAGIC) => {
                if let Ok(mut select) = SelectLongOp::try_from_longop(head) {
                    let index = self
                        .policy
                        .resolve(self.choice_cursor, select.choice_count());
                    select.choose(index);
                    let LongOp { id, private_state } = select.into_longop();
                    head.id = id;
                    head.private_state = private_state;
                    self.choice_cursor += 1;
                    self.choices_made = self.choices_made.saturating_add(1);
                } else {
                    // A select-magic payload that will not decode is
                    // malformed; resume anyway (the VM emits a typed
                    // ChoiceResumeMalformed warning) so the headless walk
                    // never deadlocks on it.
                    self.other_advanced = self.other_advanced.saturating_add(1);
                }
                LongOpReadiness::Ready
            }
            Some(OBJECT_SELECT_PRIVATE_STATE_MAGIC) => {
                if let Ok(mut select) = ObjectSelectLongOp::try_from_longop(head) {
                    let index = self
                        .policy
                        .resolve(self.choice_cursor, select.choice_count());
                    select.select(index);
                    let LongOp { id, private_state } = select.into_longop();
                    head.id = id;
                    head.private_state = private_state;
                    self.choice_cursor += 1;
                    self.choices_made = self.choices_made.saturating_add(1);
                } else {
                    self.other_advanced = self.other_advanced.saturating_add(1);
                }
                LongOpReadiness::Ready
            }
            _ => {
                self.other_advanced = self.other_advanced.saturating_add(1);
                LongOpReadiness::Ready
            }
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
    fn object_select_wire_is_bounded_and_round_trips() {
        assert!(matches!(
            ObjectSelectLongOp::try_new(LongOpId(5), vec![0; u16::MAX as usize + 1]),
            Err(ObjectSelectLongOpBuildError::TooManyReturnValues { .. })
        ));
        let mut select = ObjectSelectLongOp::try_new(LongOpId(6), vec![7, -2]).expect("bounded");
        select.set_cancelable(true);
        select.select(1);
        let longop = select.into_longop();
        assert_eq!(
            longop.private_state[..8],
            [OBJECT_SELECT_PRIVATE_STATE_MAGIC, 2, 1, 1, 1, 0, 2, 0]
        );
        let decoded = ObjectSelectLongOp::try_from_longop(&longop).expect("decode");
        assert_eq!(decoded.return_values(), &[7, -2]);
        assert!(decoded.is_cancelable());
        assert_eq!(decoded.outcome(), ObjectSelectOutcome::DisplayIndex(1));
        let mut cancelled = decoded;
        cancelled.cancel();
        assert_eq!(
            ObjectSelectLongOp::try_from_longop(&cancelled.into_longop())
                .expect("decode")
                .outcome(),
            ObjectSelectOutcome::Cancelled
        );
        let v1 = LongOp::new(
            LongOpId(7),
            vec![0xA3, 1, 1, 0, 2, 0, 7, 0, 0, 0, 2, 0, 0, 0],
        );
        let v1 = ObjectSelectLongOp::try_from_longop(&v1).expect("v1 decode");
        assert_eq!(v1.flags(), 0);
        assert_eq!(v1.outcome(), ObjectSelectOutcome::DisplayIndex(1));

        let decode = |state| ObjectSelectLongOp::try_from_longop(&LongOp::new(LongOpId(8), state));
        assert!(matches!(
            decode(vec![0xA3, 2, 0, 0, 1, 0, 0, 0]),
            Err(ObjectSelectLongOpDecodeError::ReservedOutcomeIndex { tag: 0, index: 1 })
        ));
        assert!(matches!(
            decode(vec![0xA3, 2, 1, 2, 1, 0, 0, 0]),
            Err(ObjectSelectLongOpDecodeError::ReservedOutcomeIndex { tag: 2, index: 1 })
        ));
        assert!(matches!(
            decode(vec![0xA3, 2, 0, 2, 0, 0, 0, 0]),
            Err(ObjectSelectLongOpDecodeError::CancelledWithoutCancelableFlag)
        ));
        assert!(matches!(
            decode(vec![0xA3, 2, 2, 0, 0, 0, 0, 0]),
            Err(ObjectSelectLongOpDecodeError::UnknownFlags { observed: 2 })
        ));
        assert!(matches!(
            decode(vec![0xA3, 2, 0, 3, 0, 0, 0, 0]),
            Err(ObjectSelectLongOpDecodeError::UnknownOutcomeTag { observed: 3 })
        ));
        assert!(matches!(
            decode(vec![0xA3, 3]),
            Err(ObjectSelectLongOpDecodeError::UnsupportedVersion { observed: 3 })
        ));
    }

    #[test]
    fn selection_choice_count_scheduler_observes_pending_then_ready() {
        let mut scheduler = SelectionChoiceCountScheduler::new(2);
        let mut op = LongOp::new(LongOpId(1), vec![]);
        assert_eq!(scheduler.poll(&mut op), LongOpReadiness::Pending);
        assert_eq!(scheduler.poll(&mut op), LongOpReadiness::Pending);
        assert_eq!(scheduler.poll(&mut op), LongOpReadiness::Ready);
    }

    #[test]
    fn headless_scheduler_auto_dismisses_pause() {
        let mut sched = HeadlessInputScheduler::default();
        let mut head = PauseLongOp::new(LongOpId(1)).into_longop();
        assert_eq!(sched.poll(&mut head), LongOpReadiness::Ready);
        // The pause is now dismissed in the head's private state.
        assert!(
            PauseLongOp::try_from_longop(&head)
                .expect("decode")
                .dismissed()
        );
        assert_eq!(sched.pauses_advanced(), 1);
        assert_eq!(sched.choices_made(), 0);
    }

    #[test]
    fn headless_scheduler_always_first_picks_index_zero() {
        let mut sched = HeadlessInputScheduler::new(HeadlessChoicePolicy::AlwaysFirst);
        let mut head = SelectLongOp::new(
            LongOpId(2),
            vec![b"a".to_vec(), b"b".to_vec(), b"c".to_vec()],
        )
        .into_longop();
        assert_eq!(sched.poll(&mut head), LongOpReadiness::Ready);
        assert_eq!(
            SelectLongOp::try_from_longop(&head)
                .expect("decode")
                .chosen(),
            Some(0)
        );
        assert_eq!(sched.choices_made(), 1);
    }

    #[test]
    fn headless_scheduler_fixed_clamps_to_last_option() {
        let mut sched = HeadlessInputScheduler::new(HeadlessChoicePolicy::Fixed(9));
        let mut head =
            SelectLongOp::new(LongOpId(3), vec![b"a".to_vec(), b"b".to_vec()]).into_longop();
        assert_eq!(sched.poll(&mut head), LongOpReadiness::Ready);
        // Clamped to the last option (index 1) rather than out-of-range 9.
        assert_eq!(
            SelectLongOp::try_from_longop(&head)
                .expect("decode")
                .chosen(),
            Some(1)
        );
    }

    #[test]
    fn headless_scheduler_scripted_consumes_in_order_then_falls_back() {
        let mut sched = HeadlessInputScheduler::new(HeadlessChoicePolicy::Scripted(vec![2, 1]));
        let choices = vec![b"a".to_vec(), b"b".to_vec(), b"c".to_vec()];
        // First prompt → 2, second → 1, third (exhausted) → 0.
        for expected in [2u16, 1, 0] {
            let mut head = SelectLongOp::new(LongOpId(4), choices.clone()).into_longop();
            assert_eq!(sched.poll(&mut head), LongOpReadiness::Ready);
            assert_eq!(
                SelectLongOp::try_from_longop(&head)
                    .expect("decode")
                    .chosen(),
                Some(expected)
            );
        }
        assert_eq!(sched.choices_made(), 3);
    }

    #[test]
    fn headless_scheduler_resumes_unknown_longop_shape() {
        let mut sched = HeadlessInputScheduler::default();
        let mut head = LongOp::new(LongOpId(5), vec![0xEE, 0x00]);
        assert_eq!(sched.poll(&mut head), LongOpReadiness::Ready);
        assert_eq!(sched.other_advanced(), 1);
    }

    #[test]
    fn headless_scheduler_is_deterministic_across_identical_drives() {
        let run = || {
            let mut sched = HeadlessInputScheduler::new(HeadlessChoicePolicy::Fixed(1));
            let mut picks = Vec::new();
            for _ in 0..3 {
                let mut head = ObjectSelectLongOp::try_new(LongOpId(6), vec![7, 2])
                    .expect("bounded")
                    .into_longop();
                sched.poll(&mut head);
                picks.push(
                    ObjectSelectLongOp::try_from_longop(&head)
                        .expect("decode")
                        .outcome(),
                );
            }
            picks
        };
        assert_eq!(run(), vec![ObjectSelectOutcome::DisplayIndex(1); 3]);
        assert_eq!(run(), run());
    }
}
