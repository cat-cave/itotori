use super::*;

#[test]
fn bank_byte_table_maps_documented_int_letters() {
    assert_eq!(BankId::from_int_bank_byte(0x00), Some(BankId::IntA));
    assert_eq!(BankId::from_int_bank_byte(0x0C), Some(BankId::IntM));
    assert_eq!(BankId::from_int_bank_byte(0x0D), None);
    assert_eq!(BankId::from_int_bank_byte(0xFF), None);
}

#[test]
fn bank_byte_table_includes_string_banks_outside_int_window() {
    assert_eq!(BankId::from_bank_byte(BANK_BYTE_STR_M), Some(BankId::StrM));
    assert_eq!(BankId::from_bank_byte(BANK_BYTE_STR_K), Some(BankId::StrK));
    assert_eq!(BankId::from_bank_byte(BANK_BYTE_STR_S), Some(BankId::StrS));
}

#[test]
fn get_returns_none_for_unset_index() {
    let banks = VarBanks::new();
    assert!(banks.get(BankId::IntA, 0).is_none());
    assert!(banks.get(BankId::StrS, 0).is_none());
}

#[test]
fn set_then_get_round_trips_through_sparse_storage() {
    let mut banks = VarBanks::new();
    banks
        .set(BankId::IntA, 0, Value::Int(42))
        .expect("clean set");
    banks
        .set(BankId::IntF, 7, Value::Int(-1))
        .expect("clean set");
    assert_eq!(banks.get(BankId::IntA, 0), Some(Value::Int(42)));
    assert_eq!(banks.get(BankId::IntF, 7), Some(Value::Int(-1)));
    assert_eq!(banks.get(BankId::IntA, 1), None);
}

#[test]
fn out_of_range_set_emits_warning_and_clamps() {
    let mut banks = VarBanks::new();
    let err = banks
        .set(BankId::IntA, 2_000, Value::Int(99))
        .expect_err("out of range");
    match err {
        VarBanksWarning::BankIndexOutOfRange {
            bank,
            requested,
            cap,
        } => {
            assert_eq!(bank, "intA");
            assert_eq!(requested, 2_000);
            assert_eq!(cap, BANK_INDEX_CAP);
        }
    }
    // Clamped write landed at cap - 1.
    assert_eq!(
        banks.get(BankId::IntA, BANK_INDEX_CAP - 1),
        Some(Value::Int(99))
    );
}

#[test]
fn str_bank_round_trips_raw_shift_jis_bytes() {
    let mut banks = VarBanks::new();
    // High-bit Shift-JIS bytes: 0x82 0xa0 = ｱ in half-width Katakana
    // 0x5C is the half-width yen sign / Windows backslash. These
    // bytes are NOT valid UTF-8 and would be lost by any String
    // conversion.
    let bytes = vec![0x82, 0xa0, 0x5c, 0xff, 0x00, 0x01];
    banks
        .set(BankId::StrS, 0, Value::Str(bytes.clone()))
        .expect("clean str set");
    assert_eq!(banks.get(BankId::StrS, 0), Some(Value::Str(bytes)));
}

#[test]
fn hex_round_trips_through_helper_functions() {
    let bytes = vec![0x00, 0x7f, 0x80, 0xff];
    let hex = bytes_to_hex(&bytes);
    assert_eq!(hex, "007f80ff");
    let parsed = hex_to_bytes(&hex).expect("clean parse");
    assert_eq!(parsed, bytes);
}

#[test]
fn store_register_round_trips_through_setter() {
    let mut banks = VarBanks::new();
    banks.set_store(0xDEAD_BEEF);
    assert_eq!(banks.store(), 0xDEAD_BEEF);
}
