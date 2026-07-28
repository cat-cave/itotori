use crate::scene_runtime::SoftpalRuntimeError;
use kaifuu_softpal::RawCommand;

/// Parse `POINT.DAT`: offsets are relative to the code header and reverse-ordered.
pub(crate) fn point_offsets(bytes: &[u8]) -> Result<Vec<usize>, SoftpalRuntimeError> {
    if bytes.len() < 16 || !matches!(&bytes[..16], b"$POINT_LIST_****" | b"_POINT_LIST_****") {
        return Err(SoftpalRuntimeError::InvalidPointTable);
    }
    let encrypted = bytes[0] == b'$'
        && bytes.get(16..20).is_some_and(|word| {
            u32::from_le_bytes(word.try_into().expect("four bytes")) & 0xff00_0000 != 0
        });
    let mut offsets = Vec::new();
    let mut shift = 4u32;
    for chunk in bytes[16..].chunks_exact(4) {
        let mut raw = u32::from_le_bytes(chunk.try_into().expect("four bytes"));
        if encrypted {
            let mut parts = raw.to_le_bytes();
            parts[0] = parts[0].rotate_left(shift);
            raw = u32::from_le_bytes(parts) ^ 0x084d_f873 ^ 0xff98_7dee;
            shift = (shift + 1) % 8;
        }
        offsets
            .push(usize::try_from(raw).map_err(|_| SoftpalRuntimeError::InvalidPointTable)? + 12);
    }
    offsets.reverse();
    Ok(offsets)
}

pub(super) fn command_call_offset(command: &RawCommand) -> usize {
    match command {
        RawCommand::TextShow { command_offset, .. } => command_offset + 24,
        RawCommand::Select { command_offset, .. } => command_offset + 8,
    }
}

pub(super) fn sign_extend_28(raw: u32) -> i32 {
    ((raw & 0x0fff_ffff) as i32) << 4 >> 4
}
