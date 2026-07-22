//! TyranoScript `.ks` scenario-script parser (the `tyrano-script-markup`
//! codec stage of the layered pipeline).
//! TyranoScript is a JavaScript-based VN engine whose scenario files (`.ks`,
//! typically under `data/scenario/`) use a **KAG-style square-bracket markup**
//! dialect that is **plaintext** on disk (the layered pipeline's identity
//! container + null-key crypto). This module parses that dialect into a stable
//! set of translatable [`TsUnit`]s plus byte-identical structure (tags,
//! labels, jumps, variables, comments). Like the KiriKiri KAG adapter it is
//! deliberately *encoding-aware at the byte level* so a Shift-JIS trailing
//! byte that happens to equal an ASCII delimiter (`[`=0x5B, `]`=0x5D,
//! `&`=0x26, `#`=0x23, `@`=0x40, all inside the Shift-JIS trailing-byte range
//! 0x40..=0xFC) is NEVER mistaken for a real markup marker.
//! # Which constructs carry translatable text vs structure
//! Classification is by the **column-0** byte of a physical line (leading
//! whitespace is significant text; control markers are only markers in the
//! first column):
//! - `;` → **comment** line — structure, no translatable text.
//! - `*` → **label** line (`*label|caption`) — structure (a jump target).
//! - `@` → **line command** (`@jump target=*foo`) — structure. The command
//!   name is recorded as a finding for no-silent-skip visibility; the whole
//!   line is preserved byte-identical.
//! - `#` → **name (speaker) line** — the KAG/Tyrano speaker convention; the
//!   whole remainder is the on-screen display name (translatable). A bare `#`
//!   clears the current speaker.
//! - anything else → **message/text** line — a run of dialogue text
//!   interspersed with inline `[tag …]` tags, inline `&expr` **variable
//!   embeds**, and `[[` literal-bracket escapes.
//!   Inside a text line:
//! - Each maximal run of message text between inline tags / variable embeds
//!   becomes a `dialogue` [`TsUnit`] (translatable) — unless it falls inside a
//!   `[link] … [endlink]` block, in which case it is a `choice` unit.
//! - `[link …]` / `[endlink]` bracket an inline **choice** (the link caption is
//!   translatable `choice` text; the tags themselves are structure).
//! - `[glink …]` / `[button …]` self-contained choice tags carry their caption
//!   in a quoted `text="…"` attribute → a `choice` unit spanning only the
//!   attribute value (the tag + `target=` etc. stay structure).
//! - `[chara_ptext text="…"]` carries a speaker display name in a quoted
//!   `text="…"` attribute → a `speaker_name` unit (and sets the active
//!   speaker).
//! - `&expr` (e.g. `&f.count`) is an inline **variable embed** — structure,
//!   preserved byte-identical, and it delimits the surrounding text runs.
//! - every other tag (`[l]`, `[p]`, `[r]`, `[jump …]`, `[eval …]`, `[if …]`,
//!   `[endif]`, …) is opaque structure, preserved byte-identical.
//!   Every [`TsUnit`] carries a stable extraction identity: source file,
//!   physical line index, in-line segment index, text role, an exact
//!   `[start_byte, end_byte)` span, and a deterministic `bridge_unit_id`.

use serde::Serialize;

use crate::ids::deterministic_uuid7;

/// Byte-level text encoding of a `.ks` file.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum TsEncoding {
    /// UTF-8 (modern TyranoScript scripts, and every authored fixture here).
    Utf8,
    /// Shift-JIS (some legacy Japanese TyranoScript projects).
    ShiftJis,
}

