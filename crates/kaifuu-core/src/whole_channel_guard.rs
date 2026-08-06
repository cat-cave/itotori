//! Guard against whole-channel content redaction of operator diagnostics.
//!
//! A content span may become a size/hash summary. An entire stderr/stdout
//! channel must not. Limit of this guard: only pure
//! `[REDACTED_CONTENT kind=diagnostic|native…]` bodies fail; span summaries
//! that keep surrounding message text pass. Secret-only full masks are not
//! content whole-channel redaction.

/// Whole-channel content-redaction kind prefixes that hide an entire body.
const WHOLE_CHANNEL_CONTENT_PREFIXES: &str =
    "kind=diagnostic kind=nativestderr kind=nativestdout kind=nativeerror kind=native-";

/// True when `text` is only a whole-channel content-redaction marker.
#[must_use]
pub fn is_whole_channel_content_redaction(text: &str) -> bool {
    let trimmed = text.trim();
    let Some(rest) = trimmed
        .strip_prefix("[REDACTED_CONTENT ")
        .and_then(|value| value.strip_suffix(']'))
    else {
        return false;
    };
    let rest = rest.trim_start();
    WHOLE_CHANNEL_CONTENT_PREFIXES
        .split_ascii_whitespace()
        .any(|prefix| rest.starts_with(prefix))
        && !rest.contains('\n')
}

/// Guard used by the operator-diagnostic chokepoint and by tests. Fails when a
/// diagnostic body is only a whole-channel content hash.
pub fn assert_not_whole_channel_content_redaction(diagnostic: &str) -> Result<(), String> {
    if is_whole_channel_content_redaction(diagnostic) {
        return Err(format!(
            "native diagnostic whole-channel content redaction is forbidden: \
             pass the channel through and redact only identified content spans \
             (got {diagnostic})"
        ));
    }
    Ok(())
}
