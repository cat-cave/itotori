//! PCM-channel state recovered from the form-44 command path.

use super::model::{PcmChannelState, Value, VmError, VmState};

const FORM_PCMCH: i32 = 44;
const ELM_ARRAY: i32 = -1;
const PCMCH_STOP: i32 = 5;

/// Dispatch the exact PCMCH chain shape used by the compiler:
/// `PCMCH[-1][channel][operation]`.
///
/// `None` means this was not a PCMCH target. A recognised-but-unimplemented
/// PCMCH operation returns a terminal diagnostic; it must never advance the
/// program counter as a harmless no-op.
pub(super) fn command(
    state: &mut VmState,
    values: &[Value],
    args: &[Value],
    offset: usize,
    scene_id: u32,
) -> Result<Option<Value>, VmError> {
    let chain = values
        .iter()
        .map(|value| match value {
            Value::Int(value) => Some(*value),
            _ => None,
        })
        .collect::<Option<Vec<_>>>();
    let Some([FORM_PCMCH, ELM_ARRAY, channel, operation]) = chain.as_deref() else {
        return Ok(None);
    };
    if *channel < 0 {
        return Err(unsupported(scene_id, offset, "pcmch-channel"));
    }
    if *operation != PCMCH_STOP {
        return Err(unsupported(scene_id, offset, "pcmch-command"));
    }
    let stop_fade = args
        .first()
        .map(|value| match value {
            Value::Int(value) => Ok(*value),
            _ => Err(unsupported(scene_id, offset, "pcmch-stop-arguments")),
        })
        .transpose()?;
    state.pcm_channels.insert(
        *channel,
        PcmChannelState {
            stopped: true,
            stop_fade,
        },
    );
    Ok(Some(Value::Int(0)))
}

fn unsupported(scene_id: u32, offset: usize, operation: &'static str) -> VmError {
    VmError::UnsupportedOperation {
        scene_id,
        offset,
        operation,
    }
}
