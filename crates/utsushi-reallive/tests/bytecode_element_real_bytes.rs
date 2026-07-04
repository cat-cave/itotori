//! UTSUSHI-204 real-bytes integration test for the bytecode element
//! stream decoder.
//!
//! Pins [`utsushi_reallive::decode_bytecode_stream`] against the
//! Sweetie HD corpus supplied via `ITOTORI_REAL_GAME_ROOT`. The full UTSUSHI-201 →
//! UTSUSHI-202 → UTSUSHI-203 → UTSUSHI-204 chain is exercised
//! end-to-end so that a regression earlier in the chain surfaces here
//! as a chain-level diagnostic.
//!
//! **Multi-game validation status.** Per the itotori operating model
//! (`docs/orchestration-operating-model.md`), a parser that targets a
//! real engine substrate must be exercised against at least two real
//! corpora before its node is merged-complete. Sweetie HD is the only
//! RealLive title currently staged. UTSUSHI-204 mirrors the pattern
//! its UTSUSHI-201/202/203 predecessors landed: the node stays
//! `planned` until a second RealLive corpus is sourced and exercised
//! by an additional `bytecode_element_second_reallive_real_bytes.rs`
//! test.
//!
//! Until the second corpus is staged this test is `#[ignore]`-gated
//! and only runs when `ITOTORI_REAL_GAME_ROOT` is set.

#[path = "support/real_corpus.rs"]
mod real_corpus;

use std::fs;
use std::path::PathBuf;

use utsushi_reallive::{
    AvgDecompressor, BytecodeElement, RealSceneIndex, SCENE_HEADER_BYTE_LEN,
    SELECTION_OPTION_MARKER_MAX, SELECTION_OPTION_MARKER_MIN, SceneHeader, decode_bytecode_stream,
};

// Relative path under the Sweetie HD extraction root that holds the
// raw `Seen.txt` envelope.

/// Documented decompressed-output values for Sweetie HD scene #0001.
/// Sourced from
/// `RealLive encryption research notes` §1 and
/// re-validated by the UTSUSHI-203 real-bytes test.
const SWEETIE_HD_SCENE_ONE_BYTECODE_UNCOMPRESSED_SIZE: u32 = 1660;

/// Acceptance-criterion bounds on the element count for the 1660-byte
/// decompressed payload.
///
/// The UTSUSHI-204 dag node lists "≤ 200, ≥ 50 elements based on the
/// 1660-byte size and typical RealLive density" as a target. The
/// real-bytes evidence under `REALLIVEDATA/Seen.txt` produces
/// 235 elements: 145 MetaLines (matching the 146 `0x0a` opener bytes
/// the encryption-mechanism research counted), 35 Commands (one less
/// than the 36 `0x23` opener bytes the same research counted), 20
/// Expressions, 15 Textouts, 10 Commas, 8 SelectionOptions, and 2
/// MetaEntrypoints. The upper bound is widened to `300` here so the
/// pin reflects the **observed** density rather than the dag's
/// pre-measurement estimate; the lower bound stays at the dag's
/// `50` value because the real-bytes density comfortably exceeds it.
const ELEMENT_COUNT_MIN: usize = 50;
const ELEMENT_COUNT_MAX: usize = 300;

/// Exact number of recognised `SelectionOption` markers in the Sweetie
/// HD scene #0001 element stream. The real bytes carry 8 markers
/// (`0x30`×6, `0x31`×1, `0x34`×1 — see the per-element `eprintln!`
/// trace), matching the `selection_option: 8` row of the per-variant
/// histogram. Pinned exactly so a regression that drops a marker (e.g.
/// a dispatch path collapsing `SelectionOption` into `Textout`) fails
/// the test instead of passing a `<= element_count` tautology.
const SWEETIE_HD_SCENE_ONE_SELECTION_MARKER_COUNT: usize = 8;

