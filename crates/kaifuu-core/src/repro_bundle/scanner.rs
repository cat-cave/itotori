//! Private-asset scanner for redacted reproduction bundles.

use super::*;

const IMAGE_EXTENSIONS: &[&str] = &["png", "jpg", "jpeg", "bmp", "gif", "webp", "tga", "rpgmvp"];
const RETAIL_BINARY_EXTENSIONS: &[&str] = &[
    "xp3", "pck", "rgssad", "rgss3a", "rgss2a", "dat", "bin", "exe", "rpgmvo", "arc", "wolf",
];

fn trim_token_edges(token: &str) -> &str {
    token.trim_matches(|character: char| {
        matches!(
            character,
            '"' | '\'' | '`' | ',' | ';' | ':' | '(' | ')' | '[' | ']' | '{' | '}' | '!' | '?'
        )
    })
}

fn token_has_extension(text: &str, extensions: &[&str]) -> bool {
    text.split_whitespace().map(trim_token_edges).any(|token| {
        token.rsplit_once('.').is_some_and(|(_, extension)| {
            extensions.contains(&extension.to_ascii_lowercase().as_str())
        })
    })
}

fn contains_private_path(text: &str) -> bool {
    text.split_whitespace()
        .map(trim_token_edges)
        .any(is_local_absolute_path)
}

fn contains_raw_key(text: &str) -> bool {
    if text.contains("-----BEGIN") {
        return true;
    }
    // Scan per TOKEN, never the whole string: raw key material is a single
    // contiguous token, whereas the whole-string base64url heuristic fires on
    // ordinary hyphenated prose (e.g. "patch-back is not yet proven"). `:` is
    // kept INSIDE tokens so `sha256:<hex>` proof hashes and `local-secret:<name>`
    // refs stay whole — `looks_like_raw_key_material` excludes both, avoiding a
    // false raw-key hit on their hex/base64 tail.
    text.split(|character: char| {
        !(character.is_ascii_alphanumeric()
            || matches!(character, '+' | '/' | '=' | '-' | '_' | ':'))
    })
    .any(looks_like_raw_key_material)
}

fn contains_screenshot(text: &str) -> bool {
    let lower = text.to_ascii_lowercase();
    if lower.contains("data:image/") {
        return true;
    }
    if lower.contains("screenshot") || lower.contains("rendered frame") {
        return true;
    }
    token_has_extension(text, IMAGE_EXTENSIONS)
}

fn contains_retail_bytes(text: &str) -> bool {
    let lower = text.to_ascii_lowercase();
    if lower.contains("data:application/")
        || lower.contains("data:audio/")
        || lower.contains("data:video/")
        || lower.contains("data:application/octet-stream")
    {
        return true;
    }
    if lower.contains("retail bytes")
        || lower.contains("game bytes")
        || lower.contains("copyrighted bytes")
    {
        return true;
    }
    token_has_extension(text, RETAIL_BINARY_EXTENSIONS)
}

fn contains_prompt_log(text: &str) -> bool {
    let lower = text.to_ascii_lowercase();
    lower.contains("system prompt")
        || lower.contains("prompt log")
        || lower.contains("prompt transcript")
        || lower.contains("llm prompt")
        || lower.contains("\nassistant:")
        || lower.contains("\nuser:")
        || lower.starts_with("assistant:")
        || lower.starts_with("system:")
}

const STORY_TEXT_MARKERS: &[&str] = &[
    "decrypted script",
    "decrypted text",
    "decrypted plaintext",
    "translated line",
    "translated script",
    "story text",
    "narrative text",
    "spoiler",
];

fn contains_story_text(text: &str) -> bool {
    let lower = text.to_ascii_lowercase();
    if STORY_TEXT_MARKERS
        .iter()
        .any(|marker| lower.contains(marker))
    {
        return true;
    }
    // A spoiler/route/ending filename — a private script the bundle must not name.
    text.split_whitespace().map(trim_token_edges).any(|token| {
        let lower = token.to_ascii_lowercase();
        let looks_like_file = lower
            .rsplit_once('.')
            .is_some_and(|(_, extension)| !extension.is_empty() && extension.len() <= 8);
        looks_like_file
            && ["route", "ending", "true-end", "spoiler", "private"]
                .iter()
                .any(|needle| lower.contains(needle))
    })
}

/// Scan one string for a private-asset class. Returns the first match in a
/// fixed priority order (path → key → screenshot → retail → prompt → story).
pub fn scan_private_asset(text: &str) -> Option<PrivateAssetClass> {
    let text = text.trim();
    if text.is_empty() {
        return None;
    }
    if contains_private_path(text) {
        return Some(PrivateAssetClass::PrivatePath);
    }
    if contains_raw_key(text) {
        return Some(PrivateAssetClass::RawKey);
    }
    if contains_screenshot(text) {
        return Some(PrivateAssetClass::Screenshot);
    }
    if contains_retail_bytes(text) {
        return Some(PrivateAssetClass::RetailBytes);
    }
    if contains_prompt_log(text) {
        return Some(PrivateAssetClass::PromptLog);
    }
    if contains_story_text(text) {
        return Some(PrivateAssetClass::StoryText);
    }
    None
}
