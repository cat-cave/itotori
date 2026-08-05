pub(super) const REDACTED_SECRET: &str = "[REDACTED_SECRET]";

pub(super) fn redact_secret_tokens(text: &str) -> String {
    let bytes = text.as_bytes();
    let mut rendered = String::with_capacity(text.len());
    let mut cursor = 0;
    let mut index = 0;
    let mut bearer_value_follows = false;
    let mut previous_token = "";
    while index < bytes.len() {
        while bytes
            .get(index)
            .is_some_and(|byte| is_token_delimiter(*byte))
        {
            index += 1;
        }
        let start = index;
        while bytes
            .get(index)
            .is_some_and(|byte| !is_token_delimiter(*byte))
        {
            index += 1;
        }
        if start == index {
            continue;
        }
        let token = &text[start..index];
        let candidate = trim_token_punctuation(token);
        let replacement = if bearer_value_follows
            || (!previous_token.eq_ignore_ascii_case("sha256")
                && looks_like_secret_token(candidate))
        {
            Some(REDACTED_SECRET.to_string())
        } else if let Some(embedded) = redact_embedded_secret_token(candidate) {
            Some(embedded)
        } else {
            redact_uri_password(candidate)
        };
        if let Some(replacement) = replacement {
            rendered.push_str(&text[cursor..start]);
            rendered.push_str(&replace_token_candidate(token, candidate, &replacement));
            cursor = index;
        }
        bearer_value_follows = candidate.eq_ignore_ascii_case("bearer");
        previous_token = candidate;
    }
    if cursor == 0 {
        text.to_string()
    } else {
        rendered.push_str(&text[cursor..]);
        rendered
    }
}

fn is_token_delimiter(byte: u8) -> bool {
    byte.is_ascii_whitespace() || matches!(byte, b',' | b';')
}

fn trim_token_punctuation(token: &str) -> &str {
    token.trim_matches(|character: char| {
        matches!(
            character,
            '"' | '\''
                | '`'
                | ','
                | ';'
                | ':'
                | '.'
                | '!'
                | '?'
                | '('
                | ')'
                | '['
                | ']'
                | '{'
                | '}'
        )
    })
}

fn replace_token_candidate(token: &str, candidate: &str, replacement: &str) -> String {
    let start = token.find(candidate).unwrap_or_default();
    let end = start + candidate.len();
    format!("{}{}{}", &token[..start], replacement, &token[end..])
}

fn redact_embedded_secret_token(candidate: &str) -> Option<String> {
    let separator = candidate.find(['=', ':'])?;
    let field = &candidate[..separator];
    if field.eq_ignore_ascii_case("sha256") {
        return None;
    }
    let raw_value = &candidate[separator + 1..];
    let value = trim_token_punctuation(raw_value);
    if value.is_empty() || !looks_like_secret_token(value) {
        return None;
    }
    let value_start = separator + 1 + raw_value.find(value).unwrap_or_default();
    let value_end = value_start + value.len();
    Some(format!(
        "{}{}{}",
        &candidate[..value_start],
        REDACTED_SECRET,
        &candidate[value_end..]
    ))
}

fn looks_like_secret_token(candidate: &str) -> bool {
    let lower = candidate.to_ascii_lowercase();
    [
        "sk-",
        "ghp_",
        "gho_",
        "ghu_",
        "ghs_",
        "ghr_",
        "github_pat_",
        "xoxa-",
        "xoxb-",
        "xoxp-",
        "xoxr-",
        "xoxs-",
    ]
    .into_iter()
    .any(|prefix| {
        lower.starts_with(prefix)
            && candidate.len() >= prefix.len() + 8
            && candidate[prefix.len()..]
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
    }) || (candidate.len() == 20
        && candidate.starts_with("AKIA")
        && candidate
            .bytes()
            .all(|byte| byte.is_ascii_uppercase() || byte.is_ascii_digit()))
        || looks_like_raw_key(candidate)
        || looks_like_jwt(candidate)
}

fn looks_like_raw_key(candidate: &str) -> bool {
    let compact = candidate.replace(['-', ':'], "");
    compact.len() >= 32
        && compact.len().is_multiple_of(2)
        && compact.bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn redact_uri_password(candidate: &str) -> Option<String> {
    let scheme_end = candidate.find("://")?;
    let authority_start = scheme_end + 3;
    let authority_end = candidate[authority_start..]
        .find(['/', '?', '#'])
        .map_or(candidate.len(), |index| authority_start + index);
    let authority = &candidate[authority_start..authority_end];
    let at = authority.rfind('@')?;
    let colon = authority[..at].rfind(':')?;
    let secret_start = authority_start + colon + 1;
    let secret_end = authority_start + at;
    (secret_start < secret_end).then(|| {
        format!(
            "{}{}{}",
            &candidate[..secret_start],
            REDACTED_SECRET,
            &candidate[secret_end..]
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
        && [first, second, third].into_iter().all(|part| {
            !part.is_empty()
                && part
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
        })
}

pub(super) fn redact_private_key_blocks(text: &str) -> String {
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
        rendered.push_str(REDACTED_SECRET);
        cursor = end;
    }
    rendered.push_str(&text[cursor..]);
    rendered
}
