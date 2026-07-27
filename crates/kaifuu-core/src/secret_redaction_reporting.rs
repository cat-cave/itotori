use super::*;

pub fn redact_for_log_or_report(text: &str) -> String {
    if text_requires_redaction(text) {
        format!("[REDACTED:{SEMANTIC_SECRET_REDACTED}]")
    } else {
        text.to_string()
    }
}

pub fn redact_report_value(value: &Value) -> Value {
    redact_report_value_at(value, "$")
}

/// Whether a string leaf named as a typed diagnostic identifier ALSO carries a
/// value matching its known-safe shape, so it can be printed verbatim.
/// The field NAME alone is NOT proof the value is safe: a secret-shaped value
/// that happened to land in a `diagnosticCode`/`failureId`/etc. field must NOT
/// ride through just because of the field name. So the exemption is gated on
/// the VALUE actually matching a vocabulary-token / enum / UUID shape:
/// * stable error codes and v0.2 failure categories
///   (`kaifuu.reallive.patchback_*`, `patch_write_failed`) match a conservative
///   identifier grammar `^[A-Za-z][A-Za-z0-9_.:-]*$` — an ASCII-identifier-ish
///   token with no whitespace, no `+`/`/`/`=` (so no base64), and a leading
///   letter (so no hex/number-leading key material);
/// * `failureId` must be a UUID.
///   If the value does NOT match its safe shape (raw-key-shaped, high-entropy,
///   path-like, base64, …), this returns `false` and the caller falls back to the
///   normal content redactor, so a secret still redacts.
///   The field-NAME secret gate (`secret_redaction_reason`) still runs ahead of
///   this, so a genuinely secret-named field is unaffected either way.
pub(crate) fn is_safe_typed_diagnostic_identifier(key: &str, value: &str) -> bool {
    match normalize_secret_field_name(key).as_str() {
        "code" | "diagnosticcode" | "category" | "rollbackdiagnosticcode" => {
            is_safe_vocabulary_token(value)
        }
        "failureid" => is_uuid_like(value),
        _ => false,
    }
}

/// A conservative enum/vocabulary-token grammar: a leading ASCII letter
/// followed by ASCII letters/digits and the code separators `_`, `.`, `:`, `-`.
/// Deliberately excludes whitespace and every base64/base64 symbol
/// (`+`, `/`, `=`), and requires a leading LETTER so a hex- or number-leading
/// raw-key string cannot pass. Matches `^[A-Za-z][A-Za-z0-9_.:-]*$`.
/// The grammar alone still admits `-`/`_`, so a base64url raw key that happens
/// to lead with a letter could match it. So a value that passes the grammar is
/// additionally run through the raw-key heuristic and rejected if it
/// looks like raw key material — a diagnostic code / category never trips that
/// heuristic, but a high-entropy secret does, and must NOT ride through.
pub(crate) fn is_safe_vocabulary_token(value: &str) -> bool {
    let mut chars = value.chars();
    let Some(first) = chars.next() else {
        return false;
    };
    if !first.is_ascii_alphabetic() {
        return false;
    }
    let grammar_ok = chars.all(|character| {
        character.is_ascii_alphanumeric() || matches!(character, '_' | '.' | ':' | '-')
    });
    grammar_ok && !looks_like_raw_key_material(value)
}

/// Free-text diagnostic fields whose typed code prefix + human-readable reason
/// must stay visible for triage, while any secret-shaped token embedded in the
/// prose is scrubbed in place (rather than blanking the whole message).
pub(crate) fn is_diagnostic_free_text_field(key: &str) -> bool {
    matches!(
        normalize_secret_field_name(key).as_str(),
        "cause" | "message" | "reason"
    )
}

