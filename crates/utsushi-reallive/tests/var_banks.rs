//! UTSUSHI-206 — sparse `VarBanks` substrate integration tests.
//!
//! Pins the four acceptance criteria from the spec node:
//!
//! 0. `intA[0] = 42; snapshot; intA[0] = 99; restore; assert intA[0] == 42`
//!    round-trips through `SnapshotStore`.
//! 1. An empty-machine snapshot serializes to **less than 1 KB**.
//! 2. Out-of-range writes (e.g. `intA[2000]`) emit
//!    `utsushi.reallive.bank_index_out_of_range` and clamp.
//! 3. String banks store as Shift-JIS bytes verbatim — non-UTF-8 bytes
//!    survive the snapshot / restore round trip byte-for-byte.
//!
//! Plus a fifth cross-substrate test (`InMemorySnapshotStore` round
//! trip) covering the snapshot-store seam.

use utsushi_core::EvidenceTier;
use utsushi_core::substrate::{
    InMemorySnapshotStore, Inspectable, Snapshot, SnapshotRef, SnapshotRequest, SnapshotStore,
    restore_snapshot, take_snapshot,
};
use utsushi_reallive::{
    BANK_INDEX_CAP, BankId, VAR_BANKS_INSPECTABLE_ID, Value, VarBanks, VarBanksWarning,
};

/// Documented audit code surfaced by [`VarBanksWarning::BankIndexOutOfRange`]
/// in the rendered `Display` form. Pinned here so the audit grep can
/// detect a future rename without parsing the error variant.
const BANK_INDEX_OUT_OF_RANGE_CODE: &str = "utsushi.reallive.bank_index_out_of_range";

/// Empty-machine snapshot byte ceiling (acceptance criterion #1).
const EMPTY_SNAPSHOT_BYTES_CEILING: usize = 1024;

fn snapshot_request(tick: u64) -> SnapshotRequest<'static> {
    SnapshotRequest::new("run-utsushi-206", "2026-06-23T00:00:00Z", EvidenceTier::E2)
        .with_tick(tick)
}

fn take(banks: &VarBanks, tick: u64) -> Snapshot {
    let request = snapshot_request(tick);
    take_snapshot(banks, &request).expect("snapshot")
}

// ---------------------------------------------------------------------
// Acceptance criterion #0 — sparse round-trip through the snapshot store.
// ---------------------------------------------------------------------

#[test]
fn variable_banks_snapshot_restore_round_trips_inta_zero_equals_forty_two() {
    // Stage 1: write intA[0]=42 into the banks, snapshot.
    let mut banks = VarBanks::new();
    banks
        .set(BankId::IntA, 0, Value::Int(42))
        .expect("clean set");
    let snapshot = take(&banks, 1);

    // Stage 2: scribble intA[0]=99 in-place.
    banks
        .set(BankId::IntA, 0, Value::Int(99))
        .expect("clean set");
    assert_eq!(banks.get(BankId::IntA, 0), Some(Value::Int(99)));

    // Stage 3: restore the earlier snapshot — intA[0] must be 42 again.
    restore_snapshot(&mut banks, &snapshot).expect("restore");
    assert_eq!(
        banks.get(BankId::IntA, 0),
        Some(Value::Int(42)),
        "round-trip must restore intA[0]=42 (acceptance criterion #0)"
    );
}

