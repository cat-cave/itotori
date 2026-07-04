//! KAG `.ks` → REPLAY instruction stream.
//!
//! This is the Utsushi-side counterpart to KAIFUU-009's *extraction* parser
//! (`kaifuu-kirikiri::parse_ks`). Where the extraction parser produces
//! translatable text units + byte spans for patchback, this parser produces
//! a flat, execution-ordered [`Instr`] stream plus a `label -> index` map
//! that the [`crate::replay`] engine walks like a tiny VM.
//!
//! It re-derives the SAME documented KAG line dialect KAIFUU-009 handles
//! (column-0 classification: `;` comment, `*label` label, `@cmd` line
//! command, `#name` speaker line, and message/text lines split into runs
//! between inline `[tag …]` tags, with `[[` as the literal-`[` escape). The
//! re-derivation (rather than a production dependency) matches the
//! workspace's engine-port isolation posture; the text+name cross-validation
//! test proves the two parsers agree on real output.
//!
//! ## What is modelled vs. deferred
//!
//! - Modelled control flow: `*label`, `@jump`/`[jump]`, and
//!   `[link …]…[endlink]` choices (each `link` item is one choice option;
//!   a maximal run of adjacent links is one choice menu).
//! - Multi-line TJS blocks are recognised and their bodies are **swallowed
//!   whole** so TJS source never leaks into the text stream:
//!   `[iscript]…[endscript]` and `[macro …]…[endmacro]` each collapse to a
//!   single [`Instr::UnsupportedBlock`]. The replay turns that into a typed
//!   semantic diagnostic — recognised, never silently skipped.

use std::collections::BTreeMap;

use crate::encoding::KagEncoding;

/// One `key=value` (or bare `key`) attribute on a KAG command/tag. Values
/// keep their decoded text; surrounding `"`/`'` quotes are stripped.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Attr {
    /// Attribute name (lower-cased ASCII is NOT forced — KAG keys are
    /// case-sensitive; callers compare against known lower-case names).
    pub key: String,
    /// Attribute value, quotes stripped. Empty string for a bare flag.
    pub value: String,
}

/// A KAG command: either an inline `[name …]` tag or an `@name …` line
/// command (the two are semantically interchangeable in KAG, so the replay
/// treats them uniformly).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Command {
    /// Command name (e.g. `jump`, `link`, `eval`).
    pub name: String,
    /// Parsed attributes, in source order.
    pub attrs: Vec<Attr>,
}

impl Command {
    /// First attribute value for `key`, if present.
    #[must_use]
    pub fn attr(&self, key: &str) -> Option<&str> {
        self.attrs
            .iter()
            .find(|a| a.key == key)
            .map(|a| a.value.as_str())
    }

    /// Whether any attribute carries a TJS expression (`exp=` / `cond=`) —
    /// the marker that a tag is driven by TJS scripting the skeleton does
    /// not evaluate.
    #[must_use]
    pub fn has_tjs_expression(&self) -> bool {
        self.attrs.iter().any(|a| a.key == "exp" || a.key == "cond")
    }
}

/// Kind of a swallowed multi-line block whose body is TJS/macro source, not
/// KAG.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum BlockKind {
    /// `[iscript]…[endscript]` — an inline TJS block.
    IScript,
    /// `[macro …]…[endmacro]` — a macro definition.
    Macro,
}

impl BlockKind {
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::IScript => "iscript",
            Self::Macro => "macro",
        }
    }
}

/// One replay instruction. The stream is execution-ordered; jump targets are
/// resolved through [`KagScript::labels`].
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Instr {
    /// `*name` (the optional `|caption` page name is dropped). A jump target.
    Label(String),
    /// `#name` speaker line: `Some(display)` sets the active speaker,
    /// `None` (bare `#` or empty display) clears it.
    Name(Option<String>),
    /// A maximal run of message text between inline tags. Whitespace-only
    /// runs are dropped (matching KAIFUU-009), so every `Text` is
    /// translatable.
    Text(String),
    /// An inline `[tag …]` tag or an `@cmd …` line command.
    Command(Command),
    /// A swallowed TJS/macro block whose body was not parsed as KAG.
    UnsupportedBlock(BlockKind),
}

/// A parsed KAG `.ks` script, ready for replay.
#[derive(Clone, Debug)]
pub struct KagScript {
    /// Source file name (as supplied; used for same-file jump checks).
    pub source_file: String,
    /// Detected encoding.
    pub encoding: KagEncoding,
    /// Execution-ordered instruction stream.
    pub instrs: Vec<Instr>,
    /// `label name -> index into `instrs`` (the instruction the `*label`
    /// sits at). Later duplicate labels win, matching a linear KAG load.
    pub labels: BTreeMap<String, usize>,
}

