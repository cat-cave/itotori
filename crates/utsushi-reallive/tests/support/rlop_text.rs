use super::*;

// Test sink

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

    pub(super) fn snapshot(&self) -> Vec<TextLine> {
        self.lines.lock().expect("lock").clone()
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

#[derive(Default)]
pub(super) struct RejectingSink;

impl TextSurfaceSink for RejectingSink {
    fn capability(&self) -> SinkCapability {
        SinkCapability::Unsupported
    }

    fn emit_line(&self, _line: TextLine) -> SinkResult<()> {
        Err(SinkError::UnsupportedKind {
            sink: utsushi_core::substrate::SinkKind::TextSurface,
            adapter_id: "rejecting-stub".to_string(),
            reason: "test stub rejects all lines".to_string(),
        })
    }
}

// Element constructors mirroring the vm_synthetic.rs
// helpers.

fn command_element(offset: usize, opcode: u16) -> BytecodeElement {
    BytecodeElement::Command {
        module_type: MSG_MODULE_TYPE,
        module_id: MSG_MODULE_ID,
        opcode,
        arg_count: 0,
        overload: 0,
        goto_targets: vec![],
        goto_case_exprs: vec![],
        raw_bytes: vec![
            0x23,
            MSG_MODULE_TYPE,
            MSG_MODULE_ID,
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

pub(super) fn build_scene(opcodes: &[u16]) -> Scene {
    let mut elements = Vec::with_capacity(opcodes.len());
    let mut offset = 0usize;
    for opcode in opcodes {
        elements.push(command_element(offset, *opcode));
        offset += 8;
    }
    Scene::new(1, elements).expect("non-empty synthetic scene")
}

// Per-opcode harness — each helper builds a runtime + registry around a
// fresh sink and dispatches the requested opcode directly through the
// registered Arc<dyn RLOperation>. Tests call these to assert the
// outcome.

pub(super) fn dispatch_command(
    opcode: u16,
    args: &[ExprValue],
) -> (DispatchOutcome, Vec<TextLine>, Arc<MsgRuntime>) {
    let sink = Arc::new(CollectingSink::new());
    let runtime = Arc::new(MsgRuntime::with_sink(sink.clone()));
    let mut registry = RlopRegistry::new();
    register_text_rlops(&mut registry, Arc::clone(&runtime));
    let key = RlopKey::new(MSG_MODULE_TYPE, MSG_MODULE_ID, opcode);
    let op = registry.get(key).expect("opcode must be registered");
    let mut vm = Vm::new(1, 0);
    let outcome = op.dispatch(&mut vm, args);
    let lines = sink.drain();
    (outcome, lines, runtime)
}
