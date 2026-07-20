//! Siglus scene-bytecode **expression / stack decoder**.
//!
//! [`crate::opcode`] (siglus-08) partitions a decompressed scene into a
//! fully-covering [`SiglusInstruction`] stream — each an exact
//! `(offset, lead, opcode, len)` — but does not decode operand *values*. This
//! module lands that decode in two layers:
//!
//! 1. **Typed operands** ([`SiglusOperand`], [`decode_operand`]): every
//!    instruction's operand bytes are parsed into a typed value, consuming
//!    **exactly** the operand span the partition assigned (`[offset+1,
//!    offset+len)`) — asserted byte-for-byte, so there are no gaps and no
//!    overruns. `CD_PUSH` literals, the `CD_OPERATE_1/2` operator bytes, jump
//!    labels, and the recursive argument-form lists all become data here.
//! 2. **Typed expression trees** ([`eval`]): a fuzz-safe stack evaluator folds
//!    the operand stream into [`SiglusExpr`] trees (int/str literals,
//!    element / variable refs, unary / binary operators, gosub / command
//!    calls) and emits a sanitized operator [histogram](eval::SiglusOperatorHistogram).
//!
//! Every read is bounds-checked; an operator byte outside the re-derived tables
//! becomes a typed [`SiglusExpr::UnsupportedOperator`] diagnostic, never a panic
//! and never a silent skip. Nothing in this module carries raw scene text —
//! `str` literals travel as their string-table index only.

use thiserror::Error;

use crate::opcode::{SiglusInstruction, SiglusOpcode};

mod eval;
mod model;
mod tree;

pub use eval::{decode_operand_stream, decode_scene_expressions};
pub use model::{
    SceneExpressionDecode, SceneExpressionError, SiglusOperatorHistogram, UnsupportedOperatorSite,
};
pub use tree::{SiglusBinaryOp, SiglusElementHead, SiglusExpr, SiglusUnaryOp};

/// Form code for a nested argument list (a `-1` sentinel in the stream).
pub const FM_LIST: i32 = -1;
/// Form code for an `int` literal / value.
pub const FM_INT: i32 = 10;
/// Form code for a `str` literal / value.
pub const FM_STR: i32 = 20;
/// Depth cap for nested argument-form lists (mirrors the partitioner's cap).
const MAX_ARG_DEPTH: u32 = 64;

/// A `CD_PUSH` operand: the pushed literal's typed form.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SiglusPush {
    /// An `int` literal (form `10`) with its inline value word.
    Int(i32),
    /// A `str` literal (form `20`) with its string-table **index**.
    Str(i32),
    /// A push of some other form, carrying no inline value word.
    Form(i32),
}

/// One decoded argument form from a `CD_GOSUB` / `CD_COMMAND` / `CD_RETURN`
/// argument-form list: either a leaf form code or a nested list.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SiglusArgForm {
    /// A leaf argument form code.
    Form(i32),
    /// A nested argument-form list (form `-1`).
    List(Vec<SiglusArgForm>),
}

impl SiglusArgForm {
    /// The number of stack values this form consumes (a leaf is one value; a
    /// list consumes one value per nested entry, recursively).
    fn value_count(&self) -> usize {
        match self {
            SiglusArgForm::Form(_) => 1,
            SiglusArgForm::List(items) => items.iter().map(SiglusArgForm::value_count).sum(),
        }
    }
}

/// Total stack values consumed by an argument-form list.
pub(crate) fn arg_forms_value_count(forms: &[SiglusArgForm]) -> usize {
    forms.iter().map(SiglusArgForm::value_count).sum()
}

