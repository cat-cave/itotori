//! Siglus scene-bytecode partitioner (skeleton).
//! Siglus scene bytecode is a **stack-machine** instruction stream: a 1-byte
//! command code followed by a command-specific little-endian operand block that
//! pushes/pops operands and references interned string / label tables. This
//! module owns the **structural** decode: it parses the decompressed scene's
//! `S_tnm_scn_header` (33 little-endian `i32` fields, `0x84` bytes), locates the
//! `scn` bytecode section, and walks it into a fully-covering stream of
//! [`SiglusInstruction`]s — each an `(opcode, exact byte offset, operand
//! length)` — plus a sanitized per-opcode [`SiglusOpcodeHistogram`].
//!
//! # Scope: partition, not interpret
//! This is the partitioner **skeleton**. It classifies every command code and
//! computes exact operand-byte spans, but does **not** decode operand semantics
//! (expression trees, argument values, string references, control flow). Those
//! land in the downstream stack-VM decoder ([`crate::expression`] and beyond).
//! One command-tail width (`CD_COMMAND`'s `read_flag_no`) is a runtime property
//! of the invoked command element, not a byte-stream property; the skeleton
//! disambiguates it structurally against the scene's own label boundaries (see
//! [`walk`]). Any byte the model cannot classify is a typed
//! [`SiglusOpcode::Unknown`] span, counted and located in the histogram — never
//! silently swallowed. [`SiglusOpcodeHistogram`] carries only per-opcode counts
//! and `Unknown` offsets — never raw scene bytes or decoded text.

use std::collections::{BTreeMap, BTreeSet};

use serde::{Deserialize, Serialize};
use thiserror::Error;

mod walk;

/// Byte length of the scene header (`S_tnm_scn_header`): 33 little-endian
/// `i32` fields.
pub const SCN_HEADER_BYTE_LEN: usize = 33 * 4;

/// The scene header's self-declared size, in bytes (`0x84`). A well-formed
/// decompressed scene begins with this exact value.
pub const SCN_HEADER_DECLARED_SIZE: i32 = 0x84;

/// A classified Siglus scene-bytecode command code.
/// Names mirror the SiglusEngine `CD_*` command table. Every command code the
/// partitioner recognizes maps to one of these variants; a lead byte it cannot
/// classify (or whose operands run past the stream) becomes [`Self::Unknown`].
/// This is a **structural** classification — operand *values* are decoded
/// downstream.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
#[non_exhaustive]
pub enum SiglusOpcode {
    /// `0x01` — source line-number marker.
    Nl,
    /// `0x02` — push a literal of the given form onto the operand stack.
    Push,
    /// `0x03` — pop a value of the given form.
    Pop,
    /// `0x04` — copy (peek-and-push) the top value of the given form.
    Copy,
    /// `0x05` — resolve an element chain into a property read.
    Property,
    /// `0x06` — duplicate the current element chain.
    CopyElm,
    /// `0x07` — declare a call-local property.
    DecProp,
    /// `0x08` — mark the start of an element chain on the operand stack.
    ElmPoint,
    /// `0x09` — expand stack arguments into the current call's properties.
    Arg,
    /// `0x10` — unconditional jump to a label.
    Goto,
    /// `0x11` — jump to a label when the popped condition is non-zero.
    GotoTrue,
    /// `0x12` — jump to a label when the popped condition is zero.
    GotoFalse,
    /// `0x13` — call a label subroutine (int return).
    Gosub,
    /// `0x14` — call a label subroutine (str return).
    GosubStr,
    /// `0x15` — return from the current subroutine / scene.
    Return,
    /// `0x16` — end of the instruction stream.
    Eof,
    /// `0x20` — assign a popped value into an element chain.
    Assign,
    /// `0x21` — unary operator on the top-of-stack value.
    Operate1,
    /// `0x22` — binary operator on the top two stack values.
    Operate2,
    /// `0x30` — invoke a command element. `read_flag` records whether the
    /// runtime `read_flag_no` tail word was partitioned (resolved
    /// structurally; the semantic decision lands downstream).
    Command {
        /// Whether the trailing `read_flag_no` word was included.
        read_flag: bool,
    },
    /// `0x31` — emit a message-text run.
    Text,
    /// `0x32` — set the current speaker name.
    Name,
    /// `0x33` — open a selection block.
    SelBlockStart,
    /// `0x34` — close a selection block.
    SelBlockEnd,
    /// A lead byte the skeleton cannot classify, or whose operands would run
    /// past the stream end. Carries the raw lead byte and its absolute offset
    /// within the bytecode section so downstream work can drive these to zero.
    Unknown {
        /// The raw unclassifiable lead byte.
        lead: u8,
        /// Absolute offset within the bytecode section.
        byte_offset: usize,
    },
}

