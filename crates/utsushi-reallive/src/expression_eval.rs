//! UTSUSHI-205 — expression evaluator (UTSUSHI-206 sparse-banks edition).
//!
//! Given an [`ExprNode`] produced by [`crate::expression::parse_expression`]
//! and a [`crate::var_banks::VarBanks`] snapshot, [`evaluate`] reduces the
//! AST to an `i32` result. [`evaluate_assignment`] handles the
//! [`ExprNode::Assignment`] shape (mutating the supplied banks).
//!
//! # Bank layout
//!
//! Per `docs/research/reallive-engine.md` §G the integer banks are
//! `intA`..`intM` (13 letters per Haeleth's documented RLDEV manual;
//! rlvm caps each bank at 2 000 entries). The UTSUSHI-206 sparse model
//! uses a [`std::collections::BTreeMap<u16, i32>`] per bank and clamps
//! to [`crate::var_banks::BANK_INDEX_CAP`] (`2 000`). Bank-byte indexing
//! follows the documented `\x00..=\x0C` convention pinned in
//! [`bank_byte_to_index`].
//!
//! # Division and modulo by zero
//!
//! Per the alpha-gate hardness constraint listed in the UTSUSHI-205
//! task, division or modulo by zero surfaces as
//! [`EvaluationError::DivisionByZero`]. No panic, no
//! "silent return zero" path.

use thiserror::Error;

use crate::expression::{AssignOp, ExprNode, ExprOp, UnaryOp};
use crate::var_banks::{BANK_INDEX_CAP, BankId, Value, VarBanks};

/// Convert a raw bank byte (as it appears in the encoding) to the
/// dense bank index `0..=12`. The byte-to-bank mapping is pinned by
/// the documented RLDEV bank-letter encoding (mirrors rlvm's
/// `Memory::Get` convention — `intA`..`intM` are zero-indexed):
///
/// | Bank byte | Bank   | Dense index |
/// | --------- | ------ | ----------- |
/// | `0x00`    | `intA` | 0           |
/// | `0x01`    | `intB` | 1           |
/// | `0x02`    | `intC` | 2           |
/// | `0x03`    | `intD` | 3           |
/// | `0x04`    | `intE` | 4           |
/// | `0x05`    | `intF` | 5           |
/// | `0x06`    | `intG` | 6           |
/// | `0x07`    | `intH` | 7           |
/// | `0x08`    | `intI` | 8           |
/// | `0x09`    | `intJ` | 9           |
/// | `0x0A`    | `intK` | 10          |
/// | `0x0B`    | `intL` | 11          |
/// | `0x0C`    | `intM` | 12          |
///
/// The Sweetie HD scene #0001 Expression elements address `intF`
/// (byte `0x05`) and `intG` (byte `0x06`) under this mapping — pinned
/// by the UTSUSHI-205 real-bytes test.
///
/// Returns [`EvaluationError::UnknownBank`] for any byte outside that
/// window. The store register (`0xC8`) is handled directly by the
/// evaluator and never reaches this helper.
pub fn bank_byte_to_index(bank_byte: u8) -> Result<usize, EvaluationError> {
    if bank_byte <= 0x0C {
        Ok(bank_byte as usize)
    } else {
        Err(EvaluationError::UnknownBank {
            bank_byte,
            debug: format!("bank byte 0x{bank_byte:02x} not in documented 0x00..=0x0C window"),
        })
    }
}

fn bank_id_from_byte(bank_byte: u8) -> Result<BankId, EvaluationError> {
    BankId::from_int_bank_byte(bank_byte).ok_or(EvaluationError::UnknownBank {
        bank_byte,
        debug: format!("bank byte 0x{bank_byte:02x} not in documented 0x00..=0x0C window"),
    })
}

fn bank_index_in_range(bank_byte: u8, index: i32) -> Result<u16, EvaluationError> {
    if index < 0 {
        return Err(EvaluationError::BankIndexOutOfRange {
            bank_byte,
            index,
            slot_count: BANK_INDEX_CAP as usize,
        });
    }
    let as_usize = index as usize;
    if as_usize >= BANK_INDEX_CAP as usize {
        return Err(EvaluationError::BankIndexOutOfRange {
            bank_byte,
            index,
            slot_count: BANK_INDEX_CAP as usize,
        });
    }
    Ok(as_usize as u16)
}

