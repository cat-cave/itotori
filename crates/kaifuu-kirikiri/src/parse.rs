//! KAG `.ks` plaintext scenario-script parser.
//! KAG (KiriKiri Adventure Game system) is KiriKiri's scenario scripting
//! layer; a `.ks` file is **plaintext** (Shift-JIS, UTF-8, or BOM-marked
//! UTF-16). This module
//! parses the KAG line dialect into a stable set of translatable
//! [`KsUnit`]s plus byte-identical structure (tags, commands, comments,
//! labels). It is deliberately *encoding-aware at the byte level* so a
//! Shift-JIS trailing byte that happens to equal an ASCII delimiter
//! (`[`=0x5B, `]`=0x5D, `@`=0x40 all fall inside the Shift-JIS trailing-byte
//! range 0x40..=0x7E) is NEVER mistaken for a real tag/command marker.
//! ## The KAG line dialect handled
//! Classification is by the **column-0** byte of a physical line (KAG treats
//! leading whitespace as significant text, and control characters are only
//! control characters in the first column):
//! - `;` → **comment** line — structure, no translatable text.
//! - `*` → **label** line (`*name|caption`) — structure.
//! - `@` → **line command** (`@wait time=1000`, `@ch storage="…"`) —
//!   structure. The command name is recorded on the document for
//!   no-silent-skip visibility; the whole line is preserved byte-identical.
//! - `#` → **name (speaker) line** — the KAG speaker convention. `#display`
//!   sets the on-screen name; `#voice/display` splits a voice-file id from
//!   the display name (only the display portion is translatable text); a
//!   bare `#` clears the current speaker.
//! - anything else → **message/text** line — a run of dialogue text
//!   interspersed with inline `[tag …]` tags. Each maximal run of text
//!   between inline tags becomes a `dialogue` [`KsUnit`]; `[[` is the KAG
//!   escape for a literal `[` and stays inside the text run.
//! ## `[iscript]…[endscript]` TJS blocks
//! KAG allows raw TJS (KiriKiri's scripting language) to be embedded between
//! an `[iscript]` open and an `[endscript]` close — or the `@iscript` /
//! `@endscript` line-command spelling of the same pair. The body is **TJS
//! source, not KAG message text**, so it MUST NOT be emitted as translatable
//! `dialogue` (doing so ships code to the LLM and splices the translation back
//! over real source on patch). This parser recognises both spellings and
//! **swallows** every physical line of the block body: no [`KsUnit`] is
//! emitted for it, so its bytes stay in the immutable structural stream and
//! patchback leaves the code byte-identical. The block open is recorded as a
//! [`KsFindingKind::IScriptBlock`] finding so the construct is visible, never
//! silently dropped. This mirrors the swallow-until-`endscript` behaviour of
//! the sibling `utsushi-kirikiri` replay parser.
//! Every [`KsUnit`] carries a stable extraction identity: source file,
//! physical line index, in-line segment index, text role, an exact
//! `[start_byte, end_byte)` span, and a deterministic `bridge_unit_id`.

use serde::Serialize;

use crate::ids::deterministic_uuid7;

/// Byte-level text encoding of a `.ks` file.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum KsEncoding {
    /// UTF-8 (modern KiriKiriZ scripts, and every authored fixture here).
    Utf8,
    /// Shift-JIS (classic KiriKiri retail scripts).
    ShiftJis,
    /// UTF-16 little-endian, identified by an `FF FE` BOM.
    Utf16Le,
    /// UTF-16 big-endian, identified by an `FE FF` BOM.
    Utf16Be,
}

impl KsEncoding {
    /// Detect encoding from a KAG file's leading BOM, then fall back to valid
    /// UTF-8 or Shift-JIS. Callers with out-of-band knowledge should use
    /// [`crate::parse_ks_with_encoding`] to pin the encoding explicitly.
    #[must_use]
    pub fn detect(bytes: &[u8]) -> Self {
        if bytes.starts_with(&[0xFF, 0xFE]) {
            Self::Utf16Le
        } else if bytes.starts_with(&[0xFE, 0xFF]) {
            Self::Utf16Be
        } else if std::str::from_utf8(bytes).is_ok() {
            Self::Utf8
        } else {
            Self::ShiftJis
        }
    }

