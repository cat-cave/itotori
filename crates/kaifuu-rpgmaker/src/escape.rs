//! RPG Maker MV/MZ message-control-code (`\`-escape) scanner.
//!
//! Message text in RPG Maker (`Show Text` / `Show Scrolling Text` lines,
//! choice labels, and many database fields) embeds runtime control codes
//! introduced by a backslash:
//!
//! - Argument-bearing codes: `\V[n]` (variable), `\N[n]` (actor name),
//!   `\P[n]` (party-member name), `\C[n]` (text colour), `\I[n]` (icon),
//!   and plugin codes such as `\PX[n]` / `\FS[n]`. The engine matches the
//!   code letters case-insensitively, so the corpus stores them in either
//!   case (`\i[5]`, `\v[22]`).
//! - Bare codes: `\.` (wait 1/4s), `\|` (wait 1s), `\!` (wait for input),
//!   `\>` / `\<` (instant on/off), `\^` (no input wait), `\$` (gold
//!   window), `\{` / `\}` (font bigger/smaller), `\G` (currency unit),
//!   `\\` (literal backslash).
//!
//! Every one of these is a **protected span**: a translate+patchback pass
//! that drops or rewrites a `\V[22]` would corrupt the runtime
//! substitution, so each is emitted as a `control_markup` span with
//! `preserveMode = "exact"`. This scanner is the no-silent-skip guarantee
//! for inline markup: it never discards a `\`-run, and an
//! unrecognised-but-well-formed `\X[..]` is still surfaced as a span (its
//! `parsedName` records the code) rather than being silently flattened
//! into translatable prose.

/// A protected control-code span discovered inside one source string.
///
/// `start_byte`/`end_byte` are byte offsets into the **decoded UTF-8
/// source text** (the raw JSON string value). RPG Maker control codes are
/// ASCII, so the span always lands on UTF-8 boundaries.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EscapeSpan {
    pub start_byte: usize,
    pub end_byte: usize,
    pub raw: String,
    /// Stable parsed name, e.g. `rpgmaker.escape.V` or `rpgmaker.escape.!`.
    pub parsed_name: String,
    /// Bracket argument contents, when the code carried a `[...]` group.
    pub argument: Option<String>,
}

/// Bare (no-bracket) single-character control codes.
const BARE_SYMBOL_CODES: &[u8] = b".|!><^${}";

/// Scan `text` for every RPG Maker `\`-control code, in source order.
///
/// The returned spans are non-overlapping and sorted ascending by
/// `start_byte` (encounter order is already ascending), so they satisfy
/// the v0.2 span-ordering / non-overlap contract directly.
pub fn scan_escape_spans(text: &str) -> Vec<EscapeSpan> {
    let bytes = text.as_bytes();
    let mut spans = Vec::new();
    let mut i = 0usize;
    while i < bytes.len() {
        if bytes[i] != b'\\' {
            i += 1;
            continue;
        }
        let start = i;
        let Some(&next) = bytes.get(i + 1) else {
            // Trailing lone backslash: still markup to preserve.
            spans.push(EscapeSpan {
                start_byte: start,
                end_byte: bytes.len(),
                raw: "\\".to_string(),
                parsed_name: "rpgmaker.escape.backslash".to_string(),
                argument: None,
            });
            break;
        };

        if next == b'\\' {
            // `\\` — literal backslash escape.
            spans.push(EscapeSpan {
                start_byte: start,
                end_byte: start + 2,
                raw: "\\\\".to_string(),
                parsed_name: "rpgmaker.escape.backslash".to_string(),
                argument: None,
            });
            i = start + 2;
            continue;
        }

        if next.is_ascii_alphabetic() {
            // Letter code: consume the (possibly multi-letter) code name,
            // then an optional `[...]` argument group.
            let mut j = i + 1;
            while j < bytes.len() && bytes[j].is_ascii_alphabetic() {
                j += 1;
            }
            let code = text[i + 1..j].to_string();
            let mut argument = None;
            if bytes.get(j) == Some(&b'[') {
                // Consume to the matching `]` (RPG Maker arg groups do not
                // nest); a missing `]` leaves the bracket unconsumed so the
                // remaining text stays translatable.
                if let Some(close_rel) = text[j..].find(']') {
                    let close = j + close_rel;
                    argument = Some(text[j + 1..close].to_string());
                    j = close + 1;
                }
            }
            spans.push(EscapeSpan {
                start_byte: start,
                end_byte: j,
                raw: text[start..j].to_string(),
                parsed_name: format!("rpgmaker.escape.{}", code.to_ascii_uppercase()),
                argument,
            });
            i = j;
            continue;
        }

        if BARE_SYMBOL_CODES.contains(&next) {
            spans.push(EscapeSpan {
                start_byte: start,
                end_byte: start + 2,
                raw: text[start..start + 2].to_string(),
                parsed_name: format!("rpgmaker.escape.{}", next as char),
                argument: None,
            });
            i = start + 2;
            continue;
        }

        // `\` followed by some other byte (e.g. whitespace): preserve the
        // backslash itself as markup and advance past it. The following
        // byte is re-examined on the next iteration.
        spans.push(EscapeSpan {
            start_byte: start,
            end_byte: start + 1,
            raw: "\\".to_string(),
            parsed_name: "rpgmaker.escape.backslash".to_string(),
            argument: None,
        });
        i = start + 1;
    }
    spans
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extracts_argument_bearing_and_bare_codes_case_insensitively() {
        // Synthetic (non-retail) line exercising mixed-case + bracket +
        // bare codes.
        let text = "Gold:\\v[22]\\C[3]hi\\i[5]\\!\\}end";
        let spans = scan_escape_spans(text);
        let names: Vec<&str> = spans.iter().map(|s| s.parsed_name.as_str()).collect();
        assert_eq!(
            names,
            vec![
                "rpgmaker.escape.V",
                "rpgmaker.escape.C",
                "rpgmaker.escape.I",
                "rpgmaker.escape.!",
                "rpgmaker.escape.}",
            ]
        );
        assert_eq!(spans[0].argument.as_deref(), Some("22"));
        assert_eq!(spans[0].raw, "\\v[22]");
        // Byte ranges must reproduce the raw substring exactly.
        for span in &spans {
            assert_eq!(&text[span.start_byte..span.end_byte], span.raw);
        }
    }

    #[test]
    fn literal_double_backslash_is_one_span_not_two() {
        let text = "a\\\\b";
        let spans = scan_escape_spans(text);
        assert_eq!(spans.len(), 1);
        assert_eq!(spans[0].raw, "\\\\");
        assert_eq!(spans[0].parsed_name, "rpgmaker.escape.backslash");
    }

    #[test]
    fn no_escape_yields_no_spans() {
        assert!(scan_escape_spans("plain text, no codes").is_empty());
    }
}
