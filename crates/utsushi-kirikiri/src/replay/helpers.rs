use super::*;

/// Text runs / no-op presentational tags may sit between `[link]` items in a
/// choice menu; those separators are skipped when scanning the menu.
pub(super) fn is_link_separator(instr: &Instr) -> bool {
    match instr {
        Instr::Text(_) => true,
        Instr::Command(cmd) => matches!(cmd.name.as_str(), "r" | "l" | "p" | "pg"),
        _ => false,
    }
}

/// Collect the visible text of one link option: the `Text` runs between a
/// `[link]` and its `[endlink]`. Returns the joined text and the index just
/// past the `[endlink]` (or past the last consumed instruction).
pub(super) fn collect_link_text(instrs: &[Instr], start: usize) -> (String, usize) {
    let mut text = String::new();
    let mut i = start;
    while i < instrs.len() {
        match &instrs[i] {
            Instr::Text(run) => {
                text.push_str(run);
                i += 1;
            }
            Instr::Command(cmd) if cmd.name == "endlink" => {
                i += 1;
                break;
            }
            // Another `[link]` (or anything else) without an intervening
            // `[endlink]` ends this option's text.
            _ => break,
        }
    }
    (text, i)
}

pub(super) fn strip_label_star(target: &str) -> &str {
    target.strip_prefix('*').unwrap_or(target)
}

/// Outcome of evaluating an `[eval]` expression against the supported subset.
pub(super) enum EvalOutcome {
    /// A supported assignment: `name`:= `value`.
    Assigned { name: String, value: VarValue },
    /// A recognised assignment shape that reads an UNBOUND variable.
    UnresolvedVar(String),
    /// Outside the supported subset entirely.
    Unsupported,
}

/// Outcome of evaluating a right-hand side.
pub(super) enum RhsOutcome {
    Value(VarValue),
    UnresolvedVar(String),
    Unsupported,
}

/// Outcome of resolving a single operand.
pub(super) enum OperandOutcome {
    Value(VarValue),
    UnresolvedVar(String),
    Unsupported,
}

/// Outcome of resolving an operand constrained to an integer.
pub(super) enum IntOutcome {
    Value(i64),
    UnresolvedVar(String),
    Unsupported,
}

/// If `s` is exactly an `f.IDENT` / `sf.IDENT` variable name, return it
/// (whole, including the prefix). `IDENT` is `[A-Za-z0-9_]+` with no further
/// `.`, so `f.a.b`, `game.x`, and `f.` are rejected.
pub(super) fn parse_var_name(s: &str) -> Option<&str> {
    let s = s.trim();
    for prefix in ["f.", "sf."] {
        if let Some(rest) = s.strip_prefix(prefix)
            && !rest.is_empty()
            && rest.chars().all(|c| c.is_ascii_alphanumeric() || c == '_')
        {
            return Some(s);
        }
    }
    None
}

/// If `s` is a `"…"` / `'…'` string literal (no embedded quote of the same
/// kind, no escapes — the bounded subset), return its inner text.
pub(super) fn string_literal(s: &str) -> Option<String> {
    let s = s.trim();
    let bytes = s.as_bytes();
    if bytes.len() >= 2
        && (bytes[0] == b'"' || bytes[0] == b'\'')
        && bytes[bytes.len() - 1] == bytes[0]
    {
        let inner = &s[1..s.len() - 1];
        // A closing quote in the middle would be a concatenation/second token
        // — outside the single-literal subset.
        if !inner.contains(bytes[0] as char) {
            return Some(inner.to_string());
        }
    }
    None
}

/// Split a right-hand side into a single spaced binary `A OP B` where OP is
/// `+` or `-` (surrounding spaces REQUIRED, so a negative literal `-1` is one
/// operand, not an operator). Rejects a chained expression (a second top-level
/// operator) to stay inside the bounded subset.
pub(super) fn split_binary(rhs: &str) -> Option<(&str, char, &str)> {
    for (token, op) in [(" + ", '+'), (" - ", '-')] {
        if let Some((a, b)) = rhs.split_once(token) {
            // A chain (`a + b + c`) is out of subset.
            if b.contains(" + ") || b.contains(" - ") {
                return None;
            }
            return Some((a.trim(), op, b.trim()));
        }
    }
    None
}