/// Scrub only the secret-shaped whitespace tokens out of a free-text diagnostic
/// message, preserving every other token. This keeps the typed diagnostic code
/// and the human-readable reason visible for triage while still masking any
/// raw key material, local path, private payload, or sensitive filename that a
/// message happens to carry.
/// The per-token predicate is the same one the whole-string redactor uses
/// (`text_requires_redaction`), so raw-key redaction is NOT weakened: a token
/// that would have redacted the whole message still redacts — just that token.
pub(crate) fn redact_secret_tokens_in_text(text: &str) -> String {
    // A forbidden private-payload marker (`helper dump`, `decrypted text`,
    // `raw key`, …) is a multi-word phrase that per-token scanning cannot
    // detect, and its presence means the whole message is carrying a private
    // dump rather than a typed diagnostic reason — so redact the whole string.
    // A genuine typed patchback reason never contains these phrases, so triage
    // visibility is unaffected.
    if text_contains_forbidden_private_payload(text) {
        return format!("[REDACTED:{SEMANTIC_SECRET_REDACTED}]");
    }
    // Preserve the exact original whitespace runs (single/multi space, tabs,
    // newlines) so the reason reads identically apart from masked tokens.
    let mut out = String::with_capacity(text.len());
    let mut token = String::new();
    let flush = |token: &mut String, out: &mut String| {
        if token.is_empty() {
            return;
        }
        if text_requires_redaction(token) {
            out.push_str("[REDACTED:");
            out.push_str(SEMANTIC_SECRET_REDACTED);
            out.push(']');
        } else {
            out.push_str(token);
        }
        token.clear();
    };
    for character in text.chars() {
        if character.is_whitespace() {
            flush(&mut token, &mut out);
            out.push(character);
        } else {
            token.push(character);
        }
    }
    flush(&mut token, &mut out);
    out
}

pub(crate) fn redact_report_value_at(value: &Value, field: &str) -> Value {
    match value {
        Value::Object(object) => {
            let mut redacted = serde_json::Map::new();
            for (key, child) in object {
                let child_field = if field == "$" {
                    key.clone()
                } else {
                    format!("{field}.{key}")
                };
                if secret_redaction_reason(key, &child_field, child).is_some() {
                    redacted.insert(
                        key.clone(),
                        Value::String(format!("[REDACTED:{SEMANTIC_SECRET_REDACTED}]")),
                    );
                } else if let Some(text) = child.as_str() {
                    // A string leaf named as a typed diagnostic identifier
                    // (diagnosticCode / category / code / failureId /
                    // rollbackDiagnosticCode) is exempt from the free-text content
                    // heuristic ONLY when its value ALSO matches the known-safe
                    // vocabulary-token / enum / UUID shape — so an operator can
                    // triage a patch failure by its typed code (the common case)
                    // even when that code happens to look hex- or base64url-shaped,
                    // code-named field still falls through to the content redactor
                    // and redacts. Free-text diagnostic fields (cause / message /
                    // reason) keep their typed code + human reason visible while
                    // any embedded secret-shaped token is scrubbed in place.
                    let value = if is_safe_typed_diagnostic_identifier(key, text) {
                        text.to_string()
                    } else if is_diagnostic_free_text_field(key) {
                        redact_secret_tokens_in_text(text)
                    } else {
                        redact_for_log_or_report(text)
                    };
                    redacted.insert(key.clone(), Value::String(value));
                } else {
                    redacted.insert(key.clone(), redact_report_value_at(child, &child_field));
                }
            }
            Value::Object(redacted)
        }
        Value::Array(items) => Value::Array(
            items
                .iter()
                .enumerate()
                .map(|(index, item)| redact_report_value_at(item, &format!("{field}.{index}")))
                .collect(),
        ),
        Value::String(text) => Value::String(redact_for_log_or_report(text)),
        _ => value.clone(),
    }
}

pub(crate) fn redact_asset_ref_for_report(asset_ref: &str) -> String {
    if asset_ref_requires_redaction(asset_ref) {
        format!("[REDACTED:{SEMANTIC_SECRET_REDACTED}]")
    } else {
        asset_ref.to_string()
    }
}

pub(crate) fn text_requires_redaction(text: &str) -> bool {
    let text = text.trim();
    text_contains_local_absolute_path(text)
        || text_contains_raw_key_material(text)
        || text_contains_forbidden_private_payload(text)
        || text_contains_sensitive_filename(text)
}

pub(crate) fn free_text_requires_redaction(text: &str) -> bool {
    let text = text.trim();
    text_contains_local_absolute_path(text)
        || text_contains_raw_key_material_token(text)
        || text_contains_forbidden_private_payload(text)
        || text_contains_sensitive_filename(text)
}

pub(crate) fn asset_ref_requires_redaction(asset_ref: &str) -> bool {
    if text_requires_redaction(asset_ref) {
        return true;
    }
    let path_part = asset_ref.split('#').next().unwrap_or(asset_ref);
    path_part.contains(['/', '\\']) && safe_relative_path_parts(path_part).is_err()
}

