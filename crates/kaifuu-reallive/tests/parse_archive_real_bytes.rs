//! KAIFUU-188 real-bytes integration test for the 10,000-slot SEEN.TXT
//! envelope parser. Anchors the parser against the only RealLive corpus
//! currently staged (Sweetie HD) and exercises the truncation path on
//! synthetic 10,001-slot bytes.
//!
//! **Multi-game validation status.** Per the itotori operating model
//! (`docs/orchestration-operating-model.md`), a parser that targets a
//! real engine substrate must be exercised against at least two real
//! corpora before its node is merged-complete. The MV/MZ and KAG corpora
//! are different engines and do not contain a `Seen.txt`. Single
//! RealLive corpus (Sweetie HD) until a second RealLive title is
//! sourced. Per the multi-game-validation rule, KAIFUU-188's status
//! remains `planned` until the second RealLive corpus is staged and
//! exercised by an additional `parse_archive_second_reallive_real_bytes.rs`
//! test. The orchestrator must not approve completion until that
//! happens.

#[path = "support/real_corpus.rs"]
mod real_corpus;

use std::fs;
use std::path::PathBuf;

use kaifuu_reallive::{
    ParseDiagnosticCode, REALLIVE_SEEN_TXT_DIRECTORY_BYTE_LEN, REALLIVE_SEEN_TXT_SLOT_COUNT,
    parse_archive,
};

#[test]
#[ignore = "real-bytes; requires ITOTORI_REAL_GAME_ROOT env var"]
fn parses_sweetie_hd_seen_txt_into_198_populated_scene_entries() {
    let Some(seen_path) = real_seen_txt_path() else {
        eprintln!(
            "ITOTORI_REAL_GAME_ROOT unset; skipping Sweetie HD real-bytes test (no silent pass: \
             re-run with ITOTORI_REAL_GAME_ROOT=/path/to/reallive-game-root)"
        );
        return;
    };

    let bytes = fs::read(&seen_path)
        .unwrap_or_else(|err| panic!("failed to read {}: {err}", seen_path.display()));
    let index = parse_archive(&bytes).expect(
        "Sweetie HD REALLIVEDATA/Seen.txt must parse cleanly; \
         silent zero-state on real bytes is the bug KAIFUU-188 fixes",
    );

    // Acceptance: the documented populated-slot count for Sweetie HD is 198
    // (`docs/research/reallive-engine.md` §C).
    assert_eq!(
        index.entries.len(),
        198,
        "expected 198 populated slots in Sweetie HD Seen.txt; got {}",
        index.entries.len()
    );

    // First entry: slot 1, byte_offset 0x13880, byte_len 0x5fa.
    let first = &index.entries[0];
    assert_eq!(first.scene_id, 1, "first populated slot should be scene 1");
    assert_eq!(
        first.byte_offset, 0x13880,
        "first scene payload sits at the file offset immediately after the 80,000-byte directory"
    );
    assert_eq!(
        first.byte_len, 0x5fa,
        "first scene payload size matches the documented Sweetie HD value"
    );

    // Scene-id range bounds: 1..=9999. Per the research doc, we assert
    // the bounds rather than enumerating the gaps.
    let max_scene_id = index
        .entries
        .iter()
        .map(|e| e.scene_id)
        .max()
        .expect("non-empty index");
    let min_scene_id = index
        .entries
        .iter()
        .map(|e| e.scene_id)
        .min()
        .expect("non-empty index");
    assert_eq!(
        max_scene_id, 9999,
        "last populated scene id must be 9999 (the documented syscall-handler slot)"
    );
    assert_eq!(
        min_scene_id, 1,
        "first populated scene id must be 1 (slot 0 is reserved)"
    );

    // Entries must be slot-ascending; that's how the parser walks the
    // directory. This is a guard against a regression that re-orders.
    let mut prev = 0u16;
    for entry in &index.entries {
        assert!(
            entry.scene_id > prev,
            "entries must be strictly ascending by scene_id; got {} after {}",
            entry.scene_id,
            prev
        );
        prev = entry.scene_id;
    }
}

#[test]
fn rejects_truncated_archive_whose_last_slot_runs_past_end_of_file() {
    // Synthesise a 10,001-slot file where the last populated slot points
    // past the file end. We model "10,001 slots" as the documented
    // 10,000-slot directory plus an additional 8 bytes of payload area
    // that we will lie about the size of via slot 9999.
    let directory_byte_len = REALLIVE_SEEN_TXT_DIRECTORY_BYTE_LEN as usize;
    let total_len = directory_byte_len + 8;
    let mut bytes = vec![0u8; total_len];
    // Slot 9999: declare a 1 KiB payload starting at directory_end +
    // 8. We only have 0 bytes of usable payload past that anchor, so the
    // declared range obviously runs past `total_len`.
    let last_slot_offset = (REALLIVE_SEEN_TXT_SLOT_COUNT - 1) * 8; // 79992
    let payload_offset = (directory_byte_len + 8) as u32;
    let payload_len = 1024u32;
    bytes[last_slot_offset..last_slot_offset + 4].copy_from_slice(&payload_offset.to_le_bytes());
    bytes[last_slot_offset + 4..last_slot_offset + 8].copy_from_slice(&payload_len.to_le_bytes());

    let diag = parse_archive(&bytes).expect_err(
        "truncated slot must surface kaifuu.reallive.truncated_scene Fatal — not a silent skip",
    );
    assert_eq!(diag.code, ParseDiagnosticCode::TruncatedScene);
    assert!(
        diag.message.contains("9999"),
        "diagnostic should name the offending scene id 9999; got: {}",
        diag.message
    );
}

fn real_seen_txt_path() -> Option<PathBuf> {
    real_corpus::seen_txt_path()
}
