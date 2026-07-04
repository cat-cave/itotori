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
//! ## What is modelled vs. deferred (UTSUSHI-038 macro subset)
//!
//! - Modelled control flow: `*label`, `@jump`/`[jump]`, and
//!   `[link …]…[endlink]` choices (each `link` item is one choice option;
//!   a maximal run of adjacent links is one choice menu).
//! - **Macro DEFINITION + invocation (bounded subset).** A
//!   `[macro name="x"]…[endmacro]` block DEFINES macro `x`; its body lines
//!   are captured as a template (they emit no instruction and no diagnostic).
//!   A later invocation `[x arg=…]` (or `@x arg=…`) of a defined macro is
//!   EXPANDED inline: each body line has `%param` substituted from the
//!   invocation attributes (`%name`, or `%name|default` for an optional
//!   parameter) and is then re-parsed as ordinary KAG. Substitution is a
//!   literal textual splice — NOT TJS evaluation. A macro whose expansion is
//!   OUTSIDE the subset (a `%param` with no supplied value and no default, or
//!   an invocation nested past [`MAX_MACRO_DEPTH`]) is NOT faked: it collapses
//!   to a single [`Instr::UnexpandedMacro`] that the replay turns into a typed
//!   `unsupported_macro` diagnostic. A macro body is treated as flat KAG lines
//!   (it does not itself open `[iscript]`/`[macro]` blocks).
//! - `[iscript]…[endscript]` TJS blocks are recognised and their bodies are
//!   **swallowed whole** so TJS source never leaks into the text stream; the
//!   block collapses to a single [`Instr::UnsupportedBlock`], which the replay
//!   turns into a typed `unsupported_tjs_block` diagnostic.

use std::collections::BTreeMap;

use crate::encoding::KagEncoding;

/// Maximum macro-invocation nesting depth expanded before an invocation is
/// recorded as an [`Instr::UnexpandedMacro`] (guards against a recursive
/// macro expanding without bound). Sized well above any realistic KAG macro
/// nesting.
pub const MAX_MACRO_DEPTH: u32 = 32;

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

/// Kind of a swallowed multi-line block whose body is TJS source, not KAG.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum BlockKind {
    /// `[iscript]…[endscript]` — an inline TJS block.
    IScript,
}

impl BlockKind {
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::IScript => "iscript",
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
    /// A swallowed TJS block whose body was not parsed as KAG.
    UnsupportedBlock(BlockKind),
    /// A macro construct outside the supported expansion subset — a macro
    /// invocation whose `%param`s could not be resolved, a malformed/nameless
    /// `[macro]` definition, or an invocation nested past
    /// [`MAX_MACRO_DEPTH`]. Carries the macro name (or `"macro"` when the
    /// definition had no usable name). Never a faked expansion — the replay
    /// turns it into a typed `unsupported_macro` diagnostic.
    UnexpandedMacro(String),
}

/// A parsed KAG `.ks` script, ready for replay.
#[derive(Clone, Debug)]
pub struct KagScript {
    /// Source file name (as supplied; used for same-file jump checks).
    pub source_file: String,
    /// Detected encoding.
    pub encoding: KagEncoding,
    /// Execution-ordered instruction stream (macro invocations already
    /// expanded inline).
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

    // Defined macros: name -> raw body lines (captured verbatim, expanded on
    // invocation). Built as the linear scan proceeds, so a macro can only be
    // invoked after it is defined (matching a linear KAG load).
    let mut macros: BTreeMap<String, Vec<String>> = BTreeMap::new();
    // While `Some((name, body))`, physical lines are captured into a macro
    // definition until `[endmacro]` closes it.
    let mut open_macro: Option<(String, Vec<String>)> = None;
    // While `true`, physical lines are swallowed as `[iscript]` TJS body.
    let mut open_iscript = false;