/// A fully-typed operand block for one partitioned instruction. Every variant's
/// bytes are the exact operand span the partition assigned to that instruction.
#[derive(Debug, Clone, PartialEq, Eq)]
#[non_exhaustive]
pub enum SiglusOperand {
    /// Opcodes with no operand bytes (`CD_PROPERTY`, `CD_ELM_POINT`, `CD_NAME`,
    /// `CD_EOF`, the selection-block markers, `CD_ARG`, `CD_COPY_ELM`).
    None,
    /// `CD_NL` source line marker.
    Line(i32),
    /// `CD_PUSH` literal.
    Push(SiglusPush),
    /// `CD_POP` of the given form.
    Pop(i32),
    /// `CD_COPY` of the given form.
    Copy(i32),
    /// `CD_DEC_PROP` property declaration `(form, prop_id)`.
    DecProp(i32, i32),
    /// `CD_GOTO` unconditional jump.
    Goto(i32),
    /// `CD_GOTO_TRUE` conditional jump.
    GotoTrue(i32),
    /// `CD_GOTO_FALSE` conditional jump.
    GotoFalse(i32),
    /// `CD_GOSUB` (int return) `(label, arg_forms)`.
    Gosub(i32, Vec<SiglusArgForm>),
    /// `CD_GOSUBSTR` (str return) `(label, arg_forms)`.
    GosubStr(i32, Vec<SiglusArgForm>),
    /// `CD_RETURN` argument forms.
    Return(Vec<SiglusArgForm>),
    /// `CD_ASSIGN` `(left_form, right_form, arg_list_id)`.
    Assign(i32, i32, i32),
    /// `CD_OPERATE_1` `(form, operator_byte)`.
    Operate1(i32, u8),
    /// `CD_OPERATE_2` `(left_form, right_form, operator_byte)`.
    Operate2(i32, i32, u8),
    /// `CD_COMMAND` invocation.
    Command {
        /// Argument-list id word.
        arg_list_id: i32,
        /// Argument forms (drive how many stack values are popped).
        arg_forms: Vec<SiglusArgForm>,
        /// Named-argument ids.
        named_arg_ids: Vec<i32>,
        /// Declared return form.
        ret_form: i32,
        /// The trailing `read_flag_no` word, present per the partition's
        /// structural disambiguation.
        read_flag: Option<i32>,
    },
    /// `CD_TEXT` message run `read_flag`/id word.
    Text(i32),
    /// An `Unknown` partition span; carries the raw lead byte. No operand bytes
    /// are interpreted (the span is opaque by construction).
    Unknown(u8),
}

/// Fatal errors from the expression operand decoder.
///
/// These are structural impossibilities on a well-formed partition (the byte
/// walk already proved the spans in-bounds); they exist so the decoder is a
/// total function that never panics on adversarial input.
#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum SiglusExpressionError {
    /// An operand read ran past the end of the bytecode section.
    #[error(
        "kaifuu.siglus.expression.truncated: instruction at offset {offset} needed operand bytes \
         past the {bytecode_len}-byte bytecode section"
    )]
    Truncated {
        /// Instruction offset.
        offset: usize,
        /// Bytecode section length.
        bytecode_len: usize,
    },
    /// The decoded operand consumed a different number of bytes than the
    /// partition assigned to the instruction — a decoder/partition disagreement.
    #[error(
        "kaifuu.siglus.expression.span_mismatch: instruction at offset {offset} (lead {lead:#04x}) \
         decoded {decoded} operand bytes but the partition assigned {assigned}"
    )]
    SpanMismatch {
        /// Instruction offset.
        offset: usize,
        /// Raw lead byte.
        lead: u8,
        /// Bytes the operand decoder consumed.
        decoded: usize,
        /// Bytes the partition assigned (`len - 1`).
        assigned: usize,
    },
    /// A negative or implausibly large count in an argument-form list.
    #[error(
        "kaifuu.siglus.expression.bad_arg_count: instruction at offset {offset} has an invalid \
         argument-form count {count}"
    )]
    BadArgCount {
        /// Instruction offset.
        offset: usize,
        /// The offending count.
        count: i32,
    },
}

/// A bounds-checked little-endian reader over one instruction's operand bytes.
struct OperandReader<'a> {
    bytes: &'a [u8],
    pos: usize,
    offset: usize,
    bytecode_len: usize,
}

impl<'a> OperandReader<'a> {
    fn new(bytes: &'a [u8], pos: usize, offset: usize) -> Self {
        OperandReader {
            bytes,
            pos,
            offset,
            bytecode_len: bytes.len(),
        }
    }

    fn read_i32(&mut self) -> Result<i32, SiglusExpressionError> {
        let end = self
            .pos
            .checked_add(4)
            .filter(|end| *end <= self.bytes.len());
        let Some(end) = end else {
            return Err(SiglusExpressionError::Truncated {
                offset: self.offset,
                bytecode_len: self.bytecode_len,
            });
        };
        let slice = &self.bytes[self.pos..end];
        self.pos = end;
        Ok(i32::from_le_bytes([slice[0], slice[1], slice[2], slice[3]]))
    }

    fn read_u8(&mut self) -> Result<u8, SiglusExpressionError> {
        let Some(&byte) = self.bytes.get(self.pos) else {
            return Err(SiglusExpressionError::Truncated {
                offset: self.offset,
                bytecode_len: self.bytecode_len,
            });
        };
        self.pos += 1;
        Ok(byte)
    }

    fn read_arg_forms(&mut self, depth: u32) -> Result<Vec<SiglusArgForm>, SiglusExpressionError> {
        let count = self.read_i32()?;
        if count < 0 || depth > MAX_ARG_DEPTH {
            return Err(SiglusExpressionError::BadArgCount {
                offset: self.offset,
                count,
            });
        }
        let mut forms = Vec::with_capacity(count as usize);
        for _ in 0..count {
            let form = self.read_i32()?;
            if form == FM_LIST {
                forms.push(SiglusArgForm::List(self.read_arg_forms(depth + 1)?));
            } else {
                forms.push(SiglusArgForm::Form(form));
            }
        }
        Ok(forms)
    }
}

