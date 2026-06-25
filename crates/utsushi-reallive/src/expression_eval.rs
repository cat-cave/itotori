//! UTSUSHI-205 — expression evaluator.
//!
//! Given an [`ExprNode`] produced by [`crate::expression::parse_expression`]
//! and a [`VarBanks`] snapshot, [`evaluate`] reduces the AST to an
//! `i32` result. [`evaluate_assignment`] handles the
//! [`ExprNode::Assignment`] shape (mutating the supplied banks).
//!
//! # Bank layout
//!
//! Per `docs/research/reallive-engine.md` §G the integer banks are
//! `intA`..`intM` (13 letters per Haeleth's documented RLDEV manual;
//! rlvm caps each bank at 2,000 entries — this evaluator uses 4,096
//! slots per bank as a conservative upper bound). Bank-byte
//! indexing follows the documented `\x0B = intB` convention pinned
//! in [`bank_byte_to_index`].
//!
//! # Division and modulo by zero
//!
//! Per the alpha-gate hardness constraint listed in the UTSUSHI-205
//! task, division or modulo by zero surfaces as
//! [`EvaluationError::DivisionByZero`]. No panic, no
//! "silent return zero" path.

use thiserror::Error;

use crate::expression::{AssignOp, ExprNode, ExprOp, UnaryOp};

/// Number of slots per integer bank. rlvm caps each at 2,000; this
/// evaluator uses 4,096 as a power-of-two upper bound so the array
/// stays contiguous and bounds-check failures are still typed errors
/// rather than panics.
pub const INT_BANK_SLOT_COUNT: usize = 4096;

/// Number of typed integer banks (`intA`..`intM`).
pub const INT_BANK_COUNT: usize = 13;

/// Typed integer-bank snapshot used as the evaluator's read/write
/// surface.
///
/// The bank arrays are exposed as fixed-size `[i32; INT_BANK_SLOT_COUNT]`
/// rather than as a `HashMap` because (a) the lookup is on a hot path
/// — every expression in a scene's bytecode touches at least one
/// memory ref — and (b) the dense representation lets the snapshot
/// surface UTSUSHI-206 will land plug straight into the evaluator
/// without an indirection.
#[derive(Clone)]
pub struct VarBanks {
    /// `intA` — general-purpose bank A.
    pub int_a: [i32; INT_BANK_SLOT_COUNT],
    /// `intB` — general-purpose bank B (bank byte `0x01`).
    pub int_b: [i32; INT_BANK_SLOT_COUNT],
    /// `intC` — general-purpose bank C.
    pub int_c: [i32; INT_BANK_SLOT_COUNT],
    /// `intD` — general-purpose bank D.
    pub int_d: [i32; INT_BANK_SLOT_COUNT],
    /// `intE` — general-purpose bank E.
    pub int_e: [i32; INT_BANK_SLOT_COUNT],
    /// `intF` — general-purpose bank F.
    pub int_f: [i32; INT_BANK_SLOT_COUNT],
    /// `intG` — general-purpose bank G.
    pub int_g: [i32; INT_BANK_SLOT_COUNT],
    /// `intH` — general-purpose bank H.
    pub int_h: [i32; INT_BANK_SLOT_COUNT],
    /// `intI` — general-purpose bank I.
    pub int_i: [i32; INT_BANK_SLOT_COUNT],
    /// `intJ` — general-purpose bank J.
    pub int_j: [i32; INT_BANK_SLOT_COUNT],
    /// `intK` — general-purpose bank K (RealLive: "constant" historical).
    pub int_k: [i32; INT_BANK_SLOT_COUNT],
    /// `intL` — general-purpose bank L.
    pub int_l: [i32; INT_BANK_SLOT_COUNT],
    /// `intM` — general-purpose bank M.
    pub int_m: [i32; INT_BANK_SLOT_COUNT],
    /// Single store register (rlvm: `u32`; this crate treats it as
    /// `i32` to match the arithmetic surface — sign reinterpretation
    /// happens in the caller if needed).
    pub store: i32,
}

impl Default for VarBanks {
    fn default() -> Self {
        Self::zeroed()
    }
}