    for raw_line in text.split('\n') {
        let line = raw_line.strip_suffix('\r').unwrap_or(raw_line);

        // 1. Capturing a macro definition body.
        if let Some((_, body)) = open_macro.as_mut() {
            if line_contains_tag(line, "endmacro") {
                let (name, body) = open_macro.take().expect("open_macro is Some");
                define_macro(name, body, &mut macros, &mut instrs);
            } else {
                body.push(line.to_string());
            }
            continue;
        }

        // 2. Swallowing an `[iscript]` block body.
        if open_iscript {
            if line_contains_tag(line, "endscript") {
                instrs.push(Instr::UnsupportedBlock(BlockKind::IScript));
                open_iscript = false;
            }
            continue;
        }

        // 3. A line whose FIRST inline tag opens a macro definition.
        if let Some(cmd) = leading_command(line)
            && cmd.name == "macro"
        {
            let name = cmd.attr("name").unwrap_or("").to_string();
            if line_contains_tag(line, "endmacro") {
                // Single-line `[macro name=x]body[endmacro]`.
                let body = single_line_macro_body(line);
                define_macro(name, body, &mut macros, &mut instrs);
            } else {
                open_macro = Some((name, Vec::new()));
            }
            continue;
        }

        // 4. A line whose FIRST inline tag opens an `[iscript]` block.
        if leading_tag_name(line.trim_start()).as_deref() == Some("iscript") {
            if line_contains_tag(line, "endscript") {
                instrs.push(Instr::UnsupportedBlock(BlockKind::IScript));
            } else {
                open_iscript = true;
            }
            continue;
        }

        // 5. An ordinary line: parse it, expanding any macro invocations.
        emit_line(line, &macros, &mut instrs, 0);
    }

    // An unterminated block/definition still surfaces its marker (recorded,
    // not lost).
    if open_iscript {
        instrs.push(Instr::UnsupportedBlock(BlockKind::IScript));
    }
    if let Some((name, _)) = open_macro {
        instrs.push(Instr::UnexpandedMacro(macro_detail(&name)));
    }

    let labels = index_labels(&instrs);
    KagScript {
        source_file: source_file.to_string(),
        encoding,
        instrs,
        labels,
    }
}

/// Record a finished macro definition. A nameless definition cannot be
/// invoked, so it surfaces a typed `unsupported_macro` diagnostic instead of
/// being silently dropped.
fn define_macro(
    name: String,
    body: Vec<String>,
    macros: &mut BTreeMap<String, Vec<String>>,
    instrs: &mut Vec<Instr>,
) {
    if name.is_empty() {
        instrs.push(Instr::UnexpandedMacro(macro_detail(&name)));
    } else {
        macros.insert(name, body);
    }
}

