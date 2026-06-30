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
use crate::opcode::{
    RealLiveOpcode, RealLiveParseError, TextEncoding, parse_real_bytecode,
    parse_real_bytecode_spans,
};
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
    // Drive the AST projection off the authoritative width-carrying decode
    // ([`parse_real_bytecode_spans`]): each element's `consumed` width is
    // exactly what the single-source-of-truth `decode_element` /
    // `decode_command` consumed. The projection must NOT re-derive widths
    // heuristically — a second table would silently drift and mis-place
    // every `byte_offset` after the first command carrying args/pointers.
    let spans = match parse_real_bytecode_spans(scene_bytes) {
        Ok(spans) => spans,
        Err(err) => {
            diagnostics.push(map_parse_error(&err));
            return ParseOutcome::new(None, diagnostics);
        }
    };

    let mut instructions = Vec::new();
    let mut strings = Vec::new();
    let mut next_global_slot_index: u32 = 0;
    let mut byte_offset: u64 = 0;

    for (opcode, consumed) in &spans {
        let consumed = *consumed;
        let (kind, operands, string_slot_refs) = project_opcode(
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
/// (`InstructionKind`, `operands`, `string_slot_refs`) tuple for the
/// [`Scene`] tree. The function also pushes any extracted string slots
/// into the running `strings` vector and bumps `next_global_slot_index`.
///
/// The element's byte width is **not** computed here: it is supplied by
/// the caller from [`parse_real_bytecode_spans`] (the single source of
/// truth that mirrors `decode_command`). Re-deriving it here would
/// reintroduce a second width table that could silently drift from the
/// decoder.
fn project_opcode(
    opcode: &RealLiveOpcode,
    scene_id: u16,
    byte_offset: u64,
    _scene_bytes: &[u8],
    strings: &mut Vec<crate::ast::StringSlot>,
    next_global_slot_index: &mut u32,
) -> (
    InstructionKind,
    Vec<Operand>,
    Vec<crate::ast::StringSlotRef>,
) {
    let named: Option<NamedOpcode> = match opcode {
        RealLiveOpcode::MetaLine { .. }
        | RealLiveOpcode::MetaEntrypoint { .. }
        | RealLiveOpcode::MetaKidoku { .. }
        | RealLiveOpcode::Comma
        | RealLiveOpcode::Expression { .. } => None,
        RealLiveOpcode::Textout { .. } => Some(NamedOpcode::TextDisplay),
        RealLiveOpcode::TextDisplay { .. } => Some(NamedOpcode::TextDisplay),
        RealLiveOpcode::CharacterTextDisplay => Some(NamedOpcode::SetSpeaker),
        RealLiveOpcode::Choice { .. } => Some(NamedOpcode::Choice),
        RealLiveOpcode::Branch | RealLiveOpcode::If => Some(NamedOpcode::Jump),
        RealLiveOpcode::Jump | RealLiveOpcode::Goto | RealLiveOpcode::Call => {
            Some(NamedOpcode::Jump)
        }
        RealLiveOpcode::Return => Some(NamedOpcode::Return),
        RealLiveOpcode::Wait { .. } => Some(NamedOpcode::Pause),
        RealLiveOpcode::Background { .. } => Some(NamedOpcode::SetVar),
        RealLiveOpcode::BgmPlay | RealLiveOpcode::BgmStop => Some(NamedOpcode::SetVar),
        RealLiveOpcode::VoicePlay { .. } => Some(NamedOpcode::SetVar),
        RealLiveOpcode::SetVariable => Some(NamedOpcode::SetVar),
        RealLiveOpcode::End => Some(NamedOpcode::Return),
        // Generic typed function command (documented long-tail module):
        // structurally decoded but without a bespoke synthetic NamedOpcode.
        RealLiveOpcode::Command { .. } => None,
        RealLiveOpcode::Unknown { .. } => None,
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
    // `slot_byte_offset` is the slot's **scene-relative** byte offset — the
    // splice target the length-preserving patch-back keys on. It MUST point
    // at the slot's editable bytes, not the instruction opener. For a
    // Textout run the run starts at the instruction, so the two coincide;
    // for a Choice option the editable bytes live inside the argument list,
    // so the caller passes the per-option offset captured by the decoder.
    let push_string_slot = |slot_byte_offset: u64,
                            bytes: &[u8],
                            role: StringSlotRole,
                            strings: &mut Vec<crate::ast::StringSlot>,
                            operands: &mut Vec<Operand>,
                            string_slot_refs: &mut Vec<crate::ast::StringSlotRef>,
                            next_global_slot_index: &mut u32,
                            slot_index_within_instruction: &mut u8| {
        let (slot, slot_ref) = make_slot(
            scene_id,
            slot_byte_offset,
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
            // A Textout run starts at the instruction byte_offset and the
            // whole run is the editable slot, so offset == byte_offset and
            // byte_len == raw_bytes.len() — already byte-correct.
            push_string_slot(
                byte_offset,
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
            // TextDisplay / CharacterTextDisplay carry no inline text body
            // in the parsed opcode (the visible run lands as the following
            // Textout). The slot is a zero-length marker anchored at the
            // command opener: byte_len == 0, so a slot-keyed splice can
            // never overwrite the opcode header (the canonical
            // bundle-driven patchback re-walks authoritative ranges).
            push_string_slot(
                byte_offset,
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
                byte_offset,
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
                // Stamp each Choice slot at the option's authoritative
                // scene-relative byte offset (inside the argument list),
                // NOT the command opener — otherwise a slot-keyed splice
                // would write the translation over the opcode header and
                // structurally corrupt the scene.
                push_string_slot(
                    choice.byte_offset,
                    &choice.bytes,
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

    (kind, operands, string_slot_refs)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::opcode::{decode_element, opener};

    #[test]
    fn ast_byte_offsets_track_the_authoritative_decode_width_no_hardcoded_8_drift() {
        // 003 regression: project_opcode hardcoded every recognised
        // command to width 8, so the AST `byte_offset` of every element
        // after the first arg/pointer-carrying command drifted. Here a
        // goto_if (module_jmp opcode 2) carries an 8-byte header + an
        // 8-byte `( $ 0xFF 0 )` arg list + a 4-byte trailing jump pointer
        // = 20 bytes total. The following Textout's byte_offset must equal
        // that real width (20), not the old hardcoded 8.
        let mut bytes = vec![opener::COMMAND, 0, 1, 2, 0, 0, 0, 0];
        bytes.extend_from_slice(&[b'(', 0x24, 0xFF, 0x00, 0x00, 0x00, 0x00, b')']);
        bytes.extend_from_slice(&[0x61, 0x04, 0x00, 0x00]); // trailing i32 jump target
        bytes.extend_from_slice(&[0x83, 0x6E]); // Textout "ハ"
        bytes.extend_from_slice(&[opener::META_LINE, 0x05, 0x00]); // bound the run

        // The authoritative width the decoder consumes for the command.
        let (_op, command_width) = decode_element(&bytes, 0).expect("command decodes");
        assert_eq!(
            command_width, 20,
            "goto_if must consume header+arglist+pointer"
        );

        let outcome = parse_scene_into_ast(&bytes, 1, 0);
        let scene = outcome.scene.expect("scene must parse");
        // instruction[0] = goto_if command; byte_len must be the real width.
        assert_eq!(
            scene.instructions[0].byte_len, command_width as u64,
            "command byte_len must mirror decode_command, not a hardcoded 8"
        );
        // instruction[1] = the Textout; its byte_offset must follow the
        // command at the real width.
        assert_eq!(
            scene.instructions[1].byte_offset, command_width as u64,
            "byte_offset after an arg/pointer command must not drift to the hardcoded 8"
        );
    }
}
