use super::*;

use std::sync::Mutex;

use utsushi_core::substrate::{SinkCapability, SinkResult};

use crate::expression::BANK_BYTE_INT_A;

/// Bank byte for `strS`.
const BANK_BYTE_STR_S: u8 = 0x12;
/// Bank byte for `strM`.
const BANK_BYTE_STR_M: u8 = 0x0D;

fn int_arg(value: i32) -> ExprValue {
    ExprValue::Int(value)
}

fn bytes_arg(value: &[u8]) -> ExprValue {
    ExprValue::Bytes(value.to_vec())
}

fn str_ref(bank_byte: u8, idx: u16) -> Vec<ExprValue> {
    vec![int_arg(bank_byte as i32), int_arg(idx as i32)]
}

fn int_ref(bank_byte: u8, idx: u16) -> Vec<ExprValue> {
    vec![int_arg(bank_byte as i32), int_arg(idx as i32)]
}

/// Concatenate the argument vectors. Convenience for assembling
/// the `(dst_ref, src_ref…)` arg lists the table-style tests use.
fn args(parts: Vec<Vec<ExprValue>>) -> Vec<ExprValue> {
    let mut out = Vec::new();
    for part in parts {
        out.extend(part);
    }
    out
}

#[derive(Default)]
struct CollectingSink {
    lines: Mutex<Vec<TextLine>>,
}

impl TextSurfaceSink for CollectingSink {
    fn capability(&self) -> SinkCapability {
        SinkCapability::Supported {
            evidence_tier_ceiling: EvidenceTier::E1,
        }
    }

    fn emit_line(&self, line: TextLine) -> SinkResult<()> {
        line.validate()?;
        self.lines.lock().expect("lock").push(line);
        Ok(())
    }
}

fn make_runtime() -> (Arc<StrRuntime>, Arc<CollectingSink>) {
    let sink = Arc::new(CollectingSink::default());
    let runtime = Arc::new(StrRuntime::new(
        Arc::clone(&sink) as Arc<dyn TextSurfaceSink>
    ));
    (runtime, sink)
}

fn run<R: RLOperation>(op: &R, args: &[ExprValue]) -> Vm {
    let mut vm = Vm::new(1, 0);
    op.dispatch(&mut vm, args);
    vm
}

fn read_str(vm: &Vm, bank: BankId, idx: u16) -> Vec<u8> {
    match vm.banks().get(bank, idx) {
        Some(Value::Str(bytes)) => bytes,
        _ => Vec::new(),
    }
}

fn read_int(vm: &Vm, bank: BankId, idx: u16) -> i32 {
    match vm.banks().get(bank, idx) {
        Some(Value::Int(value)) => value,
        _ => 0,
    }
}

// Acceptance: register_helper covers exactly STR_RLOP_COUNT opcodes

#[test]
fn str_register_helper_populates_expected_count() {
    let (runtime, _sink) = make_runtime();
    let mut registry = RlopRegistry::new();
    let count = register_str_rlops(&mut registry, runtime);
    assert_eq!(count, STR_RLOP_COUNT);
    assert_eq!(registry.len(), STR_RLOP_COUNT);
    for op in StrOpcode::ALL {
        assert!(registry.get(op.rlop_key()).is_some(), "{op:?} must resolve",);
    }
}

#[test]
fn str_opcode_byte_values_are_distinct() {
    let mut seen = std::collections::HashSet::new();
    for op in StrOpcode::ALL {
        assert!(seen.insert(op.opcode()), "duplicate opcode for {op:?}");
    }
}

// Acceptance: `str_ops_table` — input/output table for each op
// with ≥3 cases including a boundary.

