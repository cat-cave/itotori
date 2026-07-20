//! Per-opcode `RLOperation` implementations for the text/messaging family.
//! Each opcode's dispatch shape plus the `register_text_rlops` mount.

use std::sync::Arc;

use crate::rlop::{
    DispatchOutcome, ExprValue, LongOp, RLOperation, RlopRegistry, longops::PauseLongOp,
};
use crate::vm::Vm;

use super::{LATTICE_TYPES, MsgOpcode, MsgRuntime, MsgRuntimeWarning};

/// `msg.pause` — yield a [`crate::rlop::LongOp`] carrying a
/// [`crate::rlop::longops::PauseLongOp`] private state. The VM's
/// scheduler decides when to resume (always-ready in tests, user-input
/// in the runtime path).
#[derive(Debug)]
pub struct MsgPauseOp {
    runtime: Arc<MsgRuntime>,
}

impl MsgPauseOp {
    pub fn new(runtime: Arc<MsgRuntime>) -> Self {
        Self { runtime }
    }
}

impl RLOperation for MsgPauseOp {
    fn dispatch(&self, _vm: &mut Vm, _args: &[ExprValue]) -> DispatchOutcome {
        // Flush any pending text run before yielding so the user sees
        // the line before the input prompt.
        self.runtime.flush_pending_line(MsgOpcode::Pause);
        let id = self.runtime.id_sequence().allocate();
        let pause = PauseLongOp::new(id);
        let LongOp { id, private_state } = pause.into_longop();
        DispatchOutcome::Yield {
            longop_id: id,
            private_state,
        }
    }
}

/// `msg.par` — paragraph break. Flushes the pending body.
#[derive(Debug)]
pub struct MsgParagraphBreakOp {
    runtime: Arc<MsgRuntime>,
}

impl MsgParagraphBreakOp {
    pub fn new(runtime: Arc<MsgRuntime>) -> Self {
        Self { runtime }
    }
}

impl RLOperation for MsgParagraphBreakOp {
    fn dispatch(&self, _vm: &mut Vm, _args: &[ExprValue]) -> DispatchOutcome {
        self.runtime.flush_pending_line(MsgOpcode::ParagraphBreak);
        DispatchOutcome::Advance
    }
}

/// `msg.br` — line break. Flushes the pending body.
#[derive(Debug)]
pub struct MsgLineBreakOp {
    runtime: Arc<MsgRuntime>,
}

impl MsgLineBreakOp {
    pub fn new(runtime: Arc<MsgRuntime>) -> Self {
        Self { runtime }
    }
}

impl RLOperation for MsgLineBreakOp {
    fn dispatch(&self, _vm: &mut Vm, _args: &[ExprValue]) -> DispatchOutcome {
        self.runtime.flush_pending_line(MsgOpcode::LineBreak);
        DispatchOutcome::Advance
    }
}

/// `msg.page` — page wipe. Flushes the pending body and clears the
/// speaker bracket so the next page starts fresh.
#[derive(Debug)]
pub struct MsgPageOp {
    runtime: Arc<MsgRuntime>,
}

impl MsgPageOp {
    pub fn new(runtime: Arc<MsgRuntime>) -> Self {
        Self { runtime }
    }
}

impl RLOperation for MsgPageOp {
    fn dispatch(&self, _vm: &mut Vm, _args: &[ExprValue]) -> DispatchOutcome {
        self.runtime.flush_pending_line(MsgOpcode::Page);
        let mut guard = self
            .runtime
            .inner
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        guard.pending_speaker = None;
        DispatchOutcome::Advance
    }
}

/// `msg.msg_hide` — hide the active text window. Flushes any pending
/// body first so a hidden window does not silently drop a line.
#[derive(Debug)]
pub struct MsgMsgHideOp {
    runtime: Arc<MsgRuntime>,
}

impl MsgMsgHideOp {
    pub fn new(runtime: Arc<MsgRuntime>) -> Self {
        Self { runtime }
    }
}

impl RLOperation for MsgMsgHideOp {
    fn dispatch(&self, _vm: &mut Vm, _args: &[ExprValue]) -> DispatchOutcome {
        self.runtime.flush_pending_line(MsgOpcode::MsgHide);
        DispatchOutcome::Advance
    }
}

/// `msg.msg_clear` — clear the active text window. Discards the
/// pending body without emitting (the clear is visible as the
/// absence of a line); the runtime records the clear as a zero-text
/// emission so the audit trail still names the opcode.
#[derive(Debug)]
pub struct MsgMsgClearOp {
    runtime: Arc<MsgRuntime>,
}

