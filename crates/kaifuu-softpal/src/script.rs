//! Softpal `SCRIPT.SRC` (`Sv`-version) dialogue disassembler: scan the
//! **plaintext** bytecode for the two text-bearing command shapes, recover their
//! `TEXT.DAT` pointer fields, and resolve those pointers to decoded lines via the
//! [`crate::TextDat`] codec.
//!
//! `SCRIPT.SRC` is **plaintext** (`Sv20` magic, `Sv<nn>` version-tolerant; not
//! encrypted). Dialogue text is **not** inline — text-bearing commands carry
//! 4-byte little-endian **pointers into the (decrypted) `TEXT.DAT` record pool**,
//! where each pointer is the absolute byte offset of a record's 4-byte index
//! field ([`crate::TextRecord::offset`]).
//!
//! # The two text-bearing command shapes
//!
//! Both are keyed by the 4-byte marker `17 00 01 00` followed by two 16-bit
//! words. Writing the marker at byte offset `m`, `word_lo = bytes[m+4..m+6]`,
//! `word_hi = bytes[m+6..m+8]`:
//!
//! - **TEXT-SHOW (32 bytes)** — `word_hi == 02 00` and `word_lo` is a *text
//!   type* ∈ {`02 00`, `0F 00`, `10 00`, `11 00`, `12 00`, `13 00`, `14 00`}.
//!   The marker sits 24 bytes into the command, so the command spans
//!   `[m-24, m+8)`. Within the command, `bytes[4..8]` is the **text pointer**
//!   and `bytes[12..16]` is the **speaker name pointer** (`0x0FFFFFFF` = no
//!   speaker / narration).
//! - **SELECT / choice (16 bytes)** — `word_lo == 02 00` and `word_hi == 06 00`.
//!   The marker sits 8 bytes into the command, so the command spans `[m-8, m+8)`.
//!   Within the command, `bytes[4..8]` is the immediate. In the v21465 variant
//!   this immediate is a **text pointer** (the choice label); in the newer
//!   v60663 variant the SELECT is a system/branch op whose immediate is the
//!   non-pointer sentinel `0x40000000` (the choice label is decoupled), so it
//!   resolves [`OutOfPool`](PointerResolution::OutOfPool) rather than to a
//!   record. A choice never carries a speaker.
//!
//! The marker `17 00 01 00` alone is *not* a reliable key — it occurs tens of
//! thousands of times as part of unrelated commands; only the marker **plus**
//! the two discriminator words identify a text-bearing command.
//!
//! # Honest scope: TEXT-SHOW + SELECT surfaces only
//!
//! This module scopes the two text-extraction surfaces (dialogue + speaker +
//! choice) and their `TEXT.DAT` pointers. It is **not** the full `Sv20` opcode
//! table / control-flow decompiler (scene dispatch, branches, voice/animation
//! commands) — that is the separate replay node. Bytes that are not one of the
//! two shapes above are deliberately ignored, not decoded.
//!
//! # Byte-locatable for patch-back
//!
//! Every recovered pointer records the **absolute byte offset of its 4-byte
//! field within `SCRIPT.SRC`** ([`TextRef::field_offset`]), so a future
//! patch-back node can repoint it after the `TEXT.DAT` pool is rebuilt.
//!
//! # Determinism / no shell-outs
//!
//! Pure functions of the input `&[u8]` (and a parsed [`crate::TextDat`]). No
//! `Command::new`; the SoftPal-Tool `pal_script_tool.py` is a reference oracle
//! only. Malformed input never panics: every failure is a typed [`ScriptError`].

use std::collections::HashMap;

use serde::{Deserialize, Serialize};
use thiserror::Error;

use crate::TextDat;

/// The 2-byte magic prefix every `SCRIPT.SRC` opens with (`"Sv"`); the two
/// following bytes are the version (`"20"` on the profiled titles), captured but
/// not otherwise constrained (version-tolerant).
pub const SCRIPT_MAGIC_PREFIX: &[u8; 2] = b"Sv";

/// Total length of the fixed `SCRIPT.SRC` header (`"Sv"` + 2 version bytes).
pub const SCRIPT_HEADER_BYTE_LEN: usize = 4;

/// The 4-byte marker that opens every text-bearing command. **Not** sufficient
/// on its own — see the module docs — but a necessary prefix.
pub const SCRIPT_COMMAND_MARKER: &[u8; 4] = &[0x17, 0x00, 0x01, 0x00];

/// The `word_hi` (`bytes[m+6..m+8]`) value that, together with a text-type
/// `word_lo`, identifies a TEXT-SHOW command (`02 00`).
pub const TEXT_SHOW_WORD_HI: u16 = 0x0002;