/// One partitioned instruction: its exact offset within the bytecode (`scn`)
/// section, the raw lead byte, the classified [`SiglusOpcode`], and the total
/// instruction length in bytes (lead byte + operands). The operand bytes
/// occupy `[byte_offset + 1, byte_offset + len)`. Offsets are exact and
/// reproducible: the same bytes always partition identically.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SiglusInstruction {
    /// Absolute offset of the lead byte within the bytecode section.
    pub byte_offset: usize,
    /// The raw lead byte (command code).
    pub lead: u8,
    /// The classified opcode.
    pub opcode: SiglusOpcode,
    /// Total instruction length (lead byte + operands).
    pub len: usize,
}

/// Sanitized per-opcode histogram for one or more partitioned scenes.
/// Counts and offsets only — never raw scene bytes or decoded text.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SiglusOpcodeHistogram {
    /// Per lead-byte instruction counts, keyed by two-digit hex (`"01"`..).
    /// Includes `Unknown` lead bytes.
    pub counts: BTreeMap<String, usize>,
    /// Total number of `Unknown` spans.
    pub unknown_count: usize,
    /// Distinct `Unknown` lead bytes and how many spans each produced.
    pub unknown_lead_counts: BTreeMap<String, usize>,
    /// Absolute byte offsets of every `Unknown` span (offsets only).
    pub unknown_offsets: Vec<usize>,
}

impl SiglusOpcodeHistogram {
    /// Fold another histogram into this one (for per-game / per-corpus rollups).
    pub fn merge(&mut self, other: &SiglusOpcodeHistogram) {
        for (key, count) in &other.counts {
            *self.counts.entry(key.clone()).or_insert(0) += count;
        }
        for (key, count) in &other.unknown_lead_counts {
            *self.unknown_lead_counts.entry(key.clone()).or_insert(0) += count;
        }
        self.unknown_count += other.unknown_count;
    }
}

/// The result of partitioning one decompressed scene payload.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SiglusScenePartition {
    /// Length of the bytecode (`scn`) section, in bytes.
    pub bytecode_len: usize,
    /// Number of instructions (known + `Unknown` spans).
    pub instruction_count: usize,
    /// The fully-covering instruction stream (no gaps, contiguous offsets).
    pub instructions: Vec<SiglusInstruction>,
    /// Sanitized per-opcode histogram.
    pub histogram: SiglusOpcodeHistogram,
    /// Number of label / z-label anchors resolved from the scene header.
    pub anchor_count: usize,
    /// True when every anchor landed on an instruction-start boundary.
    pub anchors_aligned: bool,
    /// True when the scene partitioned with zero `Unknown` spans and every
    /// anchor aligned — the acceptance shape for a fully-recognized scene.
    pub fully_partitioned: bool,
}

/// Fatal errors raised while partitioning a scene payload. The byte walk itself
/// is infallible (unclassifiable bytes become `Unknown` spans); only a
/// malformed **header** is fatal — and always as a typed diagnostic, never a
/// panic.
#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum SiglusParseError {
    /// The payload is shorter than the fixed scene header.
    #[error(
        "kaifuu.siglus.opcode.payload_too_short: scene payload length {len} is shorter than the \
         {needed}-byte scene header"
    )]
    PayloadTooShort {
        /// Observed payload length.
        len: usize,
        /// Required header length.
        needed: usize,
    },
    /// The header's self-declared size is not the expected `0x84`.
    #[error(
        "kaifuu.siglus.opcode.unexpected_header_size: scene header declares size {declared:#x}, \
         expected {SCN_HEADER_DECLARED_SIZE:#x}"
    )]
    UnexpectedHeaderSize {
        /// The declared header size.
        declared: i32,
    },
    /// The declared bytecode (`scn`) section runs past the payload end.
    #[error(
        "kaifuu.siglus.opcode.bytecode_out_of_bounds: scn section [{scn_ofs}, {scn_ofs}+{scn_size}) \
         runs past payload length {payload_len}"
    )]
    BytecodeOutOfBounds {
        /// Declared bytecode offset.
        scn_ofs: usize,
        /// Declared bytecode size.
        scn_size: usize,
        /// Observed payload length.
        payload_len: usize,
    },
}