    /// Number of leading BOM bytes that belong to the file structure rather
    /// than to the first parsed line.
    fn bom_len(self, bytes: &[u8]) -> usize {
        match self {
            Self::Utf8 if bytes.starts_with(&[0xEF, 0xBB, 0xBF]) => 3,
            Self::Utf16Le if bytes.starts_with(&[0xFF, 0xFE]) => 2,
            Self::Utf16Be if bytes.starts_with(&[0xFE, 0xFF]) => 2,
            _ => 0,
        }
    }

    /// Byte length of the character starting at `bytes[i]`. Always `>= 1`.
    /// This is the single primitive that makes delimiter scanning
    /// encoding-safe: a multi-byte character is skipped whole, so its
    /// trailing byte can never be read as an ASCII `[`/`]`/`@`/… delimiter.
    fn char_len(self, bytes: &[u8], i: usize) -> usize {
        let b = bytes[i];
        let remaining = bytes.len() - i;
        match self {
            Self::Utf8 => {
                let n = if b < 0x80 {
                    1
                } else if b >= 0xF0 {
                    4
                } else if b >= 0xE0 {
                    3
                } else if b >= 0xC0 {
                    2
                } else {
                    // stray continuation byte — treat as a single byte
                    1
                };
                n.min(remaining).max(1)
            }
            Self::ShiftJis => {
                let is_lead = (0x81..=0x9F).contains(&b) || (0xE0..=0xFC).contains(&b);
                if is_lead && remaining >= 2 { 2 } else { 1 }
            }
            Self::Utf16Le | Self::Utf16Be => {
                if remaining >= 2 {
                    2
                } else {
                    1
                }
            }
        }
    }

    /// Return an ASCII byte when the character at `i` is a single-byte ASCII
    /// character in this encoding. UTF-16 controls are recognized only when
    /// their complete two-byte code unit is present, so a zero high/low byte
    /// is never mistaken for a delimiter of its own.
    fn ascii_byte(self, bytes: &[u8], i: usize) -> Option<u8> {
        match self {
            Self::Utf8 | Self::ShiftJis => bytes.get(i).copied().filter(u8::is_ascii),
            Self::Utf16Le => match (bytes.get(i), bytes.get(i + 1)) {
                (Some(&byte), Some(&0)) if byte.is_ascii() => Some(byte),
                _ => None,
            },
            Self::Utf16Be => match (bytes.get(i), bytes.get(i + 1)) {
                (Some(&0), Some(&byte)) if byte.is_ascii() => Some(byte),
                _ => None,
            },
        }
    }

    /// Return the ASCII byte immediately before the character at `i`.
    fn previous_ascii_byte(self, bytes: &[u8], i: usize) -> Option<u8> {
        let previous = self.previous_char_start(i)?;
        self.ascii_byte(bytes, previous)
    }

    fn previous_char_start(self, i: usize) -> Option<usize> {
        match self {
            Self::Utf16Le | Self::Utf16Be => i.checked_sub(2),
            Self::Utf8 | Self::ShiftJis => i.checked_sub(1),
        }
    }
}

/// Decode a byte slice to a `String` under `enc` (lossy on invalid input;
/// authored fixtures are always clean).
pub(crate) fn decode_slice(bytes: &[u8], enc: KsEncoding) -> String {
    let coder = match enc {
        KsEncoding::Utf8 => encoding_rs::UTF_8,
        KsEncoding::ShiftJis => encoding_rs::SHIFT_JIS,
        KsEncoding::Utf16Le => encoding_rs::UTF_16LE,
        KsEncoding::Utf16Be => encoding_rs::UTF_16BE,
    };
    coder.decode(bytes).0.into_owned()
}

/// Role a translatable unit plays in the script.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum TextRole {
    /// A run of on-screen message text.
    Dialogue,
    /// The display-name portion of a KAG `#name` line.
    SpeakerName,
}

impl TextRole {
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Dialogue => "dialogue",
            Self::SpeakerName => "speaker_name",
        }
    }
}

