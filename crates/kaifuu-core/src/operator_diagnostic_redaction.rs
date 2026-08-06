use super::*;
const CONTENT_FIELDS: &str = concat!(
    "annotationText annotation_text annotation-text body cause content decodedText decoded_text ",
    "decoded-text description detail dialogue message originalText original_text original-text payload ",
    "plaintext raw rawBytes raw_bytes raw-bytes reason replacementText replacement_text replacement-text ",
    "script source sourceText source_text source-text targetText target_text target-text text value bytes"
);
const COMMON_SECRET_PREFIXES: &str =
    "sk- ghp_ gho_ ghu_ ghs_ ghr_ github_pat_ xoxa- xoxb- xoxp- xoxr- xoxs-";
const SAFE_CONTEXT_FIELDS: &str = "actual byteLen byte_len code column end error expected index kind len length line offset partial path scene start status unit";
/// THE operator-facing native diagnostic chokepoint. CLI `main` and every
/// terminal error path must route through here so a new call site inherits
/// span-only redaction rather than inventing whole-channel hashing.
///
/// Redacts private diagnostic spans while preserving useful operator context.
/// If redaction would collapse the body to a sole content-hash marker, the
/// original text is restored (secrets are still span-masked first).
pub fn redact_diagnostic_for_operator(text: &str) -> String {
    let without_secrets = redact_operator_secret_spans(text);
    let redacted = redact_terminal_path_payload(&redact_operator_content_spans(&without_secrets));
    if is_whole_channel_content_redaction(&redacted) && !is_whole_channel_content_redaction(text) {
        // Defensive: never introduce whole-channel content hashing.
        return without_secrets;
    }
    redacted
}

fn redact_terminal_path_payload(text: &str) -> String {
    let Some(marker) = text.find(['?', '#']) else {
        return text.to_string();
    };
    let path = &text[..marker];
    let payload = &text[marker + 1..];
    if is_operator_path_prefix(path) && !payload.is_empty() {
        format!(
            "{}{}",
            path,
            redacted_content_summary("path_payload", payload)
        )
    } else {
        text.to_string()
    }
}

fn is_operator_path_prefix(text: &str) -> bool {
    is_local_absolute_path(text)
        && !text.chars().any(char::is_whitespace)
        && !text.contains("://")
        && text.matches(['/', '\\']).count() > 1
}

fn is_operator_path(text: &str) -> bool {
    is_operator_path_prefix(text) && text.find(['?', '#', '\0']).is_none()
}
fn redact_operator_content_spans(text: &str) -> String {
    redact_named_spans(text, is_content_field, false, |field, value| {
        if field.eq_ignore_ascii_case("source") && is_operator_path(value) {
            return value.to_string();
        }
        if field.eq_ignore_ascii_case("bytes") && value.bytes().all(|byte| byte.is_ascii_digit()) {
            return value.to_string();
        }
        redacted_content_summary(field, value)
    })
}
fn redacted_content_summary(kind: &str, value: &str) -> String {
    let summary = RedactedContentSummary::from_text(value);
    format!(
        "[REDACTED_CONTENT kind={kind} byte_len={} sha256={}]",
        summary.byte_len(),
        summary.sha256()
    )
}
fn redact_operator_secret_spans(text: &str) -> String {
    let private_keys = redact_private_key_blocks(text);
    let named = redact_named_spans(&private_keys, is_operator_secret_field, true, |_, _| {
        format!("[REDACTED:{SEMANTIC_SECRET_REDACTED}]")
    });
    let flagged = redact_secret_flag_values(&named);
    redact_raw_key_tokens(&flagged)
}
fn redact_named_spans(
    text: &str,
    field_is_sensitive: fn(&str, u8) -> bool,
    allows_secret_refs: bool,
    redact: impl Fn(&str, &str) -> String,
) -> String {
    let mut rendered = String::with_capacity(text.len());
    let mut cursor = 0;
    while let Some(assignment) = next_assignment(&text[cursor..], field_is_sensitive) {
        let field_start = cursor + assignment.field_start;
        let separator_end = cursor + assignment.separator_end;
        let Some(span) = diagnostic_value_span(text, separator_end) else {
            break;
        };
        if allows_secret_refs && is_valid_secret_ref(&text[span.value_start..span.value_end]) {
            rendered.push_str(&text[cursor..separator_end]);
            cursor = separator_end;
            continue;
        }
        rendered.push_str(&text[cursor..span.replace_start]);
        rendered.push_str(&redact(
            &text[field_start..cursor + assignment.field_end],
            &text[span.value_start..span.value_end],
        ));
        cursor = span.replace_end;
    }
    rendered.push_str(&text[cursor..]);
    rendered
}
#[derive(Clone, Copy)]
struct Assignment {
    field_start: usize,
    field_end: usize,
    separator_end: usize,
}
#[derive(Clone, Copy)]
struct DiagnosticValueSpan {
    replace_start: usize,
    value_start: usize,
    value_end: usize,
    replace_end: usize,
}

