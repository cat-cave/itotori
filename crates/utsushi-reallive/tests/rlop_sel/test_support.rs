use super::*;

#[derive(Default)]
pub(super) struct CollectingSink {
    lines: Mutex<Vec<TextLine>>,
}

impl CollectingSink {
    pub(super) fn new() -> Self {
        Self::default()
    }

    pub(super) fn drain(&self) -> Vec<TextLine> {
        std::mem::take(&mut *self.lines.lock().expect("lock"))
    }
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

pub(super) fn build_runtime(
    gameexe: Option<Arc<Gameexe>>,
) -> (Arc<CollectingSink>, Arc<SelRuntime>) {
    let sink: Arc<CollectingSink> = Arc::new(CollectingSink::new());
    let sink_dyn: Arc<dyn TextSurfaceSink> = sink.clone();
    let runtime = match gameexe {
        Some(game) => Arc::new(SelRuntime::with_gameexe(sink_dyn, game)),
        None => Arc::new(SelRuntime::with_sink(sink_dyn)),
    };
    (sink, runtime)
}

pub(super) fn sel_command(offset: usize, opcode: u16) -> BytecodeElement {
    BytecodeElement::Command {
        module_type: SEL_MODULE_TYPE,
        module_id: SEL_MODULE_ID,
        opcode,
        arg_count: 0,
        overload: 0,
        goto_targets: vec![],
        goto_case_exprs: vec![],
        raw_bytes: vec![
            0x23,
            SEL_MODULE_TYPE,
            SEL_MODULE_ID,
            opcode as u8,
            (opcode >> 8) as u8,
            0,
            0,
            0,
        ],
        byte_offset: offset,
        byte_len: 8,
    }
}

/// A `module_sel` select command framed as a REAL `SelectElement`: an
/// 8-byte header followed by a `{ opt0 \n opt1 }` option block — the exact
/// framing `extract_select_choice_texts` walks on real Sweetie/Kanon bytes.
/// The VM's dispatch path recovers the option labels from this block (a
/// select with no options is not a presentable prompt and is advanced), so
/// a VM-stepped select must carry one.
pub(super) fn sel_command_with_options(
    offset: usize,
    opcode: u16,
    options: &[&str],
) -> BytecodeElement {
    const SELECT_BLOCK_OPEN: u8 = 0x7B; // '{'
    const SELECT_BLOCK_CLOSE: u8 = 0x7D; // '}'
    const META_LINE_LEAD: u8 = 0x0A;
    let mut raw = vec![
        0x23,
        SEL_MODULE_TYPE,
        SEL_MODULE_ID,
        opcode as u8,
        (opcode >> 8) as u8,
        0,
        0,
        0,
    ];
    raw.push(SELECT_BLOCK_OPEN);
    for (i, option) in options.iter().enumerate() {
        if i > 0 {
            raw.extend_from_slice(&[META_LINE_LEAD, 0x00, 0x00]);
        }
        raw.extend_from_slice(option.as_bytes());
    }
    raw.push(SELECT_BLOCK_CLOSE);
    let byte_len = raw.len();
    BytecodeElement::Command {
        module_type: SEL_MODULE_TYPE,
        module_id: SEL_MODULE_ID,
        opcode,
        arg_count: 0,
        overload: 0,
        goto_targets: vec![],
        goto_case_exprs: vec![],
        raw_bytes: raw,
        byte_offset: offset,
        byte_len,
    }
}
