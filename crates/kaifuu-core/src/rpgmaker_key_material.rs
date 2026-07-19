//! Normalization for locally imported RPG Maker MV/MZ asset keys.
//!
//! The generic CLI key-import path decodes `--key-hex` before persisting it.
//! Earlier fixture stores predate that importer and persist hex text instead.
//! Accept both local-only representations at the resolver boundary, so the
//! caller sees one canonical byte sequence without exposing either form.

/// Decode hexadecimal text, tolerating conventional display separators.
pub(crate) fn decode_hex_material(text: &str) -> Option<Vec<u8>> {
    let compact = text
        .chars()
        .filter(|character| !matches!(character, ' ' | '\t' | '\n' | '\r' | ':' | '-'))
        .collect::<String>();
    if compact.is_empty() || compact.len() % 2 != 0 {
        return None;
    }

    let mut bytes = Vec::with_capacity(compact.len() / 2);
    for pair in compact.as_bytes().chunks_exact(2) {
        let high = hex_nibble(pair[0])?;
        let low = hex_nibble(pair[1])?;
        bytes.push((high << 4) | low);
    }
    Some(bytes)
}

/// Preserve imported key bytes, while decoding legacy local-store hex text.
pub(crate) fn normalize_rpg_maker_asset_key_material(raw_material: Vec<u8>) -> Vec<u8> {
    std::str::from_utf8(&raw_material)
        .ok()
        .and_then(decode_hex_material)
        .unwrap_or(raw_material)
}

fn hex_nibble(byte: u8) -> Option<u8> {
    match byte {
        b'0'..=b'9' => Some(byte - b'0'),
        b'a'..=b'f' => Some(byte - b'a' + 10),
        b'A'..=b'F' => Some(byte - b'A' + 10),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::{decode_hex_material, normalize_rpg_maker_asset_key_material};

    #[test]
    fn decodes_legacy_hex_text_into_key_bytes() {
        let key_hex = {
            use std::fmt::Write;
            let mut s = String::new();
            for byte in 0_u8..16 {
                write!(s, "{byte:02x}").unwrap();
            }
            s
        };

        assert_eq!(
            normalize_rpg_maker_asset_key_material(key_hex.into_bytes()),
            (0_u8..16).collect::<Vec<_>>(),
        );
    }

    #[test]
    fn preserves_decoded_binary_material_from_key_import() {
        let imported = (0_u8..16).collect::<Vec<_>>();

        assert_eq!(
            normalize_rpg_maker_asset_key_material(imported.clone()),
            imported,
        );
    }

    #[test]
    fn rejects_malformed_legacy_hex_text() {
        assert!(decode_hex_material("not hexadecimal").is_none());
    }
}