/// Parse `bytes` as a plaintext KAG `.ks` script, auto-detecting the
/// encoding.
#[must_use]
pub fn parse_kag(source_file: &str, bytes: &[u8]) -> KagScript {
    let encoding = KagEncoding::detect(bytes);
    parse_kag_with_encoding(source_file, bytes, encoding)
}

/// Parse `bytes` under an explicit `encoding`.
#[must_use]
pub fn parse_kag_with_encoding(
    source_file: &str,
    bytes: &[u8],
    encoding: KagEncoding,
) -> KagScript {
    let text = encoding.decode(bytes);
    let mut instrs: Vec<Instr> = Vec::new();

    // Block-swallow state: while `Some(kind)`, physical lines are consumed
    // (not parsed as KAG) until the matching end tag closes the block.
    let mut open_block: Option<BlockKind> = None;

    for raw_line in text.split('\n') {
        let line = raw_line.strip_suffix('\r').unwrap_or(raw_line);

        if let Some(kind) = open_block {
            if line_closes_block(line, kind) {
                instrs.push(Instr::UnsupportedBlock(kind));
                open_block = None;
            }
            continue;
        }

        if let Some(kind) = line_opens_block(line) {
            // A single-line `[iscript][endscript]` closes immediately.
            if line_closes_block(line, kind) {
                instrs.push(Instr::UnsupportedBlock(kind));
            } else {
                open_block = Some(kind);
            }
            continue;
        }

        parse_line(line, &mut instrs);
    }

    // An unterminated block still surfaces its marker (recorded, not lost).
    if let Some(kind) = open_block {
        instrs.push(Instr::UnsupportedBlock(kind));
    }

    let labels = index_labels(&instrs);
    KagScript {
        source_file: source_file.to_string(),
        encoding,
        instrs,
        labels,
    }
}

fn index_labels(instrs: &[Instr]) -> BTreeMap<String, usize> {
    let mut labels = BTreeMap::new();
    for (index, instr) in instrs.iter().enumerate() {
        if let Instr::Label(name) = instr {
            labels.insert(name.clone(), index);
        }
    }
    labels
}

/// If `line` opens a swallowed block, which kind. Recognised by the FIRST
/// inline tag on the line being `[iscript]` or `[macro …]`.
fn line_opens_block(line: &str) -> Option<BlockKind> {
    let trimmed = line.trim_start();
    if let Some(name) = leading_tag_name(trimmed) {
        return match name.as_str() {
            "iscript" => Some(BlockKind::IScript),
            "macro" => Some(BlockKind::Macro),
            _ => None,
        };
    }
    None
}

fn line_closes_block(line: &str, kind: BlockKind) -> bool {
    let close = match kind {
        BlockKind::IScript => "endscript",
        BlockKind::Macro => "endmacro",
    };
    // Scan every inline tag on the line for the closing name (the close may
    // trail body text on the same physical line).
    let mut rest = line;
    while let Some(open) = rest.find('[') {
        rest = &rest[open..];
        let Some(end) = rest.find(']') else { break };
        let inner = rest[1..end].trim();
        let name = inner.split_whitespace().next().unwrap_or("");
        if name == close {
            return true;
        }
        rest = &rest[end + 1..];
    }
    false
}

/// The name of the first `[tag …]` if `line` starts with one (after leading
/// whitespace), else `None`.
fn leading_tag_name(trimmed: &str) -> Option<String> {
    let rest = trimmed.strip_prefix('[')?;
    // `[[` is the literal-bracket escape, never a tag.
    if rest.starts_with('[') {
        return None;
    }
    let end = rest.find(']')?;
    let inner = rest[..end].trim();
    let name = inner.split_whitespace().next().unwrap_or("");
    if name.is_empty() {
        None
    } else {
        Some(name.to_string())
    }
}

/// Classify one physical line by its column-0 character (KAG treats leading
/// whitespace as significant text, so classification is on the raw first
/// char).
fn parse_line(line: &str, instrs: &mut Vec<Instr>) {
    let mut chars = line.chars();
    let Some(first) = chars.next() else {
        return; // empty line
    };
    match first {
        ';' => {} // comment — pure structure, nothing to replay.
        '*' => {
            // `*name|caption` → label `name`.
            let rest = &line[first.len_utf8()..];
            let name = rest.split('|').next().unwrap_or("").trim();
            instrs.push(Instr::Label(name.to_string()));
        }
        '@' => {
            let rest = &line[first.len_utf8()..];
            instrs.push(Instr::Command(parse_command(rest)));
        }
        '#' => instrs.push(parse_name_line(line)),
        '[' if line[first.len_utf8()..].starts_with('[') => {
            // Leading `[[` escape → this is a text line beginning with a
            // literal `[`.
            parse_text_line(line, instrs);
        }
        _ => parse_text_line(line, instrs),
    }
}

