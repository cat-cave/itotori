use super::*;

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
            outcome: selected.map_or(
                ObjectSelectOutcome::Pending,
                ObjectSelectOutcome::DisplayIndex,
            ),
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
