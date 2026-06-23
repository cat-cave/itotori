//! Gameexe.ini Shift-JIS line walker.
//!
//! Clean-room provenance (KAIFUU-174):
//! - The inclusion rules for user-visible keys (`#TITLE`, `#WINTITLE`,
//!   `#REGNAME` as asset reference, `#G00*`/`#KOE*`/`#SEEN*`/`#NWK*` as
//!   asset references) are derived from publicly archived Haeleth RLDEV
//!   documentation. No expression is copied from rlvm.
//! - Non-catalogue keys emit a
//!   `kaifuu.reallive.inventory.unknown_gameexe_key` warning and are
//!   recorded as asset references with `kind = Unknown` so no byte is
//!   silently dropped.

use serde::{Deserialize, Serialize};

use crate::encoding::decode_shift_jis_slot;

/// Stable warning code emitted for non-catalogue Gameexe.ini keys.
pub const UNKNOWN_GAMEEXE_KEY_CODE: &str = "kaifuu.reallive.inventory.unknown_gameexe_key";

/// One Gameexe.ini entry classified for the inventory layer.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GameexeInventoryEntry {
    /// 1-based line number.
    pub line_number: u64,
    /// Byte offset of the line within the file.
    pub byte_offset: u64,
    /// Byte length of the line (excluding the terminator).
    pub byte_len: u64,
    pub key: String,
    pub value: String,
    pub treatment: GameexeKeyTreatment,
}

/// Treatment of one Gameexe.ini entry.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum GameexeKeyTreatment {
    /// User-visible translatable metadata. Emitted as a BridgeUnit.
    BridgeUnit,
    /// Asset path / non-translatable metadata. Emitted as an
    /// AssetReference only.
    AssetReference,
    /// Non-catalogue key. Warning is paired in `GameexeInventoryReport`.
    Unknown,
}

/// Warning emitted by [`parse_gameexe_inventory`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GameexeIniDiagnostic {
    pub code: String,
    pub line_number: u64,
    pub key: String,
    pub message: String,
}

/// Output of [`parse_gameexe_inventory`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GameexeInventoryReport {
    pub entries: Vec<GameexeInventoryEntry>,
    pub warnings: Vec<GameexeIniDiagnostic>,
}

/// Parse a Gameexe.ini blob into one inventory entry per recognized line.
///
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
        let key = String::from_utf8_lossy(key_bytes).to_string().to_uppercase();
        let value_decoded = decode_shift_jis_slot(value_bytes).text;
        let value = value_decoded.trim_matches('"').to_string();

        let treatment = classify_key(&key);
        if treatment == GameexeKeyTreatment::Unknown {
            warnings.push(GameexeIniDiagnostic {
                code: UNKNOWN_GAMEEXE_KEY_CODE.to_string(),
                line_number,
                key: key.clone(),
                message: format!(
                    "Gameexe.ini key {key} is not in the documented user-visible / asset \
                     catalogue; recording as AssetReference (Unknown) with warning"
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

fn classify_key(key: &str) -> GameexeKeyTreatment {
    if key == "#WINTITLE" || key == "#TITLE" {
        return GameexeKeyTreatment::BridgeUnit;
    }
    if key == "#REGNAME" || key == "#GAMEEXE_VERSION" {
        return GameexeKeyTreatment::AssetReference;
    }
    if key.starts_with("#G00")
        || key.starts_with("#KOE")
        || key.starts_with("#SEEN")
        || key.starts_with("#NWK")
        || key.starts_with("#OVK")
    {
        return GameexeKeyTreatment::AssetReference;
    }
    GameexeKeyTreatment::Unknown
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_wintitle_as_bridge_unit() {
        let ini = b"#WINTITLE=\"Test Title\"\n";
        let report = parse_gameexe_inventory(ini);
        assert_eq!(report.entries.len(), 1);
        assert_eq!(report.entries[0].key, "#WINTITLE");
        assert_eq!(report.entries[0].value, "Test Title");
        assert_eq!(report.entries[0].treatment, GameexeKeyTreatment::BridgeUnit);
        assert!(report.warnings.is_empty());
    }

    #[test]
    fn parses_g00_key_as_asset_reference() {
        let ini = b"#G00BUF=8\n#KOEPAC=koe.ovk\n";
        let report = parse_gameexe_inventory(ini);
        assert_eq!(report.entries.len(), 2);
        assert!(report
            .entries
            .iter()
            .all(|e| e.treatment == GameexeKeyTreatment::AssetReference));
    }

    #[test]
    fn emits_unknown_gameexe_key_warning_for_non_catalogue_key() {
        let ini = b"#WEIRDKEY=42\n";
        let report = parse_gameexe_inventory(ini);
        assert_eq!(report.warnings.len(), 1);
        assert_eq!(report.warnings[0].code, UNKNOWN_GAMEEXE_KEY_CODE);
        assert_eq!(report.entries[0].treatment, GameexeKeyTreatment::Unknown);
    }

    #[test]
    fn handles_crlf_line_endings_and_blank_lines() {
        let ini = b"\r\n#TITLE=\"Hi\"\r\n\r\n#REGNAME=Tester\r\n";
        let report = parse_gameexe_inventory(ini);
        assert_eq!(report.entries.len(), 2);
        assert_eq!(report.entries[0].key, "#TITLE");
        assert_eq!(report.entries[1].key, "#REGNAME");
    }
}
