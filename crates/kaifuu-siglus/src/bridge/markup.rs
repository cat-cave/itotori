//! Engine-level Siglus inline text-control recognition.
//!
//! The string table carries text as UTF-16LE, but inline renderer controls are
//! embedded in those strings.  The bridge keeps the literal untouched and pins
//! each control token as an exact protected span.  This scanner intentionally
//! describes the serialized Siglus text grammar (control characters and its
//! sigil escape forms), not any game's vocabulary.

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct MarkupSpan {
    pub(crate) start_byte: u64,
    pub(crate) end_byte: u64,
    pub(crate) parsed_name: &'static str,
}

pub(crate) fn protected_spans(text: &str) -> Vec<MarkupSpan> {
    let mut spans = Vec::new();
    let mut cursor = 0;
    while cursor < text.len() {
        let rest = &text[cursor..];
        let character = rest.chars().next().expect("cursor is a character boundary");
        let character_end = cursor + character.len_utf8();
        if character.is_control() || is_private_use(character) {
            spans.push(span(cursor, character_end, "siglus.inline_control"));
            cursor = character_end;
            continue;
        }
        if matches!(character, '\\' | '%' | '$' | '@')
            && let Some(end) = scan_sigil_token(text, cursor, character)
        {
            let name = match character {
                '\\' => "siglus.inline_escape",
                '%' => "siglus.inline_percent",
                '$' => "siglus.inline_variable",
                '@' => "siglus.inline_command",
                _ => unreachable!(),
            };
            spans.push(span(cursor, end, name));
            cursor = end;
            continue;
        }
        cursor = character_end;
    }
    spans
}

fn span(start_byte: usize, end_byte: usize, parsed_name: &'static str) -> MarkupSpan {
    MarkupSpan {
        start_byte: start_byte as u64,
        end_byte: end_byte as u64,
        parsed_name,
    }
}

fn is_private_use(character: char) -> bool {
    matches!(character as u32, 0xe000..=0xf8ff | 0xf0000..=0xffffd | 0x100000..=0x10fffd)
}

/// Return the byte end of one sigil-led serialized control.  Siglus controls
/// are either a one-character escape (for example `\\n`) or an ASCII command /
/// placeholder identifier with an optional balanced argument group.
fn scan_sigil_token(text: &str, start: usize, sigil: char) -> Option<usize> {
    let after_sigil = start + sigil.len_utf8();
    let first = text.get(after_sigil..)?.chars().next()?;
    if let Some(close) = matching_delimiter(first) {
        return scan_balanced(text, after_sigil, first, close);
    }
    if !first.is_ascii_alphanumeric() && first != '_' {
        return None;
    }
    let mut cursor = after_sigil + first.len_utf8();
    while let Some(character) = text.get(cursor..).and_then(|rest| rest.chars().next()) {
        if character.is_ascii_alphanumeric() || character == '_' {
            cursor += character.len_utf8();
        } else {
            break;
        }
    }
    if let Some(open) = text.get(cursor..).and_then(|rest| rest.chars().next())
        && let Some(close) = matching_delimiter(open)
    {
        return scan_balanced(text, cursor, open, close);
    }
    Some(cursor)
}

fn matching_delimiter(open: char) -> Option<char> {
    match open {
        '(' => Some(')'),
        '[' => Some(']'),
        '{' => Some('}'),
        '<' => Some('>'),
        _ => None,
    }
}

fn scan_balanced(text: &str, start: usize, open: char, close: char) -> Option<usize> {
    let mut depth = 0_usize;
    let mut cursor = start;
    while let Some(character) = text.get(cursor..).and_then(|rest| rest.chars().next()) {
        cursor += character.len_utf8();
        if character == open {
            depth += 1;
        } else if character == close {
            depth = depth.checked_sub(1)?;
            if depth == 0 {
                return Some(cursor);
            }
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recognizes_siglus_controls_without_title_vocabulary() {
        let text = r"A\c[2]B%wait(10)C${name}\n";
        let spans = protected_spans(text);
        let raw: Vec<_> = spans
            .iter()
            .map(|span| &text[span.start_byte as usize..span.end_byte as usize])
            .collect();
        assert_eq!(raw, ["\\c[2]", "%wait(10)", "${name}", "\\n"]);
        assert!(spans.iter().all(|span| span.end_byte > span.start_byte));
    }

    #[test]
    fn preserves_actual_control_characters_too() {
        let text = "A\nB\u{e000}C";
        let spans = protected_spans(text);
        assert_eq!(spans.len(), 2);
    }
}
