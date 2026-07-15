use kaifuu_core::RedactedContentSummary;

use crate::encoding::decode_shift_jis_slot;

use super::{
    GameexeIniDiagnostic, GameexeInventoryEntry, GameexeInventoryReport, GameexeKeyTreatment,
    UNKNOWN_GAMEEXE_KEY_CODE, classify_key,
};

/// Parse a Gameexe.ini blob into one inventory entry per recognized line.
/// The parser is forgiving: it splits on `\n` (consuming any preceding
/// `\r`) and accepts both `#KEY=VALUE` and `#KEY VALUE` shapes. Empty
/// lines and lines without a leading `#` are ignored.
pub fn parse_gameexe_inventory(bytes: &[u8]) -> GameexeInventoryReport {
    let mut entries = Vec::new();
    let mut warnings = Vec::new();
    let mut cursor: usize = 0;
    let mut line_number: u64 = 0;
    while cursor < bytes.len() {
        line_number += 1;
        let line_start = cursor;
        // Find the end of this line (newline or EOF).
        let mut newline = cursor;
        while newline < bytes.len() && bytes[newline] != b'\n' {
            newline += 1;
        }
        let mut line_end = newline;
        // Trim trailing `\r` from the line bytes (CRLF support).
        if line_end > line_start && bytes[line_end - 1] == b'\r' {
            line_end -= 1;
        }
        let line_bytes = &bytes[line_start..line_end];
        cursor = (newline + 1).min(bytes.len() + 1);
        if cursor > bytes.len() {
            cursor = bytes.len();
        }

        // Skip empties / non-key lines.
        let trimmed = trim_leading_ascii_ws(line_bytes);
        if trimmed.is_empty() || trimmed[0] != b'#' {
            continue;
        }

        // Split the line at the first `=` or whitespace into key/value.
        let (key_bytes, value_bytes) = split_key_value(trimmed);
        let key = String::from_utf8_lossy(key_bytes)
            .to_string()
            .to_uppercase();
        let value_decoded = decode_shift_jis_slot(value_bytes).text;
        let value = trim_inline_value(&value_decoded);

        let (family, treatment) = classify_key(&key, &value);
        if treatment == GameexeKeyTreatment::Unknown {
            let key_summary = RedactedContentSummary::from_text(&key);
            warnings.push(GameexeIniDiagnostic {
                code: UNKNOWN_GAMEEXE_KEY_CODE.to_string(),
                line_number,
                key: key.clone(),
                message: format!(
                    "Gameexe.ini key {key_summary} is not in the documented RealLive key surface \
                     (documented key catalogue); recording with typed UnknownReason"
                ),
            });
        }

        entries.push(GameexeInventoryEntry {
            line_number,
            byte_offset: line_start as u64,
            byte_len: (line_end - line_start) as u64,
            key,
            value,
            treatment,
            family,
        });
    }
    GameexeInventoryReport { entries, warnings }
}

fn trim_leading_ascii_ws(bytes: &[u8]) -> &[u8] {
    let mut start = 0;
    while start < bytes.len() && bytes[start].is_ascii_whitespace() {
        start += 1;
    }
    &bytes[start..]
}

fn split_key_value(bytes: &[u8]) -> (&[u8], &[u8]) {
    let mut key_end = 0;
    while key_end < bytes.len() {
        let byte = bytes[key_end];
        if byte == b'=' || byte.is_ascii_whitespace() {
            break;
        }
        key_end += 1;
    }
    let key = &bytes[..key_end];
    let mut value_start = key_end;
    while value_start < bytes.len()
        && (bytes[value_start] == b'=' || bytes[value_start].is_ascii_whitespace())
    {
        value_start += 1;
    }
    let value = if value_start <= bytes.len() {
        &bytes[value_start..]
    } else {
        &[]
    };
    (key, value)
}

/// Trim a decoded raw value: strip the wrapping `"…"` when present and
/// the value is a single quoted-string declaration, otherwise return the
/// raw decoded text as-is. Triple-equals lines (`#NAMAE`, `#FOLDNAME`,
/// `#SE.*`, `#DSTRACK`) keep the full RHS so downstream tuple parsers
/// can re-split.
fn trim_inline_value(decoded: &str) -> String {
    let trimmed = decoded.trim();
    if trimmed.starts_with('"') && trimmed.ends_with('"') && trimmed.len() >= 2 {
        // Only strip when there's exactly one pair of quotes (no inner
        // `"=…="` triple-equals shape).
        let inner = &trimmed[1..trimmed.len() - 1];
        if !inner.contains('"') {
            return inner.to_string();
        }
    }
    trimmed.to_string()
}