/// One stable, translatable extraction unit.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct KsUnit {
    /// Deterministic UUID7-shaped id (see [`crate::ids`]).
    pub bridge_unit_id: String,
    /// Source `.ks` file name.
    pub source_file: String,
    /// Zero-based physical line index.
    pub line_index: usize,
    /// Zero-based text-run index within the line (`0` for a speaker name).
    pub segment_index: usize,
    /// What the unit is.
    pub role: TextRole,
    /// Inclusive start byte of the translatable span in the source file.
    pub start_byte: usize,
    /// Exclusive end byte of the translatable span in the source file.
    pub end_byte: usize,
    /// Decoded source text (the exact bytes `[start_byte, end_byte)`).
    pub source_text: String,
    /// For a `dialogue` unit, the active speaker display name (from the most
    /// recent `#name` line); `None` after a bare `#` reset. Always `None`
    /// for a `speaker_name` unit (it *is* the name).
    pub speaker: Option<String>,
    /// Stable, human-readable unit key:
    /// `kirikiri-kag:<file>#L<line>#seg<seg>#<role>`.
    pub source_unit_key: String,
}

/// A structural note emitted without silently dropping anything. Carries only
/// structural description (line index + a control token), never retail text.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct KsFinding {
    pub kind: KsFindingKind,
    pub line_index: usize,
    /// Structural detail (e.g. the `@`-command name, or an unclosed tag's
    /// opening name). Never message text.
    pub detail: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum KsFindingKind {
    /// An inline `[tag` with no closing `]` before end-of-line. The remainder
    /// of the line is preserved as structure.
    UnclosedInlineTag,
    /// A recognised `@`-line command (recorded so the command vocabulary is
    /// visible, not silently skipped). The line is preserved byte-identical.
    LineCommand,
    /// An `[iscript]…[endscript]` (or `@iscript…@endscript`) TJS block was
    /// recognised and its body swallowed. Recorded at the block's opening line
    /// so the embedded-TJS construct is visible, not silently dropped. The
    /// body emits no translatable unit and is preserved byte-identical.
    IScriptBlock,
}

/// Parsed KAG `.ks` document.
#[derive(Clone, Debug, Serialize)]
pub struct KsDocument {
    pub source_file: String,
    pub encoding: KsEncoding,
    pub source_len: usize,
    pub units: Vec<KsUnit>,
    pub findings: Vec<KsFinding>,
}

impl KsDocument {
    /// Only the `dialogue`-role units, in document order.
    pub fn dialogue_units(&self) -> impl Iterator<Item = &KsUnit> {
        self.units.iter().filter(|u| u.role == TextRole::Dialogue)
    }

    /// Only the `speaker_name`-role units, in document order.
    pub fn speaker_units(&self) -> impl Iterator<Item = &KsUnit> {
        self.units
            .iter()
            .filter(|u| u.role == TextRole::SpeakerName)
    }
}

fn bridge_namespace(source_file: &str) -> String {
    format!("kirikiri-kag-bridge:source-file={source_file}")
}

struct Parser<'a> {
    source_file: &'a str,
    namespace: String,
    bytes: &'a [u8],
    enc: KsEncoding,
    current_speaker: Option<String>,
    /// While `true`, physical lines are the body of an open
    /// `[iscript]…[endscript]` TJS block and are swallowed (no unit emitted)
    /// until the closing `[endscript]` / `@endscript` line.
    open_iscript: bool,
    units: Vec<KsUnit>,
    findings: Vec<KsFinding>,
}