/// `#display` / `#voice/display` / bare `#` (mirrors KAIFUU-009's
/// `parse_name_line`).
fn parse_name_line(line: &str) -> Instr {
    let after = &line['#'.len_utf8()..];
    if after.is_empty() {
        return Instr::Name(None); // bare `#` clears the speaker
    }
    // A `/` splits a voice-file id (structure) from the display name.
    let display = match after.split_once('/') {
        Some((_voice, display)) => display,
        None => after,
    };
    if display.is_empty() {
        Instr::Name(None)
    } else {
        Instr::Name(Some(display.to_string()))
    }
}

/// Split a message/text line into `Text` runs and inline `Command`s, in
/// order. `[[` stays inside the text run as a literal `[`.
fn parse_text_line(line: &str, instrs: &mut Vec<Instr>) {
    let bytes = line.as_bytes();
    let mut run = String::new();
    let mut i = 0usize;
    while i < bytes.len() {
        if bytes[i] == b'[' {
            if bytes.get(i + 1) == Some(&b'[') {
                run.push('['); // `[[` literal-bracket escape
                i += 2;
                continue;
            }
            flush_run(&mut run, instrs);
            // Scan to the closing `]`.
            if let Some(close_rel) = line[i + 1..].find(']') {
                let inner = &line[i + 1..i + 1 + close_rel];
                instrs.push(Instr::Command(parse_command(inner)));
                i = i + 1 + close_rel + 1;
            } else {
                // Unclosed inline tag: preserve the remainder as a command
                // name (no crash), matching KAIFUU-009's finding posture.
                let inner = &line[i + 1..];
                instrs.push(Instr::Command(parse_command(inner)));
                i = bytes.len();
            }
            continue;
        }
        // Advance one whole UTF-8 char (indices land on char boundaries).
        let ch_len = utf8_char_len(bytes[i]);
        let end = (i + ch_len).min(bytes.len());
        run.push_str(&line[i..end]);
        i = end;
    }
    flush_run(&mut run, instrs);
}

fn flush_run(run: &mut String, instrs: &mut Vec<Instr>) {
    if run.trim().is_empty() {
        run.clear();
    } else {
        instrs.push(Instr::Text(std::mem::take(run)));
    }
}

/// Parse `name key=value key2="v2" flag` (the shared body of an inline tag
/// and an `@` line command) into a [`Command`].
fn parse_command(inner: &str) -> Command {
    let trimmed = inner.trim();
    let mut parts = split_attrs(trimmed);
    let name = if parts.is_empty() {
        String::new()
    } else {
        parts.remove(0)
    };
    let attrs = parts.into_iter().map(parse_attr).collect();
    Command { name, attrs }
}

fn parse_attr(token: String) -> Attr {
    match token.split_once('=') {
        Some((key, value)) => Attr {
            key: key.trim().to_string(),
            value: strip_quotes(value.trim()).to_string(),
        },
        None => Attr {
            key: token.trim().to_string(),
            value: String::new(),
        },
    }
}

fn strip_quotes(value: &str) -> &str {
    let bytes = value.as_bytes();
    if bytes.len() >= 2
        && (bytes[0] == b'"' || bytes[0] == b'\'')
        && bytes[bytes.len() - 1] == bytes[0]
    {
        &value[1..value.len() - 1]
    } else {
        value
    }
}

/// Whitespace-split `inner` into tokens, keeping quoted values (which may
/// contain spaces) intact.
fn split_attrs(inner: &str) -> Vec<String> {
    let mut tokens: Vec<String> = Vec::new();
    let mut current = String::new();
    let mut quote: Option<char> = None;
    for ch in inner.chars() {
        match quote {
            Some(q) => {
                current.push(ch);
                if ch == q {
                    quote = None;
                }
            }
            None => {
                if ch == '"' || ch == '\'' {
                    quote = Some(ch);
                    current.push(ch);
                } else if ch.is_whitespace() {
                    if !current.is_empty() {
                        tokens.push(std::mem::take(&mut current));
                    }
                } else {
                    current.push(ch);
                }
            }
        }
    }
    if !current.is_empty() {
        tokens.push(current);
    }
    tokens
}

/// Byte length of a UTF-8 character from its lead byte (always `>= 1`).
fn utf8_char_len(lead: u8) -> usize {
    if lead < 0x80 {
        1
    } else if lead >= 0xF0 {
        4
    } else if lead >= 0xE0 {
        3
    } else if lead >= 0xC0 {
        2
    } else {
        1
    }
}