#[test]
fn str_ops_table_strcpy_three_cases() {
    // Case 1: literal-bytes source → dst slot holds the bytes.
    let mut vm = Vm::new(1, 0);
    StrcpyOp.dispatch(
        &mut vm,
        &args(vec![str_ref(BANK_BYTE_STR_S, 0), vec![bytes_arg(b"hi")]]),
    );
    assert_eq!(read_str(&vm, BankId::StrS, 0), b"hi".to_vec());
    // Case 2: bank-source → dst.
    vm.banks_mut()
        .set(BankId::StrS, 5, Value::Str(b"there".to_vec()))
        .expect("seed");
    StrcpyOp.dispatch(
        &mut vm,
        &args(vec![
            str_ref(BANK_BYTE_STR_M, 0),
            str_ref(BANK_BYTE_STR_S, 5),
        ]),
    );
    assert_eq!(read_str(&vm, BankId::StrM, 0), b"there".to_vec());
    // Boundary: empty-string copy.
    StrcpyOp.dispatch(
        &mut vm,
        &args(vec![str_ref(BANK_BYTE_STR_S, 1), vec![bytes_arg(b"")]]),
    );
    assert_eq!(read_str(&vm, BankId::StrS, 1), Vec::<u8>::new());
}

#[test]
fn str_ops_table_strcat_three_cases() {
    // Case 1: empty dst + new bytes → new bytes.
    let mut vm = Vm::new(1, 0);
    StrcatOp.dispatch(
        &mut vm,
        &args(vec![str_ref(BANK_BYTE_STR_S, 0), vec![bytes_arg(b"abc")]]),
    );
    assert_eq!(read_str(&vm, BankId::StrS, 0), b"abc".to_vec());
    // Case 2: existing dst + new bytes → concat.
    StrcatOp.dispatch(
        &mut vm,
        &args(vec![str_ref(BANK_BYTE_STR_S, 0), vec![bytes_arg(b"def")]]),
    );
    assert_eq!(read_str(&vm, BankId::StrS, 0), b"abcdef".to_vec());
    // Boundary: append empty → no change.
    StrcatOp.dispatch(
        &mut vm,
        &args(vec![str_ref(BANK_BYTE_STR_S, 0), vec![bytes_arg(b"")]]),
    );
    assert_eq!(read_str(&vm, BankId::StrS, 0), b"abcdef".to_vec());
}

#[test]
fn str_ops_table_strlen_three_cases() {
    let mut vm = Vm::new(1, 0);
    // Case 1: non-empty.
    StrlenOp.dispatch(
        &mut vm,
        &args(vec![int_ref(BANK_BYTE_INT_A, 0), vec![bytes_arg(b"abc")]]),
    );
    assert_eq!(read_int(&vm, BankId::IntA, 0), 3);
    // Case 2: shift-jis pair.
    StrlenOp.dispatch(
        &mut vm,
        &args(vec![
            int_ref(BANK_BYTE_INT_A, 1),
            vec![bytes_arg(&[0x82, 0xa0])],
        ]),
    );
    assert_eq!(read_int(&vm, BankId::IntA, 1), 2);
    // Boundary: empty.
    StrlenOp.dispatch(
        &mut vm,
        &args(vec![int_ref(BANK_BYTE_INT_A, 2), vec![bytes_arg(b"")]]),
    );
    assert_eq!(read_int(&vm, BankId::IntA, 2), 0);
}

#[test]
fn str_ops_table_strout_emits_three_cases_through_sink() {
    let (runtime, sink) = make_runtime();
    let op = StroutOp::new(runtime);
    // Case 1: literal ASCII.
    let _ = run(&op, &[bytes_arg(b"hello")]);
    // Case 2: literal shift-jis あ.
    let _ = run(&op, &[bytes_arg(&[0x82, 0xa0])]);
    // Boundary: empty.
    let _ = run(&op, &[bytes_arg(b"")]);
    let lines = sink.lines.lock().expect("lock");
    assert_eq!(lines.len(), 3);
    assert_eq!(lines[0].text, "hello");
    assert_eq!(lines[1].text, "\u{3042}");
    assert_eq!(lines[2].text, "");
    for line in &*lines {
        assert_eq!(line.text_surface.as_deref(), Some("strout"));
    }
}