impl MsgMsgClearOp {
    pub fn new(runtime: Arc<MsgRuntime>) -> Self {
        Self { runtime }
    }
}

impl RLOperation for MsgMsgClearOp {
    fn dispatch(&self, _vm: &mut Vm, _args: &[ExprValue]) -> DispatchOutcome {
        {
            let mut guard = self
                .runtime
                .inner
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            guard.pending_body.clear();
        }
        DispatchOutcome::Advance
    }
}

/// `msg.linenumber(int)` — declared source-line number marker.
#[derive(Debug)]
pub struct MsgLineNumberOp {
    runtime: Arc<MsgRuntime>,
}

impl MsgLineNumberOp {
    pub fn new(runtime: Arc<MsgRuntime>) -> Self {
        Self { runtime }
    }
}

impl RLOperation for MsgLineNumberOp {
    fn dispatch(&self, _vm: &mut Vm, args: &[ExprValue]) -> DispatchOutcome {
        let value = match args.first() {
            Some(ExprValue::Int(n)) => Some(*n),
            Some(ExprValue::Bytes(_)) => {
                self.runtime
                    .record_warning(MsgRuntimeWarning::ArgShapeMismatch {
                        opcode: MsgOpcode::LineNumber,
                        expected: "int",
                    });
                None
            }
            None => {
                self.runtime.record_warning(MsgRuntimeWarning::MissingArg {
                    opcode: MsgOpcode::LineNumber,
                    slot: "line_number",
                });
                None
            }
        };
        if let Some(value) = value {
            let mut guard = self
                .runtime
                .inner
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            guard.last_line_number = Some(value as u32);
        }
        DispatchOutcome::Advance
    }
}

/// `msg.font_color(int)` — set font colour.
#[derive(Debug)]
pub struct MsgFontColorOp {
    runtime: Arc<MsgRuntime>,
}

impl MsgFontColorOp {
    pub fn new(runtime: Arc<MsgRuntime>) -> Self {
        Self { runtime }
    }
}

impl RLOperation for MsgFontColorOp {
    fn dispatch(&self, _vm: &mut Vm, args: &[ExprValue]) -> DispatchOutcome {
        let value = match args.first() {
            Some(ExprValue::Int(n)) => Some(*n as u32),
            Some(ExprValue::Bytes(_)) => {
                self.runtime
                    .record_warning(MsgRuntimeWarning::ArgShapeMismatch {
                        opcode: MsgOpcode::FontColor,
                        expected: "int",
                    });
                None
            }
            None => {
                self.runtime.record_warning(MsgRuntimeWarning::MissingArg {
                    opcode: MsgOpcode::FontColor,
                    slot: "rgb",
                });
                None
            }
        };
        if let Some(value) = value {
            let mut guard = self
                .runtime
                .inner
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            guard.current_font_color = Some(value);
        }
        DispatchOutcome::Advance
    }
}

/// `msg.font_size(int)` — set font size.
#[derive(Debug)]
pub struct MsgFontSizeOp {
    runtime: Arc<MsgRuntime>,
}

impl MsgFontSizeOp {
    pub fn new(runtime: Arc<MsgRuntime>) -> Self {
        Self { runtime }
    }
}

impl RLOperation for MsgFontSizeOp {
    fn dispatch(&self, _vm: &mut Vm, args: &[ExprValue]) -> DispatchOutcome {
        let value = match args.first() {
            Some(ExprValue::Int(n)) => {
                let clamped = (*n).clamp(0, u8::MAX as i32) as u8;
                Some(clamped)
            }
            Some(ExprValue::Bytes(_)) => {
                self.runtime
                    .record_warning(MsgRuntimeWarning::ArgShapeMismatch {
                        opcode: MsgOpcode::FontSize,
                        expected: "int",
                    });
                None
            }
            None => {
                self.runtime.record_warning(MsgRuntimeWarning::MissingArg {
                    opcode: MsgOpcode::FontSize,
                    slot: "size",
                });
                None
            }
        };
        if let Some(value) = value {
            let mut guard = self
                .runtime
                .inner
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            guard.current_font_size = Some(value);
        }
        DispatchOutcome::Advance
    }
}

/// `msg.name_open` — speaker-bracket open.
#[derive(Debug)]
pub struct MsgNameOpenOp {
    runtime: Arc<MsgRuntime>,
}