/// The set of valid `word_lo` (`bytes[m+4..m+6]`) *text type* values for a
/// TEXT-SHOW command: `{02, 0F, 10, 11, 12, 13, 14}` (each as a `?? 00` word).
pub const TEXT_SHOW_TYPE_WORDS: [u16; 7] = [0x0002, 0x000F, 0x0010, 0x0011, 0x0012, 0x0013, 0x0014];

/// The `word_lo` value identifying a SELECT command (`02 00`).
pub const SELECT_WORD_LO: u16 = 0x0002;
/// The `word_hi` value identifying a SELECT command (`06 00`).
pub const SELECT_WORD_HI: u16 = 0x0006;

/// Total byte length of a TEXT-SHOW command.
pub const TEXT_SHOW_COMMAND_BYTE_LEN: usize = 32;
/// Byte offset of the marker **within** a TEXT-SHOW command.
pub const TEXT_SHOW_MARKER_OFFSET: usize = 24;
/// Total byte length of a SELECT command.
pub const SELECT_COMMAND_BYTE_LEN: usize = 16;
/// Byte offset of the marker **within** a SELECT command.
pub const SELECT_MARKER_OFFSET: usize = 8;

/// Offset of the text pointer's 4-byte field within either command shape.
pub const COMMAND_TEXT_PTR_OFFSET: usize = 4;
/// Offset of the speaker name pointer's 4-byte field within a TEXT-SHOW command.
pub const COMMAND_NAME_PTR_OFFSET: usize = 12;

/// Sentinel speaker name pointer meaning "no speaker" (narration). On disk the
/// little-endian bytes are `FF FF FF 0F`.
pub const NO_SPEAKER_POINTER: u32 = 0x0FFF_FFFF;

/// The parsed `SCRIPT.SRC` header: the `"Sv"` magic plus its 2 version bytes.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScriptHeader {
    /// The two version bytes following the `"Sv"` magic (e.g. `b"20"`).
    pub version: [u8; 2],
}

impl ScriptHeader {
    /// The version bytes decoded lossily to a `&str` (e.g. `"20"`).
    #[must_use]
    pub fn version_str(&self) -> std::borrow::Cow<'_, str> {
        String::from_utf8_lossy(&self.version)
    }

    /// Parse the 4-byte header from the front of `bytes`.
    ///
    /// # Errors
    ///
    /// [`ScriptError::TruncatedHeader`] for a short buffer, or
    /// [`ScriptError::BadMagic`] if the first two bytes are not `"Sv"`.
    pub fn parse(bytes: &[u8]) -> Result<Self, ScriptError> {
        if bytes.len() < SCRIPT_HEADER_BYTE_LEN {
            return Err(ScriptError::TruncatedHeader {
                observed_len: bytes.len(),
            });
        }
        let magic = [bytes[0], bytes[1]];
        if &magic != SCRIPT_MAGIC_PREFIX {
            return Err(ScriptError::BadMagic {
                expected: *SCRIPT_MAGIC_PREFIX,
                found: magic,
            });
        }
        Ok(Self {
            version: [bytes[2], bytes[3]],
        })
    }
}

/// One recovered text-bearing command, before pointers are resolved.
///
/// Byte-locatable: every field offset is absolute within `SCRIPT.SRC`, so a
/// patch-back node can repoint the command without re-scanning.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum RawCommand {
    /// A TEXT-SHOW command (dialogue line, optional speaker).
    TextShow {
        /// Absolute byte offset of the 32-byte command's first byte.
        command_offset: usize,
        /// The text pointer value (offset into the decrypted `TEXT.DAT` pool).
        text_pointer: u32,
        /// Absolute byte offset of the text pointer's 4-byte field.
        text_ptr_field_offset: usize,
        /// The speaker name pointer, or `None` if it is [`NO_SPEAKER_POINTER`].
        name_pointer: Option<u32>,
        /// Absolute byte offset of the name pointer's 4-byte field.
        name_ptr_field_offset: usize,
    },
    /// A SELECT command (one choice line, no speaker).
    Select {
        /// Absolute byte offset of the 16-byte command's first byte.
        command_offset: usize,
        /// The text pointer value (offset into the decrypted `TEXT.DAT` pool).
        text_pointer: u32,
        /// Absolute byte offset of the text pointer's 4-byte field.
        text_ptr_field_offset: usize,
    },
}

impl RawCommand {
    /// Absolute byte offset of this command's first byte.
    #[must_use]
    pub fn command_offset(&self) -> usize {
        match *self {
            RawCommand::TextShow { command_offset, .. }
            | RawCommand::Select { command_offset, .. } => command_offset,
        }
    }
}