#[test]
fn str_ops_table_intout_emits_three_cases_through_sink() {
    let (runtime, sink) = make_runtime();
    let op = IntoutOp::new(runtime);
    // Case 1: positive.
    let _ = run(&op, &[int_arg(42)]);
    // Case 2: negative.
    let _ = run(&op, &[int_arg(-7)]);
    // Boundary: i32::MIN.
    let _ = run(&op, &[int_arg(i32::MIN)]);
    let lines = sink.lines.lock().expect("lock");
    assert_eq!(lines.len(), 3);
    assert_eq!(lines[0].text, "42");
    assert_eq!(lines[1].text, "-7");
    assert_eq!(lines[2].text, "-2147483648");
}

#[test]
fn str_ops_table_uppercase_three_cases_including_fullwidth_pass_through() {
    let mut vm = Vm::new(1, 0);
    // Case 1: ASCII lower.
    vm.banks_mut()
        .set(BankId::StrS, 0, Value::Str(b"abc".to_vec()))
        .expect("seed");
    UppercaseOp.dispatch(&mut vm, &str_ref(BANK_BYTE_STR_S, 0));
    assert_eq!(read_str(&vm, BankId::StrS, 0), b"ABC".to_vec());
    // Case 2: mixed.
    vm.banks_mut()
        .set(BankId::StrS, 1, Value::Str(b"AbCd1!".to_vec()))
        .expect("seed");
    UppercaseOp.dispatch(&mut vm, &str_ref(BANK_BYTE_STR_S, 1));
    assert_eq!(read_str(&vm, BankId::StrS, 1), b"ABCD1!".to_vec());
    // Boundary: full-width 'Ａ' (0x82 0x60) stays unchanged — RLDEV
    // acceptance criterion in the spec: `Uppercase("ＡＢＣ")`
    // returns `"ＡＢＣ"` (already upper-case shape).
    let fullwidth_abc = vec![0x82, 0x60, 0x82, 0x61, 0x82, 0x62];
    vm.banks_mut()
        .set(BankId::StrS, 2, Value::Str(fullwidth_abc.clone()))
        .expect("seed");
    UppercaseOp.dispatch(&mut vm, &str_ref(BANK_BYTE_STR_S, 2));
    assert_eq!(read_str(&vm, BankId::StrS, 2), fullwidth_abc);
}

#[test]
fn str_ops_table_lowercase_three_cases() {
    let mut vm = Vm::new(1, 0);
    vm.banks_mut()
        .set(BankId::StrS, 0, Value::Str(b"ABC".to_vec()))
        .expect("seed");
    LowercaseOp.dispatch(&mut vm, &str_ref(BANK_BYTE_STR_S, 0));
    assert_eq!(read_str(&vm, BankId::StrS, 0), b"abc".to_vec());
    vm.banks_mut()
        .set(BankId::StrS, 1, Value::Str(b"AbCd1!".to_vec()))
        .expect("seed");
    LowercaseOp.dispatch(&mut vm, &str_ref(BANK_BYTE_STR_S, 1));
    assert_eq!(read_str(&vm, BankId::StrS, 1), b"abcd1!".to_vec());
    // Boundary: empty.
    LowercaseOp.dispatch(&mut vm, &str_ref(BANK_BYTE_STR_S, 2));
    assert_eq!(read_str(&vm, BankId::StrS, 2), Vec::<u8>::new());
}

#[test]
fn str_ops_table_itoa_three_cases() {
    let mut vm = Vm::new(1, 0);
    // Case 1: positive literal.
    ItoaOp.dispatch(
        &mut vm,
        &args(vec![str_ref(BANK_BYTE_STR_S, 0), vec![int_arg(42)]]),
    );
    assert_eq!(read_str(&vm, BankId::StrS, 0), b"42".to_vec());
    // Case 2: negative literal.
    ItoaOp.dispatch(
        &mut vm,
        &args(vec![str_ref(BANK_BYTE_STR_S, 1), vec![int_arg(-7)]]),
    );
    assert_eq!(read_str(&vm, BankId::StrS, 1), b"-7".to_vec());
    // Boundary: zero.
    ItoaOp.dispatch(
        &mut vm,
        &args(vec![str_ref(BANK_BYTE_STR_S, 2), vec![int_arg(0)]]),
    );
    assert_eq!(read_str(&vm, BankId::StrS, 2), b"0".to_vec());
}