impl MsgNameOpenOp {
    pub fn new(runtime: Arc<MsgRuntime>) -> Self {
        Self { runtime }
    }
}

impl RLOperation for MsgNameOpenOp {
    fn dispatch(&self, _vm: &mut Vm, _args: &[ExprValue]) -> DispatchOutcome {
        self.runtime.begin_speaker();
        DispatchOutcome::Advance
    }
}

/// `msg.name_close` — speaker-bracket close.
#[derive(Debug)]
pub struct MsgNameCloseOp {
    runtime: Arc<MsgRuntime>,
}

impl MsgNameCloseOp {
    pub fn new(runtime: Arc<MsgRuntime>) -> Self {
        Self { runtime }
    }
}

impl RLOperation for MsgNameCloseOp {
    fn dispatch(&self, _vm: &mut Vm, _args: &[ExprValue]) -> DispatchOutcome {
        self.runtime.end_speaker();
        DispatchOutcome::Advance
    }
}

/// `msg.text_window(int)` — switch active text-window slot.
#[derive(Debug)]
pub struct MsgTextWindowOp {
    runtime: Arc<MsgRuntime>,
}

impl MsgTextWindowOp {
    pub fn new(runtime: Arc<MsgRuntime>) -> Self {
        Self { runtime }
    }
}

impl RLOperation for MsgTextWindowOp {
    fn dispatch(&self, _vm: &mut Vm, args: &[ExprValue]) -> DispatchOutcome {
        let value = match args.first() {
            Some(ExprValue::Int(n)) => Some(*n as u32),
            Some(ExprValue::Bytes(_)) => {
                self.runtime
                    .record_warning(MsgRuntimeWarning::ArgShapeMismatch {
                        opcode: MsgOpcode::TextWindow,
                        expected: "int",
                    });
                None
            }
            None => {
                self.runtime.record_warning(MsgRuntimeWarning::MissingArg {
                    opcode: MsgOpcode::TextWindow,
                    slot: "window",
                });
                None
            }
        };
        if let Some(value) = value {
            let mut guard = self
                .runtime
                .inner
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            guard.current_text_window = Some(value);
        }
        DispatchOutcome::Advance
    }
}

/// Mount every text/messaging op this module ships into `registry`.
/// Returns the number of lattice-specific entries registered.
pub fn register_text_rlops(registry: &mut RlopRegistry, runtime: Arc<MsgRuntime>) -> usize {
    let mut register = |opcode: MsgOpcode, op: Arc<dyn RLOperation>| {
        for module_type in LATTICE_TYPES {
            registry.register(opcode.rlop_key_for(module_type), Arc::clone(&op));
        }
    };
    register(
        MsgOpcode::Pause,
        Arc::new(MsgPauseOp::new(Arc::clone(&runtime))),
    );
    register(
        MsgOpcode::ParagraphBreak,
        Arc::new(MsgParagraphBreakOp::new(Arc::clone(&runtime))),
    );
    register(
        MsgOpcode::LineBreak,
        Arc::new(MsgLineBreakOp::new(Arc::clone(&runtime))),
    );
    register(
        MsgOpcode::Page,
        Arc::new(MsgPageOp::new(Arc::clone(&runtime))),
    );
    register(
        MsgOpcode::MsgHide,
        Arc::new(MsgMsgHideOp::new(Arc::clone(&runtime))),
    );
    register(
        MsgOpcode::MsgClear,
        Arc::new(MsgMsgClearOp::new(Arc::clone(&runtime))),
    );
    register(
        MsgOpcode::LineNumber,
        Arc::new(MsgLineNumberOp::new(Arc::clone(&runtime))),
    );
    register(
        MsgOpcode::FontColor,
        Arc::new(MsgFontColorOp::new(Arc::clone(&runtime))),
    );
    register(
        MsgOpcode::FontSize,
        Arc::new(MsgFontSizeOp::new(Arc::clone(&runtime))),
    );
    register(
        MsgOpcode::NameOpen,
        Arc::new(MsgNameOpenOp::new(Arc::clone(&runtime))),
    );
    register(
        MsgOpcode::NameClose,
        Arc::new(MsgNameCloseOp::new(Arc::clone(&runtime))),
    );
    register(
        MsgOpcode::TextWindow,
        Arc::new(MsgTextWindowOp::new(Arc::clone(&runtime))),
    );
    MsgOpcode::ALL.len() * LATTICE_TYPES.len()
}
