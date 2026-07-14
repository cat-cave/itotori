//! Synthetic-byte round-trip tests for the AVG-derived
//! save format.
//!
//! These tests do **not** require the Sweetie HD research mount;
//! every byte they consume is produced by the
//! [`SaveRoundTrip`](utsushi_reallive::SaveRoundTrip) builder. They
//! exercise the spec acceptance criteria that don't depend on the
//! research-mount bytes:
//!
//! - The `SystemSave` round-trip (`encode(decode(bytes)) == bytes`).
//! - The `GlobalSave` round-trip.
//! - The `ReadFlags` round-trip, including the Sweetie HD title bytes
//!   decoded from Shift-JIS.
//! - The substrate `SnapshotStore` round-trip for the in-memory
//!   `SaveState` backing.
//!
//! The test entry-point names are deliberately structured so the three
//! verification commands the spec lists each match at least one
//! `#[test]`:
//!
//! - `cargo test -p utsushi-reallive save_reads_avg_system_save`
//! - `cargo test -p utsushi-reallive save_reads_avg_global_save`
//! - `cargo test -p utsushi-reallive save_read_flags_decodes_title`

use utsushi_core::substrate::{
    EvidenceTier, InMemorySnapshotStore, Inspectable, Snapshot, SnapshotRef, SnapshotRequest,
    SnapshotStore, restore_snapshot, take_snapshot,
};
use utsushi_reallive::{
    AVG_DERIVED_COMPILER_VERSION, AvgSavePreamble, GLOBAL_SAVE_MAGIC, GlobalSave, ReadFlags,
    SAVE_STATE_INSPECTABLE_ID, SYSTEM_SAVE_MAGIC, SaveDecodeError, SaveRoundTrip, SaveState,
    SystemSave,
};

/// Sweetie HD's `REALLIVE.sav` total byte length (audit doc § J).
const SWEETIE_HD_SYSTEM_SAVE_BYTES: usize = 24_876;

/// Sweetie HD's `save999.sav` total byte length (audit doc § J).
const SWEETIE_HD_GLOBAL_SAVE_BYTES: usize = 6_748;

/// Sweetie HD's `read.sav` total byte length (audit doc § J).
const SWEETIE_HD_READ_FLAGS_BYTES: usize = 44_495;

/// Sweetie HD title bytes embedded at offset 0x18 of `read.sav`. The
/// 38-byte Shift-JIS string before the null terminator.
fn reallive_real_bytes_title_bytes() -> Vec<u8> {
    vec![
        0x83, 0x49, 0x83, 0x56, 0x83, 0x49, 0x83, 0x4c, 0x53, 0x77, 0x65, 0x65, 0x74, 0x69, 0x65,
        0x81, 0x7b, 0x53, 0x77, 0x65, 0x65, 0x74, 0x73, 0x21, 0x21, 0x20, 0x48, 0x44, 0x20, 0x45,
        0x64, 0x69, 0x74, 0x69, 0x6f, 0x6e, 0x81, 0x40,
    ]
}

/// UTF-8 form of the Sweetie HD title (`オシオキSweetie＋Sweets!! HD Edition`
/// IDEOGRAPHIC SPACE U+3000).
const SWEETIE_HD_TITLE_UTF8: &str = "オシオキSweetie＋Sweets!! HD Edition\u{3000}";

// `SystemSave` (REALLIVE.sav, `AVG_SYSTEM_SAVE`).

#[test]
fn save_reads_avg_system_save_synthetic_round_trips_byte_identically() {
    let bytes = SaveRoundTrip::synthetic_system_save(SWEETIE_HD_SYSTEM_SAVE_BYTES);
    let save = SystemSave::decode(&bytes).expect("synthetic system save must decode");
    assert_eq!(
        save.preamble.leading_u32 as usize, SWEETIE_HD_SYSTEM_SAVE_BYTES,
        "preamble file-size cross-check must hold"
    );
    assert_eq!(save.preamble.compiler_version, AVG_DERIVED_COMPILER_VERSION);
    let re_encoded = save.encode();
    assert_eq!(
        re_encoded, bytes,
        "synthetic SystemSave round-trip must be byte-identical"
    );
}

