//! UTSUSHI-203 real-bytes integration test for the AVG32 LZSS + XOR
//! scene decompressor.
//!
//! Pins the decompressor against the Sweetie HD corpus supplied via
//! `ITOTORI_REAL_GAME_ROOT`
//! using the documented decompressed-output values from
//! `RealLive encryption research notes`
//! (outcome A: no second-level XOR for Sukara-branch titles).
//!
//! **Multi-game validation status.** Per the itotori operating model
//! (`docs/orchestration-operating-model.md`), a parser that targets a
//! real engine substrate must be exercised against at least two real
//! corpora before its node is merged-complete. Sweetie HD is the only
//! RealLive title currently staged. UTSUSHI-203 mirrors the pattern
//! its UTSUSHI-201/202 predecessors landed: the node stays `planned`
//! until a second RealLive corpus is sourced and exercised by an
//! additional `decompressor_second_reallive_real_bytes.rs` test.
//!
//! Until the second corpus is staged this test is `#[ignore]`-gated and
//! only runs when `ITOTORI_REAL_GAME_ROOT` is set.

#[path = "support/real_corpus.rs"]
mod real_corpus;

use std::fs;
use std::path::PathBuf;

use utsushi_reallive::{
    AVG32_COMPRESSED_PREAMBLE_LEN, AVG32_XOR_MASK, AvgDecompressor, COMPILER_VERSION_1_10,
    DecompressWarning, RealSceneIndex, SCENE_HEADER_BYTE_LEN, SceneHeader,
};

// Relative path under the Sweetie HD extraction root that holds the
// raw `Seen.txt` envelope.

/// Documented decompressed-output values for Sweetie HD scene #0001.
/// Sourced from `RealLive encryption research notes` §1.
const SWEETIE_HD_SCENE_ONE_BYTECODE_COMPRESSED_SIZE: u32 = 1062;
const SWEETIE_HD_SCENE_ONE_BYTECODE_UNCOMPRESSED_SIZE: u32 = 1660;

/// First 8 bytes of the decompressed bytecode payload for Sweetie HD
/// scene #0001. Sourced verbatim from
/// `RealLive encryption research notes` §1 and
/// re-confirmed by the kaifuu-reallive `probe_scene_1_encryption`
/// example (read-only reference; we do **not** depend on
/// `kaifuu-reallive` for any code path).
const SWEETIE_HD_SCENE_ONE_DECOMPRESSED_FIRST_EIGHT_BYTES: [u8; 8] =
    [0x0a, 0x02, 0x00, 0x0a, 0x03, 0x00, 0x21, 0x00];

