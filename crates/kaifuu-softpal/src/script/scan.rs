use super::*;

impl ScriptScan {
    /// Derive every TEXT-SHOW + SELECT command from the arity-driven opcode-catalog
    /// walk ([`crate::OpcodeScan`]) — the single source of truth.
    /// The walk types every token operator→operands→operator, so every `Call`
    /// operator it reports is a genuine command (an operand whose bytes resemble a
    /// `Call` operator is consumed as an operand, never mis-read as one). For each
    /// `Call` classified [`CommandFamily::TextShow`] / [`CommandFamily::Select`]
    /// this reads the text / speaker-name / immediate pointers straight off the
    /// walk's typed operands at the command's fixed field offsets (writing the
    /// `Call` operator offset as `m`: text at `m-20`, speaker name at `m-12`,
    /// SELECT immediate at `m-4`), preserving the byte-locatable field offsets a
    /// patch-back repoints. Commands are yielded in play (ascending offset) order.
    /// # Errors
    /// [`ScriptError::TruncatedHeader`] / [`ScriptError::BadMagic`] from the
    /// header parse, or [`ScriptError::TruncatedCommand`] if a `Call` is classified
    /// as a text-bearing command but the buffer/stream lacks the tokens before it
    /// to hold the command's pointer fields (a truncated command, never silently
    /// dropped).
    pub fn parse(bytes: &[u8]) -> Result<Self, ScriptError> {
        let header = ScriptHeader::parse(bytes)?;

        // Single source of truth: the arity-driven stack-machine walk. On a buffer
        // too short/malformed for the 12-byte `Sv20` program header the walk yields
        // nothing, so a valid-magic buffer with no token stream has no commands.
        let Ok(walk) = OpcodeScan::parse(bytes) else {
            return Ok(Self {
                header,
                commands: Vec::new(),
            });
        };

        // Indirect SELECT labels, keyed by the SELECT `Call` operator offset,
        // derived from typed assignment flow in the same walk.
        let decoupled = decoupled_select_labels(&walk);

        // The typed operand values the walk recovered, indexed by their absolute
        // 4-byte field offset. A TEXT-SHOW / SELECT reads its pointer fields from
        // *these* operand positions the arity walk actually produced — so a value
        // whose bytes look like a command is never re-read as one.
        let mut operand_by_offset: HashMap<usize, u32> =
            HashMap::with_capacity(walk.instructions.len());
        for ins in &walk.instructions {
            for op in ins.operands() {
                operand_by_offset.insert(op.field_offset, op.raw);
            }
        }
        // Fetch the typed operand at `field_offset`, or a truncated-command error
        // (the command's pointer push is not in the stream).
        let operand_at = |field_offset: usize,
                          marker_offset: usize,
                          needed_before: usize,
                          kind: &'static str|
         -> Result<u32, ScriptError> {
            operand_by_offset
                .get(&field_offset)
                .copied()
                .ok_or(ScriptError::TruncatedCommand {
                    marker_offset,
                    needed_before,
                    kind,
                })
        };

        let mut commands = Vec::new();
        for ins in &walk.instructions {
            // `m` is the `Call` operator offset (== the old marker offset).
            let m = ins.offset;
            match ins.family {
                CommandFamily::TextShow { .. } => {
                    // The command spans `[m-24, m+8)`; its pointer fields precede
                    // the `Call` (text at m-20, speaker name at m-12).
                    let command_offset = m.checked_sub(TEXT_SHOW_MARKER_OFFSET).ok_or(
                        ScriptError::TruncatedCommand {
                            marker_offset: m,
                            needed_before: TEXT_SHOW_MARKER_OFFSET,
                            kind: "text-show",
                        },
                    )?;
                    let text_ptr_field_offset = command_offset + COMMAND_TEXT_PTR_OFFSET;
                    let name_ptr_field_offset = command_offset + COMMAND_NAME_PTR_OFFSET;
                    let text_pointer = operand_at(
                        text_ptr_field_offset,
                        m,
                        TEXT_SHOW_MARKER_OFFSET,
                        "text-show",
                    )?;
                    let raw_name = operand_at(
                        name_ptr_field_offset,
                        m,
                        TEXT_SHOW_MARKER_OFFSET,
                        "text-show",
                    )?;
                    let name_pointer = (raw_name != NO_SPEAKER_POINTER).then_some(raw_name);
                    commands.push(RawCommand::TextShow {
                        command_offset,
                        text_pointer,
                        text_ptr_field_offset,
                        name_pointer,
                        name_ptr_field_offset,
                    });
                }
                CommandFamily::Select => {
                    // The command spans `[m-8, m+8)`; the immediate is at m-4.
                    let command_offset = m.checked_sub(SELECT_MARKER_OFFSET).ok_or(
                        ScriptError::TruncatedCommand {
                            marker_offset: m,
                            needed_before: SELECT_MARKER_OFFSET,
                            kind: "select",
                        },
                    )?;
                    let text_ptr_field_offset = command_offset + COMMAND_TEXT_PTR_OFFSET;
                    let text_pointer =
                        operand_at(text_ptr_field_offset, m, SELECT_MARKER_OFFSET, "select")?;
                    commands.push(RawCommand::Select {
                        command_offset,
                        text_pointer,
                        text_ptr_field_offset,
                        decoupled_label: decoupled.get(&m).map(|&(pointer, field_offset)| {
                            DecoupledLabel {
                                pointer,
                                field_offset,
                            }
                        }),
                    });
                }
                // Every other `Call` target + all non-`Call` operators are outside
                // this module's two text-bearing surfaces.
                _ => {}
            }
        }

        Ok(Self { header, commands })
    }

