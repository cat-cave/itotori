use super::*;

#[test]
fn int_literal_evaluates_to_itself() {
    let banks = VarBanks::new();
    assert_eq!(evaluate(&ExprNode::IntLiteral(42), &banks).unwrap(), 42);
}

#[test]
fn store_register_round_trip() {
    let mut banks = VarBanks::new();
    banks.set_store(7);
    assert_eq!(evaluate(&ExprNode::StoreRegister, &banks).unwrap(), 7);
}

#[test]
fn memory_ref_reads_intb_zero() {
    let mut banks = VarBanks::new();
    banks
        .set(BankId::IntB, 0, Value::Int(10))
        .expect("clean set");
    let node = ExprNode::MemoryRef {
        bank: 0x01,
        index: Box::new(ExprNode::IntLiteral(0)),
    };
    assert_eq!(evaluate(&node, &banks).unwrap(), 10);
}

#[test]
fn memory_ref_unset_index_reads_as_zero() {
    let banks = VarBanks::new();
    let node = ExprNode::MemoryRef {
        bank: 0x01,
        index: Box::new(ExprNode::IntLiteral(42)),
    };
    assert_eq!(evaluate(&node, &banks).unwrap(), 0);
}

#[test]
fn division_by_zero_is_typed_error_not_panic() {
    let banks = VarBanks::new();
    let node = ExprNode::BinaryOp {
        op: ExprOp::Div,
        lhs: Box::new(ExprNode::IntLiteral(5)),
        rhs: Box::new(ExprNode::IntLiteral(0)),
    };
    match evaluate(&node, &banks) {
        Err(EvaluationError::DivisionByZero) => {}
        other => panic!("expected DivisionByZero, got {other:?}"),
    }
}

#[test]
fn modulo_by_zero_is_typed_error_not_panic() {
    let banks = VarBanks::new();
    let node = ExprNode::BinaryOp {
        op: ExprOp::Mod,
        lhs: Box::new(ExprNode::IntLiteral(5)),
        rhs: Box::new(ExprNode::IntLiteral(0)),
    };
    assert!(matches!(
        evaluate(&node, &banks),
        Err(EvaluationError::DivisionByZero)
    ));
}

#[test]
fn bank_byte_table_maps_documented_letters() {
    // Zero-indexed encoding: 0x00=intA,..., 0x0C=intM.
    assert_eq!(bank_byte_to_index(0x00).unwrap(), 0);
    assert_eq!(bank_byte_to_index(0x01).unwrap(), 1);
    assert_eq!(bank_byte_to_index(0x0C).unwrap(), 12);
    assert!(bank_byte_to_index(0x0D).is_err());
    assert!(bank_byte_to_index(0xFF).is_err());
}

#[test]
fn out_of_range_bank_index_is_typed_error() {
    let mut banks = VarBanks::new();
    let res = write_int_bank(&mut banks, 0x01, BANK_INDEX_CAP as i32, 1);
    assert!(matches!(
        res,
        Err(EvaluationError::BankIndexOutOfRange { .. })
    ));
}

#[test]
fn evaluate_assignment_writes_into_intb() {
    let mut banks = VarBanks::new();
    let node = ExprNode::Assignment {
        dest: Box::new(ExprNode::MemoryRef {
            bank: 0x01,
            index: Box::new(ExprNode::IntLiteral(0)),
        }),
        op: AssignOp::Plain,
        src: Box::new(ExprNode::IntLiteral(7)),
    };
    let result = evaluate_assignment(&node, &mut banks).unwrap();
    assert_eq!(result, 7);
    assert_eq!(banks.get(BankId::IntB, 0), Some(Value::Int(7)));
}

#[test]
fn evaluate_compound_add_assign() {
    let mut banks = VarBanks::new();
    banks
        .set(BankId::IntB, 0, Value::Int(5))
        .expect("clean set");
    let node = ExprNode::Assignment {
        dest: Box::new(ExprNode::MemoryRef {
            bank: 0x01,
            index: Box::new(ExprNode::IntLiteral(0)),
        }),
        op: AssignOp::AddAssign,
        src: Box::new(ExprNode::IntLiteral(3)),
    };
    evaluate_assignment(&node, &mut banks).unwrap();
    assert_eq!(banks.get(BankId::IntB, 0), Some(Value::Int(8)));
}

#[test]
fn logical_and_short_circuits_on_false_lhs() {
    let banks = VarBanks::new();
    // If RHS were evaluated it would division-by-zero. The
    // short-circuit must skip it.
    let node = ExprNode::BinaryOp {
        op: ExprOp::LogicAnd,
        lhs: Box::new(ExprNode::IntLiteral(0)),
        rhs: Box::new(ExprNode::BinaryOp {
            op: ExprOp::Div,
            lhs: Box::new(ExprNode::IntLiteral(1)),
            rhs: Box::new(ExprNode::IntLiteral(0)),
        }),
    };
    assert_eq!(evaluate(&node, &banks).unwrap(), 0);
}

#[test]
fn logical_or_short_circuits_on_true_lhs() {
    let banks = VarBanks::new();
    let node = ExprNode::BinaryOp {
        op: ExprOp::LogicOr,
        lhs: Box::new(ExprNode::IntLiteral(1)),
        rhs: Box::new(ExprNode::BinaryOp {
            op: ExprOp::Div,
            lhs: Box::new(ExprNode::IntLiteral(1)),
            rhs: Box::new(ExprNode::IntLiteral(0)),
        }),
    };
    assert_eq!(evaluate(&node, &banks).unwrap(), 1);
}
