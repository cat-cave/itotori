use super::*;
impl Gameexe {
    /// Parse a `Gameexe.ini` byte slice.
    ///
    /// Decodes Shift-JIS via `encoding_rs`. Surfaces typed
    /// [`GameexeParseError`] on Shift-JIS substitution or structural
    /// failure. A failed numeric token preserves its scalar value and
    /// records a [`GameexeParseWarning`] in [`Gameexe::warnings`].
    pub fn parse(bytes: &[u8]) -> Result<Self, GameexeParseError> {
        let mut entries: HashMap<String, GameexeValue> = HashMap::new();
        let mut order: Vec<String> = Vec::new();
        let mut warnings: Vec<GameexeParseWarning> = Vec::new();
        let mut cursor = 0usize;
        let mut line_number: u64 = 0;
        while cursor < bytes.len() {
            line_number += 1;
            let line_start = cursor;
            let mut newline = cursor;
            while newline < bytes.len() && bytes[newline] != b'\n' {
                newline += 1;
            }
            let mut line_end = newline;
            if line_end > line_start && bytes[line_end - 1] == b'\r' {
                line_end -= 1;
            }
            cursor = newline.saturating_add(1).min(bytes.len() + 1);
            if cursor > bytes.len() {
                cursor = bytes.len();
            }
            let line_bytes = &bytes[line_start..line_end];

            // Cheap skips before the Shift-JIS round-trip: an empty
            // line or a line whose first non-whitespace byte is not `#`
            // is a comment or blank and is ignored.
            let trimmed_bytes = trim_leading_ascii_ws(line_bytes);
            if trimmed_bytes.is_empty() || trimmed_bytes[0] != b'#' {
                continue;
            }

            // Now decode Shift-JIS strictly. `encoding_rs` returns
            // `had_replacement` when it substituted U+FFFD; we surface
            // that as a typed error so the caller cannot ignore it.
            let (decoded, _, had_replacement) = SHIFT_JIS.decode(line_bytes);
            if had_replacement {
                return Err(GameexeParseError::ShiftJisDecode {
                    code: GAMEEXE_SHIFT_JIS_DECODE_FAILURE_CODE.to_string(),
                    line_number,
                    byte_len: line_bytes.len() as u64,
                });
            }
            let decoded = decoded.into_owned();
            let trimmed = trim_leading_ws(&decoded);

            // Split at the first `=` or whitespace. We require a
            // separator at minimum so structural errors raise instead
            // of silently dropping a `#KEY` with no value. The
            // line-classifier in `kaifuu-reallive` is permissive on
            // this point; the structural parser is not.
            let Some((key_raw, value_raw)) = split_key_value(trimmed) else {
                return Err(GameexeParseError::MissingSeparator {
                    line_number,
                    raw: decoded,
                });
            };
            let bare_key = key_raw
                .strip_prefix('#')
                .ok_or_else(|| GameexeParseError::MalformedKey {
                    line_number,
                    raw: decoded.clone(),
                })?
                .trim();
            if bare_key.is_empty() || bare_key.starts_with('.') || bare_key.starts_with('=') {
                return Err(GameexeParseError::MalformedKey {
                    line_number,
                    raw: decoded,
                });
            }
            let upper_key = bare_key.to_uppercase();
            let value_text = value_raw.trim();

            // Per-shape branching. The order matters: dotted prefixes
            // are checked before bare suffix-stripping so the more
            // specific shape wins.
            let (final_key, value) = if let Some(kind) = upper_key.strip_prefix("FOLDNAME.") {
                let parsed = parse_foldname_triple(value_text).ok_or_else(|| {
                    GameexeParseError::MalformedFoldname {
                        line_number,
                        raw: value_text.to_string(),
                    }
                })?;
                (format!("FOLDNAME.{kind}"), parsed)
            } else if upper_key == "NAMAE" {
                let (display, value) = parse_namae_entry(value_text).ok_or_else(|| {
                    GameexeParseError::MalformedNamae {
                        line_number,
                        raw: value_text.to_string(),
                    }
                })?;
                (format!("NAMAE.{display}"), value)
            } else if upper_key.starts_with("SYSCOM.") {
                let label = parse_syscom_label(value_text);
                (upper_key, GameexeValue::SyscomLabel(label))
            } else {
                let value = parse_scalar_value(&upper_key, value_text, &mut warnings);
                (upper_key, value)
            };

            if !entries.contains_key(&final_key) {
                order.push(final_key.clone());
            }
            entries.insert(final_key, value);
        }
        Ok(Self {
            entries,
            order,
            warnings,
        })
    }
}

