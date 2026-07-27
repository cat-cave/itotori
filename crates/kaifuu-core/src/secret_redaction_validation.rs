use super::*;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SecretRedactionResult {
    pub value: Value,
    pub findings: Vec<SecretRedactionFinding>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SecretRedactionFinding {
    pub code: String,
    pub field: String,
    pub reason: String,
}

pub fn validate_secret_redaction_boundary(value: &Value) -> Vec<SecretRedactionFinding> {
    redact_secret_bearing_value(value).findings
}

pub fn redact_secret_bearing_value(value: &Value) -> SecretRedactionResult {
    let mut findings = Vec::new();
    let value = redact_secret_bearing_value_at(value, "$", &mut findings);
    SecretRedactionResult { value, findings }
}

pub(crate) fn redact_secret_bearing_value_at(
    value: &Value,
    field: &str,
    findings: &mut Vec<SecretRedactionFinding>,
) -> Value {
    match value {
        Value::Object(object) => {
            let mut redacted = serde_json::Map::new();
            for (key, child) in object {
                let child_field = if field == "$" {
                    key.clone()
                } else {
                    format!("{field}.{key}")
                };
                if let Some(reason) = secret_redaction_reason(key, &child_field, child) {
                    findings.push(SecretRedactionFinding {
                        code: SemanticErrorCode::SecretRedacted.to_string(),
                        field: child_field,
                        reason: reason.to_string(),
                    });
                    redacted.insert(
                        key.clone(),
                        Value::String(format!("[REDACTED:{SEMANTIC_SECRET_REDACTED}]")),
                    );
                } else {
                    redacted.insert(
                        key.clone(),
                        redact_secret_bearing_value_at(child, &child_field, findings),
                    );
                }
            }
            Value::Object(redacted)
        }
        Value::Array(items) => Value::Array(
            items
                .iter()
                .enumerate()
                .map(|(index, item)| {
                    redact_secret_bearing_value_at(item, &format!("{field}.{index}"), findings)
                })
                .collect(),
        ),
        _ => value.clone(),
    }
}

pub(crate) fn secret_redaction_reason<'a>(
    key: &str,
    field: &str,
    value: &'a Value,
) -> Option<&'a str> {
    let normalized = normalize_secret_field_name(key);
    if normalized == "secretref"
        && value
            .as_str()
            .is_some_and(|secret_ref| SecretRef::new(secret_ref.to_string()).is_ok())
    {
        return None;
    }
    if normalized == "secret" && value.is_boolean() {
        return None;
    }
    if is_forbidden_secret_field(&normalized) {
        return Some(
            "secret-bearing fields must be redacted before profiles or reports are persisted",
        );
    }
    let text = value.as_str()?;
    if is_free_text_secret_scan_field(&normalized) && free_text_requires_redaction(text) {
        return Some(
            "free-text profile/report fields must not persist secrets, helper dumps, decrypted text, local paths, or private source filenames",
        );
    }
    if is_path_like_field(&normalized) && is_local_absolute_path(text) {
        return Some("local paths must be redacted from profiles and reports");
    }
    if is_key_like_context(&normalized, field) && looks_like_raw_key_material(text) {
        return Some("raw key-like material must be referenced through secretRef, not persisted");
    }
    if is_archive_parameter_value_field(field) && looks_like_raw_key_material(text) {
        return Some(
            "raw key-like archive parameter values must be referenced through secretRef, not persisted",
        );
    }
    None
}

pub(crate) fn normalize_secret_field_name(key: &str) -> String {
    key.chars()
        .filter(char::is_ascii_alphanumeric)
        .flat_map(char::to_lowercase)
        .collect()
}

pub(crate) fn helper_execution_config_field_is_forbidden(key: &str) -> bool {
    matches!(
        normalize_secret_field_name(key).as_str(),
        "command"
            | "args"
            | "argv"
            | "shell"
            | "env"
            | "environment"
            | "executable"
            | "executablepath"
    )
}

pub(crate) fn helper_execution_config_field_is_forbidden_at(key: &str, field: &str) -> bool {
    if helper_execution_config_field_is_forbidden(key) {
        return true;
    }
    let normalized = normalize_secret_field_name(key);
    let normalized_field = normalize_secret_field_name(field);
    let helper_context = normalized_field.contains("helper");
    let helper_config_key = normalized == "path"
        || normalized == "filepath"
        || normalized == "binarypath"
        || normalized == "helperpath"
        || normalized == "helperbinary"
        || normalized == "helperbinarypath"
        || normalized == "location"
        || normalized == "uri"
        || normalized == "config"
        || normalized == "configuration"
        || normalized == "helperconfig"
        || normalized == "launchconfig"
        || normalized == "settings"
        || normalized == "options";
    helper_context && helper_config_key
}

pub(crate) fn is_forbidden_secret_field(normalized: &str) -> bool {
    matches!(
        normalized,
        "rawkey"
            | "keymaterial"
            | "keybytes"
            | "keyhex"
            | "keyvalue"
            | "rawsecret"
            | "secretmaterial"
            | "secretvalue"
            | "helperdump"
            | "helperlog"
            | "rawlog"
            | "memorydump"
            | "decryptedtext"
            | "decryptedplaintext"
            | "privatetext"
            | "localpath"
    )
}

pub(crate) fn is_path_like_field(normalized: &str) -> bool {
    normalized.contains("path") || normalized == "gamedir"
}