#[test]
fn variable_banks_snapshot_restore_through_snapshot_store_round_trips_state() {
    // Cross-substrate test: snapshot via `InMemorySnapshotStore`, then
    // resolve the ref and restore. The state-tree must round-trip
    // byte-identically.
    let store = InMemorySnapshotStore::new();
    let mut banks = VarBanks::new();
    banks
        .set(BankId::IntF, 3, Value::Int(-7))
        .expect("clean set");
    banks
        .set(BankId::IntG, 11, Value::Int(123))
        .expect("clean set");
    banks
        .set(BankId::StrS, 0, Value::Str(vec![0x82, 0xa0, 0x82, 0xa1]))
        .expect("clean str set");
    banks.set_store(0xCAFE_BABE);
    let snapshot = take(&banks, 7);
    store.insert(snapshot.clone()).expect("insert");

    // Mutate in place, then resolve + restore.
    banks
        .set(BankId::IntF, 3, Value::Int(0))
        .expect("clean set");
    banks
        .set(BankId::IntG, 11, Value::Int(0))
        .expect("clean set");
    banks.set_store(0);
    banks
        .set(BankId::StrS, 0, Value::Str(vec![]))
        .expect("clean str set");

    let reference = SnapshotRef {
        snapshot_id: snapshot.snapshot_id().clone(),
        inspectable_id: snapshot.inspectable_id().to_string(),
        evidence_tier: snapshot.evidence_tier(),
    };
    let resolved = store.resolve(&reference).expect("resolve");
    restore_snapshot(&mut banks, &resolved).expect("restore");
    assert_eq!(banks.get(BankId::IntF, 3), Some(Value::Int(-7)));
    assert_eq!(banks.get(BankId::IntG, 11), Some(Value::Int(123)));
    assert_eq!(
        banks.get(BankId::StrS, 0),
        Some(Value::Str(vec![0x82, 0xa0, 0x82, 0xa1]))
    );
    assert_eq!(banks.store(), 0xCAFE_BABE);
}

// ---------------------------------------------------------------------
// Acceptance criterion #1 — empty-machine snapshot fits in < 1 KB.
// ---------------------------------------------------------------------

#[test]
fn variable_banks_empty_machine_snapshot_serializes_under_one_kilobyte() {
    let banks = VarBanks::new();
    let snapshot = take(&banks, 0);
    let serialized = serde_json::to_vec(&snapshot).expect("serialize");
    eprintln!(
        "[UTSUSHI-206] empty_machine_snapshot_bytes={} ceiling={}",
        serialized.len(),
        EMPTY_SNAPSHOT_BYTES_CEILING
    );
    assert!(
        serialized.len() < EMPTY_SNAPSHOT_BYTES_CEILING,
        "empty-machine snapshot {} bytes exceeds ceiling {} (acceptance criterion #1)",
        serialized.len(),
        EMPTY_SNAPSHOT_BYTES_CEILING
    );
    // The serialized form must NOT mention any bank that has zero set
    // indices — sparse storage is the load-bearing posture.
    let serialized_str = String::from_utf8(serialized.clone()).expect("ascii-clean json");
    for bank in BankId::INT_BANKS {
        assert!(
            !serialized_str.contains(bank.path_segment()),
            "empty-machine snapshot must not mention {}",
            bank.path_segment()
        );
    }
    for bank in BankId::STR_BANKS {
        assert!(
            !serialized_str.contains(bank.path_segment()),
            "empty-machine snapshot must not mention {}",
            bank.path_segment()
        );
    }
}

// ---------------------------------------------------------------------
// Acceptance criterion #2 — out-of-range writes emit warning and clamp.
// ---------------------------------------------------------------------

#[test]
fn variable_banks_out_of_range_write_emits_warning_and_clamps() {
    let mut banks = VarBanks::new();
    // Acceptance criterion #2 lists `intA[2000]` as the canonical
    // example — `2 000` is the rlvm-documented cap (`BANK_INDEX_CAP`).
    let err = banks
        .set(BankId::IntA, BANK_INDEX_CAP, Value::Int(99))
        .expect_err("write past cap must surface warning");
    let rendered = err.to_string();
    assert!(
        rendered.starts_with(BANK_INDEX_OUT_OF_RANGE_CODE),
        "warning {rendered:?} must start with audit code {BANK_INDEX_OUT_OF_RANGE_CODE:?}"
    );
    match err {
        VarBanksWarning::BankIndexOutOfRange {
            bank,
            requested,
            cap,
        } => {
            assert_eq!(bank, "intA");
            assert_eq!(requested, BANK_INDEX_CAP as u32);
            assert_eq!(cap, BANK_INDEX_CAP);
        }
    }
    // Clamped write landed at cap - 1.
    assert_eq!(
        banks.get(BankId::IntA, BANK_INDEX_CAP - 1),
        Some(Value::Int(99))
    );
    // The original out-of-range index does NOT carry the value (the
    // write clamped — not "fell through").
    assert_eq!(banks.get(BankId::IntA, BANK_INDEX_CAP), None);
}