impl TsEncoding {
    /// Detect encoding: valid UTF-8 → [`TsEncoding::Utf8`], else
    /// [`TsEncoding::ShiftJis`]. Callers with out-of-band knowledge should use
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
    /// This is the single primitive that makes delimiter scanning
    /// encoding-safe: a multi-byte character is skipped whole, so its
    /// trailing byte can never be read as an ASCII delimiter.
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
pub(crate) fn decode_slice(bytes: &[u8], enc: TsEncoding) -> String {
    let coder = match enc {
        TsEncoding::Utf8 => encoding_rs::UTF_8,
        TsEncoding::ShiftJis => encoding_rs::SHIFT_JIS,
    };
    coder.decode(bytes).0.into_owned()
}

/// Role a translatable unit plays in the script.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum TextRole {
    /// A run of on-screen message text.
    Dialogue,
    /// A choice / link caption (`[link]…[endlink]` inline text, or the
    /// `text="…"` attribute of a `[glink]` / `[button]` choice tag).
    Choice,
    /// The display-name portion of a speaker (`#name` line, or a
    /// `[chara_ptext text="…"]` attribute).
    SpeakerName,
}

impl TextRole {
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Dialogue => "dialogue",
            Self::Choice => "choice",
            Self::SpeakerName => "speaker_name",
        }
    }
}

/// One stable, translatable extraction unit.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct TsUnit {
    /// Deterministic UUID7-shaped id (see [`crate::ids`]).
    pub bridge_unit_id: String,
    /// Source `.ks` file name.
    pub source_file: String,
    /// Zero-based physical line index.
    pub line_index: usize,
    /// Zero-based segment index within the line.
    pub segment_index: usize,
    /// What the unit is.
    pub role: TextRole,
    /// Inclusive start byte of the translatable span in the source file.
    pub start_byte: usize,
    /// Exclusive end byte of the translatable span in the source file.
    pub end_byte: usize,
    /// Decoded source text (the exact bytes `[start_byte, end_byte)`).
    pub source_text: String,
    /// For a `dialogue` / `choice` unit, the active speaker display name (from
    /// the most recent `#name` / `[chara_ptext]`); `None` after a bare `#`
    /// reset. Always `None` for a `speaker_name` unit (it *is* the name).
    pub speaker: Option<String>,
    /// Stable, human-readable unit key:
    /// `tyranoscript:<file>#L<line>#seg<seg>#<role>`.
    pub source_unit_key: String,
}

/// A structural note emitted without silently dropping anything. Carries only
/// structural description (line index + a control token), never retail text.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct TsFinding {
    pub kind: TsFindingKind,
    pub line_index: usize,
    /// Structural detail (e.g. the `@`-command name, or an unclosed tag's
    /// opening name). Never message text.
    pub detail: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum TsFindingKind {
    /// An inline `[tag` with no closing `]` before end-of-line. The remainder
    /// of the line is preserved as structure.
    UnclosedInlineTag,
    /// A recognised `@`-line command (recorded so the command vocabulary is
    /// visible, not silently skipped). The line is preserved byte-identical.
    LineCommand,
}

/// Parsed TyranoScript `.ks` document.
#[derive(Clone, Debug, Serialize)]
pub struct TsDocument {
    pub source_file: String,
    pub encoding: TsEncoding,
    pub source_len: usize,
    pub units: Vec<TsUnit>,
    pub findings: Vec<TsFinding>,
}

impl TsDocument {
    /// Only the `dialogue`-role units, in document order.
    pub fn dialogue_units(&self) -> impl Iterator<Item = &TsUnit> {
        self.units.iter().filter(|u| u.role == TextRole::Dialogue)
    }

    /// Only the `choice`-role units, in document order.
    pub fn choice_units(&self) -> impl Iterator<Item = &TsUnit> {
        self.units.iter().filter(|u| u.role == TextRole::Choice)
    }

    /// Only the `speaker_name`-role units, in document order.
    pub fn speaker_units(&self) -> impl Iterator<Item = &TsUnit> {
        self.units
            .iter()
            .filter(|u| u.role == TextRole::SpeakerName)
    }
}

fn bridge_namespace(source_file: &str) -> String {
    format!("tyranoscript-bridge:source-file={source_file}")
}

/// A quote-aware scan of one inline `[tag …]`.
struct TagScan {
    /// One byte past the closing `]` (or end-of-line if unclosed).
    end: usize,
    /// Whether a closing `]` was found.
    closed: bool,
    /// `[start, end)` of the ASCII tag name (immediately after `[`).
    name_start: usize,
    name_end: usize,
    /// `[start, end)` of the attribute body (after the name, up to `]`).
    body_start: usize,
    body_end: usize,
}

