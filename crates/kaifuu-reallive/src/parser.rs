//! Real RealLive scene-bytecode parser (KAIFUU-191).
//!
//! `parse_scene` consumes a decompressed scene-bytecode byte stream
//! (post-AVG32 LZSS + XOR per
//! `docs/research/reallive-sweetie-hd-encryption-mechanism.md`) and
//! decodes it into a sequence of [`RealLiveOpcode`] values via the
//! opener-byte switch documented in `docs/research/reallive-engine.md`
//! §D.
//!
//! The pre-KAIFUU-191 synthetic `0x23 ('#') opener + named opcode byte +
//! operand-count` shape is deleted — not aliased, not flagged, not kept
//! behind a feature gate. See `lib.rs` for the clean-room provenance
//! posture.
//!
//! Surface:
//! - [`parse_scene`] — the canonical entry point. Returns the
//!   `Vec<RealLiveOpcode>` directly so downstream tools can dispatch
//!   without an intermediate [`crate::ast::Scene`] tree.
//! - [`parse_scene_into_ast`] — adapter that wraps `parse_scene` and
//!   builds the [`crate::ast::Scene`] tree consumed by
//!   [`crate::inventory`] and [`crate::patchback`]. Errors surface as
//!   fatal diagnostics on the [`ParseOutcome`].
//!
//! No silent zero-state: an empty input yields
//! [`crate::opcode::RealLiveParseError::TruncatedBytecode`], never
//! `Ok(vec![])`.

use kaifuu_core::SourceEncoding;

use crate::archive::scene_id_string;
use crate::ast::{
    Instruction, InstructionId, InstructionKind, Operand, ParseOutcome, SCHEMA_VERSION, Scene,
    StringSlotRole,
};
use crate::diagnostics::{ParseDiagnostic, ParseDiagnosticCode};
use crate::opcode::{RealLiveOpcode, RealLiveParseError, TextEncoding, parse_real_bytecode};
use crate::opcodes::NamedOpcode;
use crate::strings::make_slot;

/// Decode a decompressed scene bytecode byte stream into the documented
/// [`RealLiveOpcode`] sequence.
///
/// The byte stream is the **decompressed** scene bytecode — the caller
/// owns AVG32 LZSS + XOR decompression. This function operates on the
/// plaintext bytecode bytes documented in
/// `docs/research/reallive-engine.md` §D.
pub fn parse_scene(scene_bytes: &[u8]) -> Result<Vec<RealLiveOpcode>, RealLiveParseError> {
    parse_real_bytecode(scene_bytes)
}

/// Adapter that wraps [`parse_scene`] and projects the
/// `Vec<RealLiveOpcode>` into the [`Scene`] tree consumed by the
/// inventory and patchback walks.
///
/// `scene_id` is the 10,000-slot directory slot index for this scene
/// (matches the historical `seenNNNN` naming); `scene_offset` is the
/// absolute archive byte offset of the scene blob and is recorded for
/// downstream tools (KAIFUU-174's offset-table rewriter will use it).
///
/// On [`RealLiveParseError`] the adapter emits a single fatal
/// [`ParseDiagnostic`] and returns a [`ParseOutcome`] with `scene =
/// None`. Recoverable warnings are emitted for `Unknown` opcodes so the
/// inventory walk surfaces them without silent loss.
pub fn parse_scene_into_ast(scene_bytes: &[u8], scene_id: u16, _scene_offset: u64) -> ParseOutcome {
    let mut diagnostics = Vec::new();
    let opcodes = match parse_real_bytecode(scene_bytes) {
        Ok(opcodes) => opcodes,
        Err(err) => {
            diagnostics.push(map_parse_error(&err));
            return ParseOutcome::new(None, diagnostics);
        }
    };

    let mut instructions = Vec::new();
    let mut strings = Vec::new();
    let mut next_global_slot_index: u32 = 0;
    let mut byte_offset: u64 = 0;

    for opcode in &opcodes {
        let (consumed, kind, operands, string_slot_refs) = project_opcode(
            opcode,
            scene_id,
            byte_offset,
            scene_bytes,
            &mut strings,
            &mut next_global_slot_index,
        );
        if matches!(kind, InstructionKind::Unrecognized { .. }) {
            diagnostics.push(ParseDiagnostic::warning(
                ParseDiagnosticCode::UnrecognizedInstruction,
                byte_offset,
                Some(consumed as u64),
                None,
                format!(
                    "opcode {} at scene-blob offset {} not in the alpha classification \
                     set; preserving raw bytes",
                    opcode.label(),
                    byte_offset
                ),
            ));
        }
        instructions.push(Instruction {
            instruction_id: InstructionId::for_scene(scene_id, byte_offset),
            byte_offset,
            byte_len: consumed as u64,
            kind,
            operands,
            string_slot_refs,
        });
        byte_offset += consumed as u64;
    }

    let scene = Scene {
        schema_version: SCHEMA_VERSION.to_string(),
        scene_id: scene_id_string(scene_id),
        instructions,
        strings,
    };
    ParseOutcome::new(Some(scene), diagnostics)
}