#[test]
fn save_reads_avg_system_save_magic_pinned_at_offset_0x18() {
    let bytes = SaveRoundTrip::synthetic_system_save(SWEETIE_HD_SYSTEM_SAVE_BYTES);
    // Audit-focus: the magic string lives at offset 0x18 and matches
    // the documented pin.
    let magic_slice = &bytes[0x18..0x18 + SYSTEM_SAVE_MAGIC.len()];
    assert_eq!(magic_slice, SYSTEM_SAVE_MAGIC.as_bytes());
    assert_eq!(
        bytes[0x18 + SYSTEM_SAVE_MAGIC.len()],
        0,
        "magic must be NUL-terminated"
    );
}

#[test]
fn save_reads_avg_system_save_decode_rejects_file_size_mismatch() {
    // Audit-focus: silently truncating slots is the named risk; we
    // surface a typed `PreambleFileSizeMismatch` instead of accepting
    // the smaller-than-declared input.
    let mut bytes = SaveRoundTrip::synthetic_system_save(SWEETIE_HD_SYSTEM_SAVE_BYTES);
    bytes.truncate(SWEETIE_HD_SYSTEM_SAVE_BYTES - 1);
    let err = SystemSave::decode(&bytes).expect_err("truncated input must error");
    assert!(matches!(
        err,
        SaveDecodeError::PreambleFileSizeMismatch { .. }
    ));
}

// `GlobalSave` (save999.sav, `AVG_GLOBAL_SAVE`).

#[test]
fn save_reads_avg_global_save_synthetic_round_trips_byte_identically() {
    // The synthetic builder produces a `save999.sav`-shaped stream;
    // the leading u32 is the per-format constant `0x000000A4`, not the
    // file size.
    let payload_bytes = SWEETIE_HD_GLOBAL_SAVE_BYTES - 0x18 - GLOBAL_SAVE_MAGIC.len() - 1;
    let bytes = SaveRoundTrip::synthetic_global_save(payload_bytes);
    let save = GlobalSave::decode(&bytes).expect("synthetic global save must decode");
    assert_eq!(save.preamble.leading_u32, 0x0000_00A4);
    let re_encoded = save.encode();
    assert_eq!(re_encoded, bytes);
    assert_eq!(re_encoded.len(), SWEETIE_HD_GLOBAL_SAVE_BYTES);
}

#[test]
fn save_reads_avg_global_save_magic_pinned_at_offset_0x18() {
    let bytes = SaveRoundTrip::synthetic_global_save(64);
    let magic_slice = &bytes[0x18..0x18 + GLOBAL_SAVE_MAGIC.len()];
    assert_eq!(magic_slice, GLOBAL_SAVE_MAGIC.as_bytes());
    assert_eq!(bytes[0x18 + GLOBAL_SAVE_MAGIC.len()], 0);
}

#[test]
fn save_reads_avg_global_save_decode_rejects_wrong_magic() {
    // Build a `SystemSave`-shaped byte stream and try to decode it
    // as a `GlobalSave` — the magic check must fire.
    let system = SaveRoundTrip::synthetic_system_save(2048);
    let err = GlobalSave::decode(&system).expect_err("wrong magic");
    match err {
        SaveDecodeError::MagicMismatch { observed, expected } => {
            assert_eq!(observed, SYSTEM_SAVE_MAGIC);
            assert_eq!(expected, GLOBAL_SAVE_MAGIC);
        }
        other => panic!("expected MagicMismatch, got {other:?}"),
    }
}

// `ReadFlags` (read.sav, Shift-JIS title).

#[test]
fn save_read_flags_decodes_title_round_trips_shift_jis_bytes() {
    let title_bytes = reallive_real_bytes_title_bytes();
    let payload_bytes = SWEETIE_HD_READ_FLAGS_BYTES - 0x18 - title_bytes.len() - 1;
    let bytes = SaveRoundTrip::synthetic_read_flags(&title_bytes, payload_bytes);
    let flags = ReadFlags::decode(&bytes).expect("synthetic read flags must decode");
    assert_eq!(flags.title_bytes, title_bytes);
    assert_eq!(
        flags.title, SWEETIE_HD_TITLE_UTF8,
        "Shift-JIS title must decode to the documented UTF-8 string"
    );
    let re_encoded = flags.encode();
    assert_eq!(re_encoded, bytes);
    assert_eq!(re_encoded.len(), SWEETIE_HD_READ_FLAGS_BYTES);
}