struct Parser<'a> {
    source_file: &'a str,
    namespace: String,
    bytes: &'a [u8],
    enc: TsEncoding,
    current_speaker: Option<String>,
    /// True while inside a `[link] … [endlink]` block (text runs are choices).
    in_link: bool,
    units: Vec<TsUnit>,
    findings: Vec<TsFinding>,
}

#[path = "parse_scanner.rs"]
mod scanner;

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
            "tyranoscript:{}#L{line_index}#seg{segment_index}#{}",
            self.source_file,
            role.as_str()
        );
        let bridge_unit_id =
            deterministic_uuid7(&self.namespace, &format!("unit-{source_unit_key}"));
        let speaker = match role {
            TextRole::Dialogue | TextRole::Choice => self.current_speaker.clone(),
            TextRole::SpeakerName => None,
        };
        self.units.push(TsUnit {
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
                let name = self.token_name(ls + 1, le);
                self.findings.push(TsFinding {
                    kind: TsFindingKind::LineCommand,
                    line_index,
                    detail: name,
                });
            }
            b'#' => self.parse_name_line(ls, le, line_index),
            _ => self.parse_text_line(ls, le, line_index),
        }
    }

    /// ASCII identifier starting at `start` (up to whitespace / non-ident /
    /// EOL) — used for `@command` and `[tag` names.
    fn token_name(&self, start: usize, le: usize) -> String {
        let mut i = start;
        while i < le {
            let cl = self.enc.char_len(self.bytes, i);
            if cl != 1 {
                break;
            }
            let b = self.bytes[i];
            if b.is_ascii_alphanumeric() || b == b'_' {
                i += 1;
            } else {
                break;
            }
        }
        decode_slice(&self.bytes[start..i], self.enc)
    }

    /// `#DisplayName` — the whole remainder is the translatable display name;
    /// a bare `#` clears the current speaker. (TyranoScript speaker line.)
    fn parse_name_line(&mut self, ls: usize, le: usize, line_index: usize) {
        let name_start = ls + 1;
        if name_start >= le {
            self.current_speaker = None;
            return;
        }
        let display_text = decode_slice(&self.bytes[name_start..le], self.enc);
        self.current_speaker = Some(display_text);
        self.push_unit(line_index, 0, TextRole::SpeakerName, name_start, le);
    }
}

/// Parse `bytes` as a TyranoScript `.ks` script, auto-detecting the encoding.
#[must_use]
pub fn parse_ks(source_file: &str, bytes: &[u8]) -> TsDocument {
    parse_ks_with_encoding(source_file, bytes, TsEncoding::detect(bytes))
}

/// Parse `bytes` as a TyranoScript `.ks` script under an explicit `enc`.
#[must_use]
pub fn parse_ks_with_encoding(source_file: &str, bytes: &[u8], enc: TsEncoding) -> TsDocument {
    let mut parser = Parser {
        source_file,
        namespace: bridge_namespace(source_file),
        bytes,
        enc,
        current_speaker: None,
        in_link: false,
        units: Vec::new(),
        findings: Vec::new(),
    };

    let mut ls = 0usize;
    let mut line_index = 0usize;
    while ls < bytes.len() {
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

    TsDocument {
        source_file: source_file.to_string(),
        encoding: enc,
        source_len: bytes.len(),
        units: parser.units,
        findings: parser.findings,
    }
}

/// The bytes of `source` that lie **outside** every translatable unit span —
/// i.e. the immutable structure (tags, labels, jumps, variable embeds,
/// comments, `#`/`@` markers, newlines). A byte-preserving patch leaves this
/// stream byte-identical; [`crate::verify_byte_preserving`] compares it
/// between source and patched output.
#[must_use]
pub fn structural_bytes(source: &[u8], doc: &TsDocument) -> Vec<u8> {
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
