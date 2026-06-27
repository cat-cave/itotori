//! UTSUSHI-202 real-bytes integration test for the `utsushi-reallive`
//! 0x1d0-byte scene header decoder.
//!
//! Pins the typed header parser against the Sweetie HD corpus supplied
//! via `ITOTORI_REAL_GAME_ROOT`
//! using the documented field values from
//! `docs/research/reallive-engine.md` §D plus the directory offsets
//! confirmed by UTSUSHI-201's
//! `tests/scene_index_real_bytes.rs`.
//!
//! **Multi-game validation status.** Per the itotori operating model
//! (`docs/orchestration-operating-model.md`), a parser that targets a
//! real engine substrate must be exercised against at least two real
//! corpora before its node is merged-complete. The MV/MZ and KAG
//! corpora are different engines and do not carry a `Seen.txt`.
//! `utsushi-reallive` is therefore in the same single-RealLive-corpus
//! position as `kaifuu-reallive` was for KAIFUU-188 and as
//! `utsushi-reallive` was for UTSUSHI-201: Sweetie HD is the only
//! RealLive title currently staged. UTSUSHI-202 mirrors that pattern —
//! the node stays `planned` until a second RealLive corpus is sourced
//! and exercised by an additional
//! `scene_header_second_reallive_real_bytes.rs` test. The orchestrator
//! must not approve completion until that happens.
//!
//! Until the second corpus is staged this test is `#[ignore]`-gated and
//! only runs when `ITOTORI_REAL_GAME_ROOT` is set (the same env
//! var KAIFUU-188 and UTSUSHI-201 use, so a single export drives every
//! real-bytes integration test in the workspace).

#[path = "support/real_corpus.rs"]
mod real_corpus;

use std::fs;
use std::path::PathBuf;

use utsushi_reallive::{
    COMPILER_VERSION_1_10, ENTRYPOINT_TABLE_LEN, RealSceneIndex, SCENE_HEADER_BYTE_LEN, SceneHeader,
};

// Relative path under the Sweetie HD extraction root that holds the
// raw `Seen.txt` envelope.

/// Sweetie HD scene #0001 file-offset pin. Verified by UTSUSHI-201's
/// integration test. The scene blob starts here in the `Seen.txt`
/// envelope.
const SWEETIE_HD_SCENE_ONE_FILE_OFFSET: u64 = 0x13880;

/// Scene-blob byte length for Sweetie HD scene #0001. Verified by
/// UTSUSHI-201's integration test.
const SWEETIE_HD_SCENE_ONE_BLOB_LEN: u32 = 0x5fa;

/// Documented scene-header field values for Sweetie HD scene #0001,
/// drawn from `docs/research/reallive-engine.md` §D.
const SWEETIE_HD_SCENE_ONE_COMPILER_VERSION: u32 = 110002;
const SWEETIE_HD_SCENE_ONE_KIDOKU_OFFSET: u32 = 464;
const SWEETIE_HD_SCENE_ONE_KIDOKU_COUNT: u32 = 1;
const SWEETIE_HD_SCENE_ONE_DRAMATIS_OFFSET: u32 = 468;
const SWEETIE_HD_SCENE_ONE_DRAMATIS_COUNT: u32 = 0;
const SWEETIE_HD_SCENE_ONE_BYTECODE_OFFSET: u32 = 468;
const SWEETIE_HD_SCENE_ONE_BYTECODE_UNCOMPRESSED_SIZE: u32 = 1660;
const SWEETIE_HD_SCENE_ONE_BYTECODE_COMPRESSED_SIZE: u32 = 1062;
const SWEETIE_HD_SCENE_ONE_Z_MINUS_TWO: u32 = 3;