/// Parse a RealLive `#WINDOW.xxx.POS` value (`"type:x,y"`) into
/// `(origin_type, x, y)`. Returns `None` when the shape does not match.
pub(super) fn parse_pos_triple(raw: &str) -> Option<(i32, i32, i32)> {
    let (type_text, coords) = raw.split_once(':')?;
    let origin: i32 = type_text.trim().parse().ok()?;
    let (x_text, y_text) = coords.split_once(',')?;
    let x: i32 = x_text.trim().parse().ok()?;
    let y: i32 = y_text.trim().parse().ok()?;
    Some((origin, x, y))
}

/// Clamp an `i32` Gameexe colour/alpha channel into `u8` range.
pub(super) fn clamp_u8(value: i32) -> u8 {
    value.clamp(0, 255) as u8
}

pub(super) fn normalise_key(key: &str) -> String {
    key.trim().trim_start_matches('#').to_uppercase()
}

fn trim_leading_ascii_ws(bytes: &[u8]) -> &[u8] {
    let mut start = 0;
    while start < bytes.len() && bytes[start].is_ascii_whitespace() {
        start += 1;
    }
    &bytes[start..]
}

fn trim_leading_ws(text: &str) -> &str {
    text.trim_start()
}

/// Split a trimmed `#KEY = VALUE` line into its key half and value
/// half. The separator can be `=` or whitespace (Gameexe.ini accepts
/// both). Returns `None` if no separator is found.
fn split_key_value(line: &str) -> Option<(&str, &str)> {
    let mut split_at = None;
    for (i, ch) in line.char_indices() {
        if ch == '=' || ch.is_ascii_whitespace() {
            split_at = Some((i, ch));
            break;
        }
    }
    let (i, separator) = split_at?;
    let key = &line[..i];
    let mut rest = &line[i + separator.len_utf8()..];
    // Consume the rest of the separator run.
    loop {
        let mut chars = rest.char_indices();
        match chars.next() {
            Some((0, ch)) if ch == '=' || ch.is_ascii_whitespace() => {
                rest = &rest[ch.len_utf8()..];
            }
            _ => break,
        }
    }
    Some((key, rest))
}

/// Decide the shape of a raw RHS for a non-special key.
///
/// Order of operations:
/// 1. If the entire trimmed RHS is `"…"`, return [`GameexeValue::Str`] with
///    the unquoted body.
/// 2. If every comma-separated, whitespace-trimmed token parses as an
///    `i32`, return [`GameexeValue::IntArray`]. A failed token is added
///    to `warnings`.
/// 3. Otherwise treat the RHS as a string scalar
///    ([`GameexeValue::Str`]).
fn parse_scalar_value(
    key: &str,
    raw: &str,
    warnings: &mut Vec<GameexeParseWarning>,
) -> GameexeValue {
    let trimmed = raw.trim();
    if let Some(inner) = strip_outer_quotes(trimmed) {
        return GameexeValue::Str(inner.to_string());
    }
    if let Some(ints) = parse_int_list(key, trimmed, warnings) {
        return GameexeValue::IntArray(ints);
    }
    GameexeValue::Str(trimmed.to_string())
}

fn strip_outer_quotes(text: &str) -> Option<&str> {
    let bytes = text.as_bytes();
    if bytes.len() >= 2 && bytes[0] == b'"' && bytes[bytes.len() - 1] == b'"' {
        let inner = &text[1..text.len() - 1];
        if !inner.contains('"') {
            return Some(inner);
        }
    }
    None
}

fn parse_int_list(
    key: &str,
    text: &str,
    warnings: &mut Vec<GameexeParseWarning>,
) -> Option<Vec<i32>> {
    let mut out = Vec::new();
    for token in text.split(',') {
        let token = token.trim();
        if token.is_empty() {
            return None;
        }
        let Ok(parsed) = token.parse::<i32>() else {
            warnings.push(GameexeParseWarning {
                key: key.to_string(),
                raw: token.to_string(),
            });
            return None;
        };
        out.push(parsed);
    }
    if out.is_empty() { None } else { Some(out) }
}