/// Read a little-endian `i32` at an exact byte offset, or `None` past the end.
fn read_i32_at(payload: &[u8], byte_offset: usize) -> Option<i32> {
    let slice = payload.get(byte_offset..byte_offset.checked_add(4)?)?;
    Some(i32::from_le_bytes([slice[0], slice[1], slice[2], slice[3]]))
}

/// Read a little-endian `i32` header field by field index, or `None` past the
/// end.
fn header_field(payload: &[u8], index: usize) -> Option<i32> {
    read_i32_at(payload, index.checked_mul(4)?)
}

/// Collect the byte offsets of a header offset/count table (label or z-label),
/// keeping only in-range instruction offsets (`<= bytecode_len`). `ofs_field` /
/// `cnt_field` are header field indices; the table itself is an array of
/// little-endian `i32` scn-relative offsets at that byte offset.
fn collect_offsets(
    payload: &[u8],
    ofs_field: usize,
    cnt_field: usize,
    bytecode_len: usize,
    out: &mut BTreeSet<usize>,
) {
    let table_ofs = header_field(payload, ofs_field).unwrap_or(0).max(0) as usize;
    let count = header_field(payload, cnt_field).unwrap_or(0).max(0) as usize;
    for i in 0..count {
        let Some(entry) = i
            .checked_mul(4)
            .and_then(|delta| table_ofs.checked_add(delta))
            .and_then(|byte_offset| read_i32_at(payload, byte_offset))
        else {
            break;
        };
        let offset = entry.max(0) as usize;
        if offset <= bytecode_len {
            out.insert(offset);
        }
    }
}

fn hex2(byte: u8) -> String {
    format!("{byte:02x}")
}

/// Build the sanitized histogram from a partitioned instruction stream.
fn build_histogram(
    instructions: &[SiglusInstruction],
    unknown_offsets: &[usize],
) -> SiglusOpcodeHistogram {
    let mut counts: BTreeMap<String, usize> = BTreeMap::new();
    let mut unknown_lead_counts: BTreeMap<String, usize> = BTreeMap::new();
    for instruction in instructions {
        *counts.entry(hex2(instruction.lead)).or_insert(0) += 1;
        if matches!(instruction.opcode, SiglusOpcode::Unknown { .. }) {
            *unknown_lead_counts
                .entry(hex2(instruction.lead))
                .or_insert(0) += 1;
        }
    }
    SiglusOpcodeHistogram {
        counts,
        unknown_count: unknown_offsets.len(),
        unknown_lead_counts,
        unknown_offsets: unknown_offsets.to_vec(),
    }
}

