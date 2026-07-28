use crate::scene_runtime::SoftpalRuntimeError;
use kaifuu_softpal::RawCommand;
use std::collections::BTreeMap;

#[derive(Debug)]
pub(super) struct FileTable {
    pub(super) entries: Vec<i32>,
    pub(super) strings: BTreeMap<i32, String>,
}

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

pub(super) fn is_plausible_resource_name(value: &str) -> bool {
    !value.is_empty()
        && !value.starts_with('$')
        && !value.contains('*')
        && !value.contains("__3I")
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-' | b'#' | b'.'))
}

/// Parse the compact CSV table shape used by native `file_string`: integers
/// remain table values while quoted cells become high-bit string references.
/// A non-UTF8 asset is decoded lossily so an ASCII resource name can still be
/// observed, rather than turning an open handle into a fabricated empty table.
pub(super) fn parse_file_table(bytes: &[u8]) -> Option<FileTable> {
    let text = String::from_utf8_lossy(bytes);
    if !text.contains('"') && !text.contains(',') {
        return None;
    }
    let mut entries = Vec::new();
    let mut strings = BTreeMap::new();
    let mut string_offset = 0_i32;
    let mut cell = String::new();
    let mut in_quotes = false;
    let mut cells = Vec::new();
    for character in text.chars() {
        match character {
            '"' => {
                in_quotes = !in_quotes;
                cell.push(character);
            }
            ',' | '\n' if !in_quotes => {
                cells.push(std::mem::take(&mut cell));
            }
            _ => cell.push(character),
        }
    }
    if in_quotes {
        return None;
    }
    if !cell.trim().is_empty() {
        cells.push(cell);
    }
    for cell in cells {
        let token = cell.trim();
        if token.is_empty() || token.starts_with("//") {
            continue;
        }
        if let Some(value) = token
            .strip_prefix('"')
            .and_then(|value| value.strip_suffix('"'))
        {
            let value = value.replace("\"\"", "\"");
            entries.push((0x8000_0000_u32 | string_offset as u32) as i32);
            string_offset = string_offset.saturating_add(2 + value.len() as i32);
            strings.insert(string_offset - 2 - value.len() as i32, value);
        } else if let Ok(value) = token
            .strip_prefix("0x")
            .or_else(|| token.strip_prefix("0X"))
            .map_or_else(|| token.parse(), |hex| i32::from_str_radix(hex, 16))
        {
            entries.push(value);
        }
    }
    Some(FileTable { entries, strings })
}