#[test]
fn str_ops_table_atoi_three_cases() {
    let mut vm = Vm::new(1, 0);
    AtoiOp.dispatch(
        &mut vm,
        &args(vec![int_ref(BANK_BYTE_INT_A, 0), vec![bytes_arg(b"42")]]),
    );
    assert_eq!(read_int(&vm, BankId::IntA, 0), 42);
    AtoiOp.dispatch(
        &mut vm,
        &args(vec![int_ref(BANK_BYTE_INT_A, 1), vec![bytes_arg(b"-7abc")]]),
    );
    assert_eq!(read_int(&vm, BankId::IntA, 1), -7);
    // Boundary: empty → 0.
    AtoiOp.dispatch(
        &mut vm,
        &args(vec![int_ref(BANK_BYTE_INT_A, 2), vec![bytes_arg(b"")]]),
    );
    assert_eq!(read_int(&vm, BankId::IntA, 2), 0);
}

#[test]
fn str_ops_table_strpos_three_cases() {
    let mut vm = Vm::new(1, 0);
    // Case 1: hit.
    StrposOp.dispatch(
        &mut vm,
        &args(vec![
            int_ref(BANK_BYTE_INT_A, 0),
            vec![bytes_arg(b"foobar"), bytes_arg(b"bar")],
        ]),
    );
    assert_eq!(read_int(&vm, BankId::IntA, 0), 3);
    // Case 2: miss → -1.
    StrposOp.dispatch(
        &mut vm,
        &args(vec![
            int_ref(BANK_BYTE_INT_A, 1),
            vec![bytes_arg(b"foobar"), bytes_arg(b"zzz")],
        ]),
    );
    assert_eq!(read_int(&vm, BankId::IntA, 1), -1);
    // Boundary: empty needle → 0.
    StrposOp.dispatch(
        &mut vm,
        &args(vec![
            int_ref(BANK_BYTE_INT_A, 2),
            vec![bytes_arg(b"foobar"), bytes_arg(b"")],
        ]),
    );
    assert_eq!(read_int(&vm, BankId::IntA, 2), 0);
}

#[test]
fn str_ops_table_strlpos_three_cases() {
    let mut vm = Vm::new(1, 0);
    // Case 1: hit (last 'b').
    StrlposOp.dispatch(
        &mut vm,
        &args(vec![
            int_ref(BANK_BYTE_INT_A, 0),
            vec![bytes_arg(b"abcabc"), bytes_arg(b"bc")],
        ]),
    );
    assert_eq!(read_int(&vm, BankId::IntA, 0), 4);
    // Case 2: miss → -1.
    StrlposOp.dispatch(
        &mut vm,
        &args(vec![
            int_ref(BANK_BYTE_INT_A, 1),
            vec![bytes_arg(b"abcabc"), bytes_arg(b"zzz")],
        ]),
    );
    assert_eq!(read_int(&vm, BankId::IntA, 1), -1);
    // Boundary: needle longer than haystack → -1.
    StrlposOp.dispatch(
        &mut vm,
        &args(vec![
            int_ref(BANK_BYTE_INT_A, 2),
            vec![bytes_arg(b"ab"), bytes_arg(b"abcd")],
        ]),
    );
    assert_eq!(read_int(&vm, BankId::IntA, 2), -1);
}