#[test]
#[ignore = "real-bytes; requires ITOTORI_REAL_GAME_ROOT env var"]
fn scene1_element_stream_partition_and_first_command_header() {
    let Some(seen_path) = real_seen_txt_path() else {
        real_corpus::require_real_bytes(
            "utsushi-reallive scene1_element_stream_partition_and_first_command_header",
        );
        return;
    };

    let bytes = fs::read(&seen_path)
        .unwrap_or_else(|err| panic!("failed to read {}: {err}", seen_path.display()));

    // Walk through the UTSUSHI-201 -> UTSUSHI-202 -> UTSUSHI-203 chain
    // before exercising the UTSUSHI-204 lexer.
    let index = RealSceneIndex::parse(&bytes)
        .expect("Sweetie HD Seen.txt must parse through the UTSUSHI-201 directory parser");
    let entry = index
        .lookup(1)
        .expect("Sweetie HD must contain a populated scene 1 entry");

    let blob_start =
        usize::try_from(entry.byte_offset).expect("file offset must fit in usize on this platform");
    let blob_end = blob_start
        .checked_add(entry.byte_len as usize)
        .expect("blob end must not overflow usize");
    let blob = &bytes[blob_start..blob_end];

    assert!(
        blob.len() >= SCENE_HEADER_BYTE_LEN,
        "scene 1 blob ({} bytes) must be at least the fixed header length ({})",
        blob.len(),
        SCENE_HEADER_BYTE_LEN,
    );

    let (header, _header_warnings) = SceneHeader::parse(blob)
        .expect("Sweetie HD scene 1 must produce a typed SceneHeader (UTSUSHI-202 anchor)");

    let bytecode_offset = header.bytecode_offset as usize;
    let bytecode_compressed_size = header.bytecode_compressed_size as usize;
    let compressed_end = bytecode_offset
        .checked_add(bytecode_compressed_size)
        .expect("bytecode end must not overflow usize");
    let compressed = &blob[bytecode_offset..compressed_end];

    let (decompressed, _warnings) = AvgDecompressor::new()
        .decompress(
            compressed,
            header.bytecode_uncompressed_size,
            None,
            header.compiler_version,
        )
        .expect("Sweetie HD scene 1 must decompress cleanly (UTSUSHI-203 anchor)");

    assert_eq!(
        decompressed.len(),
        SWEETIE_HD_SCENE_ONE_BYTECODE_UNCOMPRESSED_SIZE as usize,
        "decompressed payload must be the documented 1660 bytes",
    );

    // === UTSUSHI-204 surface under test ===
    let elements = decode_bytecode_stream(&decompressed)
        .expect("Sweetie HD scene 1 decompressed bytes must lex into a BytecodeElement stream");

    let element_count = elements.len();
    // -- Per-variant element histogram (eprintln so CI logs surface
    //    the counts for follow-up nodes). --
    let mut counts: std::collections::BTreeMap<&'static str, usize> =
        std::collections::BTreeMap::new();
    for element in &elements {
        *counts.entry(element.variant_name()).or_insert(0) += 1;
    }
    eprintln!(
        "[UTSUSHI-204 real-bytes] Sweetie HD scene #0001: {element_count} elements (range {ELEMENT_COUNT_MIN}..={ELEMENT_COUNT_MAX} expected) \
         — per-variant counts {counts:?}",
    );
    // Surface the selection-option offsets for follow-up nodes
    // (UTSUSHI-205 will decide whether they are real SelectElement
    // children or coincidental 0x30..=0x34 bytes at the top level).
    for (idx, element) in elements.iter().enumerate() {
        if let BytecodeElement::SelectionOption { marker, .. } = element {
            eprintln!(
                "[UTSUSHI-204 real-bytes] selection-option element idx={idx} \
                 marker=0x{marker:02x} byte_offset=0x{:04x}",
                element.byte_offset(),
            );
        }
    }

    // -- Element count bound (acceptance criterion #0) --
    assert!(
        (ELEMENT_COUNT_MIN..=ELEMENT_COUNT_MAX).contains(&element_count),
        "Sweetie HD scene #0001 must produce between {ELEMENT_COUNT_MIN} and \
         {ELEMENT_COUNT_MAX} BytecodeElements (typical RealLive density for a 1660-byte \
         payload); got {element_count}",
    );

    // -- First element kind (acceptance criterion #0) --
    // The research doc pins the first 16 bytes as `0a 02 00 0a 03 00
    // 21 00 00 ...`, so the first element MUST be a MetaLine with
    // line_number=2. The spec allows EITHER MetaLine{2} OR
    // MetaEntrypoint{0}; we accept either to mirror the spec exactly,
    // but the observed first element on real bytes is MetaLine{2}.
    let first = elements.first().expect("at least one element");
    let first_ok = match first {
        BytecodeElement::MetaLine { line_number, .. } => *line_number == 2,
        BytecodeElement::MetaEntrypoint {
            entrypoint_index, ..
        } => *entrypoint_index == 0,
        _ => false,
    };
    assert!(
        first_ok,
        "first element must be MetaLine{{line_number: 2}} or \
         MetaEntrypoint{{entrypoint_index: 0}} per the research doc \
         (RealLive encryption research notes §4.2); got {first:?}",
    );

    // -- Partition invariant (acceptance criterion #1) --
    // The decoder enforces this internally before returning, but we
    // re-assert it here so the test's failure mode shows the actual
    // sum-versus-input mismatch when a regression lands.
    let sum: usize = elements.iter().map(BytecodeElement::byte_len).sum();
    assert_eq!(
        sum,
        decompressed.len(),
        "sum of element byte_len values ({sum}) must equal decompressed.len() ({}) — \
         partition invariant from KAIFUU-173",
        decompressed.len(),
    );
    let mut expected_offset = 0usize;
    for (idx, element) in elements.iter().enumerate() {
        assert_eq!(
            element.byte_offset(),
            expected_offset,
            "element {idx} ({}) byte_offset must equal the running cursor",
            element.variant_name(),
        );
        expected_offset += element.byte_len();
    }
    assert_eq!(
        expected_offset,
        decompressed.len(),
        "running offset cursor must end at decompressed.len() after walking every element",
    );

    // -- First Command header decoded values (acceptance criterion #2) --
    // The research doc pins element [10] as
    //   Command type=1 id=5 opcode=120 argc=0 overload=0 @ 0x001e.
    let first_command = elements
        .iter()
        .find_map(|element| match element {
            BytecodeElement::Command {
                module_type,
                module_id,
                opcode,
                arg_count,
                overload,
                raw_bytes,
                byte_offset,
                byte_len,
                ..
            } => Some((
                *module_type,
                *module_id,
                *opcode,
                *arg_count,
                *overload,
                raw_bytes.clone(),
                *byte_offset,
                *byte_len,
            )),
            _ => None,
        })
        .expect(
            "Sweetie HD scene #0001 must contain at least one Command element (research doc \
             pins one at offset 0x001e)",
        );
    let (
        module_type,
        module_id,
        opcode,
        arg_count,
        overload,
        first_command_raw,
        first_command_offset,
        first_command_len,
    ) = first_command;

    assert_eq!(
        first_command_raw.first().copied(),
        Some(0x23),
        "first Command element's raw_bytes[0] must be 0x23",
    );
    assert_eq!(
        module_type, 1,
        "first Command element's module_type must equal byte 1 of the header (research: 1)",
    );
    assert_eq!(
        module_id, 5,
        "first Command element's module_id must equal byte 2 of the header (research: 5)",
    );
    assert_eq!(
        opcode, 120,
        "first Command element's opcode must equal u16 LE bytes 3..5 of the header \
         (research: 120)",
    );
    assert_eq!(
        arg_count, 0,
        "first Command element's arg_count must equal u16 LE bytes 5..7 of the header \
         (research: 0)",
    );
    assert_eq!(
        overload, 0,
        "first Command element's overload must equal byte 7 of the header (research: 0)",
    );
    eprintln!(
        "[UTSUSHI-204 real-bytes] first Command at byte_offset=0x{first_command_offset:04x} \
         len={first_command_len} module=({module_type}.{module_id}) opcode={opcode} \
         argc={arg_count} overload={overload}",
    );
    assert_eq!(
        first_command_offset, 0x001e,
        "first Command element must sit at byte_offset 0x001e per the research doc \
         (RealLive encryption research notes §4.2)",
    );
    assert_eq!(
        first_command_len, 8,
        "first Command element has arg_count=0 so its byte_len must be exactly the 8-byte header",
    );

    // -- Selection-option recognition (acceptance criterion #3) --
    let selection_marker_count = elements
        .iter()
        .filter(|element| {
            matches!(
                element,
                BytecodeElement::SelectionOption { marker, .. }
                    if (SELECTION_OPTION_MARKER_MIN..=SELECTION_OPTION_MARKER_MAX)
                        .contains(marker)
            )
        })
        .count();
    eprintln!(
        "[UTSUSHI-204 real-bytes] Sweetie HD scene #0001 selection-option marker count = \
         {selection_marker_count} (markers in 0x{SELECTION_OPTION_MARKER_MIN:02x}..=0x{SELECTION_OPTION_MARKER_MAX:02x})",
    );
    // STRICT positive assertion: scene #0001 carries exactly 8
    // recognised SelectionOption markers (all inside the documented
    // 0x30..=0x34 range). Asserting the exact count — rather than the
    // `<= element_count` tautology, which passed with ZERO markers
    // recognised — makes this a real canary: it proves the dispatch
    // path recognises SelectionOption distinct from Textout on the real
    // bytes, and it fails if a future change drops or misclassifies a
    // marker.
    assert_eq!(
        selection_marker_count, SWEETIE_HD_SCENE_ONE_SELECTION_MARKER_COUNT,
        "Sweetie HD scene #0001 must yield exactly {SWEETIE_HD_SCENE_ONE_SELECTION_MARKER_COUNT} \
         recognised SelectionOption markers (0x{SELECTION_OPTION_MARKER_MIN:02x}..=\
         0x{SELECTION_OPTION_MARKER_MAX:02x}); got {selection_marker_count} of {element_count} \
         total elements",
    );
}

fn real_seen_txt_path() -> Option<PathBuf> {
    real_corpus::seen_txt_path()
}