fn macro_detail(name: &str) -> String {
    if name.is_empty() {
        "macro".to_string()
    } else {
        name.to_string()
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

/// Parse one physical `line` into instructions, EXPANDING any inline command
/// that names a defined macro. Non-macro instructions pass through unchanged.
fn emit_line(
    line: &str,
    macros: &BTreeMap<String, Vec<String>>,
    instrs: &mut Vec<Instr>,
    depth: u32,
) {
    let mut parsed: Vec<Instr> = Vec::new();
    parse_line(line, &mut parsed);
    for instr in parsed {
        match instr {
            Instr::Command(cmd) if macros.contains_key(&cmd.name) => {
                expand_invocation(&cmd, macros, instrs, depth);
            }
            other => instrs.push(other),
        }
    }
}

/// Expand a macro invocation `cmd` by splicing its (parameter-substituted)
/// body into `instrs`. A `%param` with no supplied attribute and no default,
/// or nesting past [`MAX_MACRO_DEPTH`], is NOT faked — the whole invocation
/// collapses to a single [`Instr::UnexpandedMacro`].
fn expand_invocation(
    cmd: &Command,
    macros: &BTreeMap<String, Vec<String>>,
    instrs: &mut Vec<Instr>,
    depth: u32,
) {
    if depth >= MAX_MACRO_DEPTH {
        instrs.push(Instr::UnexpandedMacro(cmd.name.clone()));
        return;
    }
    let body = &macros[&cmd.name];
    // Resolve every body line up front: if any `%param` is unresolved, the
    // invocation is out of subset and NOTHING is emitted (no partial/faked
    // expansion).
    let mut substituted: Vec<String> = Vec::with_capacity(body.len());
    for body_line in body {
        match substitute_params(body_line, &cmd.attrs) {
            Ok(line) => substituted.push(line),
            Err(_missing_param) => {
                instrs.push(Instr::UnexpandedMacro(cmd.name.clone()));
                return;
            }
        }
    }
    for line in substituted {
        emit_line(&line, macros, instrs, depth + 1);
    }
}

/// Substitute `%param` references in a macro body line from the invocation
/// `attrs`. `%name` takes the invocation's `name=` value; `%name|default`
/// falls back to `default` when the attribute is absent. A `%param` with
/// neither an attribute nor a default is [`Err`] (the invocation is out of
/// subset). A lone `%` (not followed by an identifier) is a literal `%`.
fn substitute_params(line: &str, attrs: &[Attr]) -> Result<String, String> {
    let chars: Vec<char> = line.chars().collect();
    let mut out = String::with_capacity(line.len());
    let mut i = 0usize;
    while i < chars.len() {
        if chars[i] != '%' {
            out.push(chars[i]);
            i += 1;
            continue;
        }
        // Read the parameter identifier following `%`.
        let mut j = i + 1;
        let mut ident = String::new();
        while j < chars.len() && (chars[j].is_ascii_alphanumeric() || chars[j] == '_') {
            ident.push(chars[j]);
            j += 1;
        }
        if ident.is_empty() {
            out.push('%'); // lone `%` — literal
            i += 1;
            continue;
        }
        // Optional `|default` (terminated by whitespace, `]`, or a quote).
        let mut default: Option<String> = None;
        if j < chars.len() && chars[j] == '|' {
            j += 1;
            let mut d = String::new();
            while j < chars.len()
                && !chars[j].is_whitespace()
                && chars[j] != ']'
                && chars[j] != '"'
                && chars[j] != '\''
            {
                d.push(chars[j]);
                j += 1;
            }
            default = Some(d);
        }
        let value = attrs
            .iter()
            .find(|a| a.key == ident)
            .map(|a| a.value.clone())
            .or(default)
            .ok_or_else(|| ident.clone())?;
        out.push_str(&value);
        i = j;
    }
    Ok(out)
}

/// Whether any inline `[tag …]` on `line` names `want` (used to detect a
/// block's closing tag, which may trail body text on the same physical line).
fn line_contains_tag(line: &str, want: &str) -> bool {
    let mut rest = line;
    while let Some(open) = rest.find('[') {
        rest = &rest[open..];
        // `[[` is the literal-bracket escape, not a tag.
        if rest.starts_with("[[") {
            rest = &rest[2..];
            continue;
        }
        let Some(end) = rest.find(']') else { break };
        let inner = rest[1..end].trim();
        let name = inner.split_whitespace().next().unwrap_or("");
        if name == want {
            return true;
        }
        rest = &rest[end + 1..];
    }
    false
}

/// The body of a single-line `[macro …]body[endmacro]` (the text between the
/// macro tag's closing `]` and the `[endmacro]`), as one body line.
fn single_line_macro_body(line: &str) -> Vec<String> {
    let trimmed = line.trim_start();
    let Some(macro_close) = trimmed.find(']') else {
        return Vec::new();
    };
    let after = &trimmed[macro_close + 1..];
    let end = after.find("[endmacro]").unwrap_or(after.len());
    let body = &after[..end];
    if body.is_empty() {
        Vec::new()
    } else {
        vec![body.to_string()]
    }
}

/// Parse the FIRST inline `[tag …]` on `line` into a [`Command`] (after
/// leading whitespace), else `None`. Used to inspect a macro definition's
/// opening tag.
fn leading_command(line: &str) -> Option<Command> {
    let trimmed = line.trim_start();
    let rest = trimmed.strip_prefix('[')?;
    if rest.starts_with('[') {
        return None; // `[[` escape
    }
    let end = rest.find(']')?;
    Some(parse_command(&rest[..end]))
}

/// The name of the first `[tag …]` if `trimmed` starts with one, else `None`.
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