#[test]
fn save_read_flags_decodes_title_preserves_non_utf8_bytes_verbatim() {
    // Acceptance criterion: the Shift-JIS title decode round-trips.
    // Use bytes that are NOT valid UTF-8 directly to prove the raw-byte
    // round-trip path doesn't lose anything.
    let title_bytes = reallive_real_bytes_title_bytes();
    let bytes = SaveRoundTrip::synthetic_read_flags(&title_bytes, 16);
    let flags = ReadFlags::decode(&bytes).expect("decode");
    // Re-encoding must reproduce the input verbatim — including every
    // high-bit byte in the title.
    let re = flags.encode();
    assert_eq!(&re[0x18..0x18 + title_bytes.len()], title_bytes.as_slice());
}

#[test]
fn save_read_flags_decodes_title_accepts_ascii_title() {
    // Sanity check: a pure-ASCII title round-trips through the same
    // decoder without tripping the Shift-JIS replacement guard.
    let title = b"REALLIVE";
    let bytes = SaveRoundTrip::synthetic_read_flags(title, 8);
    let flags = ReadFlags::decode(&bytes).expect("decode");
    assert_eq!(flags.title, "REALLIVE");
    assert_eq!(flags.encode(), bytes);
}

// Preamble cross-checks.

#[test]
fn save_preamble_round_trips_reallive_real_bytes_shaped_values() {
    let preamble = AvgSavePreamble {
        leading_u32: SWEETIE_HD_SYSTEM_SAVE_BYTES as u32,
        compiler_version: AVG_DERIVED_COMPILER_VERSION,
        timestamp: [0x07E9, 0x0003, 0x0002, 0x000B, 0x0012, 0x0027],
        padding_a: 0,
        tail: 0x02DC,
    };
    let bytes = preamble.encode();
    // Audit-focus: byte-for-byte match against the documented Sweetie HD
    // header prefix.
    assert_eq!(&bytes[0x00..0x04], &[0x2C, 0x61, 0x00, 0x00]);
    assert_eq!(&bytes[0x04..0x08], &[0x12, 0x27, 0x00, 0x00]);
    assert_eq!(
        &bytes[0x08..0x14],
        &[
            0xE9, 0x07, 0x03, 0x00, 0x02, 0x00, 0x0B, 0x00, 0x12, 0x00, 0x27, 0x00
        ]
    );
    assert_eq!(&bytes[0x16..0x18], &[0xDC, 0x02]);
    let parsed = AvgSavePreamble::decode(&bytes).expect("decode");
    assert_eq!(parsed, preamble);
}

// Substrate `SnapshotStore` round-trip — the in-memory backing seam
// the spec names: "substrate `SnapshotStore` is used as the in-memory
// backing for save state; on-disk write is a separate serialiser".

#[test]
fn save_state_inspectable_id_is_pinned() {
    let state = SaveState::new();
    assert_eq!(state.inspectable_id(), SAVE_STATE_INSPECTABLE_ID);
}

#[test]
fn save_state_snapshot_round_trips_through_in_memory_snapshot_store() {
    let store = InMemorySnapshotStore::new();
    let mut state = SaveState::new();

    let system_bytes = SaveRoundTrip::synthetic_system_save(2048);
    let global_bytes = SaveRoundTrip::synthetic_global_save(64);
    let read_bytes = SaveRoundTrip::synthetic_read_flags(b"REALLIVE", 16);

    state.set_system_save(SystemSave::decode(&system_bytes).expect("system"));
    state.set_global_save(GlobalSave::decode(&global_bytes).expect("global"));
    state.set_read_flags(ReadFlags::decode(&read_bytes).expect("read"));

    let request = SnapshotRequest::new("run-utsushi-218", "2026-06-26T00:00:00Z", EvidenceTier::E2)
        .with_tick(1);
    let snapshot: Snapshot = take_snapshot(&state, &request).expect("snapshot");
    store.insert(snapshot.clone()).expect("insert");

    // Mutate in place; restore from the store; assert all three slots
    // come back byte-identical.
    let mut restored = SaveState::new();
    let reference = SnapshotRef {
        snapshot_id: snapshot.snapshot_id().clone(),
        inspectable_id: snapshot.inspectable_id().to_string(),
        evidence_tier: snapshot.evidence_tier(),
    };
    let resolved = store.resolve(&reference).expect("resolve");
    restore_snapshot(&mut restored, &resolved).expect("restore");

    assert_eq!(restored.system_save().expect("sys").encode(), system_bytes);
    assert_eq!(restored.global_save().expect("glob").encode(), global_bytes);
    assert_eq!(restored.read_flags().expect("read").encode(), read_bytes);
}
