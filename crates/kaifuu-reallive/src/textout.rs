//! Textout grammar and the bridge's visible-dialogue predicate.

/// Decode a catch-all Textout run as visible, translatable Shift-JIS text.
///
/// Textout is a catch-all bytecode element, so valid Shift-JIS alone is not
/// enough: embedded binary tables are excluded by decode errors or control
/// characters. Quote delimiters and quoted escaping are Textout grammar, not
/// displayed text; therefore `22 22` is an empty body, not prose.
pub fn decode_dialogue_textout(raw_bytes: &[u8]) -> Option<String> {
    if raw_bytes.is_empty() {
        return None;
    }
    let visible_bytes = textout_visible_bytes(raw_bytes);
    if visible_bytes.is_empty() {
        return None;
    }
    let (decoded, _encoding, had_errors) = encoding_rs::SHIFT_JIS.decode(&visible_bytes);
    if had_errors || decoded.chars().any(char::is_control) {
        return None;
    }
    Some(decoded.into_owned())
}

fn textout_visible_bytes(raw_bytes: &[u8]) -> Vec<u8> {
    let mut visible = Vec::with_capacity(raw_bytes.len());
    let mut quoted = false;
    let mut cursor = 0;
    while cursor < raw_bytes.len() {
        let byte = raw_bytes[cursor];
        if byte == b'"' {
            quoted = !quoted;
            cursor += 1;
        } else if quoted && byte == b'\\' {
            cursor += 1;
            if raw_bytes.get(cursor) == Some(&b'"') {
                visible.push(b'"');
                cursor += 1;
            } else {
                visible.push(b'\\');
            }
        } else if crate::opcode::is_shift_jis_textout_lead(byte) && cursor + 1 < raw_bytes.len() {
            visible.extend_from_slice(&raw_bytes[cursor..cursor + 2]);
            cursor += 2;
        } else {
            visible.push(byte);
            cursor += 1;
        }
    }
    visible
}
