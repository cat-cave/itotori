use super::*;
use crate::expression::{BANK_BYTE_INT_A, BANK_BYTE_INT_B};

fn int_arg(value: i32) -> ExprValue {
    ExprValue::Int(value)
}

fn int_ref(bank_byte: u8, idx: u16) -> Vec<ExprValue> {
    vec![int_arg(bank_byte as i32), int_arg(idx as i32)]
}

fn args(parts: Vec<Vec<ExprValue>>) -> Vec<ExprValue> {
    let mut out = Vec::new();
    for part in parts {
        out.extend(part);
    }
    out
}

fn read_int(vm: &Vm, bank: BankId, idx: u16) -> i32 {
    match vm.banks().get(bank, idx) {
        Some(Value::Int(value)) => value,
        _ => 0,
    }
}

#[test]
fn mem_register_helper_populates_expected_count() {
    let mut registry = RlopRegistry::new();
    let count = register_mem_rlops(&mut registry);
    assert_eq!(count, MEM_RLOP_COUNT);
    assert_eq!(registry.len(), MEM_RLOP_COUNT);
    for op in MemOpcode::ALL {
        assert!(registry.get(op.rlop_key()).is_some(), "{op:?} must resolve",);
    }
}

#[test]
fn mem_opcode_byte_values_are_distinct() {
    let mut seen = std::collections::HashSet::new();
    for op in MemOpcode::ALL {
        assert!(seen.insert(op.opcode()), "duplicate opcode for {op:?}");
    }
}

// Acceptance: `mem_setarray_stepped_table` — input/output table
// for setarray_stepped with ≥3 cases incl. boundary.

#[test]
fn mem_setarray_stepped_table_three_cases() {
    // Case 1: step=2, n=3 → indices 0, 2, 4 get the values.
    let mut vm = Vm::new(1, 0);
    SetarrayStepped.dispatch(
        &mut vm,
        &args(vec![
            int_ref(BANK_BYTE_INT_A, 0),
            vec![
                int_arg(2),
                int_arg(3),
                int_arg(10),
                int_arg(20),
                int_arg(30),
            ],
        ]),
    );
    assert_eq!(read_int(&vm, BankId::IntA, 0), 10);
    assert_eq!(read_int(&vm, BankId::IntA, 1), 0);
    assert_eq!(read_int(&vm, BankId::IntA, 2), 20);
    assert_eq!(read_int(&vm, BankId::IntA, 3), 0);
    assert_eq!(read_int(&vm, BankId::IntA, 4), 30);
    // Case 2: step=5, n=2 → indices 100, 105.
    SetarrayStepped.dispatch(
        &mut vm,
        &args(vec![
            int_ref(BANK_BYTE_INT_A, 100),
            vec![int_arg(5), int_arg(2), int_arg(7), int_arg(9)],
        ]),
    );
    assert_eq!(read_int(&vm, BankId::IntA, 100), 7);
    assert_eq!(read_int(&vm, BankId::IntA, 105), 9);
    // Boundary: n=0 → no writes, no warnings.
    let mut vm2 = Vm::new(1, 0);
    SetarrayStepped.dispatch(
        &mut vm2,
        &args(vec![
            int_ref(BANK_BYTE_INT_A, 50),
            vec![int_arg(3), int_arg(0)],
        ]),
    );
    assert_eq!(read_int(&vm2, BankId::IntA, 50), 0);
    assert!(vm2.warnings().is_empty());
}

