//! UTSUSHI-201 real-bytes integration test for the `utsushi-reallive`
//! 10,000-slot `Seen.txt` directory parser.
//!
//! Anchors the parser against the Sweetie HD corpus supplied via
//! `ITOTORI_REAL_GAME_ROOT` and
//! re-uses the format invariants documented in
//! `docs/research/reallive-engine.md` §D plus
//! `docs/audits/real-bytes-validation-2026-06-24.md` §2.8.
//!
//! **Multi-game validation status.** Per the itotori operating model
//! (`docs/orchestration-operating-model.md`), a parser that targets a
//! real engine substrate must be exercised against at least two real
//! corpora before its node is merged-complete. The MV/MZ and KAG
//! corpora are different engines and do not contain a `Seen.txt`.
//! `utsushi-reallive` is therefore in the same single-RealLive-corpus
//! position as `kaifuu-reallive` was for KAIFUU-188: Sweetie HD is the
//! only RealLive title currently staged. UTSUSHI-201 mirrors that
//! pattern — the node stays `planned` until a second RealLive corpus is
//! sourced and exercised by an additional
//! `scene_index_second_reallive_real_bytes.rs` test. The orchestrator
//! must not approve completion until that happens.
//!
//! Until the second corpus is staged this test is `#[ignore]`-gated and
//! only runs when `ITOTORI_REAL_GAME_ROOT` is set (the same env
//! var KAIFUU-188 uses, so a single export drives both projects).

#[path = "support/real_corpus.rs"]
mod real_corpus;

use std::fs;
use std::path::PathBuf;

use utsushi_reallive::{REAL_SCENE_DIRECTORY_BYTE_LEN, RealSceneIndex};

// Relative path under the Sweetie HD extraction root that holds the
// raw `Seen.txt` envelope.

/// Sweetie HD is the only RealLive corpus currently staged, so its
/// populated-slot count is the alpha-gate anchor. Mirrors the
/// equivalent constant in `kaifuu-reallive`'s integration test — both
/// parsers see the same archive, both must agree on the count.
const SWEETIE_HD_POPULATED_SLOT_COUNT: usize = 198;

/// Documented byte offset of the first populated scene payload (slot
/// 1). Equal to the directory byte length — the first scene sits
/// immediately after the 80,000-byte directory.
const SWEETIE_HD_FIRST_SCENE_BYTE_OFFSET: u64 = 0x13880;

/// Documented byte length of scene 1's payload.
const SWEETIE_HD_FIRST_SCENE_BYTE_LEN: u32 = 0x5fa;

/// Documented final populated scene id. RealLive reserves slot 9999 as
/// the syscall-handler scene; Sweetie HD populates it.
const SWEETIE_HD_LAST_SCENE_ID: u16 = 9999;

#[test]
#[ignore = "real-bytes; requires ITOTORI_REAL_GAME_ROOT env var"]
fn scene_index_real_bytes_parses_reallive_real_bytes_seen_txt_into_198_populated_scene_entries() {
    let Some(seen_path) = real_seen_txt_path() else {
        eprintln!(
            "ITOTORI_REAL_GAME_ROOT unset; skipping Sweetie HD real-bytes test for \
             utsushi-reallive (no silent pass: re-run with \
             ITOTORI_REAL_GAME_ROOT=/path/to/reallive-game-root)",
        );
        return;
    };

    let bytes = fs::read(&seen_path)
        .unwrap_or_else(|err| panic!("failed to read {}: {err}", seen_path.display()));

    // Sanity: the byte count should be larger than the bare directory.
    // If this assert ever fires we are pointing at a different file
    // than the one the audit documented.
    assert!(
        bytes.len() >= REAL_SCENE_DIRECTORY_BYTE_LEN,
        "Sweetie HD Seen.txt should be at least the directory size ({} bytes); got {}",
        REAL_SCENE_DIRECTORY_BYTE_LEN,
        bytes.len(),
    );

    let index = RealSceneIndex::parse(&bytes).expect(
        "Sweetie HD REALLIVEDATA/Seen.txt must parse cleanly through \
         utsushi-reallive's own parser; silent zero-state on real bytes is the bug \
         UTSUSHI-201 fixes",
    );

    assert_eq!(
        index.len(),
        SWEETIE_HD_POPULATED_SLOT_COUNT,
        "expected {} populated slots in Sweetie HD Seen.txt; got {}",
        SWEETIE_HD_POPULATED_SLOT_COUNT,
        index.len(),
    );

    // First entry pinning: slot 1 @ (0x13880, 0x5fa). These three
    // invariants together prove (a) the directory walk starts at slot
    // 0, (b) slot 0 is reserved so the first emitted entry is slot 1,
    // and (c) the (offset, length) decoder uses little-endian u32 reads
    // at the documented byte stride.
    let first = index
        .entries
        .first()
        .expect("Sweetie HD has 198 populated slots; first one must exist");
    assert_eq!(first.scene_id, 1, "first populated slot must be scene 1");
    assert_eq!(
        first.byte_offset, SWEETIE_HD_FIRST_SCENE_BYTE_OFFSET,
        "first scene payload sits immediately after the 80,000-byte directory",
    );
    assert_eq!(
        first.byte_len, SWEETIE_HD_FIRST_SCENE_BYTE_LEN,
        "first scene payload size matches the documented Sweetie HD value",
    );

    // `lookup` must agree with `entries.first()`.
    let first_via_lookup = index
        .lookup(1)
        .expect("lookup(1) must return the first populated entry");
    assert_eq!(first_via_lookup, first);

    // Reserved slot 0 must not appear in the index.
    assert!(
        index.lookup(0).is_none(),
        "slot 0 is reserved by the RealLive convention and must not appear",
    );

    // Scene-id range bounds: 1..=9999. We assert the bounds rather than
    // enumerating the gaps — the gap structure is corpus-specific and
    // changes between titles.
    let max_scene_id = index
        .entries
        .iter()
        .map(|entry| entry.scene_id)
        .max()
        .expect("non-empty index");
    let min_scene_id = index
        .entries
        .iter()
        .map(|entry| entry.scene_id)
        .min()
        .expect("non-empty index");
    assert_eq!(
        max_scene_id, SWEETIE_HD_LAST_SCENE_ID,
        "last populated scene id must be 9999 (the documented syscall-handler slot)",
    );
    assert_eq!(
        min_scene_id, 1,
        "first populated scene id must be 1 (slot 0 is reserved)",
    );

    // Slot-ascending invariant — the parser walks the directory front
    // to back and must not re-order.
    let mut prev = 0u16;
    for entry in &index.entries {
        assert!(
            entry.scene_id > prev,
            "entries must be strictly ascending by scene_id; got {} after {}",
            entry.scene_id,
            prev,
        );
        prev = entry.scene_id;
    }
}

fn real_seen_txt_path() -> Option<PathBuf> {
    real_corpus::seen_txt_path()
}
