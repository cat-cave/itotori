use super::{PatchbackEncoding, PatchbackError};

#[derive(Debug, Clone)]
pub(super) struct StringSlot {
    pub(super) index: i32,
    pub(super) char_offset: i32,
    pub(super) char_len: i32,
    pub(super) byte_offset: usize,
}

pub(super) fn parse_slots(
    decoded: &[u8],
    scene_id: u32,
) -> Result<Vec<StringSlot>, PatchbackError> {
    let (index_list, string_base) = layout(decoded, scene_id)?;
    let count = header_i32(decoded, 4, scene_id, "string index count")?;
    let declared_count = header_i32(decoded, 6, scene_id, "string count")?;
    if count < 0 || declared_count < 0 || count != declared_count {
        return Err(scene_error(
            scene_id,
            "string index count and string count disagree",
        ));
    }
    let mut slots = Vec::with_capacity(count as usize);
    for index in 0..count as usize {
        let at = index_list + index * 8;
        let char_offset =
            read_i32(decoded, at).ok_or_else(|| scene_error(scene_id, "truncated string index"))?;
        let char_len = read_i32(decoded, at + 4)
            .ok_or_else(|| scene_error(scene_id, "truncated string length"))?;
        if char_offset < 0 || char_len < 0 {
            return Err(scene_error(scene_id, "negative string index coordinate"));
        }
        let byte_offset = string_base
            .checked_add(char_offset as usize * 2)
            .ok_or_else(|| scene_error(scene_id, "string byte offset overflow"))?;
        byte_offset
            .checked_add(char_len as usize * 2)
            .filter(|end| *end <= decoded.len())
            .ok_or_else(|| scene_error(scene_id, "string span runs past decoded scene"))?;
        slots.push(StringSlot {
            index: index as i32,
            char_offset,
            char_len,
            byte_offset,
        });
    }
    Ok(slots)
}

pub(super) fn layout(decoded: &[u8], scene_id: u32) -> Result<(usize, usize), PatchbackError> {
    let index_list = header_i32(decoded, 3, scene_id, "string index offset")?;
    let string_base = header_i32(decoded, 5, scene_id, "string data offset")?;
    if index_list < 0 || string_base < 0 {
        return Err(scene_error(
            scene_id,
            "negative string-table header coordinate",
        ));
    }
    Ok((index_list as usize, string_base as usize))
}

pub(super) fn decode(decoded: &[u8], slot: &StringSlot) -> Option<String> {
    let raw = decoded.get(slot.byte_offset..slot.byte_offset + slot.char_len as usize * 2)?;
    let key = 28_807u16.wrapping_mul(slot.index as u16);
    let units = raw
        .chunks_exact(2)
        .map(|pair| u16::from_le_bytes([pair[0], pair[1]]) ^ key)
        .take_while(|unit| *unit != 0)
        .collect::<Vec<_>>();
    Some(String::from_utf16_lossy(&units))
}

pub(super) fn encode(
    text: &str,
    index: i32,
    encoding: PatchbackEncoding,
    scene_id: u32,
) -> Result<(Vec<u8>, i32), PatchbackError> {
    let mut units = text.encode_utf16().collect::<Vec<_>>();
    units.push(0);
    let char_len = i32::try_from(units.len())
        .map_err(|_| scene_error(scene_id, "target UTF-16 length exceeds i32"))?;
    let key = 28_807u16.wrapping_mul(index as u16);
    let mut bytes = Vec::with_capacity(units.len() * 2);
    match encoding {
        PatchbackEncoding::Utf16Le => {
            for unit in units {
                bytes.extend_from_slice(&(unit ^ key).to_le_bytes());
            }
        }
    }
    Ok((bytes, char_len))
}

fn header_i32(
    decoded: &[u8],
    field: usize,
    scene_id: u32,
    label: &str,
) -> Result<i32, PatchbackError> {
    read_i32(decoded, field * 4)
        .ok_or_else(|| scene_error(scene_id, format!("truncated scene header at {label}")))
}

fn read_i32(bytes: &[u8], offset: usize) -> Option<i32> {
    let slice = bytes.get(offset..offset.checked_add(4)?);
    slice.map(|slice| i32::from_le_bytes([slice[0], slice[1], slice[2], slice[3]]))
}

fn scene_error(scene_id: u32, message: impl Into<String>) -> PatchbackError {
    PatchbackError::SceneReencode {
        scene_id,
        message: message.into(),
    }
}