// ---------------------------------------------------------------------
// Acceptance criterion #3 — string banks preserve Shift-JIS bytes.
// ---------------------------------------------------------------------

#[test]
fn variable_banks_string_bank_round_trips_raw_shift_jis_bytes_verbatim() {
    // Bytes that are intentionally NOT valid UTF-8 so a lossy
    // conversion would have a detectable artefact:
    // - 0x82 0xA0 = ｱ in Shift-JIS (Katakana A)
    // - 0x82 0xA2 = ｲ in Shift-JIS (Katakana I)
    // - 0x5C standalone = Windows backslash / ¥ in Shift-JIS
    // - 0xFF (Shift-JIS extended)
    // - 0x80, 0xC0, 0xE0 — high-bit bytes that always look "lossy" in
    //   a UTF-8 lens.
    let shift_jis_bytes = vec![
        0x82, 0xA0, 0x82, 0xA2, 0x5C, 0xFF, 0x80, 0xC0, 0xE0, 0x00, 0x01, 0x7F,
    ];
    let mut banks = VarBanks::new();
    banks
        .set(BankId::StrM, 5, Value::Str(shift_jis_bytes.clone()))
        .expect("clean str set");
    // Snapshot -> serialize -> deserialize -> restore. The full
    // round-trip must not lose any byte.
    let snapshot = take(&banks, 1);
    let json = snapshot.to_json_value().expect("to json");
    let snapshot_back = Snapshot::from_json_value(json).expect("from json");
    let mut restored = VarBanks::new();
    restore_snapshot(&mut restored, &snapshot_back).expect("restore");
    assert_eq!(
        restored.get(BankId::StrM, 5),
        Some(Value::Str(shift_jis_bytes)),
        "string bank must round-trip raw Shift-JIS bytes verbatim (acceptance criterion #3)"
    );
}

// ---------------------------------------------------------------------
// Inspectable / Restorable trait pinning.
// ---------------------------------------------------------------------

#[test]
fn variable_banks_inspectable_id_is_pinned_constant() {
    let banks = VarBanks::new();
    assert_eq!(banks.inspectable_id(), VAR_BANKS_INSPECTABLE_ID);
}

#[test]
fn variable_banks_restore_round_trip_preserves_store_register() {
    let mut banks = VarBanks::new();
    banks.set_store(0xDEAD_BEEF);
    let snapshot = take(&banks, 1);
    banks.set_store(0);
    restore_snapshot(&mut banks, &snapshot).expect("restore");
    assert_eq!(banks.store(), 0xDEAD_BEEF);
}

#[test]
fn variable_banks_inspect_state_emits_nonempty_state_tree_for_empty_machine() {
    let banks = VarBanks::new();
    let tree = banks.inspect_state().expect("inspect");
    assert!(
        !tree.is_empty(),
        "empty machine must still produce a non-empty state tree (manifest + store)"
    );
}

#[test]
fn variable_banks_inspect_state_emits_only_set_indices() {
    let mut banks = VarBanks::new();
    banks
        .set(BankId::IntA, 0, Value::Int(1))
        .expect("clean set");
    banks
        .set(BankId::IntA, 1, Value::Int(2))
        .expect("clean set");
    // IntB is intentionally not touched.
    let tree = banks.inspect_state().expect("inspect");
    let paths: Vec<&str> = tree.paths().map(utsushi_core::StatePath::as_str).collect();
    assert!(paths.iter().any(|p| p.contains("int_a")));
    assert!(
        !paths.iter().any(|p| p.contains("int_b")),
        "unset bank IntB must not appear in state tree (sparse posture)"
    );
}