#[test]
fn mem_setarray_stepped_boundary_max_u16_index_clamps() {
    // Boundary: writing at idx = BANK_INDEX_CAP - 1 (= 1999) lands.
    let mut vm = Vm::new(1, 0);
    SetarrayStepped.dispatch(
        &mut vm,
        &args(vec![
            int_ref(BANK_BYTE_INT_A, 1999),
            vec![int_arg(1), int_arg(1), int_arg(123)],
        ]),
    );
    assert_eq!(read_int(&vm, BankId::IntA, 1999), 123);
    // Writing at idx = BANK_INDEX_CAP (= 2000) clamps + warns
    // (per VarBanksWarning::BankIndexOutOfRange).
    SetarrayStepped.dispatch(
        &mut vm,
        &args(vec![
            int_ref(BANK_BYTE_INT_A, 2000),
            vec![int_arg(1), int_arg(1), int_arg(456)],
        ]),
    );
    // Write landed at the clamped idx (1999); but our dispatch
    // converts the warning into a RlopArgsInvalid (not a panic).
    let warnings = vm.take_warnings();
    assert!(warnings.iter().any(|w| matches!(
        w,
        VmWarning::RlopArgsInvalid {
            op: "mem.setarray_stepped",
            ..
        }
    )));
}

#[test]
fn mem_setrng_stepped_table_three_cases() {
    let mut vm = Vm::new(1, 0);
    // Case 1: step=2, n=3, value=7 → indices 0/2/4 = 7.
    SetrngStepped.dispatch(
        &mut vm,
        &args(vec![
            int_ref(BANK_BYTE_INT_A, 0),
            vec![int_arg(2), int_arg(3), int_arg(7)],
        ]),
    );
    assert_eq!(read_int(&vm, BankId::IntA, 0), 7);
    assert_eq!(read_int(&vm, BankId::IntA, 2), 7);
    assert_eq!(read_int(&vm, BankId::IntA, 4), 7);
    assert_eq!(read_int(&vm, BankId::IntA, 1), 0);
    // Case 2: step=1, n=5, value=42 → contiguous fill.
    SetrngStepped.dispatch(
        &mut vm,
        &args(vec![
            int_ref(BANK_BYTE_INT_A, 100),
            vec![int_arg(1), int_arg(5), int_arg(42)],
        ]),
    );
    for idx in 100u16..105 {
        assert_eq!(read_int(&vm, BankId::IntA, idx), 42);
    }
    // Boundary: n=0 → no writes.
    SetrngStepped.dispatch(
        &mut vm,
        &args(vec![
            int_ref(BANK_BYTE_INT_A, 200),
            vec![int_arg(1), int_arg(0), int_arg(99)],
        ]),
    );
    assert_eq!(read_int(&vm, BankId::IntA, 200), 0);
}

#[test]
fn mem_setarray_three_cases() {
    let mut vm = Vm::new(1, 0);
    // Case 1: three values.
    SetarrayOp.dispatch(
        &mut vm,
        &args(vec![
            int_ref(BANK_BYTE_INT_A, 0),
            vec![int_arg(3), int_arg(1), int_arg(2), int_arg(3)],
        ]),
    );
    assert_eq!(read_int(&vm, BankId::IntA, 0), 1);
    assert_eq!(read_int(&vm, BankId::IntA, 1), 2);
    assert_eq!(read_int(&vm, BankId::IntA, 2), 3);
    // Case 2: single value.
    SetarrayOp.dispatch(
        &mut vm,
        &args(vec![
            int_ref(BANK_BYTE_INT_A, 10),
            vec![int_arg(1), int_arg(42)],
        ]),
    );
    assert_eq!(read_int(&vm, BankId::IntA, 10), 42);
    // Boundary: zero count → no writes.
    SetarrayOp.dispatch(
        &mut vm,
        &args(vec![int_ref(BANK_BYTE_INT_A, 20), vec![int_arg(0)]]),
    );
    assert_eq!(read_int(&vm, BankId::IntA, 20), 0);
}