/// The result of scanning a `SCRIPT.SRC`: its header plus every text-bearing
/// command in **play order** (ascending byte offset). Pure over `SCRIPT.SRC` —
/// no `TEXT.DAT` needed — so it is the stable, byte-locatable surface a
/// patch-back node repoints.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScriptScan {
    /// The parsed `SCRIPT.SRC` header.
    pub header: ScriptHeader,
    /// Every recovered TEXT-SHOW / SELECT command, in play (offset) order.
    pub commands: Vec<RawCommand>,
}

/// Read a little-endian `u16` at `off`. Caller guarantees `off + 2 <= len`.
fn read_u16_le(bytes: &[u8], off: usize) -> u16 {
    u16::from_le_bytes([bytes[off], bytes[off + 1]])
}

/// Read a little-endian `u32` at `off`. Caller guarantees `off + 4 <= len`.
fn read_u32_le(bytes: &[u8], off: usize) -> u32 {
    u32::from_le_bytes([bytes[off], bytes[off + 1], bytes[off + 2], bytes[off + 3]])
}

impl ScriptScan {
    /// Scan a whole `SCRIPT.SRC` buffer for TEXT-SHOW + SELECT commands.
    ///
    /// The scan walks the buffer on 4-byte boundaries (every command is 4-byte
    /// aligned) looking for the `17 00 01 00` marker; each match is
    /// disambiguated by its two following words into a TEXT-SHOW, a SELECT, or
    /// (the common case) neither — non-matching bytes are ignored, not decoded.
    ///
    /// # Errors
    ///
    /// [`ScriptError::TruncatedHeader`] / [`ScriptError::BadMagic`] from the
    /// header parse, or [`ScriptError::TruncatedCommand`] if a marker+word pair
    /// identifies a command shape but the buffer lacks the bytes before the
    /// marker to hold the whole command (a truncated command, never silently
    /// dropped).
    pub fn parse(bytes: &[u8]) -> Result<Self, ScriptError> {
        let header = ScriptHeader::parse(bytes)?;
        let mut commands = Vec::new();

        // Walk 4-byte-aligned marker candidates. `m + 8 <= len` guarantees both
        // the marker dword and the two discriminator words are readable.
        let mut m = 0usize;
        while m + 8 <= bytes.len() {
            if &bytes[m..m + 4] != SCRIPT_COMMAND_MARKER {
                m += 4;
                continue;
            }
            let word_lo = read_u16_le(bytes, m + 4);
            let word_hi = read_u16_le(bytes, m + 6);

            if word_hi == TEXT_SHOW_WORD_HI && TEXT_SHOW_TYPE_WORDS.contains(&word_lo) {
                // TEXT-SHOW: marker sits 24 bytes into a 32-byte command.
                let command_offset = m.checked_sub(TEXT_SHOW_MARKER_OFFSET).ok_or(
                    ScriptError::TruncatedCommand {
                        marker_offset: m,
                        needed_before: TEXT_SHOW_MARKER_OFFSET,
                        kind: "text-show",
                    },
                )?;
                let text_ptr_field_offset = command_offset + COMMAND_TEXT_PTR_OFFSET;
                let name_ptr_field_offset = command_offset + COMMAND_NAME_PTR_OFFSET;
                let text_pointer = read_u32_le(bytes, text_ptr_field_offset);
                let raw_name = read_u32_le(bytes, name_ptr_field_offset);
                let name_pointer = (raw_name != NO_SPEAKER_POINTER).then_some(raw_name);
                commands.push(RawCommand::TextShow {
                    command_offset,
                    text_pointer,
                    text_ptr_field_offset,
                    name_pointer,
                    name_ptr_field_offset,
                });
            } else if word_lo == SELECT_WORD_LO && word_hi == SELECT_WORD_HI {
                // SELECT: marker sits 8 bytes into a 16-byte command.
                let command_offset =
                    m.checked_sub(SELECT_MARKER_OFFSET)
                        .ok_or(ScriptError::TruncatedCommand {
                            marker_offset: m,
                            needed_before: SELECT_MARKER_OFFSET,
                            kind: "select",
                        })?;
                let text_ptr_field_offset = command_offset + COMMAND_TEXT_PTR_OFFSET;
                let text_pointer = read_u32_le(bytes, text_ptr_field_offset);
                commands.push(RawCommand::Select {
                    command_offset,
                    text_pointer,
                    text_ptr_field_offset,
                });
            }
            m += 4;
        }

        Ok(Self { header, commands })
    }

    /// Number of TEXT-SHOW commands recovered.
    #[must_use]
    pub fn text_show_count(&self) -> usize {
        self.commands
            .iter()
            .filter(|c| matches!(c, RawCommand::TextShow { .. }))
            .count()
    }

    /// Number of TEXT-SHOW commands that carry a speaker name pointer.
    #[must_use]
    pub fn text_show_with_speaker_count(&self) -> usize {
        self.commands
            .iter()
            .filter(|c| {
                matches!(
                    c,
                    RawCommand::TextShow {
                        name_pointer: Some(_),
                        ..
                    }
                )
            })
            .count()
    }

