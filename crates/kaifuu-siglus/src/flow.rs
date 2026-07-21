//! Siglus scene-bytecode **statement / flow decoder**.
//!
//! [`crate::opcode`] (the opcode partitioner) partitions a scene into a
//! fully-covering instruction stream and [`crate::expression`] (the
//! expression-stack evaluator) folds each instruction's operands into typed
//! [`SiglusExpr`](crate::expression::SiglusExpr) trees — but the evaluator
//! walks the stream **straight-line**, leaving ~0.3% of statement-level
//! operands as typed `StackUnderflow` diagnostics where a value's producer
//! sits across a control-flow edge. This module lands the statement / flow
//! layer over that substrate:
//!
//! 1. **Named statements** ([`SiglusStatement`]): every instruction decodes to a
//!    named, exact-argument statement — the `text` / `name` / `jump` / `assign`
//!    / `arith` / `command` families carry their operands, and a scene-wide
//!    [family histogram](SceneFlowDecode::family_histogram) proves zero
//!    `unknown` on a fully-partitioned scene.
//! 2. **Text surfaces** ([`SiglusTextSurface`]): every `CD_TEXT` / `CD_NAME`
//!    carries the string-table **reference** (index) plus the payload byte-span
//!    (offset + UTF-16 length) that the patch-back layer rewrites — the
//!    load-bearing output. Never the decoded characters.
//! 3. **Resolved jumps** ([`SiglusJump`]): every `CD_GOTO*` / `CD_GOSUB*` label
//!    index is resolved to its absolute bytecode target offset.
//! 4. **Choice units** ([`SiglusChoiceUnit`]): the select→conditional-jump
//!    dispatch pattern is recognized and linked (choice constant ↔ branch
//!    target).
//! 5. **Underflow resolution** ([`FlowUnderflowReport`]): the intra-scene
//!    control-flow graph propagates an abstract stack state across every jump +
//!    fall-through edge, resolving the evaluator's cross-edge underflows; the
//!    residual is a documented inter-procedural (call-frame / indirect-entry)
//!    non-flow residual.
//!
//! Every read is bounds-checked and the walk is bounded, so an adversarial or
//! truncated scene yields typed diagnostics, never a panic. Nothing here carries
//! raw scene text.

use std::collections::BTreeMap;

use crate::opcode::{SiglusParseError, partition_scene};

mod model;
mod resolve;
mod statements;

pub use model::{
    FlowUnderflowReport, SiglusChoiceArm, SiglusChoiceUnit, SiglusJump, SiglusJumpKind,
    SiglusStatement, SiglusTextSurface,
};

use statements::SceneStrings;

/// Read a little-endian `i32` header field by index, or `0` past the end.
fn header_field(payload: &[u8], index: usize) -> i32 {
    let base = index * 4;
    payload.get(base..base + 4).map_or(0, |slice| {
        i32::from_le_bytes([slice[0], slice[1], slice[2], slice[3]])
    })
}

/// Read a `count`-long array of little-endian `i32` at a payload byte offset,
/// keeping only the entries that stay in bounds (a truncated table simply ends
/// early — never a panic).
fn read_i32_array(payload: &[u8], ofs: i32, count: i32) -> Vec<i32> {
    let mut out = Vec::new();
    if ofs < 0 || count < 0 {
        return out;
    }
    let base = ofs as usize;
    for i in 0..count as usize {
        let Some(byte) = base.checked_add(i * 4) else {
            break;
        };
        let Some(slice) = payload.get(byte..byte + 4) else {
            break;
        };
        out.push(i32::from_le_bytes([slice[0], slice[1], slice[2], slice[3]]));
    }
    out
}

/// Read the string-index table (`(char_offset, char_len)` pairs, 8 bytes each).
fn read_str_index(payload: &[u8], ofs: i32, count: i32) -> Vec<(i32, i32)> {
    let mut out = Vec::new();
    if ofs < 0 || count < 0 {
        return out;
    }
    let base = ofs as usize;
    for i in 0..count as usize {
        let Some(byte) = base.checked_add(i * 8) else {
            break;
        };
        let Some(slice) = payload.get(byte..byte + 8) else {
            break;
        };
        let offset = i32::from_le_bytes([slice[0], slice[1], slice[2], slice[3]]);
        let size = i32::from_le_bytes([slice[4], slice[5], slice[6], slice[7]]);
        out.push((offset, size));
    }
    out
}

/// The header tables the flow layer consumes, resolved from an `S_tnm_scn_header`.
struct SceneTables {
    labels: Vec<i32>,
    scn_cmds: Vec<i32>,
    str_list_byte_ofs: usize,
    str_index: Vec<(i32, i32)>,
}