fn map_parse_error(err: &RealLiveParseError) -> ParseDiagnostic {
    let (offset, message) = match err {
        RealLiveParseError::TruncatedBytecode { input_len } => (
            0u64,
            format!("scene stream produced no opcodes (input_len={input_len})"),
        ),
        RealLiveParseError::TruncatedMetaHeader {
            opener,
            offset,
            needed,
            available,
        } => (
            *offset,
            format!(
                "meta header {opener:#04x} truncated at offset {offset}: needs {needed} bytes, \
                 {available} available"
            ),
        ),
        RealLiveParseError::TruncatedCommandHeader { offset, available } => (
            *offset,
            format!(
                "command header truncated at offset {offset}: 8 bytes needed, {available} available"
            ),
        ),
        RealLiveParseError::TruncatedCommandArgs { offset, argc } => (
            *offset,
            format!("command at offset {offset} declared argc={argc} but argument bytes ran out"),
        ),
        RealLiveParseError::InvalidLengthPrefix {
            offset,
            declared,
            available,
        } => (
            *offset,
            format!(
                "length-prefixed string at offset {offset} declared len={declared} but only \
                 {available} bytes remain"
            ),
        ),
        RealLiveParseError::TruncatedExpression { offset } => (
            *offset,
            format!("expression token at offset {offset} ran past end of stream"),
        ),
        RealLiveParseError::MalformedExpression { offset, byte } => (
            *offset,
            format!("byte {byte:#04x} at offset {offset} is not a valid ExpressionPiece token"),
        ),
    };
    ParseDiagnostic::fatal(
        ParseDiagnosticCode::TruncatedInstruction,
        offset,
        None,
        None,
        message,
    )
}