    /// Number of SELECT (choice) commands recovered.
    #[must_use]
    pub fn select_count(&self) -> usize {
        self.commands
            .iter()
            .filter(|c| matches!(c, RawCommand::Select { .. }))
            .count()
    }

    /// Resolve every command's pointer(s) against a parsed [`TextDat`], yielding
    /// the dialogue + speaker + choice stream in play order.
    ///
    /// Each pointer is classified against the record pool (see
    /// [`PointerResolution`]): [`Resolved`](PointerResolution::Resolved) when it
    /// equals some record's byte offset ([`crate::TextRecord::offset`], an exact
    /// boundary), [`Dangling`](PointerResolution::Dangling) when it falls *inside*
    /// the pool but misses a boundary (a genuine integrity failure), or
    /// [`OutOfPool`](PointerResolution::OutOfPool) when it cannot be a pool
    /// offset at all — e.g. the v60663 SELECT immediate `0x40000000`, a
    /// system/branch select with no inline text. Never panics; the proof bar is
    /// 0 dangling on real bytes.
    #[must_use]
    pub fn resolve(&self, textdat: &TextDat) -> Disassembly {
        // record offset (as u32) -> decoded text.
        let mut by_offset: HashMap<u32, &str> = HashMap::with_capacity(textdat.records.len());
        for r in &textdat.records {
            if let Ok(off) = u32::try_from(r.offset) {
                by_offset.insert(off, r.text.as_str());
            }
        }
        // The record pool spans [first_offset, pool_end); a pointer at or past
        // `pool_end` (or before the first record) is not a pool reference.
        let pool_start = textdat.records.first().map_or(0u64, |r| r.offset as u64);
        let pool_end = textdat
            .records
            .last()
            .map_or(0u64, |r| (r.text_offset + r.raw_text.len() + 1) as u64);
        let classify = |pointer: u32| -> PointerResolution {
            if let Some(text) = by_offset.get(&pointer) {
                PointerResolution::Resolved((*text).to_owned())
            } else if (pool_start..pool_end).contains(&(pointer as u64)) {
                PointerResolution::Dangling
            } else {
                PointerResolution::OutOfPool
            }
        };
        let make_ref = |pointer: u32, field_offset: usize| TextRef {
            pointer,
            field_offset,
            resolution: classify(pointer),
        };

        let mut dialogue = Vec::new();
        let mut choices = Vec::new();
        for cmd in &self.commands {
            match *cmd {
                RawCommand::TextShow {
                    command_offset,
                    text_pointer,
                    text_ptr_field_offset,
                    name_pointer,
                    name_ptr_field_offset,
                } => {
                    dialogue.push(DialogueUnit {
                        command_offset,
                        text: make_ref(text_pointer, text_ptr_field_offset),
                        speaker: name_pointer.map(|p| make_ref(p, name_ptr_field_offset)),
                    });
                }
                RawCommand::Select {
                    command_offset,
                    text_pointer,
                    text_ptr_field_offset,
                } => {
                    choices.push(ChoiceUnit {
                        command_offset,
                        text: make_ref(text_pointer, text_ptr_field_offset),
                    });
                }
            }
        }
        Disassembly { dialogue, choices }
    }
}

/// How a `TEXT.DAT` pointer landed relative to the record pool.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", tag = "status", content = "text")]
pub enum PointerResolution {
    /// The pointer equals an exact record boundary; carries the decoded line.
    Resolved(String),
    /// The pointer falls *within* the pool byte range but does **not** land on a
    /// record boundary — a genuine dangling pointer (the proof-bar violation).
    Dangling,
    /// The pointer lies outside the record pool entirely, so it is not a
    /// `TEXT.DAT` text reference — e.g. a system/branch SELECT immediate such as
    /// `0x40000000`. Not a failure: the command simply carries no inline text.
    OutOfPool,
}

/// A single `TEXT.DAT` pointer: its value, the absolute byte offset of its
/// 4-byte field within `SCRIPT.SRC` (for patch-back), and how it resolved.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TextRef {
    /// The pointer value: an absolute byte offset into the decrypted `TEXT.DAT`
    /// record pool.
    pub pointer: u32,
    /// Absolute byte offset of this pointer's 4-byte field within `SCRIPT.SRC`.
    pub field_offset: usize,
    /// How the pointer resolved against the record pool.
    pub resolution: PointerResolution,
}

impl TextRef {
    /// The decoded line if this pointer landed on an exact record boundary.
    #[must_use]
    pub fn resolved_text(&self) -> Option<&str> {
        match &self.resolution {
            PointerResolution::Resolved(t) => Some(t.as_str()),
            _ => None,
        }
    }

