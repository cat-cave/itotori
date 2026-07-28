//! Softpal `SCRIPT.SRC` (`Sv`-version) dialogue disassembler: **derive** the two
//! text-bearing command surfaces from the [`crate::opcode`] arity-driven
//! stack-machine walk (the single source of truth), recover their `TEXT.DAT`
//! pointer fields, and resolve those pointers to decoded lines via the
//! [`crate::TextDat`] codec.
//! `SCRIPT.SRC` is **plaintext** (`Sv20` magic, `Sv<nn>` version-tolerant; not
//! encrypted). Dialogue text is **not** inline — text-bearing commands carry
//! 4-byte little-endian **pointers into the (decrypted) `TEXT.DAT` record pool**,
//! where each pointer is the absolute byte offset of a record's 4-byte index
//! field ([`crate::TextRecord::offset`]).
//! # Single source of truth: the opcode-catalog stack walk
//! `SCRIPT.SRC` is a typed **stack machine** (12-byte program header, then 4-byte
//! tokens; see [`crate::opcode`]). Rendering-relevant commands are all the single
//! `Call` opcode `0x17` dispatching on a packed [`CallTarget`](crate::CallTarget)
//! `{ category, function }`. This disassembler runs the **arity-driven walk**
//! ([`crate::OpcodeScan`]) — which steps operator→operands→operator and so can
//! never mistake an operand whose bits *happen* to look like an operator for a
//! command — and reads the two text-bearing surfaces straight off its typed
//! instruction stream:
//! - **TEXT-SHOW** = [`CommandFamily::TextShow`](crate::CommandFamily) — a `Call`
//!   with category `0x0002` and a text-type function ∈ {`0x02`, `0x0F`, `0x10`,
//!   `0x11`, `0x12`, `0x13`, `0x14`}. The engine pushes the text pointer and the
//!   speaker name pointer just before the `Call`: writing the `Call` operator
//!   offset as `m`, the **text pointer** is the typed operand at `m-20` and the
//!   **speaker name pointer** the typed operand at `m-12` (`0x0FFFFFFF` = no
//!   speaker / narration). The command spans `[m-24, m+8)` (32 bytes).
//! - **SELECT / choice** = [`CommandFamily::Select`](crate::CommandFamily) — a
//!   `Call` with category `0x0006`, function `0x0002`. The **immediate** (the
//!   operand the operator immediately before the `Call` pushes) is the typed
//!   operand at `m-4`; the command spans `[m-8, m+8)` (16 bytes). A choice never
//!   carries a speaker.
//!   Because the surfaces are read from `Call` operators the *arity walk* produced
//!   (never from a raw `17 00 01 00` byte scan), an operator-looking operand
//!   immediate — e.g. the raw value `0x0001_0017`, whose little-endian bytes are
//!   exactly `17 00 01 00` — is consumed as an operand and is **never** mis-read as
//!   a phantom command.
//! # Two SELECT-label encodings (both handled)
//! The choice **label** is inferred from the SELECT's typed operands, not from a
//! game/build identity or a fixed slot number:
//! - **direct** — the operand at `m-4` has the plain (`0x0`) tag, so its value is
//!   the `TEXT.DAT` pointer pushed directly by the operator before the `Call`.
//! - **indirect** — that operand has the typed (`0x4`) tag. Within the current
//!   menu block, the parser follows the exact typed destination through preceding
//!   `Move` assignments until it reaches a plain source; that source is the
//!   byte-locatable label pointer. The trace is bounded by the prior SELECT or
//!   TEXT-SHOW, so it cannot borrow a value from another menu block.
//!   A typed chain which does not end in a plain source is not guessed at: it
//!   stays [`OutOfPool`](PointerResolution::OutOfPool) as a genuine system/menu
//!   select. [`ScriptScan`] enriches an indirect SELECT with that candidate
//!   ([`RawCommand::Select::decoupled_label`]) at scan time — pure over
//!   `SCRIPT.SRC` — and [`ScriptScan::resolve`] accepts it only when it lands on
//!   a `TEXT.DAT` record boundary.
//! # Honest scope: TEXT-SHOW + SELECT surfaces only
//! This module scopes the two text-extraction surfaces (dialogue + speaker +
//! choice) and their `TEXT.DAT` pointers. It is **not** the full `Sv20` opcode
//! table / control-flow decompiler (scene dispatch, branches, voice/animation
//! commands) — that is the separate replay node; the full command catalog it
//! *does* build is [`crate::OpcodeScan`]. `Call` targets that are neither
//! TEXT-SHOW nor SELECT are deliberately not surfaced here.
//! # Byte-locatable for patch-back
//! Every recovered pointer records the **absolute byte offset of its 4-byte
//! field within `SCRIPT.SRC`** ([`TextRef::field_offset`]), so a future
//! patch-back node can repoint it after the `TEXT.DAT` pool is rebuilt.
//! # Determinism / no shell-outs
//! Pure functions of the input `&[u8]` (and a parsed [`crate::TextDat`]). No
//! `Command::new`; the SoftPal-Tool `pal_script_tool.py` is a reference oracle
//! only. Malformed input never panics: every failure is a typed [`ScriptError`].