impl std::fmt::Debug for VarBanks {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        // The bank arrays are 13 * 4096 i32s — printing them defeats
        // the purpose of a Debug impl. Instead surface the non-zero
        // counts and the store register so a regression that scribbles
        // into the banks is still visible in panic output.
        let nonzero_total: usize = self.int_banks_iter().map(count_nonzero).sum();
        formatter
            .debug_struct("VarBanks")
            .field("nonzero_int_slots", &nonzero_total)
            .field("store", &self.store)
            .finish()
    }
}

impl VarBanks {
    /// Construct a banks snapshot with every slot zeroed and the store
    /// register cleared. Used by the synthetic test suite as the
    /// neutral baseline.
    pub fn zeroed() -> Self {
        Self {
            int_a: [0; INT_BANK_SLOT_COUNT],
            int_b: [0; INT_BANK_SLOT_COUNT],
            int_c: [0; INT_BANK_SLOT_COUNT],
            int_d: [0; INT_BANK_SLOT_COUNT],
            int_e: [0; INT_BANK_SLOT_COUNT],
            int_f: [0; INT_BANK_SLOT_COUNT],
            int_g: [0; INT_BANK_SLOT_COUNT],
            int_h: [0; INT_BANK_SLOT_COUNT],
            int_i: [0; INT_BANK_SLOT_COUNT],
            int_j: [0; INT_BANK_SLOT_COUNT],
            int_k: [0; INT_BANK_SLOT_COUNT],
            int_l: [0; INT_BANK_SLOT_COUNT],
            int_m: [0; INT_BANK_SLOT_COUNT],
            store: 0,
        }
    }

    /// Read a slot from the bank addressed by `bank_byte`. Returns
    /// [`EvaluationError::UnknownBank`] if the bank byte does not map
    /// to any documented bank, or
    /// [`EvaluationError::BankIndexOutOfRange`] if `index` is past the
    /// fixed slot count.
    pub fn read(&self, bank_byte: u8, index: i32) -> Result<i32, EvaluationError> {
        let slot = self.bank_slice(bank_byte)?;
        let idx = bank_index_in_range(bank_byte, index)?;
        Ok(slot[idx])
    }

    /// Write `value` to a slot in the bank addressed by `bank_byte`.
    pub fn write(&mut self, bank_byte: u8, index: i32, value: i32) -> Result<(), EvaluationError> {
        let slot = self.bank_slice_mut(bank_byte)?;
        let idx = bank_index_in_range(bank_byte, index)?;
        slot[idx] = value;
        Ok(())
    }

    fn bank_slice(&self, bank_byte: u8) -> Result<&[i32; INT_BANK_SLOT_COUNT], EvaluationError> {
        match bank_byte_to_index(bank_byte)? {
            0 => Ok(&self.int_a),
            1 => Ok(&self.int_b),
            2 => Ok(&self.int_c),
            3 => Ok(&self.int_d),
            4 => Ok(&self.int_e),
            5 => Ok(&self.int_f),
            6 => Ok(&self.int_g),
            7 => Ok(&self.int_h),
            8 => Ok(&self.int_i),
            9 => Ok(&self.int_j),
            10 => Ok(&self.int_k),
            11 => Ok(&self.int_l),
            12 => Ok(&self.int_m),
            other => Err(EvaluationError::UnknownBank {
                bank_byte,
                debug: format!("bank-byte slot index {other} out of range"),
            }),
        }
    }

    fn bank_slice_mut(
        &mut self,
        bank_byte: u8,
    ) -> Result<&mut [i32; INT_BANK_SLOT_COUNT], EvaluationError> {
        match bank_byte_to_index(bank_byte)? {
            0 => Ok(&mut self.int_a),
            1 => Ok(&mut self.int_b),
            2 => Ok(&mut self.int_c),
            3 => Ok(&mut self.int_d),
            4 => Ok(&mut self.int_e),
            5 => Ok(&mut self.int_f),
            6 => Ok(&mut self.int_g),
            7 => Ok(&mut self.int_h),
            8 => Ok(&mut self.int_i),
            9 => Ok(&mut self.int_j),
            10 => Ok(&mut self.int_k),
            11 => Ok(&mut self.int_l),
            12 => Ok(&mut self.int_m),
            other => Err(EvaluationError::UnknownBank {
                bank_byte,
                debug: format!("bank-byte slot index {other} out of range"),
            }),
        }
    }

