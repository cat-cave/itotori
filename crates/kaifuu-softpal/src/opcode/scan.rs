use std::collections::BTreeMap;

use super::{
    CallTarget, CommandFamily, Instruction, OpcodeError, OpcodeScan, Operand, SV_OPERATOR_TAG,
    SV_PROGRAM_HEADER_BYTE_LEN, SV_TOKEN_BYTE_LEN, SvOpcode, UnknownToken, read_u16_le,
    read_u32_le,
};

impl OpcodeScan {
    /// Walk a whole `SCRIPT.SRC` buffer into a typed opcode catalog.
    /// The walk is **arity-driven**: it reads the header, then repeatedly reads
    /// an operator token and consumes exactly [`SvOpcode::arity`] operand tokens,
    /// stepping to the next operator. This is what makes the walk exhaustive and
    /// unambiguous — an operand whose bits resemble an operator is consumed as an
    /// operand, never re-read as one.
    /// Never panics: a fatal header failure is `Err`; an unrecognized operator
    /// token is recorded in [`Self::unknowns`] (and the walk resyncs on the
    /// 4-byte grid); a truncated final command sets [`Self::truncated_final`].
    /// # Errors
    /// [`OpcodeError::TruncatedHeader`] / [`OpcodeError::BadMagic`] from the
    /// header parse.
    pub fn parse(bytes: &[u8]) -> Result<Self, OpcodeError> {
        let header = super::SvProgramHeader::parse(bytes)?;
        let mut instructions = Vec::new();
        let mut unknowns = Vec::new();
        let mut truncated_final = false;

        let mut off = SV_PROGRAM_HEADER_BYTE_LEN;
        while off + SV_TOKEN_BYTE_LEN <= bytes.len() {
            let lo = read_u16_le(bytes, off);
            let hi = read_u16_le(bytes, off + 2);

            // At an operator position the high word must be the operator tag.
            if hi != SV_OPERATOR_TAG {
                unknowns.push(UnknownToken {
                    offset: off,
                    token_lo: lo,
                    token_hi: hi,
                });
                off += SV_TOKEN_BYTE_LEN;
                continue;
            }
            let opcode = SvOpcode::from_id(lo);
            let Some(arity) = opcode.arity() else {
                // Unknown opcode id: arity unknown, cannot consume operands.
                unknowns.push(UnknownToken {
                    offset: off,
                    token_lo: lo,
                    token_hi: hi,
                });
                off += SV_TOKEN_BYTE_LEN;
                continue;
            };

            let op_offset = off;
            off += SV_TOKEN_BYTE_LEN;

            let mut operands_buf = [Operand::default(); 2];
            let mut got = 0usize;
            for slot in operands_buf.iter_mut().take(arity) {
                if off + SV_TOKEN_BYTE_LEN > bytes.len() {
                    break;
                }
                *slot = Operand {
                    raw: read_u32_le(bytes, off),
                    field_offset: off,
                };
                got += 1;
                off += SV_TOKEN_BYTE_LEN;
            }

            let family = classify(opcode, &operands_buf, got);
            instructions.push(Instruction {
                offset: op_offset,
                opcode,
                family,
                arity: got as u8,
                operands_buf,
            });

            if got < arity {
                truncated_final = true;
                break;
            }
        }

        let trailing_bytes = bytes.len().saturating_sub(off);
        Ok(Self {
            header,
            instructions,
            unknowns,
            truncated_final,
            trailing_bytes,
            input_len: bytes.len(),
        })
    }

    /// The catalog is **exhaustive** iff it typed every command with no residual:
    /// no unknown operator tokens, no truncated final command, and no trailing
    /// bytes. This is the 0-unknown completeness bar.
    #[must_use]
    pub fn is_exhaustive(&self) -> bool {
        self.unknowns.is_empty() && !self.truncated_final && self.trailing_bytes == 0
    }

    /// Number of unknown (untyped) operator-position tokens — the residual the
    /// completeness bar drives to zero.
    #[must_use]
    pub fn unknown_count(&self) -> usize {
        self.unknowns.len()
    }

    /// TEXT-SHOW (dialogue) instruction count — mirrors
    /// [`crate::ScriptScan::text_show_count`].
    #[must_use]
    pub fn text_show_count(&self) -> usize {
        self.instructions
            .iter()
            .filter(|i| matches!(i.family, CommandFamily::TextShow { .. }))
            .count()
    }

    /// SELECT (choice) instruction count — mirrors
    /// [`crate::ScriptScan::select_count`].
    #[must_use]
    pub fn select_count(&self) -> usize {
        self.instructions
            .iter()
            .filter(|i| matches!(i.family, CommandFamily::Select))
            .count()
    }

    /// Total native `Syscall` (opcode `0x17`) instruction count, across all targets
    /// (TEXT-SHOW + SELECT + every other engine built-in).
    #[must_use]
    pub fn call_count(&self) -> usize {
        self.instructions
            .iter()
            .filter(|i| i.opcode.is_syscall())
            .count()
    }

    /// Opcode-id → occurrence-count histogram over all typed instructions.
    #[must_use]
    pub fn opcode_histogram(&self) -> BTreeMap<u16, usize> {
        let mut h = BTreeMap::new();
        for i in &self.instructions {
            *h.entry(i.opcode.id()).or_default() += 1;
        }
        h
    }

    /// Operand structural-tag → occurrence-count histogram over every operand of
    /// every instruction.
    #[must_use]
    pub fn operand_tag_histogram(&self) -> BTreeMap<u8, usize> {
        let mut h = BTreeMap::new();
        for i in &self.instructions {
            for o in i.operands() {
                *h.entry(o.tag().0).or_default() += 1;
            }
        }
        h
    }

    /// `Syscall` category (dispatch high word) → count histogram over all `Syscall`
    /// instructions — the coarse command-family table.
    #[must_use]
    pub fn call_category_histogram(&self) -> BTreeMap<u16, usize> {
        let mut h = BTreeMap::new();
        for i in &self.instructions {
            if let Some(t) = i.call_target() {
                *h.entry(t.category).or_default() += 1;
            }
        }
        h
    }

    /// The set of distinct `Syscall` `(category, function)` dispatch targets — the
    /// fine-grained engine built-in table a replay must cover.
    #[must_use]
    pub fn call_target_count(&self) -> usize {
        let mut set = std::collections::BTreeSet::new();
        for i in &self.instructions {
            if let Some(t) = i.call_target() {
                set.insert((t.category, t.function));
            }
        }
        set.len()
    }

    /// Total token count consumed (operators + operands).
    #[must_use]
    pub fn token_count(&self) -> usize {
        self.instructions
            .iter()
            .map(|i| 1 + i.arity as usize)
            .sum::<usize>()
            + self.unknowns.len()
    }
}

/// Classify an operator + its (up to `got`) operands into a [`CommandFamily`].
fn classify(opcode: SvOpcode, operands: &[Operand; 2], got: usize) -> CommandFamily {
    if opcode.is_syscall() && got >= 1 {
        let target = CallTarget::from_operand(operands[0].raw);
        // Keep the extraction-bearing families on the same semantic catalog as
        // every other Syscall target.  ScriptScan (and therefore the real Softpal
        // bridge) consumes this classification; this is not a test-only seam.
        match target.semantic_name() {
            Some("message.show") => {
                return CommandFamily::TextShow {
                    text_type: target.function,
                };
            }
            Some("choice.select") => return CommandFamily::Select,
            _ => {}
        }
        return CommandFamily::Call { target };
    }
    match opcode.arity() {
        Some(0) => CommandFamily::Control,
        _ => CommandFamily::Expr,
    }
}
