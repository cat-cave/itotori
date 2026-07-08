//! KAIFUU-191 real-bytes integration test for the RealLive opcode
//! dispatch.
//!
//! Reads scene 1 from Sweetie HD's `REALLIVEDATA/Seen.txt` at
//! `$ITOTORI_REAL_GAME_ROOT`, runs the AVG32 LZSS + 256-byte XOR
//! decompression inline (the decompressor is a per-this-node helper —
//! see `examples/probe_scene_1_encryption.rs` for the full probe), then
//! dispatches the plaintext bytecode through the new
//! [`kaifuu_reallive::parse_real_bytecode`].
//!
//! # Scope: a SCENE-1 pin, NOT the full-archive 100% gate
//!
//! This test pins the decode of **Sweetie HD scene 1 only**. It is an
//! honest single-scene regression pin — it asserts that scene 1's known
//! prologue, text/voice structure and byte-framing decode correctly and
//! that scene 1 in particular carries zero un-recognised elements. It does
//! **NOT** prove full-archive / 100% decompilation: that claim is owned
//! solely by `tests/multi_corpus_real_bytes.rs`
//! (`multi_game_validation_runs_against_two_distinct_reallive_corpora`),
//! which asserts the SEMANTIC-zero bar (zero generic `Command`, zero
//! `Unknown`, zero `MalformedExpression`, zero parse-failure) across EVERY
//! populated scene of BOTH full archives (Sweetie HD + Kanon). A single
//! scene being clean says nothing about the other 197 Sweetie / 79 Kanon
//! scenes — only the multi-corpus gate does.
//!
//! # Decompressor provenance
//!
//! The AVG32 LZSS + 256-byte XOR decompressor below is restated in our
//! own words from rlvm's BSD-licensed `compression.cc::Decompress`
//! (Peter Jolly, 2006) and confirmed against Sweetie HD's scene 1 in
//! `docs/research/reallive-sweetie-hd-encryption-mechanism.md` §4. No
//! rlvm source is vendored; the 256-byte mask constant and the LZSS
//! cycle (flag-byte, literal-XOR, back-reference) are documented
//! behavior of a fixed file format.
//!
//! # Scene-1 pin criteria (per KAIFUU-191 deliverable 4)
//!
//! 1. First decoded opcode is in the documented opener set
//!    (`MetaLine(2)` per research doc §D first bytes
//!    `0a 02 00 0a 03 00 21 ...`).
//! 2. The scene contains ≥1 text-display opcode (`TextDisplay` /
//!    `CharacterTextDisplay` / `Textout`), each resolving to a typed
//!    variant. Scene 1 carries zero un-recognised elements (see criterion
//!    4), so no `Unknown` fallback is exercised here.
//! 3. The scene contains ≥1 voice-line reference (`VoicePlay` if
//!    recognised, otherwise the test records the count for diagnostics).
//! 4. Scene 1's own un-recognised-element count is EXACTLY zero — the full
//!    ExpressionPiece evaluator, goto-family pointer handling, and catch-all
//!    Textout partition resolve every byte of THIS scene to a typed element.
//!    This is a scene-1 regression pin, not a full-archive completeness
//!    claim (that is `multi_corpus_real_bytes`' gate).
//!
//! The scene-1 recognition count is reported via `eprintln!` so the
//! orchestration report can quote it directly.

#[path = "support/real_corpus.rs"]
mod real_corpus;

use std::fs;
use std::path::PathBuf;

use kaifuu_reallive::{
    REALLIVE_SEEN_TXT_DIRECTORY_BYTE_LEN, RealLiveOpcode, parse_real_bytecode,
    parse_real_bytecode_spans,
};

