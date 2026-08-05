use super::stderr_secret_redaction::{
    REDACTED_SECRET, redact_private_key_blocks, redact_secret_tokens,
};

use sha2::{Digest, Sha256};

pub(super) const REDACTED_CONTENT: &str = "[REDACTED_CONTENT";

pub(super) fn redact_runtime_diagnostic(text: &str) -> String {
    let private_keys = redact_private_key_blocks(text);
    let assignments = redact_named_values(&private_keys, RedactionKind::Secret);
    let flags = redact_secret_flags(&assignments);
    let tokens = redact_secret_tokens(&flags);
    redact_named_values(&tokens, RedactionKind::Content)
}

#[derive(Clone, Copy)]
enum RedactionKind {
    Content,
    Secret,
}

struct NamedValue {
    field_start: usize,
    field_end: usize,
    span: ValueSpan,
}

struct ValueSpan {
    replace_start: usize,
    value_start: usize,
    value_end: usize,
    replace_end: usize,
}

fn redact_named_values(text: &str, kind: RedactionKind) -> String {
    let mut rendered = String::with_capacity(text.len());
    let mut cursor = 0;
    let mut search_start = 0;
    while let Some(value) = next_named_value(text, search_start) {
        search_start = value.span.replace_end.max(value.field_end);
        let field = &text[value.field_start..value.field_end];
        let value_text = &text[value.span.value_start..value.span.value_end];
        let should_redact = match kind {
            RedactionKind::Content => should_redact_content(field, value_text),
            RedactionKind::Secret => is_secret_field(field),
        };
        if !should_redact {
            continue;
        }
        rendered.push_str(&text[cursor..value.span.replace_start]);
        match kind {
            RedactionKind::Content => rendered.push_str(&content_summary(field, value_text)),
            RedactionKind::Secret => rendered.push_str(REDACTED_SECRET),
        }
        cursor = value.span.replace_end;
    }
    if cursor == 0 {
        text.to_string()
    } else {
        rendered.push_str(&text[cursor..]);
        rendered
    }
}

fn next_named_value(text: &str, from: usize) -> Option<NamedValue> {
    let bytes = text.as_bytes();
    let mut index = from;
    while index < bytes.len() {
        if !is_field_start(bytes[index])
            || (index > 0 && is_field_character(bytes[index.saturating_sub(1)]))
        {
            index += 1;
            continue;
        }
        let field_start = index;
        index += 1;
        while index < bytes.len() && is_field_character(bytes[index]) {
            index += 1;
        }
        let field_end = index;
        let mut separator = field_end;
        if matches!(bytes.get(separator), Some(b'\'' | b'"')) {
            separator += 1;
        }
        while bytes.get(separator).is_some_and(u8::is_ascii_whitespace) {
            separator += 1;
        }
        if !matches!(bytes.get(separator), Some(b'=' | b':')) {
            continue;
        }
        if !is_context_field(&text[field_start..field_end]) {
            continue;
        }
        if let Some(span) = value_span(text, separator + 1) {
            return Some(NamedValue {
                field_start,
                field_end,
                span,
            });
        }
    }
    None
}

fn value_span(text: &str, after_separator: usize) -> Option<ValueSpan> {
    let bytes = text.as_bytes();
    let mut replace_start = after_separator;
    while bytes
        .get(replace_start)
        .is_some_and(u8::is_ascii_whitespace)
    {
        replace_start += 1;
    }
    let quote = bytes
        .get(replace_start)
        .copied()
        .filter(|byte| matches!(*byte, b'\'' | b'"'));
    let (value_start, value_end, replace_end) = if let Some(quote) = quote {
        let value_start = replace_start + 1;
        let (value_end, replace_end) = closing_quote(text, value_start, quote).map_or_else(
            || {
                let end = unquoted_value_end(text, value_start);
                (end, end)
            },
            |end| (end, end + 1),
        );
        (value_start, value_end, replace_end)
    } else {
        let value_start = replace_start;
        let mut value_end = unquoted_value_end(text, value_start);
        while value_end > value_start && bytes[value_end - 1].is_ascii_whitespace() {
            value_end -= 1;
        }
        (value_start, value_end, value_end)
    };
    (value_start < value_end).then_some(ValueSpan {
        replace_start,
        value_start,
        value_end,
        replace_end,
    })
}

fn closing_quote(text: &str, start: usize, quote: u8) -> Option<usize> {
    let mut escaped = false;
    for (index, byte) in text.as_bytes().iter().enumerate().skip(start) {
        match *byte {
            b'\\' if !escaped => escaped = true,
            byte if byte == quote && !escaped => return Some(index),
            _ => escaped = false,
        }
    }
    None
}

fn unquoted_value_end(text: &str, start: usize) -> usize {
    let bytes = text.as_bytes();
    for (index, byte) in bytes.iter().enumerate().skip(start) {
        if matches!(*byte, b';' | b'\n' | b'\r') {
            return index;
        }
        if *byte == b',' && begins_context_assignment(&text[index + 1..]) {
            return index;
        }
        if byte.is_ascii_whitespace() && begins_context_assignment(&text[index..]) {
            return index;
        }
    }
    bytes.len()
}

