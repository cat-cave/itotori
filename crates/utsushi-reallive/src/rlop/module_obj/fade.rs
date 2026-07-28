use super::types::*;
use crate::rlop::{LongOp, LongOpId};
use serde::{Deserialize, Serialize};
use thiserror::Error;

/// Typed wrapper around the `Fade` private state. Carries the alpha
/// endpoints and the total tick count the substrate scheduler will
/// advance through.
///
/// # Payload shape
///
/// `[FADE_PRIVATE_STATE_MAGIC (1B), starting_alpha (1B), target_alpha
/// (1B), total_ticks_LE (8B), elapsed_ticks_LE (8B)]` — 19 bytes total.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct FadeLongOp {
    id: LongOpId,
    starting_alpha: u8,
    target_alpha: u8,
    total_ticks: u64,
    elapsed_ticks: u64,
}

impl FadeLongOp {
    pub const PAYLOAD_BYTE_LEN: usize = 19;

    /// Build a fresh fade longop. The `elapsed_ticks` field starts at
    /// `0`; the scheduler increments it through [`Self::advance`] and
    /// then re-encodes the payload through [`Self::write_into_payload`].
    pub fn new(id: LongOpId, starting_alpha: u8, target_alpha: u8, total_ticks: u64) -> Self {
        Self {
            id,
            starting_alpha,
            target_alpha,
            total_ticks,
            elapsed_ticks: 0,
        }
    }

    pub fn id(&self) -> LongOpId {
        self.id
    }

    pub fn starting_alpha(&self) -> u8 {
        self.starting_alpha
    }

    pub fn target_alpha(&self) -> u8 {
        self.target_alpha
    }

    pub fn total_ticks(&self) -> u64 {
        self.total_ticks
    }

    pub fn elapsed_ticks(&self) -> u64 {
        self.elapsed_ticks
    }

    /// Whether the fade has run its full tick budget.
    pub fn is_complete(&self) -> bool {
        self.elapsed_ticks >= self.total_ticks
    }

    /// Linear-interpolated alpha for the current elapsed ticks. Pinned
    /// so the substrate-honest "no float drift" guarantee holds.
    pub fn current_alpha(&self) -> u8 {
        if self.total_ticks == 0 || self.is_complete() {
            return self.target_alpha;
        }
        let start = self.starting_alpha as i64;
        let target = self.target_alpha as i64;
        let elapsed = self.elapsed_ticks as i64;
        let total = self.total_ticks as i64;
        // value = start + (target - start) * elapsed / total
        let span = target - start;
        let delta = span * elapsed / total;
        let value = start + delta;
        value.clamp(0, 255) as u8
    }

    /// Advance the fade by `ticks` ticks. Saturates at `total_ticks`.
    pub fn advance(&mut self, ticks: u64) {
        self.elapsed_ticks = self
            .elapsed_ticks
            .saturating_add(ticks)
            .min(self.total_ticks);
    }

    /// Encode the wrapper into a [`LongOp`] carrier.
    pub fn into_longop(self) -> LongOp {
        let mut payload = Vec::with_capacity(Self::PAYLOAD_BYTE_LEN);
        payload.push(FADE_PRIVATE_STATE_MAGIC);
        payload.push(self.starting_alpha);
        payload.push(self.target_alpha);
        payload.extend_from_slice(&self.total_ticks.to_le_bytes());
        payload.extend_from_slice(&self.elapsed_ticks.to_le_bytes());
        LongOp::new(self.id, payload)
    }

    /// Decode a payload back into a `FadeLongOp`. Returns a typed error
    /// on length or magic mismatch.
    pub fn try_from_payload(id: LongOpId, payload: &[u8]) -> Result<Self, FadeLongOpDecodeError> {
        if payload.len() != Self::PAYLOAD_BYTE_LEN {
            return Err(FadeLongOpDecodeError::UnexpectedPayloadLength {
                observed: payload.len(),
                expected: Self::PAYLOAD_BYTE_LEN,
            });
        }
        if payload[0] != FADE_PRIVATE_STATE_MAGIC {
            return Err(FadeLongOpDecodeError::MagicMismatch {
                observed: payload[0],
                expected: FADE_PRIVATE_STATE_MAGIC,
            });
        }
        let starting_alpha = payload[1];
        let target_alpha = payload[2];
        let total_ticks = u64::from_le_bytes(payload[3..11].try_into().expect("11-3=8"));
        let elapsed_ticks = u64::from_le_bytes(payload[11..19].try_into().expect("19-11=8"));
        Ok(Self {
            id,
            starting_alpha,
            target_alpha,
            total_ticks,
            elapsed_ticks,
        })
    }
}

/// Typed decode error for [`FadeLongOp::try_from_payload`].
#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum FadeLongOpDecodeError {
    #[error("utsushi.reallive.rlop.fade.payload_length: observed={observed} expected={expected}")]
    UnexpectedPayloadLength { observed: usize, expected: usize },
    #[error(
        "utsushi.reallive.rlop.fade.magic_mismatch: observed=0x{observed:02x} expected=0x{expected:02x}"
    )]
    MagicMismatch { observed: u8, expected: u8 },
}