fn next_assignment(text: &str, field_is_sensitive: fn(&str, u8) -> bool) -> Option<Assignment> {
    let bytes = text.as_bytes();
    for (field_start, character) in text.char_indices() {
        if !character.is_ascii_alphanumeric() && character != '_' {
            continue;
        }
        if field_start > 0
            && (bytes[field_start - 1].is_ascii_alphanumeric() || bytes[field_start - 1] == b'_')
        {
            continue;
        }
        let mut field_end = field_start;
        while bytes
            .get(field_end)
            .is_some_and(|byte| byte.is_ascii_alphanumeric() || matches!(*byte, b'_' | b'-'))
        {
            field_end += 1;
        }
        let mut assignment_start = field_end;
        if matches!(bytes.get(assignment_start), Some(b'\'' | b'"')) {
            assignment_start += 1;
        }
        while bytes
            .get(assignment_start)
            .is_some_and(u8::is_ascii_whitespace)
        {
            assignment_start += 1;
        }
        let Some(separator) = bytes
            .get(assignment_start)
            .copied()
            .filter(|byte| matches!(*byte, b'=' | b':'))
        else {
            continue;
        };
        if !field_is_sensitive(&text[field_start..field_end], separator) {
            continue;
        }
        return Some(Assignment {
            field_start,
            field_end,
            separator_end: assignment_start + 1,
        });
    }
    None
}
fn diagnostic_value_span(text: &str, assignment_end: usize) -> Option<DiagnosticValueSpan> {
    let bytes = text.as_bytes();
    let mut value_start = assignment_end;
    while bytes.get(value_start).is_some_and(u8::is_ascii_whitespace) {
        value_start += 1;
    }
    let quote = bytes
        .get(value_start)
        .copied()
        .filter(|byte| matches!(*byte, b'\'' | b'"'));
    let (replace_start, value_start, value_end, replace_end) = if let Some(quote) = quote {
        let content_start = value_start + 1;
        let (content_end, replace_end) = closing_quote_or_boundary(text, content_start, quote)
            .map_or_else(
                || {
                    let end = unquoted_value_end(text, content_start);
                    (end, end)
                },
                |end| (end, end + 1),
            );
        (value_start, content_start, content_end, replace_end)
    } else {
        let candidate_end = unquoted_value_end(text, value_start);
        let content_end = text[..candidate_end]
            .trim_end_matches(char::is_whitespace)
            .len();
        (value_start, value_start, content_end, content_end)
    };
    (value_start < value_end).then_some(DiagnosticValueSpan {
        replace_start,
        value_start,
        value_end,
        replace_end,
    })
}
fn closing_quote_or_boundary(text: &str, start: usize, quote: u8) -> Option<usize> {
    let bytes = text.as_bytes();
    let mut escaped = false;
    for (index, byte) in bytes.iter().enumerate().skip(start) {
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
        if matches!(*byte, b';' | b',' | b'\n' | b'\r')
            && begins_safe_context_assignment(&text[index + 1..])
        {
            return index;
        }
        if byte.is_ascii_whitespace() && begins_safe_context_assignment(&text[index..]) {
            return index;
        }
    }
    bytes.len()
}