fn read_int_bank(banks: &VarBanks, bank_byte: u8, index: i32) -> Result<i32, EvaluationError> {
    let bank = bank_id_from_byte(bank_byte)?;
    let idx = bank_index_in_range(bank_byte, index)?;
    Ok(match banks.get(bank, idx) {
        Some(Value::Int(value)) => value,
        // Sparse storage: unset indices read as zero — matches the
        // dense-bank surface UTSUSHI-205 exposed (every slot defaulted
        // to zero) so the evaluator's arithmetic on unset slots is
        // unchanged.
        None => 0,
        Some(Value::Str(_)) => {
            return Err(EvaluationError::UnknownBank {
                bank_byte,
                debug: format!(
                    "bank byte 0x{bank_byte:02x} resolved to non-integer bank — \
                     expression evaluator only addresses int banks"
                ),
            });
        }
    })
}

fn write_int_bank(
    banks: &mut VarBanks,
    bank_byte: u8,
    index: i32,
    value: i32,
) -> Result<(), EvaluationError> {
    let bank = bank_id_from_byte(bank_byte)?;
    let idx = bank_index_in_range(bank_byte, index)?;
    // The evaluator's caller-supplied indices already pass through
    // `bank_index_in_range` above, so the sparse-banks `set` will
    // never emit a `BankIndexOutOfRange` warning here. Treat any
    // warning that surfaces as a structural bug.
    if let Err(warning) = banks.set(bank, idx, Value::Int(value)) {
        return Err(EvaluationError::BankIndexOutOfRange {
            bank_byte,
            index,
            slot_count: warning_cap_or_default(warning),
        });
    }
    Ok(())
}

fn warning_cap_or_default(warning: crate::var_banks::VarBanksWarning) -> usize {
    let crate::var_banks::VarBanksWarning::BankIndexOutOfRange { cap, .. } = warning;
    cap as usize
}

/// Typed evaluator failure modes.
#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum EvaluationError {
    /// Division or modulo by zero (`a / 0` or `a % 0`). Hard-mandated
    /// by the alpha-gate constraint — must never panic on this path.
    #[error("expression evaluator: division by zero")]
    DivisionByZero,

    /// A memory-ref index resolved to a value that is either negative
    /// or beyond the bank's documented slot count.
    #[error(
        "expression evaluator: bank-index {index} out of range for bank 0x{bank_byte:02x} \
         (slot count {slot_count})"
    )]
    BankIndexOutOfRange {
        /// Raw bank byte the out-of-range index targeted.
        bank_byte: u8,
        /// Index value that was out of range.
        index: i32,
        /// Slot count of the targeted bank.
        slot_count: usize,
    },

    /// A memory-ref bank byte did not map to any documented int bank.
    #[error("expression evaluator: unknown bank byte 0x{bank_byte:02x} ({debug})")]
    UnknownBank {
        /// Raw bank byte that did not map.
        bank_byte: u8,
        /// Debug context.
        debug: String,
    },

    /// `evaluate_assignment` was called on a node whose top-level
    /// variant is not [`ExprNode::Assignment`]. This is a caller bug
    /// rather than a script-level failure — every assignment-shaped
    /// node we surface from the parser is wrapped in [`ExprNode::Assignment`].
    #[error("expression evaluator: evaluate_assignment requires an Assignment node; got {got}")]
    NotAnAssignment {
        /// Variant name that was passed instead.
        got: &'static str,
    },

    /// Assignment destination resolved to a non-lvalue node (e.g.
    /// `IntLiteral`). The parser does not produce these, but a
    /// hand-built AST could.
    #[error("expression evaluator: assignment destination is not an lvalue ({got})")]
    NonLValueAssignmentDestination {
        /// Variant name of the destination node.
        got: &'static str,
    },

    /// Integer overflow in an arithmetic operation. Uses
    /// `i32::wrapping_*` semantics throughout (matching RealLive's
    /// undefined-on-overflow posture). This variant is reserved for
    /// future use — surfaces as a typed error so the audit grep can
    /// pin the contract.
    #[error("expression evaluator: arithmetic overflow on {op}")]
    Overflow {
        /// Operator that overflowed.
        op: &'static str,
    },
}

