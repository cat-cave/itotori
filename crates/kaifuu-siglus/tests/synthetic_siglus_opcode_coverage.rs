//! `synthetic-fixture-author-feature-complete-archives` (P2) — Siglus.
//! The Siglus scene-bytecode opcode catalogue is the structural set of `CD_*`
//! command codes the partitioner ([`partition_scene`]) classifies, plus the
//! `Unknown` catch-all. This test drives a hand-built synthetic scene — carrying
//! one instance of EVERY catalogued opcode plus an unclassifiable lead byte —
//! through the REAL partitioner and asserts the synthetic corpus instantiates
//! 100% of the manifest's opcode component group. Operand *semantics* are
//! decoded downstream; here we prove structural coverage of the whole catalogue.

use std::collections::BTreeSet;
use std::path::PathBuf;

use kaifuu_siglus::{SCN_HEADER_BYTE_LEN, SCN_HEADER_DECLARED_SIZE, SiglusOpcode, partition_scene};
use serde_json::Value;

fn test_manifest_dir() -> PathBuf {
    std::env::var_os("CARGO_MANIFEST_DIR")
        .map_or_else(|| PathBuf::from(env!("CARGO_MANIFEST_DIR")), PathBuf::from)
}

fn manifest_value() -> Value {
    let path = test_manifest_dir().join("../../fixtures/synthetic/coverage-manifest.v0.json");
    let bytes = std::fs::read(&path)
        .unwrap_or_else(|err| panic!("read coverage manifest {}: {err}", path.display()));
    serde_json::from_slice(&bytes).expect("coverage manifest is valid JSON")
}

fn put_i32(buf: &mut Vec<u8>, value: i32) {
    buf.extend_from_slice(&value.to_le_bytes());
}

/// Append one instruction (lead + `operand_len` zero operand bytes) and record
/// its start offset so the caller can register it as a label anchor.
fn emit(bytecode: &mut Vec<u8>, starts: &mut Vec<i32>, lead: u8, operand_len: usize) {
    starts.push(bytecode.len() as i32);
    bytecode.push(lead);
    bytecode.extend(std::iter::repeat_n(0u8, operand_len));
}

/// Build a well-formed scene payload wrapping `bytecode`, with `labels` as the
/// label table (every instruction start → a guaranteed boundary anchor).
fn build_payload(bytecode: &[u8], labels: &[i32]) -> Vec<u8> {
    let header_len = SCN_HEADER_BYTE_LEN as i32;
    let mut header = Vec::new();
    put_i32(&mut header, SCN_HEADER_DECLARED_SIZE); // 0 header_size
    put_i32(&mut header, header_len); // 1 scn_ofs
    put_i32(&mut header, bytecode.len() as i32); // 2 scn_size
    put_i32(&mut header, 0); // 3 str_index_list_ofs
    put_i32(&mut header, 0); // 4 str_index_cnt
    put_i32(&mut header, 0); // 5 str_list_ofs
    put_i32(&mut header, 0); // 6 str_cnt
    put_i32(&mut header, header_len + bytecode.len() as i32); // 7 label_list_ofs
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

/// Stable component name for a classified opcode (mirrors the manifest's
/// `SiglusOpcode` variant names).
fn component_name(opcode: &SiglusOpcode) -> &'static str {
    match opcode {
        SiglusOpcode::Nl => "Nl",
        SiglusOpcode::Push => "Push",
        SiglusOpcode::Pop => "Pop",
        SiglusOpcode::Copy => "Copy",
        SiglusOpcode::Property => "Property",
        SiglusOpcode::CopyElm => "CopyElm",
        SiglusOpcode::DecProp => "DecProp",
        SiglusOpcode::ElmPoint => "ElmPoint",
        SiglusOpcode::Arg => "Arg",
        SiglusOpcode::Goto => "Goto",
        SiglusOpcode::GotoTrue => "GotoTrue",
        SiglusOpcode::GotoFalse => "GotoFalse",
        SiglusOpcode::Gosub => "Gosub",
        SiglusOpcode::GosubStr => "GosubStr",
        SiglusOpcode::Return => "Return",
        SiglusOpcode::Eof => "Eof",
        SiglusOpcode::Assign => "Assign",
        SiglusOpcode::Operate1 => "Operate1",
        SiglusOpcode::Operate2 => "Operate2",
        SiglusOpcode::Command { .. } => "Command",
        SiglusOpcode::Text => "Text",
        SiglusOpcode::Name => "Name",
        SiglusOpcode::SelBlockStart => "SelBlockStart",
        SiglusOpcode::SelBlockEnd => "SelBlockEnd",
        SiglusOpcode::Unknown { .. } => "Unknown",
        _ => "??",
    }
}

/// (lead byte, zero-operand-byte count) for one instance of each catalogued
/// command code. Widths match the partitioner's operand model; `0x02` uses the
/// void push form (no trailing literal) and `0x30` uses an empty arg list with
/// no named args and no read-flag tail.
const CATALOGUE: &[(u8, usize)] = &[
    (0x01, 4),
    (0x02, 4),
    (0x03, 4),
    (0x04, 4),
    (0x05, 0),
    (0x06, 0),
    (0x07, 8),
    (0x08, 0),
    (0x09, 0),
    (0x10, 4),
    (0x11, 4),
    (0x12, 4),
    (0x13, 8),
    (0x14, 8),
    (0x15, 4),
    (0x16, 0),
    (0x20, 12),
    (0x21, 5),
    (0x22, 9),
    (0x30, 16),
    (0x31, 4),
    (0x32, 0),
    (0x33, 0),
    (0x34, 0),
];

#[test]
fn synthetic_corpus_instantiates_every_siglus_opcode() {
    let manifest = manifest_value();
    let components: BTreeSet<String> =
        manifest["engineFamilies"]["siglus"]["componentGroups"]["opcode"]["components"]
            .as_array()
            .expect("siglus opcode components array")
            .iter()
            .map(|value| value.as_str().expect("component is a string").to_string())
            .collect();
    assert_eq!(
        components.len(),
        25,
        "the Siglus catalogue is the 24 CD_* opcodes plus the Unknown catch-all"
    );
    assert!(components.contains("Command"));
    assert!(components.contains("Unknown"));

    // Build one synthetic scene carrying every catalogued opcode, each fronted
    // by a label anchor, then a trailing unclassifiable lead byte (0xAA).
    let mut bytecode = Vec::new();
    let mut starts = Vec::new();
    for &(lead, operand_len) in CATALOGUE {
        emit(&mut bytecode, &mut starts, lead, operand_len);
    }
    // Unknown span, then a final EOF so it partitions cleanly around it.
    starts.push(bytecode.len() as i32);
    bytecode.push(0xAA);
    emit(&mut bytecode, &mut starts, 0x16, 0);

    let payload = build_payload(&bytecode, &starts);
    let part = partition_scene(&payload).expect("synthetic scene partitions");
    assert!(
        part.anchors_aligned,
        "every anchor is an instruction boundary"
    );
    assert_eq!(part.histogram.unknown_count, 1, "exactly one Unknown span");
    assert_eq!(part.histogram.unknown_lead_counts.get("aa"), Some(&1));

    // Every manifest component must be instantiated through the REAL partitioner.
    let observed: BTreeSet<String> = part
        .instructions
        .iter()
        .map(|instruction| component_name(&instruction.opcode).to_string())
        .collect();
    let missing: Vec<&String> = components.difference(&observed).collect();
    assert!(
        missing.is_empty(),
        "synthetic corpus must instantiate 100% of the manifest opcode catalogue; missing {missing:?}"
    );
}