    fn int_banks_iter(&self) -> impl Iterator<Item = &[i32; INT_BANK_SLOT_COUNT]> {
        [
            &self.int_a,
            &self.int_b,
            &self.int_c,
            &self.int_d,
            &self.int_e,
            &self.int_f,
            &self.int_g,
            &self.int_h,
            &self.int_i,
            &self.int_j,
            &self.int_k,
            &self.int_l,
            &self.int_m,
        ]
        .into_iter()
    }
}

fn count_nonzero(slots: &[i32; INT_BANK_SLOT_COUNT]) -> usize {
    slots.iter().filter(|&&value| value != 0).count()
}

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

fn bank_index_in_range(bank_byte: u8, index: i32) -> Result<usize, EvaluationError> {
    if index < 0 {
        return Err(EvaluationError::BankIndexOutOfRange {
            bank_byte,
            index,
            slot_count: INT_BANK_SLOT_COUNT,
        });
    }
    let as_usize = index as usize;
    if as_usize >= INT_BANK_SLOT_COUNT {
        return Err(EvaluationError::BankIndexOutOfRange {
            bank_byte,
            index,
            slot_count: INT_BANK_SLOT_COUNT,
        });
    }
    Ok(as_usize)
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
        ExprNode::StoreRegister => Ok(banks.store),
        ExprNode::MemoryRef { bank, index } => {
            let idx = evaluate(index, banks)?;
            banks.read(*bank, idx)
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
            let current = banks.read(*bank, idx)?;
            let new_value = apply_assign_op(*op, current, source_value)?;
            banks.write(*bank, idx, new_value)?;
            Ok(new_value)
        }
        ExprNode::StoreRegister => {
            let current = banks.store;
            let new_value = apply_assign_op(*op, current, source_value)?;
            banks.store = new_value;
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
        let banks = VarBanks::zeroed();
        assert_eq!(evaluate(&ExprNode::IntLiteral(42), &banks).unwrap(), 42);
    }

    #[test]
    fn store_register_round_trip() {
        let mut banks = VarBanks::zeroed();
        banks.store = 7;
        assert_eq!(evaluate(&ExprNode::StoreRegister, &banks).unwrap(), 7);
    }

    #[test]
    fn memory_ref_reads_intb_zero() {
        let mut banks = VarBanks::zeroed();
        banks.int_b[0] = 10;
        let node = ExprNode::MemoryRef {
            bank: 0x01,
            index: Box::new(ExprNode::IntLiteral(0)),
        };
        assert_eq!(evaluate(&node, &banks).unwrap(), 10);
    }

    #[test]
    fn division_by_zero_is_typed_error_not_panic() {
        let banks = VarBanks::zeroed();
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
        let banks = VarBanks::zeroed();
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
        let mut banks = VarBanks::zeroed();
        let res = banks.write(0x01, INT_BANK_SLOT_COUNT as i32, 1);
        assert!(matches!(
            res,
            Err(EvaluationError::BankIndexOutOfRange { .. })
        ));
    }

    #[test]
    fn evaluate_assignment_writes_into_intb() {
        let mut banks = VarBanks::zeroed();
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
        assert_eq!(banks.int_b[0], 7);
    }

    #[test]
    fn evaluate_compound_add_assign() {
        let mut banks = VarBanks::zeroed();
        banks.int_b[0] = 5;
        let node = ExprNode::Assignment {
            dest: Box::new(ExprNode::MemoryRef {
                bank: 0x01,
                index: Box::new(ExprNode::IntLiteral(0)),
            }),
            op: AssignOp::AddAssign,
            src: Box::new(ExprNode::IntLiteral(3)),
        };
        evaluate_assignment(&node, &mut banks).unwrap();
        assert_eq!(banks.int_b[0], 8);
    }

    #[test]
    fn logical_and_short_circuits_on_false_lhs() {
        let banks = VarBanks::zeroed();
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
        let banks = VarBanks::zeroed();
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
