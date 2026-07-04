//! KAG `.ks` plaintext scenario-script parser.
//!
//! KAG (KiriKiri Adventure Game system) is KiriKiri's scenario scripting
//! layer; a `.ks` file is **plaintext** (Shift-JIS or UTF-8). This module
//! parses the KAG line dialect into a stable set of translatable
//! [`KsUnit`]s plus byte-identical structure (tags, commands, comments,
//! labels). It is deliberately *encoding-aware at the byte level* so a
//! Shift-JIS trailing byte that happens to equal an ASCII delimiter
//! (`[`=0x5B, `]`=0x5D, `@`=0x40 all fall inside the Shift-JIS trailing-byte
//! range 0x40..=0x7E) is NEVER mistaken for a real tag/command marker.
//!
//! ## The KAG line dialect handled
//!
//! Classification is by the **column-0** byte of a physical line (KAG treats
//! leading whitespace as significant text, and control characters are only
//! control characters in the first column):
//!
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
//!
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
}

impl KsEncoding {
    /// Detect encoding: valid UTF-8 → [`KsEncoding::Utf8`], else
    /// [`KsEncoding::ShiftJis`]. Callers with out-of-band knowledge should use
    /// [`crate::parse_ks_with_encoding`] to pin the encoding explicitly.
    #[must_use]
    pub fn detect(bytes: &[u8]) -> Self {
        if std::str::from_utf8(bytes).is_ok() {
            Self::Utf8
        } else {
            Self::ShiftJis
        }
    }

    /// Byte length of the character starting at `bytes[i]`. Always `>= 1`.
    ///
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
        }
    }
}

/// Decode a byte slice to a `String` under `enc` (lossy on invalid input;
/// authored fixtures are always clean).
pub(crate) fn decode_slice(bytes: &[u8], enc: KsEncoding) -> String {
    let coder = match enc {
        KsEncoding::Utf8 => encoding_rs::UTF_8,
        KsEncoding::ShiftJis => encoding_rs::SHIFT_JIS,
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
        if ls >= le {
            return; // empty line
        }
        match self.bytes[ls] {
            // comment (`;`) and label (`*`) lines are pure structure.
            b';' | b'*' => {}
            b'@' => {
                let name = self.command_name(ls + 1, le);
                self.findings.push(KsFinding {
                    kind: KsFindingKind::LineCommand,
                    line_index,
                    detail: name,
                });
            }
            b'#' => self.parse_name_line(ls, le, line_index),
            _ => self.parse_text_line(ls, le, line_index),
        }
    }

    /// `@commandname …` → the command name (ASCII up to whitespace or EOL).
    fn command_name(&self, start: usize, le: usize) -> String {
        let mut i = start;
        while i < le {
            let cl = self.enc.char_len(self.bytes, i);
            if cl == 1 && self.bytes[i].is_ascii_whitespace() {
                break;
            }
            i += cl;
        }
        decode_slice(&self.bytes[start..i], self.enc)
    }

    /// `#display` / `#voice/display` / bare `#`.
    fn parse_name_line(&mut self, ls: usize, le: usize, line_index: usize) {
        let name_start = ls + 1;
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
            if cl == 1 && self.bytes[i] == b'/' {
                slash = Some(i);
                break;
            }
            i += cl;
        }
        let display_start = slash.map_or(name_start, |s| s + 1);
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
            if cl == 1 && self.bytes[i] == b'[' {
                // `[[` — KAG literal-bracket escape; stays inside the run.
                if i + 1 < le && self.bytes[i + 1] == b'[' {
                    i += 2;
                    continue;
                }
                self.emit_run(line_index, &mut segment_index, run_start, i);
                // Scan to the closing `]`.
                let mut j = i + cl;
                let mut closed = false;
                while j < le {
                    let cl2 = self.enc.char_len(self.bytes, j);
                    if cl2 == 1 && self.bytes[j] == b']' {
                        j += 1;
                        closed = true;
                        break;
                    }
                    j += cl2;
                }
                if !closed {
                    self.findings.push(KsFinding {
                        kind: KsFindingKind::UnclosedInlineTag,
                        line_index,
                        detail: self.command_name(i + 1, le),
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
        units: Vec::new(),
        findings: Vec::new(),
    };

    let mut ls = 0usize;
    let mut line_index = 0usize;
    while ls < bytes.len() {
        // Locate the physical line terminator.
        let mut i = ls;
        let mut content_end = bytes.len();
        let mut next = bytes.len();
        while i < bytes.len() {
            let cl = enc.char_len(bytes, i);
            if cl == 1 && bytes[i] == b'\n' {
                let mut ce = i;
                if ce > ls && bytes[ce - 1] == b'\r' {
                    ce -= 1;
                }
                content_end = ce;
                next = i + 1;
                break;
            }
            i += cl;
        }
        if i >= bytes.len() {
            // Final line with no trailing newline.
            content_end = bytes.len();
            if content_end > ls && bytes[content_end - 1] == b'\r' {
                content_end -= 1;
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