    /// Whether this pointer landed on an exact `TEXT.DAT` record boundary.
    #[must_use]
    pub fn is_resolved(&self) -> bool {
        matches!(self.resolution, PointerResolution::Resolved(_))
    }

    /// Whether this pointer fell inside the pool but missed a boundary (a
    /// genuine dangling pointer — the integrity failure the proof bar forbids).
    #[must_use]
    pub fn is_dangling(&self) -> bool {
        matches!(self.resolution, PointerResolution::Dangling)
    }

    /// Whether this pointer lies outside the record pool (a non-text reference,
    /// e.g. a system/branch SELECT immediate).
    #[must_use]
    pub fn is_out_of_pool(&self) -> bool {
        matches!(self.resolution, PointerResolution::OutOfPool)
    }
}

/// One dialogue line recovered from a TEXT-SHOW command, in play order.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DialogueUnit {
    /// Absolute byte offset of the 32-byte command in `SCRIPT.SRC`.
    pub command_offset: usize,
    /// The dialogue text pointer + resolution.
    pub text: TextRef,
    /// The speaker name pointer + resolution, or `None` for narration
    /// (name pointer == [`NO_SPEAKER_POINTER`]).
    pub speaker: Option<TextRef>,
}

/// One choice line recovered from a SELECT command, in play order.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChoiceUnit {
    /// Absolute byte offset of the 16-byte command in `SCRIPT.SRC`.
    pub command_offset: usize,
    /// The choice text pointer + resolution.
    pub text: TextRef,
}

/// The resolved dialogue + speaker + choice stream for one `SCRIPT.SRC`, in play
/// order.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Disassembly {
    /// Dialogue lines (TEXT-SHOW), in play order.
    pub dialogue: Vec<DialogueUnit>,
    /// Choice lines (SELECT), in play order.
    pub choices: Vec<ChoiceUnit>,
}

impl Disassembly {
    /// Every pointer in the stream (dialogue text, present speakers, choice
    /// text), for aggregate resolution accounting.
    fn all_refs(&self) -> impl Iterator<Item = &TextRef> {
        self.dialogue
            .iter()
            .flat_map(|d| std::iter::once(&d.text).chain(d.speaker.as_ref()))
            .chain(self.choices.iter().map(|c| &c.text))
    }

    /// Total count of **dangling** pointers across the whole stream — pointers
    /// that fall inside the pool yet miss a record boundary. This is the
    /// integrity bar: it must be **0** (an out-of-pool system-select immediate is
    /// *not* dangling and is not counted).
    #[must_use]
    pub fn dangling_pointer_count(&self) -> usize {
        self.all_refs().filter(|r| r.is_dangling()).count()
    }

    /// Count of dialogue **text** pointers that did not resolve to a record
    /// boundary (dangling *or* out-of-pool). A dialogue line must always carry
    /// resolvable inline text, so on real bytes this is 0.
    #[must_use]
    pub fn unresolved_dialogue_text_count(&self) -> usize {
        self.dialogue
            .iter()
            .filter(|d| !d.text.is_resolved())
            .count()
    }

    /// Count of present speaker **name** pointers that did not resolve (narration
    /// lines carry no name pointer and are not counted). On real bytes this is 0.
    #[must_use]
    pub fn unresolved_speaker_count(&self) -> usize {
        self.dialogue
            .iter()
            .filter_map(|d| d.speaker.as_ref())
            .filter(|s| !s.is_resolved())
            .count()
    }

    /// Count of SELECT commands whose immediate resolves to a record boundary —
    /// i.e. genuine **text-bearing** choices (v21465-style).
    #[must_use]
    pub fn text_bearing_choice_count(&self) -> usize {
        self.choices.iter().filter(|c| c.text.is_resolved()).count()
    }

    /// Count of SELECT commands whose immediate lies outside the pool — non-text
    /// **system / branch** selects (v60663-style `0x40000000`).
    #[must_use]
    pub fn nontext_select_count(&self) -> usize {
        self.choices
            .iter()
            .filter(|c| c.text.is_out_of_pool())
            .count()
    }

    /// The 100 % proof bar: **zero** dangling pointers anywhere, every dialogue
    /// text pointer resolved, and every present speaker name pointer resolved.
    /// (Out-of-pool system-select immediates are permitted and disclosed
    /// separately via [`Self::nontext_select_count`].)
    #[must_use]
    pub fn is_fully_resolved(&self) -> bool {
        self.dangling_pointer_count() == 0
            && self.unresolved_dialogue_text_count() == 0
            && self.unresolved_speaker_count() == 0
    }
}

