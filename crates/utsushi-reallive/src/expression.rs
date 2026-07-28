//! RealLive expression byte-stream parser.
//!
//! Consumes the `raw_bytes` payload of a
//! [`crate::BytecodeElement::Expression`] () and produces a
//! typed [`ExprNode`] AST. The byte stream is the documented RealLive
//! expression encoding (`docs/research/reallive-engine.md` §G
//! re-derived from publicly archived RLDEV documentation and
//! `rlvm/src/libreallive/expression.cc` as a research anchor only):
//!
//! - `$ 0xFF <i32:LE>` — 6-byte int-literal token.
//! - `$ 0xC8` — store-register reference.
//! - `$ <bank_byte> [ <index_expr> ]` — memory reference.
//! - `(` <expr> `)` — grouping.
//! - `\ <op_byte> <rhs>` — binary or compound-assignment operator
//!   continuation. The op byte values are pinned in [`ExprOp`] and
//!   [`AssignOp`].
//! - `\ 0x00 <term>` / `\ 0x01 <term>` — unary forms (no-op
//!   unary-minus).
//!
//! A standalone [`crate::BytecodeElement::Expression`] is shaped as an
//! assignment per the bytecode walker:
//! `<dest_term> \ <assign_op> <source_expression>`. The top-level
//! [`parse_expression`] entry point recognises this shape and produces
//! an [`ExprNode::Assignment`].
//!
//! # Operator byte table
//!
//! Pinned operator byte table:
//!
//! Byte (after `\`) | Operator | Variant
//! ---------------- | ------------ | ------------------
//! `0x00` | `+` | [`ExprOp::Add`]
//! `0x01` | `-` | [`ExprOp::Sub`]
//! `0x02` | `*` | [`ExprOp::Mul`]
//! `0x03` | `/` | [`ExprOp::Div`]
//! `0x04` | `%` | [`ExprOp::Mod`]
//! `0x05` | `&` | [`ExprOp::And`]
//! `0x06` | `\|` | [`ExprOp::Or`]
//! `0x07` | `^` | [`ExprOp::Xor`]
//! `0x08` | `<<` | [`ExprOp::Shl`]
//! `0x09` | `>>` | [`ExprOp::Shr`]
//! `0x28` | `==` | [`ExprOp::Equ`]
//! `0x29` | `!=` | [`ExprOp::Neq`]
//! `0x2A` | `<` | [`ExprOp::Lt`]
//! `0x2B` | `<=` | [`ExprOp::Le`]
//! `0x2C` | `>` | [`ExprOp::Gt`]
//! `0x2D` | `>=` | [`ExprOp::Ge`]
//! `0x3C` | `&&` | [`ExprOp::LogicAnd`]
//! `0x3D` | `\|\|` | [`ExprOp::LogicOr`]
//!
//! Assignment ops live in `0x14..=0x24` per the bytecode walker, with
//! the documented sub-range expanded below:
//!
//! Byte (after `\`) | Operator | Variant
//! ---------------- | -------- | ------------------------
//! `0x14` | `+=` | [`AssignOp::AddAssign`]
//! `0x15` | `-=` | [`AssignOp::SubAssign`]
//! `0x16` | `*=` | [`AssignOp::MulAssign`]
//! `0x17` | `/=` | [`AssignOp::DivAssign`]
//! `0x18` | `%=` | [`AssignOp::ModAssign`]
//! `0x19` | `&=` | [`AssignOp::AndAssign`]
//! `0x1A` | `\|=` | [`AssignOp::OrAssign`]
//! `0x1B` | `^=` | [`AssignOp::XorAssign`]
//! `0x1C` | `<<=` | [`AssignOp::ShlAssign`]
//! `0x1D` | `>>=` | [`AssignOp::ShrAssign`]
//! `0x1E` | `=` | [`AssignOp::Plain`]
//!
//! (This matches rlvm's `libreallive/expression.cc`: op `30`/`0x1E` is the
//! special-cased plain `=`, `0x14..=0x1D` are the compound forms.)
//!
//! The `0x1F..=0x24` slots are accepted by the bytecode walker but
//! their semantics are not documented in RLDEV; the two public entry
//! points handle them differently (see below).
//!
//! # Dual path: decompile (fail-closed) vs emulator (fail-soft)
//!
//! - [`parse_expression`] is the **decompile / strict** path. An
//!   unknown operator byte is a typed
//!   [`ExpressionParseError::UnknownOperator`] — no fabricated
//!   `+ 0` / partial AST. Static tools and re-decompile acceptance
//!   must not silently paper over coverage gaps.
//! - [`parse_expression_with_warnings`] is the **emulator / replay**
//!   path. An unknown operator emits
//!   [`ExpressionWarning::UnknownOperator`] and recovers with a
//!   partial result (treat the slot as terminating the arithmetic
//!   chain / a zero operand) so the VM can keep making progress.
//!   Callers that care about coverage assert the warning vector is
//!   empty on real bytes.
//!
//! # Empty input
//!
//! An empty byte slice is **not** parsed as a zero-node expression. The
//! function returns [`ExpressionParseError::Truncated`] — the alpha-gate
//! "no silent zero-state" contract forbids returning a default node on
//! empty input.

#[path = "expression/arithmetic.rs"]
mod arithmetic;
#[cfg(test)]
#[path = "expression_tests.rs"]
mod tests;
include!("expression_parts/001.rs");
include!("expression_parts/002.rs");
