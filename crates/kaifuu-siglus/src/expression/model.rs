//! Data model for the expression decoder: the per-scene decode result, the
//! sanitized operator histogram, the fatal-error type, and the ProgStack
//! operand-stack model the [`super::eval`] evaluator drives.
//!
//! Everything here carries only counts / offsets / forms / operator labels —
//! never raw scene text.

use std::collections::BTreeMap;

use crate::opcode::SiglusParseError;

use super::SiglusExpressionError;
use super::tree::{SiglusBinaryOp, SiglusElementHead, SiglusExpr, SiglusUnaryOp};

/// A located operator byte outside the re-derived operator tables.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UnsupportedOperatorSite {
    /// Absolute offset of the operator instruction within the bytecode section.
    pub byte_offset: usize,
    /// The raw operator byte.
    pub op: u8,
    /// `1` for `CD_OPERATE_1`, `2` for `CD_OPERATE_2`.
    pub arity: u8,
}

/// Sanitized operator histogram over one or more scenes.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct SiglusOperatorHistogram {
    /// Unary operator label → count (labels from [`SiglusUnaryOp::label`]).
    pub unary: BTreeMap<String, usize>,
    /// Binary operator label → count (labels from [`SiglusBinaryOp::label`]).
    pub binary: BTreeMap<String, usize>,
    /// Every operator byte outside the re-derived tables, located.
    pub unsupported: Vec<UnsupportedOperatorSite>,
}

impl SiglusOperatorHistogram {
    pub(crate) fn bump_unary(&mut self, op: SiglusUnaryOp) {
        *self.unary.entry(op.label().to_string()).or_insert(0) += 1;
    }

    pub(crate) fn bump_binary(&mut self, op: SiglusBinaryOp) {
        *self.binary.entry(op.label().to_string()).or_insert(0) += 1;
    }

    /// Fold another histogram into this one (per-game / per-corpus rollup).
    pub fn merge(&mut self, other: &SiglusOperatorHistogram) {
        for (key, count) in &other.unary {
            *self.unary.entry(key.clone()).or_insert(0) += count;
        }
        for (key, count) in &other.binary {
            *self.binary.entry(key.clone()).or_insert(0) += count;
        }
        self.unsupported.extend(other.unsupported.iter().cloned());
    }

    /// Total operator applications recorded (unary + binary).
    pub fn total(&self) -> usize {
        self.unary.values().sum::<usize>() + self.binary.values().sum::<usize>()
    }
}

/// The result of decoding one scene's expressions.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SceneExpressionDecode {
    /// Number of instructions evaluated.
    pub instruction_count: usize,
    /// Total operand bytes across every instruction (`sum(len - 1)`).
    pub total_operand_bytes: usize,
    /// Operand bytes that decoded to a typed operand. Equal to
    /// `total_operand_bytes` on success — the zero-unparsed-bytes invariant.
    pub typed_operand_bytes: usize,
    /// Sanitized operator histogram.
    pub operators: SiglusOperatorHistogram,
    /// Count of `int`-form `CD_PUSH` literals.
    pub push_int_count: usize,
    /// Count of `str`-form `CD_PUSH` literals.
    pub push_str_count: usize,
    /// Other `CD_PUSH` form codes → count (non-int/str forms, if any).
    pub push_other_forms: BTreeMap<i32, usize>,
    /// Number of element / variable reference chains built.
    pub element_chain_count: usize,
    /// Number of gosub call expressions built.
    pub gosub_count: usize,
    /// Number of command call expressions built.
    pub command_count: usize,
    /// Completed top-level expression trees harvested at consumer sites.
    pub roots: Vec<SiglusExpr>,
    /// Count of stack-underflow diagnostics emitted (cross-block operands).
    pub stack_underflow_count: usize,
    /// Underflow diagnostics attributed to the consuming opcode's lead byte
    /// (two-digit hex → count). A straight-line walk cannot supply an operand
    /// whose producer sits on another control-flow path; the flow layer
    /// resolves these. Sanitized: opcode leads + counts only.
    pub stack_underflow_by_lead: BTreeMap<String, usize>,
    /// Operand-stack depth left at the end of the scene.
    pub final_stack_depth: usize,
}

