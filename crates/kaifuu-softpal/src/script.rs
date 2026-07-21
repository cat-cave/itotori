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

/// The 4-byte `Call` (opcode `0x17`) operator token dword — little-endian
/// `17 00 01 00` (opcode id `0x17` low word, operator tag `0x0001` high word).
/// Every TEXT-SHOW / SELECT command is a `Call`, so this dword sits at the
/// command's `Call` operator offset `m`. It is **not** a scan key: an operand
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

impl ScriptScan {
    /// Derive every TEXT-SHOW + SELECT command from the arity-driven opcode-catalog
    /// walk ([`crate::OpcodeScan`]) — the single source of truth.
    /// The walk types every token operator→operands→operator, so every `Call`
    /// operator it reports is a genuine command (an operand whose bytes resemble a
    /// `Call` operator is consumed as an operand, never mis-read as one). For each
    /// `Call` classified [`CommandFamily::TextShow`] / [`CommandFamily::Select`]
    /// this reads the text / speaker-name / immediate pointers straight off the
    /// walk's typed operands at the command's fixed field offsets (writing the
    /// `Call` operator offset as `m`: text at `m-20`, speaker name at `m-12`,
    /// SELECT immediate at `m-4`), preserving the byte-locatable field offsets a
    /// patch-back repoints. Commands are yielded in play (ascending offset) order.
    /// # Errors
    /// [`ScriptError::TruncatedHeader`] / [`ScriptError::BadMagic`] from the
    /// header parse, or [`ScriptError::TruncatedCommand`] if a `Call` is classified
    /// as a text-bearing command but the buffer/stream lacks the tokens before it
    /// to hold the command's pointer fields (a truncated command, never silently
    /// dropped).
    pub fn parse(bytes: &[u8]) -> Result<Self, ScriptError> {
        let header = ScriptHeader::parse(bytes)?;

        // Single source of truth: the arity-driven stack-machine walk. On a buffer
        // too short/malformed for the 12-byte `Sv20` program header the walk yields
        // nothing, so a valid-magic buffer with no token stream has no commands.
        let Ok(walk) = OpcodeScan::parse(bytes) else {
            return Ok(Self {
                header,
                commands: Vec::new(),
            });
        };

        // Indirect SELECT labels, keyed by the SELECT `Call` operator offset,
        // derived from typed assignment flow in the same walk.
        let decoupled = decoupled_select_labels(&walk);

        // The typed operand values the walk recovered, indexed by their absolute
        // 4-byte field offset. A TEXT-SHOW / SELECT reads its pointer fields from
        // *these* operand positions the arity walk actually produced — so a value
        // whose bytes look like a command is never re-read as one.
        let mut operand_by_offset: HashMap<usize, u32> =
            HashMap::with_capacity(walk.instructions.len());
        for ins in &walk.instructions {
            for op in ins.operands() {
                operand_by_offset.insert(op.field_offset, op.raw);
            }
        }
        // Fetch the typed operand at `field_offset`, or a truncated-command error
        // (the command's pointer push is not in the stream).
        let operand_at = |field_offset: usize,
                          marker_offset: usize,
                          needed_before: usize,
                          kind: &'static str|
         -> Result<u32, ScriptError> {
            operand_by_offset
                .get(&field_offset)
                .copied()
                .ok_or(ScriptError::TruncatedCommand {
                    marker_offset,
                    needed_before,
                    kind,
                })
        };

        let mut commands = Vec::new();
        for ins in &walk.instructions {
            // `m` is the `Call` operator offset (== the old marker offset).
            let m = ins.offset;
            match ins.family {
                CommandFamily::TextShow { .. } => {
                    // The command spans `[m-24, m+8)`; its pointer fields precede
                    // the `Call` (text at m-20, speaker name at m-12).
                    let command_offset = m.checked_sub(TEXT_SHOW_MARKER_OFFSET).ok_or(
                        ScriptError::TruncatedCommand {
                            marker_offset: m,
                            needed_before: TEXT_SHOW_MARKER_OFFSET,
                            kind: "text-show",
                        },
                    )?;
                    let text_ptr_field_offset = command_offset + COMMAND_TEXT_PTR_OFFSET;
                    let name_ptr_field_offset = command_offset + COMMAND_NAME_PTR_OFFSET;
                    let text_pointer = operand_at(
                        text_ptr_field_offset,
                        m,
                        TEXT_SHOW_MARKER_OFFSET,
                        "text-show",
                    )?;
                    let raw_name = operand_at(
                        name_ptr_field_offset,
                        m,
                        TEXT_SHOW_MARKER_OFFSET,
                        "text-show",
                    )?;
                    let name_pointer = (raw_name != NO_SPEAKER_POINTER).then_some(raw_name);
                    commands.push(RawCommand::TextShow {
                        command_offset,
                        text_pointer,
                        text_ptr_field_offset,
                        name_pointer,
                        name_ptr_field_offset,
                    });
                }
                CommandFamily::Select => {
                    // The command spans `[m-8, m+8)`; the immediate is at m-4.
                    let command_offset = m.checked_sub(SELECT_MARKER_OFFSET).ok_or(
                        ScriptError::TruncatedCommand {
                            marker_offset: m,
                            needed_before: SELECT_MARKER_OFFSET,
                            kind: "select",
                        },
                    )?;
                    let text_ptr_field_offset = command_offset + COMMAND_TEXT_PTR_OFFSET;
                    let text_pointer =
                        operand_at(text_ptr_field_offset, m, SELECT_MARKER_OFFSET, "select")?;
                    commands.push(RawCommand::Select {
                        command_offset,
                        text_pointer,
                        text_ptr_field_offset,
                        decoupled_label: decoupled.get(&m).map(|&(pointer, field_offset)| {
                            DecoupledLabel {
                                pointer,
                                field_offset,
                            }
                        }),
                    });
                }
                // Every other `Call` target + all non-`Call` operators are outside
                // this module's two text-bearing surfaces.
                _ => {}
            }
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
    /// Each pointer is classified against the record pool (see
    /// [`PointerResolution`]): [`Resolved`](PointerResolution::Resolved) when it
    /// equals some record's byte offset ([`crate::TextRecord::offset`], an exact
    /// boundary), [`Dangling`](PointerResolution::Dangling) when it falls *inside*
    /// the pool but misses a boundary (a genuine integrity failure), or
    /// [`OutOfPool`](PointerResolution::OutOfPool) when it cannot be a pool
    /// offset at all — e.g. a typed SELECT immediate `0x40000000`, a
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
                    decoupled_label,
                } => {
                    // A direct plain immediate resolves first. If it does not,
                    // try the typed-flow candidate; otherwise retain the immediate
                    // so a genuine system/menu select remains OutOfPool.
                    let immediate = make_ref(text_pointer, text_ptr_field_offset);
                    let text = if immediate.is_resolved() {
                        immediate
                    } else if let Some(dl) = decoupled_label {
                        let decoupled = make_ref(dl.pointer, dl.field_offset);
                        if decoupled.is_resolved() {
                            decoupled
                        } else {
                            immediate
                        }
                    } else {
                        immediate
                    };
                    choices.push(ChoiceUnit {
                        command_offset,
                        text,
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

    /// Count of SELECT commands whose label resolves to a record boundary —
    /// i.e. genuine **text-bearing** choices.
    #[must_use]
    pub fn text_bearing_choice_count(&self) -> usize {
        self.choices.iter().filter(|c| c.text.is_resolved()).count()
    }

    /// Count of SELECT commands whose label lies outside the pool — non-text
    /// **system / branch** selects (for example, typed `0x40000000`).
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
mod tests {
    use super::*;
    use crate::{TEXTDAT_FLAG_PLAINTEXT, TEXTDAT_MAGIC_TAIL};

    // Every fixture is a real `Sv20` program (12-byte program header + 4-byte
    // arity-aligned tokens) so the arity-driven walk the disassembler now consumes
    // types it exactly as the real bytecode. TEXT-SHOW / SELECT are built as the
    // engine's push-then-`Call` idiom, matching the real layout the walk recovers:
    // the text pointer is pushed to `m-20`, the speaker name to `m-12`, and the
    // SELECT immediate to `m-4`, where `m` is the `Call` operator offset.

    /// Read a little-endian `u32` at `off` (test-only helper).
    fn read_u32_le(bytes: &[u8], off: usize) -> u32 {
        u32::from_le_bytes([bytes[off], bytes[off + 1], bytes[off + 2], bytes[off + 3]])
    }

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

    /// One operator token `(id, 0x0001)`.
    fn opc(id: u16) -> [u8; 4] {
        let mut t = [0u8; 4];
        t[0..2].copy_from_slice(&id.to_le_bytes());
        t[2..4].copy_from_slice(&0x0001u16.to_le_bytes());
        t
    }
    /// One raw operand/word token.
    fn word(v: u32) -> [u8; 4] {
        v.to_le_bytes()
    }
    /// A `Call` first-operand (dispatch target) word from `(category, function)`.
    fn call_target(category: u16, function: u16) -> u32 {
        (u32::from(category) << 16) | u32::from(function)
    }

    /// The push-then-`Call` **TEXT-SHOW** idiom: three arity-1 pushes (text ptr,
    /// speaker name ptr, a filler window/message value) then `Call 0x17` to the
    /// text category with the given text-type function. Lands text at `m-20`,
    /// speaker name at `m-12` (`m` = the `Call` operator offset).
    fn text_show_tokens(text_ptr: u32, name_ptr: u32, text_type: u16) -> Vec<[u8; 4]> {
        vec![
            opc(0x1f),
            word(text_ptr),
            opc(0x1f),
            word(name_ptr),
            opc(0x1f),
            word(0x0000_0000),
            opc(0x17),
            word(call_target(TEXT_SHOW_WORD_HI, text_type)),
            word(0x0000_0000),
        ]
    }

    /// The push-then-`Call` **SELECT** idiom: one arity-1 push of the immediate,
    /// then `Call 0x17` to the select target. Lands the immediate at `m-4`.
    fn select_tokens(immediate: u32) -> Vec<[u8; 4]> {
        vec![
            opc(0x1f),
            word(immediate),
            opc(0x17),
            word(call_target(SELECT_WORD_HI, SELECT_WORD_LO)),
            word(0x0000_0000),
        ]
    }

    /// A generic typed `Move` assignment.
    fn move_tokens(destination: u32, source: u32) -> Vec<[u8; 4]> {
        vec![opc(0x01), word(destination), word(source)]
    }

    /// A 12-byte `Sv20` program header (`"Sv20"` + two header dwords) + tokens.
    fn sv_program(tokens: &[[u8; 4]]) -> Vec<u8> {
        let mut s = Vec::new();
        s.extend_from_slice(SCRIPT_MAGIC_PREFIX);
        s.extend_from_slice(b"20");
        s.extend_from_slice(&0u32.to_le_bytes());
        s.extend_from_slice(&0u32.to_le_bytes());
        for t in tokens {
            s.extend_from_slice(t);
        }
        s
    }

    #[test]
    fn header_parses_version_and_rejects_bad_magic() {
        let s = sv_program(&[]);
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
    fn derives_text_show_and_select_with_correct_offsets_and_speaker() {
        // Two records so a text pointer and a name pointer both resolve. ASCII
        // text keeps the fixture cp932-clean (the codec decodes Shift-JIS).
        let (textdat_bytes, recs) = build_textdat(&[(0, b"Hello there"), (1, b"Alice")]);
        let text_ptr = recs[0] as u32;
        let name_ptr = recs[1] as u32;

        // Stream: a text-show WITH speaker, a narration text-show (no speaker),
        // then a select — in that play order.
        let mut tokens = Vec::new();
        tokens.extend(text_show_tokens(text_ptr, name_ptr, 0x0002));
        tokens.extend(text_show_tokens(text_ptr, NO_SPEAKER_POINTER, 0x0010));
        tokens.extend(select_tokens(text_ptr));
        let script = sv_program(&tokens);

        let scan = ScriptScan::parse(&script).unwrap();
        assert_eq!(scan.text_show_count(), 2);
        assert_eq!(scan.text_show_with_speaker_count(), 1);
        assert_eq!(scan.select_count(), 1);

        // Command offset is the `Call` operator offset minus its in-command offset
        // (24 for text-show, 8 for select). A text-show idiom is 9 tokens (36
        // bytes) with its `Call` at token 6 (+24); a select idiom is 5 tokens (20
        // bytes) with its `Call` at token 2 (+8). Tokens begin after the 12-byte
        // program header.
        let base = crate::SV_PROGRAM_HEADER_BYTE_LEN;
        let first_call = base + 24; // TS0 idiom @ base, Call at +24
        assert_eq!(scan.commands[0].command_offset(), first_call - 24);
        let second_call = base + 36 + 24; // TS1 idiom @ base+36
        assert_eq!(scan.commands[1].command_offset(), second_call - 24);
        let third_call = base + 72 + 8; // SELECT idiom @ base+72, Call at +8
        assert_eq!(scan.commands[2].command_offset(), third_call - 8);

        let textdat = TextDat::parse(&textdat_bytes).unwrap();
        let dis = scan.resolve(&textdat);
        assert_eq!(dis.dialogue.len(), 2);
        assert_eq!(dis.choices.len(), 1);
        assert!(dis.is_fully_resolved());

        // Unit 0: resolved dialogue + resolved speaker, byte-locatable fields.
        let d0 = &dis.dialogue[0];
        assert_eq!(d0.text.pointer, text_ptr);
        assert_eq!(d0.text.field_offset, first_call - 20);
        assert_eq!(read_u32_le(&script, d0.text.field_offset), text_ptr);
        assert_eq!(d0.text.resolved_text(), Some("Hello there"));
        let sp = d0.speaker.as_ref().expect("has speaker");
        assert_eq!(sp.pointer, name_ptr);
        assert_eq!(sp.field_offset, first_call - 12);
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
    fn text_show_type_function_02_is_not_misread_as_select() {
        // A text-show with function 0x0002 dispatches to the TEXT category
        // (0x0002), NOT the SELECT category (0x0006). Guards the discriminator.
        let (textdat_bytes, recs) = build_textdat(&[(0, b"x")]);
        let tokens = text_show_tokens(recs[0] as u32, NO_SPEAKER_POINTER, 0x0002);
        let script = sv_program(&tokens);
        let scan = ScriptScan::parse(&script).unwrap();
        assert_eq!(scan.text_show_count(), 1);
        assert_eq!(scan.select_count(), 0);
        let _ = TextDat::parse(&textdat_bytes).unwrap();
    }

    #[test]
    fn operator_looking_operand_is_not_misread_as_command() {
        // THE consolidation guarantee: an operand whose little-endian bytes are
        // exactly the `Call` operator dword `17 00 01 00` (raw value 0x0001_0017),
        // immediately followed by an operand whose bytes are `02 00 02 00` (a
        // TEXT-SHOW discriminator), is consumed by the arity walk as two operands
        // of a binary Expr op — NOT re-read as a phantom TEXT-SHOW `Call`. The old
        // `17 00 01 00` marker scan WOULD have emitted a phantom command here.
        let (textdat_bytes, recs) = build_textdat(&[(0, b"real choice")]);

        // Some nullary filler so the trap operands are deep enough that the old
        // marker scan would compute a valid (non-underflowing) command offset.
        let mut tokens = vec![opc(0x18), opc(0x18), opc(0x18)];
        // A binary op whose two operands are the operator-looking trap bytes.
        tokens.push(opc(0x01));
        tokens.push(word(0x0001_0017)); // bytes: 17 00 01 00 (the Call dword)
        tokens.push(word(call_target(TEXT_SHOW_WORD_HI, 0x0002))); // bytes: 02 00 02 00
        // One genuine SELECT so there is a real command to count against.
        tokens.extend(select_tokens(recs[0] as u32));
        let script = sv_program(&tokens);

        // The trap operand really carries the Call dword bytes (offset 28: after
        // the 12-byte header, 3 nullary operators and 1 binary operator token).
        let trap_field = crate::SV_PROGRAM_HEADER_BYTE_LEN + 4 * 4;
        assert_eq!(&script[trap_field..trap_field + 4], SCRIPT_COMMAND_MARKER);

        let scan = ScriptScan::parse(&script).unwrap();
        // No phantom TEXT-SHOW from the trap operand; exactly the genuine SELECT.
        assert_eq!(
            scan.text_show_count(),
            0,
            "trap operand not a phantom command"
        );
        assert_eq!(scan.select_count(), 1);

        let dis = scan.resolve(&TextDat::parse(&textdat_bytes).unwrap());
        assert_eq!(dis.dialogue.len(), 0);
        assert_eq!(dis.choices[0].text.resolved_text(), Some("real choice"));
        assert!(dis.is_fully_resolved());
    }

    #[test]
    fn dangling_pointer_is_recorded_not_panicked() {
        // A record with a long enough text that pointer+1 is still inside the
        // pool (so name_ptr lands mid-record => Dangling, not OutOfPool).
        let (textdat_bytes, recs) = build_textdat(&[(0, b"a real dialogue line")]);
        let bogus = recs[0] as u32 + 1; // inside the pool, off a boundary
        let tokens = text_show_tokens(recs[0] as u32, bogus, 0x0002);
        let script = sv_program(&tokens);
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
        // A SELECT whose typed immediate lies far past the pool is a system/branch
        // select: OutOfPool, not a dangling failure.
        let (textdat_bytes, _recs) = build_textdat(&[(0, b"only record")]);
        let tokens = select_tokens(0x4000_0000);
        let script = sv_program(&tokens);
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
        // A `Call` classified TEXT-SHOW at the very first token offset (12): its
        // text pointer field would sit at 12-20 (underflow) — the pushes that
        // carry it are not in the stream => TruncatedCommand, not a silent drop.
        let tokens = [
            opc(0x17),
            word(call_target(TEXT_SHOW_WORD_HI, 0x0002)),
            word(0x0000_0000),
        ];
        let s = sv_program(&tokens);
        let err = ScriptScan::parse(&s).expect_err("truncated text-show command");
        assert!(matches!(
            err,
            ScriptError::TruncatedCommand {
                marker_offset: 12,
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
    fn non_text_call_targets_are_ignored() {
        // A `Call` to an unrelated engine built-in (graphics category 0x0011) is
        // neither TEXT-SHOW nor SELECT — it produces no command in this module.
        let tokens = [
            opc(0x1f),
            word(0x0000_0001),
            opc(0x17),
            word(call_target(0x0011, 0x0008)),
            word(0x0000_0005),
        ];
        let s = sv_program(&tokens);
        let scan = ScriptScan::parse(&s).unwrap();
        assert_eq!(scan.commands.len(), 0);
    }

    #[test]
    fn empty_and_headerless_inputs_are_typed_errors() {
        assert!(matches!(
            ScriptScan::parse(&[]),
            Err(ScriptError::TruncatedHeader { observed_len: 0 })
        ));
        // A valid 4-byte header but no `Sv20` token stream => no commands (the walk
        // needs the 12-byte program header before it yields anything).
        let scan = ScriptScan::parse(b"Sv20").unwrap();
        assert_eq!(scan.commands.len(), 0);
        assert_eq!(scan.header.version, *b"20");
    }

    #[test]
    fn genuine_system_select_without_label_stays_out_of_pool() {
        // A SELECT with a typed immediate and no assignment chain is a system/menu
        // select that must remain OutOfPool (never force-resolved).
        let (td_bytes, _recs) = build_textdat(&[(0, b"only record")]);
        let mut tokens = vec![opc(0x18)]; // nullary control filler (no operands)
        tokens.extend(select_tokens(0x4000_0000));
        let s = sv_program(&tokens);
        let scan = ScriptScan::parse(&s).unwrap();
        assert_eq!(scan.select_count(), 1);
        match &scan.commands[0] {
            RawCommand::Select {
                decoupled_label, ..
            } => assert!(decoupled_label.is_none(), "no typed label flow"),
            other @ RawCommand::TextShow { .. } => panic!("expected Select, got {other:?}"),
        }
        let dis = scan.resolve(&TextDat::parse(&td_bytes).unwrap());
        assert!(dis.choices[0].text.is_out_of_pool());
        assert_eq!(dis.text_bearing_choice_count(), 0);
        assert_eq!(dis.nontext_select_count(), 1);
        assert_eq!(dis.dangling_pointer_count(), 0);
    }

    #[test]
    fn decoupled_scan_is_bounded_by_intervening_text_show() {
        // A full indirect chain, then a TEXT-SHOW, then its SELECT: the backwards
        // dataflow must stop at the TEXT-SHOW boundary, so it cannot borrow the
        // far label.
        let (td_bytes, recs) = build_textdat(&[(0, b"FarLabel"), (1, b"a line")]);
        let far_label = recs[0] as u32;
        let mut tokens = Vec::new();
        let label_slot = 0x4000_000a;
        let select_slot = 0x4000_000c;
        tokens.extend(move_tokens(label_slot, far_label));
        tokens.extend(move_tokens(select_slot, label_slot));
        tokens.extend(text_show_tokens(recs[1] as u32, NO_SPEAKER_POINTER, 0x0002));
        tokens.extend(select_tokens(select_slot));
        let s = sv_program(&tokens);
        let scan = ScriptScan::parse(&s).unwrap();
        let sel = scan
            .commands
            .iter()
            .find(|c| matches!(c, RawCommand::Select { .. }))
            .expect("a select");
        match sel {
            RawCommand::Select {
                decoupled_label, ..
            } => assert!(
                decoupled_label.is_none(),
                "label beyond the text-show boundary must not be followed"
            ),
            RawCommand::TextShow { .. } => unreachable!(),
        }
        // And it stays OutOfPool on resolve.
        let dis = scan.resolve(&TextDat::parse(&td_bytes).unwrap());
        let choice = dis.choices.first().expect("a choice");
        assert!(choice.text.is_out_of_pool());
    }

    #[test]
    fn direct_immediate_label_wins_when_an_indirect_chain_is_present() {
        // Guards both encodings coexisting: a resolving immediate always wins over
        // an indirect chain in the same menu block.
        let (td_bytes, recs) = build_textdat(&[(0, b"ImmChoice"), (1, b"SlotChoice")]);
        let immediate = recs[0] as u32;
        let slot_label = recs[1] as u32;
        let mut tokens = Vec::new();
        // An indirect chain would resolve, but so does the direct immediate.
        tokens.extend(move_tokens(0x4000_000a, slot_label));
        tokens.extend(move_tokens(0x4000_000c, 0x4000_000a));
        tokens.extend(select_tokens(immediate));
        let s = sv_program(&tokens);
        let scan = ScriptScan::parse(&s).unwrap();
        let dis = scan.resolve(&TextDat::parse(&td_bytes).unwrap());
        assert_eq!(dis.choices.len(), 1);
        // The immediate label wins.
        assert_eq!(dis.choices[0].text.resolved_text(), Some("ImmChoice"));
        assert_eq!(dis.text_bearing_choice_count(), 1);
    }
}