#[test]
#[ignore = "real-bytes; requires ITOTORI_REAL_GAME_ROOT env var"]
fn pins_sweetie_hd_scene_1_dispatch_with_zero_unknown_opcodes() {
    let Some(seen_path) = real_seen_txt_path() else {
        real_corpus::require_real_bytes("Sweetie HD scene-1 dispatch test");
        return;
    };

    let bytes = fs::read(&seen_path)
        .unwrap_or_else(|err| panic!("failed to read {}: {err}", seen_path.display()));

    // Resolve scene 1 via the 10,000-slot directory at file offset 0
    // (KAIFUU-188 envelope). Slot 1 lives at file offset 8.
    assert!(
        bytes.len() as u64 >= REALLIVE_SEEN_TXT_DIRECTORY_BYTE_LEN,
        "Seen.txt must be at least {REALLIVE_SEEN_TXT_DIRECTORY_BYTE_LEN} bytes \
         (10,000-slot directory)"
    );
    let slot1_offset = u32::from_le_bytes([bytes[8], bytes[9], bytes[10], bytes[11]]) as usize;
    let slot1_size = u32::from_le_bytes([bytes[12], bytes[13], bytes[14], bytes[15]]) as usize;
    assert_eq!(
        slot1_offset, 0x13880,
        "scene-1 should sit at file offset 0x13880 (immediately after the 80,000-byte directory)"
    );
    assert!(
        slot1_offset + slot1_size <= bytes.len(),
        "scene-1 slot declares (offset=0x{slot1_offset:x}, size=0x{slot1_size:x}) past EOF"
    );
    let blob = &bytes[slot1_offset..slot1_offset + slot1_size];

    // Parse the plaintext scene header (the first 0x1d0 bytes are
    // plaintext per docs/research/reallive-engine.md §D and
    // docs/research/reallive-sweetie-hd-encryption-mechanism.md §2).
    let header_size = u32::from_le_bytes([blob[0], blob[1], blob[2], blob[3]]);
    let compiler_version = u32::from_le_bytes([blob[4], blob[5], blob[6], blob[7]]);
    let bytecode_offset =
        u32::from_le_bytes([blob[0x20], blob[0x21], blob[0x22], blob[0x23]]) as usize;
    let bytecode_uncompressed =
        u32::from_le_bytes([blob[0x24], blob[0x25], blob[0x26], blob[0x27]]) as usize;
    let bytecode_compressed =
        u32::from_le_bytes([blob[0x28], blob[0x29], blob[0x2a], blob[0x2b]]) as usize;
    assert_eq!(header_size, 0x1d0, "scene header size must be 0x1d0");
    assert_eq!(
        compiler_version, 110002,
        "Sweetie HD scene 1 must report compiler version 110002"
    );
    assert_eq!(
        bytecode_uncompressed, 1660,
        "Sweetie HD scene 1 uncompressed size must be 1660 bytes"
    );
    assert_eq!(
        bytecode_compressed, 1062,
        "Sweetie HD scene 1 compressed size must be 1062 bytes"
    );

    // Decompress: AVG32 LZSS + 256-byte XOR first-level transform.
    // Sukara-branch titles (Sweetie HD) do NOT apply a second-level XOR
    // (outcome A in docs/research/reallive-sweetie-hd-encryption-mechanism.md).
    let compressed = &blob[bytecode_offset..bytecode_offset + bytecode_compressed];
    let decompressed = decompress_avg32(compressed, bytecode_uncompressed)
        .unwrap_or_else(|err| panic!("decompress failed: {err}"));
    assert_eq!(
        decompressed.len(),
        bytecode_uncompressed,
        "decompressor must produce exactly bytecode_uncompressed_size bytes"
    );
    // The first 16 bytes of the decompressed stream are documented as
    // `0a 02 00 0a 03 00 21 00 00 0a 04 00 0a 05 00 0a` —
    // MetaLine(2), MetaLine(3), MetaEntrypoint(0), MetaLine(4..7).
    assert_eq!(
        &decompressed[..16],
        &[
            0x0a, 0x02, 0x00, 0x0a, 0x03, 0x00, 0x21, 0x00, 0x00, 0x0a, 0x04, 0x00, 0x0a, 0x05,
            0x00, 0x0a,
        ],
        "decompressed[0..16] must match the documented scene-1 prologue"
    );

    // Dispatch to the new opcode parser.
    let opcodes = parse_real_bytecode(&decompressed)
        .expect("real bytecode must decode under the KAIFUU-191 parser");

    assert!(
        !opcodes.is_empty(),
        "real bytecode decoded but produced no opcodes (silent zero-state)"
    );

    // ---- Acceptance 1: first opcode in the documented set. ----
    assert!(
        matches!(opcodes[0], RealLiveOpcode::MetaLine { line: 2 }),
        "first decoded opcode must be MetaLine(2) per research doc §D; got {:?}",
        opcodes[0]
    );
    assert!(
        matches!(opcodes[1], RealLiveOpcode::MetaLine { line: 3 }),
        "second decoded opcode must be MetaLine(3); got {:?}",
        opcodes[1]
    );
    assert!(
        matches!(opcodes[2], RealLiveOpcode::MetaEntrypoint { entrypoint: 0 }),
        "third decoded opcode must be MetaEntrypoint(0); got {:?}",
        opcodes[2]
    );

    // ---- Acceptance 2: ≥1 TextDisplay (or labelled Unknown). ----
    let text_displays = opcodes
        .iter()
        .filter(|op| matches!(op, RealLiveOpcode::TextDisplay { .. }))
        .count();
    let character_text_displays = opcodes
        .iter()
        .filter(|op| matches!(op, RealLiveOpcode::CharacterTextDisplay))
        .count();
    let textouts = opcodes
        .iter()
        .filter(|op| matches!(op, RealLiveOpcode::Textout { .. }))
        .count();
    let text_total = text_displays + character_text_displays + textouts;
    assert!(
        text_total >= 1,
        "scene must contain at least one text-display opcode (TextDisplay / \
         CharacterTextDisplay / Textout); got {text_total} (text_displays={text_displays}, \
         character_text_displays={character_text_displays}, textouts={textouts})"
    );

    // ---- Acceptance 3: ≥1 voice-line reference (best-effort). ----
    let voice_play_count = opcodes
        .iter()
        .filter(|op| matches!(op, RealLiveOpcode::VoicePlay { .. }))
        .count();
    // The exact opcode catalogue for Sweetie HD scene 1 may not include
    // a recognised VoicePlay (the scene 1 prologue is largely meta +
    // text). Per the spec we record the count rather than fail
    // outright; the strict zero-unknown pin below catches any general
    // dispatch regression.
    if voice_play_count == 0 {
        eprintln!(
            "scene 1 produced no VoicePlay opcodes — recording as a follow-up data \
             point; the strict zero-unknown pin below is the harder check"
        );
    }

    // ---- Scene-1 pin: this scene's own un-recognised-element count. ----
    let total = opcodes.len();
    let unknown = opcodes.iter().filter(|op| !op.is_recognized()).count();
    let recognized = total - unknown;
    let recognition_rate = (recognized as f64) / (total as f64);
    eprintln!(
        "KAIFUU-191 Sweetie HD scene-1 opcode dispatch: total_opcodes={total} \
         recognized={recognized} unknown={unknown} recognition_rate={:.2}%",
        recognition_rate * 100.0,
    );
    // Per-variant histogram for the orchestration report.
    let mut counts: std::collections::BTreeMap<&'static str, usize> =
        std::collections::BTreeMap::new();
    for op in &opcodes {
        *counts.entry(op.label()).or_insert(0) += 1;
    }
    for (label, count) in &counts {
        eprintln!("  {label}: {count}");
    }
    // Diagnostic: enumerate Unknown command (module_type, module_id,
    // opcode_u16) tuples so the follow-up node can widen the
    // recognised module catalogue under explicit RLDEV / rlvm
    // citations.
    let mut unknown_command_signatures: std::collections::BTreeMap<(u8, u8, u16), usize> =
        std::collections::BTreeMap::new();
    for op in &opcodes {
        if let RealLiveOpcode::Unknown {
            opcode: 0x23,
            raw_bytes,
        } = op
            && raw_bytes.len() >= 8
        {
            let module_type = raw_bytes[1];
            let module_id = raw_bytes[2];
            let opcode_u16 = u16::from_le_bytes([raw_bytes[3], raw_bytes[4]]);
            *unknown_command_signatures
                .entry((module_type, module_id, opcode_u16))
                .or_insert(0) += 1;
        }
    }
    if !unknown_command_signatures.is_empty() {
        eprintln!("Unknown command (module_type, module_id, opcode) signatures -> count:");
        for ((module_type, module_id, opcode), count) in &unknown_command_signatures {
            eprintln!("  ({module_type:>3}, {module_id:>3}, {opcode:>5}): {count}");
        }
    }
    eprintln!("Unknown command signatures (module_type, module_id, opcode) -> count:");
    for ((module_type, module_id, opcode), count) in &unknown_command_signatures {
        eprintln!("  ({module_type:>3}, {module_id:>3}, {opcode:>5}): {count}");
    }
    // Scene-1 regression pin: the full ExpressionPiece evaluator +
    // goto-family pointer handling + catch-all Textout partition resolve
    // EVERY byte of real Sweetie HD scene 1 into a typed BytecodeElement, so
    // scene 1 carries zero un-recognised elements. This pins scene 1 only;
    // it is NOT a full-archive completeness claim — the SEMANTIC-zero bar
    // across every scene of both full archives is asserted solely by
    // `multi_corpus_real_bytes`.
    assert_eq!(
        unknown,
        0,
        "scene-1 pin: every byte of Sweetie HD scene 1 must resolve to a typed \
         BytecodeElement (recognized={recognized}, unknown={unknown}, total={total}, \
         scene_1_recognition_rate={:.2}%)",
        recognition_rate * 100.0
    );
}