/// Parse a `FOLDNAME` RHS:
/// `"<name>" = <mode>: "<archive>"`. The archive string may be empty
/// (`#FOLDNAME.KOE = "KOE" = 1: ""`).
fn parse_foldname_triple(raw: &str) -> Option<GameexeValue> {
    let (name_field, after_name) = take_quoted_string(raw)?;
    let after_name = skip_separator(after_name, '=');
    let (mode_text, after_mode) = take_until(after_name, ':');
    let mode: i32 = mode_text.trim().parse().ok()?;
    let after_colon = after_mode.strip_prefix(':')?.trim_start();
    let (archive_field, _) = take_quoted_string(after_colon)?;
    Some(GameexeValue::Tuple3 {
        name: name_field.to_string(),
        mode,
        archive: archive_field.to_string(),
    })
}

/// Parse a `NAMAE` RHS:
/// `"<display>" = "<canonical>" = (<mode>, <color_table_index>, <reserved>)`.
/// Returns the parsed display key alongside the value so the caller
/// can route the entry under `NAMAE.<display>` in the flat map.
fn parse_namae_entry(raw: &str) -> Option<(String, GameexeValue)> {
    let (display, after_display) = take_quoted_string(raw)?;
    let after_display = skip_separator(after_display, '=');
    let (canonical, after_canonical) = take_quoted_string(after_display)?;
    let after_canonical = skip_separator(after_canonical, '=');
    let after_open = after_canonical.trim_start().strip_prefix('(')?;
    let close = after_open.find(')')?;
    let tuple_text = &after_open[..close];
    let parts: Vec<&str> = tuple_text.split(',').map(str::trim).collect();
    if parts.len() != 3 {
        return None;
    }
    let mode: i32 = parts[0].parse().ok()?;
    let color_table_index: i32 = parts[1].parse().ok()?;
    let reserved: i32 = parts[2].parse().ok()?;
    Some((
        display.to_string(),
        GameexeValue::Namae(NamaeEntry {
            display: display.to_string(),
            canonical: canonical.to_string(),
            mode,
            color_table_index,
            reserved,
        }),
    ))
}

/// Parse a `SYSCOM.*` RHS, peeling off the optional `U:` / `N:`
/// visibility prefix and the surrounding quotes.
///
/// Examples:
/// - `U:"画面モード"` → `(User, "画面モード")`
/// - `N:"ＢＧＭ設定"` → `(Navigation, "ＢＧＭ設定")`
/// - `"フルスクリーン"` → `(Unspecified, "フルスクリーン")`
/// - `1` → `(Unspecified, "1")` (sub-keys like `SYSCOM.002.PAGE=0` land
///   here)
fn parse_syscom_label(raw: &str) -> SyscomLabel {
    let trimmed = raw.trim();
    let (visibility, body) = if let Some(rest) = trimmed.strip_prefix("U:") {
        (SyscomVisibility::User, rest)
    } else if let Some(rest) = trimmed.strip_prefix("N:") {
        (SyscomVisibility::Navigation, rest)
    } else {
        (SyscomVisibility::Unspecified, trimmed)
    };
    let body = body.trim();
    let label = strip_outer_quotes(body).map_or_else(|| body.to_string(), str::to_string);
    SyscomLabel { visibility, label }
}

/// Read a quoted `"…"` substring at the start of `text` and return
/// `(inner, rest)` where `rest` is the byte run after the closing
/// quote. Trims leading whitespace. Returns `None` if the input does
/// not begin with a quote or has no matching closing quote.
fn take_quoted_string(text: &str) -> Option<(&str, &str)> {
    let text = text.trim_start();
    let rest = text.strip_prefix('"')?;
    let close = rest.find('"')?;
    let inner = &rest[..close];
    let after = &rest[close + 1..];
    Some((inner, after))
}

/// Skip leading whitespace and a single occurrence of `separator`.
fn skip_separator(text: &str, separator: char) -> &str {
    let text = text.trim_start();
    text.strip_prefix(separator).map_or(text, str::trim_start)
}

/// Split `text` at the first occurrence of `delimiter`, returning
/// `(before, from_delimiter_inclusive)`.
fn take_until(text: &str, delimiter: char) -> (&str, &str) {
    match text.find(delimiter) {
        Some(idx) => (&text[..idx], &text[idx..]),
        None => (text, ""),
    }
}