#[test]
#[ignore = "real-bytes; requires ITOTORI_REAL_GAME_ROOT env var"]
fn scene1_header_matches_sweetie_hd() {
    let Some(seen_path) = real_seen_txt_path() else {
        eprintln!(
            "ITOTORI_REAL_GAME_ROOT unset; skipping Sweetie HD real-bytes test for \
             utsushi-reallive scene_header (no silent pass: re-run with \
             ITOTORI_REAL_GAME_ROOT=/path/to/reallive-game-root)",
        );
        return;
    };

    let bytes = fs::read(&seen_path)
        .unwrap_or_else(|err| panic!("failed to read {}: {err}", seen_path.display()));

    // Resolve scene #0001's blob window via the UTSUSHI-201 directory
    // parser. We deliberately route through `RealSceneIndex::lookup`
    // (rather than hard-coding the file offset) so a future UTSUSHI-201
    // regression that silently dropped scene 1 would surface here too.
    let index = RealSceneIndex::parse(&bytes)
        .expect("Sweetie HD Seen.txt must parse through the UTSUSHI-201 directory parser");
    let entry = index
        .lookup(1)
        .expect("Sweetie HD must contain a populated scene 1 entry");
    assert_eq!(
        entry.byte_offset, SWEETIE_HD_SCENE_ONE_FILE_OFFSET,
        "scene 1 file offset drift between UTSUSHI-201 and UTSUSHI-202 anchors",
    );
    assert_eq!(
        entry.byte_len, SWEETIE_HD_SCENE_ONE_BLOB_LEN,
        "scene 1 blob length drift between UTSUSHI-201 and UTSUSHI-202 anchors",
    );

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

    let (header, warnings) = SceneHeader::parse(blob).expect(
        "Sweetie HD scene 1 must produce a typed SceneHeader; silent zero-state on real \
         bytes is the bug UTSUSHI-202 fixes",
    );

    assert!(
        warnings.is_empty(),
        "Sweetie HD scene 1 uses compiler_version 110002 which is documented; no warnings \
         expected; got: {warnings:?}",
    );

    assert_eq!(
        header.compiler_version, SWEETIE_HD_SCENE_ONE_COMPILER_VERSION,
        "compiler_version pin (docs/research/reallive-engine.md §D)",
    );
    assert_eq!(
        header.compiler_version, COMPILER_VERSION_1_10,
        "Sweetie HD is RealLive 1.10 — the public constant must match the observed value",
    );
    assert_eq!(
        header.kidoku_offset, SWEETIE_HD_SCENE_ONE_KIDOKU_OFFSET,
        "kidoku_offset pin",
    );
    assert_eq!(
        header.kidoku_count, SWEETIE_HD_SCENE_ONE_KIDOKU_COUNT,
        "kidoku_count pin",
    );
    assert_eq!(
        header.dramatis_offset, SWEETIE_HD_SCENE_ONE_DRAMATIS_OFFSET,
        "dramatis_offset pin",
    );
    assert_eq!(
        header.dramatis_count, SWEETIE_HD_SCENE_ONE_DRAMATIS_COUNT,
        "dramatis_count pin",
    );
    assert_eq!(
        header.bytecode_offset, SWEETIE_HD_SCENE_ONE_BYTECODE_OFFSET,
        "bytecode_offset pin",
    );
    assert_eq!(
        header.bytecode_uncompressed_size, SWEETIE_HD_SCENE_ONE_BYTECODE_UNCOMPRESSED_SIZE,
        "bytecode_uncompressed_size pin",
    );
    assert_eq!(
        header.bytecode_compressed_size, SWEETIE_HD_SCENE_ONE_BYTECODE_COMPRESSED_SIZE,
        "bytecode_compressed_size pin",
    );

    // Cross-check the compressed-size invariant from the research doc:
    // 1530 (blob len 0x5fa) - 468 (bytecode_offset) = 1062.
    assert_eq!(
        (SWEETIE_HD_SCENE_ONE_BLOB_LEN as i64) - (SWEETIE_HD_SCENE_ONE_BYTECODE_OFFSET as i64),
        SWEETIE_HD_SCENE_ONE_BYTECODE_COMPRESSED_SIZE as i64,
        "documented invariant blob_len - bytecode_offset == bytecode_compressed_size",
    );

    // z_minus_one / z_minus_two pins. The research doc records
    // z_minus_two=3 explicitly; z_minus_one is documented as 0.
    assert_eq!(header.z_minus_one, 0, "z_minus_one pin (retail unused)");
    assert_eq!(
        header.z_minus_two, SWEETIE_HD_SCENE_ONE_Z_MINUS_TWO,
        "z_minus_two pin (docs/research/reallive-engine.md §D)",
    );

    // Savepoint triplet: all three are zero for scene #0001.
    assert_eq!(header.savepoint_message, 0, "savepoint_message pin");
    assert_eq!(header.savepoint_selcom, 0, "savepoint_selcom pin");
    assert_eq!(header.savepoint_seentop, 0, "savepoint_seentop pin");

    // Entrypoint table assertions. The research doc names the 0x34
    // lattice as the entrypoint table and pins each populated slot to
    // value 0x06. Assert (a) the table is the fixed 100-slot length,
    // (b) it is non-empty (table length > 0), and (c) the first
    // entry's value is 0x06 — the documented lattice marker.
    assert_eq!(
        header.entrypoint_table.len(),
        ENTRYPOINT_TABLE_LEN,
        "entrypoint table must be a fixed 100-slot lattice",
    );
    assert!(
        !header.entrypoint_table.is_empty(),
        "entrypoint table must contain at least one entry",
    );
    let first_entry = &header.entrypoint_table[0];
    assert_eq!(
        first_entry.index, 0,
        "first entrypoint slot is index 0 (start of the 0x34 lattice)",
    );
    assert_eq!(
        first_entry.value, 0x06,
        "Sweetie HD scene #0001 starts the entrypoint lattice with the documented 0x06 marker \
         (docs/research/reallive-engine.md §D)",
    );
}

fn real_seen_txt_path() -> Option<PathBuf> {
    real_corpus::seen_txt_path()
}