#[test]
fn mem_setrng_three_cases() {
    let mut vm = Vm::new(1, 0);
    // Case 1: inclusive range.
    SetrngOp.dispatch(
        &mut vm,
        &args(vec![
            int_ref(BANK_BYTE_INT_A, 0),
            vec![int_arg(3), int_arg(99)],
        ]),
    );
    for idx in 0u16..=3 {
        assert_eq!(read_int(&vm, BankId::IntA, idx), 99);
    }
    // Case 2: single-element range.
    SetrngOp.dispatch(
        &mut vm,
        &args(vec![
            int_ref(BANK_BYTE_INT_A, 100),
            vec![int_arg(100), int_arg(7)],
        ]),
    );
    assert_eq!(read_int(&vm, BankId::IntA, 100), 7);
    // Boundary: end < start → zero-size, no writes.
    SetrngOp.dispatch(
        &mut vm,
        &args(vec![
            int_ref(BANK_BYTE_INT_A, 200),
            vec![int_arg(199), int_arg(42)],
        ]),
    );
    assert_eq!(read_int(&vm, BankId::IntA, 200), 0);
}

#[test]
fn mem_cpyrng_three_cases() {
    let mut vm = Vm::new(1, 0);
    // Seed the source range.
    for (i, value) in [10, 20, 30].into_iter().enumerate() {
        vm.banks_mut()
            .set(BankId::IntA, i as u16, Value::Int(value))
            .expect("seed");
    }
    // Case 1: cross-bank copy.
    CpyrngOp.dispatch(
        &mut vm,
        &args(vec![
            int_ref(BANK_BYTE_INT_B, 0),
            int_ref(BANK_BYTE_INT_A, 0),
            vec![int_arg(3)],
        ]),
    );
    assert_eq!(read_int(&vm, BankId::IntB, 0), 10);
    assert_eq!(read_int(&vm, BankId::IntB, 1), 20);
    assert_eq!(read_int(&vm, BankId::IntB, 2), 30);
    // Case 2: in-bank overlapping copy (dst > src).
    CpyrngOp.dispatch(
        &mut vm,
        &args(vec![
            int_ref(BANK_BYTE_INT_A, 5),
            int_ref(BANK_BYTE_INT_A, 0),
            vec![int_arg(3)],
        ]),
    );
    assert_eq!(read_int(&vm, BankId::IntA, 5), 10);
    assert_eq!(read_int(&vm, BankId::IntA, 6), 20);
    assert_eq!(read_int(&vm, BankId::IntA, 7), 30);
    // Boundary: zero-count copy.
    CpyrngOp.dispatch(
        &mut vm,
        &args(vec![
            int_ref(BANK_BYTE_INT_B, 100),
            int_ref(BANK_BYTE_INT_A, 0),
            vec![int_arg(0)],
        ]),
    );
    assert_eq!(read_int(&vm, BankId::IntB, 100), 0);
}

#[test]
fn mem_cpyvars_three_cases() {
    let mut vm = Vm::new(1, 0);
    // Seed sources.
    vm.banks_mut()
        .set(BankId::IntA, 0, Value::Int(11))
        .expect("seed");
    vm.banks_mut()
        .set(BankId::IntA, 1, Value::Int(22))
        .expect("seed");
    // Case 1: two pairs.
    CpyvarsOp.dispatch(
        &mut vm,
        &args(vec![
            vec![int_arg(2)],
            int_ref(BANK_BYTE_INT_B, 0),
            int_ref(BANK_BYTE_INT_A, 0),
            int_ref(BANK_BYTE_INT_B, 1),
            int_ref(BANK_BYTE_INT_A, 1),
        ]),
    );
    assert_eq!(read_int(&vm, BankId::IntB, 0), 11);
    assert_eq!(read_int(&vm, BankId::IntB, 1), 22);
    // Case 2: single pair.
    CpyvarsOp.dispatch(
        &mut vm,
        &args(vec![
            vec![int_arg(1)],
            int_ref(BANK_BYTE_INT_B, 99),
            int_ref(BANK_BYTE_INT_A, 0),
        ]),
    );
    assert_eq!(read_int(&vm, BankId::IntB, 99), 11);
    // Boundary: k=0 → no writes.
    CpyvarsOp.dispatch(&mut vm, &args(vec![vec![int_arg(0)]]));
    // No new writes.
}