pub(crate) fn text_contains_local_absolute_path(text: &str) -> bool {
    text.split_whitespace()
        .map(trim_token_punctuation)
        .any(token_contains_local_absolute_path)
}

pub(crate) fn token_contains_local_absolute_path(token: &str) -> bool {
    if token.is_empty() {
        return false;
    }
    if is_local_absolute_path(token) || path_has_windows_drive_prefix_component(token) {
        return true;
    }
    token.char_indices().any(|(index, character)| {
        if !matches!(character, '=' | ':') {
            return false;
        }
        if character == ':'
            && token
                .get(index.saturating_sub(5)..index + 3)
                .is_some_and(|window| window.eq_ignore_ascii_case("https://"))
        {
            return false;
        }
        if character == ':'
            && token
                .get(index.saturating_sub(4)..index + 3)
                .is_some_and(|window| window.eq_ignore_ascii_case("http://"))
        {
            return false;
        }
        let candidate = trim_token_punctuation(&token[index + character.len_utf8()..]);
        !candidate.is_empty()
            && (is_local_absolute_path(candidate)
                || path_has_windows_drive_prefix_component(candidate))
    })
}

pub(crate) fn path_starts_with_home_or_local_env_var(path: &str) -> bool {
    let path = path.trim_start();
    if path.starts_with("~/") || path.starts_with("~\\") {
        return true;
    }

    let local_env_prefixes = [
        "$HOME",
        "${HOME}",
        "$USERPROFILE",
        "${USERPROFILE}",
        "$HOMEPATH",
        "${HOMEPATH}",
        "$APPDATA",
        "${APPDATA}",
        "$LOCALAPPDATA",
        "${LOCALAPPDATA}",
        "%HOME%",
        "%USERPROFILE%",
        "%HOMEPATH%",
        "%APPDATA%",
        "%LOCALAPPDATA%",
        "%TEMP%",
        "%TMP%",
    ];
    local_env_prefixes.iter().any(|prefix| {
        path.get(..prefix.len())
            .is_some_and(|start| start.eq_ignore_ascii_case(prefix))
            && path[prefix.len()..].starts_with(['/', '\\'])
    })
}

pub(crate) fn text_contains_raw_key_material(text: &str) -> bool {
    if is_sha256_ref(text) || is_uuid_like(text) {
        return false;
    }
    if looks_like_raw_key_material(text) {
        return true;
    }
    text_contains_raw_key_material_token(text)
}

pub(crate) fn is_uuid_like(value: &str) -> bool {
    let bytes = value.as_bytes();
    if bytes.len() != 36 {
        return false;
    }
    for (index, byte) in bytes.iter().enumerate() {
        if matches!(index, 8 | 13 | 18 | 23) {
            if *byte != b'-' {
                return false;
            }
        } else if !byte.is_ascii_hexdigit() {
            return false;
        }
    }
    true
}

pub(crate) fn text_contains_raw_key_material_token(text: &str) -> bool {
    text.split(|character: char| {
        !(character.is_ascii_alphanumeric() || matches!(character, '+' | '/' | '=' | '-' | '_'))
    })
    .any(looks_like_raw_key_material)
}

pub(crate) fn text_contains_forbidden_private_payload(text: &str) -> bool {
    let normalized = text.to_ascii_lowercase();
    [
        "helper dump",
        "memory dump",
        "register dump",
        "raw helper log",
        "decrypted script",
        "decrypted text",
        "private script",
        "private translated",
        "raw key",
    ]
    .iter()
    .any(|needle| normalized.contains(needle))
}

pub(crate) fn text_contains_sensitive_filename(text: &str) -> bool {
    text.split_whitespace()
        .map(trim_token_punctuation)
        .any(|token| {
            let lower = token.to_ascii_lowercase();
            let looks_like_file = lower.contains('.')
                && lower
                    .rsplit_once('.')
                    .is_some_and(|(_, extension)| extension.len() <= 8);
            looks_like_file
                && ["private", "spoiler", "route", "ending", "true-end"]
                    .iter()
                    .any(|needle| lower.contains(needle))
        })
}

pub(crate) fn trim_token_punctuation(token: &str) -> &str {
    token.trim_matches(|character: char| {
        matches!(
            character,
            '"' | '\'' | '`' | ',' | ';' | ':' | '(' | ')' | '[' | ']' | '{' | '}'
        )
    })
}