#[test]
fn str_ops_table_hantozen_three_cases() {
    let mut vm = Vm::new(1, 0);
    // Case 1: RLDEV acceptance — hantozen("abc") = "ａｂｃ".
    vm.banks_mut()
        .set(BankId::StrS, 0, Value::Str(b"abc".to_vec()))
        .expect("seed");
    HantozenOp.dispatch(&mut vm, &str_ref(BANK_BYTE_STR_S, 0));
    assert_eq!(
        read_str(&vm, BankId::StrS, 0),
        vec![0x82, 0x81, 0x82, 0x82, 0x82, 0x83],
    );
    // Case 2: ASCII digits → fullwidth digits.
    vm.banks_mut()
        .set(BankId::StrS, 1, Value::Str(b"123".to_vec()))
        .expect("seed");
    HantozenOp.dispatch(&mut vm, &str_ref(BANK_BYTE_STR_S, 1));
    assert_eq!(
        read_str(&vm, BankId::StrS, 1),
        vec![0x82, 0x50, 0x82, 0x51, 0x82, 0x52],
    );
    // Boundary: half-width katakana survives the round trip.
    vm.banks_mut()
        .set(BankId::StrS, 2, Value::Str(vec![0xB1]))
        .expect("seed");
    HantozenOp.dispatch(&mut vm, &str_ref(BANK_BYTE_STR_S, 2));
    assert_eq!(read_str(&vm, BankId::StrS, 2), vec![0x83, 0x41]);
}

#[test]
fn str_ops_table_zentohan_three_cases() {
    let mut vm = Vm::new(1, 0);
    // Case 1: fullwidth "ａｂｃ" → "abc".
    vm.banks_mut()
        .set(
            BankId::StrS,
            0,
            Value::Str(vec![0x82, 0x81, 0x82, 0x82, 0x82, 0x83]),
        )
        .expect("seed");
    ZentohanOp.dispatch(&mut vm, &str_ref(BANK_BYTE_STR_S, 0));
    assert_eq!(read_str(&vm, BankId::StrS, 0), b"abc".to_vec());
    // Case 2: fullwidth digits → ASCII digits.
    vm.banks_mut()
        .set(
            BankId::StrS,
            1,
            Value::Str(vec![0x82, 0x50, 0x82, 0x51, 0x82, 0x52]),
        )
        .expect("seed");
    ZentohanOp.dispatch(&mut vm, &str_ref(BANK_BYTE_STR_S, 1));
    assert_eq!(read_str(&vm, BankId::StrS, 1), b"123".to_vec());
    // Boundary: fullwidth katakana → halfwidth.
    vm.banks_mut()
        .set(BankId::StrS, 2, Value::Str(vec![0x83, 0x41]))
        .expect("seed");
    ZentohanOp.dispatch(&mut vm, &str_ref(BANK_BYTE_STR_S, 2));
    assert_eq!(read_str(&vm, BankId::StrS, 2), vec![0xB1]);
}

#[test]
fn hantozen_half_width_katakana_round_trips() {
    // RLDEV pin: every half-width katakana byte 0xA1..=0xDF must
    // hantozen → full-width AND zentohan back to the same byte.
    for byte in 0xA1u8..=0xDFu8 {
        let folded = hantozen_bytes(&[byte]);
        assert_eq!(
            folded.len(),
            2,
            "0x{byte:02x} must land on a 2-byte full-width form",
        );
        let restored = zentohan_bytes(&folded);
        assert_eq!(
            restored,
            vec![byte],
            "0x{byte:02x} did not round-trip through hantozen/zentohan",
        );
    }
}

// Argument validation surfaces — warnings, not panics.

#[test]
fn strcpy_with_missing_dst_warns() {
    let mut vm = Vm::new(1, 0);
    StrcpyOp.dispatch(&mut vm, &[]);
    let warnings = vm.take_warnings();
    assert_eq!(warnings.len(), 1);
    assert!(matches!(
        warnings[0],
        VmWarning::RlopArgsInvalid {
            op: "str.strcpy",
            ..
        }
    ));
}

#[test]
fn strcpy_into_int_bank_warns() {
    let mut vm = Vm::new(1, 0);
    StrcpyOp.dispatch(
        &mut vm,
        &args(vec![int_ref(BANK_BYTE_INT_A, 0), vec![bytes_arg(b"x")]]),
    );
    let warnings = vm.take_warnings();
    assert_eq!(warnings.len(), 1);
}