#[test]
fn mem_sum_three_cases() {
    let mut vm = Vm::new(1, 0);
    // Seed: intA[0..=2] = 1, 2, 3.
    for (i, value) in [1, 2, 3].into_iter().enumerate() {
        vm.banks_mut()
            .set(BankId::IntA, i as u16, Value::Int(value))
            .expect("seed");
    }
    // Case 1: non-empty range.
    SumOp.dispatch(
        &mut vm,
        &args(vec![
            int_ref(BANK_BYTE_INT_B, 0),
            int_ref(BANK_BYTE_INT_A, 0),
            vec![int_arg(2)],
        ]),
    );
    assert_eq!(read_int(&vm, BankId::IntB, 0), 6);
    // Case 2: single-element range.
    SumOp.dispatch(
        &mut vm,
        &args(vec![
            int_ref(BANK_BYTE_INT_B, 1),
            int_ref(BANK_BYTE_INT_A, 1),
            vec![int_arg(1)],
        ]),
    );
    assert_eq!(read_int(&vm, BankId::IntB, 1), 2);
    // Boundary: empty range (end < start) → 0.
    SumOp.dispatch(
        &mut vm,
        &args(vec![
            int_ref(BANK_BYTE_INT_B, 2),
            int_ref(BANK_BYTE_INT_A, 10),
            vec![int_arg(0)],
        ]),
    );
    assert_eq!(read_int(&vm, BankId::IntB, 2), 0);
}

#[test]
fn mem_sums_three_cases() {
    let mut vm = Vm::new(1, 0);
    // Seed: intA[0..=2] = 1, 2, 3; intA[10..=11] = 100, 200.
    for (i, value) in [1, 2, 3].into_iter().enumerate() {
        vm.banks_mut()
            .set(BankId::IntA, i as u16, Value::Int(value))
            .expect("seed");
    }
    vm.banks_mut()
        .set(BankId::IntA, 10, Value::Int(100))
        .expect("seed");
    vm.banks_mut()
        .set(BankId::IntA, 11, Value::Int(200))
        .expect("seed");
    // Case 1: two ranges.
    SumsOp.dispatch(
        &mut vm,
        &args(vec![
            int_ref(BANK_BYTE_INT_B, 0),
            vec![int_arg(2)],
            int_ref(BANK_BYTE_INT_A, 0),
            vec![int_arg(2)],
            int_ref(BANK_BYTE_INT_A, 10),
            vec![int_arg(11)],
        ]),
    );
    assert_eq!(read_int(&vm, BankId::IntB, 0), 6 + 300);
    // Case 2: single range.
    SumsOp.dispatch(
        &mut vm,
        &args(vec![
            int_ref(BANK_BYTE_INT_B, 1),
            vec![int_arg(1)],
            int_ref(BANK_BYTE_INT_A, 0),
            vec![int_arg(0)],
        ]),
    );
    assert_eq!(read_int(&vm, BankId::IntB, 1), 1);
    // Boundary: zero ranges → 0.
    SumsOp.dispatch(
        &mut vm,
        &args(vec![int_ref(BANK_BYTE_INT_B, 2), vec![int_arg(0)]]),
    );
    assert_eq!(read_int(&vm, BankId::IntB, 2), 0);
}

#[test]
fn setarray_with_non_int_bank_warns() {
    let mut vm = Vm::new(1, 0);
    // strS = 0x12; not an int bank.
    SetarrayOp.dispatch(
        &mut vm,
        &args(vec![vec![
            int_arg(0x12),
            int_arg(0),
            int_arg(1),
            int_arg(99),
        ]]),
    );
    let warnings = vm.take_warnings();
    assert_eq!(warnings.len(), 1);
    assert!(matches!(
        warnings[0],
        VmWarning::RlopArgsInvalid {
            op: "mem.setarray",
            ..
        }
    ));
}