    /// Number of TEXT-SHOW commands recovered.
    #[must_use]
    pub fn text_show_count(&self) -> usize {
        self.commands
            .iter()
            .filter(|c| matches!(c, RawCommand::TextShow { .. }))
            .count()
    }

    /// Number of TEXT-SHOW commands that carry a speaker name pointer.
    #[must_use]
    pub fn text_show_with_speaker_count(&self) -> usize {
        self.commands
            .iter()
            .filter(|c| {
                matches!(
                    c,
                    RawCommand::TextShow {
                        name_pointer: Some(_),
                        ..
                    }
                )
            })
            .count()
    }

    /// Number of SELECT (choice) commands recovered.
    #[must_use]
    pub fn select_count(&self) -> usize {
        self.commands
            .iter()
            .filter(|c| matches!(c, RawCommand::Select { .. }))
            .count()
    }

    /// Resolve every command's pointer(s) against a parsed [`TextDat`], yielding
    /// the dialogue + speaker + choice stream in play order.
    /// Each pointer is classified against the record pool (see
    /// [`PointerResolution`]): [`Resolved`](PointerResolution::Resolved) when it
    /// equals some record's byte offset ([`crate::TextRecord::offset`], an exact
    /// boundary), [`Dangling`](PointerResolution::Dangling) when it falls *inside*
    /// the pool but misses a boundary (a genuine integrity failure), or
    /// [`OutOfPool`](PointerResolution::OutOfPool) when it cannot be a pool
    /// offset at all — e.g. a typed SELECT immediate `0x40000000`, a
    /// system/branch select with no inline text. Never panics; the proof bar is
    /// 0 dangling on real bytes.
    #[must_use]
    pub fn resolve(&self, textdat: &TextDat) -> Disassembly {
        // record offset (as u32) -> decoded text.
        let mut by_offset: HashMap<u32, &str> = HashMap::with_capacity(textdat.records.len());
        for r in &textdat.records {
            if let Ok(off) = u32::try_from(r.offset) {
                by_offset.insert(off, r.text.as_str());
            }
        }
        // The record pool spans [first_offset, pool_end); a pointer at or past
        // `pool_end` (or before the first record) is not a pool reference.
        let pool_start = textdat.records.first().map_or(0u64, |r| r.offset as u64);
        let pool_end = textdat
            .records
            .last()
            .map_or(0u64, |r| (r.text_offset + r.raw_text.len() + 1) as u64);
        let classify = |pointer: u32| -> PointerResolution {
            if let Some(text) = by_offset.get(&pointer) {
                PointerResolution::Resolved((*text).to_owned())
            } else if (pool_start..pool_end).contains(&(pointer as u64)) {
                PointerResolution::Dangling
            } else {
                PointerResolution::OutOfPool
            }
        };
        let make_ref = |pointer: u32, field_offset: usize| TextRef {
            pointer,
            field_offset,
            resolution: classify(pointer),
        };

        let mut dialogue = Vec::new();
        let mut choices = Vec::new();
        for cmd in &self.commands {
            match *cmd {
                RawCommand::TextShow {
                    command_offset,
                    text_pointer,
                    text_ptr_field_offset,
                    name_pointer,
                    name_ptr_field_offset,
                } => {
                    dialogue.push(DialogueUnit {
                        command_offset,
                        text: make_ref(text_pointer, text_ptr_field_offset),
                        speaker: name_pointer.map(|p| make_ref(p, name_ptr_field_offset)),
                    });
                }
                RawCommand::Select {
                    command_offset,
                    text_pointer,
                    text_ptr_field_offset,
                    decoupled_label,
                } => {
                    // A direct plain immediate resolves first. If it does not,
                    // try the typed-flow candidate; otherwise retain the immediate
                    // so a genuine system/menu select remains OutOfPool.
                    let immediate = make_ref(text_pointer, text_ptr_field_offset);
                    let text = if immediate.is_resolved() {
                        immediate
                    } else if let Some(dl) = decoupled_label {
                        let decoupled = make_ref(dl.pointer, dl.field_offset);
                        if decoupled.is_resolved() {
                            decoupled
                        } else {
                            immediate
                        }
                    } else {
                        immediate
                    };
                    choices.push(ChoiceUnit {
                        command_offset,
                        text,
                    });
                }
            }
        }
        Disassembly { dialogue, choices }
    }
}