fn real_seen_txt_path() -> Option<PathBuf> {
    real_corpus::seen_txt_path()
}

/// Resolve scene 1 from the real `Seen.txt` and run the AVG32 LZSS + XOR
/// decompression, returning the plaintext bytecode stream — the same
/// derivation the dispatch test above performs, factored out so the
/// framing-offset pin can re-walk the identical bytes.
fn decompressed_scene_1(seen_path: &PathBuf) -> Vec<u8> {
    let bytes = fs::read(seen_path)
        .unwrap_or_else(|err| panic!("failed to read {}: {err}", seen_path.display()));
    let slot1_offset = u32::from_le_bytes([bytes[8], bytes[9], bytes[10], bytes[11]]) as usize;
    let slot1_size = u32::from_le_bytes([bytes[12], bytes[13], bytes[14], bytes[15]]) as usize;
    let blob = &bytes[slot1_offset..slot1_offset + slot1_size];
    let bytecode_offset =
        u32::from_le_bytes([blob[0x20], blob[0x21], blob[0x22], blob[0x23]]) as usize;
    let bytecode_uncompressed =
        u32::from_le_bytes([blob[0x24], blob[0x25], blob[0x26], blob[0x27]]) as usize;
    let bytecode_compressed =
        u32::from_le_bytes([blob[0x28], blob[0x29], blob[0x2a], blob[0x2b]]) as usize;
    let compressed = &blob[bytecode_offset..bytecode_offset + bytecode_compressed];
    decompress_avg32(compressed, bytecode_uncompressed)
        .unwrap_or_else(|err| panic!("decompress failed: {err}"))
}

