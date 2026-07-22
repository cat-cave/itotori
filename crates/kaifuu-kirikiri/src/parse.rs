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

#[path = "parse_parser.rs"]
mod parser;

pub use parser::{parse_ks, parse_ks_with_encoding};

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