use std::collections::HashMap;

use serde::{Deserialize, Serialize};
use thiserror::Error;

use crate::TextDat;
use crate::opcode::{
    CALL_CATEGORY_SELECT, CALL_CATEGORY_TEXT, CommandFamily, OpcodeScan, OperandTag,
    SELECT_FUNCTION, SvOpcode, TEXT_TYPE_FUNCTIONS,
};

/// The 2-byte magic prefix every `SCRIPT.SRC` opens with (`"Sv"`); the two
/// following bytes are the version (`"20"` on the profiled titles), captured but
/// not otherwise constrained (version-tolerant).
pub const SCRIPT_MAGIC_PREFIX: &[u8; 2] = b"Sv";

/// Total length of the fixed `SCRIPT.SRC` header (`"Sv"` + 2 version bytes).
pub const SCRIPT_HEADER_BYTE_LEN: usize = 4;

/// The 4-byte native `Syscall` (opcode `0x17`) operator token dword — little-endian
/// `17 00 01 00` (opcode id `0x17` low word, operator tag `0x0001` high word).
/// Every TEXT-SHOW / SELECT command is a `Syscall`, so this dword sits at the
/// command's `Syscall` operator offset `m`. It is **not** a scan key: an operand
/// whose bits equal this dword is consumed as an operand by the arity walk, never
/// treated as a command.
pub const SCRIPT_COMMAND_MARKER: &[u8; 4] = &[0x17, 0x00, 0x01, 0x00];

/// The `Call`-target **category** (high word) that dispatches a TEXT-SHOW
/// (`0x0002`). Alias of [`crate::CALL_CATEGORY_TEXT`] — the opcode catalog is the
/// single source of truth for the dispatch discriminators.
pub const TEXT_SHOW_WORD_HI: u16 = CALL_CATEGORY_TEXT;

/// The valid TEXT-SHOW `Call`-target **functions** (low word): the text-type set
/// `{0x02, 0x0F, 0x10, 0x11, 0x12, 0x13, 0x14}`. Alias of
/// [`crate::TEXT_TYPE_FUNCTIONS`].
pub const TEXT_SHOW_TYPE_WORDS: [u16; 7] = TEXT_TYPE_FUNCTIONS;

/// The SELECT `Call`-target **function** (low word, `0x0002`). Alias of
/// [`crate::SELECT_FUNCTION`].
pub const SELECT_WORD_LO: u16 = SELECT_FUNCTION;
/// The SELECT `Call`-target **category** (high word, `0x0006`). Alias of
/// [`crate::CALL_CATEGORY_SELECT`].
pub const SELECT_WORD_HI: u16 = CALL_CATEGORY_SELECT;

/// Total byte length of a TEXT-SHOW command.
pub const TEXT_SHOW_COMMAND_BYTE_LEN: usize = 32;
/// Byte offset of the `Call` operator **within** a TEXT-SHOW command (the command
/// spans `[m - TEXT_SHOW_MARKER_OFFSET, m + 8)` around its `Call` at `m`).
pub const TEXT_SHOW_MARKER_OFFSET: usize = 24;
/// Total byte length of a SELECT command.
pub const SELECT_COMMAND_BYTE_LEN: usize = 16;
/// Byte offset of the `Call` operator **within** a SELECT command (the command
/// spans `[m - SELECT_MARKER_OFFSET, m + 8)` around its `Call` at `m`).
pub const SELECT_MARKER_OFFSET: usize = 8;

/// Offset of the text pointer's 4-byte field within either command shape.
pub const COMMAND_TEXT_PTR_OFFSET: usize = 4;
/// Offset of the speaker name pointer's 4-byte field within a TEXT-SHOW command.
pub const COMMAND_NAME_PTR_OFFSET: usize = 12;

/// Sentinel speaker name pointer meaning "no speaker" (narration). On disk the
/// little-endian bytes are `FF FF FF 0F`.
pub const NO_SPEAKER_POINTER: u32 = 0x0FFF_FFFF;