fn begins_safe_context_assignment(text: &str) -> bool {
    let bytes = text.as_bytes();
    let mut start = 0;
    while bytes.get(start).is_some_and(u8::is_ascii_whitespace) {
        start += 1;
    }
    let mut end = start;
    while bytes
        .get(end)
        .is_some_and(|byte| byte.is_ascii_alphanumeric() || matches!(*byte, b'_' | b'-'))
    {
        end += 1;
    }
    if !SAFE_CONTEXT_FIELDS
        .split_ascii_whitespace()
        .any(|field| field.eq_ignore_ascii_case(&text[start..end]))
    {
        return false;
    }
    let mut assignment = end;
    while bytes.get(assignment).is_some_and(u8::is_ascii_whitespace) {
        assignment += 1;
    }
    matches!(bytes.get(assignment), Some(b'=' | b':'))
}

fn is_content_field(field: &str, _: u8) -> bool {
    CONTENT_FIELDS
        .split_ascii_whitespace()
        .any(|candidate| candidate.eq_ignore_ascii_case(field))
}

fn is_operator_secret_field(field: &str, _: u8) -> bool {
    let normalized = normalize_secret_field_name(field);
    if matches!(
        normalized.as_str(),
        "localsecret" | "oskeychain" | "secretmanager"
    ) {
        return false;
    }
    normalized.contains("apikey")
        || normalized.contains("token")
        || normalized.contains("secret")
        || normalized.contains("password")
        || normalized.contains("credential")
        || normalized.ends_with("databaseurl")
        || normalized.ends_with("authorization")
        || matches!(
            normalized.as_str(),
            "auth" | "authorization" | "bearer" | "cookie" | "dsn"
        )
        || normalized.ends_with("key")
}

fn redact_secret_flag_values(text: &str) -> String {
    // `--api-key=value` is covered by the named-assignment pass above; this
    // pass handles the whitespace form (`--api-key value`).
    let mut rendered = String::with_capacity(text.len());
    let mut cursor = 0;
    while let Some(flag_end) = next_secret_flag(&text[cursor..]) {
        let flag_end = cursor + flag_end;
        let Some(span) = diagnostic_value_span(text, flag_end) else {
            break;
        };
        rendered.push_str(&text[cursor..span.replace_start]);
        push_secret_redaction(&mut rendered);
        cursor = span.replace_end;
    }
    rendered.push_str(&text[cursor..]);
    rendered
}

fn push_secret_redaction(rendered: &mut String) {
    rendered.push_str("[REDACTED:");
    rendered.push_str(SEMANTIC_SECRET_REDACTED);
    rendered.push(']');
}

fn next_secret_flag(text: &str) -> Option<usize> {
    let bytes = text.as_bytes();
    let mut index = 0;
    while index + 2 <= bytes.len() {
        if bytes.get(index..index + 2) != Some(b"--") {
            index += 1;
            continue;
        }
        let field_start = index + 2;
        let mut field_end = field_start;
        while bytes
            .get(field_end)
            .is_some_and(|byte| byte.is_ascii_alphanumeric() || matches!(*byte, b'_' | b'-'))
        {
            field_end += 1;
        }
        if field_end > field_start
            && bytes.get(field_end).is_some_and(u8::is_ascii_whitespace)
            && is_operator_secret_field(&text[field_start..field_end], b' ')
        {
            return Some(field_end);
        }
        index = field_end.max(index + 1);
    }
    None
}

fn redact_raw_key_tokens(text: &str) -> String {
    let mut rendered = String::with_capacity(text.len());
    let mut token = String::new();
    let mut redact_bearer_value = false;
    for character in text.chars() {
        if character.is_whitespace() || matches!(character, ',' | ';') {
            flush_raw_key_token(&mut rendered, &mut token, &mut redact_bearer_value);
            rendered.push(character);
        } else {
            token.push(character);
        }
    }
    flush_raw_key_token(&mut rendered, &mut token, &mut redact_bearer_value);
    rendered
}

fn flush_raw_key_token(rendered: &mut String, token: &mut String, redact_bearer_value: &mut bool) {
    if token.is_empty() {
        return;
    }
    let candidate = trim_token_punctuation(token);
    if *redact_bearer_value && !candidate.is_empty() {
        push_secret_redaction(rendered);
    } else {
        rendered.push_str(&redact_raw_key_token(token));
    }
    *redact_bearer_value = candidate.eq_ignore_ascii_case("bearer");
    token.clear();
}