impl SceneTables {
    /// Parse the flow-relevant header tables from a decompressed scene payload.
    fn parse(payload: &[u8]) -> Self {
        let labels = read_i32_array(payload, header_field(payload, 7), header_field(payload, 8));
        let scn_cmds = read_i32_array(
            payload,
            header_field(payload, 19),
            header_field(payload, 20),
        );
        let str_list_byte_ofs = header_field(payload, 5).max(0) as usize;
        let str_index = read_str_index(payload, header_field(payload, 3), header_field(payload, 4));
        SceneTables {
            labels,
            scn_cmds,
            str_list_byte_ofs,
            str_index,
        }
    }
}

/// The result of decoding one scene's statement / flow structure.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SceneFlowDecode {
    /// Number of instructions (equals the partition's instruction count).
    pub instruction_count: usize,
    /// One named statement per instruction, in stream order.
    pub statements: Vec<SiglusStatement>,
    /// Every `CD_TEXT` / `CD_NAME` surface with its string-table reference +
    /// byte-span (the patch-back output).
    pub text_surfaces: Vec<SiglusTextSurface>,
    /// Every resolved control-flow transfer.
    pub jumps: Vec<SiglusJump>,
    /// Recognized + linked select→conditional-jump choice units.
    pub choice_units: Vec<SiglusChoiceUnit>,
    /// The flow layer's resolution of the expression-evaluator cross-edge underflows.
    pub underflow: FlowUnderflowReport,
    /// Per-family statement counts (`family → count`); `unknown` is zero on a
    /// fully-partitioned scene.
    pub family_histogram: BTreeMap<String, usize>,
}

impl SceneFlowDecode {
    /// Statement count in a named family (`text`, `name`, `jump`, …).
    pub fn family_count(&self, family: &str) -> usize {
        self.family_histogram.get(family).copied().unwrap_or(0)
    }

    /// Number of statements the decoder could not classify (`unknown` family).
    /// Zero for a fully-partitioned scene — the acceptance shape.
    pub fn unknown_family_count(&self) -> usize {
        self.family_count("unknown")
    }

    /// Number of `CD_TEXT` (message-run) surfaces.
    pub fn text_run_count(&self) -> usize {
        self.text_surfaces.iter().filter(|s| !s.is_name).count()
    }

    /// Number of `CD_NAME` (speaker) surfaces.
    pub fn name_run_count(&self) -> usize {
        self.text_surfaces.iter().filter(|s| s.is_name).count()
    }

    /// Number of text surfaces carrying a concrete string-table ref + byte-span
    /// (the patch-back-ready shape).
    pub fn patchable_surface_count(&self) -> usize {
        self.text_surfaces
            .iter()
            .filter(|s| s.is_patchable())
            .count()
    }
}

/// Fatal errors from the flow decoder. Only a malformed scene **header** is
/// fatal (the byte walk is otherwise total); operand-shape and control-flow
/// anomalies become typed statements / diagnostics, never errors.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum SceneFlowError {
    /// The scene failed to partition (malformed header).
    #[error("kaifuu.siglus.flow.partition: {0}")]
    Partition(#[from] SiglusParseError),
}