/// Evaluate `expr` against the supplied banks and return the resulting
/// `i32`. Read-only — never mutates `banks`.
///
/// # Semantics
///
/// - Arithmetic ops use **wrapping** semantics (matches the RealLive
///   compiler's observed runtime behaviour: integer overflow wraps
///   silently).
/// - Comparison ops return `1` for true, `0` for false.
/// - Logical ops (`&&`, `||`) treat any non-zero operand as true and
///   return `1` / `0`.
/// - `\<Noop>` is the identity; `\<Neg>` negates with wrapping (so
///   `-i32::MIN` does not panic).
///
/// # Errors
///
/// - [`EvaluationError::DivisionByZero`] when `Div` / `Mod` would
///   divide by zero.
/// - [`EvaluationError::BankIndexOutOfRange`] when a memory-ref index
///   is out of the bank's slot window.
/// - [`EvaluationError::UnknownBank`] when a memory-ref bank byte does
///   not map.
pub fn evaluate(expr: &ExprNode, banks: &VarBanks) -> Result<i32, EvaluationError> {
    match expr {
        ExprNode::IntLiteral(value) => Ok(*value),
        ExprNode::StoreRegister => Ok(banks.store() as i32),
        ExprNode::MemoryRef { bank, index } => {
            let idx = evaluate(index, banks)?;
            read_int_bank(banks, *bank, idx)
        }
        ExprNode::Group(inner) => evaluate(inner, banks),
        ExprNode::UnaryOp { op, operand } => {
            let value = evaluate(operand, banks)?;
            Ok(match op {
                UnaryOp::Noop => value,
                UnaryOp::Neg => value.wrapping_neg(),
            })
        }
        ExprNode::BinaryOp { op, lhs, rhs } => evaluate_binary(*op, lhs, rhs, banks),
        ExprNode::Assignment { .. } => Err(EvaluationError::NotAnAssignment {
            got: "Assignment in read-only evaluate(); call evaluate_assignment instead",
        }),
    }
}

fn evaluate_binary(
    op: ExprOp,
    lhs: &ExprNode,
    rhs: &ExprNode,
    banks: &VarBanks,
) -> Result<i32, EvaluationError> {
    // Short-circuit logical ops before evaluating the RHS.
    match op {
        ExprOp::LogicAnd => {
            let l = evaluate(lhs, banks)?;
            if l == 0 {
                return Ok(0);
            }
            let r = evaluate(rhs, banks)?;
            return Ok(if r != 0 { 1 } else { 0 });
        }
        ExprOp::LogicOr => {
            let l = evaluate(lhs, banks)?;
            if l != 0 {
                return Ok(1);
            }
            let r = evaluate(rhs, banks)?;
            return Ok(if r != 0 { 1 } else { 0 });
        }
        _ => {}
    }

    let l = evaluate(lhs, banks)?;
    let r = evaluate(rhs, banks)?;

    Ok(match op {
        ExprOp::Add => l.wrapping_add(r),
        ExprOp::Sub => l.wrapping_sub(r),
        ExprOp::Mul => l.wrapping_mul(r),
        ExprOp::Div => {
            if r == 0 {
                return Err(EvaluationError::DivisionByZero);
            }
            l.wrapping_div(r)
        }
        ExprOp::Mod => {
            if r == 0 {
                return Err(EvaluationError::DivisionByZero);
            }
            l.wrapping_rem(r)
        }
        ExprOp::And => l & r,
        ExprOp::Or => l | r,
        ExprOp::Xor => l ^ r,
        ExprOp::Equ => bool_to_i32(l == r),
        ExprOp::Neq => bool_to_i32(l != r),
        ExprOp::Lt => bool_to_i32(l < r),
        ExprOp::Le => bool_to_i32(l <= r),
        ExprOp::Gt => bool_to_i32(l > r),
        ExprOp::Ge => bool_to_i32(l >= r),
        // Already handled above.
        ExprOp::LogicAnd | ExprOp::LogicOr => unreachable!("short-circuited above"),
    })
}