impl SceneExpressionDecode {
    /// A zeroed decode for a scene of `instruction_count` instructions.
    pub(crate) fn new(instruction_count: usize) -> Self {
        SceneExpressionDecode {
            instruction_count,
            total_operand_bytes: 0,
            typed_operand_bytes: 0,
            operators: SiglusOperatorHistogram::default(),
            push_int_count: 0,
            push_str_count: 0,
            push_other_forms: BTreeMap::new(),
            element_chain_count: 0,
            gosub_count: 0,
            command_count: 0,
            roots: Vec::new(),
            stack_underflow_count: 0,
            stack_underflow_by_lead: BTreeMap::new(),
            final_stack_depth: 0,
        }
    }

    /// True when every operand byte decoded to a typed operand (no gaps) and
    /// every operator byte mapped to a re-derived operator (no unsupported).
    pub fn is_fully_typed(&self) -> bool {
        self.typed_operand_bytes == self.total_operand_bytes
            && self.operators.unsupported.is_empty()
    }
}

/// A fatal error decoding a scene's expressions: either the structural
/// partition failed or an operand decode did.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum SceneExpressionError {
    /// The scene failed to partition (malformed header).
    #[error("kaifuu.siglus.expression.partition: {0}")]
    Partition(#[from] SiglusParseError),
    /// An operand failed to decode.
    #[error("kaifuu.siglus.expression.operand: {0}")]
    Operand(#[from] SiglusExpressionError),
}

/// The operand-stack model driving expression-tree reconstruction.
#[derive(Default)]
pub(crate) struct ProgStack {
    values: Vec<SiglusExpr>,
    frames: Vec<usize>,
    underflow: usize,
    /// Lead byte of the instruction currently executing (for underflow blame).
    cur_lead: u8,
    /// Underflow count attributed to each consuming opcode lead byte.
    underflow_by_lead: BTreeMap<String, usize>,
}

impl ProgStack {
    /// Record the currently-executing opcode lead (blamed on underflow).
    pub(crate) fn set_lead(&mut self, lead: u8) {
        self.cur_lead = lead;
    }

    fn blame_underflow(&mut self) {
        self.underflow += 1;
        *self
            .underflow_by_lead
            .entry(format!("{:02x}", self.cur_lead))
            .or_insert(0) += 1;
    }

    pub(crate) fn push(&mut self, value: SiglusExpr) {
        self.values.push(value);
    }

    pub(crate) fn pop(&mut self) -> SiglusExpr {
        if self.values.is_empty() {
            self.blame_underflow();
            SiglusExpr::StackUnderflow
        } else {
            self.values.pop().unwrap_or(SiglusExpr::StackUnderflow)
        }
    }

    /// Peek the top value and push a duplicate (`CD_COPY`).
    pub(crate) fn dup_top(&mut self) {
        let top = self.values.last().cloned().unwrap_or_else(|| {
            self.blame_underflow();
            SiglusExpr::StackUnderflow
        });
        self.values.push(top);
    }

    pub(crate) fn open_frame(&mut self) {
        self.frames.push(self.values.len());
    }

    pub(crate) fn dup_frame(&mut self) {
        let begin = self
            .frames
            .last()
            .copied()
            .unwrap_or(0)
            .min(self.values.len());
        self.frames.push(self.values.len());
        let dup = self.values[begin..].to_vec();
        self.values.extend(dup);
    }

    /// Close the current element frame into an [`SiglusExpr::Element`].
    pub(crate) fn close_frame(&mut self) -> SiglusExpr {
        let Some(depth) = self.frames.pop() else {
            self.blame_underflow();
            return SiglusExpr::StackUnderflow;
        };
        let depth = depth.min(self.values.len());
        let atoms = self.values.split_off(depth);
        let mut iter = atoms.into_iter();
        let Some(head_expr) = iter.next() else {
            self.blame_underflow();
            return SiglusExpr::StackUnderflow;
        };
        SiglusExpr::Element {
            head: SiglusElementHead::from_expr(head_expr),
            tail: iter.collect(),
        }
    }

    /// Pop `n` argument subtrees, restoring source (stack) order.
    pub(crate) fn pop_args(&mut self, n: usize) -> Vec<SiglusExpr> {
        let mut args: Vec<SiglusExpr> = (0..n).map(|_| self.pop()).collect();
        args.reverse();
        args
    }

    /// Consume the stack into its end-of-scene diagnostics:
    /// `(total underflow, underflow-by-lead, residual depth)`.
    pub(crate) fn into_diagnostics(self) -> (usize, BTreeMap<String, usize>, usize) {
        (self.underflow, self.underflow_by_lead, self.values.len())
    }
}