impl Parser<'_> {
    fn push_unit(
        &mut self,
        line_index: usize,
        segment_index: usize,
        role: TextRole,
        start: usize,
        end: usize,
    ) {
        let source_text = decode_slice(&self.bytes[start..end], self.enc);
        let source_unit_key = format!(
            "kirikiri-kag:{}#L{line_index}#seg{segment_index}#{}",
            self.source_file,
            role.as_str()
        );
        let bridge_unit_id =
            deterministic_uuid7(&self.namespace, &format!("unit-{source_unit_key}"));
        let speaker = match role {
            TextRole::Dialogue => self.current_speaker.clone(),
            TextRole::SpeakerName => None,
        };
        self.units.push(KsUnit {
            bridge_unit_id,
            source_file: self.source_file.to_string(),
            line_index,
            segment_index,
            role,
            start_byte: start,
            end_byte: end,
            source_text,
            speaker,
            source_unit_key,
        });
    }

    /// Parse one physical line whose content bytes are `[ls, le)` (trailing
    /// `\r`/`\n` already excluded).
    fn parse_line(&mut self, ls: usize, le: usize, line_index: usize) {
        // 1. Inside an open `[iscript]` block: swallow every physical line
        // (including blanks) as TJS body — never emit a unit — until the
        // closing `[endscript]` / `@endscript` line, which is swallowed too.
        if self.open_iscript {
            if self.line_closes_iscript(ls, le) {
                self.open_iscript = false;
            }
            return;
        }

        if ls >= le {
            return; // empty line
        }

        // 2. A line that OPENS an `[iscript]` / `@iscript` TJS block. Recorded
        // as a finding; body lines are swallowed by branch 1 above. A
        // single-line `[iscript]…[endscript]` closes on the same line and
        // never opens the swallow state.
        if let Some(closes_same_line) = self.line_opens_iscript(ls, le) {
            self.findings.push(KsFinding {
                kind: KsFindingKind::IScriptBlock,
                line_index,
                detail: "iscript".to_string(),
            });
            if !closes_same_line {
                self.open_iscript = true;
            }
            return;
        }

        match self.enc.ascii_byte(self.bytes, ls) {
            // comment (`;`) and label (`*`) lines are pure structure.
            Some(b';' | b'*') => {}
            Some(b'@') => {
                let name_start = ls + self.enc.char_len(self.bytes, ls);
                let name = self.command_name(name_start, le);
                self.findings.push(KsFinding {
                    kind: KsFindingKind::LineCommand,
                    line_index,
                    detail: name,
                });
            }
            Some(b'#') => self.parse_name_line(ls, le, line_index),
            _ => self.parse_text_line(ls, le, line_index),
        }
    }

    /// Index of the first non-ASCII-whitespace byte in `[ls, le)` (encoding
    /// safe: a multi-byte char is stepped whole, so its trailing byte is never
    /// read as a whitespace control byte).
    fn first_content(&self, ls: usize, le: usize) -> usize {
        let mut i = ls;
        while i < le {
            let cl = self.enc.char_len(self.bytes, i);
            if self
                .enc
                .ascii_byte(self.bytes, i)
                .is_some_and(|byte| byte.is_ascii_whitespace())
            {
                i += cl;
            } else {
                break;
            }
        }
        i
    }

    /// Name of the leading inline `[name …]` tag (after any leading ASCII
    /// whitespace), or `None` when the line does not begin with a real tag
    /// (`[[` is the literal-bracket escape, not a tag). The name is the first
    /// whitespace-delimited token inside the brackets.
    fn leading_tag_name(&self, ls: usize, le: usize) -> Option<String> {
        let start = self.first_content(ls, le);
        if start >= le || self.enc.ascii_byte(self.bytes, start) != Some(b'[') {
            return None;
        }
        // `[[` literal-bracket escape → this is text, not a tag.
        let next = start + self.enc.char_len(self.bytes, start);
        if self.enc.ascii_byte(self.bytes, next) == Some(b'[') {
            return None;
        }
        let inner_start = next;
        let close = self.find_close_bracket(inner_start, le)?;
        let name = self.command_name(inner_start, close);
        if name.is_empty() { None } else { Some(name) }
    }

    /// Name of the leading `@name …` line command (after any leading ASCII
    /// whitespace), or `None` when the line does not begin with `@`.
    fn leading_command_name(&self, ls: usize, le: usize) -> Option<String> {
        let start = self.first_content(ls, le);
        if start >= le || self.enc.ascii_byte(self.bytes, start) != Some(b'@') {
            return None;
        }
        let name_start = start + self.enc.char_len(self.bytes, start);
        let name = self.command_name(name_start, le);
        if name.is_empty() { None } else { Some(name) }
    }

    /// Byte index of the closing `]` for a tag whose inner text starts at
    /// `start`, scanning encoding-safely within `[start, le)`.
    fn find_close_bracket(&self, start: usize, le: usize) -> Option<usize> {
        let mut j = start;
        while j < le {
            let cl = self.enc.char_len(self.bytes, j);
            if self.enc.ascii_byte(self.bytes, j) == Some(b']') {
                return Some(j);
            }
            j += cl;
        }
        None
    }

    /// Whether any inline `[tag …]` in `[ls, le)` names `want` (used to detect
    /// an `[endscript]` close, which may trail body text on the same physical
    /// line). Respects the `[[` literal-bracket escape and steps multi-byte
    /// characters whole.
    fn contains_tag(&self, ls: usize, le: usize, want: &[u8]) -> bool {
        let mut i = ls;
        while i < le {
            let cl = self.enc.char_len(self.bytes, i);
            if self.enc.ascii_byte(self.bytes, i) == Some(b'[') {
                let next = i + cl;
                if self.enc.ascii_byte(self.bytes, next) == Some(b'[') {
                    i = next + self.enc.char_len(self.bytes, next); // `[[` escape
                    continue;
                }
                match self.find_close_bracket(i + cl, le) {
                    Some(close) => {
                        if self.command_name(i + cl, close).as_bytes() == want {
                            return true;
                        }
                        i = close + self.enc.char_len(self.bytes, close);
                    }
                    None => break,
                }
                continue;
            }
            i += cl;
        }
        false
    }

    /// If the line opens an `[iscript]` / `@iscript` TJS block, return
    /// `Some(closes_same_line)`: `true` for a single-line
    /// `[iscript]…[endscript]` (which never opens the swallow state), `false`
    /// for a multi-line block. Returns `None` when the line opens no block.
    fn line_opens_iscript(&self, ls: usize, le: usize) -> Option<bool> {
        let opens = self.leading_tag_name(ls, le).as_deref() == Some("iscript")
            || self.leading_command_name(ls, le).as_deref() == Some("iscript");
        if !opens {
            return None;
        }
        // Only the bracket form can close on the same physical line; the
        // `@iscript` line-command form is closed by a later `@endscript` line.
        Some(self.contains_tag(ls, le, b"endscript"))
    }

    /// Whether a line inside an open block closes it — an `[endscript]` inline
    /// tag anywhere on the line, or a leading `@endscript` line command.
    fn line_closes_iscript(&self, ls: usize, le: usize) -> bool {
        self.contains_tag(ls, le, b"endscript")
            || self.leading_command_name(ls, le).as_deref() == Some("endscript")
    }

    /// `@commandname …` → the command name (ASCII up to whitespace or EOL).
    fn command_name(&self, start: usize, le: usize) -> String {
        let mut i = start;
        while i < le {
            let cl = self.enc.char_len(self.bytes, i);
            if self
                .enc
                .ascii_byte(self.bytes, i)
                .is_some_and(|byte| byte.is_ascii_whitespace())
            {
                break;
            }
            i += cl;
        }
        decode_slice(&self.bytes[start..i], self.enc)
    }

    /// `#display` / `#voice/display` / bare `#`.
    fn parse_name_line(&mut self, ls: usize, le: usize, line_index: usize) {
        let name_start = ls + self.enc.char_len(self.bytes, ls);
        if name_start >= le {
            // bare `#` → clear speaker
            self.current_speaker = None;
            return;
        }
        // Find an ASCII '/' separating voice id from display name.
        let mut slash: Option<usize> = None;
        let mut i = name_start;
        while i < le {
            let cl = self.enc.char_len(self.bytes, i);
            if self.enc.ascii_byte(self.bytes, i) == Some(b'/') {
                slash = Some(i);
                break;
            }
            i += cl;
        }
        let display_start = slash.map_or(name_start, |s| s + self.enc.char_len(self.bytes, s));
        if display_start >= le {
            // `#voice/` with empty display → clear speaker, no unit.
            self.current_speaker = None;
            return;
        }
        let display_text = decode_slice(&self.bytes[display_start..le], self.enc);
        self.current_speaker = Some(display_text);
        self.push_unit(line_index, 0, TextRole::SpeakerName, display_start, le);
    }

    fn parse_text_line(&mut self, ls: usize, le: usize, line_index: usize) {
        let mut segment_index = 0usize;
        let mut run_start = ls;
        let mut i = ls;
        while i < le {
            let cl = self.enc.char_len(self.bytes, i);
            if self.enc.ascii_byte(self.bytes, i) == Some(b'[') {
                // `[[` — KAG literal-bracket escape; stays inside the run.
                let next = i + cl;
                if self.enc.ascii_byte(self.bytes, next) == Some(b'[') {
                    i = next + self.enc.char_len(self.bytes, next);
                    continue;
                }
                self.emit_run(line_index, &mut segment_index, run_start, i);
                // Scan to the closing `]`.
                let mut j = i + cl;
                let mut closed = false;
                while j < le {
                    let cl2 = self.enc.char_len(self.bytes, j);
                    if self.enc.ascii_byte(self.bytes, j) == Some(b']') {
                        j += cl2;
                        closed = true;
                        break;
                    }
                    j += cl2;
                }
                if !closed {
                    self.findings.push(KsFinding {
                        kind: KsFindingKind::UnclosedInlineTag,
                        line_index,
                        detail: self.command_name(i + cl, le),
                    });
                    j = le;
                }
                run_start = j;
                i = j;
                continue;
            }
            i += cl;
        }
        self.emit_run(line_index, &mut segment_index, run_start, le);
    }

    fn emit_run(&mut self, line_index: usize, segment_index: &mut usize, start: usize, end: usize) {
        if end <= start {
            return;
        }
        // Skip whitespace-only runs: they carry no translatable text and are
        // preserved verbatim as structure.
        let decoded = decode_slice(&self.bytes[start..end], self.enc);
        if decoded.trim().is_empty() {
            return;
        }
        let seg = *segment_index;
        self.push_unit(line_index, seg, TextRole::Dialogue, start, end);
        *segment_index += 1;
    }
}