pub(crate) fn is_free_text_secret_scan_field(normalized: &str) -> bool {
    matches!(normalized, "description" | "placeholder" | "limitation")
}

pub(crate) fn is_key_like_context(normalized: &str, field: &str) -> bool {
    normalized.contains("key")
        || normalized.contains("secret")
        || field.starts_with("keyRequirements.")
        || field.contains(".keyRequirements.")
}

pub(crate) fn looks_like_raw_key_material(text: &str) -> bool {
    let text = text.trim();
    if text.starts_with("sha256:") || is_valid_secret_ref(text) {
        return false;
    }
    looks_like_raw_key_material_without_secret_ref(text)
}

pub(crate) fn is_archive_parameter_value_field(field: &str) -> bool {
    let segments = field.split('.').collect::<Vec<_>>();
    segments.len() >= 3
        && segments.last() == Some(&"value")
        && segments
            .get(segments.len().saturating_sub(3))
            .is_some_and(|segment| *segment == "archiveParameters")
        && segments
            .get(segments.len().saturating_sub(2))
            .is_some_and(|segment| segment.parse::<usize>().is_ok())
}

pub(crate) fn is_local_absolute_path(text: &str) -> bool {
    text.starts_with('/')
        || text.starts_with('\\')
        || path_has_windows_drive_prefix_component(text)
        || path_starts_with_home_or_local_env_var(text)
}

pub(crate) fn is_valid_secret_ref(value: &str) -> bool {
    let Some((scheme, name)) = value.split_once(':') else {
        return false;
    };
    if !matches!(
        scheme,
        "local-secret" | "os-keychain" | "secret-manager" | "prompt"
    ) {
        return false;
    }
    if name.is_empty()
        || name.trim() != name
        || name.contains('\0')
        || name.contains('\\')
        || name
            .split('/')
            .any(|component| component.is_empty() || component == "..")
        || is_local_absolute_path(name)
        || secret_ref_name_contains_raw_key_material(name)
    {
        return false;
    }
    name.chars().all(|character| {
        character.is_ascii_alphanumeric() || matches!(character, '-' | '_' | '.' | '/')
    })
}

pub(crate) fn secret_ref_name_contains_raw_key_material(name: &str) -> bool {
    looks_like_raw_key_material_without_secret_ref(name)
        || name
            .split('/')
            .any(looks_like_raw_key_material_without_secret_ref)
}

pub(crate) fn looks_like_raw_key_material_without_secret_ref(text: &str) -> bool {
    let hex_compact = text
        .chars()
        .filter(|character| !matches!(character, ' ' | '\t' | '\n' | '\r' | ':' | '-'))
        .collect::<String>();
    if hex_compact.len() >= 32
        && hex_compact.len() % 2 == 0
        && hex_compact
            .chars()
            .all(|character| character.is_ascii_hexdigit())
    {
        return true;
    }

    let encoded_compact = text
        .chars()
        .filter(|character| !matches!(character, ' ' | '\t' | '\n' | '\r'))
        .collect::<String>();
    looks_like_base64_key_material(&encoded_compact)
        || looks_like_base64url_key_material(&encoded_compact)
}

pub(crate) fn looks_like_base64_key_material(text: &str) -> bool {
    text.len() >= 22
        && text.chars().all(|character| {
            character.is_ascii_alphanumeric() || matches!(character, '+' | '/' | '=')
        })
        && text
            .chars()
            .any(|character| matches!(character, '+' | '/' | '='))
        && base64_padding_is_valid(text)
        && encoded_material_entropy(text) >= 4.0
}

pub(crate) fn looks_like_base64url_key_material(text: &str) -> bool {
    let unpadded = text.trim_end_matches('=');
    if !(22..=256).contains(&unpadded.len()) {
        return false;
    }
    if !base64_padding_is_valid(text)
        || !unpadded
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || matches!(character, '-' | '_'))
        || unpadded.contains('=')
    {
        return false;
    }

    let has_lowercase = unpadded
        .chars()
        .any(|character| character.is_ascii_lowercase());
    let has_uppercase = unpadded
        .chars()
        .any(|character| character.is_ascii_uppercase());
    let has_digit = unpadded.chars().any(|character| character.is_ascii_digit());
    let has_url_symbol = unpadded
        .chars()
        .any(|character| matches!(character, '-' | '_'));
    let signal_classes =
        usize::from(has_lowercase) + usize::from(has_uppercase) + usize::from(has_digit);
    let entropy = encoded_material_entropy(unpadded);
    (signal_classes >= 3 && entropy >= 4.0)
        || (has_url_symbol && signal_classes >= 2 && entropy >= 3.8)
        || (has_lowercase && has_uppercase && unpadded.len() >= 24 && entropy >= 4.0)
}

pub(crate) fn base64_padding_is_valid(text: &str) -> bool {
    if text.len() % 4 == 1 {
        return false;
    }
    let first_padding = text.find('=').unwrap_or(text.len());
    text[first_padding..]
        .chars()
        .all(|character| character == '=')
}

pub(crate) fn encoded_material_entropy(text: &str) -> f64 {
    let sample = text.trim_end_matches('=');
    if sample.is_empty() {
        return 0.0;
    }
    let mut frequencies = BTreeMap::<char, usize>::new();
    for character in sample.chars() {
        *frequencies.entry(character).or_default() += 1;
    }
    let length = sample.chars().count() as f64;
    frequencies
        .values()
        .map(|count| {
            let probability = *count as f64 / length;
            -probability * probability.log2()
        })
        .sum()
}