/// Pin the exact arg/expression byte-framing of real Sweetie HD scene 1.
///
/// # Why this test exists (the regression it guards)
///
/// `decode_command` / `parse_arg_list` once treated raw `0x29` (`)`) and
/// `0x2C` (`,`) bytes as structural arg-list delimiters even when they
/// were the payload of a `0xFF`-introduced i32 literal or sat inside a
/// parenthesised sub-expression. A legal expression byte equal to a
/// delimiter would close the arg list early, mis-set the consumed width,
/// and desync the cursor for the rest of the stream — inflating the
/// Unknown count and corrupting the byte offsets the patch-back re-walk
/// depends on. The current decoder drives every arg/expression span off
/// the real [`kaifuu_reallive::parse_expression`] evaluator (the single
/// source of truth that [`parse_real_bytecode_spans`] exposes), so a
/// delimiter-valued literal byte is consumed whole.
///
/// The mechanism has a synthetic unit pin
/// (`command_arglist_int_literal_payload_with_delimiter_bytes_does_not_misterminate`
/// in `opcode.rs`). This test is the **real-bytes** pin the audit asked
/// for: it asserts the exact byte offset + width of every variable-width,
/// arg/expression-framed element of scene 1, plus contiguous tiling of the
/// whole 1660-byte stream. Any framing change — a re-introduced delimiter
/// scan, a wrong expression width, a dropped goto pointer — shifts these
/// offsets and turns the test red, instead of silently re-flowing the
/// stream.
///
/// The pinned numbers are structural metadata (offsets / widths / element
/// labels), not game content; regenerate them only when the decoder's
/// framing legitimately changes.
#[test]
#[ignore = "real-bytes; requires ITOTORI_REAL_GAME_ROOT env var"]
fn scene_1_arg_expression_framing_offsets_are_pinned_byte_exact() {
    let Some(seen_path) = real_seen_txt_path() else {
        real_corpus::require_real_bytes("Sweetie HD scene-1 framing-offset pin");
        return;
    };
    let decompressed = decompressed_scene_1(&seen_path);

    let spans = parse_real_bytecode_spans(&decompressed)
        .expect("real scene-1 bytecode must decode under the spans walker");

    // ---- Invariant 1: the spans tile [0, len) exactly, contiguously. ----
    // A desync that double-counts or skips bytes breaks this before any
    // golden comparison.
    let mut offset = 0usize;
    for (idx, (_op, width)) in spans.iter().enumerate() {
        assert!(
            *width > 0,
            "element #{idx} at offset {offset} consumed zero bytes (framing would spin/desync)"
        );
        offset += *width;
    }
    assert_eq!(
        offset,
        decompressed.len(),
        "decoded element widths must tile the whole {}-byte scene with no gap/overlap; \
         summed to {offset}",
        decompressed.len()
    );
    assert_eq!(
        spans.len(),
        210,
        "scene-1 must decode to exactly 210 elements; a desync changes this count"
    );

    // ---- Invariant 2: the exact (offset, label, width) of every ----
    // variable-width, arg/expression-framed element. Fixed-width 3-byte
    // meta lines and 1-byte commas are covered by the tiling invariant
    // above; the entries below are the commands (with bracketed arg
    // lists / trailing goto pointers) and Expression elements whose spans
    // are computed by the ExpressionPiece evaluator — i.e. exactly the
    // framing the audit finding is about.
    //
    // Labels reflect the SEMANTIC command catalogue
    // (`reallive-semantic-command-cataloguing`): every in-space command maps
    // to a named operation family keyed on its `module_id`, never a generic
    // `"command"` blob. The element at offset 30 is module (type=1, id=5,
    // opcode=120) — a `module_sys`-class control op per
    // `docs/research/reallive-sweetie-hd-encryption-mechanism.md` §4.2, so it
    // is `"system_control"`; offset 201 is a `module_msg` window directive
    // (`"message_control"`); the 8/16/22-byte `module_sys` ops previously
    // shown as the generic `"command"` are now `"system_control"`. The
    // byte-framing (offset + width) is **byte-identical** to the prior pin —
    // only the label is upgraded from a blob to a semantic family, which is
    // exactly what the semantic-cataloguing node delivers.
    let golden: &[(usize, &str, usize)] = &[
        (6, "meta_entrypoint", 3),
        (30, "system_control", 8),
        (38, "expression", 14),
        (193, "system_control", 8),
        (201, "message_control", 8),
        (209, "system_control", 8),
        (217, "system_control", 8),
        (225, "system_control", 8),
        (233, "system_control", 8),
        (241, "system_control", 8),
        (249, "system_control", 8),
        (257, "meta_entrypoint", 3),
        (260, "textout", 22),
        (283, "textout", 15),
        (299, "textout", 214),
        (517, "expression", 18),
        (544, "system_control", 16),
        (566, "background", 22),
        (591, "background", 22),
        (619, "system_control", 8),
        (630, "system_control", 16),
        (652, "branch", 32),
        (687, "expression", 18),
        (711, "expression", 18),
        (735, "expression", 18),
        (756, "expression", 18),
        (777, "expression", 18),
        (798, "expression", 18),
        (819, "expression", 18),
        (840, "expression", 18),
        (861, "expression", 18),
        (885, "expression", 18),
        (906, "expression", 18),
        (930, "call", 16),
        (958, "expression", 18),
        (982, "expression", 18),
        (1006, "expression", 18),
        (1027, "expression", 18),
        (1048, "expression", 18),
        (1069, "expression", 18),
        (1096, "system_control", 16),
        (1121, "background", 22),
        (1158, "system_control", 22),
        (1180, "expression", 14),
        (1197, "branch", 32),
        (1232, "background", 24),
        (1262, "voice_play", 22),
        (1290, "voice_play", 8),
        (1304, "background", 24),
        (1334, "voice_play", 22),
        (1362, "voice_play", 8),
        (1373, "goto", 12),
        (1397, "background", 26),
        (1429, "voice_play", 22),
        (1457, "voice_play", 8),
        (1471, "background", 26),
        (1503, "voice_play", 22),
        (1531, "voice_play", 8),
        (1551, "background", 22),
        (1588, "call", 16),
        (1613, "textout", 46),
    ];

    // Build the observed (offset, label, width) manifest for the same
    // element classes the golden set covers.
    let mut observed: Vec<(usize, &'static str, usize)> = Vec::new();
    let mut pos = 0usize;
    for (op, width) in &spans {
        let label = op.label();
        if label != "meta_line" && label != "comma" {
            observed.push((pos, label, *width));
        }
        pos += *width;
    }

    assert_eq!(
        observed.len(),
        golden.len(),
        "count of arg/expression-framed elements changed: observed {} vs pinned {}",
        observed.len(),
        golden.len()
    );
    for (i, (got, want)) in observed.iter().zip(golden.iter()).enumerate() {
        assert_eq!(
            (got.0, got.1, got.2),
            (want.0, want.1, want.2),
            "framing desync at element #{i}: decoded {got:?} but pinned {want:?} — \
             arg/expression byte-framing changed (a legal expression byte may again be \
             treated as a structural delimiter)"
        );
    }

    // ---- Invariant 3: still 100% recognised (no Unknown bucket). ----
    let unknown = spans.iter().filter(|(op, _)| !op.is_recognized()).count();
    assert_eq!(
        unknown, 0,
        "framing pin must coincide with 100% recognition; got {unknown} Unknown elements"
    );
}

/// AVG32 256-byte XOR mask applied to the LZSS compressed stream.
///
/// Restated in our own words from rlvm's BSD-licensed
/// `compression.cc::xor_mask[256]` constant (Peter Jolly, 2006). The
/// 256-byte table is a documented constant of the AVG32 format used by
/// every RealLive title since 1.10; no rlvm source is vendored.
const AVG32_XOR_MASK: [u8; 256] = [
    0x8b, 0xe5, 0x5d, 0xc3, 0xa1, 0xe0, 0x30, 0x44, 0x00, 0x85, 0xc0, 0x74, 0x09, 0x5f, 0x5e, 0x33,
    0xc0, 0x5b, 0x8b, 0xe5, 0x5d, 0xc3, 0x8b, 0x45, 0x0c, 0x85, 0xc0, 0x75, 0x14, 0x8b, 0x55, 0xec,
    0x83, 0xc2, 0x20, 0x52, 0x6a, 0x00, 0xe8, 0xf5, 0x28, 0x01, 0x00, 0x83, 0xc4, 0x08, 0x89, 0x45,
    0x0c, 0x8b, 0x45, 0xe4, 0x6a, 0x00, 0x6a, 0x00, 0x50, 0x53, 0xff, 0x15, 0x34, 0xb1, 0x43, 0x00,
    0x8b, 0x45, 0x10, 0x85, 0xc0, 0x74, 0x05, 0x8b, 0x4d, 0xec, 0x89, 0x08, 0x8a, 0x45, 0xf0, 0x84,
    0xc0, 0x75, 0x78, 0xa1, 0xe0, 0x30, 0x44, 0x00, 0x8b, 0x7d, 0xe8, 0x8b, 0x75, 0x0c, 0x85, 0xc0,
    0x75, 0x44, 0x8b, 0x1d, 0xd0, 0xb0, 0x43, 0x00, 0x85, 0xff, 0x76, 0x37, 0x81, 0xff, 0x00, 0x00,
    0x04, 0x00, 0x6a, 0x00, 0x76, 0x43, 0x8b, 0x45, 0xf8, 0x8d, 0x55, 0xfc, 0x52, 0x68, 0x00, 0x00,
    0x04, 0x00, 0x56, 0x50, 0xff, 0x15, 0x2c, 0xb1, 0x43, 0x00, 0x6a, 0x05, 0xff, 0xd3, 0xa1, 0xe0,
    0x30, 0x44, 0x00, 0x81, 0xef, 0x00, 0x00, 0x04, 0x00, 0x81, 0xc6, 0x00, 0x00, 0x04, 0x00, 0x85,
    0xc0, 0x74, 0xc5, 0x8b, 0x5d, 0xf8, 0x53, 0xe8, 0xf4, 0xfb, 0xff, 0xff, 0x8b, 0x45, 0x0c, 0x83,
    0xc4, 0x04, 0x5f, 0x5e, 0x5b, 0x8b, 0xe5, 0x5d, 0xc3, 0x8b, 0x55, 0xf8, 0x8d, 0x4d, 0xfc, 0x51,
    0x57, 0x56, 0x52, 0xff, 0x15, 0x2c, 0xb1, 0x43, 0x00, 0xeb, 0xd8, 0x8b, 0x45, 0xe8, 0x83, 0xc0,
    0x20, 0x50, 0x6a, 0x00, 0xe8, 0x47, 0x28, 0x01, 0x00, 0x8b, 0x7d, 0xe8, 0x89, 0x45, 0xf4, 0x8b,
    0xf0, 0xa1, 0xe0, 0x30, 0x44, 0x00, 0x83, 0xc4, 0x08, 0x85, 0xc0, 0x75, 0x56, 0x8b, 0x1d, 0xd0,
    0xb0, 0x43, 0x00, 0x85, 0xff, 0x76, 0x49, 0x81, 0xff, 0x00, 0x00, 0x04, 0x00, 0x6a, 0x00, 0x76,
];

/// rlvm-shape LZSS+XOR decompressor restated in our own words from
/// `libreallive::compression::Decompress` (BSD 2006, Peter Jolly). Does
/// **not** apply the per-game second-level XOR — Sukara-branch titles
/// (Sweetie HD) do not need it (outcome A in
/// `docs/research/reallive-sweetie-hd-encryption-mechanism.md`).
fn decompress_avg32(src: &[u8], dst_len: usize) -> Result<Vec<u8>, String> {
    let mut dst: Vec<u8> = Vec::with_capacity(dst_len);
    let mut src_pos: usize = 8; // skip 8-byte preamble
    let mut mask_idx: u8 = 8;
    let mut bit: u32 = 1;

    if src_pos >= src.len() {
        return Err(format!("src exhausted at preamble: src_len={}", src.len()));
    }
    let mut flag = src[src_pos] ^ AVG32_XOR_MASK[mask_idx as usize];
    src_pos += 1;
    mask_idx = mask_idx.wrapping_add(1);

    while src_pos < src.len() && dst.len() < dst_len {
        if bit == 256 {
            bit = 1;
            if src_pos >= src.len() {
                break;
            }
            flag = src[src_pos] ^ AVG32_XOR_MASK[mask_idx as usize];
            src_pos += 1;
            mask_idx = mask_idx.wrapping_add(1);
        }
        if (flag as u32) & bit != 0 {
            // Literal byte.
            if src_pos >= src.len() {
                break;
            }
            let b = src[src_pos] ^ AVG32_XOR_MASK[mask_idx as usize];
            src_pos += 1;
            mask_idx = mask_idx.wrapping_add(1);
            dst.push(b);
        } else {
            // Back-reference: 2 bytes -> u16 LE.
            if src_pos + 1 >= src.len() {
                break;
            }
            let lo = src[src_pos] ^ AVG32_XOR_MASK[mask_idx as usize];
            src_pos += 1;
            mask_idx = mask_idx.wrapping_add(1);
            let hi = src[src_pos] ^ AVG32_XOR_MASK[mask_idx as usize];
            src_pos += 1;
            mask_idx = mask_idx.wrapping_add(1);
            let count = (lo as u32) | ((hi as u32) << 8);
            let back = (count >> 4) as usize;
            let run = ((count & 0x0f) as usize) + 2;
            if back == 0 || back > dst.len() {
                return Err(format!(
                    "back-ref out of range at src_pos={src_pos} dst.len()={} back={back} run={run}",
                    dst.len()
                ));
            }
            let start = dst.len() - back;
            for i in 0..run {
                if dst.len() >= dst_len {
                    break;
                }
                let byte = dst[start + i];
                dst.push(byte);
            }
        }
        bit <<= 1;
    }

    Ok(dst)
}