/// Parse `bytes` as a KAG `.ks` script, auto-detecting the encoding.
#[must_use]
pub fn parse_ks(source_file: &str, bytes: &[u8]) -> KsDocument {
    parse_ks_with_encoding(source_file, bytes, KsEncoding::detect(bytes))
}

/// Parse `bytes` as a KAG `.ks` script under an explicit `enc`.
#[must_use]
pub fn parse_ks_with_encoding(source_file: &str, bytes: &[u8], enc: KsEncoding) -> KsDocument {
    let mut parser = Parser {
        source_file,
        namespace: bridge_namespace(source_file),
        bytes,
        enc,
        current_speaker: None,
        open_iscript: false,
        units: Vec::new(),
        findings: Vec::new(),
    };

    let mut ls = enc.bom_len(bytes);
    let mut line_index = 0usize;
    while ls < bytes.len() {
        // Locate the physical line terminator.
        let mut i = ls;
        let mut content_end = bytes.len();
        let mut next = bytes.len();
        while i < bytes.len() {
            let cl = enc.char_len(bytes, i);
            if enc.ascii_byte(bytes, i) == Some(b'\n') {
                let mut ce = i;
                if enc.previous_ascii_byte(bytes, ce) == Some(b'\r') {
                    ce = enc.previous_char_start(ce).expect("CR precedes LF");
                }
                content_end = ce;
                next = i + cl;
                break;
            }
            i += cl;
        }
        if i >= bytes.len() {
            // Final line with no trailing newline.
            content_end = bytes.len();
            if enc.previous_ascii_byte(bytes, content_end) == Some(b'\r') {
                content_end = enc
                    .previous_char_start(content_end)
                    .expect("final CR has a start offset");
            }
            next = bytes.len();
        }
        parser.parse_line(ls, content_end, line_index);
        ls = next;
        line_index += 1;
    }

    KsDocument {
        source_file: source_file.to_string(),
        encoding: enc,
        source_len: bytes.len(),
        units: parser.units,
        findings: parser.findings,
    }
}

/// The bytes of `source` that lie **outside** every translatable unit span —
/// i.e. the immutable structure (tags, `@`-commands, comments, labels,
/// `#`/`/` markers and voice ids, newlines). A byte-preserving patch leaves
/// this stream byte-identical; [`crate::verify_byte_preserving`] compares it
/// between source and patched output.
#[must_use]
pub fn structural_bytes(source: &[u8], doc: &KsDocument) -> Vec<u8> {
    let mut spans: Vec<(usize, usize)> = doc
        .units
        .iter()
        .map(|u| (u.start_byte, u.end_byte))
        .collect();
    spans.sort_unstable();
    let mut out = Vec::with_capacity(source.len());
    let mut cursor = 0usize;
    for (start, end) in spans {
        if start > cursor {
            out.extend_from_slice(&source[cursor..start]);
        }
        cursor = cursor.max(end);
    }
    if cursor < source.len() {
        out.extend_from_slice(&source[cursor..]);
    }
    out
}