fn begins_context_assignment(text: &str) -> bool {
    let bytes = text.as_bytes();
    let mut start = 0;
    while bytes.get(start).is_some_and(u8::is_ascii_whitespace) {
        start += 1;
    }
    if !bytes.get(start).is_some_and(|byte| is_field_start(*byte)) {
        return false;
    }
    let mut end = start + 1;
    while bytes.get(end).is_some_and(|byte| is_field_character(*byte)) {
        end += 1;
    }
    let mut separator = end;
    if matches!(bytes.get(separator), Some(b'\'' | b'"')) {
        separator += 1;
    }
    while bytes.get(separator).is_some_and(u8::is_ascii_whitespace) {
        separator += 1;
    }
    matches!(bytes.get(separator), Some(b'=' | b':')) && is_context_field(&text[start..end])
}

fn is_field_start(byte: u8) -> bool {
    byte.is_ascii_alphabetic() || byte == b'_'
}

fn is_field_character(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-')
}

fn is_context_field(field: &str) -> bool {
    is_content_field(field) || is_secret_field(field) || is_safe_metadata_field(field)
}

fn should_redact_content(field: &str, value: &str) -> bool {
    is_content_field(field)
        && !value.starts_with("[REDACTED_")
        && !(normalize_field(field) == "bytes" && value.bytes().all(|byte| byte.is_ascii_digit()))
        && !(normalize_field(field) == "source" && looks_like_operator_path(value))
}

fn is_content_field(field: &str) -> bool {
    matches!(
        normalize_field(field).as_str(),
        "annotationtext"
            | "body"
            | "bytes"
            | "content"
            | "data"
            | "decodedtext"
            | "detail"
            | "dialogue"
            | "dialoguetext"
            | "excerpt"
            | "message"
            | "output"
            | "payload"
            | "plaintext"
            | "raw"
            | "rawbytes"
            | "rawtext"
            | "reason"
            | "script"
            | "snippet"
            | "source"
            | "sourcetext"
            | "stderr"
            | "stdout"
            | "targettext"
            | "text"
            | "value"
    )
}

fn is_secret_field(field: &str) -> bool {
    let normalized = normalize_field(field);
    normalized.contains("apikey")
        || normalized.contains("token")
        || normalized.contains("secret")
        || normalized.contains("password")
        || normalized.contains("credential")
        || normalized.ends_with("databaseurl")
        || normalized.ends_with("auth")
        || normalized.ends_with("authorization")
        || normalized.ends_with("key")
        || matches!(normalized.as_str(), "cookie" | "dsn")
}

fn is_safe_metadata_field(field: &str) -> bool {
    matches!(
        normalize_field(field).as_str(),
        "actual"
            | "bytelen"
            | "code"
            | "column"
            | "end"
            | "error"
            | "expected"
            | "index"
            | "kind"
            | "len"
            | "length"
            | "line"
            | "offset"
            | "path"
            | "scene"
            | "start"
            | "status"
            | "unit"
    )
}

fn normalize_field(field: &str) -> String {
    field
        .bytes()
        .filter(u8::is_ascii_alphanumeric)
        .map(|byte| char::from(byte.to_ascii_lowercase()))
        .collect()
}

fn looks_like_operator_path(value: &str) -> bool {
    value.starts_with('/')
        && value.matches('/').count() > 1
        && !value.chars().any(char::is_whitespace)
        && !value.contains(['?', '#', '\0'])
}

fn content_summary(field: &str, value: &str) -> String {
    let digest = Sha256::digest(value.as_bytes());
    format!(
        "[REDACTED_CONTENT kind={} {} bytes (sha256 {:x})]",
        normalize_field(field),
        value.len(),
        digest
    )
}

fn redact_secret_flags(text: &str) -> String {
    let bytes = text.as_bytes();
    let mut rendered = String::with_capacity(text.len());
    let mut cursor = 0;
    let mut search_start = 0;
    while let Some(relative_start) = text[search_start..].find("--") {
        let start = search_start + relative_start;
        let field_start = start + 2;
        let mut field_end = field_start;
        while bytes
            .get(field_end)
            .is_some_and(|byte| is_field_character(*byte))
        {
            field_end += 1;
        }
        if field_end == field_start || !is_secret_field(&text[field_start..field_end]) {
            search_start = field_end.max(start + 2);
            continue;
        }
        let mut value_start = field_end;
        if bytes.get(value_start) == Some(&b'=') {
            value_start += 1;
        } else {
            while bytes.get(value_start).is_some_and(u8::is_ascii_whitespace) {
                value_start += 1;
            }
        }
        let Some(span) = flag_value_span(text, value_start) else {
            search_start = field_end;
            continue;
        };
        rendered.push_str(&text[cursor..span.replace_start]);
        rendered.push_str(REDACTED_SECRET);
        cursor = span.replace_end;
        search_start = span.replace_end;
    }
    if cursor == 0 {
        text.to_string()
    } else {
        rendered.push_str(&text[cursor..]);
        rendered
    }
}

fn flag_value_span(text: &str, start: usize) -> Option<ValueSpan> {
    let bytes = text.as_bytes();
    let quote = bytes
        .get(start)
        .copied()
        .filter(|byte| matches!(*byte, b'\'' | b'"'));
    let (value_start, value_end, replace_end) = if let Some(quote) = quote {
        let value_start = start + 1;
        let (value_end, replace_end) = closing_quote(text, value_start, quote)
            .map_or((text.len(), text.len()), |end| (end, end + 1));
        (value_start, value_end, replace_end)
    } else {
        let mut end = start;
        while bytes
            .get(end)
            .is_some_and(|byte| !byte.is_ascii_whitespace() && !matches!(*byte, b',' | b';'))
        {
            end += 1;
        }
        (start, end, end)
    };
    (value_start < value_end).then_some(ValueSpan {
        replace_start: start,
        value_start,
        value_end,
        replace_end,
    })
}