/// Decode one partitioned instruction's operand bytes into a typed
/// [`SiglusOperand`], over the scene's `bytecode` section.
///
/// The decode consumes **exactly** the operand span the partition assigned
/// (`instruction.len - 1` bytes starting at `instruction.byte_offset + 1`); a
/// disagreement is a typed [`SiglusExpressionError::SpanMismatch`], never a
/// silent gap. This is the byte-completeness guarantee the real-bytes proof
/// asserts scene-wide.
pub fn decode_operand(
    bytecode: &[u8],
    instruction: &SiglusInstruction,
) -> Result<SiglusOperand, SiglusExpressionError> {
    let offset = instruction.byte_offset;
    let operand_start = offset + 1;
    let mut reader = OperandReader::new(bytecode, operand_start, offset);

    let operand = match instruction.opcode {
        SiglusOpcode::Nl => SiglusOperand::Line(reader.read_i32()?),
        SiglusOpcode::Push => {
            let form = reader.read_i32()?;
            let push = match form {
                FM_INT => SiglusPush::Int(reader.read_i32()?),
                FM_STR => SiglusPush::Str(reader.read_i32()?),
                other => SiglusPush::Form(other),
            };
            SiglusOperand::Push(push)
        }
        SiglusOpcode::Pop => SiglusOperand::Pop(reader.read_i32()?),
        SiglusOpcode::Copy => SiglusOperand::Copy(reader.read_i32()?),
        SiglusOpcode::Property
        | SiglusOpcode::CopyElm
        | SiglusOpcode::ElmPoint
        | SiglusOpcode::Arg
        | SiglusOpcode::Name
        | SiglusOpcode::SelBlockStart
        | SiglusOpcode::SelBlockEnd
        | SiglusOpcode::Eof => SiglusOperand::None,
        SiglusOpcode::DecProp => {
            let form = reader.read_i32()?;
            let prop_id = reader.read_i32()?;
            SiglusOperand::DecProp(form, prop_id)
        }
        SiglusOpcode::Goto => SiglusOperand::Goto(reader.read_i32()?),
        SiglusOpcode::GotoTrue => SiglusOperand::GotoTrue(reader.read_i32()?),
        SiglusOpcode::GotoFalse => SiglusOperand::GotoFalse(reader.read_i32()?),
        SiglusOpcode::Gosub => {
            let label = reader.read_i32()?;
            SiglusOperand::Gosub(label, reader.read_arg_forms(0)?)
        }
        SiglusOpcode::GosubStr => {
            let label = reader.read_i32()?;
            SiglusOperand::GosubStr(label, reader.read_arg_forms(0)?)
        }
        SiglusOpcode::Return => SiglusOperand::Return(reader.read_arg_forms(0)?),
        SiglusOpcode::Assign => {
            let left = reader.read_i32()?;
            let right = reader.read_i32()?;
            let arg_list_id = reader.read_i32()?;
            SiglusOperand::Assign(left, right, arg_list_id)
        }
        SiglusOpcode::Operate1 => {
            let form = reader.read_i32()?;
            SiglusOperand::Operate1(form, reader.read_u8()?)
        }
        SiglusOpcode::Operate2 => {
            let left = reader.read_i32()?;
            let right = reader.read_i32()?;
            SiglusOperand::Operate2(left, right, reader.read_u8()?)
        }
        SiglusOpcode::Command { read_flag } => {
            let arg_list_id = reader.read_i32()?;
            let arg_forms = reader.read_arg_forms(0)?;
            let named_count = reader.read_i32()?;
            if named_count < 0 {
                return Err(SiglusExpressionError::BadArgCount {
                    offset,
                    count: named_count,
                });
            }
            let mut named_arg_ids = Vec::with_capacity(named_count as usize);
            for _ in 0..named_count {
                named_arg_ids.push(reader.read_i32()?);
            }
            let ret_form = reader.read_i32()?;
            let read_flag = if read_flag {
                Some(reader.read_i32()?)
            } else {
                None
            };
            SiglusOperand::Command {
                arg_list_id,
                arg_forms,
                named_arg_ids,
                ret_form,
                read_flag,
            }
        }
        SiglusOpcode::Text => SiglusOperand::Text(reader.read_i32()?),
        SiglusOpcode::Unknown { lead, .. } => SiglusOperand::Unknown(lead),
    };

    let decoded = reader.pos - operand_start;
    let assigned = instruction.len - 1;
    if decoded != assigned {
        return Err(SiglusExpressionError::SpanMismatch {
            offset,
            lead: instruction.lead,
            decoded,
            assigned,
        });
    }
    Ok(operand)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::opcode::partition_scene;

    /// Partition a hand-built payload and decode every operand, asserting each
    /// consumes exactly its assigned span.
    fn operands_of(bytecode: &[u8], labels: &[i32]) -> Vec<SiglusOperand> {
        let payload = build_payload(bytecode, labels);
        let part = partition_scene(&payload).expect("partition");
        let scn = &payload[crate::opcode::SCN_HEADER_BYTE_LEN
            ..crate::opcode::SCN_HEADER_BYTE_LEN + bytecode.len()];
        part.instructions
            .iter()
            .map(|instruction| decode_operand(scn, instruction).expect("operand decode"))
            .collect()
    }

    fn put_i32(buf: &mut Vec<u8>, value: i32) {
        buf.extend_from_slice(&value.to_le_bytes());
    }

    fn build_payload(bytecode: &[u8], labels: &[i32]) -> Vec<u8> {
        let header_len = crate::opcode::SCN_HEADER_BYTE_LEN as i32;
        let scn_ofs = header_len;
        let label_ofs = header_len + bytecode.len() as i32;
        let mut header = Vec::new();
        put_i32(&mut header, crate::opcode::SCN_HEADER_DECLARED_SIZE);
        put_i32(&mut header, scn_ofs);
        put_i32(&mut header, bytecode.len() as i32);
        put_i32(&mut header, 0);
        put_i32(&mut header, 0);
        put_i32(&mut header, 0);
        put_i32(&mut header, 0);
        put_i32(&mut header, label_ofs);
        put_i32(&mut header, labels.len() as i32);
        put_i32(&mut header, 0);
        put_i32(&mut header, 0);
        for _ in 11..33 {
            put_i32(&mut header, 0);
        }
        let mut payload = header;
        payload.extend_from_slice(bytecode);
        for label in labels {
            put_i32(&mut payload, *label);
        }
        payload
    }

    #[test]
    fn decodes_push_int_and_str_literals() {
        let mut bytecode = vec![0x02];
        put_i32(&mut bytecode, FM_INT);
        put_i32(&mut bytecode, 42);
        bytecode.push(0x02);
        put_i32(&mut bytecode, FM_STR);
        put_i32(&mut bytecode, 7);
        bytecode.push(0x16);
        let ops = operands_of(&bytecode, &[]);
        assert_eq!(ops[0], SiglusOperand::Push(SiglusPush::Int(42)));
        assert_eq!(ops[1], SiglusOperand::Push(SiglusPush::Str(7)));
        assert_eq!(ops[2], SiglusOperand::None);
    }

    #[test]
    fn decodes_operator_bytes_from_operate_opcodes() {
        let mut bytecode = vec![0x21];
        put_i32(&mut bytecode, FM_INT);
        bytecode.push(0x02); // negate
        bytecode.push(0x22);
        put_i32(&mut bytecode, FM_INT);
        put_i32(&mut bytecode, FM_INT);
        bytecode.push(0x01); // add
        bytecode.push(0x16);
        let ops = operands_of(&bytecode, &[]);
        assert_eq!(ops[0], SiglusOperand::Operate1(FM_INT, 0x02));
        assert_eq!(ops[1], SiglusOperand::Operate2(FM_INT, FM_INT, 0x01));
    }

    #[test]
    fn decodes_nested_command_arg_forms() {
        // COMMAND arg_list_id=0, one list arg holding two int forms, 0 named,
        // ret_form=int, no read flag (label lands right after).
        let mut bytecode = vec![0x30];
        put_i32(&mut bytecode, 0); // arg_list_id
        put_i32(&mut bytecode, 1); // arg count
        put_i32(&mut bytecode, FM_LIST); // a nested list
        put_i32(&mut bytecode, 2); // nested count
        put_i32(&mut bytecode, FM_INT);
        put_i32(&mut bytecode, FM_INT);
        put_i32(&mut bytecode, 0); // named count
        put_i32(&mut bytecode, FM_INT); // ret_form
        let after = bytecode.len() as i32;
        bytecode.push(0x16);
        let ops = operands_of(&bytecode, &[after]);
        match &ops[0] {
            SiglusOperand::Command {
                arg_forms,
                ret_form,
                read_flag,
                ..
            } => {
                assert_eq!(*ret_form, FM_INT);
                assert_eq!(*read_flag, None);
                assert_eq!(arg_forms_value_count(arg_forms), 2);
            }
            other => panic!("expected command, got {other:?}"),
        }
    }
}