/// Fatal errors raised while scanning a `SCRIPT.SRC`.
///
/// Every display string begins with the `kaifuu.softpal.script` namespace marker
/// (see [`crate::SOFTPAL_SCRIPT_ERROR_MARKER`]).
#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum ScriptError {
    /// The buffer is shorter than the fixed 4-byte header.
    #[error(
        "kaifuu.softpal.script.truncated_header: length {observed_len} is shorter than the fixed \
         {SCRIPT_HEADER_BYTE_LEN}-byte header"
    )]
    TruncatedHeader { observed_len: usize },
    /// The first two bytes are not the `"Sv"` magic prefix.
    #[error(
        "kaifuu.softpal.script.bad_magic: expected magic prefix {expected:02X?} (\"Sv\") at \
         offset 0, found {found:02X?}"
    )]
    BadMagic { expected: [u8; 2], found: [u8; 2] },
    /// A marker + discriminator-word pair identifies a command shape, but the
    /// buffer lacks the `needed_before` bytes ahead of the marker to hold the
    /// whole command — a truncated command, surfaced rather than dropped.
    #[error(
        "kaifuu.softpal.script.truncated_command: {kind} marker at offset {marker_offset} needs \
         {needed_before} bytes before it to hold the command, but the marker is too close to the \
         start of the buffer"
    )]
    TruncatedCommand {
        marker_offset: usize,
        needed_before: usize,
        kind: &'static str,
    },
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{TEXTDAT_FLAG_PLAINTEXT, TEXTDAT_MAGIC_TAIL};

    /// Build a plaintext `TEXT.DAT` from `(index, cp932 text)` records and return
    /// `(bytes, record_offsets)` so tests can point commands at exact records.
    fn build_textdat(records: &[(u32, &[u8])]) -> (Vec<u8>, Vec<usize>) {
        let mut buf = Vec::new();
        buf.push(TEXTDAT_FLAG_PLAINTEXT);
        buf.extend_from_slice(TEXTDAT_MAGIC_TAIL);
        buf.extend_from_slice(&(records.len() as u32).to_le_bytes());
        let mut offsets = Vec::with_capacity(records.len());
        for (index, text) in records {
            offsets.push(buf.len());
            buf.extend_from_slice(&index.to_le_bytes());
            buf.extend_from_slice(text);
            buf.push(0x00);
        }
        (buf, offsets)
    }

    /// Emit a 32-byte TEXT-SHOW command with the given pointers. The marker sits
    /// at command byte 24; `word_lo`/`word_hi` follow it.
    fn text_show_cmd(text_ptr: u32, name_ptr: u32, word_lo: u16, word_hi: u16) -> Vec<u8> {
        let mut c = vec![0u8; TEXT_SHOW_COMMAND_BYTE_LEN];
        c[COMMAND_TEXT_PTR_OFFSET..COMMAND_TEXT_PTR_OFFSET + 4]
            .copy_from_slice(&text_ptr.to_le_bytes());
        c[COMMAND_NAME_PTR_OFFSET..COMMAND_NAME_PTR_OFFSET + 4]
            .copy_from_slice(&name_ptr.to_le_bytes());
        c[TEXT_SHOW_MARKER_OFFSET..TEXT_SHOW_MARKER_OFFSET + 4]
            .copy_from_slice(SCRIPT_COMMAND_MARKER);
        c[TEXT_SHOW_MARKER_OFFSET + 4..TEXT_SHOW_MARKER_OFFSET + 6]
            .copy_from_slice(&word_lo.to_le_bytes());
        c[TEXT_SHOW_MARKER_OFFSET + 6..TEXT_SHOW_MARKER_OFFSET + 8]
            .copy_from_slice(&word_hi.to_le_bytes());
        c
    }

    /// Emit a 16-byte SELECT command with the given text pointer.
    fn select_cmd(text_ptr: u32) -> Vec<u8> {
        let mut c = vec![0u8; SELECT_COMMAND_BYTE_LEN];
        c[COMMAND_TEXT_PTR_OFFSET..COMMAND_TEXT_PTR_OFFSET + 4]
            .copy_from_slice(&text_ptr.to_le_bytes());
        c[SELECT_MARKER_OFFSET..SELECT_MARKER_OFFSET + 4].copy_from_slice(SCRIPT_COMMAND_MARKER);
        c[SELECT_MARKER_OFFSET + 4..SELECT_MARKER_OFFSET + 6]
            .copy_from_slice(&SELECT_WORD_LO.to_le_bytes());
        c[SELECT_MARKER_OFFSET + 6..SELECT_MARKER_OFFSET + 8]
            .copy_from_slice(&SELECT_WORD_HI.to_le_bytes());
        c
    }

    fn script_with(header_version: &[u8; 2], bodies: &[Vec<u8>]) -> Vec<u8> {
        let mut s = Vec::new();
        s.extend_from_slice(SCRIPT_MAGIC_PREFIX);
        s.extend_from_slice(header_version);
        for b in bodies {
            s.extend_from_slice(b);
        }
        s
    }

    #[test]
    fn header_parses_version_and_rejects_bad_magic() {
        let s = script_with(b"20", &[]);
        assert_eq!(ScriptHeader::parse(&s).unwrap().version, *b"20");
        assert_eq!(ScriptHeader::parse(&s).unwrap().version_str(), "20");

        let bad = b"XX20".to_vec();
        assert!(matches!(
            ScriptHeader::parse(&bad),
            Err(ScriptError::BadMagic { .. })
        ));
        assert!(matches!(
            ScriptHeader::parse(&[0x53]),
            Err(ScriptError::TruncatedHeader { observed_len: 1 })
        ));
    }

    #[test]
    fn scans_text_show_and_select_with_correct_offsets_and_speaker() {
        // Two records so a text pointer and a name pointer both resolve. ASCII
        // text keeps the fixture cp932-clean (the codec decodes Shift-JIS).
        let (textdat_bytes, recs) = build_textdat(&[(0, b"Hello there"), (1, b"Alice")]);
        let text_ptr = recs[0] as u32;
        let name_ptr = recs[1] as u32;

        // Stream: a text-show WITH speaker, a narration text-show (no speaker),
        // then a select — in that play order.
        let c0 = text_show_cmd(text_ptr, name_ptr, 0x0002, TEXT_SHOW_WORD_HI);
        let c1 = text_show_cmd(text_ptr, NO_SPEAKER_POINTER, 0x0010, TEXT_SHOW_WORD_HI);
        let c2 = select_cmd(text_ptr);
        let script = script_with(b"20", &[c0, c1, c2]);

        let scan = ScriptScan::parse(&script).unwrap();
        assert_eq!(scan.text_show_count(), 2);
        assert_eq!(scan.text_show_with_speaker_count(), 1);
        assert_eq!(scan.select_count(), 1);

        // Command offsets follow the 4-byte header, 32B, 32B.
        assert_eq!(scan.commands[0].command_offset(), SCRIPT_HEADER_BYTE_LEN);
        assert_eq!(
            scan.commands[1].command_offset(),
            SCRIPT_HEADER_BYTE_LEN + TEXT_SHOW_COMMAND_BYTE_LEN
        );
        assert_eq!(
            scan.commands[2].command_offset(),
            SCRIPT_HEADER_BYTE_LEN + 2 * TEXT_SHOW_COMMAND_BYTE_LEN
        );

        let textdat = TextDat::parse(&textdat_bytes).unwrap();
        let dis = scan.resolve(&textdat);
        assert_eq!(dis.dialogue.len(), 2);
        assert_eq!(dis.choices.len(), 1);
        assert!(dis.is_fully_resolved());

        // Unit 0: resolved dialogue + resolved speaker, byte-locatable fields.
        let d0 = &dis.dialogue[0];
        assert_eq!(d0.text.pointer, text_ptr);
        assert_eq!(
            d0.text.field_offset,
            SCRIPT_HEADER_BYTE_LEN + COMMAND_TEXT_PTR_OFFSET
        );
        assert_eq!(d0.text.resolved_text(), Some("Hello there"));
        let sp = d0.speaker.as_ref().expect("has speaker");
        assert_eq!(sp.pointer, name_ptr);
        assert_eq!(
            sp.field_offset,
            SCRIPT_HEADER_BYTE_LEN + COMMAND_NAME_PTR_OFFSET
        );
        assert_eq!(sp.resolved_text(), Some("Alice"));

        // Unit 1: narration => 0x0FFFFFFF => speaker None.
        assert!(dis.dialogue[1].speaker.is_none());

        // Choice resolves to the same record text (text-bearing choice).
        assert_eq!(dis.choices[0].text.resolved_text(), Some("Hello there"));
        assert_eq!(dis.text_bearing_choice_count(), 1);
        assert_eq!(dis.nontext_select_count(), 0);
        assert_eq!(dis.dangling_pointer_count(), 0);
    }

    #[test]
    fn text_show_type_word_02_is_not_misread_as_select() {
        // word_lo == 02 with word_hi == 02 is a TEXT-SHOW, not a SELECT (SELECT
        // needs word_hi == 06). Guards the discriminator ordering.
        let (textdat_bytes, recs) = build_textdat(&[(0, b"x")]);
        let c = text_show_cmd(
            recs[0] as u32,
            NO_SPEAKER_POINTER,
            0x0002,
            TEXT_SHOW_WORD_HI,
        );
        let script = script_with(b"20", &[c]);
        let scan = ScriptScan::parse(&script).unwrap();
        assert_eq!(scan.text_show_count(), 1);
        assert_eq!(scan.select_count(), 0);
        let _ = TextDat::parse(&textdat_bytes).unwrap();
    }

    #[test]
    fn dangling_pointer_is_recorded_not_panicked() {
        // A record with a long enough text that pointer+1 is still inside the
        // pool (so name_ptr lands mid-record => Dangling, not OutOfPool).
        let (textdat_bytes, recs) = build_textdat(&[(0, b"a real dialogue line")]);
        let bogus = recs[0] as u32 + 1; // inside the pool, off a boundary
        let c = text_show_cmd(recs[0] as u32, bogus, 0x0002, TEXT_SHOW_WORD_HI);
        let script = script_with(b"20", &[c]);
        let scan = ScriptScan::parse(&script).unwrap();
        let dis = scan.resolve(&TextDat::parse(&textdat_bytes).unwrap());
        assert_eq!(dis.unresolved_dialogue_text_count(), 0);
        assert_eq!(dis.unresolved_speaker_count(), 1);
        assert_eq!(dis.dangling_pointer_count(), 1);
        assert!(!dis.is_fully_resolved());
        // The unit still exists, speaker present but dangling.
        let sp = dis.dialogue[0].speaker.as_ref().unwrap();
        assert_eq!(sp.pointer, bogus);
        assert!(sp.is_dangling());
        assert!(!sp.is_resolved());
    }

    #[test]
    fn out_of_pool_select_immediate_is_not_dangling() {
        // Mirrors v60663: a SELECT whose immediate (0x40000000) lies far past the
        // pool => OutOfPool (a system/branch select), NOT a dangling failure.
        let (textdat_bytes, _recs) = build_textdat(&[(0, b"only record")]);
        let mut c = select_cmd(0); // placeholder, overwrite the immediate below
        c[COMMAND_TEXT_PTR_OFFSET..COMMAND_TEXT_PTR_OFFSET + 4]
            .copy_from_slice(&0x4000_0000u32.to_le_bytes());
        let script = script_with(b"20", &[c]);
        let scan = ScriptScan::parse(&script).unwrap();
        let dis = scan.resolve(&TextDat::parse(&textdat_bytes).unwrap());
        assert_eq!(dis.choices.len(), 1);
        assert!(dis.choices[0].text.is_out_of_pool());
        assert_eq!(dis.nontext_select_count(), 1);
        assert_eq!(dis.text_bearing_choice_count(), 0);
        assert_eq!(dis.dangling_pointer_count(), 0);
        // No dialogue/speaker failures + zero dangling => fully resolved holds.
        assert!(dis.is_fully_resolved());
    }

    #[test]
    fn truncated_command_is_typed_error() {
        // A marker+discriminator for a text-show placed too close to offset 0
        // (only the header before it) => TruncatedCommand, not a silent drop.
        // Header "Sv20" (4 bytes) then a marker at offset 4: 4 < 24 needed.
        let mut s = Vec::new();
        s.extend_from_slice(SCRIPT_MAGIC_PREFIX);
        s.extend_from_slice(b"20");
        s.extend_from_slice(SCRIPT_COMMAND_MARKER); // marker at offset 4
        s.extend_from_slice(&0x0002u16.to_le_bytes()); // word_lo (text type)
        s.extend_from_slice(&TEXT_SHOW_WORD_HI.to_le_bytes()); // word_hi
        let err = ScriptScan::parse(&s).expect_err("truncated text-show command");
        assert!(matches!(
            err,
            ScriptError::TruncatedCommand {
                marker_offset: 4,
                needed_before: 24,
                kind: "text-show"
            }
        ));
        assert!(
            err.to_string()
                .starts_with(crate::SOFTPAL_SCRIPT_ERROR_MARKER)
        );
    }

    #[test]
    fn unrelated_marker_bytes_are_ignored() {
        // A bare marker with non-command discriminator words is not a command.
        let mut s = Vec::new();
        s.extend_from_slice(SCRIPT_MAGIC_PREFIX);
        s.extend_from_slice(b"20");
        // 24 bytes of filler so a marker at offset 28 has room, but give it a
        // discriminator that matches neither shape (word_hi == 07).
        s.extend_from_slice(&[0u8; 24]);
        s.extend_from_slice(SCRIPT_COMMAND_MARKER);
        s.extend_from_slice(&0x0002u16.to_le_bytes());
        s.extend_from_slice(&0x0007u16.to_le_bytes());
        let scan = ScriptScan::parse(&s).unwrap();
        assert_eq!(scan.commands.len(), 0);
    }

    #[test]
    fn empty_and_headerless_inputs_are_typed_errors() {
        assert!(matches!(
            ScriptScan::parse(&[]),
            Err(ScriptError::TruncatedHeader { observed_len: 0 })
        ));
    }
}