/// Decode a decompressed Siglus scene payload's statement / flow structure.
///
/// Partitions the scene (via the opcode partitioner), then builds named
/// statements + located text surfaces + the resolved jump table, recognizes
/// choice units, and resolves the expression-evaluator cross-edge underflows
/// via CFG stack-state propagation. The decode is deterministic and
/// panic-free.
pub fn decode_scene_flow(payload: &[u8]) -> Result<SceneFlowDecode, SceneFlowError> {
    let partition = partition_scene(payload)?;
    let tables = SceneTables::parse(payload);

    // The `scn` bytecode section (partition already proved it in bounds).
    let scn_ofs = header_field(payload, 1).max(0) as usize;
    let scn_size = header_field(payload, 2).max(0) as usize;
    let bytecode = payload
        .get(scn_ofs..scn_ofs.saturating_add(scn_size))
        .unwrap_or(&[]);

    let strings = SceneStrings::new(tables.str_list_byte_ofs, tables.str_index.clone());

    let decode =
        statements::build_statements(bytecode, &partition.instructions, &tables.labels, &strings);
    let choice_units =
        statements::recognize_choices(bytecode, &partition.instructions, &tables.labels);
    let underflow = resolve::resolve_underflows(
        bytecode,
        &partition.instructions,
        &tables.labels,
        &tables.scn_cmds,
    );

    Ok(SceneFlowDecode {
        instruction_count: partition.instructions.len(),
        statements: decode.statements,
        text_surfaces: decode.text_surfaces,
        jumps: decode.jumps,
        choice_units,
        underflow,
        family_histogram: decode.family_histogram,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn put_i32(buf: &mut Vec<u8>, value: i32) {
        buf.extend_from_slice(&value.to_le_bytes());
    }

    /// Build a scene payload: header + bytecode + label table + a UTF-16 string
    /// table. `strings` are `(char_offset, char_len)` entries; `str_bytes` is the
    /// string-data section appended after the labels.
    fn build_payload(
        bytecode: &[u8],
        labels: &[i32],
        str_index: &[(i32, i32)],
        str_bytes: &[u8],
    ) -> Vec<u8> {
        let header_len = crate::opcode::SCN_HEADER_BYTE_LEN as i32;
        let scn_ofs = header_len;
        let label_ofs = header_len + bytecode.len() as i32;
        let str_index_ofs = label_ofs + (labels.len() as i32) * 4;
        let str_list_ofs = str_index_ofs + (str_index.len() as i32) * 8;
        let mut payload = Vec::new();
        put_i32(&mut payload, crate::opcode::SCN_HEADER_DECLARED_SIZE); // 0
        put_i32(&mut payload, scn_ofs); // 1
        put_i32(&mut payload, bytecode.len() as i32); // 2
        put_i32(&mut payload, str_index_ofs); // 3 str_index_list_ofs
        put_i32(&mut payload, str_index.len() as i32); // 4 str_index_cnt
        put_i32(&mut payload, str_list_ofs); // 5 str_list_ofs
        put_i32(&mut payload, str_index.len() as i32); // 6 str_cnt
        put_i32(&mut payload, label_ofs); // 7 label_list_ofs
        put_i32(&mut payload, labels.len() as i32); // 8 label_cnt
        for _ in 9..33 {
            put_i32(&mut payload, 0);
        }
        payload.extend_from_slice(bytecode);
        for label in labels {
            put_i32(&mut payload, *label);
        }
        for (offset, size) in str_index {
            put_i32(&mut payload, *offset);
            put_i32(&mut payload, *size);
        }
        payload.extend_from_slice(str_bytes);
        payload
    }

    #[test]
    fn text_surface_carries_string_ref_and_byte_span() {
        // PUSH str#0 ; CD_TEXT read_flag=5 ; EOF. One string of 3 code units.
        let mut bc = vec![0x02];
        put_i32(&mut bc, crate::expression::FM_STR);
        put_i32(&mut bc, 0); // str index 0
        bc.push(0x31); // TEXT
        put_i32(&mut bc, 5); // read_flag
        bc.push(0x16); // EOF
        let str_bytes = vec![0u8; 6]; // 3 UTF-16 code units
        let payload = build_payload(&bc, &[], &[(0, 3)], &str_bytes);
        let decode = decode_scene_flow(&payload).expect("flow decode");
        assert_eq!(decode.text_run_count(), 1);
        let surface = &decode.text_surfaces[0];
        assert_eq!(surface.str_index, Some(0));
        assert_eq!(surface.read_flag, Some(5));
        assert_eq!(surface.str_char_len, Some(3));
        assert!(surface.is_patchable());
        // Byte offset points at the string-data section.
        let expected = crate::opcode::SCN_HEADER_BYTE_LEN + bc.len(); // labels empty
        assert_eq!(surface.str_byte_offset, Some(expected + 8)); // + one 8-byte index entry
        assert_eq!(decode.unknown_family_count(), 0);
    }

    #[test]
    fn goto_resolves_to_target_offset() {
        // GOTO label#0 (-> offset 6) ; NL ; EOF at 6.
        let mut bc = vec![0x10];
        put_i32(&mut bc, 0); // label index 0
        bc.push(0x16); // EOF at offset 5
        bc.push(0x16); // EOF at offset 6
        let payload = build_payload(&bc, &[6], &[], &[]);
        let decode = decode_scene_flow(&payload).expect("flow decode");
        assert_eq!(decode.jumps.len(), 1);
        assert_eq!(decode.jumps[0].kind, SiglusJumpKind::Goto);
        assert_eq!(decode.jumps[0].target_offset, Some(6));
        assert_eq!(decode.family_count("jump"), 1);
    }

    #[test]
    fn deterministic_across_two_runs() {
        let mut bc = vec![0x02];
        put_i32(&mut bc, crate::expression::FM_STR);
        put_i32(&mut bc, 0);
        bc.push(0x32); // NAME
        bc.push(0x16);
        let payload = build_payload(&bc, &[], &[(0, 2)], &[0u8; 4]);
        let a = decode_scene_flow(&payload).expect("run a");
        let b = decode_scene_flow(&payload).expect("run b");
        assert_eq!(a, b);
        assert_eq!(a.name_run_count(), 1);
    }
}
