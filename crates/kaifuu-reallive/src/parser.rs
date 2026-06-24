//! Bytecode parser FSM for the RealLive Scene/SEEN parser-boundary smoke.
//!
//! See `lib.rs` for the clean-room provenance posture, the instruction
//! shape, and the operand-tag table. Every byte of the scene-blob input
//! is either consumed by an [`crate::ast::Instruction`] node or covered
//! by a [`crate::diagnostics::ParseDiagnostic`]; the partition guarantee
//! is exercised by the
//! `partitions_scene_bytes_completely_into_instructions_and_diagnostics`
//! test.

use kaifuu_core::SourceEncoding;

use crate::archive::{preview_hex, scene_id_string};
use crate::ast::{
    Instruction, InstructionId, InstructionKind, Operand, ParseOutcome, SCHEMA_VERSION, Scene,
    StringSlotRole,
};
use crate::diagnostics::{ParseDiagnostic, ParseDiagnosticCode};
use crate::opcodes::{INSTRUCTION_OPENER, NamedOpcode, operand_tag};
use crate::strings::make_slot;

/// Parse a single scene blob into an AST plus diagnostics.
///
/// `scene_id` is the 10,000-slot directory slot index for this scene
/// (matches the historical `seenNNNN` naming); it feeds into the stable
/// [`crate::ast::InstructionId`] and [`crate::ast::StringSlotId`]
/// derivations (see `lib.rs` § "Stable id derivation rule"). The
/// `scene_offset` parameter is recorded for downstream tools and exists
/// for parity with the documented public surface (KAIFUU-174 will use it
/// when projecting `byte_range.start` into absolute archive coordinates).
///
/// The parser never panics on malformed input; instead it emits one or
/// more [`ParseDiagnostic`] entries. The returned [`ParseOutcome`] has
/// `scene = None` iff any diagnostic carries
/// [`crate::ast::DiagnosticSeverity::Fatal`].
pub fn parse_scene(scene_bytes: &[u8], scene_id: u16, _scene_offset: u64) -> ParseOutcome {
    let mut diagnostics = Vec::new();
    let mut instructions = Vec::new();
    let mut strings = Vec::new();

    let mut cursor: usize = 0;
    let total = scene_bytes.len();
    let mut next_global_slot_index: u32 = 0;

    while cursor < total {
        let opener = scene_bytes[cursor];
        let instr_offset = cursor as u64;

        if opener != INSTRUCTION_OPENER {
            // Unrecognized opener — emit a warning and advance one byte.
            // The byte range is recorded as an Unrecognized instruction
            // so the partition invariant holds.
            instructions.push(Instruction {
                instruction_id: InstructionId::for_scene(scene_id, instr_offset),
                byte_offset: instr_offset,
                byte_len: 1,
                kind: InstructionKind::Unrecognized {
                    raw_opener_byte: opener,
                },
                operands: Vec::new(),
                string_slot_refs: Vec::new(),
            });
            diagnostics.push(ParseDiagnostic::warning(
                ParseDiagnosticCode::UnrecognizedInstruction,
                instr_offset,
                Some(1),
                preview_hex(scene_bytes, cursor),
                format!(
                    "unrecognized instruction opener byte 0x{opener:02X} at scene-blob offset {instr_offset}; \
                     advancing one byte. The byte is preserved as an Unrecognized instruction node."
                ),
            ));
            cursor += 1;
            continue;
        }

        // Need: opener (1) + opcode byte (1) + operand count (1) at least.
        if cursor + 3 > total {
            diagnostics.push(ParseDiagnostic::fatal(
                ParseDiagnosticCode::TruncatedInstruction,
                instr_offset,
                Some((total - cursor) as u64),
                preview_hex(scene_bytes, cursor),
                "instruction header truncated: need opener + opcode + operand-count bytes",
            ));
            // The fatal status will suppress the scene below; we still
            // bail out of the loop so we do not emit further partial AST.
            break;
        }

        let opcode_byte = scene_bytes[cursor + 1];
        let operand_count = scene_bytes[cursor + 2];
        let mut local_cursor = cursor + 3;
        let mut operands = Vec::with_capacity(operand_count as usize);
        let mut string_slot_refs = Vec::new();
        let mut slot_index_within_instruction: u8 = 0;

        let opcode = NamedOpcode::from_byte(opcode_byte);
        let default_role = opcode
            .map(NamedOpcode::default_string_slot_role)
            .unwrap_or(StringSlotRole::Unknown);

        let mut instr_fatal = false;
        let mut instr_unrecognized_operand = false;
        for operand_index in 0..operand_count {
            if local_cursor >= total {
                diagnostics.push(ParseDiagnostic::fatal(
                    ParseDiagnosticCode::TruncatedInstruction,
                    instr_offset,
                    Some((total - cursor) as u64),
                    preview_hex(scene_bytes, cursor),
                    format!(
                        "instruction at offset {instr_offset} declared {operand_count} operands \
                         but bytes ran out at operand index {operand_index}"
                    ),
                ));
                instr_fatal = true;
                break;
            }
            let tag = scene_bytes[local_cursor];
            let tag_offset = local_cursor as u64;
            local_cursor += 1;

            match tag {
                operand_tag::INT => {
                    if local_cursor + 4 > total {
                        diagnostics.push(ParseDiagnostic::fatal(
                            ParseDiagnosticCode::TruncatedInstruction,
                            tag_offset,
                            Some((total - local_cursor + 1) as u64),
                            preview_hex(scene_bytes, local_cursor - 1),
                            "int operand truncated: need 4 little-endian bytes after tag",
                        ));
                        instr_fatal = true;
                        break;
                    }
                    let mut buf = [0u8; 4];
                    buf.copy_from_slice(&scene_bytes[local_cursor..local_cursor + 4]);
                    let value = i32::from_le_bytes(buf);
                    operands.push(Operand::Int {
                        value,
                        byte_offset: tag_offset,
                        byte_len: 5,
                    });
                    local_cursor += 4;
                }
                operand_tag::STRING => {
                    if local_cursor + 2 > total {
                        diagnostics.push(ParseDiagnostic::fatal(
                            ParseDiagnosticCode::TruncatedInstruction,
                            tag_offset,
                            Some((total - local_cursor + 1) as u64),
                            preview_hex(scene_bytes, local_cursor - 1),
                            "string operand truncated: need 2-byte LE length prefix",
                        ));
                        instr_fatal = true;
                        break;
                    }
                    let len = u16::from_le_bytes([
                        scene_bytes[local_cursor],
                        scene_bytes[local_cursor + 1],
                    ]) as usize;
                    let slot_byte_offset = (local_cursor + 2) as u64;
                    if local_cursor + 2 + len > total {
                        // Emit a recoverable invalid_string_slot warning;
                        // record a zero-length slot per §8.2 row 6 of the
                        // plan, and skip the remainder of the operand
                        // span.
                        diagnostics.push(ParseDiagnostic::warning(
                            ParseDiagnosticCode::InvalidStringSlot,
                            tag_offset,
                            Some((total - local_cursor + 1) as u64),
                            preview_hex(scene_bytes, local_cursor - 1),
                            format!(
                                "string operand at offset {tag_offset} declares length {len} \
                                 but only {} bytes remain; recording slot with byte_len = 0",
                                total - (local_cursor + 2)
                            ),
                        ));
                        let (slot, slot_ref) = make_slot(
                            scene_id,
                            slot_byte_offset,
                            slot_index_within_instruction,
                            &[],
                            default_role,
                            SourceEncoding::Binary,
                            next_global_slot_index,
                        );
                        strings.push(slot);
                        operands.push(Operand::String {
                            slot_ref: slot_ref.clone(),
                        });
                        string_slot_refs.push(slot_ref);
                        next_global_slot_index += 1;
                        let _ = slot_index_within_instruction
                            .checked_add(1)
                            .expect("more than 255 string operands in a single instruction");
                        // Advance to the end of the scene so we do not
                        // emit further nested diagnostics on this
                        // truncated run; the warning fully accounts for
                        // the remaining bytes via the partition rule
                        // (the diagnostic byte_len covers the remainder).
                        local_cursor = total;
                        break;
                    }
                    let raw_bytes = &scene_bytes[local_cursor + 2..local_cursor + 2 + len];
                    let (slot, slot_ref) = make_slot(
                        scene_id,
                        slot_byte_offset,
                        slot_index_within_instruction,
                        raw_bytes,
                        default_role,
                        SourceEncoding::Binary,
                        next_global_slot_index,
                    );
                    strings.push(slot);
                    operands.push(Operand::String {
                        slot_ref: slot_ref.clone(),
                    });
                    string_slot_refs.push(slot_ref);
                    next_global_slot_index += 1;
                    slot_index_within_instruction = slot_index_within_instruction
                        .checked_add(1)
                        .expect("more than 255 string operands in a single instruction");
                    local_cursor += 2 + len;
                }
                operand_tag::LABEL => {
                    if local_cursor + 2 > total {
                        diagnostics.push(ParseDiagnostic::fatal(
                            ParseDiagnosticCode::TruncatedInstruction,
                            tag_offset,
                            Some((total - local_cursor + 1) as u64),
                            preview_hex(scene_bytes, local_cursor - 1),
                            "label operand truncated: need 2-byte LE length prefix",
                        ));
                        instr_fatal = true;
                        break;
                    }
                    let len = u16::from_le_bytes([
                        scene_bytes[local_cursor],
                        scene_bytes[local_cursor + 1],
                    ]) as usize;
                    if local_cursor + 2 + len > total {
                        diagnostics.push(ParseDiagnostic::fatal(
                            ParseDiagnosticCode::TruncatedInstruction,
                            tag_offset,
                            Some((total - local_cursor + 1) as u64),
                            preview_hex(scene_bytes, local_cursor - 1),
                            format!(
                                "label operand at offset {tag_offset} declares length {len} \
                                 but only {} bytes remain",
                                total - (local_cursor + 2)
                            ),
                        ));
                        instr_fatal = true;
                        break;
                    }
                    let raw_bytes = &scene_bytes[local_cursor + 2..local_cursor + 2 + len];
                    // Labels are ASCII per the synthetic-fixture
                    // catalogue. Non-ASCII bytes are recorded verbatim;
                    // the lossy decode is fine for the smoke since
                    // KAIFUU-174 owns Shift-JIS decode.
                    let name = String::from_utf8_lossy(raw_bytes).into_owned();
                    operands.push(Operand::Label {
                        name,
                        byte_offset: tag_offset,
                        byte_len: (3 + len) as u64,
                    });
                    local_cursor += 2 + len;
                }
                other => {
                    // Operand tag outside the documented set. Emit a
                    // recoverable warning and stop reading operands for
                    // this instruction — but record it so the partition
                    // invariant holds against the bytes we have seen so
                    // far.
                    diagnostics.push(ParseDiagnostic::warning(
                        ParseDiagnosticCode::UnrecognizedOperandShape,
                        tag_offset,
                        Some(1),
                        preview_hex(scene_bytes, local_cursor - 1),
                        format!(
                            "operand tag 0x{other:02X} at offset {tag_offset} not in the \
                             documented operand-tag set (int/string/label); recording \
                             instruction with operands parsed so far"
                        ),
                    ));
                    instr_unrecognized_operand = true;
                    break;
                }
            }
        }

        if instr_fatal {
            // Stop parsing further instructions; the fatal flag will
            // suppress AST emission below.
            break;
        }

        let consumed = local_cursor.saturating_sub(cursor);
        let kind = match opcode {
            Some(opcode) => InstructionKind::Named { opcode },
            None => {
                diagnostics.push(ParseDiagnostic::warning(
                    ParseDiagnosticCode::UnrecognizedInstruction,
                    instr_offset,
                    Some(consumed as u64),
                    preview_hex(scene_bytes, cursor),
                    format!(
                        "opcode byte 0x{opcode_byte:02X} after opener at offset {instr_offset} \
                         is not in the named catalogue; recording Unrecognized node and \
                         continuing"
                    ),
                ));
                InstructionKind::Unrecognized {
                    raw_opener_byte: opcode_byte,
                }
            }
        };

        instructions.push(Instruction {
            instruction_id: InstructionId::for_scene(scene_id, instr_offset),
            byte_offset: instr_offset,
            byte_len: consumed as u64,
            kind,
            operands,
            string_slot_refs,
        });

        if instr_unrecognized_operand {
            // Best-effort recovery: the next byte after the unrecognized
            // operand tag may not be a clean opener. We advance to the
            // tag byte itself (already consumed) plus zero — the loop
            // top will then re-classify each subsequent byte as either a
            // recognized opener or another `unrecognized_instruction`
            // warning.
        }
        cursor = local_cursor;
    }

    let scene = Scene {
        schema_version: SCHEMA_VERSION.to_string(),
        scene_id: scene_id_string(scene_id),
        instructions,
        strings,
    };
    ParseOutcome::new(Some(scene), diagnostics)
}