#[test]
#[ignore = "real-bytes; requires ITOTORI_REAL_GAME_ROOT env var"]
fn scene1_decompressor_matches_reallive_real_bytes_outcome_a() {
    let Some(seen_path) = real_seen_txt_path() else {
        eprintln!(
            "ITOTORI_REAL_GAME_ROOT unset; skipping Sweetie HD real-bytes test for \
             utsushi-reallive decompressor (no silent pass: re-run with \
             ITOTORI_REAL_GAME_ROOT=/path/to/reallive-game-root)",
        );
        return;
    };

    let bytes = fs::read(&seen_path)
        .unwrap_or_else(|err| panic!("failed to read {}: {err}", seen_path.display()));

    // Walk through the chain UTSUSHI-201 -> UTSUSHI-202 -> UTSUSHI-203.
    // We deliberately route through each typed parser (rather than
    // hard-coding the file offsets) so a regression earlier in the chain
    // surfaces here as a chain-level diagnostic.
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

    let (header, header_warnings) = SceneHeader::parse(blob)
        .expect("Sweetie HD scene 1 must produce a typed SceneHeader (UTSUSHI-202 anchor)");
    assert!(
        header_warnings.is_empty(),
        "Sweetie HD scene 1 uses compiler_version 110002 which is documented; got: \
         {header_warnings:?}",
    );
    assert_eq!(
        header.compiler_version, COMPILER_VERSION_1_10,
        "compiler_version must be 110002 (Sweetie HD is RealLive 1.10)",
    );
    assert_eq!(
        header.bytecode_compressed_size, SWEETIE_HD_SCENE_ONE_BYTECODE_COMPRESSED_SIZE,
        "compressed-size pin (RealLive encryption research notes §1)",
    );
    assert_eq!(
        header.bytecode_uncompressed_size, SWEETIE_HD_SCENE_ONE_BYTECODE_UNCOMPRESSED_SIZE,
        "uncompressed-size pin (RealLive encryption research notes §1)",
    );

    // Slice the compressed bytecode payload out of the scene blob.
    let bytecode_offset = header.bytecode_offset as usize;
    let bytecode_compressed_size = header.bytecode_compressed_size as usize;
    let compressed_end = bytecode_offset
        .checked_add(bytecode_compressed_size)
        .expect("bytecode end must not overflow usize");
    assert!(
        compressed_end <= blob.len(),
        "bytecode_offset + bytecode_compressed_size ({compressed_end}) must fit inside the \
         scene blob ({} bytes)",
        blob.len(),
    );
    let compressed = &blob[bytecode_offset..compressed_end];
    assert_eq!(
        compressed.len(),
        SWEETIE_HD_SCENE_ONE_BYTECODE_COMPRESSED_SIZE as usize,
        "sliced compressed payload must be exactly the documented 1062 bytes",
    );

    // Assertion #4 (run first because it's evidence the slice is correct):
    // the compressed-stream 8-byte preamble XOR'd with `AVG32_XOR_MASK[0..8]`
    // yields the LE u32 pair (1062, 1660). This is the two-step
    // self-consistency check from
    // `RealLive encryption research notes` §4.1.
    let preamble: [u8; AVG32_COMPRESSED_PREAMBLE_LEN] =
        std::array::from_fn(|i| compressed[i] ^ AVG32_XOR_MASK[i]);
    let preamble_lo = u32::from_le_bytes([preamble[0], preamble[1], preamble[2], preamble[3]]);
    let preamble_hi = u32::from_le_bytes([preamble[4], preamble[5], preamble[6], preamble[7]]);
    assert_eq!(
        preamble_lo, SWEETIE_HD_SCENE_ONE_BYTECODE_COMPRESSED_SIZE,
        "preamble[0..4] ^ AVG32_XOR_MASK[0..4] must yield bytecode_compressed_size (1062) — \
         self-consistency check from \
         RealLive encryption research notes §4.1",
    );
    assert_eq!(
        preamble_hi, SWEETIE_HD_SCENE_ONE_BYTECODE_UNCOMPRESSED_SIZE,
        "preamble[4..8] ^ AVG32_XOR_MASK[4..8] must yield bytecode_uncompressed_size (1660) — \
         self-consistency check from \
         RealLive encryption research notes §4.1",
    );

    // Decompress. Outcome A: xor2_key = None for Sukara-branch titles.
    let (decompressed, warnings) = AvgDecompressor::new()
        .decompress(
            compressed,
            header.bytecode_uncompressed_size,
            None,
            header.compiler_version,
        )
        .expect("Sweetie HD scene 1 must decompress cleanly with xor2_key=None (outcome A)");

    // The compiler_version=110002 path with xor2_key=None *intentionally*
    // emits the Xor2NotApplied warning per the alpha-gate "no silent skip"
    // contract. This is the correct, documented choice for Sukara-branch
    // titles — outcome A in
    // RealLive encryption research notes.
    assert_eq!(
        warnings.len(),
        1,
        "exactly one warning expected (xor2_not_applied for compiler 110002 with None key); \
         got: {warnings:?}",
    );
    match &warnings[0] {
        DecompressWarning::Xor2NotApplied { compiler_version } => {
            assert_eq!(
                *compiler_version, COMPILER_VERSION_1_10,
                "warning must carry the observed compiler version (110002)",
            );
        }
    }

    // Assertion #1: output length == 1660.
    assert_eq!(
        decompressed.len(),
        SWEETIE_HD_SCENE_ONE_BYTECODE_UNCOMPRESSED_SIZE as usize,
        "decompressed output must match bytecode_uncompressed_size (1660 bytes)",
    );

    // Assertion #2: first 8 bytes match the documented prefix.
    assert_eq!(
        &decompressed[..8],
        &SWEETIE_HD_SCENE_ONE_DECOMPRESSED_FIRST_EIGHT_BYTES,
        "first 8 bytes of decompressed output must match the documented prefix \
         (RealLive encryption research notes §1): \
         0a 02 00 0a 03 00 21 00",
    );

    // Assertion #3: first byte is in the documented BytecodeElement opener
    // set OR is a printable Shift-JIS lead byte. For Sweetie HD scene #0001
    // we know it's 0x0A (MetaLine), which is in the opener set.
    let first = decompressed[0];
    assert!(
        is_documented_bytecode_opener(first),
        "first byte 0x{first:02x} must be in the documented BytecodeElement opener set \
         {{0x00, 0x0a, 0x21, 0x23, 0x24, 0x2c, 0x40}} or a Shift-JIS lead byte \
         (0x81..=0x9F / 0xE0..=0xFC) — if not, the XOR-2 key choice is wrong (canary).",
    );
}

/// `true` when `byte` is in the documented BytecodeElement opener set
/// (rlvm `bytecode.cc::BytecodeElement::Read`) or is a printable
/// Shift-JIS lead byte. Centralised so the assertion message and the
/// predicate share the same source of truth.
fn is_documented_bytecode_opener(byte: u8) -> bool {
    matches!(byte, 0x00 | 0x0A | 0x21 | 0x23 | 0x24 | 0x2C | 0x40)
        || (0x81..=0x9F).contains(&byte)
        || (0xE0..=0xFC).contains(&byte)
}

fn real_seen_txt_path() -> Option<PathBuf> {
    real_corpus::seen_txt_path()
}