fn redact_raw_key_token(token: &str) -> String {
    let candidate = trim_token_punctuation(token);
    if let Some(redacted) = redact_uri_password(candidate) {
        return token.replacen(candidate, &redacted, 1);
    }
    if raw_key_candidate_requires_redaction(candidate) {
        return redact_raw_key_candidate(token, candidate);
    }
    let Some(separator) = token.find(['=', ':']) else {
        return token.to_string();
    };
    let value = &token[separator + 1..];
    let candidate = trim_token_punctuation(value);
    if !raw_key_candidate_requires_redaction(candidate) {
        return token.to_string();
    }
    let candidate_start = separator + 1 + value.find(candidate).unwrap_or_default();
    let candidate_end = candidate_start + candidate.len();
    format!(
        "{}[REDACTED:{SEMANTIC_SECRET_REDACTED}]{}",
        &token[..candidate_start],
        &token[candidate_end..]
    )
}

fn raw_key_candidate_requires_redaction(candidate: &str) -> bool {
    (!is_sha256_ref(candidate)
        && !is_uuid_like(candidate)
        && looks_like_raw_key_material(candidate))
        || looks_like_jwt(candidate)
        || looks_like_common_secret_token(candidate)
}

fn redact_uri_password(token: &str) -> Option<String> {
    let scheme_end = token.find("://")?;
    let authority_start = scheme_end + 3;
    let authority_end = token[authority_start..]
        .find(|character: char| {
            character.is_ascii_whitespace() || matches!(character, '/' | '?' | '#')
        })
        .map_or(token.len(), |index| authority_start + index);
    let authority = &token[authority_start..authority_end];
    let at = authority.rfind('@')?;
    let colon = authority[..at].rfind(':')?;
    let secret_start = authority_start + colon + 1;
    let secret_end = authority_start + at;
    (secret_start < secret_end).then(|| {
        format!(
            "{}[REDACTED:{SEMANTIC_SECRET_REDACTED}]{}",
            &token[..secret_start],
            &token[secret_end..]
        )
    })
}

fn looks_like_jwt(candidate: &str) -> bool {
    let mut parts = candidate.split('.');
    let (Some(first), Some(second), Some(third)) = (parts.next(), parts.next(), parts.next())
    else {
        return false;
    };
    parts.next().is_none()
        && first.starts_with("eyJ")
        && [first, second, third].into_iter().all(is_secret_token_part)
}

fn is_secret_token_part(part: &str) -> bool {
    !part.is_empty()
        && part
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || matches!(character, '-' | '_'))
}

fn looks_like_common_secret_token(candidate: &str) -> bool {
    COMMON_SECRET_PREFIXES
        .split_ascii_whitespace()
        .any(|prefix| {
            candidate.starts_with(prefix)
                && candidate.len() >= prefix.len() + 8
                && is_secret_token_part(&candidate[prefix.len()..])
        })
        || (candidate.len() == 20
            && candidate.starts_with("AKIA")
            && candidate
                .chars()
                .all(|character| character.is_ascii_uppercase() || character.is_ascii_digit()))
}

fn redact_private_key_blocks(text: &str) -> String {
    let mut rendered = String::with_capacity(text.len());
    let mut cursor = 0;
    while let Some(relative_start) = text[cursor..].find("-----BEGIN ") {
        let start = cursor + relative_start;
        let Some(header_end) = text[start..]
            .find("PRIVATE KEY-----")
            .map(|index| start + index + "PRIVATE KEY-----".len())
        else {
            let next = start + "-----BEGIN ".len();
            rendered.push_str(&text[cursor..next]);
            cursor = next;
            continue;
        };
        let end = text[header_end..]
            .find("-----END ")
            .and_then(|relative_end| {
                let end_start = header_end + relative_end;
                text[end_start..]
                    .find("PRIVATE KEY-----")
                    .map(|index| end_start + index + "PRIVATE KEY-----".len())
            })
            .unwrap_or(text.len());
        rendered.push_str(&text[cursor..start]);
        push_secret_redaction(&mut rendered);
        cursor = end;
    }
    rendered.push_str(&text[cursor..]);
    rendered
}

fn redact_raw_key_candidate(token: &str, candidate: &str) -> String {
    let candidate_start = token.find(candidate).unwrap_or_default();
    let candidate_end = candidate_start + candidate.len();
    format!(
        "{}[REDACTED:{SEMANTIC_SECRET_REDACTED}]{}",
        &token[..candidate_start],
        &token[candidate_end..]
    )
}