/// Partition a **decompressed** Siglus scene payload (as produced by
/// [`crate::scene_decode::decode_scene_chunk`]) into a fully-covering
/// instruction stream plus a sanitized histogram.
///
/// The payload's `S_tnm_scn_header` locates the `scn` bytecode section and the
/// label / z-label tables (used as instruction-boundary anchors). The byte walk
/// is infallible and panic-free; only a malformed header returns a typed
/// [`SiglusParseError`]. `Unknown`-opcode spans are permitted and reported (not
/// fatal) — driving them to zero is downstream work.
pub fn partition_scene(payload: &[u8]) -> Result<SiglusScenePartition, SiglusParseError> {
    if payload.len() < SCN_HEADER_BYTE_LEN {
        return Err(SiglusParseError::PayloadTooShort {
            len: payload.len(),
            needed: SCN_HEADER_BYTE_LEN,
        });
    }
    // Fields 0..2: header_size, scn_ofs, scn_size (payload length is checked).
    let declared = header_field(payload, 0).unwrap_or_default();
    if declared != SCN_HEADER_DECLARED_SIZE {
        return Err(SiglusParseError::UnexpectedHeaderSize { declared });
    }
    let scn_ofs = header_field(payload, 1).unwrap_or_default().max(0) as usize;
    let scn_size = header_field(payload, 2).unwrap_or_default().max(0) as usize;
    let scn_end = scn_ofs
        .checked_add(scn_size)
        .filter(|end| *end <= payload.len())
        .ok_or(SiglusParseError::BytecodeOutOfBounds {
            scn_ofs,
            scn_size,
            payload_len: payload.len(),
        })?;
    let bytecode = &payload[scn_ofs..scn_end];

    // Anchors: label_list (fields 7/8) and z_label_list (fields 9/10). Offsets
    // are relative to the scn section start.
    let mut anchors: BTreeSet<usize> = BTreeSet::new();
    collect_offsets(payload, 7, 8, bytecode.len(), &mut anchors);
    collect_offsets(payload, 9, 10, bytecode.len(), &mut anchors);

    let (instructions, unknown_offsets, boundaries) = walk::walk_bytecode(bytecode, &anchors);
    let anchors_aligned = anchors.iter().all(|anchor| boundaries.contains(anchor));
    let histogram = build_histogram(&instructions, &unknown_offsets);
    let fully_partitioned = unknown_offsets.is_empty() && anchors_aligned;

    Ok(SiglusScenePartition {
        bytecode_len: bytecode.len(),
        instruction_count: instructions.len(),
        instructions,
        histogram,
        anchor_count: anchors.len(),
        anchors_aligned,
        fully_partitioned,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Little-endian `i32` push helper for hand-built scene payloads.
    fn put_i32(buf: &mut Vec<u8>, value: i32) {
        buf.extend_from_slice(&value.to_le_bytes());
    }

    /// Build a minimal well-formed scene payload: a `0x84` header whose `scn`
    /// section carries `bytecode`, with the given label offsets. All other
    /// tables are empty.
    fn build_payload(bytecode: &[u8], labels: &[i32]) -> Vec<u8> {
        let header_len = SCN_HEADER_BYTE_LEN as i32;
        // Layout: [header][scn bytecode][label table].
        let scn_ofs = header_len;
        let label_ofs = header_len + bytecode.len() as i32;
        let mut header = Vec::new();
        put_i32(&mut header, SCN_HEADER_DECLARED_SIZE); // 0 header_size
        put_i32(&mut header, scn_ofs); // 1 scn_ofs
        put_i32(&mut header, bytecode.len() as i32); // 2 scn_size
        put_i32(&mut header, 0); // 3 str_index_list_ofs
        put_i32(&mut header, 0); // 4 str_index_cnt
        put_i32(&mut header, 0); // 5 str_list_ofs
        put_i32(&mut header, 0); // 6 str_cnt
        put_i32(&mut header, label_ofs); // 7 label_list_ofs
        put_i32(&mut header, labels.len() as i32); // 8 label_cnt
        put_i32(&mut header, 0); // 9 z_label_list_ofs
        put_i32(&mut header, 0); // 10 z_label_cnt
        for _ in 11..33 {
            put_i32(&mut header, 0);
        }
        let mut payload = header;
        payload.extend_from_slice(bytecode);
        for label in labels {
            put_i32(&mut payload, *label);
        }
        payload
    }

    #[test]
    fn partitions_fixed_width_opcodes_with_exact_offsets() {
        // NL(0x01,+4), NAME(0x32,+0), TEXT(0x31,+4), EOF(0x16,+0).
        let bytecode = vec![
            0x01, 0, 0, 0, 0,    // NL
            0x32, // NAME
            0x31, 7, 0, 0, 0,    // TEXT
            0x16, // EOF
        ];
        let part = partition_scene(&build_payload(&bytecode, &[])).expect("partition");
        assert!(part.fully_partitioned);
        assert_eq!(part.histogram.unknown_count, 0);
        assert_eq!(part.bytecode_len, bytecode.len());
        let kinds: Vec<_> = part
            .instructions
            .iter()
            .map(|i| (i.byte_offset, i.lead, i.len))
            .collect();
        assert_eq!(
            kinds,
            vec![(0, 0x01, 5), (5, 0x32, 1), (6, 0x31, 5), (11, 0x16, 1)]
        );
        // Instructions fully cover the bytecode with no gaps.
        let covered: usize = part.instructions.iter().map(|i| i.len).sum();
        assert_eq!(covered, bytecode.len());
    }

    #[test]
    fn push_int_form_widens_operand_by_four() {
        // PUSH int(form=10) value + PUSH str(form=20) value + PUSH void(form=0).
        let mut bytecode = vec![0x02];
        bytecode.extend_from_slice(&10i32.to_le_bytes()); // int form
        bytecode.extend_from_slice(&42i32.to_le_bytes()); // literal
        bytecode.push(0x02);
        bytecode.extend_from_slice(&20i32.to_le_bytes()); // str form
        bytecode.extend_from_slice(&3i32.to_le_bytes()); // str id
        bytecode.push(0x02);
        bytecode.extend_from_slice(&0i32.to_le_bytes()); // void form (no literal)
        let part = partition_scene(&build_payload(&bytecode, &[])).expect("partition");
        assert!(part.fully_partitioned);
        let lens: Vec<_> = part.instructions.iter().map(|i| i.len).collect();
        assert_eq!(lens, vec![9, 9, 5]);
    }

    #[test]
    fn command_read_flag_tail_disambiguated_by_label_anchor() {
        // COMMAND with empty arg list, 0 named args, ret_form, then a trailing
        // read_flag_no word. A label anchor points *past* the read_flag tail, so
        // the disambiguator must select the read-flag variant.
        let mut bytecode = vec![0x30];
        put_i32(&mut bytecode, 0); // arg_list_id
        put_i32(&mut bytecode, 0); // arg list count = 0
        put_i32(&mut bytecode, 0); // named_arg_cnt = 0
        put_i32(&mut bytecode, 0); // ret_form
        put_i32(&mut bytecode, 5); // read_flag_no (present)
        let after_rf = bytecode.len() as i32; // 25
        bytecode.push(0x16); // EOF at offset 25
        let part = partition_scene(&build_payload(&bytecode, &[after_rf])).expect("partition");
        assert!(part.fully_partitioned, "{:?}", part.histogram);
        assert_eq!(
            part.instructions[0].opcode,
            SiglusOpcode::Command { read_flag: true }
        );
        // 0x30 + arg_list_id(4) + arg_list(4) + named_cnt(4) + ret_form(4)
        // + read_flag_no(4) = 21 bytes.
        assert_eq!(part.instructions[0].len, 21);
    }

    #[test]
    fn unknown_lead_byte_is_reported_not_swallowed() {
        // 0xAA is not a known command code.
        let bytecode = vec![0xAA, 0x16];
        let part = partition_scene(&build_payload(&bytecode, &[])).expect("partition");
        assert!(!part.fully_partitioned);
        assert_eq!(part.histogram.unknown_count, 1);
        assert_eq!(part.histogram.unknown_lead_counts.get("aa"), Some(&1));
        assert_eq!(part.histogram.unknown_offsets, vec![0]);
        // Still fully covering: Unknown span + the trailing EOF.
        let covered: usize = part.instructions.iter().map(|i| i.len).sum();
        assert_eq!(covered, bytecode.len());
    }

    #[test]
    fn deterministic_across_two_runs() {
        let bytecode = vec![0x01, 0, 0, 0, 0, 0x32, 0x16];
        let payload = build_payload(&bytecode, &[]);
        let a = partition_scene(&payload).expect("run a");
        let b = partition_scene(&payload).expect("run b");
        assert_eq!(a, b);
    }

    #[test]
    fn malformed_header_is_typed_not_panic() {
        let short = vec![0u8; 8];
        assert!(matches!(
            partition_scene(&short),
            Err(SiglusParseError::PayloadTooShort { .. })
        ));
        let mut bad_size = vec![0u8; SCN_HEADER_BYTE_LEN];
        bad_size[0] = 0x11; // wrong declared size
        assert!(matches!(
            partition_scene(&bad_size),
            Err(SiglusParseError::UnexpectedHeaderSize { .. })
        ));
    }

    #[test]
    fn walk_never_panics_on_arbitrary_bytecode() {
        // Fuzz-ish: every single-byte lead plus random tails must partition
        // without panicking (Unknown spans are fine).
        for lead in 0u8..=0xFF {
            let bytecode = vec![lead, 0x99, 0x00, 0xFF, 0x7F, 0x01, 0x30, 0x30];
            let payload = build_payload(&bytecode, &[]);
            let _ = partition_scene(&payload).expect("header is well-formed");
        }
    }
}