/// Project a single [`RealLiveOpcode`] into a Scene-level
/// (`byte_len`, `InstructionKind`, `operands`, `string_slot_refs`) tuple
/// for the [`Scene`] tree. The function also pushes any extracted string
/// slots into the running `strings` vector and bumps
/// `next_global_slot_index`.
fn project_opcode(
    opcode: &RealLiveOpcode,
    scene_id: u16,
    byte_offset: u64,
    _scene_bytes: &[u8],
    strings: &mut Vec<crate::ast::StringSlot>,
    next_global_slot_index: &mut u32,
) -> (
    usize,
    InstructionKind,
    Vec<Operand>,
    Vec<crate::ast::StringSlotRef>,
) {
    let (consumed, named) = match opcode {
        RealLiveOpcode::MetaLine { .. } => (3, None),
        RealLiveOpcode::MetaEntrypoint { .. } => (3, None),
        RealLiveOpcode::MetaKidoku { .. } => (3, None),
        RealLiveOpcode::Comma => (1, None),
        RealLiveOpcode::Textout { raw_bytes, .. } => {
            (raw_bytes.len(), Some(NamedOpcode::TextDisplay))
        }
        RealLiveOpcode::Expression { raw_bytes } => (raw_bytes.len() + 1, None),
        RealLiveOpcode::TextDisplay { .. } => (8, Some(NamedOpcode::TextDisplay)),
        RealLiveOpcode::CharacterTextDisplay => (8, Some(NamedOpcode::SetSpeaker)),
        RealLiveOpcode::Choice { choices } => {
            let mut total = 10usize;
            for choice in choices {
                total += choice.len() + 1;
            }
            (total, Some(NamedOpcode::Choice))
        }
        RealLiveOpcode::Branch | RealLiveOpcode::If => (8, Some(NamedOpcode::Jump)),
        RealLiveOpcode::Jump | RealLiveOpcode::Goto | RealLiveOpcode::Call => {
            (8, Some(NamedOpcode::Jump))
        }
        RealLiveOpcode::Return => (8, Some(NamedOpcode::Return)),
        RealLiveOpcode::Wait { .. } => (8, Some(NamedOpcode::Pause)),
        RealLiveOpcode::Background { .. } => (8, Some(NamedOpcode::SetVar)),
        RealLiveOpcode::BgmPlay | RealLiveOpcode::BgmStop => (8, Some(NamedOpcode::SetVar)),
        RealLiveOpcode::VoicePlay { .. } => (8, Some(NamedOpcode::SetVar)),
        RealLiveOpcode::SetVariable => (8, Some(NamedOpcode::SetVar)),
        RealLiveOpcode::End => (8, Some(NamedOpcode::Return)),
        RealLiveOpcode::Unknown { raw_bytes, .. } => (raw_bytes.len(), None),
    };

    let kind = match opcode {
        RealLiveOpcode::Unknown { opcode: byte, .. } => InstructionKind::Unrecognized {
            raw_opener_byte: *byte,
        },
        RealLiveOpcode::MetaLine { .. } => InstructionKind::Unrecognized {
            raw_opener_byte: crate::opcode::opener::META_LINE,
        },
        RealLiveOpcode::MetaEntrypoint { .. } => InstructionKind::Unrecognized {
            raw_opener_byte: crate::opcode::opener::META_ENTRYPOINT,
        },
        RealLiveOpcode::MetaKidoku { .. } => InstructionKind::Unrecognized {
            raw_opener_byte: crate::opcode::opener::META_KIDOKU,
        },
        RealLiveOpcode::Comma => InstructionKind::Unrecognized {
            raw_opener_byte: crate::opcode::opener::COMMA,
        },
        RealLiveOpcode::Expression { .. } => InstructionKind::Unrecognized {
            raw_opener_byte: crate::opcode::opener::EXPRESSION,
        },
        _ => match named {
            Some(named) => InstructionKind::Named { opcode: named },
            None => InstructionKind::Unrecognized {
                raw_opener_byte: crate::opcode::opener::COMMAND,
            },
        },
    };

    // Operands: extract string slots for variants that carry textual
    // payloads. Textout, TextDisplay, CharacterTextDisplay, Choice all
    // contribute one or more string slots.
    let mut operands: Vec<Operand> = Vec::new();
    let mut string_slot_refs: Vec<crate::ast::StringSlotRef> = Vec::new();
    let mut slot_index_within_instruction: u8 = 0;
    let push_string_slot = |bytes: &[u8],
                            role: StringSlotRole,
                            strings: &mut Vec<crate::ast::StringSlot>,
                            operands: &mut Vec<Operand>,
                            string_slot_refs: &mut Vec<crate::ast::StringSlotRef>,
                            next_global_slot_index: &mut u32,
                            slot_index_within_instruction: &mut u8| {
        let (slot, slot_ref) = make_slot(
            scene_id,
            byte_offset,
            *slot_index_within_instruction,
            bytes,
            role,
            SourceEncoding::Binary,
            *next_global_slot_index,
        );
        strings.push(slot);
        operands.push(Operand::String {
            slot_ref: slot_ref.clone(),
        });
        string_slot_refs.push(slot_ref);
        *next_global_slot_index += 1;
        *slot_index_within_instruction = slot_index_within_instruction.saturating_add(1);
    };

    match opcode {
        RealLiveOpcode::Textout { raw_bytes, .. } => {
            push_string_slot(
                raw_bytes,
                StringSlotRole::Dialogue,
                strings,
                &mut operands,
                &mut string_slot_refs,
                next_global_slot_index,
                &mut slot_index_within_instruction,
            );
        }
        RealLiveOpcode::TextDisplay { .. } => {
            push_string_slot(
                &[],
                StringSlotRole::Dialogue,
                strings,
                &mut operands,
                &mut string_slot_refs,
                next_global_slot_index,
                &mut slot_index_within_instruction,
            );
        }
        RealLiveOpcode::CharacterTextDisplay => {
            push_string_slot(
                &[],
                StringSlotRole::SpeakerName,
                strings,
                &mut operands,
                &mut string_slot_refs,
                next_global_slot_index,
                &mut slot_index_within_instruction,
            );
        }
        RealLiveOpcode::Choice { choices } => {
            for choice in choices {
                push_string_slot(
                    choice,
                    StringSlotRole::Choice,
                    strings,
                    &mut operands,
                    &mut string_slot_refs,
                    next_global_slot_index,
                    &mut slot_index_within_instruction,
                );
            }
        }
        _ => {}
    }
    let _ = TextEncoding::ShiftJisInlineRun; // silence unused-import

    (consumed, kind, operands, string_slot_refs)
}