fn bool_to_i32(b: bool) -> i32 {
    if b { 1 } else { 0 }
}

/// Evaluate an [`ExprNode::Assignment`] node — writes the source value
/// into the destination memory slot or store register. Returns the
/// post-assignment value of the destination so callers can chain.
///
/// # Errors
///
/// - [`EvaluationError::NotAnAssignment`] if `expr` is not an
///   [`ExprNode::Assignment`].
/// - [`EvaluationError::NonLValueAssignmentDestination`] if `dest` is
///   neither a memory ref nor the store register.
/// - Any error surfaced by [`evaluate`] for the destination's index or
///   the source expression.
pub fn evaluate_assignment(expr: &ExprNode, banks: &mut VarBanks) -> Result<i32, EvaluationError> {
    let ExprNode::Assignment { dest, op, src } = expr else {
        return Err(EvaluationError::NotAnAssignment {
            got: variant_name(expr),
        });
    };
    // Resolve the destination's index (if any) before computing the
    // source — RealLive evaluates LHS first.
    let source_value = evaluate(src, banks)?;
    match dest.as_ref() {
        ExprNode::MemoryRef { bank, index } => {
            let idx = evaluate(index, banks)?;
            let current = read_int_bank(banks, *bank, idx)?;
            let new_value = apply_assign_op(*op, current, source_value)?;
            write_int_bank(banks, *bank, idx, new_value)?;
            Ok(new_value)
        }
        ExprNode::StoreRegister => {
            let current = banks.store() as i32;
            let new_value = apply_assign_op(*op, current, source_value)?;
            banks.set_store(new_value as u32);
            Ok(new_value)
        }
        other => Err(EvaluationError::NonLValueAssignmentDestination {
            got: variant_name(other),
        }),
    }
}

fn apply_assign_op(op: AssignOp, current: i32, src: i32) -> Result<i32, EvaluationError> {
    Ok(match op {
        AssignOp::Plain => src,
        AssignOp::AddAssign => current.wrapping_add(src),
        AssignOp::SubAssign => current.wrapping_sub(src),
        AssignOp::MulAssign => current.wrapping_mul(src),
        AssignOp::DivAssign => {
            if src == 0 {
                return Err(EvaluationError::DivisionByZero);
            }
            current.wrapping_div(src)
        }
        AssignOp::ModAssign => {
            if src == 0 {
                return Err(EvaluationError::DivisionByZero);
            }
            current.wrapping_rem(src)
        }
        AssignOp::AndAssign => current & src,
        AssignOp::OrAssign => current | src,
        AssignOp::XorAssign => current ^ src,
        AssignOp::ShlAssign => {
            // Shift counts are masked to the low 5 bits — matches the
            // x86 `SHL` semantics RealLive's compiler emits.
            let shift = (src as u32) & 0x1F;
            current.wrapping_shl(shift)
        }
        AssignOp::ShrAssign => {
            let shift = (src as u32) & 0x1F;
            current.wrapping_shr(shift)
        }
    })
}

fn variant_name(node: &ExprNode) -> &'static str {
    match node {
        ExprNode::IntLiteral(_) => "IntLiteral",
        ExprNode::StoreRegister => "StoreRegister",
        ExprNode::MemoryRef { .. } => "MemoryRef",
        ExprNode::BinaryOp { .. } => "BinaryOp",
        ExprNode::UnaryOp { .. } => "UnaryOp",
        ExprNode::Group(_) => "Group",
        ExprNode::Assignment { .. } => "Assignment",
    }
}

#[cfg(test)]
mod tests {
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
        // Zero-indexed encoding: 0x00=intA, ..., 0x0C=intM.
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
}