/// A choice **label** pointer recovered through a typed-assignment chain earlier
/// in the menu block, rather than carried by the SELECT immediate. Byte-locatable
/// for patch-back exactly like a direct label.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DecoupledLabel {
    /// The label's `TEXT.DAT` pointer value.
    pub pointer: u32,
    /// Absolute byte offset of this pointer's 4-byte field within `SCRIPT.SRC`.
    pub field_offset: usize,
}

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
    /// # Errors
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
        /// The SELECT **immediate** — the operand the operator immediately before
        /// the `Call` pushes. A plain immediate is the direct choice-label
        /// `TEXT.DAT` pointer; a typed immediate may resolve through
        /// [`Self::Select::decoupled_label`].
        text_pointer: u32,
        /// Absolute byte offset of the immediate's 4-byte field.
        text_ptr_field_offset: usize,
        /// The indirect choice-label candidate recovered through a typed
        /// assignment chain in the `Sv20` walk, or `None` when the immediate
        /// already carries the label or the typed chain has no plain source.
        decoupled_label: Option<DecoupledLabel>,
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

/// Recover an **indirect** choice-label pointer for each SELECT from a typed
/// [`OpcodeScan`]: `Call` offset → `(label pointer, its 4-byte field offset)`.
/// For a SELECT whose immediate is typed, trace that typed value through the
/// preceding `Move` assignments in its menu block. Every step must be a typed
/// destination; the first plain (`0x0`) source is the candidate `TEXT.DAT`
/// pointer. This is value flow, not a slot-name convention: any typed slot can
/// carry the label, and unrelated typed assignments are ignored unless the
/// SELECT's immediate actually reaches them. A non-plain terminal is left
/// unresolved so [`ScriptScan::resolve`] reports the original immediate as
/// [`OutOfPool`](PointerResolution::OutOfPool).
fn decoupled_select_labels(scan: &OpcodeScan) -> HashMap<usize, (u32, usize)> {
    let ins = &scan.instructions;
    let mut map = HashMap::new();
    for (i, sel) in ins.iter().enumerate() {
        if !matches!(sel.family, CommandFamily::Select) {
            continue;
        }
        let block_start = ins[..i]
            .iter()
            .rposition(|previous| {
                matches!(
                    previous.family,
                    CommandFamily::Select | CommandFamily::TextShow { .. }
                )
            })
            .map_or(0, |boundary| boundary + 1);

        // `m - 4` is the final operand before this SELECT's `Call`. Find it
        // structurally, rather than indexing raw bytes, so it remains tied to the
        // arity-driven walk.
        let Some(immediate) = ins[..i]
            .iter()
            .rev()
            .flat_map(|instruction| instruction.operands().iter().rev())
            .find(|operand| operand.field_offset + 4 == sel.offset)
        else {
            continue;
        };
        if immediate.tag() != OperandTag::TYPED {
            continue;
        }

        let mut source = *immediate;
        let mut search_end = i;
        let mut seen_slots = Vec::new();
        while source.tag() == OperandTag::TYPED {
            if seen_slots.contains(&source.raw) {
                break;
            }
            seen_slots.push(source.raw);
            let Some((assignment_index, assignment_value)) = ins[block_start..search_end]
                .iter()
                .enumerate()
                .rev()
                .find_map(|(relative_index, instruction)| {
                    let [destination, value] = instruction.operands() else {
                        return None;
                    };
                    (instruction.opcode == SvOpcode::Move
                        && destination.tag() == OperandTag::TYPED
                        && destination.raw == source.raw)
                        .then_some((block_start + relative_index, *value))
                })
            else {
                break;
            };
            source = assignment_value;
            // A value read by an assignment must have been written before that
            // assignment; do not let a later write overwrite its provenance.
            search_end = assignment_index;
        }
        if source.tag() == OperandTag::PLAIN {
            map.insert(sel.offset, (source.raw, source.field_offset));
        }
    }
    map
}

mod resolve;
mod scan;
pub use resolve::{ChoiceUnit, DialogueUnit, Disassembly, PointerResolution, TextRef};

/// Fatal errors raised while scanning a `SCRIPT.SRC`.
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
    /// The walk classified a `Call` at `marker_offset` as a text-bearing command,
    /// but the stream lacks the `needed_before` bytes / typed pointer-push operands
    /// ahead of the `Call` to hold the whole command — a truncated command,
    /// surfaced rather than dropped.
    #[error(
        "kaifuu.softpal.script.truncated_command: {kind} Call at offset {marker_offset} needs \
         {needed_before} bytes and its pointer-push operands before it to hold the command, but \
         they are not present in the token stream"
    )]
    TruncatedCommand {
        marker_offset: usize,
        needed_before: usize,
        kind: &'static str,
    },
}

#[cfg(test)]
#[path = "script_tests.rs"]
mod tests;
